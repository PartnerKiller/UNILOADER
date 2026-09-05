const fs = require('fs');
const path = require('path');

// Load environment variables from .env file if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [k, ...rest] = trimmed.split('=');
        const v = rest.join('=').trim().replace(/^["']|["']$/g, '');
        if (!process.env[k.trim()]) {
          process.env[k.trim()] = v;
        }
      }
    }
  } catch (e) {}
}

const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const { extractMetadata, getYtDlpPath, getPythonBin } = require('./extractor');

const app = express();
const PORT = process.env.PORT || 3000;
let TEMP_DIR = process.env.TEMP_DIR || path.join(__dirname, 'temp_media');
const MAX_CONCURRENT_DOWNLOADS = 4;

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '150mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: false
}));

// Cross-platform tool detection
function getToolPaths() {
  const ytdlpPath = getYtDlpPath();
  let ffmpegDir = '';
  let freyrPath = '';

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\sayan', 'AppData', 'Local');
    const ffmpegCandidates = [
      path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0-full_build', 'bin'),
      path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-N-125875-g5d4d3bdc61-win64-gpl', 'bin'),
      path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
      ''
    ];
    for (const c of ffmpegCandidates) {
      if (c && fs.existsSync(c)) {
        ffmpegDir = c;
        break;
      }
    }
    try {
      freyrPath = execSync('where freyr', { encoding: 'utf-8' }).split(/\r?\n/)[0].trim();
    } catch (e) {}
  } else {
    try {
      freyrPath = execSync('which freyr', { encoding: 'utf-8' }).trim();
    } catch (e) {}
  }

  return { ytdlpPath, ffmpegDir, freyrPath };
}

const tools = getToolPaths();
console.log('Detected Tools:', tools);

// In-memory job & SSE client store
const jobs = new Map();
const sseClients = new Map(); // jobId -> Set(res)
const globalSseClients = new Set();

function broadcastGlobalJobUpdate() {
  if (globalSseClients.size === 0) return;
  const jobList = Array.from(jobs.values()).map(j => ({
    id: j.id,
    mode: j.mode,
    title: j.title,
    status: j.status,
    progress: j.progress,
    filesize: j.filesize || '',
    filename: j.filename,
    error: j.error,
    createdAt: j.createdAt,
    downloadUrl: `/api/download-file/${j.id}`,
    streamUrl: `/api/stream/${j.id}`
  }));
  const payload = JSON.stringify(jobList);
  for (const client of globalSseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (e) {
      globalSseClients.delete(client);
    }
  }
}

function broadcastJobUpdate(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  
  broadcastGlobalJobUpdate();

  const clients = sseClients.get(jobId);
  if (clients && clients.size > 0) {
    const data = JSON.stringify({
      id: job.id,
      status: job.status,
      mode: job.mode,
      progress: job.progress,
      logs: job.logs.slice(-30),
      error: job.error,
      title: job.title,
      filename: job.filename,
      filesize: job.filesize || '',
      downloadUrl: `/api/download-file/${job.id}`,
      streamUrl: `/api/stream/${job.id}`,
      filePath: job.filePath || ''
    });
    for (const res of clients) {
      try {
        res.write(`data: ${data}\n\n`);
      } catch (e) {
        clients.delete(res);
      }
    }
  }
}

// Global SSE Stream Endpoint (60fps realtime live updates)
app.get('/api/jobs/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('\n');
  globalSseClients.add(res);

  // Send initial jobs payload
  const initial = Array.from(jobs.values()).map(j => ({
    id: j.id,
    mode: j.mode,
    title: j.title,
    status: j.status,
    progress: j.progress,
    filesize: j.filesize || '',
    filename: j.filename,
    error: j.error,
    createdAt: j.createdAt,
    downloadUrl: `/api/download-file/${j.id}`,
    streamUrl: `/api/stream/${j.id}`,
    filePath: j.filePath || ''
  }));
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  req.on('close', () => {
    globalSseClients.delete(res);
  });
});

// SSE Heartbeat every 15 seconds to keep connections persistent
setInterval(() => {
  for (const client of globalSseClients) {
    try {
      client.write(': keepalive\n\n');
    } catch (e) {
      globalSseClients.delete(client);
    }
  }
}, 15000);

// Concurrency Queue Manager
function getActiveDownloadCount() {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === 'downloading' && job.process) count++;
  }
  return count;
}

function processDownloadQueue() {
  const active = getActiveDownloadCount();
  if (active >= MAX_CONCURRENT_DOWNLOADS) return;

  for (const job of jobs.values()) {
    if (job.status === 'queued') {
      startJobProcess(job);
      if (getActiveDownloadCount() >= MAX_CONCURRENT_DOWNLOADS) break;
    }
  }
}

// Health & Engine Status Endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeDownloads: getActiveDownloadCount(),
    maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
    totalJobs: jobs.size,
    platform: process.platform,
    engines: {
      spotiflacNext: true,
      soulseekP2P: true,
      tidalMonochrome: true,
      deezerHiFi: true,
      tiktokHD: true,
      instagramHD: true,
      universalYtdlp: true
    },
    downloadDir: TEMP_DIR
  });
});

// Download Directory Configuration
app.get('/api/config/download-dir', (req, res) => {
  res.json({
    downloadDir: TEMP_DIR,
    isDefault: TEMP_DIR === path.join(__dirname, 'temp_media')
  });
});

app.post('/api/config/download-dir', (req, res) => {
  const { downloadDir } = req.body || {};
  if (!downloadDir || typeof downloadDir !== 'string') {
    return res.status(400).json({ error: 'Valid directory path is required' });
  }
  try {
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    TEMP_DIR = downloadDir;
    console.log(`[Config] Download directory updated to: ${TEMP_DIR}`);
    res.json({ success: true, downloadDir: TEMP_DIR });
  } catch (err) {
    res.status(500).json({ error: `Failed to set download directory: ${err.message}` });
  }
});

// Reveal in System File Explorer (Windows / Linux / macOS)
app.post('/api/config/open-folder', (req, res) => {
  const { filePath } = req.body || {};
  const target = filePath || TEMP_DIR;
  try {
    if (process.platform === 'win32') {
      if (filePath && fs.existsSync(filePath)) {
        spawn('explorer.exe', [`/select,${path.normalize(filePath)}`], { detached: true, stdio: 'ignore' });
      } else {
        spawn('explorer.exe', [path.normalize(target)], { detached: true, stdio: 'ignore' });
      }
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' });
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' });
    }
    res.json({ success: true, opened: target });
  } catch (err) {
    res.status(500).json({ error: `Cannot open folder: ${err.message}` });
  }
});

// ==========================================
// Inbuilt FLAC Checker & Lossless Endpoints
// ==========================================

// List recent FLAC files for quick inspection
app.get('/api/flac-check/recent', (req, res) => {
  try {
    const searchDirs = [
      TEMP_DIR,
      path.join(__dirname, 'temp_media'),
      path.join(process.env.USERPROFILE || 'C:\\Users\\sayan', 'Downloads', 'JAV-Downloader')
    ];

    const results = [];
    const seen = new Set();

    for (const dir of searchDirs) {
      if (!dir || !fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (f.toLowerCase().endsWith('.flac')) {
            const fullPath = path.join(dir, f);
            if (!seen.has(fullPath)) {
              seen.add(fullPath);
              try {
                const stat = fs.statSync(fullPath);
                results.push({
                  filename: f,
                  filePath: fullPath,
                  sizeBytes: stat.size,
                  sizeMB: (stat.size / (1024 * 1024)).toFixed(2),
                  mtime: stat.mtimeMs
                });
              } catch (e) {}
            }
          }
        }
      } catch (e) {}
    }

    results.sort((a, b) => b.mtime - a.mtime);
    res.json(results.slice(0, 25));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run FLAC Authenticity Analysis
app.post('/api/flac-check', async (req, res) => {
  let targetPath = null;
  let isTempFile = false;

  try {
    const { filePath, fileBase64, fileName, jobId } = req.body || {};

    if (filePath && fs.existsSync(filePath)) {
      targetPath = filePath;
    } else if (jobId && jobs.has(jobId)) {
      const job = jobs.get(jobId);
      if (job.filePath && fs.existsSync(job.filePath)) {
        targetPath = job.filePath;
      }
    } else if (fileBase64) {
      const safeName = (fileName || 'inspect_upload.flac').replace(/[\\/:*?"<>|]/g, '_');
      targetPath = path.join(TEMP_DIR, `flac_check_${Date.now()}_${safeName}`);
      isTempFile = true;
      const base64Data = fileBase64.replace(/^data:.*?;base64,/, '');
      fs.writeFileSync(targetPath, Buffer.from(base64Data, 'base64'));
    }

    if (!targetPath || !fs.existsSync(targetPath)) {
      return res.status(400).json({ error: 'Valid audio file or filePath is required' });
    }

    const pythonBin = getPythonBin();
    const checkerScript = path.join(__dirname, 'flac_checker.py');

    const pyProcess = spawn(pythonBin, [checkerScript, targetPath], { windowsHide: true });
    let stdoutData = '';
    let stderrData = '';

    pyProcess.stdout.on('data', d => stdoutData += d.toString());
    pyProcess.stderr.on('data', d => stderrData += d.toString());

    pyProcess.on('close', code => {
      if (isTempFile) {
        try { fs.unlinkSync(targetPath); } catch (e) {}
      }

      try {
        const jsonRes = JSON.parse(stdoutData.trim());
        res.json(jsonRes);
      } catch (parseErr) {
        res.status(500).json({
          error: 'Failed to parse checker output',
          rawStdout: stdoutData,
          rawStderr: stderrData
        });
      }
    });

  } catch (err) {
    if (isTempFile && targetPath && fs.existsSync(targetPath)) {
      try { fs.unlinkSync(targetPath); } catch (e) {}
    }
    res.status(500).json({ error: err.message });
  }
});


// 1. Metadata Extraction Endpoint
app.post('/api/extract', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const meta = await extractMetadata(url);
    res.json(meta);
  } catch (err) {
    console.error('Extract error:', err.message);
    const msg = err.message || 'Failed to extract media information';
    const isNotFound = msg.toLowerCase().includes('not found') || msg.includes('404') || msg.toLowerCase().includes('private');
    res.status(isNotFound ? 404 : 400).json({ error: msg });
  }
});

// Helper to start the actual process
function startJobProcess(job) {
  job.status = 'downloading';
  job.startTime = Date.now();
  job.progress.eta = 'Starting...';
  broadcastJobUpdate(job.id);

  const { opts } = job;
  let {
    url, hlsUrl, downloadTargetUrl, mode, videoQuality, videoFormat,
    audioFormat, audioBitrate, embedThumbnail, embedMetadata, embedSubtitles,
    subLangs, autoSubs, sponsorBlock, splitChapters, customArgs, concurrentFragments
  } = opts;

  mode = mode || 'video';
  concurrentFragments = parseInt(concurrentFragments, 10) || 8;
  const rawTarget = downloadTargetUrl || hlsUrl || url || '';

  const isJavGuru = (url && url.includes('jav.guru')) || (rawTarget && rawTarget.includes('maxstream.org'));
  const isSpotify = url && url.includes('spotify.com');
  const isSpotifyPlaylistOrAlbum = url && (url.includes('spotify.com/playlist') || url.includes('spotify.com/album'));
  const isYouTube = url && (url.includes('youtube.com') || url.includes('youtu.be'));
  const isYouTubeFlac = isYouTube && mode === 'audio' && audioFormat === 'flac';
  const isAppleOrDeezer = url && (url.includes('music.apple.com') || url.includes('deezer.com'));
  const isInstagram = url && url.includes('instagram.com');
  const isTikTok = url && url.includes('tiktok.com');

  if (isTikTok) {
    const pythonBin = getPythonBin();
    const ttScript = path.join(__dirname, 'tiktok_engine.py');
    const safeTitle = (job.title || 'tiktok_media').replace(/[\\/:*?"<>|]/g, '_').trim();
    const finalOutPath = path.join(TEMP_DIR, `${job.id}_${safeTitle}`);

    job.logs.push(`Starting TikTok Watermark-Free HD Engine...`);
    job.logs.push(`Target: ${url}`);

    const child = spawn(pythonBin, [
      ttScript,
      url,
      finalOutPath,
      mode || 'video',
      audioFormat || 'mp3',
      audioBitrate || '320k'
    ], { windowsHide: true });
    job.process = child;
    attachProcessListeners(job, child);
  } else if (isInstagram) {
    const pythonBin = getPythonBin();
    const igScript = path.join(__dirname, 'instagram_engine.py');
    const safeTitle = (job.title || 'instagram_media').replace(/[\\/:*?"<>|]/g, '_').trim();
    const finalOutPath = path.join(TEMP_DIR, `${job.id}_${safeTitle}`);

    job.logs.push(`Starting Instagram FastCDN Video Engine...`);
    job.logs.push(`Target: ${url}`);

    const child = spawn(pythonBin, [
      igScript,
      url,
      finalOutPath,
      mode || 'video',
      audioFormat || 'mp3',
      audioBitrate || '320k'
    ], { windowsHide: true });
    job.process = child;
    attachProcessListeners(job, child);
  } else if (isSpotify) {
    const pythonBin = getPythonBin();
    const spotifyScript = path.join(__dirname, 'spotify_downloader.py');
    const isFlac = (mode === 'audio' && audioFormat === 'flac');
    const ext = isFlac ? 'flac' : (audioFormat || 'mp3');
    const safeTitle = (job.title || 'spotify_media').replace(/[\\/:*?"<>|]/g, '_').trim();
    const finalOutPath = isSpotifyPlaylistOrAlbum
      ? path.join(TEMP_DIR, `${job.id}_${safeTitle}.zip`)
      : path.join(TEMP_DIR, `${job.id}_${safeTitle}.${ext}`);

    job.logs.push(`Starting SpotiFLAC-Next ${isFlac ? 'True Lossless FLAC' : (audioFormat || 'mp3').toUpperCase()} Engine...`);
    job.logs.push(`Target: ${url}`);

    const child = spawn(pythonBin, [
      spotifyScript,
      url,
      finalOutPath,
      isFlac ? 'flac' : (audioFormat || 'mp3'),
      audioBitrate || '320k'
    ], { windowsHide: true });
    job.process = child;
    attachProcessListeners(job, child);
  } else if (isYouTubeFlac) {
    const pythonBin = getPythonBin();
    const slskScript = path.join(__dirname, 'soulseek_flac_engine.py');
    const safeTitle = (job.title || 'youtube_audio').replace(/[\\/:*?"<>|]/g, '_').trim();
    const finalOutPath = path.join(TEMP_DIR, `${job.id}_${safeTitle}.flac`);

    let artist = '';
    let trackTitle = job.title || '';
    if (job.title && job.title.includes(' - ')) {
      const parts = job.title.split(' - ');
      artist = parts[0].trim();
      trackTitle = parts.slice(1).join(' - ').trim();
    } else {
      artist = job.uploader || '';
    }

    job.logs.push(`Lossless FLAC requested for YouTube music: "${job.title}"`);
    job.logs.push(`Notice: YouTube audio is lossy (128-160kbps Opus). Querying decentralized Soulseek HiFi network for authentic CD/Vinyl Master FLAC...`);

    const child = spawn(pythonBin, [
      slskScript,
      artist,
      trackTitle,
      finalOutPath
    ], { windowsHide: true });
    job.process = child;
    attachProcessListeners(job, child);
  } else if (isAppleOrDeezer && tools.freyrPath && !opts.fallbackMode) {
    job.isFreyr = true;
    const freyrArgs = [
      'get',
      '--no-logo',
      '--no-header',
      '--no-tree',
      '--no-browser',
      '--no-auth',
      '--no-net-check',
      '-b', '320',
      '-d', TEMP_DIR,
      url
    ];

    job.logs.push(`Starting Freyr-JS High-Quality Music Engine...`);
    job.logs.push(`Command: freyr ${freyrArgs.join(' ')}`);

    const child = spawn(tools.freyrPath, freyrArgs, { windowsHide: true });
    job.process = child;
    attachProcessListeners(job, child);
  } else if (isJavGuru) {
    const pythonBin = getPythonBin();
    const hlsScript = path.join(__dirname, 'hls_downloader.py');
    const finalOutPath = path.join(TEMP_DIR, `${job.id}_${job.title}.mp4`);

    job.logs.push(`Starting JavGuru High-Speed Stream Engine...`);
    job.logs.push(`Target: ${url || rawTarget}`);

    const child = spawn(pythonBin, [hlsScript, url || rawTarget, finalOutPath], { windowsHide: true });
    job.process = child;
    attachProcessListeners(job, child);
  } else {
    const concurrentFragments = parseInt(opts.concurrentFragments, 10) || 16;
    const outputTemplate = path.join(TEMP_DIR, `${job.id}_${job.title}.%(ext)s`);
    const args = [
      '--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      '--concurrent-fragments', String(concurrentFragments),
      '--buffer-size', '16M',
      '--http-chunk-size', '10M',
      '--retries', '10',
      '--fragment-retries', '10',
      '--newline',
      '--ignore-errors',
      '--no-abort-on-error',
      '--extractor-args', 'youtube:player_client=android',
      '--js-runtimes', process.platform === 'win32' ? 'node' : 'node:/usr/bin/node',
      '-o', outputTemplate
    ];

    if (process.platform === 'linux') {
      try {
        execSync('which aria2c', { stdio: 'ignore' });
        args.push('--downloader', 'http,https:aria2c');
        args.push('--downloader-args', 'aria2c:-s 16 -x 16 -k 1M -j 16 --min-split-size=1M --summary-interval=1');
      } catch (e) {}
    } else if (process.platform === 'win32') {
      args.push('--impersonate', 'chrome');
    }

    if (tools.ffmpegDir) {
      args.unshift(tools.ffmpegDir);
      args.unshift('--ffmpeg-location');
    }

    // Dynamic Referers for JAV streaming CDNs & adult networks
    if (rawTarget.includes('phncdn.com') || (url && url.includes('pornhub'))) {
      args.push('--add-header', 'Referer: https://www.pornhub.com/');
    } else if (rawTarget.includes('surrit.com') || rawTarget.includes('sixyik.com') || (url && url.includes('missav'))) {
      args.push('--add-header', 'Referer: https://missav.ws/');
    } else if (url && url.includes('jable.tv')) {
      args.push('--add-header', 'Referer: https://en.jable.tv/');
    } else if (url && (url.includes('supjav') || url.includes('supremejav') || rawTarget.includes('turbovid') || rawTarget.includes('turboviplay'))) {
      args.push('--add-header', 'Referer: https://supjav.com/');
    } else if (url && url.includes('javgg')) {
      args.push('--add-header', 'Referer: https://javgg.net/');
    } else if (url && url.includes('njav')) {
      args.push('--add-header', 'Referer: https://njav.tv/');
    } else if (url && (url.includes('xvideos') || url.includes('xnxx'))) {
      args.push('--add-header', 'Referer: https://www.xvideos.com/');
    } else if (url && url.includes('xhamster')) {
      args.push('--add-header', 'Referer: https://xhamster.com/');
    } else if (url && url.includes('rule34video')) {
      args.push('--add-header', 'Referer: https://rule34video.com/');
    }

    // Mode options
    if (mode === 'audio') {
      args.push('-x');
      const aFmt = audioFormat || 'mp3';
      args.push('--audio-format', aFmt);
      const aBit = audioBitrate || '320k';
      args.push('--audio-quality', aBit === 'best' ? '0' : aBit);
    } else {
      if (videoQuality && videoQuality !== 'best') {
        const maxHeight = parseInt(videoQuality, 10);
        args.push('-f', `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`);
      } else {
        args.push('-f', 'bestvideo+bestaudio/best');
      }

      if (videoFormat && videoFormat !== 'auto') {
        args.push('--merge-output-format', videoFormat);
      }
    }

    // Subtitles (only for video)
    if (embedSubtitles && mode !== 'audio') {
      args.push('--embed-subs');
      if (subLangs && subLangs.trim()) {
        args.push('--sub-langs', subLangs.trim());
      } else {
        args.push('--sub-langs', 'all,-live_chat');
      }
      if (autoSubs) {
        args.push('--write-auto-subs');
      }
    }

    // Metadata & Thumbnails
    if (embedThumbnail !== false) args.push('--embed-thumbnail');
    if (embedMetadata !== false) {
      args.push('--embed-metadata');
      args.push('--embed-chapters');
    }

    // SponsorBlock
    if (sponsorBlock) args.push('--sponsorblock-remove', 'all');

    // Split Chapters
    if (splitChapters) args.push('--split-chapters');

    // Custom flags
    if (customArgs && typeof customArgs === 'string') {
      const extra = customArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      for (const arg of extra) {
        args.push(arg.replace(/^["']|["']$/g, ''));
      }
    }

    const isJable = url && url.includes('jable.tv');
    const targetUrl = (isJable && hlsUrl) ? hlsUrl : (downloadTargetUrl || url);
    args.push(targetUrl);

    job.logs.push(`Starting ${mode.toUpperCase()} processing...`);
    job.logs.push(`Arguments: ${args.join(' ')}`);

    const child = spawn(tools.ytdlpPath, args, { windowsHide: true });
    job.process = child;
    attachProcessListeners(job, child);
  }
}

function attachProcessListeners(job, child) {
  const jobId = job.id;

  const parseProgress = (line) => {
    // Aria2 progress parser: [#fd6ef8 510MiB/1.3GiB(36%) CN:16 DL:17MiB ETA:49s]
    const ariaMatch = line.match(/\[#\w+\s+([\d.]+\s*[a-zA-Z]+)\/([\d.]+\s*[a-zA-Z]+)\((\d+)%\).*?DL:([\d.]+\s*[a-zA-Z]+).*?ETA:([\d:\w]+)/i);
    if (ariaMatch) {
      job.progress.downloadedSize = ariaMatch[1];
      job.progress.totalSize = ariaMatch[2];
      job.progress.percent = parseFloat(ariaMatch[3]) || 0;
      job.progress.speed = ariaMatch[4] + '/s';
      job.progress.eta = ariaMatch[5];
      return;
    }

    const pMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*[a-zA-Z]+)?\s+at\s+([\d.]+\s*[a-zA-Z/]+)\s+ETA\s+([\d:]+|\w+)/i);
    if (pMatch) {
      job.progress.percent = parseFloat(pMatch[1]) || 0;
      if (pMatch[2]) job.progress.totalSize = pMatch[2].trim();
      if (pMatch[3]) job.progress.speed = pMatch[3].trim();
      if (pMatch[4]) job.progress.eta = pMatch[4].trim();
      return;
    }

    const pMatch2 = line.match(/\[download\]\s+([\d.]+)%/i);
    if (pMatch2) {
      job.progress.percent = parseFloat(pMatch2[1]) || 0;
    }

    const speedMatch = line.match(/at\s+([\d.]+\s*(?:KiB|MiB|GiB|B|KB|MB|GB)\/s)/i);
    if (speedMatch) job.progress.speed = speedMatch[1];

    const etaMatch = line.match(/ETA\s+([\d:]+)/i);
    if (etaMatch) job.progress.eta = etaMatch[1];

    const sizeMatch = line.match(/of\s+~?\s*([\d.]+\s*(?:KiB|MiB|GiB|B|KB|MB|GB))/i);
    if (sizeMatch) job.progress.totalSize = sizeMatch[1];

    // Freyr-JS progress parsing
    if (line.includes('Identifying service') || line.includes('Checking authentication')) {
      job.progress.eta = 'Resolving...';
      job.progress.percent = 15;
      return;
    }
    if (line.includes('Downloading track') || line.includes('Fetching') || line.includes('Collate:')) {
      job.progress.eta = 'Downloading...';
      job.progress.percent = 50;
      return;
    }
    if (line.includes('Embedding metadata') || line.includes('Tagging') || line.includes('Embedding:')) {
      job.progress.eta = 'Embedding tags...';
      job.progress.percent = 85;
      return;
    }

    const fragMatch = line.match(/\(frag\s+([0-9]+)\/([0-9]+)\)/i);
    if (fragMatch) {
      job.progress.currentFrag = parseInt(fragMatch[1], 10);
      job.progress.totalFrag = parseInt(fragMatch[2], 10);
    }
  };

  child.stdout.on('data', (data) => {
    const lines = data.toString().split(/[\r\n]+/).filter(Boolean);
    for (const line of lines) {
      job.logs.push(line);
      if (job.logs.length > 80) job.logs.shift();
      parseProgress(line);
    }
    broadcastJobUpdate(jobId);
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().split(/[\r\n]+/).filter(Boolean);
    for (const line of lines) {
      job.logs.push(`[ERR] ${line}`);
      if (job.logs.length > 80) job.logs.shift();
    }
    broadcastJobUpdate(jobId);
  });

  child.on('close', (code) => {
    job.completedTime = Date.now();
    job.process = null;

    if (job.isFreyr && code !== 0) {
      job.logs.push(`[FALLBACK] Freyr exited with code ${code}. Engaging Universal High-Speed Spotify Engine...`);
      job.isFreyr = false;
      startJobProcess(job, { ...job.opts, fallbackMode: true });
      return;
    }

    if (code === 0) {
      try {
        const files = fs.readdirSync(TEMP_DIR);
        // Find actual completed media file (strictly regular files, exclude directories and temporary artifacts)
        let matched = files.find(f => {
          if (!f.startsWith(`${jobId}_`)) return false;
          if (f.endsWith('_work') || f.endsWith('_parts') || f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.temp') || f.includes('_playlist_dir')) return false;
          try {
            const p = path.join(TEMP_DIR, f);
            const st = fs.statSync(p);
            return st.isFile() && st.size > 0;
          } catch (e) {
            return false;
          }
        });

        // If freyr downloaded without prefix, find recent audio file
        if (!matched && job.isFreyr) {
          const musicFiles = files
            .filter(f => f.endsWith('.m4a') || f.endsWith('.mp3') || f.endsWith('.flac'))
            .map(f => ({ name: f, time: fs.statSync(path.join(TEMP_DIR, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);
          if (musicFiles.length > 0) {
            const src = path.join(TEMP_DIR, musicFiles[0].name);
            const dst = path.join(TEMP_DIR, `${jobId}_${musicFiles[0].name}`);
            fs.renameSync(src, dst);
            matched = `${jobId}_${musicFiles[0].name}`;
          }
        }

        // Secondary fallback search if extension differed slightly
        if (!matched) {
          matched = files.find(f => {
            if (!f.includes(jobId)) return false;
            if (f.endsWith('_work') || f.endsWith('_parts') || f.endsWith('.part') || f.endsWith('.ytdl')) return false;
            try {
              const p = path.join(TEMP_DIR, f);
              return fs.statSync(p).isFile() && fs.statSync(p).size > 0;
            } catch (e) {
              return false;
            }
          });
        }

        if (matched) {
          job.filePath = path.join(TEMP_DIR, matched);
          job.filename = matched.replace(`${jobId}_`, '');
          const stat = fs.statSync(job.filePath);
          if (stat.size > 0) {
            job.status = 'completed';
            job.progress.percent = 100;
            job.progress.eta = 'Ready';
            job.logs.push('Processing completed! Ready to save to device.');
            job.filesize = stat.size > (1024 ** 3)
              ? (stat.size / (1024 ** 3)).toFixed(2) + ' GB'
              : (stat.size / (1024 ** 2)).toFixed(1) + ' MB';
          } else {
            job.status = 'failed';
            job.error = 'Downloaded file was 0 bytes.';
            job.logs.push('[ERR] Media file was empty (0 bytes).');
          }
        } else {
          job.status = 'failed';
          job.error = 'No output media file was generated.';
          job.logs.push('[ERR] Media file was not found in temp directory.');
        }
      } catch (e) {
        job.status = 'failed';
        job.error = e.message;
        job.logs.push(`[ERR] File verification error: ${e.message}`);
      }
    } else {
      if (job.status !== 'cancelled') {
        job.status = 'failed';
        job.error = `Engine exited with code ${code}`;
        job.logs.push(`Process failed with exit code ${code}`);
      }
    }
    broadcastJobUpdate(jobId);
    processDownloadQueue();
  });
}

function createAndStartJob(opts) {
  let {
    url, customFilename, title, code, poster, mode, videoFormat, audioFormat
  } = opts;

  mode = mode || 'video';
  const safeTitle = (customFilename || title || 'video_' + Date.now()).replace(/[\\/:*?"<>|]/g, '_').trim();
  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

  const ext = mode === 'audio' ? (audioFormat || 'mp3') : (videoFormat && videoFormat !== 'auto' ? videoFormat : 'mp4');
  const finalFilename = `${safeTitle}.${ext}`;
  const filePath = path.join(TEMP_DIR, `${jobId}_${finalFilename}`);

  const job = {
    id: jobId,
    url,
    opts,
    title: safeTitle,
    code: code || 'MEDIA',
    poster: poster || '',
    mode,
    filePath,
    filename: finalFilename,
    filesize: '',
    status: 'queued',
    progress: {
      percent: 0,
      speed: '0 MB/s',
      eta: 'Queued',
      downloadedSize: '0 MB',
      totalSize: '0 MB',
      currentFrag: 0,
      totalFrag: 0
    },
    logs: [],
    error: null,
    startTime: Date.now(),
    completedTime: null,
    process: null
  };

  jobs.set(jobId, job);

  // Check if we can start immediately or queue
  if (getActiveDownloadCount() < MAX_CONCURRENT_DOWNLOADS) {
    startJobProcess(job);
  } else {
    job.logs.push('Task queued (waiting for active downloads to complete)...');
    broadcastJobUpdate(jobId);
  }

  return job;
}

// 2. Start Download Job
app.post('/api/download', async (req, res) => {
  try {
    const payload = req.body;
    let { url, title } = payload;

    if (!url) return res.status(400).json({ error: 'URL is required' });

    if (!title) {
      try {
        const meta = await extractMetadata(url);
        payload.hlsUrl = meta.hlsUrl;
        payload.title = meta.title;
        payload.code = meta.code;
        payload.poster = meta.poster;
        payload.downloadTargetUrl = meta.downloadTargetUrl;
      } catch (e) {}
    }

    const job = createAndStartJob(payload);
    res.json({
      success: true,
      jobId: job.id,
      title: job.title,
      filename: job.filename,
      mode: job.mode
    });
  } catch (err) {
    console.error('Download dispatch error:', err);
    res.status(500).json({ error: err.message || 'Failed to initialize download' });
  }
});

// 3. Batch Download
app.post('/api/batch-download', async (req, res) => {
  try {
    const { urls, ...opts } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'No URLs provided' });
    }

    const createdJobs = [];
    for (const u of urls) {
      const trimmed = u.trim();
      if (!trimmed) continue;

      let meta = null;
      try { meta = await extractMetadata(trimmed); } catch (e) {}

      const jobOpts = {
        ...opts,
        url: trimmed,
        hlsUrl: meta ? meta.hlsUrl : '',
        title: meta ? meta.title : '',
        code: meta ? meta.code : '',
        poster: meta ? meta.poster : '',
        downloadTargetUrl: meta ? meta.downloadTargetUrl : ''
      };

      const job = createAndStartJob(jobOpts);
      createdJobs.push({
        id: job.id,
        url: trimmed,
        title: job.title,
        filename: job.filename
      });
    }

    res.json({ success: true, count: createdJobs.length, jobs: createdJobs });
  } catch (err) {
    console.error('Batch error:', err);
    res.status(500).json({ error: err.message || 'Failed to process batch' });
  }
});

// 4. SSE Events Stream with Keep-Alive Heartbeat
app.get('/api/jobs/:id/events', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);

  if (!job) return res.status(404).send('Job not found');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (!sseClients.has(jobId)) {
    sseClients.set(jobId, new Set());
  }
  const clientSet = sseClients.get(jobId);
  clientSet.add(res);

  // Send initial snapshot
  broadcastJobUpdate(jobId);

  // Heartbeat ping every 15s to keep proxy/browser connections alive
  const pingTimer = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      clearInterval(pingTimer);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(pingTimer);
    clientSet.delete(res);
    if (clientSet.size === 0) {
      sseClients.delete(jobId);
    }
  });
});

// Get all jobs
app.get('/api/jobs', (req, res) => {
  const list = [];
  for (const job of jobs.values()) {
    list.push({
      id: job.id,
      url: job.url,
      title: job.title,
      code: job.code,
      poster: job.poster,
      mode: job.mode,
      filename: job.filename,
      filesize: job.filesize || '',
      status: job.status,
      progress: job.progress,
      error: job.error,
      startTime: job.startTime,
      completedTime: job.completedTime,
      downloadUrl: `/api/download-file/${job.id}`,
      streamUrl: `/api/stream/${job.id}`,
      filePath: job.filePath || '',
      lastLog: job.logs.length > 0 ? job.logs[job.logs.length - 1] : ''
    });
  }
  res.json(list);
});

// 5. Cancel Job (Tree termination & partial cleanup)
app.post('/api/jobs/:id/cancel', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  job.status = 'cancelled';
  job.logs.push('Download cancelled by user.');

  if (job.process) {
    const pid = job.process.pid;
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } else {
        execSync(`kill -9 ${pid} 2>/dev/null`, { stdio: 'ignore' });
      }
    } catch (e) {
      try { job.process.kill('SIGKILL'); } catch (err) {}
    }
    job.process = null;
  }

  // Clean temp files & parts folders
  try {
    const files = fs.readdirSync(TEMP_DIR);
    for (const f of files) {
      if (f.startsWith(`${jobId}_`)) {
        const fullPath = path.join(TEMP_DIR, f);
        if (fs.lstatSync(fullPath).isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      }
    }
  } catch (e) {}

  broadcastJobUpdate(jobId);
  processDownloadQueue();
  res.json({ success: true, message: 'Download cancelled and cleaned up' });
});

// Remove Single Job
app.delete('/api/jobs/:id', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);

  if (job && job.process) {
    const pid = job.process.pid;
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } else {
        execSync(`kill -9 ${pid} 2>/dev/null`, { stdio: 'ignore' });
      }
    } catch (e) {
      try { job.process.kill('SIGKILL'); } catch (err) {}
    }
  }

  try {
    const files = fs.readdirSync(TEMP_DIR);
    for (const f of files) {
      if (f.startsWith(`${jobId}_`)) {
        const fullPath = path.join(TEMP_DIR, f);
        if (fs.lstatSync(fullPath).isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      }
    }
  } catch (e) {}

  jobs.delete(jobId);
  processDownloadQueue();
  res.json({ success: true, message: 'Job deleted' });
});

// Clear All Inactive Jobs
app.delete('/api/jobs', (req, res) => {
  for (const [id, job] of jobs.entries()) {
    if (job.status !== 'downloading' && job.status !== 'queued') {
      try {
        const files = fs.readdirSync(TEMP_DIR);
        for (const f of files) {
          if (f.startsWith(`${id}_`)) {
            const fullPath = path.join(TEMP_DIR, f);
            if (fs.lstatSync(fullPath).isDirectory()) {
              fs.rmSync(fullPath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(fullPath);
            }
          }
        }
      } catch (e) {}
      jobs.delete(id);
    }
  }
  res.json({ success: true, message: 'Cleared completed jobs' });
});

// 6. Direct Browser File Download
app.get('/api/download-file/:id', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);

  if (!job) {
    try {
      const files = fs.readdirSync(TEMP_DIR);
      const matched = files.find(f => f.startsWith(`${jobId}_`) && !f.endsWith('_parts'));
      if (matched) {
        const fullPath = path.join(TEMP_DIR, matched);
        const clientFilename = matched.replace(`${jobId}_`, '');
        return res.download(fullPath, clientFilename);
      }
    } catch (e) {}
    return res.status(404).send('File not found or expired');
  }

  if (job.filePath && fs.existsSync(job.filePath)) {
    return res.download(job.filePath, job.filename);
  }

  try {
    const files = fs.readdirSync(TEMP_DIR);
    const matched = files.find(f => f.startsWith(`${jobId}_`) && !f.endsWith('_parts'));
    if (matched) {
      const fullPath = path.join(TEMP_DIR, matched);
      return res.download(fullPath, job.filename || matched.replace(`${jobId}_`, ''));
    }
  } catch (e) {}

  res.status(404).send('File is still processing or has expired');
});

// 7. Media Streaming Endpoint
app.get('/api/stream/:id', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  let filePath = job ? job.filePath : null;

  if (!filePath || !fs.existsSync(filePath)) {
    try {
      const files = fs.readdirSync(TEMP_DIR);
      const matched = files.find(f => f.startsWith(`${jobId}_`) && !f.endsWith('_parts'));
      if (matched) filePath = path.join(TEMP_DIR, matched);
    } catch (e) {}
  }

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const ext = path.extname(filePath).toLowerCase();

  const mimeTypes = {
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.opus': 'audio/opus',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav',
    '.aac': 'audio/aac'
  };
  const contentType = mimeTypes[ext] || 'video/mp4';

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end, highWaterMark: 1024 * 1024 });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': contentType,
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }).pipe(res);
  }
});

// Periodic cleanup of temp files and parts folders older than 2 hours
setInterval(() => {
  try {
    const now = Date.now();
    const files = fs.readdirSync(TEMP_DIR);
    for (const f of files) {
      const full = path.join(TEMP_DIR, f);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > 2 * 3600 * 1000) {
        if (stat.isDirectory()) {
          fs.rmSync(full, { recursive: true, force: true });
        } else {
          fs.unlinkSync(full);
        }
      }
    }
  } catch (e) {}
}, 15 * 60 * 1000);

// Graceful Shutdown
function gracefulShutdown() {
  console.log('Shutting down server, terminating active download processes...');
  for (const job of jobs.values()) {
    if (job.process) {
      const pid = job.process.pid;
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
        } else {
          execSync(`kill -9 ${pid} 2>/dev/null`, { stdio: 'ignore' });
        }
      } catch (e) {}
    }
  }
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 Universal Downloader Web Service is running!`);
  console.log(`🌐 Server listening on http://0.0.0.0:${PORT}`);
  console.log(`====================================================`);
});
