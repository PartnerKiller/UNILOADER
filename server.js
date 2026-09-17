const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const os = require('os');

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
const { spawn, exec, execSync } = require('child_process');
const { extractMetadata, getYtDlpPath, getPythonBin } = require('./extractor');

const app = express();
const PORT = process.env.PORT || 3000;
let TEMP_DIR = process.env.TEMP_DIR || path.join(__dirname, 'temp_media');

// Global Dynamic Engine Configuration
const ENGINE_CONFIG_FILE = path.join(__dirname, 'engine_config.json');
const defaultEngineConfig = {
  maxConcurrentJobs: 4,
  aria2cFragments: 16,
  aria2cMinSplitSize: '1M',
  bufferSize: '16M',
  httpChunkSize: '10M',
  retries: 10,
  features: {
    adultHub: true,
    movieHub: true,
    torrentFallback: true,
    soulseekP2P: true,
    strictLossless: true,
    embedSubs: true,
    embedChapters: true,
    sponsorBlock: true,
    olamoviesSource: true,
    ytsSource: false,
    torrentsSource: false
  }
};
let engineConfig = { ...defaultEngineConfig };

function loadEngineConfig() {
  try {
    if (fs.existsSync(ENGINE_CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ENGINE_CONFIG_FILE, 'utf8'));
      engineConfig = {
        ...defaultEngineConfig,
        ...parsed,
        features: {
          ...defaultEngineConfig.features,
          ...(parsed.features || {})
        }
      };
    }
  } catch (e) {
    console.warn('[Config] Failed to load engine_config.json, using defaults:', e.message);
  }
}

function saveEngineConfig() {
  try {
    fs.writeFileSync(ENGINE_CONFIG_FILE, JSON.stringify(engineConfig, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Config] Failed to save engine_config.json:', e.message);
  }
}

loadEngineConfig();

function getMaxConcurrentDownloads() {
  return engineConfig.maxConcurrentJobs || 4;
}

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '150mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// Admin Panel Static Serving & Direct Routes
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin'), {
  maxAge: 0,
  etag: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  }
}));
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// Helper to synchronously download image artwork
function downloadImageSync(url, destPath) {
  if (!url || !destPath) return false;
  try {
    const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';
    execSync(`"${curlBin}" -sL -A "Mozilla/5.0" "${url}" -o "${destPath}"`, { timeout: 15000, stdio: 'ignore' });
    return fs.existsSync(destPath) && fs.statSync(destPath).size > 500;
  } catch (e) {
    return false;
  }
}

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

const HISTORY_FILE = path.join(TEMP_DIR, '.jobs_history.json');

function saveJobsHistory() {
  try {
    const records = [];
    for (const j of jobs.values()) {
      if (j.status === 'completed' && j.filePath && fs.existsSync(j.filePath)) {
        records.push({
          id: j.id,
          url: j.url || '',
          title: j.title || '',
          code: j.code || 'MEDIA',
          poster: j.poster || '',
          mode: j.mode || 'video',
          filename: j.filename || path.basename(j.filePath),
          filesize: j.filesize || '',
          filePath: j.filePath,
          status: 'completed',
          progress: { percent: 100, eta: 'Ready' },
          createdAt: j.createdAt || Date.now(),
          completedTime: j.completedTime || Date.now()
        });
      }
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(records, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Server] Failed to save jobs history:', e.message);
  }
}

function loadJobsHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const content = fs.readFileSync(HISTORY_FILE, 'utf8');
      const records = JSON.parse(content);
      if (Array.isArray(records)) {
        for (const r of records) {
          if (r && r.id && r.filePath && fs.existsSync(r.filePath)) {
            jobs.set(r.id, {
              ...r,
              logs: ['Processing completed! File ready in folder.'],
              downloadUrl: `/api/download-file/${r.id}`,
              streamUrl: `/api/stream/${r.id}`,
              process: null
            });
          }
        }
      }
    }
  } catch (e) {
    console.warn('[Server] Failed to load jobs history:', e.message);
  }

  // Scan TEMP_DIR for any media files from previous runs
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const mediaExtensions = new Set(['.mp4', '.mkv', '.webm', '.mp3', '.flac', '.m4a', '.wav', '.opus']);
    const knownPaths = new Set(Array.from(jobs.values()).map(j => path.normalize(j.filePath || '')));

    for (const f of files) {
      if (f.startsWith('.') || f.endsWith('_parts') || f.endsWith('.part') || f.endsWith('.ytdl')) continue;
      const fullPath = path.join(TEMP_DIR, f);
      const ext = path.extname(f).toLowerCase();
      if (!mediaExtensions.has(ext)) continue;

      if (!knownPaths.has(path.normalize(fullPath))) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile() && stat.size > 0) {
            const match = f.match(/^(job_\d+_[a-z0-9]+)_(.*)$/i);
            const id = match ? match[1] : `job_${Math.floor(stat.mtimeMs)}_${Math.random().toString(36).substring(2, 7)}`;
            const cleanName = match ? match[2] : f;
            const title = cleanName.replace(/\.[^.]+$/, '');
            const isAudio = ['.mp3', '.flac', '.m4a', '.wav', '.opus'].includes(ext);
            const sizeStr = stat.size > (1024 ** 3)
              ? (stat.size / (1024 ** 3)).toFixed(2) + ' GB'
              : (stat.size / (1024 ** 2)).toFixed(1) + ' MB';

            jobs.set(id, {
              id,
              url: '',
              title,
              code: title.substring(0, 15).toUpperCase(),
              poster: '',
              mode: isAudio ? 'audio' : 'video',
              filename: cleanName,
              filesize: sizeStr,
              filePath: fullPath,
              status: 'completed',
              progress: { percent: 100, eta: 'Ready' },
              logs: ['Processing completed! File ready in folder.'],
              createdAt: stat.mtimeMs,
              completedTime: stat.mtimeMs,
              downloadUrl: `/api/download-file/${id}`,
              streamUrl: `/api/stream/${id}`,
              process: null
            });
            knownPaths.add(path.normalize(fullPath));
          }
        } catch (e) {}
      }
    }
    saveJobsHistory();
  } catch (e) {}
}

function findMediaFileByJobId(jobId) {
  // 1. Check in-memory jobs Map
  const job = jobs.get(jobId);
  if (job && job.filePath && fs.existsSync(job.filePath)) {
    return { filePath: job.filePath, filename: job.filename || path.basename(job.filePath), job };
  }

  // 2. Check dedicated job folder in TEMP_DIR (e.g. for torrents or isolated downloads)
  try {
    const jobDir = path.join(TEMP_DIR, jobId);
    if (fs.existsSync(jobDir) && fs.statSync(jobDir).isDirectory()) {
      function scanDirForLargestMedia(dir) {
        let largest = null;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name.endsWith('.aria2') || entry.name.endsWith('.txt') || entry.name.endsWith('.nfo')) continue;
          const full = path.join(dir, entry.name);
          try {
            if (entry.isDirectory()) {
              const nested = scanDirForLargestMedia(full);
              if (nested && (!largest || nested.size > largest.size)) largest = nested;
            } else if (entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase();
              const isMedia = ['.mp4', '.mkv', '.avi', '.ts', '.wmv', '.flv', '.mov', '.webm', '.m4v', '.mp3', '.flac', '.m4a', '.wav'].includes(ext);
              const st = fs.statSync(full);
              if (isMedia || !largest) {
                if (!largest || st.size > largest.size) {
                  largest = { path: full, name: entry.name, size: st.size };
                }
              }
            }
          } catch (e) {}
        }
        return largest;
      }
      const found = scanDirForLargestMedia(jobDir);
      if (found) {
        return { filePath: found.path, filename: (job && job.filename) || found.name, job };
      }
    }
  } catch (e) {}

  // 3. Scan TEMP_DIR for prefixed files
  try {
    const files = fs.readdirSync(TEMP_DIR).filter(f => !f.startsWith('.') && !f.endsWith('_parts') && !f.endsWith('.part') && !f.endsWith('.ytdl'));

    let matched = files.find(f => f.startsWith(`${jobId}_`));
    if (matched) {
      const fullPath = path.join(TEMP_DIR, matched);
      return { filePath: fullPath, filename: matched.replace(`${jobId}_`, ''), job };
    }

    matched = files.find(f => f === jobId || f.startsWith(`${jobId}.`));
    if (matched) {
      const fullPath = path.join(TEMP_DIR, matched);
      return { filePath: fullPath, filename: matched, job };
    }
  } catch (e) {}

  return null;
}

loadJobsHistory();

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
  const maxJobs = getMaxConcurrentDownloads();
  if (active >= maxJobs) return;

  for (const job of jobs.values()) {
    if (job.status === 'queued') {
      if (job.opts && (job.opts.magnet || job.opts.torrentUrl || job.opts.type === 'torrent')) {
        startTorrentJob(job);
      } else {
        startJobProcess(job);
      }
      if (getActiveDownloadCount() >= maxJobs) break;
    }
  }
}

// Health & Engine Status Endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeDownloads: getActiveDownloadCount(),
    maxConcurrent: getMaxConcurrentDownloads(),
    totalJobs: jobs.size,
    platform: process.platform,
    engines: {
      spotiflacNext: true,
      soulseekP2P: true,
      tidalMonochrome: true,
      deezerHiFi: true,
      tiktokHD: true,
      instagramHD: true,
      universalYtdlp: true,
      adultJavHub: true,
      movieHub: true,
      olaMovies: true,
      ytsMovies: false, // disabled for testing
      pirateBayTorrents: false, // disabled for testing
      aria2cBitTorrent: true
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
      const child = (filePath && fs.existsSync(filePath))
        ? spawn('explorer.exe', [`/select,${path.normalize(filePath)}`], { detached: true, stdio: 'ignore' })
        : spawn('explorer.exe', [path.normalize(target)], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => console.warn('[Server] Explorer error:', err.message));
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [target], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => console.warn('[Server] Open error:', err.message));
    } else {
      if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
        const child = spawn('xdg-open', [target], { detached: true, stdio: 'ignore' });
        child.on('error', (err) => console.warn('[Server] xdg-open error:', err.message));
      } else {
        return res.json({ success: false, message: 'Headless server: cannot open GUI folder' });
      }
    }
    res.json({ success: true, opened: target });
  } catch (err) {
    res.status(500).json({ error: `Cannot open folder: ${err.message}` });
  }
});

// ==========================================================================
// Sakura Admin Authentication, UI/UX Studio & Diagnostics Endpoints
// ==========================================================================
const SESSIONS_FILE = path.join(__dirname, '.admin_sessions.json');
const adminSessions = new Map(); // token -> { user, createdAt }

function loadAdminSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const now = Date.now();
      for (const [token, sess] of Object.entries(parsed)) {
        if (now - (sess.createdAt || 0) < 14 * 24 * 60 * 60 * 1000) {
          adminSessions.set(token, sess);
        }
      }
    }
  } catch (e) {}
}

function saveAdminSessions() {
  try {
    const obj = {};
    for (const [token, sess] of adminSessions.entries()) {
      obj[token] = sess;
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj), 'utf8');
  } catch (e) {}
}

loadAdminSessions();

let globalUiSettings = {
  theme: 'sakura',
  density: 'standard',
  updatedAt: Date.now()
};

function generateAdminToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, { user, createdAt: Date.now() });
  saveAdminSessions();
  return token;
}

function verifyAdminToken(req) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.headers['x-admin-token']) {
    token = req.headers['x-admin-token'];
  } else if (req.query && req.query.admin_token) {
    token = req.query.admin_token;
  }

  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > 14 * 24 * 60 * 60 * 1000) {
    adminSessions.delete(token);
    saveAdminSessions();
    return null;
  }
  return session;
}

function requireAdmin(req, res, next) {
  const session = verifyAdminToken(req);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized: Admin authentication required' });
  }
  req.admin = session;
  next();
}

// 1. Admin Login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const expectedUser = process.env.ADMIN_USER || 'sakura';
  const expectedPass = process.env.ADMIN_PASS || 'sakura';

  if (username === expectedUser && password === expectedPass) {
    const token = generateAdminToken(username);
    res.json({ success: true, token, user: username });
  } else {
    res.status(401).json({ error: 'Invalid admin credentials' });
  }
});

// 2. Admin Logout
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '').trim() || req.headers['x-admin-token'];
  if (token) {
    adminSessions.delete(token);
    saveAdminSessions();
  }
  res.json({ success: true });
});

// 3. Verify Admin Session
app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ success: true, user: req.admin.user });
});

// Helper: FLAC storage directories on server
function getFlacStorageDirs() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  return [
    TEMP_DIR,
    path.join(__dirname, 'temp_media'),
    path.join(homeDir, 'slskd_downloads'),
    path.join(homeDir, 'OrpheusDL', 'downloads'),
    path.join(homeDir, 'Downloads', 'JAV-Downloader'),
    path.join(homeDir, 'Downloads'),
    path.join(homeDir, 'music'),
    path.join(process.env.USERPROFILE || 'C:\\Users\\sayan', 'Downloads', 'JAV-Downloader')
  ].filter(Boolean);
}

function scanFlacFiles() {
  const dirs = getFlacStorageDirs();
  const results = [];
  const seen = new Set();

  function scanDir(dir, maxDepth = 2, currentDepth = 0) {
    if (!dir || !fs.existsSync(dir) || currentDepth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.flac')) {
          if (!seen.has(fullPath)) {
            seen.add(fullPath);
            try {
              const stat = fs.statSync(fullPath);
              results.push({
                filename: entry.name,
                filePath: fullPath,
                sizeBytes: stat.size,
                sizeMB: (stat.size / (1024 * 1024)).toFixed(2),
                mtime: stat.mtimeMs
              });
            } catch (e) {}
          }
        } else if (entry.isDirectory() && entry.name !== 'incomplete' && !entry.name.startsWith('.') && currentDepth < maxDepth) {
          scanDir(fullPath, maxDepth, currentDepth + 1);
        }
      }
    } catch (e) {}
  }

  for (const dir of dirs) {
    scanDir(dir, 2, 0);
  }

  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

function purgeFlacFiles() {
  const activePaths = new Set();
  for (const j of jobs.values()) {
    if (j.status === 'downloading' && j.filePath) {
      activePaths.add(j.filePath);
    }
  }

  const allFlacs = scanFlacFiles();
  let deletedCount = 0;
  let freedBytes = 0;

  for (const f of allFlacs) {
    if (!activePaths.has(f.filePath)) {
      let deleted = false;
      try {
        fs.unlinkSync(f.filePath);
        deleted = true;
      } catch (err) {
        if (process.platform !== 'win32') {
          try {
            execSync(`rm -f "${f.filePath}"`, { stdio: 'ignore' });
            deleted = true;
          } catch (e) {
            try {
              execSync(`echo 'sakura' | sudo -S -p '' rm -f "${f.filePath}"`, { stdio: 'ignore' });
              deleted = true;
            } catch (e2) {}
          }
        }
      }

      if (deleted) {
        deletedCount++;
        freedBytes += f.sizeBytes;
        try {
          const parent = path.dirname(f.filePath);
          if (fs.readdirSync(parent).length === 0) {
            try {
              fs.rmdirSync(parent);
            } catch (e) {
              if (process.platform !== 'win32') {
                execSync(`echo 'sakura' | sudo -S -p '' rmdir "${parent}"`, { stdio: 'ignore' });
              }
            }
          }
        } catch (e) {}
      }
    }
  }

  // Ensure slskd_downloads directory permissions remain owned by sakura
  if (process.platform !== 'win32') {
    try {
      const homeDir = process.env.HOME || '/home/sakura';
      const slskdDir = path.join(homeDir, 'slskd_downloads');
      if (fs.existsSync(slskdDir)) {
        execSync(`echo 'sakura' | sudo -S -p '' chown -R sakura:sakura "${slskdDir}" && echo 'sakura' | sudo -S -p '' chmod -R 777 "${slskdDir}"`, { stdio: 'ignore', timeout: 5000 });
      }
    } catch (e) {}
  }

  return {
    deletedCount,
    freedBytes,
    freedMB: (freedBytes / (1024 * 1024)).toFixed(2)
  };
}

// 4. System Diagnostics & Host Stats
app.get('/api/admin/system-stats', requireAdmin, (req, res) => {
  try {
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const cpus = os.cpus();
    const loadavg = os.loadavg();
    const uptime = os.uptime();

    let tempSizeBytes = 0;
    let tempFileCount = 0;
    let orphanedPartials = 0;

    try {
      if (fs.existsSync(TEMP_DIR)) {
        const files = fs.readdirSync(TEMP_DIR);
        tempFileCount = files.length;
        for (const f of files) {
          try {
            const stat = fs.statSync(path.join(TEMP_DIR, f));
            tempSizeBytes += stat.size;
            if (f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.temp')) {
              orphanedPartials++;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    let flacCacheBytes = 0;
    let flacCacheFiles = 0;
    try {
      const flacs = scanFlacFiles();
      flacCacheFiles = flacs.length;
      for (const f of flacs) {
        flacCacheBytes += f.sizeBytes;
      }
    } catch (e) {}

    let ytdlpVersion = 'Unknown';
    try {
      const ytdlpBin = getYtDlpPath();
      ytdlpVersion = execSync(`"${ytdlpBin}" --version`, { timeout: 4000 }).toString().trim();
    } catch (e) {}

    let ffmpegVersion = 'Unknown';
    try {
      ffmpegVersion = execSync('ffmpeg -version', { timeout: 4000 }).toString().split('\n')[0].trim();
    } catch (e) {}

    let slskdRunning = false;
    try {
      const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';
      execSync(`"${curlBin}" -s -m 1 http://127.0.0.1:5030/api/v0/application`, { stdio: 'ignore' });
      slskdRunning = true;
    } catch (e) {
      slskdRunning = !!slskdProcess;
    }

    res.json({
      memory: mem,
      system: {
        total: totalMem,
        free: freeMem,
        cpus: cpus.length,
        loadavg,
        uptime
      },
      storage: {
        tempSizeBytes,
        tempFileCount,
        orphanedPartials,
        flacCache: {
          fileCount: flacCacheFiles,
          sizeBytes: flacCacheBytes,
          sizeMB: (flacCacheBytes / (1024 * 1024)).toFixed(1)
        }
      },
      tools: {
        ytdlpVersion,
        ffmpegVersion,
        slskd: {
          running: slskdRunning,
          port: 5030
        }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4.1 Verify FFmpeg Installed Codecs
app.post('/api/admin/verify-codecs', requireAdmin, (req, res) => {
  try {
    let encodersOut = '';
    let decodersOut = '';
    try {
      encodersOut = execSync('ffmpeg -encoders', { timeout: 5000 }).toString();
      decodersOut = execSync('ffmpeg -decoders', { timeout: 5000 }).toString();
    } catch (e) {}

    const hasH264 = encodersOut.includes('libx264');
    const hasH265 = encodersOut.includes('libx265');
    const hasAac = encodersOut.includes('aac');
    const hasFlac = encodersOut.includes('flac');
    const hasOpus = encodersOut.includes('libopus') || encodersOut.includes('opus');
    const hasVp9 = encodersOut.includes('libvpx-vp9');
    const hasAv1 = encodersOut.includes('libsvtav1') || encodersOut.includes('libaom-av1');

    res.json({
      success: true,
      codecs: {
        h264: hasH264,
        h265_hevc: hasH265,
        flac_lossless: hasFlac,
        aac: hasAac,
        opus: hasOpus,
        vp9: hasVp9,
        av1: hasAv1
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Clean Orphaned Temp Files
app.post('/api/admin/clean-temp', requireAdmin, (req, res) => {
  try {
    let deletedFiles = 0;
    let freedBytes = 0;

    const activeFiles = new Set();
    for (const j of jobs.values()) {
      if (j.status === 'downloading' && j.filename) {
        activeFiles.add(j.filename);
      }
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const tempDirs = [
      TEMP_DIR,
      path.join(homeDir, 'slskd_downloads', 'incomplete')
    ];

    for (const targetDir of tempDirs) {
      if (fs.existsSync(targetDir)) {
        try {
          const files = fs.readdirSync(targetDir);
          for (const f of files) {
            if (f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.temp') || targetDir.includes('incomplete')) {
              let isCurrent = false;
              for (const act of activeFiles) {
                if (f.includes(act)) isCurrent = true;
              }
              if (!isCurrent) {
                const full = path.join(targetDir, f);
                try {
                  const sz = fs.statSync(full).size;
                  fs.unlinkSync(full);
                  deletedFiles++;
                  freedBytes += sz;
                } catch (e) {
                  if (process.platform !== 'win32') {
                    try {
                      execSync(`echo 'sakura' | sudo -S -p '' rm -rf "${full}"`, { stdio: 'ignore' });
                      deletedFiles++;
                    } catch (e2) {}
                  }
                }
              }
            }
          }
        } catch (e) {}
      }
    }

    res.json({ success: true, deletedFiles, freedBytes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5.1 Purge Audiophile FLAC Library Cache
app.post('/api/admin/purge-flac-cache', requireAdmin, (req, res) => {
  try {
    const stats = purgeFlacFiles();
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Update yt-dlp Core
app.post('/api/admin/update-ytdlp', requireAdmin, (req, res) => {
  try {
    const ytdlpBin = getYtDlpPath();
    let output = '';
    try {
      output = execSync(`"${ytdlpBin}" -U`, { timeout: 30000 }).toString();
    } catch (err) {
      output = err.stdout ? err.stdout.toString() : (err.message || 'Update executed');
    }
    res.json({ success: true, output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 7. Get Creds Status
app.get('/api/admin/creds', requireAdmin, (req, res) => {
  const arl = process.env.DEEZER_ARL || '';
  res.json({
    deezerArl: arl ? (arl.slice(0, 8) + '...' + arl.slice(-6)) : '',
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
    spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET ? '••••••••••••••••' : '',
    adminUser: process.env.ADMIN_USER || 'sakura'
  });
});

// 8. Update Creds & Persist to .env
app.post('/api/admin/creds', requireAdmin, (req, res) => {
  try {
    const { deezerArl, spotifyClientId, spotifyClientSecret, adminUser, adminPass } = req.body || {};

    if (deezerArl && !deezerArl.includes('...') && !deezerArl.includes('•')) {
      process.env.DEEZER_ARL = deezerArl.trim();
    }
    if (spotifyClientId) {
      process.env.SPOTIFY_CLIENT_ID = spotifyClientId.trim();
    }
    if (spotifyClientSecret && !spotifyClientSecret.includes('••')) {
      process.env.SPOTIFY_CLIENT_SECRET = spotifyClientSecret.trim();
    }
    if (adminUser) {
      process.env.ADMIN_USER = adminUser.trim();
    }
    if (adminPass) {
      process.env.ADMIN_PASS = adminPass.trim();
    }

    try {
      let envContent = '';
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
      }
      const envMap = new Map();
      const lines = envContent.split(/\r?\n/);
      for (const line of lines) {
        const t = line.trim();
        if (t && !t.startsWith('#') && t.includes('=')) {
          const [k, ...v] = t.split('=');
          envMap.set(k.trim(), v.join('=').trim());
        }
      }

      if (process.env.DEEZER_ARL) envMap.set('DEEZER_ARL', process.env.DEEZER_ARL);
      if (process.env.SPOTIFY_CLIENT_ID) envMap.set('SPOTIFY_CLIENT_ID', process.env.SPOTIFY_CLIENT_ID);
      if (process.env.SPOTIFY_CLIENT_SECRET) envMap.set('SPOTIFY_CLIENT_SECRET', process.env.SPOTIFY_CLIENT_SECRET);
      if (process.env.ADMIN_USER) envMap.set('ADMIN_USER', process.env.ADMIN_USER);
      if (process.env.ADMIN_PASS) envMap.set('ADMIN_PASS', process.env.ADMIN_PASS);
      if (process.env.PORT) envMap.set('PORT', process.env.PORT);

      let newContent = '';
      for (const [k, v] of envMap.entries()) {
        newContent += `${k}=${v}\n`;
      }
      fs.writeFileSync(envPath, newContent, 'utf8');
    } catch (e) {}

    res.json({ success: true, message: 'Credentials safely updated in server environment' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Test Deezer HiFi ARL Token
app.post('/api/admin/test-deezer', requireAdmin, (req, res) => {
  let { arl } = req.body || {};
  if (!arl || arl.includes('...') || arl.includes('•')) {
    arl = process.env.DEEZER_ARL || '';
  }
  if (!arl) {
    return res.status(400).json({ valid: false, error: 'No Deezer ARL token provided or configured in server environment' });
  }

  const https = require('https');
  const url = 'https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=';
  const options = {
    headers: {
      'Cookie': `arl=${arl.trim()}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    timeout: 8000
  };

  const request = https.get(url, options, (response) => {
    let body = '';
    response.on('data', (chunk) => body += chunk);
    response.on('end', () => {
      try {
        const data = JSON.parse(body);
        const user = data?.results?.USER || {};
        const userId = user.USER_ID;
        const soundQuality = user?.OPTIONS?.mobile_sound_quality || {};
        const hasLossless = !!(soundQuality.lossless || soundQuality.high);
        if (userId && userId !== 0 && userId !== '0') {
          // If a new valid raw token was provided, persist to .env
          if (!arl.includes('...') && !arl.includes('•') && arl.length >= 64) {
            process.env.DEEZER_ARL = arl.trim();
            try {
              let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
              if (envContent.includes('DEEZER_ARL=')) {
                envContent = envContent.replace(/DEEZER_ARL=.*/g, `DEEZER_ARL=${arl.trim()}`);
              } else {
                envContent += `\nDEEZER_ARL=${arl.trim()}\n`;
              }
              fs.writeFileSync(envPath, envContent, 'utf8');
            } catch (e) {}
          }

          res.json({
            valid: true,
            user: user.BLOG_NAME || `Deezer User (${userId})`,
            country: data?.results?.COUNTRY || 'Global',
            canStreamLossless: hasLossless
          });
        } else {
          res.json({
            valid: false,
            error: (data?.error && Array.isArray(data.error) && data.error.length)
              ? data.error.join(', ')
              : (data?.error && typeof data.error === 'object' ? JSON.stringify(data.error) : 'Invalid or expired Deezer ARL token')
          });
        }
      } catch (e) {
        res.json({ valid: false, error: 'Failed to parse Deezer response: ' + e.message });
      }
    });
  });

  request.on('error', (err) => {
    res.status(500).json({ valid: false, error: 'Deezer connection error: ' + err.message });
  });

  request.on('timeout', () => {
    request.destroy();
    res.status(504).json({ valid: false, error: 'Deezer API request timed out' });
  });
});

// 10. UI/UX Global Settings
app.get('/api/admin/ui-settings', requireAdmin, (req, res) => {
  res.json(globalUiSettings);
});

app.post('/api/admin/ui-settings', requireAdmin, (req, res) => {
  const { theme, density } = req.body || {};
  if (theme) globalUiSettings.theme = theme;
  if (density) globalUiSettings.density = density;
  globalUiSettings.updatedAt = Date.now();
  res.json({ success: true, settings: globalUiSettings });
});

// Public UI Settings (Non-admin client sync)
app.get('/api/ui-settings', (req, res) => {
  res.json({ theme: globalUiSettings.theme, density: globalUiSettings.density });
});

// ==========================================================================
// EXPANDED SAKURA ADMIN CONTROL CENTER & MAINTAINER SUITE
// ==========================================================================

// 11. Service Control & Status
app.get('/api/admin/service/status', requireAdmin, (req, res) => {
  try {
    let systemdOut = 'Systemd not available on this platform';
    let isActive = true;
    if (process.platform === 'linux') {
      try {
        systemdOut = execSync('systemctl status jav-downloader.service --no-pager', { timeout: 4000 }).toString();
        isActive = systemdOut.includes('Active: active (running)');
      } catch (e) {
        systemdOut = e.stdout ? e.stdout.toString() : (e.message || 'Service check error');
        isActive = systemdOut.includes('Active: active (running)');
      }
    }
    res.json({
      success: true,
      active: isActive,
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      systemUptime: Math.floor(os.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      rawStatus: systemdOut
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restart Service
app.post('/api/admin/service/restart', requireAdmin, (req, res) => {
  try {
    if (process.platform !== 'linux') {
      return res.json({ success: true, message: 'Restart triggered (simulated in local non-linux mode)' });
    }
    res.json({ success: true, message: 'Restart command dispatched to systemd. Service reloading now...' });
    
    setTimeout(() => {
      try {
        exec("echo 'sakura' | sudo -S -p '' systemctl restart jav-downloader.service");
      } catch (e) {}
    }, 500);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live Service Journal Logs
app.get('/api/admin/service/logs', requireAdmin, (req, res) => {
  try {
    const lines = Math.min(parseInt(req.query.lines, 10) || 150, 500);
    let logs = '';
    if (process.platform === 'linux') {
      try {
        logs = execSync(`journalctl -u jav-downloader.service -n ${lines} --no-pager`, { timeout: 6000 }).toString();
      } catch (e) {
        logs = e.stdout ? e.stdout.toString() : `Failed to read journalctl: ${e.message}`;
      }
    } else {
      logs = `[Local Development Logs]\nHost Platform: ${process.platform} (${process.arch})\nNode PID: ${process.pid}\nNode Uptime: ${Math.floor(process.uptime())}s\nIn-memory Jobs: ${jobs.size}\nTemp Directory: ${TEMP_DIR}`;
    }
    res.json({ success: true, lines, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12. Dynamic Engine Configuration
app.get('/api/admin/engine-config', requireAdmin, (req, res) => {
  res.json({ success: true, config: engineConfig });
});

app.post('/api/admin/engine-config', requireAdmin, (req, res) => {
  try {
    const updates = req.body || {};
    if (typeof updates.maxConcurrentJobs === 'number') {
      engineConfig.maxConcurrentJobs = Math.max(1, Math.min(10, updates.maxConcurrentJobs));
    }
    if (typeof updates.aria2cFragments === 'number') {
      engineConfig.aria2cFragments = Math.max(1, Math.min(32, updates.aria2cFragments));
    }
    if (typeof updates.aria2cMinSplitSize === 'string') {
      engineConfig.aria2cMinSplitSize = updates.aria2cMinSplitSize.trim();
    }
    if (typeof updates.bufferSize === 'string') {
      engineConfig.bufferSize = updates.bufferSize.trim();
    }
    if (typeof updates.httpChunkSize === 'string') {
      engineConfig.httpChunkSize = updates.httpChunkSize.trim();
    }
    if (typeof updates.retries === 'number') {
      engineConfig.retries = Math.max(1, Math.min(30, updates.retries));
    }
    if (updates.features && typeof updates.features === 'object') {
      engineConfig.features = {
        ...engineConfig.features,
        ...updates.features
      };
    }
    saveEngineConfig();
    res.json({ success: true, config: engineConfig, message: 'Engine configuration updated and saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 13. Storage Explorer & File Manager
app.get('/api/admin/storage/files', requireAdmin, (req, res) => {
  try {
    let diskStats = { total: '0 GB', used: '0 GB', free: '0 GB', percentUsed: 0 };
    if (process.platform === 'linux') {
      try {
        const df = execSync('df -BG /', { timeout: 3000 }).toString().trim().split('\n');
        if (df.length >= 2) {
          const parts = df[1].split(/\s+/);
          const totalG = parseInt(parts[1], 10) || 0;
          const usedG = parseInt(parts[2], 10) || 0;
          const freeG = parseInt(parts[3], 10) || 0;
          const pct = parseInt(parts[4], 10) || 0;
          diskStats = { total: `${totalG} GB`, used: `${usedG} GB`, free: `${freeG} GB`, percentUsed: pct };
        }
      } catch (e) {}
    } else {
      const freeG = (os.freemem() / (1024 ** 3)).toFixed(1);
      const totalG = (os.totalmem() / (1024 ** 3)).toFixed(1);
      diskStats = { total: `${totalG} GB`, used: `${(totalG - freeG).toFixed(1)} GB`, free: `${freeG} GB`, percentUsed: Math.round(((totalG - freeG) / totalG) * 100) };
    }

    const fileList = [];
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const targetDirs = [
      { path: TEMP_DIR, category: 'Temp Media' },
      { path: path.join(homeDir, 'slskd_downloads'), category: 'Soulseek Downloads' }
    ];

    function scanStorageDir(dirPath, category, maxDepth = 3, currentDepth = 0) {
      if (!dirPath || !fs.existsSync(dirPath) || currentDepth > maxDepth) return;
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const ent of entries) {
          const full = path.join(dirPath, ent.name);
          if (ent.isFile() && !ent.name.startsWith('.')) {
            try {
              const st = fs.statSync(full);
              const ext = path.extname(ent.name).toLowerCase();
              const isVideo = ['.mp4', '.mkv', '.webm', '.avi', '.ts'].includes(ext);
              const isAudio = ['.flac', '.mp3', '.m4a', '.wav', '.opus', '.ogg', '.aac'].includes(ext);
              const isFragment = ['.part', '.ytdl', '.temp', '.aria2'].includes(ext);
              
              const sizeFormatted = st.size > (1024 ** 3)
                ? `${(st.size / (1024 ** 3)).toFixed(2)} GB`
                : `${(st.size / (1024 ** 2)).toFixed(1)} MB`;

              fileList.push({
                name: ent.name,
                fullPath: full,
                category,
                sizeBytes: st.size,
                sizeFormatted,
                mtime: st.mtimeMs,
                mtimeFormatted: new Date(st.mtimeMs).toLocaleString(),
                ext,
                isVideo,
                isAudio,
                isFragment,
                downloadUrl: isFragment ? null : `/api/admin/storage/raw-download?file=${encodeURIComponent(full)}`
              });
            } catch (e) {}
          } else if (ent.isDirectory() && !ent.name.startsWith('.') && currentDepth < maxDepth) {
            scanStorageDir(full, category, maxDepth, currentDepth + 1);
          }
        }
      } catch (e) {}
    }

    for (const td of targetDirs) {
      scanStorageDir(td.path, td.category, 3, 0);
    }

    fileList.sort((a, b) => b.mtime - a.mtime);
    res.json({ success: true, disk: diskStats, files: fileList.slice(0, 150) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Raw file download for admin
app.get('/api/admin/storage/raw-download', requireAdmin, (req, res) => {
  const filePath = req.query.file;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }
  const resolved = path.resolve(filePath);
  const home = path.resolve(process.env.HOME || process.env.USERPROFILE || '');
  const temp = path.resolve(TEMP_DIR);
  if (!resolved.startsWith(temp) && !resolved.startsWith(home)) {
    return res.status(403).send('Forbidden: Access outside download directories');
  }
  res.download(resolved);
});

// Delete specific file
app.post('/api/admin/storage/delete', requireAdmin, (req, res) => {
  try {
    const { filePath } = req.body || {};
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    const resolved = path.resolve(filePath);
    const home = path.resolve(process.env.HOME || process.env.USERPROFILE || '');
    const temp = path.resolve(TEMP_DIR);
    if (!resolved.startsWith(temp) && !resolved.startsWith(home)) {
      return res.status(403).json({ error: 'Cannot delete files outside allowed storage' });
    }
    try {
      fs.unlinkSync(resolved);
    } catch (err) {
      if (process.platform !== 'win32') {
        try {
          execSync(`echo 'sakura' | sudo -S -p '' rm -f "${resolved}"`, { stdio: 'ignore' });
        } catch (e2) {
          throw err;
        }
      } else {
        throw err;
      }
    }
    res.json({ success: true, message: `Deleted ${path.basename(resolved)}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Purge Incomplete Fragments
app.post('/api/admin/storage/purge-incomplete', requireAdmin, (req, res) => {
  try {
    let deletedCount = 0;
    let freedBytes = 0;
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const purgeDirs = [
      TEMP_DIR,
      path.join(homeDir, 'slskd_downloads', 'incomplete')
    ];

    function cleanIncomplete(dirPath) {
      if (!fs.existsSync(dirPath)) return;
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const ent of entries) {
          const full = path.join(dirPath, ent.name);
          if (ent.isFile()) {
            if (ent.name.endsWith('.part') || ent.name.endsWith('.ytdl') || ent.name.endsWith('.temp') || ent.name.endsWith('.aria2') || dirPath.includes('incomplete')) {
              try {
                freedBytes += fs.statSync(full).size;
                fs.unlinkSync(full);
                deletedCount++;
              } catch (e) {
                if (process.platform !== 'win32') {
                  try {
                    execSync(`echo 'sakura' | sudo -S -p '' rm -f "${full}"`, { stdio: 'ignore' });
                    deletedCount++;
                  } catch (e2) {}
                }
              }
            }
          } else if (ent.isDirectory()) {
            cleanIncomplete(full);
            try {
              if (fs.readdirSync(full).length === 0) {
                fs.rmdirSync(full);
              }
            } catch (e) {
              if (process.platform !== 'win32') {
                try {
                  execSync(`echo 'sakura' | sudo -S -p '' rmdir "${full}"`, { stdio: 'ignore' });
                } catch (e2) {}
              }
            }
          }
        }
      } catch (e) {}
    }

    for (const d of purgeDirs) {
      cleanIncomplete(d);
    }

    res.json({
      success: true,
      deletedCount,
      freedBytes,
      freedMB: (freedBytes / (1024 * 1024)).toFixed(2)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 14. Network & API Health Bench
app.get('/api/admin/health-bench', requireAdmin, async (req, res) => {
  const targets = [
    { name: 'Tidal Monochrome API', url: 'https://api.tidal.com/v1/ping', expect: [200, 401, 403] },
    { name: 'Deezer Core API', url: 'https://api.deezer.com', expect: [200] },
    { name: 'Local Soulseek Daemon', url: 'http://127.0.0.1:5030/api/v0/application', expect: [200, 401] },
    { name: 'OlaMovies Domain', url: cachedOlaDomain || 'https://v5.olamovies.mov', expect: [200, 301, 302, 403] },
    { name: 'YTS Movie API', url: 'https://yts.mx/api/v2/list_movies.json?limit=1', expect: [200] },
    { name: 'YouTube / Google Core', url: 'https://www.youtube.com', expect: [200, 302] },
    { name: 'GitHub Upstream API', url: 'https://api.github.com/zen', expect: [200] }
  ];

  const results = await Promise.all(targets.map(async (t) => {
    const start = Date.now();
    try {
      const resp = await fetch(t.url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*'
        },
        signal: AbortSignal.timeout(5000)
      });
      const latencyMs = Date.now() - start;
      const isExpected = (t.expect || [200]).includes(resp.status);
      return {
        name: t.name,
        url: t.url,
        status: resp.status,
        statusText: resp.statusText || String(resp.status),
        latencyMs,
        ok: isExpected,
        tier: latencyMs < 300 ? 'optimal' : (latencyMs < 800 ? 'fair' : 'slow')
      };
    } catch (e) {
      return {
        name: t.name,
        url: t.url,
        status: 0,
        statusText: e.message || 'Connection Error',
        latencyMs: Date.now() - start,
        ok: false,
        tier: 'error'
      };
    }
  }));

  res.json({ success: true, timestamp: Date.now(), results });
});

// 15. Maintainer Terminal Command Runner
app.post('/api/admin/terminal/exec', requireAdmin, (req, res) => {
  const { command } = req.body || {};
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'Command string is required' });
  }

  const trimmed = command.trim();
  if (trimmed.includes('rm -rf /') || trimmed.includes('mkfs') || trimmed.includes(':(){ :|:& };:')) {
    return res.status(400).json({ error: 'Forbidden dangerous command pattern' });
  }

  try {
    const cwd = __dirname;
    const out = execSync(trimmed, {
      cwd,
      timeout: 25000,
      maxBuffer: 1024 * 1024 * 2,
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
    });
    res.json({ success: true, exitCode: 0, output: out.toString() });
  } catch (err) {
    const stdout = err.stdout ? err.stdout.toString() : '';
    const stderr = err.stderr ? err.stderr.toString() : (err.message || 'Execution error');
    res.json({
      success: false,
      exitCode: err.status || 1,
      output: (stdout ? stdout + '\n' : '') + stderr
    });
  }
});

// ==========================================
// Inbuilt FLAC Checker & Lossless Endpoints
// ==========================================

// List recent FLAC files for quick inspection
app.get('/api/flac-check/recent', (req, res) => {
  try {
    const results = scanFlacFiles();
    res.json(results.slice(0, 35));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Purge / Clear Recent Downloaded FLAC files from server storage
app.post('/api/flac-check/clear-recent', (req, res) => {
  try {
    const stats = purgeFlacFiles();
    res.json({ success: true, ...stats });
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

// ==========================================================================
// Adult Search & JAV Engine (Tubes via XVideos & Studio Masters via Sukebei)
// ==========================================================================

function extractJavCode(title) {
  if (!title) return null;
  const match = title.match(/\b([A-Za-z]{2,6})[-_ ]?(\d{2,5})\b/);
  if (match) {
    const letters = match[1].toUpperCase();
    const numbers = match[2];
    return `${letters}-${numbers}`;
  }
  return null;
}

function getDmmCoverUrl(code) {
  if (!code) return '';
  const parts = code.toLowerCase().split('-');
  if (parts.length !== 2) return '';
  const letters = parts[0];
  const num = parts[1];
  const padded = num.padStart(5, '0');
  return `https://pics.dmm.co.jp/mono/movie/adult/${letters}${padded}/${letters}${padded}pl.jpg`;
}

async function searchXVideos(query, page = 1, duration = 'full') {
  let durParam = '';
  if (duration === 'full') durParam = '&durf=10min_more';
  else if (duration === 'extended') durParam = '&durf=20min_more';

  const url = `https://www.xvideos.com/?k=${encodeURIComponent(query)}&p=${page}${durParam}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  if (!res.ok) return [];
  const html = await res.text();
  const results = [];
  const parts = html.split(/class="[^"]*thumb-block/);

  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const urlMatch = chunk.match(/href="(\/video\.[^"]+)"/);
    if (!urlMatch) continue;
    const href = urlMatch[1];
    const fullUrl = `https://www.xvideos.com${href}`;

    const titleMatch = chunk.match(/<p class="title">\s*<a[^>]*title="([^"]+)"/i) ||
                       chunk.match(/<p class="title">\s*<a[^>]*>([^<]+)<\/a>/i);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled Video';

    // When searching for full videos, filter out short studio teaser/trailer uploads
    const isTeaser = /\b(preview|trailer|teaser)\b/i.test(title);
    if (duration !== 'all' && isTeaser) {
      continue;
    }

    const thumbMatch = chunk.match(/data-src="([^"]+)"/i) || chunk.match(/src="([^"]+)"/i);
    const thumb = thumbMatch ? thumbMatch[1] : '';

    const previewMatch = chunk.match(/data-pvv="([^"]+)"/i);
    const previewVideo = previewMatch ? previewMatch[1] : '';

    const durMatch = chunk.match(/<span class="duration">([^<]+)<\/span>/i);
    const durStr = durMatch ? durMatch[1].trim() : '';

    const qMatch = chunk.match(/<span class="video-(?:hd|sd)-mark">([^<]+)<\/span>/i);
    const quality = qMatch ? qMatch[1].trim() : 'HD';

    results.push({
      id: href,
      title,
      url: fullUrl,
      thumb,
      previewVideo,
      duration: durStr,
      quality,
      provider: 'xvideos',
      type: 'tube',
      isTeaser
    });
  }
  return results;
}

async function searchPornhub(query, page = 1) {
  try {
    const url = `https://www.pornhub.com/video/search?search=${encodeURIComponent(query)}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return [];
    const html = await res.text();
    const results = [];
    const regex = /<li[^>]*data-video-vkey="([^"]+)"[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = regex.exec(html)) !== null && results.length < 25) {
      const vkey = m[1];
      const block = m[2];
      const titleMatch = block.match(/title="([^"]+)"/i);
      const durMatch = block.match(/<var class="duration">([^<]+)<\/var>/i);
      const imgMatch = block.match(/src="([^"]+)"/i) || block.match(/data-src="([^"]+)"/i);
      const hdMatch = block.match(/<span class="hd-thumbnail">([^<]+)<\/span>/i);
      const previewMatch = block.match(/data-mediabook="([^"]+)"/i);

      const title = titleMatch ? titleMatch[1].trim() : 'Pornhub Video';
      const isTeaser = /\b(preview|trailer|teaser)\b/i.test(title);

      results.push({
        id: vkey,
        title,
        url: `https://www.pornhub.com/view_video.php?viewkey=${vkey}`,
        thumb: imgMatch ? imgMatch[1] : '',
        previewVideo: previewMatch ? previewMatch[1] : '',
        duration: durMatch ? durMatch[1].trim() : '',
        quality: hdMatch ? 'HD' : '1080p',
        provider: 'pornhub',
        type: 'tube',
        isTeaser
      });
    }
    return results;
  } catch (e) {
    console.warn('[AdultSearch] Pornhub search failed:', e.message);
    return [];
  }
}

async function searchSukebeiJAV(query, page = 1) {
  const url = `https://sukebei.nyaa.si/?f=0&c=2_2&q=${encodeURIComponent(query)}&p=${page}&page=rss`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return [];
  const xml = await res.text();
  const items = [];
  const itemRegex = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<guid[^>]*>([\s\S]*?)<\/guid>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>[\s\S]*?<nyaa:seeders>(\d+)<\/nyaa:seeders>[\s\S]*?<nyaa:leechers>(\d+)<\/nyaa:leechers>[\s\S]*?<nyaa:infoHash>([a-fA-F0-9]+)<\/nyaa:infoHash>[\s\S]*?<nyaa:size>([\s\S]*?)<\/nyaa:size>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < 30) {
    const rawTitle = match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const javCode = extractJavCode(rawTitle);
    const coverUrl = javCode ? getDmmCoverUrl(javCode) : '';
    const infoHash = match[7].trim();
    const torrentUrl = match[2].trim();
    items.push({
      id: infoHash,
      title: rawTitle,
      code: javCode || '',
      thumb: coverUrl,
      size: match[8].trim(),
      seeders: parseInt(match[5], 10),
      leechers: parseInt(match[6], 10),
      torrentUrl,
      magnet: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(rawTitle)}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`,
      provider: 'sukebei',
      type: 'jav',
      isFullMovie: true
    });
  }
  return items;
}

// Lightweight Image Proxy to bypass hotlink protection & CORS on movie/adult posters
app.get('/api/proxy-image', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || !targetUrl.startsWith('http')) {
    return res.status(400).send('Invalid image URL');
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send('Failed to fetch upstream image');
    }

    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');

    const buffer = await upstream.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(502).send('Error proxying image');
  }
});

// ==========================================================================
// MOVIE & TV SHOW HUB ENGINE (OlaMovies + BitTorrent Dual Pipeline)
// ==========================================================================

let cachedOlaDomain = 'https://v5.olamovies.mov';
let lastOlaDomainCheck = 0;

async function getOlaMoviesDomain() {
  const now = Date.now();
  if (now - lastOlaDomainCheck < 1800000 && cachedOlaDomain) {
    return cachedOlaDomain;
  }
  try {
    const res = await fetch('https://olamovies.dad/current.php?redirect=1', {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(4000)
    });
    const loc = res.headers.get('location');
    if (loc) {
      cachedOlaDomain = loc.replace(/\/+$/, '');
      lastOlaDomainCheck = now;
      return cachedOlaDomain;
    }
  } catch (e) {}
  lastOlaDomainCheck = now;
  return cachedOlaDomain || 'https://v5.olamovies.mov';
}

async function searchOlaMovies(query, page = 1) {
  try {
    const domain = await getOlaMoviesDomain();
    const url = `${domain}/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&_embed=1&per_page=12&page=${page}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: AbortSignal.timeout(9000)
    });
    if (!res.ok) return [];
    const posts = await res.json();
    if (!Array.isArray(posts)) return [];

    const items = [];
    for (const post of posts) {
      const rawTitle = (post.title && post.title.rendered)
        ? post.title.rendered.replace(/&#8211;/g, '-').replace(/&amp;/g, '&').replace(/&#8217;/g, "'").replace(/&quot;/g, '"').trim()
        : 'Movie';

      const yearMatch = rawTitle.match(/\b(19\d\d|20\d\d)\b/);
      const year = yearMatch ? yearMatch[1] : '';

      let poster = '';
      if (post.yoast_head_json && post.yoast_head_json.og_image && post.yoast_head_json.og_image[0] && post.yoast_head_json.og_image[0].url) {
        poster = post.yoast_head_json.og_image[0].url;
      } else if (post.yoast_head_json && post.yoast_head_json.twitter_image) {
        poster = post.yoast_head_json.twitter_image;
      } else if (post.jetpack_featured_media_url) {
        poster = post.jetpack_featured_media_url;
      } else if (post._embedded && post._embedded['wp:featuredmedia'] && post._embedded['wp:featuredmedia'][0]) {
        poster = post._embedded['wp:featuredmedia'][0].source_url || '';
      }

      const content = (post.content && post.content.rendered) || '';
      if (!poster && content) {
        const imgMatch = content.match(/<img[^>]+src=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp))["']/i);
        if (imgMatch && !imgMatch[1].includes('/emojis/') && !imgMatch[1].includes('/plugins/')) {
          poster = imgMatch[1];
        }
      }
      const releases = [];
      const btnRegex = /<a[^>]*href="([^"]+)"[^>]*data-om-name="([^"]+)"[^>]*data-om-size="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = btnRegex.exec(content)) !== null) {
        const rawLabel = m[4].replace(/<[^>]+>/g, '').trim();
        const filename = m[2].replace(/&amp;/g, '&');
        const size = m[3].trim();
        const href = m[1].trim();

        let quality = '1080p';
        if (/2160p|4k|uhd/i.test(filename + ' ' + rawLabel)) quality = '4K UHD';
        else if (/1080p/i.test(filename + ' ' + rawLabel)) quality = '1080p';
        else if (/720p/i.test(filename + ' ' + rawLabel)) quality = '720p';

        const isHevc = /hevc|x265|h\.265|10bit/i.test(filename);
        const isMultiAudio = /multi audio|dual audio|hindi|tamil|telugu|kannada|malayalam/i.test(filename);
        const isHdr = /hdr|dv|dolby|atmos/i.test(filename + ' ' + rawLabel);

        releases.push({
          label: rawLabel || quality,
          filename,
          size,
          quality,
          href,
          provider: 'olamovies',
          isHevc,
          isMultiAudio,
          isHdr
        });
      }

      items.push({
        id: `ola_${post.id}`,
        title: rawTitle,
        year,
        poster,
        link: post.link,
        provider: 'olamovies',
        type: 'movie',
        releasesCount: releases.length,
        releases
      });
    }
    return items;
  } catch (err) {
    console.warn('[MovieSearch] OlaMovies error:', err.message);
    return [];
  }
}

async function searchYtsMovies(query, page = 1) {
  const mirrors = [
    'https://movies-api.accel.li/api/v2/list_movies.json',
    'https://yts.lt/api/v2/list_movies.json',
    'https://yts.bz/api/v2/list_movies.json'
  ];

  for (const mirror of mirrors) {
    try {
      const url = `${mirror}?query_term=${encodeURIComponent(query)}&page=${page}&limit=12`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(6000)
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data || !data.data || !data.data.movies) continue;

      const items = [];
      for (const m of data.data.movies) {
        const title = m.title_english || m.title || 'Movie';
        const year = m.year ? String(m.year) : '';
        const poster = m.large_cover_image || m.medium_cover_image || '';
        const rating = m.rating || 0;
        const genres = m.genres || [];
        const summary = m.summary || '';

        const releases = (m.torrents || []).map(t => {
          const q = t.quality === '2160p' ? '4K UHD' : (t.quality || '1080p');
          const hash = t.hash;
          const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&tr=udp%3A%2F%2Fexplodie.org%3A6969%2Fannounce`;
          return {
            label: `${q} (${(t.type || 'WEB').toUpperCase()}) [${t.size}]`,
            filename: `${title}.${year}.${t.quality}.${t.type || 'WEB'}.mp4`,
            quality: q,
            size: t.size,
            seeders: t.seeds || 0,
            peers: t.peers || 0,
            hash,
            magnet,
            torrentUrl: t.url || `https://yts.mx/torrent/download/${hash}`,
            provider: 'yts'
          };
        });

        items.push({
          id: `yts_${m.id}`,
          title: `${title} (${year})`,
          pureTitle: title,
          year,
          poster,
          rating,
          genres,
          summary,
          provider: 'yts',
          type: 'movie',
          releasesCount: releases.length,
          releases
        });
      }
      return items;
    } catch (e) {}
  }
  return [];
}

// Clean raw torrent/release filenames into clean movie titles & years
function extractCleanMovieTitle(rawName) {
  if (!rawName) return { title: '', year: '' };
  let s = rawName.replace(/[\._]/g, ' ').trim();
  let yr = '';
  const yearMatch = s.match(/\b(19\d\d|20\d\d)\b/);
  if (yearMatch) {
    yr = yearMatch[1];
    const idx = s.indexOf(yr);
    if (idx > 2) s = s.substring(0, idx).trim();
  }
  s = s.replace(/\b(4k|2160p|1080p|720p|480p|uhd|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdrip|dvdrip|cam|h264|x264|h265|x265|hevc|10bit|aac|ac3|dts|remux|hdr|dv|sdr|atmos|sub|dub|multi|amzn|dsnp|hs|galaxy|yts|proper|repack|extended|unrated|directors cut)\b.*/i, '');
  s = s.replace(/[\[\]\(\)\{\}\-_+]/g, ' ').replace(/\s+/g, ' ').trim();
  return { title: s, year: yr };
}

// In-memory poster and metadata cache for instant responses
const movieMetaCache = new Map();

async function resolveMoviePoster(rawTitle, fallbackQuery = '') {
  const { title, year } = extractCleanMovieTitle(rawTitle);
  const searchKey = (title || fallbackQuery || '').toLowerCase().trim();
  if (!searchKey) return '';

  if (movieMetaCache.has(searchKey)) {
    const cached = movieMetaCache.get(searchKey);
    return (cached && cached.poster) ? cached.poster : '';
  }

  async function queryCinemeta(term, type = 'movie') {
    try {
      const url = `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(term)}.json`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(4500)
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data && Array.isArray(data.metas) && data.metas.length > 0) {
        if (year) {
          const matchYear = data.metas.find(m => m.releaseInfo && m.releaseInfo.includes(year) && m.poster);
          if (matchYear) return matchYear;
        }
        const firstWithPoster = data.metas.find(m => m.poster);
        if (firstWithPoster) return firstWithPoster;
      }
    } catch (e) {}
    return null;
  }

  try {
    let meta = null;

    // 1. Query Cinemeta catalog with extracted clean title
    if (title) {
      meta = await queryCinemeta(title, 'movie');
      if (!meta) meta = await queryCinemeta(title, 'series');
    }

    // 2. Fallback to user query if title differed
    if (!meta && fallbackQuery && fallbackQuery.toLowerCase() !== title.toLowerCase()) {
      meta = await queryCinemeta(fallbackQuery, 'movie');
      if (!meta) meta = await queryCinemeta(fallbackQuery, 'series');
    }

    let poster = meta ? meta.poster : null;

    // 3. Fallback to iTunes Search API if Cinemeta had no result
    if (!poster) {
      try {
        const qTerm = title || fallbackQuery;
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(qTerm)}&media=movie&limit=3`;
        const itRes = await fetch(itunesUrl, { signal: AbortSignal.timeout(3500) });
        if (itRes.ok) {
          const itData = await itRes.json();
          if (itData && itData.results && itData.results.length > 0) {
            const rawArt = itData.results[0].artworkUrl100 || '';
            if (rawArt) {
              poster = rawArt.replace(/100x100bb\.jpg/i, '600x600bb.jpg');
            }
          }
        }
      } catch (e) {}
    }

    if (poster) {
      // Upgrade Cinemeta / IMDb Amazon poster resolution to crisp 600px
      if (poster.includes('media-amazon.com/images/M/') && poster.includes('._V1_')) {
        poster = poster.replace(/\._V1_.*?\.(jpg|jpeg|png|webp)/i, '._V1_SX600.$1');
      }
      if (movieMetaCache.size > 2500) movieMetaCache.clear();
      movieMetaCache.set(searchKey, {
        poster,
        name: (meta && meta.name) || title,
        year: (meta && meta.releaseInfo) || year,
        rating: (meta && meta.imdbRating) || ''
      });
      return poster;
    }
  } catch (err) {}

  movieMetaCache.set(searchKey, { poster: '', name: title, year, rating: '' });
  return '';
}

async function searchApibayMovies(query) {
  try {
    const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=200`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0 || items[0].name === 'No results returned') return [];

    const activeItems = items.filter(it => parseInt(it.seeders, 10) > 0).slice(0, 15);
    const results = [];
    for (const it of activeItems) {
      const name = it.name;
      const sizeBytes = parseInt(it.size, 10) || 0;
      const sizeStr = sizeBytes > (1024 ** 3)
        ? (sizeBytes / (1024 ** 3)).toFixed(2) + ' GB'
        : (sizeBytes / (1024 ** 2)).toFixed(1) + ' MB';
      const hash = it.info_hash;
      const seeders = parseInt(it.seeders, 10) || 0;
      const peers = parseInt(it.leechers, 10) || 0;

      let quality = '1080p';
      if (/2160p|4k|uhd/i.test(name)) quality = '4K UHD';
      else if (/1080p/i.test(name)) quality = '1080p';
      else if (/720p/i.test(name)) quality = '720p';

      const yearMatch = name.match(/\b(19\d\d|20\d\d)\b/);
      const year = yearMatch ? yearMatch[1] : '';

      const { title: cleanTitle, year: cleanYear } = extractCleanMovieTitle(name);

      const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce`;

      results.push({
        id: `tpb_${hash}`,
        title: name,
        pureTitle: cleanTitle || name.replace(/[\._]/g, ' '),
        year: cleanYear || year,
        poster: '',
        provider: 'torrent',
        type: 'movie',
        releasesCount: 1,
        releases: [{
          label: `${quality} [${sizeStr}]`,
          filename: name,
          quality,
          size: sizeStr,
          seeders,
          peers,
          hash,
          magnet,
          provider: 'torrent'
        }]
      });
    }

    // Concurrently resolve official movie posters from Cinemeta / iTunes
    const distinctSearchKeys = [...new Set(results.map(r => {
      const { title } = extractCleanMovieTitle(r.title);
      return (title || query).toLowerCase().trim();
    }))];

    await Promise.allSettled(distinctSearchKeys.map(k => resolveMoviePoster(k, query)));

    // Attach posters and metadata to results
    for (const it of results) {
      const { title } = extractCleanMovieTitle(it.title);
      const k = (title || query).toLowerCase().trim();
      const meta = movieMetaCache.get(k);
      if (meta && meta.poster) {
        it.poster = meta.poster;
        if (meta.name && it.pureTitle === it.title) it.pureTitle = meta.name;
        if (meta.year && !it.year) it.year = meta.year;
        if (meta.rating && !it.rating) it.rating = meta.rating;
      }
    }

    return results;
  } catch (e) {
    console.warn('[MovieSearch] Apibay error:', e.message);
    return [];
  }
}

// Public endpoint for client UI to sync enabled movie search provider tabs
app.get('/api/movie-sources', (req, res) => {
  const feat = (engineConfig && engineConfig.features) || {};
  res.json({
    success: true,
    sources: {
      olamovies: feat.olamoviesSource !== false,
      yts: !!feat.ytsSource,
      torrents: !!feat.torrentsSource
    }
  });
});

// Unified Movie Search API (OlaMovies + YTS + Torrents)
app.get('/api/movies/search', async (req, res) => {
  try {
    if (engineConfig.features && engineConfig.features.movieHub === false) {
      return res.json({ success: true, results: [], query: '', total: 0, disabled: true, message: 'Movie & TV Hub is currently disabled by administrator in Admin Settings.' });
    }

    const q = (req.query.q || '').trim();
    let requestedSource = req.query.source || 'all'; // 'all', 'olamovies', 'yts', 'torrents'
    const qualityFilter = req.query.quality || 'all'; // 'all', '4k', '1080p', '720p'
    const page = parseInt(req.query.page, 10) || 1;

    if (!q) {
      return res.json({ success: true, results: [], query: '', total: 0 });
    }

    const feat = (engineConfig && engineConfig.features) || {};
    const olaEnabled = feat.olamoviesSource !== false;
    const ytsEnabled = !!feat.ytsSource;
    const torrentsEnabled = !!feat.torrentsSource;

    if (!olaEnabled && !ytsEnabled && !torrentsEnabled) {
      return res.json({ success: true, results: [], query: q, total: 0, message: 'All movie providers are currently disabled in Admin Settings.' });
    }

    // Auto-resolve requested source against active provider states
    if (requestedSource === 'olamovies' && !olaEnabled) {
      requestedSource = ytsEnabled ? 'yts' : (torrentsEnabled ? 'torrents' : 'none');
    } else if (requestedSource === 'yts' && !ytsEnabled) {
      requestedSource = olaEnabled ? 'olamovies' : (torrentsEnabled ? 'torrents' : 'none');
    } else if (requestedSource === 'torrents' && !torrentsEnabled) {
      requestedSource = olaEnabled ? 'olamovies' : (ytsEnabled ? 'yts' : 'none');
    }

    if (requestedSource === 'none') {
      return res.json({ success: true, results: [], query: q, total: 0, message: 'Requested provider is currently disabled by administrator.' });
    }

    let combined = [];

    if (requestedSource === 'yts') {
      combined = await searchYtsMovies(q, page);
    } else if (requestedSource === 'torrents') {
      combined = await searchApibayMovies(q);
    } else if (requestedSource === 'olamovies') {
      const olaItems = await searchOlaMovies(q, page);
      // If torrent fallback is permitted and mirrors are available, attach torrent fallback to each Ola item
      if (feat.torrentFallback !== false) {
        try {
          const [yRes, tRes] = await Promise.allSettled([
            searchYtsMovies(q, 1),
            searchApibayMovies(q)
          ]);
          const ytsItems = yRes.status === 'fulfilled' ? yRes.value : [];
          const tpbItems = tRes.status === 'fulfilled' ? tRes.value : [];
          for (const item of olaItems) {
            const cleanTitleWords = item.title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
            let match = ytsItems.find(y => {
              const yTitle = (y.pureTitle || y.title).toLowerCase();
              return cleanTitleWords.slice(0, 2).every(w => yTitle.includes(w));
            });
            if (!match) {
              match = tpbItems.find(t => {
                const tTitle = t.title.toLowerCase();
                return cleanTitleWords.slice(0, 2).every(w => tTitle.includes(w));
              });
            }
            if (match && match.releases && match.releases.length > 0) {
              item.torrentFallback = match.releases[0];
            }
            if (!item.poster && match && match.poster) {
              item.poster = match.poster;
            }
          }
        } catch (e) {}
      }
      combined = olaItems;
    } else {
      // 'all': query all currently enabled providers concurrently
      const tasks = [];
      if (olaEnabled) tasks.push(searchOlaMovies(q, page));
      if (ytsEnabled) tasks.push(searchYtsMovies(q, page));
      if (torrentsEnabled) tasks.push(searchApibayMovies(q));
      const settled = await Promise.allSettled(tasks);
      for (const s of settled) {
        if (s.status === 'fulfilled' && Array.isArray(s.value)) {
          combined.push(...s.value);
        }
      }
    }

    // Ensure every movie/torrent item across all sources has a resolved official poster
    const missingPosters = combined.filter(it => !it.poster || it.poster.trim() === '');
    if (missingPosters.length > 0) {
      const distinctKeys = [...new Set(missingPosters.map(it => {
        const { title } = extractCleanMovieTitle(it.title || q);
        return (title || q).toLowerCase().trim();
      }))];
      await Promise.allSettled(distinctKeys.map(k => resolveMoviePoster(k, q)));
      for (const it of missingPosters) {
        const { title } = extractCleanMovieTitle(it.title || q);
        const k = (title || q).toLowerCase().trim();
        const meta = movieMetaCache.get(k);
        if (meta && meta.poster) {
          it.poster = meta.poster;
          if (meta.name && (!it.pureTitle || it.pureTitle === it.title)) it.pureTitle = meta.name;
          if (meta.year && !it.year) it.year = meta.year;
          if (meta.rating && !it.rating) it.rating = meta.rating;
        }
      }
    }

    // Proxy posters through server to bypass foreign referer Cloudflare hotlink blocks
    for (const it of combined) {
      if (it.poster && it.poster.startsWith('http') && !it.poster.startsWith('/api/proxy-image')) {
        it.poster = `/api/proxy-image?url=${encodeURIComponent(it.poster)}`;
      }
    }

    // Apply quality filter if specified
    if (qualityFilter !== 'all') {
      combined = combined.filter(it => {
        if (!it.releases || it.releases.length === 0) return true;
        if (qualityFilter === '4k') return it.releases.some(r => /4k|2160p/i.test(r.quality || r.label));
        if (qualityFilter === '1080p') return it.releases.some(r => /1080p/i.test(r.quality || r.label));
        if (qualityFilter === '720p') return it.releases.some(r => /720p/i.test(r.quality || r.label));
        return true;
      });
    }

    res.json({
      success: true,
      query: q,
      page,
      source: requestedSource,
      quality: qualityFilter,
      count: combined.length,
      results: combined
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Standalone Movie Poster & Metadata Lookup API
app.get('/api/movies/poster', async (req, res) => {
  try {
    const title = (req.query.title || req.query.q || '').trim();
    if (!title) return res.json({ success: false, poster: '' });
    const poster = await resolveMoviePoster(title, title);
    res.json({ success: true, poster });
  } catch (e) {
    res.json({ success: false, poster: '' });
  }
});

// Movie 1-Click Download API
app.post('/api/movies/download', async (req, res) => {
  try {
    const item = req.body || {};
    let magnet = item.magnet || '';
    let torrentUrl = item.torrentUrl || '';
    let target = item.url || item.href || '';

    // If magnet/torrent not pre-attached, dynamically resolve high-speed torrent stream on-the-fly
    if (!magnet && !torrentUrl) {
      let cleanQuery = (item.title || '')
        .replace(/\b(19\d\d|20\d\d)\b.*$/, '$1')
        .replace(/\[.*?\]|\(.*?\)/g, ' ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!cleanQuery) cleanQuery = (item.title || '').trim();

      try {
        const [ytsRes, tpbRes] = await Promise.allSettled([
          searchYtsMovies(cleanQuery, 1),
          searchApibayMovies(cleanQuery)
        ]);
        const yts = ytsRes.status === 'fulfilled' ? ytsRes.value : [];
        const tpb = tpbRes.status === 'fulfilled' ? tpbRes.value : [];

        const candidates = [];
        for (const y of yts) {
          for (const r of y.releases || []) {
            if (r.magnet || r.torrentUrl) candidates.push(r);
          }
        }
        for (const t of tpb) {
          for (const r of t.releases || []) {
            if (r.magnet || r.torrentUrl) candidates.push(r);
          }
        }

        if (candidates.length > 0) {
          const reqQ = (item.quality || '1080p').toLowerCase();
          let match = candidates.find(c => (c.quality || '').toLowerCase().includes(reqQ));
          if (!match && reqQ !== '1080p') {
            match = candidates.find(c => (c.quality || '').toLowerCase().includes('1080p'));
          }
          if (!match) match = candidates[0];

          magnet = match.magnet || '';
          torrentUrl = match.torrentUrl || '';
          target = magnet || torrentUrl;
        }
      } catch (e) {
        console.warn('[MovieDownload] Dynamic torrent resolution error:', e.message);
      }
    }

    if (!magnet && !torrentUrl && !target) {
      return res.status(400).json({ error: 'Valid download stream could not be resolved for this title.' });
    }

    const isTorrent = !!(magnet || torrentUrl || (target && target.startsWith('magnet:')));
    const finalTarget = magnet || torrentUrl || target;

    const jobPayload = {
      url: finalTarget,
      magnet: magnet,
      torrentUrl: torrentUrl,
      title: item.title || item.filename || 'Movie Media',
      poster: item.poster || '',
      code: 'MOVIE',
      mode: 'video',
      videoQuality: item.quality || 'best',
      type: isTorrent ? 'torrent' : 'video'
    };

    const job = createAndStartJob(jobPayload);
    res.json({
      success: true,
      jobId: job.id,
      title: job.title,
      type: jobPayload.type
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unified Adult Search API
app.get('/api/adult/search', async (req, res) => {
  try {
    if (engineConfig.features && engineConfig.features.adultHub === false) {
      return res.json({ success: true, results: [], query: '', total: 0, disabled: true, message: 'Adult & JAV Hub is currently disabled by administrator in Admin Settings.' });
    }

    const q = (req.query.q || '').trim();
    const type = req.query.type || 'all';
    const duration = req.query.duration || 'full'; // 'full' (10m+), 'extended' (20m+), 'all'
    const page = parseInt(req.query.page, 10) || 1;

    if (!q) {
      return res.json({ success: true, results: [], query: '', total: 0 });
    }

    let tubeResults = [];
    let javResults = [];

    if (type === 'all' || type === 'tubes') {
      const [xvRes, phRes] = await Promise.allSettled([
        searchXVideos(q, page, duration),
        searchPornhub(q, page)
      ]);
      const xv = xvRes.status === 'fulfilled' ? xvRes.value : [];
      const ph = phRes.status === 'fulfilled' ? phRes.value : [];
      const maxTube = Math.max(xv.length, ph.length);
      for (let i = 0; i < maxTube; i++) {
        if (i < xv.length) tubeResults.push(xv[i]);
        if (i < ph.length) tubeResults.push(ph[i]);
      }
    }

    if (type === 'all' || type === 'jav') {
      try {
        javResults = await searchSukebeiJAV(q, page);
      } catch (e) {
        console.warn('[AdultSearch] Sukebei error:', e.message);
      }
    }

    let combined = [];
    if (type === 'tubes') {
      combined = tubeResults;
    } else if (type === 'jav') {
      combined = javResults;
    } else {
      // Interleave JAV Full Movies and High-Definition Tube releases
      const maxLen = Math.max(tubeResults.length, javResults.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < javResults.length) combined.push(javResults[i]);
        if (i < tubeResults.length) combined.push(tubeResults[i]);
      }
    }

    res.json({
      success: true,
      query: q,
      page,
      duration,
      count: combined.length,
      results: combined
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Adult Direct 1-Click Download API
app.post('/api/adult/download', async (req, res) => {
  try {
    const item = req.body || {};
    if (!item.url && !item.magnet && !item.torrentUrl) {
      return res.status(400).json({ error: 'Valid URL or magnet link is required' });
    }

    const isTorrent = !!(item.torrentUrl || item.magnet || item.type === 'jav');
    const jobPayload = {
      url: item.url || item.torrentUrl || item.magnet,
      magnet: item.magnet,
      torrentUrl: item.torrentUrl,
      title: item.title || item.code || 'Adult Media',
      poster: item.thumb || '',
      code: item.code || 'ADULT',
      mode: 'video',
      videoQuality: 'best',
      type: isTorrent ? 'torrent' : 'tube'
    };

    const job = createAndStartJob(jobPayload);
    res.json({
      success: true,
      jobId: job.id,
      title: job.title,
      type: jobPayload.type
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function startTorrentJob(job) {
  job.status = 'downloading';
  job.startTime = Date.now();
  job.progress.eta = 'Connecting to peers...';
  job.logs.push('Starting BitTorrent acceleration engine via aria2c...');
  broadcastJobUpdate(job.id);

  const { opts } = job;
  // Prioritize direct .torrent URL over raw magnet:
  // Torrent files bypass slow DHT metadata resolution and connect to peers immediately!
  const target = (opts && (opts.torrentUrl || opts.magnet)) || job.url;
  if (!target) {
    job.status = 'failed';
    job.error = 'Missing valid magnet link or torrent URL';
    broadcastJobUpdate(job.id);
    processDownloadQueue();
    return;
  }

  const ariaBin = process.platform === 'linux' ? '/usr/bin/aria2c' : 'aria2c';
  const outDir = path.join(TEMP_DIR, job.id);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const args = [
    '--dir=' + outDir,
    '--seed-time=0',
    '--max-connection-per-server=16',
    '--split=16',
    '--bt-max-peers=60',
    '--bt-stop-timeout=600',
    '--summary-interval=1',
    '--enable-dht=true',
    '--bt-enable-lpd=true',
    '--file-allocation=none',
    '--follow-torrent=mem',
    '--header=User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    target
  ];

  try {
    const child = spawn(ariaBin, args, { windowsHide: true });
    job.process = child;
    job.pid = child.pid;

    child.stdout.on('data', data => {
      const text = data.toString();
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        job.logs.push(line);
        if (job.logs.length > 100) job.logs.shift();

        // Robust match for aria2c output with or without ETA / DL speed
        const m = line.match(/\[#\w+\s+([\d.]+\s*[a-zA-Z]+)\/([\d.]+\s*[a-zA-Z]+)\((\d+)%\)(?:.*?DL:([\d.]+\s*[a-zA-Z]+))?(?:.*?ETA:([\w\d:]+))?/i);
        if (m) {
          job.progress.downloadedSize = m[1];
          job.progress.totalSize = m[2];
          job.progress.percent = parseInt(m[3], 10);
          job.progress.speed = m[4] ? m[4] + '/s' : '0 B/s';
          job.progress.eta = m[5] || (job.progress.percent === 0 ? 'Connecting...' : 'Calculating...');
          broadcastJobUpdate(job.id);
        } else if (line.includes('METADATA')) {
          job.progress.eta = 'Resolving metadata...';
          broadcastJobUpdate(job.id);
        }
      }
    });

    child.stderr.on('data', data => {
      job.logs.push(`[ERR] ${data.toString()}`);
    });

    child.on('close', code => {
      job.process = null;
      job.pid = null;
      if (code === 0) {
        try {
          // Recursively find the largest media file strictly in outDir (handles multi-file subdirectories)
          function findLargestMediaFile(dir) {
            let largest = null;
            if (!fs.existsSync(dir)) return null;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name.startsWith('.') || entry.name.endsWith('.aria2')) continue;
              const full = path.join(dir, entry.name);
              try {
                if (entry.isDirectory()) {
                  const nested = findLargestMediaFile(full);
                  if (nested && (!largest || nested.size > largest.size)) {
                    largest = nested;
                  }
                } else if (entry.isFile()) {
                  const ext = path.extname(entry.name).toLowerCase();
                  if (['.mp4', '.mkv', '.avi', '.ts', '.wmv', '.flv', '.mov', '.webm', '.m4v', '.mp3', '.flac', '.m4a', '.wav'].includes(ext)) {
                    const st = fs.statSync(full);
                    if (!largest || st.size > largest.size) {
                      largest = { path: full, name: entry.name, size: st.size, mtimeMs: st.mtimeMs };
                    }
                  }
                }
              } catch (e) {}
            }
            return largest;
          }

          function findAnyLargestFile(dir) {
            let largest = null;
            if (!fs.existsSync(dir)) return null;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name.startsWith('.') || entry.name.endsWith('.aria2') || entry.name.endsWith('.txt') || entry.name.endsWith('.nfo')) continue;
              const full = path.join(dir, entry.name);
              try {
                if (entry.isDirectory()) {
                  const nested = findAnyLargestFile(full);
                  if (nested && (!largest || nested.size > largest.size)) largest = nested;
                } else if (entry.isFile()) {
                  const st = fs.statSync(full);
                  if (!largest || st.size > largest.size) {
                    largest = { path: full, name: entry.name, size: st.size, mtimeMs: st.mtimeMs };
                  }
                }
              } catch (e) {}
            }
            return largest;
          }

          let largestFile = findLargestMediaFile(outDir);
          if (!largestFile) {
            largestFile = findAnyLargestFile(outDir);
          }

          if (largestFile && largestFile.size > 0) {
            job.filePath = largestFile.path;
            job.filename = (job.opts && job.opts.customFilename) || largestFile.name;
            job.filesize = largestFile.size > (1024 ** 3)
              ? (largestFile.size / (1024 ** 3)).toFixed(2) + ' GB'
              : (largestFile.size / (1024 ** 2)).toFixed(1) + ' MB';
            job.progress.totalSize = job.filesize;
          }
        } catch (e) {}

        job.status = 'completed';
        job.progress.percent = 100;
        job.progress.speed = '0 MB/s';
        job.progress.eta = 'Ready';
        job.completedTime = Date.now();
        job.logs.push('BitTorrent download completed successfully.');
        saveJobsHistory();
      } else {
        if (job.status !== 'cancelled' && job.status !== 'paused') {
          job.status = 'failed';
          job.error = `aria2c exited with code ${code}`;
        }
      }
      broadcastJobUpdate(job.id);
      processDownloadQueue();
    });

    child.on('error', err => {
      job.status = 'failed';
      job.error = `Failed to start aria2c: ${err.message}`;
      broadcastJobUpdate(job.id);
      processDownloadQueue();
    });
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    broadcastJobUpdate(job.id);
    processDownloadQueue();
  }
}

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
  const isDeezer = url && url.includes('deezer.com');
  const isTidal = url && (url.includes('tidal.com') || url.includes('listen.tidal.com'));
  const isAudioFlac = mode === 'audio' && audioFormat === 'flac';
  const isYouTubeFlac = isYouTube && isAudioFlac;
  const isDeezerFlac = isDeezer && isAudioFlac;
  const isAppleOrDeezer = url && (url.includes('music.apple.com') || (isDeezer && !isAudioFlac));
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
    ], { 
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    });
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
    ], { 
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    });
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
    ], { 
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    });
    job.process = child;
    attachProcessListeners(job, child);
  } else if (isYouTubeFlac || isDeezerFlac || (isTidal && isAudioFlac)) {
    const pythonBin = getPythonBin();
    const audiophileScript = path.join(__dirname, 'audiophile_flac_engine.py');
    const safeTitle = (job.title || 'audiophile_track').replace(/[\\/:*?"<>|]/g, '_').trim();
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

    job.logs.push(`Lossless FLAC requested: "${job.title}"`);
    job.logs.push(`Initiating 3-Tier Audiophile Resolution Pipeline (Tidal Hi-Res → Soulseek P2P → Deezer HiFi)...`);
    job.logs.push(`Strict Quality Guarantee: Fake/upscaled transcodes prohibited; full spectral authenticity analysis will be enforced.`);

    const child = spawn(pythonBin, [
      audiophileScript,
      artist,
      trackTitle,
      finalOutPath
    ], { 
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    });
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

    const child = spawn(pythonBin, [hlsScript, url || rawTarget, finalOutPath], { 
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    });
    job.process = child;
    attachProcessListeners(job, child);
  } else {
    const concurrentFragments = parseInt(opts.concurrentFragments, 10) || engineConfig.aria2cFragments || 16;
    const outputTemplate = path.join(TEMP_DIR, `${job.id}_${job.title}.%(ext)s`);
    const args = [
      '--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      '--concurrent-fragments', String(concurrentFragments),
      '--buffer-size', engineConfig.bufferSize || '16M',
      '--http-chunk-size', engineConfig.httpChunkSize || '10M',
      '--retries', String(engineConfig.retries || 10),
      '--fragment-retries', String(engineConfig.retries || 10),
      '--newline',
      '--ignore-errors',
      '--js-runtimes', process.platform === 'win32' ? 'node' : 'node:/usr/bin/node',
      '-o', outputTemplate
    ];

    if (process.platform === 'linux') {
      try {
        execSync('which aria2c', { stdio: 'ignore' });
        const frag = engineConfig.aria2cFragments || 16;
        const split = engineConfig.aria2cMinSplitSize || '1M';
        args.push('--downloader', 'http,https:aria2c');
        args.push('--downloader-args', `aria2c:-s ${frag} -x ${frag} -k 1M -j ${frag} --min-split-size=${split} --summary-interval=1`);
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
      if (audioFormat === 'flac' && isYouTube) {
        job.logs.push(`Strict Quality Policy: Transcoding lossy YouTube audio (128-160k Opus) into fake FLAC is prohibited.`);
        throw new Error("Transcoding lossy YouTube audio streams into fake FLAC is strictly prohibited to preserve lossless integrity.");
      }
      args.push('-x');
      const aFmt = audioFormat || 'mp3';
      args.push('--audio-format', aFmt);
      const aBit = audioBitrate || '320k';
      args.push('--audio-quality', aBit === 'best' ? '0' : aBit);
    } else {
      const targetFmt = (videoFormat && videoFormat !== 'auto') ? videoFormat : 'mp4';
      if (targetFmt === 'mp4') {
        if (videoQuality && videoQuality !== 'best') {
          const maxHeight = parseInt(videoQuality, 10);
          args.push('-f', `bestvideo[height<=${maxHeight}][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`);
        } else {
          args.push('-f', 'bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best');
        }
        args.push('--merge-output-format', 'mp4');
        args.push('--postprocessor-args', 'Merger:-movflags +faststart');
      } else {
        if (videoQuality && videoQuality !== 'best') {
          const maxHeight = parseInt(videoQuality, 10);
          args.push('-f', `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`);
        } else {
          args.push('-f', 'bestvideo+bestaudio/best');
        }
        args.push('--merge-output-format', targetFmt);
      }
    }

    // Subtitles (only for video)
    if (embedSubtitles && mode !== 'audio') {
      args.push('--embed-subs');
      let requestedLangs = (subLangs && subLangs.trim()) ? subLangs.trim() : 'en.*,hi.*,ja.*';
      // When auto-subs is enabled, querying all 140+ language tracks triggers YouTube's HTTP 429 rate limit.
      // Scope to common languages if broad wildcard was provided.
      if (autoSubs) {
        if (requestedLangs === 'all' || requestedLangs === 'all,-live_chat') {
          requestedLangs = 'en.*,hi.*,ja.*,zh.*,es.*';
        }
        args.push('--write-auto-subs');
        args.push('--sleep-subtitles', '1');
      }
      args.push('--sub-langs', requestedLangs);
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
      if (pMatch[3]) job.progress.speed = (job.progress.percent >= 100) ? '0 MB/s' : pMatch[3].trim();
      if (pMatch[4]) job.progress.eta = (job.progress.percent >= 100) ? 'Ready' : pMatch[4].trim();
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

    // Detect candidate size from Soulseek logs: '...' (56.8MB from '...')
    const candMatch = line.match(/\(([\d.]+\s*(?:KiB|MiB|GiB|KB|MB|GB))\s+from/i);
    if (candMatch && (!job.progress.totalSize || job.progress.totalSize === '0 MB')) {
      job.progress.totalSize = candMatch[1].trim();
    }

    // Detect saved file size from Soulseek / SpotiFLAC logs: saved: ... (56.9MB)
    const savedMatch = line.match(/saved:.*?\(([\d.]+\s*(?:KiB|MiB|GiB|KB|MB|GB))\)/i);
    if (savedMatch) {
      job.progress.totalSize = savedMatch[1].trim();
      job.filesize = savedMatch[1].trim();
    }

    // Detect raw byte completion: 100% of 59671493 bytes
    const bytesMatch = line.match(/100%\s+of\s+(\d+)\s+bytes/i);
    if (bytesMatch) {
      const szMb = (parseInt(bytesMatch[1], 10) / (1024 * 1024)).toFixed(1) + ' MB';
      job.progress.totalSize = szMb;
      job.filesize = szMb;
      job.progress.percent = 100;
      job.progress.eta = 'Ready';
    }

    // Dynamic ETA fallback if ETA is stuck on Starting... while actively downloading
    if (job.progress.percent > 2 && job.progress.percent < 100) {
      if (!job.progress.eta || job.progress.eta === 'Starting...' || job.progress.eta === '--:--') {
        const elapsed = (Date.now() - job.startTime) / 1000;
        if (elapsed > 2) {
          const totalEstimated = elapsed / (job.progress.percent / 100);
          const remaining = Math.max(0, Math.round(totalEstimated - elapsed));
          const m = Math.floor(remaining / 60);
          const s = remaining % 60;
          job.progress.eta = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
      }
    }

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

    if (job.status === 'paused') {
      job.isSuspended = false;
      job.logs.push('Download paused. State preserved for resumption.');
      broadcastJobUpdate(jobId);
      processDownloadQueue();
      return;
    }

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
          const originalExt = path.extname(matched);
          const rawBase = matched.replace(`${jobId}_`, '');
          let cleanBase = rawBase.replace(/\.[^.]+$/, '');
          cleanBase = cleanBase.replace(/^job_[a-zA-Z0-9]+_[a-zA-Z0-9]+_/, '');
          const cleanFilename = `${cleanBase}${originalExt}`;
          
          let cleanFilePath = path.join(TEMP_DIR, cleanFilename);
          const rawFilePath = path.join(TEMP_DIR, matched);
          
          // Rename on disk to remove machine jobId prefix
          if (rawFilePath !== cleanFilePath) {
            try {
              if (fs.existsSync(cleanFilePath)) {
                try { fs.unlinkSync(cleanFilePath); } catch (e) {}
              }
              fs.renameSync(rawFilePath, cleanFilePath);
              matched = cleanFilename;
            } catch (renErr) {
              console.warn('[Server] Notice renaming file:', renErr.message);
              cleanFilePath = rawFilePath;
            }
          }

          job.filePath = cleanFilePath;
          job.filename = cleanFilename;

          // Purge any stray loose images from temp directory so only the single clean media file remains
          try {
            const allDirFiles = fs.readdirSync(TEMP_DIR);
            for (const f of allDirFiles) {
              if ((f.startsWith(`${jobId}_`) || f.startsWith(cleanBase) || f === 'cover.jpg') &&
                  (f.endsWith('.jpg') || f.endsWith('.png') || f.endsWith('.jpeg') || f.endsWith('.webp') || f.endsWith('.part'))) {
                try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch (e) {}
              }
            }
          } catch (e) {}

          job.coverUrl = `/api/download-cover/${job.id}`;

          const stat = fs.statSync(job.filePath);
          if (stat.size > 0) {
            job.status = 'completed';
            job.progress.percent = 100;
            job.progress.eta = 'Ready';
            job.logs.push('Processing completed! File ready in folder.');
            job.filesize = stat.size > (1024 ** 3)
              ? (stat.size / (1024 ** 3)).toFixed(2) + ' GB'
              : (stat.size / (1024 ** 2)).toFixed(1) + ' MB';
            job.progress.totalSize = job.filesize;
            saveJobsHistory();
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
      if (job.status !== 'cancelled' && job.status !== 'paused') {
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
      eta: 'Starting...',
      downloadedSize: '',
      totalSize: '',
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
  if (getActiveDownloadCount() < getMaxConcurrentDownloads()) {
    if (job.opts && (job.opts.magnet || job.opts.torrentUrl || job.opts.type === 'torrent')) {
      startTorrentJob(job);
    } else {
      startJobProcess(job);
    }
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
      lastLog: job.logs.length > 0 ? job.logs[job.logs.length - 1] : '',
      logs: job.logs.slice(-20)
    });
  }
  res.json(list);
});

// Helper to pause a job
function pauseJob(job) {
  if (!job) return false;
  if (job.status === 'queued') {
    job.status = 'paused';
    job.progress.eta = 'Paused';
    job.logs.push('Task paused in queue.');
    broadcastJobUpdate(job.id);
    return true;
  }
  if (job.status === 'downloading') {
    job.status = 'paused';
    job.progress.speed = '0 MB/s';
    job.progress.eta = 'Paused';
    job.logs.push('Download paused by user.');

    if (job.process && job.process.pid) {
      const pid = job.process.pid;
      if (process.platform !== 'win32') {
        try {
          execSync(`pkill -STOP -P ${pid} 2>/dev/null; kill -STOP ${pid} 2>/dev/null`, { stdio: 'ignore' });
          job.isSuspended = true;
        } catch (e) {
          try { job.process.kill('SIGSTOP'); job.isSuspended = true; } catch (err) {}
        }
      } else {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
        } catch (e) {}
        job.isSuspended = false;
        job.process = null;
      }
    }
    broadcastJobUpdate(job.id);
    processDownloadQueue();
    return true;
  }
  return false;
}

// Helper to resume a job
function resumeJob(job) {
  if (!job || job.status !== 'paused') return false;

  job.logs.push('Resuming download...');
  if (job.isSuspended && job.process && job.process.pid) {
    const pid = job.process.pid;
    if (process.platform !== 'win32') {
      let isAlive = false;
      try {
        execSync(`kill -0 ${pid} 2>/dev/null`);
        isAlive = true;
      } catch (e) {
        isAlive = false;
      }

      if (isAlive) {
        try {
          execSync(`kill -CONT ${pid} 2>/dev/null; pkill -CONT -P ${pid} 2>/dev/null`, { stdio: 'ignore' });
        } catch (e) {
          try { job.process.kill('SIGCONT'); } catch (err) {}
        }
        job.isSuspended = false;
        job.status = 'downloading';
        job.progress.eta = 'Resuming...';
        job.logs.push('Download stream resumed.');
        broadcastJobUpdate(job.id);
        return true;
      }
    }
  }

  // If process was terminated, socket closed, or on Windows
  job.isSuspended = false;
  if (getActiveDownloadCount() < getMaxConcurrentDownloads()) {
    startJobProcess(job);
  } else {
    job.status = 'queued';
    job.logs.push('Download queued for resumption...');
    broadcastJobUpdate(job.id);
  }
  return true;
}

// 5. Pause Job Endpoint
app.post('/api/jobs/:id/pause', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const ok = pauseJob(job);
  if (ok) {
    res.json({ success: true, status: 'paused' });
  } else {
    res.status(400).json({ error: `Cannot pause job with status: ${job.status}` });
  }
});

// 6. Resume Job Endpoint
app.post('/api/jobs/:id/resume', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const ok = resumeJob(job);
  if (ok) {
    res.json({ success: true, status: job.status });
  } else {
    res.status(400).json({ error: `Cannot resume job with status: ${job.status}` });
  }
});

// 7. Pause All Jobs Endpoint
app.post('/api/jobs/pause-all', (req, res) => {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === 'downloading' || job.status === 'queued') {
      if (pauseJob(job)) count++;
    }
  }
  res.json({ success: true, pausedCount: count });
});

// 8. Resume All Jobs Endpoint
app.post('/api/jobs/resume-all', (req, res) => {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === 'paused') {
      if (resumeJob(job)) count++;
    }
  }
  res.json({ success: true, resumedCount: count });
});

// 9. Cancel Job (Tree termination & partial cleanup)
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

  // 1. Remove isolated job directory if exists
  try {
    const jobDir = path.join(TEMP_DIR, jobId);
    if (fs.existsSync(jobDir)) {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  } catch (e) {}

  // 2. Remove specific job.filePath if exists
  try {
    if (job && job.filePath && fs.existsSync(job.filePath)) {
      fs.rmSync(job.filePath, { recursive: true, force: true });
    }
  } catch (e) {}

  // 3. Remove any prefixed files in TEMP_DIR
  try {
    const files = fs.readdirSync(TEMP_DIR);
    for (const f of files) {
      if (f.startsWith(`${jobId}_`) || f.startsWith(`${jobId}.`) || f === jobId) {
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
  saveJobsHistory();
  processDownloadQueue();
  res.json({ success: true, message: 'Job deleted' });
});

// Clear All Inactive Jobs
app.delete('/api/jobs', (req, res) => {
  for (const [id, job] of jobs.entries()) {
    if (job.status !== 'downloading' && job.status !== 'queued' && job.status !== 'paused') {
      try {
        const jobDir = path.join(TEMP_DIR, id);
        if (fs.existsSync(jobDir)) {
          fs.rmSync(jobDir, { recursive: true, force: true });
        }
        if (job.filePath && fs.existsSync(job.filePath)) {
          fs.rmSync(job.filePath, { recursive: true, force: true });
        }
        const files = fs.readdirSync(TEMP_DIR);
        for (const f of files) {
          if (f.startsWith(`${id}_`) || f.startsWith(`${id}.`) || f === id) {
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
  saveJobsHistory();
  res.json({ success: true, message: 'Cleared completed jobs' });
});

// 6. Direct Browser File Download
app.get('/api/download-file/:id', (req, res) => {
  const jobId = req.params.id;
  const match = findMediaFileByJobId(jobId);

  if (!match || !fs.existsSync(match.filePath)) {
    return res.status(404).send('File not found or expired');
  }

  const clientFilename = match.filename || path.basename(match.filePath);
  res.download(match.filePath, clientFilename, (err) => {
    if (err && !res.headersSent) {
      console.warn('[Server] Download error:', err.message);
    }
  });
});

// 6b. Direct Browser Cover Art Download
app.get('/api/download-cover/:id', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);

  // 1. If media file exists, stream the embedded cover artwork via ffmpeg on-the-fly
  const targetFile = job && job.filePath && fs.existsSync(job.filePath) ? job.filePath : null;
  if (targetFile) {
    try {
      const ffmpegBin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
      const cleanBase = (job.filename || 'cover').replace(/\.[^.]+$/, '');
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(cleanBase)}.jpg"`);

      const ff = spawn(ffmpegBin, ['-v', 'error', '-i', targetFile, '-an', '-vcodec', 'copy', '-f', 'image2', 'pipe:1']);
      let hasData = false;
      ff.stdout.on('data', (chunk) => {
        hasData = true;
        res.write(chunk);
      });
      ff.on('close', () => {
        if (!hasData) {
          if (job && job.opts && job.opts.poster && job.opts.poster.startsWith('http')) {
            return res.redirect(job.opts.poster);
          }
          if (!res.headersSent) res.status(404).send('Cover artwork not found');
        } else {
          res.end();
        }
      });
      ff.on('error', () => {
        if (!res.headersSent) {
          if (job && job.opts && job.opts.poster && job.opts.poster.startsWith('http')) {
            return res.redirect(job.opts.poster);
          }
          res.status(404).send('Cover artwork extraction failed');
        }
      });
      return;
    } catch (e) {}
  }

  // 2. Fallback: redirect to poster URL
  if (job && job.opts && job.opts.poster && job.opts.poster.startsWith('http')) {
    return res.redirect(job.opts.poster);
  }

  res.status(404).send('Cover artwork not found');
});

// 7. Media Streaming Endpoint
app.get('/api/stream/:id', (req, res) => {
  const jobId = req.params.id;
  const match = findMediaFileByJobId(jobId);

  if (!match || !fs.existsSync(match.filePath)) {
    return res.status(404).send('File not found');
  }

  const filePath = match.filePath;

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

let slskdProcess = null;

function startEmbeddedSlskd() {
  const req = http.get('http://127.0.0.1:5030/api/v0/application', { timeout: 1500 }, (res) => {
    // Already active
  });
  req.on('error', () => {
    const slskdBin = path.join(__dirname, 'bin', 'slskd', process.platform === 'win32' ? 'slskd.exe' : 'slskd');
    if (fs.existsSync(slskdBin)) {
      const username = 'audiophile_' + Math.floor(10000 + Math.random() * 90000);
      const password = 'pass_' + Math.floor(10000 + Math.random() * 90000);
      try {
        slskdProcess = spawn(slskdBin, [
          '--no-auth',
          '--http-port', '5030',
          '--slsk-username', username,
          '--slsk-password', password
        ], {
          windowsHide: true,
          stdio: 'ignore',
          detached: true
        });
        slskdProcess.unref();
        console.log('[Server] Embedded Soulseek HiFi daemon initiated.');
      } catch (e) {}
    }
  });
}

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
  if (slskdProcess) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /T /PID ${slskdProcess.pid}`, { stdio: 'ignore' });
      } else {
        slskdProcess.kill('SIGTERM');
      }
    } catch (e) {}
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
  startEmbeddedSlskd();
});
