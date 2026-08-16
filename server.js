const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const { extractMetadata } = require('./extractor');

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp_media');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

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
      filesize: job.filesize || '',
      downloadUrl: `/api/download-file/${job.id}`,
      streamUrl: `/api/stream/${job.id}`
    });
    for (const res of clients) {
      res.write(`data: ${data}\n\n`);
    }
  }
}

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
    url, customFilename, concurrentFragments, hlsUrl, title, code, poster,
    downloadTargetUrl, mode, videoQuality, videoFormat, audioFormat, audioBitrate,
    embedThumbnail, embedMetadata, embedSubtitles, subLangs, autoSubs, sponsorBlock,
    splitChapters, customArgs
  } = opts;

  mode = mode || 'video';
  concurrentFragments = parseInt(concurrentFragments, 10) || 8;

  const safeTitle = (customFilename || title || 'video_' + Date.now()).replace(/[\\/:*?"<>|]/g, '_').trim();
  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

  const ext = mode === 'audio' ? (audioFormat || 'mp3') : (videoFormat && videoFormat !== 'auto' ? videoFormat : 'mp4');
  const finalFilename = `${safeTitle}.${ext}`;
  const filePath = path.join(TEMP_DIR, `${jobId}_${finalFilename}`);
  const outputTemplate = path.join(TEMP_DIR, `${jobId}_${safeTitle}.%(ext)s`);

  const job = {
    id: jobId,
    url,
    hlsUrl,
    title: safeTitle,
    code: code || 'MEDIA',
    poster: poster || '',
    mode,
    filePath,
    filename: finalFilename,
    filesize: '',
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

  // Build yt-dlp arguments
  const args = [
    '--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    '--concurrent-fragments', String(concurrentFragments),
    '--retries', '10',
    '--fragment-retries', '10',
    '--newline',
    '--impersonate', 'chrome',
    '-o', outputTemplate
  ];

  if (tools.ffmpegDir) {
    args.unshift(tools.ffmpegDir);
    args.unshift('--ffmpeg-location');
  }

  // Dynamic Referers for JAV streaming CDNs & sites
  const rawTarget = downloadTargetUrl || hlsUrl || url || '';
  if (rawTarget.includes('surrit.com') || rawTarget.includes('sixyik.com') || (url && url.includes('missav'))) {
    args.push('--add-header', 'Referer: https://missav.ws/');
  } else if (url && url.includes('jable.tv')) {
    args.push('--add-header', 'Referer: https://en.jable.tv/');
  } else if (url && (url.includes('supjav') || url.includes('supremejav') || rawTarget.includes('turbovid') || rawTarget.includes('turboviplay'))) {
    args.push('--add-header', 'Referer: https://supjav.com/');
  } else if (url && url.includes('javgg')) {
    args.push('--add-header', 'Referer: https://javgg.net/');
  } else if (url && url.includes('njav')) {
    args.push('--add-header', 'Referer: https://njav.tv/');
  } else if ((url && url.includes('jav.guru')) || rawTarget.includes('maxstream.org')) {
    args.push('--add-header', 'Referer: https://maxstream.org/');
  } else if (url && (url.includes('xvideos') || url.includes('xnxx'))) {
    args.push('--add-header', 'Referer: https://www.xvideos.com/');
  } else if (url && url.includes('xhamster')) {
    args.push('--add-header', 'Referer: https://xhamster.com/');
  }

  // 1. Audio-only mode
  if (mode === 'audio') {
    args.push('-x');
    const aFmt = audioFormat || 'mp3';
    args.push('--audio-format', aFmt);
    const aBit = audioBitrate || '320k';
    args.push('--audio-quality', aBit === 'best' ? '0' : aBit);
  } else {
    // 2. Video quality & container selection
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

  // 3. Subtitles
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

  // 4. Metadata & Thumbnails
  if (embedThumbnail !== false) {
    args.push('--embed-thumbnail');
  }
  if (embedMetadata !== false) {
    args.push('--embed-metadata');
    args.push('--embed-chapters');
  }

  // 5. SponsorBlock
  if (sponsorBlock) {
    args.push('--sponsorblock-remove', 'all');
  }

  // 6. Chapter splitting
  if (splitChapters) {
    args.push('--split-chapters');
  }

  // 7. Custom yt-dlp flags
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

  const isJavGuru = (url && url.includes('jav.guru')) || (rawTarget && rawTarget.includes('maxstream.org'));

  let child;
  if (isJavGuru) {
    const pythonBin = fs.existsSync('C:\\Users\\sayan\\AppData\\Local\\Programs\\Python\\Python312\\python.exe')
      ? 'C:\\Users\\sayan\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
      : 'python';
    const hlsScript = path.join(__dirname, 'hls_downloader.py');
    const finalOutPath = path.join(TEMP_DIR, `${jobId}_${safeTitle}.mp4`);

    job.logs.push(`Starting JavGuru Stream Engine...`);
    job.logs.push(`Target: ${url || rawTarget}`);

    child = spawn(pythonBin, [hlsScript, url || rawTarget, finalOutPath], { windowsHide: true });
  } else {
    job.logs.push(`Starting ${mode.toUpperCase()} processing...`);
    job.logs.push(`Arguments: ${args.join(' ')}`);
    child = spawn(tools.ytdlpPath, args, { windowsHide: true });
  }
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
      job.progress.eta = 'Ready';
      job.logs.push('Processing completed! Ready to save to device.');

      // Find actual created file on disk
      try {
        const files = fs.readdirSync(TEMP_DIR);
        const matched = files.find(f => f.startsWith(`${jobId}_`));
        if (matched) {
          job.filePath = path.join(TEMP_DIR, matched);
          job.filename = matched.replace(`${jobId}_`, '');
          const stat = fs.statSync(job.filePath);
          job.filesize = stat.size > (1024 ** 3)
            ? (stat.size / (1024 ** 3)).toFixed(2) + ' GB'
            : (stat.size / (1024 ** 2)).toFixed(1) + ' MB';
        }
      } catch (e) {}
    } else {
      if (job.status !== 'cancelled') {
        job.status = 'failed';
        job.error = `Engine exited with code ${code}`;
        job.logs.push(`Process failed with exit code ${code}`);
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
      filename: job.filename,
      mode: job.mode
    });
  } catch (err) {
    console.error('Download dispatch error:', err);
    res.status(500).json({ error: err.message || 'Failed to start download' });
  }
});

// 2b. Start Batch Download Jobs
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
        meta = { title: rawUrl.split('/').pop() || 'media', code: 'MEDIA', hlsUrl: rawUrl };
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
    filename: j.filename,
    filesize: j.filesize || '',
    status: j.status,
    progress: j.progress,
    error: j.error,
    startTime: j.startTime,
    completedTime: j.completedTime,
    downloadUrl: `/api/download-file/${j.id}`,
    streamUrl: `/api/stream/${j.id}`,
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
    filesize: job.filesize || '',
    downloadUrl: `/api/download-file/${job.id}`,
    streamUrl: `/api/stream/${job.id}`
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

// 5. Cancel Job (Reliably kills process and removes partial files)
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

  // Remove any partial temp files for this job
  try {
    const files = fs.readdirSync(TEMP_DIR);
    for (const f of files) {
      if (f.startsWith(`${jobId}_`)) {
        fs.unlinkSync(path.join(TEMP_DIR, f));
      }
    }
  } catch (e) {}

  broadcastJobUpdate(jobId);
  res.json({ success: true, message: 'Download cancelled and cleaned up' });
});

// 5b. Remove / Delete Single Job
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

  // Remove temp files
  try {
    const files = fs.readdirSync(TEMP_DIR);
    for (const f of files) {
      if (f.startsWith(`${jobId}_`)) {
        fs.unlinkSync(path.join(TEMP_DIR, f));
      }
    }
  } catch (e) {}

  jobs.delete(jobId);
  res.json({ success: true, message: 'Job deleted' });
});

// 5c. Clear All Inactive Jobs
app.delete('/api/jobs', (req, res) => {
  for (const [id, job] of jobs.entries()) {
    if (job.status !== 'downloading') {
      try {
        const files = fs.readdirSync(TEMP_DIR);
        for (const f of files) {
          if (f.startsWith(`${id}_`)) {
            fs.unlinkSync(path.join(TEMP_DIR, f));
          }
        }
      } catch (e) {}
      jobs.delete(id);
    }
  }
  res.json({ success: true, message: 'Cleared completed jobs' });
});

// 6. Direct Browser File Download Endpoint (Delivers directly to user's device Downloads folder)
app.get('/api/download-file/:id', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);

  if (!job) {
    try {
      const files = fs.readdirSync(TEMP_DIR);
      const matched = files.find(f => f.startsWith(`${jobId}_`));
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

  // Fallback scan
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const matched = files.find(f => f.startsWith(`${jobId}_`));
    if (matched) {
      const fullPath = path.join(TEMP_DIR, matched);
      return res.download(fullPath, job.filename || matched.replace(`${jobId}_`, ''));
    }
  } catch (e) {}

  res.status(404).send('File is still processing or has expired');
});

// 7. Media Streaming Endpoint (Video & Audio In-Browser Preview)
app.get('/api/stream/:id', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  let filePath = job ? job.filePath : null;

  if (!filePath || !fs.existsSync(filePath)) {
    try {
      const files = fs.readdirSync(TEMP_DIR);
      const matched = files.find(f => f.startsWith(`${jobId}_`));
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

// Periodic cleanup of temp files older than 6 hours
setInterval(() => {
  try {
    const now = Date.now();
    const files = fs.readdirSync(TEMP_DIR);
    for (const f of files) {
      const full = path.join(TEMP_DIR, f);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > 6 * 3600 * 1000) {
        fs.unlinkSync(full);
      }
    }
  } catch (e) {}
}, 30 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 JAV-Downloader Web Service is running!`);
  console.log(`🌐 Server listening on http://0.0.0.0:${PORT}`);
  console.log(`====================================================`);
});
