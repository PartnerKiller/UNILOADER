const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const { extractMetadata } = require('./extractor');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_DIR = process.env.DEFAULT_DIR || (process.platform === 'win32' ? 'D:\\' : '/media/hdd/JAV');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Locate yt-dlp and ffmpeg cross-platform
function getToolPaths() {
  if (process.platform !== 'win32') {
    let ytdlpPath = 'yt-dlp';
    if (fs.existsSync('/usr/local/bin/yt-dlp')) ytdlpPath = '/usr/local/bin/yt-dlp';
    else if (fs.existsSync('/usr/bin/yt-dlp')) ytdlpPath = '/usr/bin/yt-dlp';
    return { ytdlpPath, ffmpegDir: '' };
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\sayan', 'AppData', 'Local');
  
  const ytdlpCandidates = [
    path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe', 'yt-dlp.exe'),
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
    'yt-dlp'
  ];

  const ffmpegCandidates = [
    path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0-full_build', 'bin'),
    path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-N-125875-g5d4d3bdc61-win64-gpl', 'bin'),
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
    ''
  ];

  let ytdlpPath = 'yt-dlp';
  for (const c of ytdlpCandidates) {
    if (fs.existsSync(c)) {
      ytdlpPath = c;
      break;
    }
  }

  let ffmpegDir = '';
  for (const c of ffmpegCandidates) {
    if (c && fs.existsSync(c)) {
      ffmpegDir = c;
      break;
    }
  }

  return { ytdlpPath, ffmpegDir };
}

const tools = getToolPaths();
console.log('Detected Tools:', tools);
console.log('Default Storage Directory:', DEFAULT_DIR);

// In-memory job store
const jobs = new Map();
const sseClients = new Map(); // jobId -> Set(res)

function broadcastJobUpdate(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  const clients = sseClients.get(jobId);
  if (clients) {
    const data = JSON.stringify({
      id: job.id,
      status: job.status,
      mode: job.mode,
      progress: job.progress,
      logs: job.logs.slice(-30),
      error: job.error,
      title: job.title,
      filename: job.filename,
      outputDir: job.outputDir
    });
    for (const res of clients) {
      res.write(`data: ${data}\n\n`);
    }
  }
}

// 0. Config Info
app.get('/api/config', (req, res) => {
  res.json({
    defaultDir: DEFAULT_DIR,
    platform: process.platform,
    hostname: require('os').hostname()
  });
});

// 1. Metadata Extraction
app.post('/api/extract', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const meta = await extractMetadata(url);
    res.json(meta);
  } catch (err) {
    console.error('Extract error:', err);
    res.status(500).json({ error: err.message || 'Failed to extract video information' });
  }
});

// Helper to spawn a download job
function createAndStartJob(opts) {
  let {
    url, outputDir, customFilename, concurrentFragments, hlsUrl, title, code, poster,
    downloadTargetUrl, mode, videoQuality, videoFormat, audioFormat, audioBitrate,
    embedThumbnail, embedMetadata, embedSubtitles, subLangs, autoSubs, sponsorBlock,
    splitChapters, customArgs
  } = opts;

  outputDir = outputDir || DEFAULT_DIR;
  mode = mode || 'video';
  concurrentFragments = parseInt(concurrentFragments, 10) || 8;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const safeTitle = (customFilename || title || 'video_' + Date.now()).replace(/[\\/:*?"<>|]/g, '_').trim();
  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

  const ext = mode === 'audio' ? (audioFormat || 'mp3') : (videoFormat && videoFormat !== 'auto' ? videoFormat : 'mp4');
  const finalFilename = `${safeTitle}.${ext}`;
  const outputTemplate = path.join(outputDir, `${safeTitle}.%(ext)s`);

  const job = {
    id: jobId,
    url,
    hlsUrl,
    title: safeTitle,
    code: code || 'MEDIA',
    poster: poster || '',
    mode,
    outputDir,
    filename: finalFilename,
    status: 'downloading',
    progress: {
      percent: 0,
      speed: '0 MB/s',
      eta: '--:--',
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

  // Build Seal-inspired yt-dlp arguments
  const args = [
    '--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    '--concurrent-fragments', String(concurrentFragments),
    '--retries', '10',
    '--fragment-retries', '10',
    '--newline',
    '-o', outputTemplate
  ];

  if (tools.ffmpegDir) {
    args.unshift(tools.ffmpegDir);
    args.unshift('--ffmpeg-location');
  }

  // Jable specific referer
  if (url && url.includes('jable.tv')) {
    args.push('--add-header', 'Referer: https://en.jable.tv/');
  }

  // 1. Audio-only mode (Seal feature)
  if (mode === 'audio') {
    args.push('-x');
    const aFmt = audioFormat || 'mp3';
    args.push('--audio-format', aFmt);
    const aBit = audioBitrate || '320k';
    args.push('--audio-quality', aBit === 'best' ? '0' : aBit);
  } else {
    // 2. Video quality & container selection (Seal feature)
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

  // 3. Subtitles (Seal feature)
  if (embedSubtitles) {
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

  // 4. Metadata & Thumbnails (Seal feature)
  if (embedThumbnail !== false) {
    args.push('--embed-thumbnail');
  }
  if (embedMetadata !== false) {
    args.push('--embed-metadata');
    args.push('--embed-chapters');
  }

  // 5. SponsorBlock (Seal feature)
  if (sponsorBlock) {
    args.push('--sponsorblock-remove', 'all');
  }

  // 6. Chapter splitting (Seal feature)
  if (splitChapters) {
    args.push('--split-chapters');
  }

  // 7. Custom yt-dlp flags (Seal feature)
  if (customArgs && typeof customArgs === 'string') {
    const extra = customArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    for (const arg of extra) {
      args.push(arg.replace(/^["']|["']$/g, ''));
    }
  }

  // Determine target URL:
  const isJable = url && url.includes('jable.tv');
  const targetUrl = (isJable && hlsUrl) ? hlsUrl : (downloadTargetUrl || url);
  args.push(targetUrl);

  job.logs.push(`Starting ${mode.toUpperCase()} download via yt-dlp engine...`);
  job.logs.push(`Target: ${outputTemplate}`);
  job.logs.push(`Arguments: ${args.join(' ')}`);

  const child = spawn(tools.ytdlpPath, args, { windowsHide: true });
  job.process = child;

  const parseProgress = (line) => {
    const percentMatch = line.match(/([0-9.]+)%/);
    if (percentMatch) {
      job.progress.percent = parseFloat(percentMatch[1]);
    }

    const speedMatch = line.match(/at\s+([0-9.]+\s*[KMGT]?i?B\/s)/i);
    if (speedMatch) {
      job.progress.speed = speedMatch[1];
    }

    const etaMatch = line.match(/ETA\s+([0-9:]+)/i);
    if (etaMatch) {
      job.progress.eta = etaMatch[1];
    }

    const totalSizeMatch = line.match(/of\s+~?\s*([0-9.]+\s*[KMGT]?i?B)/i);
    if (totalSizeMatch) {
      job.progress.totalSize = totalSizeMatch[1];
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
      if (job.logs.length > 200) job.logs.shift();
      parseProgress(line);
    }
    broadcastJobUpdate(jobId);
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().split(/[\r\n]+/).filter(Boolean);
    for (const line of lines) {
      job.logs.push(`[ERR] ${line}`);
      if (job.logs.length > 200) job.logs.shift();
    }
    broadcastJobUpdate(jobId);
  });

  child.on('close', (code) => {
    job.completedTime = Date.now();
    job.process = null;
    if (code === 0) {
      job.status = 'completed';
      job.progress.percent = 100;
      job.progress.eta = 'Done';
      job.logs.push('Download and post-processing completed successfully!');
    } else {
      if (job.status !== 'cancelled') {
        job.status = 'failed';
        job.error = `yt-dlp exited with error code ${code}`;
        job.logs.push(`Download failed with exit code ${code}`);
      }
    }
    broadcastJobUpdate(jobId);
  });

  return job;
}

// 2. Start Single Download Job
app.post('/api/download', async (req, res) => {
  try {
    const payload = req.body;
    let { url, title } = payload;

    if (!url) return res.status(400).json({ error: 'URL is required' });

    if (!title) {
      const meta = await extractMetadata(url);
      payload.hlsUrl = meta.hlsUrl;
      payload.title = meta.title;
      payload.code = meta.code;
      payload.poster = meta.poster;
      payload.downloadTargetUrl = meta.downloadTargetUrl;
    }

    const job = createAndStartJob(payload);
    res.json({
      success: true,
      jobId: job.id,
      title: job.title,
      outputDir: job.outputDir,
      filename: job.filename,
      mode: job.mode
    });
  } catch (err) {
    console.error('Download dispatch error:', err);
    res.status(500).json({ error: err.message || 'Failed to start download' });
  }
});

// 2b. Start Batch Download Jobs (Seal Batch feature)
app.post('/api/download/batch', async (req, res) => {
  try {
    const { urls, options } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'Array of URLs is required' });
    }

    const queuedJobs = [];
    for (const urlItem of urls) {
      const rawUrl = (typeof urlItem === 'string' ? urlItem : urlItem.url || '').trim();
      if (!rawUrl) continue;

      let meta = null;
      try {
        meta = await extractMetadata(rawUrl);
      } catch (e) {
        meta = { title: rawUrl.split('/').pop() || 'video', code: 'MEDIA', hlsUrl: rawUrl };
      }

      const jobPayload = {
        ...(options || {}),
        url: rawUrl,
        hlsUrl: meta.hlsUrl,
        downloadTargetUrl: meta.downloadTargetUrl || rawUrl,
        title: meta.title,
        code: meta.code,
        poster: meta.poster
      };

      const job = createAndStartJob(jobPayload);
      queuedJobs.push({ jobId: job.id, title: job.title, filename: job.filename });
    }

    res.json({ success: true, count: queuedJobs.length, jobs: queuedJobs });
  } catch (err) {
    console.error('Batch download error:', err);
    res.status(500).json({ error: err.message || 'Failed to start batch downloads' });
  }
});

// 3. List All Jobs
app.get('/api/jobs', (req, res) => {
  const jobList = Array.from(jobs.values()).map(j => ({
    id: j.id,
    url: j.url,
    title: j.title,
    code: j.code,
    poster: j.poster,
    mode: j.mode,
    outputDir: j.outputDir,
    filename: j.filename,
    status: j.status,
    progress: j.progress,
    error: j.error,
    startTime: j.startTime,
    completedTime: j.completedTime,
    lastLog: j.logs[j.logs.length - 1] || ''
  }));
  res.json(jobList.reverse());
});

// 4. SSE Stream for Live Job Progress
app.get('/api/jobs/:id/events', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!sseClients.has(jobId)) {
    sseClients.set(jobId, new Set());
  }
  sseClients.get(jobId).add(res);

  const initialData = JSON.stringify({
    id: job.id,
    status: job.status,
    mode: job.mode,
    progress: job.progress,
    logs: job.logs.slice(-30),
    error: job.error,
    title: job.title,
    filename: job.filename,
    outputDir: job.outputDir
  });
  res.write(`data: ${initialData}\n\n`);

  req.on('close', () => {
    const clients = sseClients.get(jobId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        sseClients.delete(jobId);
      }
    }
  });
});

// 5. Cancel Job
app.post('/api/jobs/:id/cancel', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.process) {
    job.status = 'cancelled';
    job.logs.push('Download cancelled by user.');
    if (process.platform === 'win32') {
      try { execSync(`taskkill /pid ${job.process.pid} /T /F`); } catch (e) { job.process.kill('SIGTERM'); }
    } else {
      try { execSync(`pkill -P ${job.process.pid}`); } catch (e) {}
      job.process.kill('SIGKILL');
    }
    broadcastJobUpdate(jobId);
    return res.json({ success: true, message: 'Download cancelled' });
  }

  res.json({ success: true, message: 'Job is not running' });
});

// 6. System Storage Query
app.get('/api/system/storage', (req, res) => {
  try {
    if (process.platform === 'win32') {
      const output = execSync(
        'powershell -Command "Get-PSDrive -PSProvider FileSystem | Select-Object Name, Used, Free, Root | ConvertTo-Json"',
        { encoding: 'utf-8', timeout: 5000 }
      );
      let drives = JSON.parse(output);
      if (!Array.isArray(drives)) drives = [drives];

      const formatted = drives.map(d => ({
        name: d.Name,
        root: d.Root || (d.Name + ':\\'),
        usedGB: ((d.Used || 0) / (1024 ** 3)).toFixed(1),
        freeGB: ((d.Free || 0) / (1024 ** 3)).toFixed(1),
        totalGB: (((d.Used || 0) + (d.Free || 0)) / (1024 ** 3)).toFixed(1)
      }));
      return res.json(formatted);
    } else {
      const targetMount = fs.existsSync('/media/hdd') ? '/media/hdd' : '/';
      const output = execSync(`df -k ${targetMount} / 2>/dev/null | awk 'NR>1 {print $1, $2, $3, $4, $6}'`, { encoding: 'utf-8' });
      const lines = output.trim().split('\n');
      const formatted = [];
      const seen = new Set();

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          const mount = parts[4];
          if (seen.has(mount)) continue;
          seen.add(mount);
          const totalK = parseInt(parts[1], 10) || 0;
          const usedK = parseInt(parts[2], 10) || 0;
          const freeK = parseInt(parts[3], 10) || 0;

          formatted.push({
            name: mount === '/media/hdd' ? 'HDD' : (mount === '/' ? 'Root' : mount),
            root: mount,
            usedGB: (usedK / (1024 ** 2)).toFixed(1),
            freeGB: (freeK / (1024 ** 2)).toFixed(1),
            totalGB: (totalK / (1024 ** 2)).toFixed(1)
          });
        }
      }
      return res.json(formatted);
    }
  } catch (err) {
    res.json([
      { name: 'Storage', root: DEFAULT_DIR, freeGB: '298.0', totalGB: '300.0' }
    ]);
  }
});

// 7. Library: List files in destination directory (Supports Video & Audio files)
app.get('/api/library', (req, res) => {
  const dir = req.query.dir || DEFAULT_DIR;
  if (!fs.existsSync(dir)) {
    return res.json({ dir, files: [] });
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const mediaExts = ['.mp4', '.mkv', '.webm', '.ts', '.mov', '.avi', '.mp3', '.m4a', '.opus', '.flac', '.wav', '.aac'];

    const files = [];
    for (const ent of entries) {
      if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (mediaExts.includes(ext)) {
          const fullPath = path.join(dir, ent.name);
          try {
            const stat = fs.statSync(fullPath);
            const isAudio = ['.mp3', '.m4a', '.opus', '.flac', '.wav', '.aac'].includes(ext);
            files.push({
              name: ent.name,
              path: fullPath,
              type: isAudio ? 'audio' : 'video',
              ext: ext.replace('.', '').toUpperCase(),
              sizeBytes: stat.size,
              sizeFormatted: stat.size > (1024 ** 3) ? (stat.size / (1024 ** 3)).toFixed(2) + ' GB' : (stat.size / (1024 ** 2)).toFixed(1) + ' MB',
              sizeMB: (stat.size / (1024 ** 2)).toFixed(1) + ' MB',
              created: stat.birthtime,
              modified: stat.mtime
            });
          } catch (e) {}
        }
      }
    }

    files.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    res.json({ dir, files });
  } catch (err) {
    res.status(500).json({ error: `Could not read directory: ${err.message}` });
  }
});

// 8. Media Streaming Endpoint with Range Support (Video & Audio)
app.get('/api/stream', (req, res) => {
  const filePath = req.query.file;
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
    const file = fs.createReadStream(filePath, { start, end });
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
    fs.createReadStream(filePath).pipe(res);
  }
});

// 9. Open Directory in File Explorer (Windows only)
app.post('/api/open-folder', (req, res) => {
  const targetDir = req.body.dir || DEFAULT_DIR;
  if (process.platform === 'win32') {
    try {
      spawn('explorer.exe', [targetDir], { detached: true, stdio: 'ignore' });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  res.json({ success: true, message: 'Platform is Linux' });
});

// 10. Delete file
app.delete('/api/file', (req, res) => {
  const targetFile = req.body.file;
  if (!targetFile || !fs.existsSync(targetFile)) {
    return res.status(404).json({ error: 'File not found' });
  }
  try {
    fs.unlinkSync(targetFile);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 Vortex Universal Downloader & Stream Web UI is running!`);
  console.log(`🌐 Server listening on http://0.0.0.0:${PORT}`);
  console.log(`📁 Default Output Directory: ${DEFAULT_DIR}`);
  console.log(`====================================================`);
});
