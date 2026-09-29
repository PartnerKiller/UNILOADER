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
const aiService = require('./ai_service');

const app = express();
const PORT = process.env.PORT || 3000;
let TEMP_DIR = process.env.TEMP_DIR || path.join(__dirname, 'temp_media');

// High-Speed Public BitTorrent Trackers for maximum swarm connectivity & peer discovery
const HIGH_SPEED_BT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.coppersurfer.tk:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://explodie.org:6969/announce',
  'udp://9.rarbg.to:2920/announce',
  'udp://tracker.internetwarriors.net:1337/announce',
  'http://tracker.openbittorrent.com:80/announce'
];
const BT_TRACKER_PARAMS = HIGH_SPEED_BT_TRACKERS.map(t => `tr=${encodeURIComponent(t)}`).join('&');

// Global Dynamic Engine Configuration
const ENGINE_CONFIG_FILE = path.join(__dirname, 'engine_config.json');
const defaultEngineConfig = {
  maxConcurrentJobs: 4,
  aria2cFragments: 32,
  aria2cMinSplitSize: '1M',
  bufferSize: '32M',
  httpChunkSize: '16M',
  retries: 10,
  maintenanceMode: false,
  maintenanceMessage: 'We are currently performing scheduled maintenance and system upgrades. The site will be back online shortly. Thank you for your patience!',
  bandwidthCaps: {
    enabled: false,           // Master bandwidth cap switch (off = full pipe for everyone)
    guestLimit: '1M',         // Default limit for anonymous visitors / guests
    userLimit: '3M',          // Default limit for registered standard members
    premiumLimit: '0',        // '0' = uncapped for premium, or e.g. '10M'
    customUserLimits: {}      // Per-user overrides: { [usernameOrId]: '500K' | '2M' | '0' }
  },
  features: {
    adultHub: true,
    movieHub: true,
    torrentFallback: true,
    soulseekP2P: true,
    strictLossless: true,
    embedSubs: true,
    embedChapters: true,
    sponsorBlock: true,
    ddlSource: true,
    ytsSource: false,
    torrentsSource: false
  }
};
let engineConfig = { ...defaultEngineConfig };

function normalizeBandwidthString(val) {
  if (val === undefined || val === null) return '0';
  const str = String(val).trim().toUpperCase();
  if (!str || str === '0' || str === 'UNLIMITED' || str === 'NONE' || str === 'OFF' || str === 'FALSE') {
    return '0';
  }
  // Strip trailing /s or b/s (e.g. 1MB/s -> 1M, 500KB/s -> 500K)
  let cleaned = str.replace(/\/S$/i, '').replace(/B$/i, '');
  const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*([KMG])?$/);
  if (!match) return '0';
  const num = match[1];
  const unit = match[2] || '';
  if (parseFloat(num) <= 0) return '0';
  return `${num}${unit}`;
}

function resolveUserBandwidthCap(entity) {
  // If master bandwidth capping is disabled in engine config, no cap applied
  if (!engineConfig.bandwidthCaps || !engineConfig.bandwidthCaps.enabled) {
    return null;
  }

  if (!entity) {
    const defaultGuest = normalizeBandwidthString(engineConfig.bandwidthCaps.guestLimit || '1M');
    return defaultGuest === '0' ? null : defaultGuest;
  }

  // Extract identity attributes from user object or job object
  const isOwner = !!(
    entity.isOwner ||
    entity.role === 'owner' ||
    entity.ownerId === 'owner' ||
    entity.userId === 'owner' ||
    entity.username === 'sakura' ||
    (entity.opts && (entity.opts.isOwner || entity.opts.ownerId === 'owner' || entity.opts.role === 'owner' || entity.opts.username === 'sakura'))
  );

  // OWNER is ALWAYS uncapped (highest priority, full gigabit pipe speed)
  if (isOwner) {
    return null;
  }

  const userId = entity.userId || entity.ownerId || (entity.opts && entity.opts.ownerId);
  const username = entity.username || (entity.opts && entity.opts.username);
  const customLimits = (engineConfig.bandwidthCaps && engineConfig.bandwidthCaps.customUserLimits) ? engineConfig.bandwidthCaps.customUserLimits : {};

  // Check individual custom override by userId or username (case-insensitive)
  if (userId && customLimits[userId] !== undefined) {
    const norm = normalizeBandwidthString(customLimits[userId]);
    return norm === '0' ? null : norm;
  }
  if (username) {
    const lowerUser = username.toLowerCase();
    for (const [k, v] of Object.entries(customLimits)) {
      if (k.toLowerCase() === lowerUser) {
        const norm = normalizeBandwidthString(v);
        return norm === '0' ? null : norm;
      }
    }
  }

  // Tiered role limit: Premium
  const isPremium = !!(entity.isPremium || entity.role === 'premium' || (entity.opts && entity.opts.isPremium));
  if (isPremium) {
    const norm = normalizeBandwidthString(engineConfig.bandwidthCaps.premiumLimit);
    return norm === '0' ? null : norm;
  }

  // Tiered role limit: Guest
  const role = entity.role || (entity.opts && entity.opts.role);
  const isGuest = role === 'guest' || (!role && (!userId || String(userId).startsWith('guest_')));
  if (isGuest) {
    const norm = normalizeBandwidthString(engineConfig.bandwidthCaps.guestLimit || '1M');
    return norm === '0' ? null : norm;
  }

  // Registered standard member
  const norm = normalizeBandwidthString(engineConfig.bandwidthCaps.userLimit || '3M');
  return norm === '0' ? null : norm;
}

function loadEngineConfig() {
  try {
    if (fs.existsSync(ENGINE_CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ENGINE_CONFIG_FILE, 'utf8'));
      engineConfig = {
        ...defaultEngineConfig,
        ...parsed,
        maintenanceMode: parsed.maintenanceMode !== undefined ? !!parsed.maintenanceMode : false,
        maintenanceMessage: typeof parsed.maintenanceMessage === 'string' && parsed.maintenanceMessage.trim() ? parsed.maintenanceMessage.trim() : defaultEngineConfig.maintenanceMessage,
        bandwidthCaps: {
          ...defaultEngineConfig.bandwidthCaps,
          ...(parsed.bandwidthCaps || {}),
          customUserLimits: {
            ...(defaultEngineConfig.bandwidthCaps?.customUserLimits || {}),
            ...(parsed.bandwidthCaps?.customUserLimits || {})
          }
        },
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
const globalSseClients = new Map(); // res -> currentUser

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
          ownerId: j.ownerId || 'owner',
          downloadFolder: j.downloadFolder || '',
          isPermanent: !!j.isPermanent,
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
              ownerId: r.ownerId || 'owner',
              downloadFolder: r.downloadFolder || '',
              isPermanent: !!r.isPermanent,
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
              ownerId: 'owner',
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

const stripAnsi = (str) => typeof str === 'string' ? str.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '') : (str || '');

function isProgressLine(line) {
  if (!line || typeof line !== 'string') return false;
  const s = line.trim();
  // yt-dlp / curl / python progress ticks: [download]  12.3% of ...
  if (/^\[download\]\s+[\d.]+%(\s+of|\s*$)/i.test(s)) return true;
  // aria2c progress ticks: [#fd6ef8 510MiB/1.3GiB(36%)...]
  if (/^\[#\w+\s+[\d.]+/i.test(s)) return true;
  // Telegram / Torrent / Swarm progress ticks: Progress: 40% (2.5 MB/s)
  if (/(?:Telegram|BitTorrent|Swarm).*?Progress:\s*[\d.]+/i.test(s)) return true;
  // Raw ffmpeg progress ticks: frame= 120 fps=... or size= ... time= ...
  if (/^frame=\s*\d+/i.test(s) || /^size=\s*\d+.*?time=/i.test(s)) return true;
  return false;
}

function isAriaJunkBanner(line) {
  if (!line || typeof line !== 'string') return false;
  const s = line.trim();
  if (s.startsWith('*** Download Progress Summary')) return true;
  if (/^[=\-]{10,}$/.test(s)) return true;
  return false;
}

function appendJobLog(job, rawLine) {
  if (!job) return;
  if (!Array.isArray(job.logs)) job.logs = [];
  if (!rawLine || typeof rawLine !== 'string') return;
  const line = stripAnsi(rawLine).trim();
  if (!line) return;

  // 1. Filter out redundant aria2c summary banners and separator lines
  if (isAriaJunkBanner(line)) return;

  // 2. Prevent consecutive identical lines (e.g. repetitive FILE: path announcements)
  const len = job.logs.length;
  if (len > 0 && job.logs[len - 1] === line) {
    return;
  }

  // 3. For live stream progress lines (aria2c [#hash ...], yt-dlp [download] ...%),
  // update the active progress line in place so thousands of ticks don't flood the logs,
  // but record milestone lines every 10% change
  if (isProgressLine(line)) {
    if (len > 0 && isProgressLine(job.logs[len - 1])) {
      const prev = job.logs[len - 1];
      const prevPercentMatch = prev.match(/(\d+)%/);
      const currPercentMatch = line.match(/(\d+)%/);
      const prevPct = prevPercentMatch ? parseInt(prevPercentMatch[1], 10) : null;
      const currPct = currPercentMatch ? parseInt(currPercentMatch[1], 10) : null;

      const isMilestone = prevPct !== null && currPct !== null &&
        (Math.floor(currPct / 10) > Math.floor(prevPct / 10));

      if (isMilestone) {
        job.logs.push(line);
      } else {
        job.logs[len - 1] = line;
        return;
      }
    } else {
      job.logs.push(line);
    }
  } else {
    job.logs.push(line);
  }

  // 4. Smart buffer retention: Keep up to 1,000 lines.
  // CRITICAL: NEVER drop the first 50 initialization/setup lines!
  // Always drop from line index 50 onwards so the beginning of the download is ALWAYS preserved!
  if (job.logs.length > 1000) {
    job.logs.splice(50, 1);
  }
}

loadJobsHistory();

function formatJobSummary(job, detailed = false) {
  const base = {
    id: job.id,
    url: job.url || '',
    mode: job.mode,
    title: job.title,
    code: job.code || 'MEDIA',
    poster: job.poster || '',
    status: job.status,
    progress: job.progress || { percent: 0, speed: '0 MB/s', eta: '--' },
    filesize: job.filesize || '',
    filename: job.filename,
    error: job.error,
    createdAt: job.createdAt || job.startTime || Date.now(),
    downloadUrl: `/api/download-file/${job.id}`,
    streamUrl: `/api/stream/${job.id}`,
    filePath: job.filePath || '',
    ownerId: job.ownerId || 'owner',
    downloadFolder: job.downloadFolder || '',
    isPermanent: !!job.isPermanent
  };
  base.lastLog = job.logs && job.logs.length > 0 ? stripAnsi(job.logs[job.logs.length - 1]) : '';
  base.logs = job.logs ? job.logs.slice(detailed ? -500 : -50).map(stripAnsi) : [];
  if (detailed) {
    base.startTime = job.startTime;
    base.completedTime = job.completedTime;
  }
  return base;
}

function getJobsForUser(currentUser, options = {}) {
  const isOwner = currentUser && (currentUser.isOwner || currentUser.role === 'owner' || currentUser.userId === 'owner' || currentUser.username?.toLowerCase() === 'sakura');
  const targetUserId = currentUser ? currentUser.userId : null;
  const showAll = Boolean(options.all || isOwner);

  const result = [];
  for (const job of jobs.values()) {
    if (showAll) {
      result.push(formatJobSummary(job, options.detailed));
      continue;
    }

    const jobOwner = job.ownerId || 'owner';
    if (targetUserId && jobOwner === targetUserId) {
      result.push(formatJobSummary(job, options.detailed));
    }
  }

  result.sort((a, b) => (b.createdAt || b.startTime || 0) - (a.createdAt || a.startTime || 0));
  return result;
}

// Real-Time Queue Synchronization Broadcast across all connected devices & sessions
function broadcastGlobalJobSync() {
  if (globalSseClients.size === 0) return;
  for (const [clientRes, clientUser] of globalSseClients.entries()) {
    try {
      const userJobs = getJobsForUser(clientUser, { detailed: false });
      const payload = JSON.stringify(userJobs);
      clientRes.write(`event: sync\ndata: ${payload}\n\n`);
      clientRes.write(`data: ${payload}\n\n`);
    } catch (e) {
      globalSseClients.delete(clientRes);
    }
  }
}

// Backward-compatible alias
const broadcastGlobalJobUpdate = broadcastGlobalJobSync;

const jobUpdateTimers = new Map();

function scheduleJobUpdate(jobId, immediate = false) {
  if (immediate) {
    if (jobUpdateTimers.has(jobId)) {
      clearTimeout(jobUpdateTimers.get(jobId));
      jobUpdateTimers.delete(jobId);
    }
    broadcastJobUpdate(jobId);
    return;
  }

  if (jobUpdateTimers.has(jobId)) return;

  const timer = setTimeout(() => {
    jobUpdateTimers.delete(jobId);
    broadcastJobUpdate(jobId);
  }, 160);

  jobUpdateTimers.set(jobId, timer);
}

function broadcastJobUpdate(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  const jobSummary = formatJobSummary(job, true);
  const jsonPayload = JSON.stringify(jobSummary);

  // 1. Live incremental progress event over Global SSE stream to authorized clients
  if (globalSseClients.size > 0) {
    for (const [clientRes, clientUser] of globalSseClients.entries()) {
      try {
        const isOwner = clientUser && (clientUser.isOwner || clientUser.role === 'owner' || clientUser.userId === 'owner' || clientUser.username?.toLowerCase() === 'sakura');
        const targetUserId = clientUser ? clientUser.userId : null;
        const jobOwner = job.ownerId || 'owner';
        if (isOwner || (targetUserId && jobOwner === targetUserId)) {
          clientRes.write(`event: job_progress\ndata: ${jsonPayload}\n\n`);
        }
      } catch (e) {
        globalSseClients.delete(clientRes);
      }
    }
  }

  // 2. Synchronize queue structure on terminal states
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    broadcastGlobalJobSync();
  }

  // 3. Dedicated per-job SSE clients (backward compatibility)
  const clients = sseClients.get(jobId);
  if (clients && clients.size > 0) {
    for (const res of clients) {
      try {
        res.write(`data: ${jsonPayload}\n\n`);
      } catch (e) {
        clients.delete(res);
      }
    }
  }
}

// Global SSE Stream Endpoint (Real-time live updates isolated per user with proxy buffering bypass)
app.get('/api/jobs/stream', identifyUser, (req, res) => {
  // Prevent socket timeouts from closing long-lived streaming connections
  if (req.socket) {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 10000);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform, no-store, must-revalidate',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'none',
    'Access-Control-Allow-Origin': '*'
  });

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  // Instruct client EventSource to auto-reconnect after 2000ms if ever dropped
  res.write('retry: 2000\n\n');
  res.write(': connected\n\n');
  res.write(`event: ping\ndata: ${Date.now()}\n\n`);

  globalSseClients.set(res, req.currentUser);

  // Send initial jobs payload strictly filtered for this user
  const initial = getJobsForUser(req.currentUser, { detailed: false });
  const initialPayload = JSON.stringify(initial);
  clientResWriteSafe(res, `event: sync\ndata: ${initialPayload}\n\n`);
  clientResWriteSafe(res, `data: ${initialPayload}\n\n`);

  // Send initial maintenance mode state
  const maintPayload = JSON.stringify({
    active: !!engineConfig.maintenanceMode,
    message: engineConfig.maintenanceMessage || defaultEngineConfig.maintenanceMessage
  });
  clientResWriteSafe(res, `event: maintenance\ndata: ${maintPayload}\n\n`);

  req.on('close', () => {
    globalSseClients.delete(res);
  });
});

function clientResWriteSafe(res, chunk) {
  try {
    res.write(chunk);
    if (typeof res.flush === 'function') res.flush();
  } catch (e) {}
}

function broadcastMaintenanceUpdate() {
  const payload = JSON.stringify({
    active: !!engineConfig.maintenanceMode,
    message: engineConfig.maintenanceMessage || defaultEngineConfig.maintenanceMessage
  });
  for (const client of globalSseClients.keys()) {
    clientResWriteSafe(client, `event: maintenance\ndata: ${payload}\n\n`);
  }
}

// SSE Heartbeat every 10 seconds to keep reverse-proxy & Cloudflare tunnel connections persistent
setInterval(() => {
  if (globalSseClients.size === 0) return;
  const pingPayload = `event: ping\ndata: ${Date.now()}\n\n`;
  for (const client of globalSseClients.keys()) {
    try {
      client.write(': keepalive\n\n');
      client.write(pingPayload);
      if (typeof client.flush === 'function') client.flush();
    } catch (e) {
      globalSseClients.delete(client);
    }
  }
}, 10000);

// Concurrency Queue Manager
function getActiveDownloadCount() {
  let count = 0;
  for (const job of jobs.values()) {
    if ((job.status === 'downloading' || job.status === 'resolving_ddl') && job.process) count++;
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
      } else if (job.url && (job.url.includes('workers.dev') || job.mode === 'direct_http')) {
        startDirectHttpJob(job);
      } else if (job.mode === 'ddl_direct') {
        startDdlMovieResolver(job, job.opts || {});
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
      ddlMovies: true,
      ytsMovies: true,
      pirateBayTorrents: false,
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

function generateAdminToken(user, rememberMe = true) {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, { user, rememberMe: !!rememberMe, createdAt: Date.now() });
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
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  const maxAge = (session.rememberMe !== false) ? (90 * 24 * 60 * 60 * 1000) : (24 * 60 * 60 * 1000);
  if (Date.now() - session.createdAt > maxAge) {
    adminSessions.delete(token);
    saveAdminSessions();
    return null;
  }
  return session;
}

function requireAdmin(req, res, next) {
  const session = verifyAdminToken(req);
  if (session) {
    req.admin = session;
    return next();
  }

  // Also check if Bearer token belongs to an owner or admin user session
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.headers['x-admin-token'] || req.headers['x-user-token']) {
    token = req.headers['x-admin-token'] || req.headers['x-user-token'];
  }
  if (token) {
    const uSess = userSessions.get(token);
    if (uSess && (uSess.role === 'owner' || uSess.role === 'admin')) {
      req.admin = { user: uSess.username, role: uSess.role };
      return next();
    }
  }

  return res.status(401).json({ error: 'Unauthorized: Admin authentication required' });
}

// 1. Admin Login
app.post('/api/admin/login', (req, res) => {
  const { username, password, rememberMe } = req.body || {};
  const isRemember = rememberMe !== false;
  const expectedUser = (process.env.ADMIN_USER || 'sakura').toLowerCase();
  const expectedPass = process.env.ADMIN_PASS || 'Sakura@002';
  const cleanUser = (username || '').trim().toLowerCase();
  const isMatchUser = cleanUser === expectedUser || cleanUser === 'sakura' || cleanUser === 'admin';

  if (isMatchUser && password === expectedPass) {
    const token = generateAdminToken(process.env.ADMIN_USER || 'sakura', isRemember);
    userSessions.set(token, {
      userId: 'owner',
      username: process.env.ADMIN_USER || 'sakura',
      role: 'owner',
      rememberMe: isRemember,
      createdAt: Date.now()
    });
    saveUserSessions();
    res.json({ success: true, token, user: process.env.ADMIN_USER || 'sakura', role: 'owner' });
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
  res.json({ success: true, user: req.admin.user, role: req.admin.role || 'owner' });
});

// ==========================================================================
// User Authentication, Premium Tiers & Guest Limits
// ==========================================================================
const USERS_FILE = path.join(__dirname, '.users.json');
const USER_SESSIONS_FILE = path.join(__dirname, '.user_sessions.json');
const ACCESS_REQUESTS_FILE = path.join(__dirname, '.access_requests.json');
const users = new Map(); // username.toLowerCase() -> { id, username, passwordHash, salt, role, createdAt }
const userSessions = new Map(); // token -> { userId, username, role, createdAt }
const accessRequests = new Map(); // id -> { id, username, contact, note, ip, status, createdAt, updatedAt, assignedPassword }
const guestDailyUsage = new Map(); // ip/guestId -> { date: 'YYYY-MM-DD', count: N }

// ==========================================================================
// Dynamic Role Permissions & Feature Access Control Matrix
// ==========================================================================
const ROLE_PERMISSIONS_FILE = path.join(__dirname, '.role_permissions.json');

const FEATURE_METADATA = [
  { key: 'downloader', label: 'Single Downloader', description: 'Core single URL media extraction (YouTube, TikTok, Twitter, Instagram, etc.)' },
  { key: 'batch', label: 'Batch Downloader', description: 'Bulk & multi-link concurrent task enqueueing' },
  { key: 'movies', label: 'Movie & TV Hub', description: 'Search, stream resolvers, and Direct DDL downloads for cinema & shows' },
  { key: 'music', label: 'Music Hub (Lossy)', description: 'Search and direct MP3/M4A/Opus downloads for tracks and albums' },
  { key: 'audiophile_flac', label: 'Audiophile FLAC (24-bit/Hi-Res)', description: 'Lossless Studio Masters via Tidal Monochrome, SLSKD P2P, and Deezer HiFi' },
  { key: 'flac_checker', label: 'FLAC Authenticity Checker', description: 'Audio spectral Nyquist cutoff analysis and counterfeit detection' },
  { key: 'adult', label: 'Adult & JAV Hub', description: 'Censored & Uncensored JAV streams, Rule34Video, and Tube engine' },
  { key: 'quality_4k', label: '4K & 8K Ultra HD', description: 'Unclamped 2160p and 4320p maximum resolution streaming' },
  { key: 'unlimited_concurrency', label: 'Unlimited Concurrency', description: 'Download multiple active tasks concurrently without queue throttling' },
  { key: 'custom_storage', label: 'Dedicated Folder Storage', description: 'User-assigned persistent destination folder routing' },
  { key: 'ai_copilot', label: 'AI Media Copilot & Multimodal Engine', description: 'Owner-exclusive Google Gemini AI Copilot, FLAC Spectrogram Audit, Subtitles, JAV recognition' }
];

const DEFAULT_ROLE_PERMISSIONS = {
  guest: {
    downloader: true,
    batch: false,
    movies: false,
    music: false,
    audiophile_flac: false,
    flac_checker: true,
    adult: false,
    quality_4k: false,
    unlimited_concurrency: false,
    custom_storage: false,
    ai_copilot: false
  },
  user: {
    downloader: true,
    batch: true,
    movies: true,
    music: true,
    audiophile_flac: true,
    flac_checker: true,
    adult: true,
    quality_4k: true,
    unlimited_concurrency: true,
    custom_storage: true,
    ai_copilot: false
  },
  premium: {
    downloader: true,
    batch: true,
    movies: true,
    music: true,
    audiophile_flac: true,
    flac_checker: true,
    adult: true,
    quality_4k: true,
    unlimited_concurrency: true,
    custom_storage: true,
    ai_copilot: false
  }
};

let rolePermissions = JSON.parse(JSON.stringify(DEFAULT_ROLE_PERMISSIONS));

function loadRolePermissions() {
  try {
    if (fs.existsSync(ROLE_PERMISSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ROLE_PERMISSIONS_FILE, 'utf8'));
      if (data && typeof data === 'object') {
        for (const role of ['guest', 'user', 'premium']) {
          if (data[role] && typeof data[role] === 'object') {
            rolePermissions[role] = Object.assign({}, DEFAULT_ROLE_PERMISSIONS[role], data[role]);
          }
        }
        rolePermissions.guest.flac_checker = true;
      }
    }
  } catch (err) {
    console.warn('[RolePermissions] Failed to load role permissions:', err.message);
  }
}

function saveRolePermissions() {
  try {
    fs.writeFileSync(ROLE_PERMISSIONS_FILE, JSON.stringify(rolePermissions, null, 2), 'utf8');
  } catch (err) {
    console.warn('[RolePermissions] Failed to save role permissions:', err.message);
  }
}

function isFeatureAllowed(userOrRole, featureKey) {
  if (!userOrRole) return false;
  let role = 'guest';
  let isOwner = false;
  let customPermissions = null;

  if (typeof userOrRole === 'string') {
    role = userOrRole.toLowerCase();
    if (role === 'owner' || role === 'admin' || role === 'sakura') isOwner = true;
    const u = users.get(role) || Array.from(users.values()).find(x => x.id === userOrRole);
    if (u) {
      role = (u.role || 'user').toLowerCase();
      if (u.role === 'owner' || u.username?.toLowerCase() === 'sakura') isOwner = true;
      if (u.customPermissions && typeof u.customPermissions === 'object') {
        customPermissions = u.customPermissions;
      }
    }
  } else if (typeof userOrRole === 'object') {
    role = (userOrRole.role || 'guest').toLowerCase();
    if (userOrRole.isOwner || userOrRole.username?.toLowerCase() === 'sakura' || role === 'owner' || role === 'admin') {
      isOwner = true;
    }
    if (userOrRole.customPermissions && typeof userOrRole.customPermissions === 'object') {
      customPermissions = userOrRole.customPermissions;
    } else {
      const u = users.get(userOrRole.username?.toLowerCase() || '') ||
                Array.from(users.values()).find(x => x.id === userOrRole.id || x.id === userOrRole.userId);
      if (u && u.customPermissions && typeof u.customPermissions === 'object') {
        customPermissions = u.customPermissions;
      }
    }
  }

  // Sakura / Admin / Owner has universal unconstrained access to all features
  if (isOwner) {
    return true;
  }
  // Inbuilt FLAC Checker is a core utility accessible across all roles & guests
  if (featureKey === 'flac_checker') {
    return true;
  }
  // If user has an explicit individual custom permission override for this feature:
  if (customPermissions && typeof customPermissions[featureKey] === 'boolean') {
    return customPermissions[featureKey];
  }
  // Fall back to role permissions
  const perms = rolePermissions[role] || rolePermissions['guest'] || DEFAULT_ROLE_PERMISSIONS.guest;
  return perms[featureKey] === true;
}

function getUserPermissions(userOrRole) {
  let role = 'guest';
  let isOwner = false;
  let customPermissions = null;

  if (typeof userOrRole === 'string') {
    role = userOrRole.toLowerCase();
    if (role === 'owner' || role === 'admin' || role === 'sakura') isOwner = true;
    const u = users.get(role) || Array.from(users.values()).find(x => x.id === userOrRole);
    if (u) {
      role = (u.role || 'user').toLowerCase();
      if (u.role === 'owner' || u.username?.toLowerCase() === 'sakura') isOwner = true;
      if (u.customPermissions && typeof u.customPermissions === 'object') {
        customPermissions = u.customPermissions;
      }
    }
  } else if (userOrRole && typeof userOrRole === 'object') {
    role = (userOrRole.role || 'guest').toLowerCase();
    if (userOrRole.isOwner || userOrRole.username?.toLowerCase() === 'sakura' || role === 'owner' || role === 'admin') {
      isOwner = true;
    }
    if (userOrRole.customPermissions && typeof userOrRole.customPermissions === 'object') {
      customPermissions = userOrRole.customPermissions;
    } else {
      const u = users.get(userOrRole.username?.toLowerCase() || '') ||
                Array.from(users.values()).find(x => x.id === userOrRole.id || x.id === userOrRole.userId);
      if (u && u.customPermissions && typeof u.customPermissions === 'object') {
        customPermissions = u.customPermissions;
      }
    }
  }

  const result = {};
  for (const item of FEATURE_METADATA) {
    if (isOwner) {
      result[item.key] = true;
    } else if (item.key === 'flac_checker') {
      result[item.key] = true;
    } else if (customPermissions && typeof customPermissions[item.key] === 'boolean') {
      result[item.key] = customPermissions[item.key];
    } else {
      const perms = rolePermissions[role] || rolePermissions['guest'] || DEFAULT_ROLE_PERMISSIONS.guest;
      result[item.key] = perms[item.key] === true;
    }
  }
  return result;
}

function getRolePermissions(userOrRole) {
  return getUserPermissions(userOrRole);
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

const CATEGORY_SUBFOLDERS = {
  movies: 'Movies and Shows',
  music: 'Music',
  adult: 'Adult',
  links: 'Links'
};

function ensureCategorySubfolders(baseFolder) {
  if (!baseFolder || typeof baseFolder !== 'string') return;
  const resolved = path.resolve(baseFolder.trim());
  const baseName = path.basename(resolved);
  if (Object.values(CATEGORY_SUBFOLDERS).includes(baseName)) {
    return;
  }
  for (const sub of Object.values(CATEGORY_SUBFOLDERS)) {
    const subPath = path.join(resolved, sub);
    try {
      if (!fs.existsSync(subPath)) {
        fs.mkdirSync(subPath, { recursive: true });
        if (process.platform !== 'win32') {
          try { fs.chmodSync(subPath, 0o775); } catch (e) {}
        }
      }
    } catch (e) {
      console.warn(`[Storage] Failed to ensure category subfolder "${subPath}":`, e.message);
    }
  }
}

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const list = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      let modified = false;
      if (Array.isArray(list)) {
        for (const u of list) {
          if (u && u.username) {
            u.allowedFolders = Array.isArray(u.allowedFolders) ? u.allowedFolders : [];
            // Auto-heal empty downloadFolder from allowedFolders if allocated
            if ((!u.downloadFolder || !u.downloadFolder.trim()) && u.allowedFolders.length > 0) {
              const firstAllowed = u.allowedFolders.find(f => typeof f === 'string' && f.trim() && f.trim() !== '*');
              if (firstAllowed) {
                u.downloadFolder = firstAllowed.trim();
                modified = true;
              }
            }
            if (u.downloadFolder && typeof u.downloadFolder === 'string' && u.downloadFolder.trim() && u.downloadFolder.trim() !== '*') {
              try { ensureCategorySubfolders(u.downloadFolder); } catch (e) {}
            }
            if (Array.isArray(u.allowedFolders)) {
              for (const af of u.allowedFolders) {
                if (typeof af === 'string' && af.trim() && af.trim() !== '*') {
                  try { ensureCategorySubfolders(af); } catch (e) {}
                }
              }
            }
            users.set(u.username.toLowerCase(), u);
          }
        }
      }
      if (modified) {
        saveUsers();
      }
    }
  } catch (e) {
    console.warn('[Auth] Failed to load users:', e.message);
  }
}

function saveUsers() {
  try {
    const list = Array.from(users.values());
    fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Auth] Failed to save users:', e.message);
  }
}

function loadAccessRequests() {
  try {
    if (fs.existsSync(ACCESS_REQUESTS_FILE)) {
      const list = JSON.parse(fs.readFileSync(ACCESS_REQUESTS_FILE, 'utf8'));
      if (Array.isArray(list)) {
        for (const r of list) {
          if (r && r.id) {
            accessRequests.set(r.id, r);
          }
        }
      }
    }
  } catch (e) {
    console.warn('[AccessRequests] Failed to load:', e.message);
  }
}

function saveAccessRequests() {
  try {
    const list = Array.from(accessRequests.values());
    fs.writeFileSync(ACCESS_REQUESTS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.warn('[AccessRequests] Failed to save:', e.message);
  }
}

function ensureOwnerAccount() {
  const ownerUsername = (process.env.ADMIN_USER || 'sakura').trim();
  const ownerPassword = process.env.ADMIN_PASS || 'Sakura@002';
  const lowerOwner = ownerUsername.toLowerCase();

  let owner = users.get(lowerOwner);
  if (!owner) {
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(ownerPassword, salt);
    owner = {
      id: 'owner_sakura',
      username: ownerUsername,
      password: ownerPassword,
      passwordHash,
      salt,
      role: 'owner',
      allowedFolders: ['*'],
      createdAt: Date.now()
    };
    users.set(lowerOwner, owner);
    saveUsers();
  } else {
    let changed = false;
    if (owner.role !== 'owner') {
      owner.role = 'owner';
      changed = true;
    }
    if (!Array.isArray(owner.allowedFolders)) {
      owner.allowedFolders = ['*'];
      changed = true;
    }
    if (owner.password !== ownerPassword) {
      owner.password = ownerPassword;
      changed = true;
    }
    const testHash = hashPassword(ownerPassword, owner.salt);
    if (testHash !== owner.passwordHash) {
      owner.salt = crypto.randomBytes(16).toString('hex');
      owner.passwordHash = hashPassword(ownerPassword, owner.salt);
      changed = true;
    }
    if (changed) saveUsers();
  }
}

function loadUserSessions() {
  try {
    if (fs.existsSync(USER_SESSIONS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(USER_SESSIONS_FILE, 'utf8'));
      const now = Date.now();
      for (const [token, sess] of Object.entries(parsed)) {
        if (now - (sess.createdAt || 0) < 30 * 24 * 60 * 60 * 1000) {
          userSessions.set(token, sess);
        }
      }
    }
  } catch (e) {}
}

function saveUserSessions() {
  try {
    const obj = {};
    for (const [token, sess] of userSessions.entries()) {
      obj[token] = sess;
    }
    fs.writeFileSync(USER_SESSIONS_FILE, JSON.stringify(obj), 'utf8');
  } catch (e) {}
}

loadUsers();
ensureOwnerAccount();
loadUserSessions();
loadAccessRequests();
loadRolePermissions();

function getUserDownloadFolder(userOrId) {
  if (!userOrId) return null;
  let user = null;
  if (typeof userOrId === 'string') {
    const lower = userOrId.toLowerCase().trim();
    if (lower === 'owner' || lower === 'sakura' || lower === 'owner_sakura') {
      user = users.get('sakura');
      if (!user) {
        for (const u of users.values()) {
          if (u.role === 'owner' || u.id === 'owner_sakura' || (u.username && u.username.toLowerCase() === 'sakura')) {
            user = u;
            break;
          }
        }
      }
    } else if (users.has(lower)) {
      user = users.get(lower);
    } else {
      for (const u of users.values()) {
        if (u.id === userOrId || (u.username && u.username.toLowerCase() === lower)) {
          user = u;
          break;
        }
      }
    }
  } else if (userOrId.username) {
    user = users.get(userOrId.username.toLowerCase()) || userOrId;
  } else if (userOrId.id || userOrId.userId) {
    const targetId = userOrId.id || userOrId.userId;
    for (const u of users.values()) {
      if (u.id === targetId || (u.username && userOrId.username && u.username.toLowerCase() === userOrId.username.toLowerCase())) {
        user = u;
        break;
      }
    }
    if (!user) user = userOrId;
  } else {
    user = userOrId;
  }

  // 1. Check primary assigned downloadFolder
  let folder = null;
  if (user && user.downloadFolder && typeof user.downloadFolder === 'string') {
    const trimmed = user.downloadFolder.trim();
    if (trimmed && trimmed !== '*') {
      folder = trimmed;
    }
  }

  // 2. Fallback to user.allowedFolders (first non-wildcard directory)
  if (!folder && user && Array.isArray(user.allowedFolders) && user.allowedFolders.length > 0) {
    const candidate = user.allowedFolders.find(f => typeof f === 'string' && f.trim() && f.trim() !== '*');
    if (candidate) {
      folder = candidate.trim();
    }
  }

  // 3. Fallback to userOrId properties (e.g. from session or request object)
  if (!folder && userOrId && typeof userOrId === 'object') {
    if (userOrId.downloadFolder && typeof userOrId.downloadFolder === 'string' && userOrId.downloadFolder.trim() !== '*') {
      folder = userOrId.downloadFolder.trim();
    } else if (Array.isArray(userOrId.allowedFolders) && userOrId.allowedFolders.length > 0) {
      const candidate = userOrId.allowedFolders.find(f => typeof f === 'string' && f.trim() && f.trim() !== '*');
      if (candidate) {
        folder = candidate.trim();
      }
    }
  }

  if (folder) {
    const isOwner = (user && (user.role === 'owner' || user.isOwner || user.username?.toLowerCase() === 'sakura')) ||
                    (userOrId && (userOrId.role === 'owner' || userOrId.isOwner || userOrId.username?.toLowerCase() === 'sakura'));
    const isGuest = (user && user.role === 'guest') || (userOrId && userOrId.role === 'guest');

    if (!isGuest && (isOwner || isFeatureAllowed(user || userOrId, 'custom_storage') || (user && user.role !== 'guest') || (userOrId && userOrId.role !== 'guest'))) {
      return path.resolve(folder);
    }
  }
  return null;
}

function isPathInside(targetPath, parentPath) {
  if (!targetPath || !parentPath) return false;
  const rel = path.relative(parentPath, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isPermanentUserFile(filePath) {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);

  // 1. Check against active & historic jobs marked isPermanent
  for (const j of jobs.values()) {
    if (j.isPermanent && j.filePath && path.resolve(j.filePath) === resolved) {
      return true;
    }
    if (j.downloadFolder && typeof j.downloadFolder === 'string' && j.downloadFolder.trim() !== '*') {
      const dfResolved = path.resolve(j.downloadFolder.trim());
      if (isPathInside(resolved, dfResolved)) {
        return true;
      }
    }
  }

  // 2. Shield /media/storage, /media/*, /mnt/* dedicated mounts (excluding TEMP_DIR)
  const tempResolved = path.resolve(TEMP_DIR);
  if (!isPathInside(resolved, tempResolved)) {
    if (resolved.startsWith('/media/storage') || resolved.startsWith('/mnt/storage') || resolved.startsWith('/media/') || resolved.startsWith('/mnt/')) {
      return true;
    }
  }

  // 3. Check if file is located inside any user's assigned permanent downloadFolder or allowedFolders
  for (const u of users.values()) {
    if (u.downloadFolder && typeof u.downloadFolder === 'string' && u.downloadFolder.trim() !== '*') {
      const folderResolved = path.resolve(u.downloadFolder.trim());
      if (isPathInside(resolved, folderResolved)) {
        return true;
      }
    }
    if (Array.isArray(u.allowedFolders)) {
      for (const f of u.allowedFolders) {
        if (typeof f === 'string' && f.trim() && f.trim() !== '*') {
          const folderResolved = path.resolve(f.trim());
          if (isPathInside(resolved, folderResolved)) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

function isPermanentUserDirectory(dirPath) {
  if (!dirPath) return false;
  const resolved = path.resolve(dirPath);

  // Protect system roots
  if (resolved === '/' || resolved === path.parse(resolved).root) return true;

  // Protect /media and /mnt storage mounts (excluding TEMP_DIR)
  const tempResolved = path.resolve(TEMP_DIR);
  if (!isPathInside(resolved, tempResolved)) {
    if (resolved.startsWith('/media') || resolved.startsWith('/mnt')) return true;
  }

  // Protect any user's assigned permanent downloadFolder, allowedFolders, and parent/sub directories
  for (const u of users.values()) {
    if (u.downloadFolder && typeof u.downloadFolder === 'string' && u.downloadFolder.trim() !== '*') {
      const folderResolved = path.resolve(u.downloadFolder.trim());
      if (isPathInside(resolved, folderResolved) || isPathInside(folderResolved, resolved)) {
        return true;
      }
    }
    if (Array.isArray(u.allowedFolders)) {
      for (const f of u.allowedFolders) {
        if (typeof f === 'string' && f.trim() && f.trim() !== '*') {
          const folderResolved = path.resolve(f.trim());
          if (isPathInside(resolved, folderResolved) || isPathInside(folderResolved, resolved)) {
            return true;
          }
        }
      }
    }
  }

  // Protect standard category subfolder names
  const baseName = path.basename(resolved);
  if ([...Object.values(CATEGORY_SUBFOLDERS), 'Uni-Downloads'].includes(baseName)) {
    return true;
  }

  return false;
}

function getJobCategory(jobOrOpts) {
  if (!jobOrOpts) return 'links';

  const adultDomains = [
    'xvideos.com', 'pornhub.com', 'eporner.com', 'redtube.com', 'hqporner.com',
    'sukebei.nyaa.si', 'sukebei', 'jable.tv', 'missav', 'fc2.com', 'fanza.com',
    'dmm.co.jp', 'spankbang.com', 'youporn.com', 'tube8.com', 'brazzers.com',
    'rule34video.com', 'javlibrary.com', 'javdb.com', 'javbus.com', '7mmtv',
    'hpjav', 'avgle.com', 'supjav', 'jav'
  ];

  const codeUpper = String(jobOrOpts.code || (jobOrOpts.opts && jobOrOpts.opts.code) || '').toUpperCase();
  const titleStr = [jobOrOpts.title, jobOrOpts.filename, jobOrOpts.opts && jobOrOpts.opts.title].filter(Boolean).join(' ');
  const urlStr = String(jobOrOpts.url || (jobOrOpts.opts && (jobOrOpts.opts.url || jobOrOpts.opts.magnet || jobOrOpts.opts.torrentUrl)) || '').toLowerCase();
  const provider = String((jobOrOpts.opts && jobOrOpts.opts.provider) || jobOrOpts.provider || '').toLowerCase();
  const typeStr = String((jobOrOpts.opts && jobOrOpts.opts.type) || jobOrOpts.type || '').toLowerCase();
  const mode = String(jobOrOpts.mode || (jobOrOpts.opts && jobOrOpts.opts.mode) || '').toLowerCase();

  // Explicit Adult signals
  const isAdultCode = codeUpper === 'ADULT' || codeUpper === 'JAV';
  const isAdultType = typeStr === 'jav' || typeStr === 'tube' || !!(jobOrOpts.opts && jobOrOpts.opts.isAdult) || !!jobOrOpts.isAdult;
  const isAdultDomain = adultDomains.some(d => urlStr.includes(d) || provider.includes(d));
  const hasAdultKeywords = /\b(jav|censored|uncensored|hentai|fanza|r18|xvideos|pornhub|spankbang|brazzers|fucktoy|blowjob|creampie|dildo|slut)\b/i.test(titleStr);
  const hasJavCode = !!(extractJavCode(jobOrOpts.title) || extractJavCode(jobOrOpts.filename) || (jobOrOpts.opts && extractJavCode(jobOrOpts.opts.title)));

  // Movie & TV Show signals (Cinema, TV Series, BitTorrent Movie Releases, DDL Direct Movie Resolvers)
  const isMovieCode = ['MOVIE', 'TV_SERIES', 'DDL_DIRECT', 'SWARM'].includes(codeUpper);
  const isMovieMode = mode === 'ddl_direct' || (mode === 'torrent' && codeUpper !== 'MUSIC_ALBUM');
  const isMovieOpt = Boolean(jobOrOpts.isMovieHub || jobOrOpts.isFullMovie || jobOrOpts.imdbId ||
    (jobOrOpts.opts && (jobOrOpts.opts.isMovieHub || jobOrOpts.opts.isFullMovie || jobOrOpts.opts.imdbId || jobOrOpts.opts.pureTitle)));
  const movieDomains = ['yts.mx', 'yts.lt', 'yts.gg', 'apibay.org', 'thepiratebay', '1337x.to', 'strem.io', 'cinemeta'];
  const isMovieDomain = movieDomains.some(d => urlStr.includes(d));
  const movieReleasePattern = /\b(mkvmoviespoint|yts|yify|pahe|psa|rarbg|galaxyrg|tgx|1337x|bluray|bdrip|web[-._]?dl|webrip|hdrip|dvdrip|hdts|hdcam|camrip|telesync|tc|remux|s\d{1,2}e\d{1,2}|s\d{1,2}\b|season\s*\d+|episode\s*\d+|complete\s*(series|season)|dual[\s._-]?audio|multi[\s._-]?audio|hindi|bollywood|hollywood)\b/i;
  const isMovieFilename = movieReleasePattern.test(titleStr);

  // If explicit movie indicators are present and NO explicit adult domain/keywords, prioritize Movies!
  if ((isMovieCode || isMovieMode || isMovieOpt || isMovieDomain || isMovieFilename) && !isAdultDomain && !isAdultType && !isAdultCode && !hasAdultKeywords) {
    return 'movies';
  }

  // 1. Adult & JAV checks
  if (isAdultCode || isAdultType || isAdultDomain || hasJavCode || hasAdultKeywords) {
    return 'adult';
  }

  // 2. Audio & Music checks
  const isAudioMode = ['audio', 'audiophile_flac', 'cdrip'].includes(mode);
  const isAudioCode = ['CD_RIP_1TO1', 'FLAC_MASTER', 'FLAC', 'AUDIO_TRACK', 'MUSIC_ALBUM'].includes(codeUpper);
  const isCdRip = !!((jobOrOpts.opts && jobOrOpts.opts.isCdRip) || jobOrOpts.isCdRip || isAudioCode || mode === 'cdrip');

  const ext = path.extname(jobOrOpts.filePath || jobOrOpts.filename || '').toLowerCase().replace('.', '');
  const audioExts = ['flac', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'alac', 'aiff', 'wma'];
  const isAudioFile = audioExts.includes(ext);

  const musicDomains = ['spotify.com', 'deezer.com', 'tidal.com', 'jiosaavn.com', 'music.apple.com', 'music.youtube.com', 'soundcloud.com', 'bandcamp.com'];
  const isMusicDomain = musicDomains.some(d => urlStr.includes(d));
  const isMusicTrackOpt = !!(jobOrOpts.opts && (jobOrOpts.opts.isMusicTrack || jobOrOpts.opts.trackTitle || jobOrOpts.opts.album));

  if (isAudioMode || isAudioCode || isCdRip || isMusicDomain || isMusicTrackOpt || (isAudioFile && mode !== 'video' && mode !== 'ddl_direct')) {
    return 'music';
  }

  // 3. Movies & TV Shows fallback check
  if (isMovieCode || isMovieMode || isMovieOpt || isMovieDomain || isMovieFilename) {
    return 'movies';
  }

  // 4. Default for generic link downloads (YouTube, social media, web streams, direct URLs)
  return 'links';
}

function finalizeJobPermanentStorage(job) {
  if (!job || !job.filePath || !fs.existsSync(job.filePath)) return;

  const userFolder = (job.downloadFolder && typeof job.downloadFolder === 'string' && job.downloadFolder.trim() && job.downloadFolder.trim() !== '*')
    ? path.resolve(job.downloadFolder.trim())
    : getUserDownloadFolder(job.ownerId);

  if (!userFolder) {
    return;
  }

  try {
    ensureCategorySubfolders(userFolder);

    const category = getJobCategory(job);
    const subfolderName = CATEGORY_SUBFOLDERS[category] || 'Links';
    const baseName = path.basename(userFolder);
    const targetFolder = Object.values(CATEGORY_SUBFOLDERS).includes(baseName)
      ? userFolder
      : path.join(userFolder, subfolderName);

    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
      if (process.platform !== 'win32') {
        try { fs.chmodSync(targetFolder, 0o775); } catch (e) {}
      }
    }

    const currentName = path.basename(job.filePath);
    let targetName = job.filename || currentName;
    if (targetName.startsWith(`${job.id}_`)) {
      targetName = targetName.slice(job.id.length + 1);
    }
    targetName = targetName.replace(/^job_[a-zA-Z0-9]+_[a-zA-Z0-9]+_/, '');
    targetName = targetName.replace(/[\\/:*?"<>|]/g, '_').trim();
    if (!targetName) targetName = `${job.title || 'media'}_${Date.now()}`;

    let destPath = path.join(targetFolder, targetName);
    if (fs.existsSync(destPath) && path.resolve(destPath) !== path.resolve(job.filePath)) {
      const parsed = path.parse(targetName);
      let count = 1;
      while (fs.existsSync(path.join(targetFolder, `${parsed.name} (${count})${parsed.ext}`))) {
        count++;
      }
      targetName = `${parsed.name} (${count})${parsed.ext}`;
      destPath = path.join(targetFolder, targetName);
    }

    if (path.resolve(job.filePath) !== path.resolve(destPath)) {
      fs.copyFileSync(job.filePath, destPath);
      try { fs.unlinkSync(job.filePath); } catch (e) {}
      job.filePath = destPath;
      job.filename = targetName;
    }

    if (process.platform !== 'win32') {
      try { fs.chmodSync(destPath, 0o664); } catch (e) {}
    }

    job.downloadFolder = targetFolder;
    job.isPermanent = true;
    job.logs.push(`📁 Permanent Storage [${subfolderName}]: File saved to assigned user folder: ${destPath}`);
    console.log(`[PermanentStorage] Job ${job.id} (${job.ownerId}) [${subfolderName}] saved to: ${destPath}`);
  } catch (err) {
    console.error(`[PermanentStorage] Error moving job ${job.id} to ${userFolder}:`, err.message);
    job.logs.push(`⚠️ Could not save to permanent user folder (${err.message}). Stored in temp media.`);
  }
}



function generateUserSession(user, rememberMe = true) {
  const token = crypto.randomBytes(32).toString('hex');
  const sess = {
    userId: user.id,
    username: user.username,
    role: user.role || 'premium',
    rememberMe: !!rememberMe,
    createdAt: Date.now()
  };
  userSessions.set(token, sess);
  saveUserSessions();
  return token;
}

function getGuestDailyDownloads(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = guestDailyUsage.get(ip);
  if (!entry || entry.date !== today) {
    return 0;
  }
  return entry.count || 0;
}

function incrementGuestDailyDownloads(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = guestDailyUsage.get(ip);
  if (!entry || entry.date !== today) {
    guestDailyUsage.set(ip, { date: today, count: 1 });
  } else {
    entry.count = (entry.count || 0) + 1;
  }
}

function resolveUserSession(req) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.headers['x-user-token']) {
    token = req.headers['x-user-token'];
  } else if (req.headers['x-admin-token']) {
    token = req.headers['x-admin-token'];
  } else if (req.query && req.query.user_token) {
    token = req.query.user_token;
  } else if (req.query && req.query.admin_token) {
    token = req.query.admin_token;
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  // Admin / Owner token inherits owner role & full premium access
  const adminSess = verifyAdminToken(req);
  if (adminSess) {
    return {
      userId: 'owner',
      username: adminSess.user,
      role: 'owner',
      isPremium: true,
      isOwner: true,
      allowedFolders: ['*']
    };
  }

  if (!token) return null;
  const sess = userSessions.get(token);
  if (!sess) return null;

  const maxAge = (sess.rememberMe !== false) ? (90 * 24 * 60 * 60 * 1000) : (24 * 60 * 60 * 1000);
  if (Date.now() - sess.createdAt > maxAge) {
    userSessions.delete(token);
    saveUserSessions();
    return null;
  }

  const isOwner = sess.role === 'owner' || sess.username?.toLowerCase() === 'sakura';
  const isPrem = isOwner || sess.role === 'premium' || sess.role === 'admin';
  const uRec = users.get(sess.username?.toLowerCase());
  const allowedFolders = isOwner ? ['*'] : (uRec?.allowedFolders || []);
  const resolvedFolder = getUserDownloadFolder(uRec || sess.userId);

  return {
    userId: sess.userId,
    username: sess.username,
    role: isOwner ? 'owner' : (sess.role || 'premium'),
    isPremium: isPrem,
    isOwner: isOwner,
    downloadFolder: resolvedFolder || '',
    allowedFolders: allowedFolders,
    customPermissions: uRec?.customPermissions || null
  };
}

function identifyUser(req, res, next) {
  const sess = resolveUserSession(req);
  if (sess) {
    req.currentUser = sess;
  } else {
    const rawIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';
    const cleanIp = rawIp.replace(/^::ffff:/, '');
    const headerCid = req.headers['x-client-id'] || (req.query && req.query.client_id);
    const guestCid = (headerCid && typeof headerCid === 'string' && headerCid.trim())
      ? headerCid.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
      : null;

    req.currentUser = {
      userId: guestCid ? (guestCid.startsWith('guest_') ? guestCid : `guest_${guestCid}`) : `guest_${cleanIp.replace(/[^a-zA-Z0-9]/g, '_')}`,
      username: 'Guest',
      role: 'guest',
      isPremium: false,
      isOwner: false,
      ip: cleanIp
    };
  }
  next();
}

function requireOwner(req, res, next) {
  if (!req.currentUser || !req.currentUser.isOwner) {
    return res.status(403).json({
      success: false,
      error: 'Access denied: AI features are exclusively reserved for the server owner (Sakura).',
      ownerOnly: true
    });
  }
  next();
}

// ==========================================================================
// Owner AI Engine Endpoints (Powered by Google Gemini Multimodal)
// Strictly guarded by requireOwner middleware
// ==========================================================================

// 1. AI Engine Health & Status
app.get('/api/ai/status', identifyUser, requireOwner, (req, res) => {
  res.json({
    success: true,
    ...aiService.getAiStatus()
  });
});

// 2. AI Media Copilot: Natural Language Intent Parser & Search Resolver
app.post('/api/ai/copilot', identifyUser, requireOwner, async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ success: false, error: 'Query prompt is required' });
    }
    const result = await aiService.parseSearchIntent(prompt.trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. FLAC Checker AI Audiophile Spectrogram Audit
app.post('/api/ai/audit-spectrogram', identifyUser, requireOwner, async (req, res) => {
  try {
    const { imageBase64, metadata } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ success: false, error: 'Spectrogram image data is required' });
    }
    const result = await aiService.auditSpectrogram(imageBase64, metadata || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Dirty Filename & Scene Release Metadata Cleaner
app.post('/api/ai/clean-filename', identifyUser, requireOwner, async (req, res) => {
  try {
    const { filename } = req.body || {};
    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ success: false, error: 'Filename is required' });
    }
    const result = await aiService.cleanDirtyFilename(filename.trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Adult & JAV Hub: Image Recognition for Actress or Code Series
app.post('/api/ai/jav-recognize', identifyUser, requireOwner, async (req, res) => {
  try {
    const { imageBase64, contextText } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ success: false, error: 'Image data is required' });
    }
    const result = await aiService.identifyJavFromImage(imageBase64, contextText || '');
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Adult & JAV Hub: Japanese Title & Synopsis Translation & Cleansing
app.post('/api/ai/jav-translate', identifyUser, requireOwner, async (req, res) => {
  try {
    const { title, synopsis } = req.body || {};
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }
    const result = await aiService.translateAndCleanJavTitle(title.trim(), synopsis || '');
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Video Auto-Subtitles (.srt) Generation via Gemini Native Audio Processing
app.post('/api/ai/generate-subtitles', identifyUser, requireOwner, async (req, res) => {
  try {
    const { jobId, audioBase64, language } = req.body || {};
    let audioData = audioBase64;

    if (!audioData && jobId) {
      const match = findMediaFileByJobId(jobId);
      if (match && match.filePath && fs.existsSync(match.filePath)) {
        // Extract 45s audio snippet with ffmpeg for fast transcription
        const tmpAudio = path.join(TEMP_DIR, `ai_sub_${jobId}_${Date.now()}.mp3`);
        try {
          const ffmpegBin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
          execSync(`"${ffmpegBin}" -y -i "${match.filePath}" -t 120 -vn -ar 16000 -ac 1 -ab 64k "${tmpAudio}"`, { timeout: 20000, stdio: 'ignore' });
          if (fs.existsSync(tmpAudio)) {
            const buf = fs.readFileSync(tmpAudio);
            audioData = `data:audio/mp3;base64,${buf.toString('base64')}`;
            try { fs.unlinkSync(tmpAudio); } catch (e) {}
          }
        } catch (e) {
          try { if (fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio); } catch (e2) {}
        }
      }
    }

    if (!audioData) {
      return res.status(400).json({ success: false, error: 'Audio data or valid jobId is required' });
    }

    const result = await aiService.generateSubtitlesFromAudio(audioData, language || 'en');
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Work In Progress / Maintenance Mode Middleware
function checkMaintenanceMode(req, res, next) {
  if (!engineConfig.maintenanceMode) {
    return next();
  }

  const p = (req.originalUrl || req.url || '').split('?')[0];

  // Only intercept /api routes; static frontend files and pages are never blocked so visitors can view the notice
  if (!p.startsWith('/api')) {
    return next();
  }

  // Exempt specific endpoints required for login, admin operations, health monitoring, and real-time updates
  if (
    p.startsWith('/api/admin') ||
    p.startsWith('/api/auth') ||
    p === '/api/health' ||
    p === '/api/maintenance/status' ||
    p === '/api/jobs/stream'
  ) {
    return next();
  }

  // Check if current user is owner or has valid admin token
  const sess = req.currentUser || resolveUserSession(req);
  if (sess && (sess.isOwner || sess.role === 'owner')) {
    return next();
  }

  return res.status(503).json({
    error: 'Site is currently undergoing maintenance (Work In Progress).',
    maintenance: true,
    message: engineConfig.maintenanceMessage || defaultEngineConfig.maintenanceMessage
  });
}

app.use(checkMaintenanceMode);

// Public Maintenance Status Endpoint
app.get('/api/maintenance/status', (req, res) => {
  res.json({
    maintenance: !!engineConfig.maintenanceMode,
    message: engineConfig.maintenanceMessage || defaultEngineConfig.maintenanceMessage
  });
});

// Auth API Routes
// Auth API Routes - Registration is disabled for public guests
app.post('/api/auth/register', (req, res) => {
  return res.status(403).json({
    error: 'Public account registration is disabled. Guests can apply for user access under About & Privacy, or contact the owner (Sakura).',
    disabled: true
  });
});

// Guest Access Request Application Route
app.post('/api/access-requests', identifyUser, (req, res) => {
  const { username, contact, note, reason } = req.body || {};
  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters long' });
  }
  const cleanUser = username.trim();
  const lowerUser = cleanUser.toLowerCase();

  if (!/^[a-zA-Z0-9_\-]+$/.test(cleanUser)) {
    return res.status(400).json({ error: 'Username may only contain letters, numbers, underscores, and dashes' });
  }

  if (users.has(lowerUser) || lowerUser === 'sakura' || lowerUser === 'admin') {
    return res.status(400).json({ error: 'An account with this username already exists. Please choose a different username.' });
  }

  for (const r of accessRequests.values()) {
    if (r.status === 'pending' && r.username.toLowerCase() === lowerUser) {
      return res.status(400).json({ error: 'An access request for this username is already pending owner review.' });
    }
  }

  const reqId = 'req_' + crypto.randomBytes(8).toString('hex');
  const reqNote = (reason || note || '').trim().slice(0, 500);
  const newRequest = {
    id: reqId,
    username: cleanUser,
    contact: (contact || '').trim().slice(0, 100),
    note: reqNote,
    reason: reqNote,
    ip: req.currentUser.ip || '127.0.0.1',
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  accessRequests.set(reqId, newRequest);
  saveAccessRequests();

  res.status(201).json({
    success: true,
    message: 'Your access application has been submitted to the owner (Sakura). Once approved, you can sign in with your credentials.',
    request: {
      id: newRequest.id,
      username: newRequest.username,
      status: newRequest.status,
      createdAt: newRequest.createdAt
    }
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password, rememberMe } = req.body || {};
  const isRemember = rememberMe !== false;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const cleanUser = username.trim();
  const lowerUser = cleanUser.toLowerCase();

  // Sakura owner / admin login (admin is owner, owner is admin)
  const expectedAdminUser = (process.env.ADMIN_USER || 'sakura').toLowerCase();
  const expectedAdminPass = process.env.ADMIN_PASS || 'Sakura@002';
  const isOwnerOrAdmin = lowerUser === expectedAdminUser || lowerUser === 'sakura' || lowerUser === 'admin';
  if (isOwnerOrAdmin && password === expectedAdminPass) {
    const adminToken = generateAdminToken(process.env.ADMIN_USER || 'sakura', isRemember);
    userSessions.set(adminToken, {
      userId: 'owner',
      username: process.env.ADMIN_USER || 'sakura',
      role: 'owner',
      rememberMe: isRemember,
      createdAt: Date.now()
    });
    saveUserSessions();

    return res.json({
      success: true,
      token: adminToken,
      user: {
        id: 'owner',
        username: process.env.ADMIN_USER || 'sakura',
        role: 'owner',
        isPremium: true,
        isOwner: true,
        features: getRolePermissions('owner')
      }
    });
  }

  const user = users.get(lowerUser);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const testHash = hashPassword(password, user.salt);
  if (testHash !== user.passwordHash) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const isOwner = user.role === 'owner' || lowerUser === 'sakura';
  const token = generateUserSession(user, isRemember);
  const effectiveRole = isOwner ? 'owner' : (user.role || 'premium');
  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      role: effectiveRole,
      isPremium: isOwner || user.role === 'premium' || user.role === 'admin',
      isOwner: isOwner,
      features: getRolePermissions(effectiveRole)
    }
  });
});

app.post('/api/auth/logout', identifyUser, (req, res) => {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.headers['x-user-token']) {
    token = req.headers['x-user-token'];
  }
  if (token && userSessions.has(token)) {
    userSessions.delete(token);
    saveUserSessions();
  }
  res.json({ success: true });
});

app.get('/api/auth/me', identifyUser, (req, res) => {
  const u = req.currentUser;
  const guestCount = u.role === 'guest' ? getGuestDailyDownloads(u.ip) : 0;
  const userFolder = getUserDownloadFolder(u.userId);
  res.json({
    authenticated: u.role !== 'guest',
    maintenance: {
      active: !!engineConfig.maintenanceMode,
      message: engineConfig.maintenanceMessage || defaultEngineConfig.maintenanceMessage
    },
    user: {
      id: u.userId,
      username: u.username,
      role: u.role,
      isPremium: u.isPremium,
      isOwner: u.isOwner || u.role === 'owner',
      downloadFolder: userFolder || (Array.isArray(u.allowedFolders) && u.allowedFolders.length > 0 ? u.allowedFolders[0] : ''),
      allowedFolders: u.allowedFolders || []
    },
    features: getRolePermissions(u),
    limits: {
      isPremium: u.isPremium,
      isOwner: u.isOwner || u.role === 'owner',
      bandwidthCap: resolveUserBandwidthCap(u) || 'Uncapped',
      allowedFolders: u.allowedFolders || [],
      maxDailyDownloads: u.isPremium ? 'unlimited' : 10,
      usedDailyDownloads: guestCount,
      maxBatchUrls: u.isPremium ? 50 : 2,
      maxConcurrent: u.isPremium ? getMaxConcurrentDownloads() : 1,
      allowedResolutions: u.isPremium ? ['best', '4320', '2160', '1440', '1080', '720', '480', '360'] : ['720', '480', '360'],
      allowedAudioFormats: u.isPremium ? ['mp3', 'flac', 'm4a', 'opus', 'wav'] : ['mp3', 'm4a', 'opus']
    }
  });
});

// Admin Role-Based Feature Permissions Endpoints
app.get('/api/admin/role-permissions', requireAdmin, (req, res) => {
  res.json({
    success: true,
    features: FEATURE_METADATA,
    permissions: rolePermissions
  });
});

app.post('/api/admin/role-permissions', requireAdmin, (req, res) => {
  const { permissions } = req.body || {};
  if (!permissions || typeof permissions !== 'object') {
    return res.status(400).json({ error: 'Valid permissions object required' });
  }

  const validRoles = ['guest', 'user', 'premium'];
  const validKeys = FEATURE_METADATA.map(f => f.key);

  for (const r of validRoles) {
    if (permissions[r] && typeof permissions[r] === 'object') {
      for (const k of validKeys) {
        if (typeof permissions[r][k] === 'boolean') {
          rolePermissions[r][k] = permissions[r][k];
        }
      }
    }
  }

  saveRolePermissions();
  res.json({
    success: true,
    message: 'Role permissions successfully updated and saved',
    permissions: rolePermissions
  });
});

app.post('/api/admin/role-permissions/reset', requireAdmin, (req, res) => {
  rolePermissions = JSON.parse(JSON.stringify(DEFAULT_ROLE_PERMISSIONS));
  saveRolePermissions();
  res.json({
    success: true,
    message: 'Role permissions reset to factory defaults',
    permissions: rolePermissions
  });
});

// Admin User Management Endpoints
app.get('/api/admin/users', requireAdmin, (req, res) => {
  ensureOwnerAccount();
  const list = Array.from(users.values()).map(u => {
    const isOwner = u.role === 'owner' || u.id === 'owner_sakura' || (u.username && u.username.toLowerCase() === 'sakura');
    const userPass = u.password || (isOwner ? (process.env.ADMIN_PASS || 'Sakura@002') : '');
    const effectivePerms = getUserPermissions(u);
    const customCap = (engineConfig.bandwidthCaps && engineConfig.bandwidthCaps.customUserLimits && (engineConfig.bandwidthCaps.customUserLimits[u.id] || engineConfig.bandwidthCaps.customUserLimits[u.username])) || null;
    return {
      id: u.id,
      username: u.username,
      role: u.role || 'premium',
      password: userPass,
      hasPassword: !!userPass,
      downloadFolder: u.downloadFolder || (Array.isArray(u.allowedFolders) && u.allowedFolders.length > 0 ? u.allowedFolders[0] : ''),
      allowedFolders: u.allowedFolders || [],
      customPermissions: u.customPermissions || null,
      hasCustomPermissions: !!(u.customPermissions && Object.keys(u.customPermissions).length > 0),
      effectivePermissions: effectivePerms,
      bandwidthCap: customCap,
      effectiveBandwidthCap: isOwner ? 'Uncapped' : (resolveUserBandwidthCap(u) || 'Default'),
      createdAt: u.createdAt
    };
  });
  res.json({ success: true, users: list });
});

// Get Single User Individual Feature Permissions (Owner & Admin)
app.get('/api/admin/users/:id/permissions', requireAdmin, (req, res) => {
  const id = req.params.id;
  let targetUser = null;
  for (const u of users.values()) {
    if (u.id === id || (u.username && u.username.toLowerCase() === id.toLowerCase())) {
      targetUser = u;
      break;
    }
  }

  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }

  const isOwner = targetUser.role === 'owner' || targetUser.id === 'owner_sakura' || (targetUser.username && targetUser.username.toLowerCase() === 'sakura');
  const role = (targetUser.role || 'user').toLowerCase();
  const rolePerms = rolePermissions[role] || rolePermissions['guest'] || DEFAULT_ROLE_PERMISSIONS.guest;
  const effectivePerms = getUserPermissions(targetUser);

  res.json({
    success: true,
    user: {
      id: targetUser.id,
      username: targetUser.username,
      role: targetUser.role || 'user',
      isOwner,
      hasCustomPermissions: !!(targetUser.customPermissions && Object.keys(targetUser.customPermissions).length > 0),
      customPermissions: targetUser.customPermissions || null,
      rolePermissions: rolePerms,
      effectivePermissions: effectivePerms
    },
    features: FEATURE_METADATA
  });
});

// Update or Reset Single User Individual Feature Permissions (Owner & Admin)
app.post('/api/admin/users/permissions', requireAdmin, (req, res) => {
  const { id, permissions, resetToRole } = req.body || {};
  if (!id) return res.status(400).json({ error: 'User ID or username is required' });

  let targetUser = null;
  for (const u of users.values()) {
    if (u.id === id || (u.username && u.username.toLowerCase() === id.toLowerCase())) {
      targetUser = u;
      break;
    }
  }

  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }

  const isOwner = targetUser.role === 'owner' || targetUser.id === 'owner_sakura' || (targetUser.username && targetUser.username.toLowerCase() === 'sakura');
  if (isOwner) {
    return res.status(400).json({ error: 'The Owner account has universal root permissions and cannot be constrained.' });
  }

  if (resetToRole) {
    delete targetUser.customPermissions;
    saveUsers();
    return res.json({
      success: true,
      message: `Permissions for "${targetUser.username}" reset to ${targetUser.role.toUpperCase()} role defaults.`,
      user: {
        id: targetUser.id,
        username: targetUser.username,
        hasCustomPermissions: false,
        customPermissions: null,
        effectivePermissions: getUserPermissions(targetUser)
      }
    });
  }

  if (!permissions || typeof permissions !== 'object') {
    return res.status(400).json({ error: 'Valid permissions object is required' });
  }

  const validKeys = FEATURE_METADATA.map(f => f.key);
  const cleanPermissions = {};
  for (const k of validKeys) {
    if (typeof permissions[k] === 'boolean') {
      cleanPermissions[k] = permissions[k];
    }
  }

  targetUser.customPermissions = cleanPermissions;
  saveUsers();

  res.json({
    success: true,
    message: `Individual permissions for "${targetUser.username}" successfully updated!`,
    user: {
      id: targetUser.id,
      username: targetUser.username,
      hasCustomPermissions: true,
      customPermissions: cleanPermissions,
      effectivePermissions: getUserPermissions(targetUser)
    }
  });
});

// Get User Current Password (Owner & Admin)
app.get('/api/admin/users/:id/password', requireAdmin, (req, res) => {
  const id = req.params.id;
  let targetUser = null;
  for (const u of users.values()) {
    if (u.id === id || (u.username && u.username.toLowerCase() === id.toLowerCase())) {
      targetUser = u;
      break;
    }
  }

  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }

  const isOwner = targetUser.role === 'owner' || targetUser.id === 'owner_sakura' || (targetUser.username && targetUser.username.toLowerCase() === 'sakura');
  const userPass = targetUser.password || (isOwner ? (process.env.ADMIN_PASS || 'Sakura@002') : '');

  res.json({
    success: true,
    id: targetUser.id,
    username: targetUser.username,
    password: userPass,
    hasPassword: !!userPass
  });
});

// Change User Password (Owner & Admin)
app.post('/api/admin/users/password', requireAdmin, (req, res) => {
  const { id, password } = req.body || {};
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'User ID is required' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }

  const cleanPassword = password.trim();

  let targetUser = null;
  for (const u of users.values()) {
    if (u.id === id || (u.username && u.username.toLowerCase() === id.toLowerCase())) {
      targetUser = u;
      break;
    }
  }

  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }

  const isOwner = targetUser.role === 'owner' || targetUser.id === 'owner_sakura' || (targetUser.username && targetUser.username.toLowerCase() === 'sakura');

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(cleanPassword, salt);

  targetUser.salt = salt;
  targetUser.passwordHash = passwordHash;
  targetUser.password = cleanPassword;

  saveUsers();

  if (isOwner) {
    process.env.ADMIN_PASS = cleanPassword;
    try {
      const envPath = path.join(__dirname, '.env');
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
      envMap.set('ADMIN_PASS', cleanPassword);
      let newContent = '';
      for (const [k, v] of envMap.entries()) {
        newContent += `${k}=${v}\n`;
      }
      fs.writeFileSync(envPath, newContent, 'utf8');
    } catch (e) {
      console.warn('[Admin] Failed to update ADMIN_PASS in .env:', e.message);
    }
  }

  if (!isOwner) {
    for (const [token, sess] of userSessions.entries()) {
      if (sess.userId === targetUser.id || (sess.username && sess.username.toLowerCase() === targetUser.username.toLowerCase())) {
        userSessions.delete(token);
      }
    }
    saveUserSessions();
  }

  res.json({
    success: true,
    message: `Password for "${targetUser.username}" successfully changed.`,
    user: {
      id: targetUser.id,
      username: targetUser.username,
      password: targetUser.password
    }
  });
});

app.post('/api/admin/users/role', requireAdmin, (req, res) => {
  const { id, role } = req.body || {};
  if (!id || !role) return res.status(400).json({ error: 'User ID and role are required' });
  for (const u of users.values()) {
    if (u.id === id) {
      if (u.role === 'owner' || u.username.toLowerCase() === 'sakura') {
        return res.status(403).json({ error: 'Cannot modify role of the owner account' });
      }
      u.role = role;
      saveUsers();
      return res.json({ success: true, user: { id: u.id, username: u.username, role: u.role } });
    }
  }
  res.status(404).json({ error: 'User not found' });
});

// Assign or Clear Permanent User Download Folder (Owner & Admin)
app.post('/api/admin/users/folder', requireAdmin, (req, res) => {
  const { id, downloadFolder } = req.body || {};
  if (!id) return res.status(400).json({ error: 'User ID or username is required' });

  for (const u of users.values()) {
    if (u.id === id || u.username.toLowerCase() === id.toLowerCase()) {
      let cleanFolder = (downloadFolder || '').trim();
      if (cleanFolder) {
        cleanFolder = path.resolve(cleanFolder);
        try {
          if (!fs.existsSync(cleanFolder)) {
            fs.mkdirSync(cleanFolder, { recursive: true });
          }
        } catch (e) {
          return res.status(400).json({ error: `Cannot create directory "${cleanFolder}": ${e.message}` });
        }
        ensureCategorySubfolders(cleanFolder);
      }

      u.downloadFolder = cleanFolder;
      u.allowedFolders = Array.isArray(u.allowedFolders) ? u.allowedFolders : [];
      if (cleanFolder && !u.allowedFolders.includes(cleanFolder)) {
        u.allowedFolders.push(cleanFolder);
      }
      saveUsers();
      return res.json({
        success: true,
        message: cleanFolder
          ? `Assigned permanent download folder updated to: ${cleanFolder}`
          : 'Custom download folder cleared. User will use default storage.',
        downloadFolder: cleanFolder,
        user: { id: u.id, username: u.username, downloadFolder: cleanFolder }
      });
    }
  }
  res.status(404).json({ error: 'User not found' });
});

// Set or Clear Individual User Bandwidth Limit (Owner & Admin)
app.post('/api/admin/users/:id/bandwidth', requireAdmin, (req, res) => {
  try {
    const targetId = req.params.id;
    const { limit } = req.body || {};
    if (!engineConfig.bandwidthCaps) {
      engineConfig.bandwidthCaps = { ...defaultEngineConfig.bandwidthCaps };
    }
    if (!engineConfig.bandwidthCaps.customUserLimits) {
      engineConfig.bandwidthCaps.customUserLimits = {};
    }

    if (!limit || limit === 'default' || limit === 'auto' || limit === 'none' || limit === 'reset') {
      delete engineConfig.bandwidthCaps.customUserLimits[targetId];
      saveEngineConfig();
      return res.json({
        success: true,
        userId: targetId,
        bandwidthCap: null,
        message: 'Custom bandwidth limit cleared. User will follow role policy.'
      });
    }

    const normalized = normalizeBandwidthString(limit);
    engineConfig.bandwidthCaps.customUserLimits[targetId] = normalized;
    saveEngineConfig();
    return res.json({
      success: true,
      userId: targetId,
      bandwidthCap: normalized,
      message: `Bandwidth limit for user set to ${normalized}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  for (const [key, u] of users.entries()) {
    if (u.id === id) {
      if (u.role === 'owner' || u.username.toLowerCase() === 'sakura') {
        return res.status(403).json({ error: 'Cannot delete the owner account' });
      }
      users.delete(key);
      saveUsers();
      for (const [t, s] of userSessions.entries()) {
        if (s.userId === id) userSessions.delete(t);
      }
      saveUserSessions();
      return res.json({ success: true });
    }
  }
  res.status(404).json({ error: 'User not found' });
});

// Admin Direct User Creation Endpoint (Owner creates accounts)
app.post('/api/admin/users/create', requireAdmin, (req, res) => {
  const { username, password, role, downloadFolder } = req.body || {};
  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters long' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }

  const cleanUser = username.trim();
  const lowerUser = cleanUser.toLowerCase();

  if (!/^[a-zA-Z0-9_\-]+$/.test(cleanUser)) {
    return res.status(400).json({ error: 'Username may only contain letters, numbers, underscores, and dashes' });
  }

  if (users.has(lowerUser) || lowerUser === 'sakura' || lowerUser === 'admin') {
    return res.status(400).json({ error: 'Username is already taken' });
  }

  let cleanFolder = (downloadFolder || '').trim();
  if (cleanFolder) {
    cleanFolder = path.resolve(cleanFolder);
    try {
      if (!fs.existsSync(cleanFolder)) fs.mkdirSync(cleanFolder, { recursive: true });
    } catch (e) {}
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const newUser = {
    id: 'u_' + crypto.randomBytes(8).toString('hex'),
    username: cleanUser,
    password: password,
    passwordHash,
    salt,
    role: role === 'user' ? 'user' : 'premium',
    downloadFolder: cleanFolder || '',
    createdAt: Date.now()
  };

  users.set(lowerUser, newUser);
  saveUsers();

  res.json({
    success: true,
    message: `User account "${cleanUser}" created successfully!`,
    user: {
      id: newUser.id,
      username: newUser.username,
      role: newUser.role,
      downloadFolder: newUser.downloadFolder,
      createdAt: newUser.createdAt
    }
  });
});

// Admin Access Requests Management Endpoints
app.get('/api/admin/access-requests', requireAdmin, (req, res) => {
  const list = Array.from(accessRequests.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ success: true, requests: list });
});

app.post('/api/admin/access-requests/:id/approve', requireAdmin, (req, res) => {
  const id = req.params.id;
  const request = accessRequests.get(id);
  if (!request) {
    return res.status(404).json({ error: 'Access request not found' });
  }

  const { password, role, downloadFolder } = req.body || {};
  const userPassword = password && password.length >= 6 ? password : ('User_' + crypto.randomBytes(4).toString('hex'));
  const userRole = role === 'user' ? 'user' : 'premium';
  const cleanUser = request.username;
  const lowerUser = cleanUser.toLowerCase();

  if (users.has(lowerUser) || lowerUser === 'sakura' || lowerUser === 'admin') {
    return res.status(400).json({ error: `Username "${cleanUser}" is already taken by an existing account.` });
  }

  let cleanFolder = (downloadFolder || '').trim();
  if (cleanFolder) {
    cleanFolder = path.resolve(cleanFolder);
    try {
      if (!fs.existsSync(cleanFolder)) fs.mkdirSync(cleanFolder, { recursive: true });
    } catch (e) {}
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(userPassword, salt);
  const newUser = {
    id: 'u_' + crypto.randomBytes(8).toString('hex'),
    username: cleanUser,
    password: userPassword,
    passwordHash,
    salt,
    role: userRole,
    downloadFolder: cleanFolder || '',
    createdAt: Date.now()
  };

  users.set(lowerUser, newUser);
  saveUsers();

  request.status = 'approved';
  request.assignedPassword = userPassword;
  request.assignedFolder = cleanFolder || '';
  request.approvedAt = Date.now();
  request.updatedAt = Date.now();
  saveAccessRequests();

  res.json({
    success: true,
    message: `Account "${cleanUser}" approved and created successfully!`,
    user: {
      id: newUser.id,
      username: newUser.username,
      role: newUser.role,
      downloadFolder: newUser.downloadFolder,
      initialPassword: userPassword
    }
  });
});

app.post('/api/admin/access-requests/:id/reject', requireAdmin, (req, res) => {
  const id = req.params.id;
  const request = accessRequests.get(id);
  if (!request) {
    return res.status(404).json({ error: 'Access request not found' });
  }
  request.status = 'rejected';
  request.updatedAt = Date.now();
  saveAccessRequests();
  res.json({ success: true, message: `Access request for "${request.username}" marked as rejected.` });
});

app.delete('/api/admin/access-requests/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  if (!accessRequests.has(id)) {
    return res.status(404).json({ error: 'Access request not found' });
  }
  accessRequests.delete(id);
  saveAccessRequests();
  res.json({ success: true });
});

// ==========================================================================
// System Drive Discovery & User Folder Allocation (Owner Controlled)
// ==========================================================================
function getSystemDrives() {
  const drives = [];
  const seenPaths = new Set();

  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    for (const letter of letters) {
      const root = `${letter}:\\`;
      try {
        if (fs.existsSync(root)) {
          drives.push({
            id: root,
            path: root,
            name: `Drive (${letter}:)`,
            label: `Local Disk (${letter}:)`,
            total: '',
            free: '',
            type: 'drive'
          });
        }
      } catch (e) {}
    }
  } else {
    // Linux / Unix: discover real mount points from active df table
    try {
      const dfOutput = execSync('df -BG -P', { timeout: 3000 }).toString().trim().split('\n');
      for (let i = 1; i < dfOutput.length; i++) {
        const line = dfOutput[i].trim();
        if (!line) continue;
        const parts = line.split(/\s+/);
        if (parts.length >= 6) {
          const fsName = parts[0];
          const total = parts[1];
          const used = parts[2];
          const avail = parts[3];
          const pct = parts[4];
          const mountPoint = parts[5];

          if (
            mountPoint.startsWith('/proc') ||
            mountPoint.startsWith('/sys') ||
            mountPoint.startsWith('/dev') ||
            mountPoint.startsWith('/run') ||
            mountPoint.startsWith('/var/lib/docker') ||
            fsName.startsWith('tmpfs') ||
            fsName.startsWith('devtmpfs') ||
            fsName.startsWith('none') ||
            fsName.startsWith('udev')
          ) {
            continue;
          }

          if (!seenPaths.has(mountPoint) && fs.existsSync(mountPoint)) {
            seenPaths.add(mountPoint);
            let friendlyName = mountPoint === '/' ? 'Root (/) [System SSD]' : mountPoint;
            if (mountPoint.startsWith('/media/')) {
              friendlyName = `Drive: ${path.basename(mountPoint).toUpperCase()} (${mountPoint})`;
            } else if (mountPoint.startsWith('/mnt/')) {
              friendlyName = `Mount: ${path.basename(mountPoint)} (${mountPoint})`;
            }
            drives.push({
              id: mountPoint,
              path: mountPoint,
              name: friendlyName,
              label: `${friendlyName} — ${avail} free of ${total}`,
              total,
              free: avail,
              used,
              percentUsed: pct
            });
          }
        }
      }
    } catch (e) {}

    // Check /media and /mnt subdirectories
    for (const base of ['/media', '/mnt']) {
      try {
        if (fs.existsSync(base)) {
          const subs = fs.readdirSync(base, { withFileTypes: true });
          for (const s of subs) {
            if (s.isDirectory() && !s.name.startsWith('.')) {
              const full = path.join(base, s.name);
              if (!seenPaths.has(full)) {
                seenPaths.add(full);
                drives.push({
                  id: full,
                  path: full,
                  name: `Drive: ${s.name.toUpperCase()} (${full})`,
                  label: `Drive: ${s.name.toUpperCase()} (${full})`,
                  total: '',
                  free: ''
                });
              }
            }
          }
        }
      } catch (e) {}
    }
  }

  if (drives.length === 0) {
    const root = process.platform === 'win32' ? 'C:\\' : '/';
    drives.push({
      id: root,
      path: root,
      name: 'Primary System Drive',
      label: root,
      total: '',
      free: ''
    });
  }

  return drives;
}

function getDriveFolders(drivePath, subDir = '') {
  if (!drivePath) return { error: 'Drive path is required', folders: [] };
  const cleanDrive = path.normalize(drivePath);
  const target = subDir ? path.resolve(cleanDrive, subDir) : cleanDrive;

  if (!target.startsWith(cleanDrive) && cleanDrive !== '/') {
    return { error: 'Invalid path navigation', folders: [] };
  }

  if (!fs.existsSync(target)) {
    return { error: 'Path does not exist', folders: [], currentPath: target, drivePath: cleanDrive };
  }

  try {
    const entries = fs.readdirSync(target, { withFileTypes: true });
    const folders = [];
    const EXCLUDED_DIRS = new Set([
      'lost+found', '$RECYCLE.BIN', 'System Volume Information',
      'proc', 'sys', 'dev', 'run', '.git', 'node_modules'
    ]);

    for (const ent of entries) {
      if (ent.isDirectory() && !ent.name.startsWith('.') && !EXCLUDED_DIRS.has(ent.name)) {
        const full = path.join(target, ent.name);
        let hasSub = false;
        try {
          const children = fs.readdirSync(full, { withFileTypes: true });
          hasSub = children.some(c => c.isDirectory() && !c.name.startsWith('.'));
        } catch (e) {}

        folders.push({
          name: ent.name,
          path: full,
          hasSubfolders: hasSub
        });
      }
    }

    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const parentPath = target !== cleanDrive ? path.dirname(target) : null;

    return {
      success: true,
      drivePath: cleanDrive,
      currentPath: target,
      parentPath: parentPath && (parentPath.startsWith(cleanDrive) || cleanDrive === '/') ? parentPath : null,
      folders
    };
  } catch (err) {
    return { error: `Cannot read directory: ${err.message}`, folders: [], currentPath: target, drivePath: cleanDrive };
  }
}

// Admin Drive & Folder Allocation Endpoints
app.get('/api/admin/system-drives', requireAdmin, (req, res) => {
  try {
    const drives = getSystemDrives();
    res.json({ success: true, drives });
  } catch (err) {
    res.status(500).json({ error: `Failed to detect drives: ${err.message}` });
  }
});

app.get('/api/admin/drive-folders', requireAdmin, (req, res) => {
  const { drive, subDir } = req.query;
  if (!drive) {
    return res.status(400).json({ error: 'drive parameter is required' });
  }
  const result = getDriveFolders(String(drive), subDir ? String(subDir) : '');
  if (result.error) {
    return res.status(400).json({ error: result.error, folders: [] });
  }
  res.json({ success: true, ...result });
});

app.post('/api/admin/drive-folders/create', requireAdmin, (req, res) => {
  const { drive, subDir, folderName } = req.body || {};
  if (!drive || !folderName || typeof folderName !== 'string') {
    return res.status(400).json({ error: 'drive and folderName are required' });
  }
  const cleanName = folderName.trim().replace(/[<>:"/\\|?*]/g, '_');
  if (!cleanName) {
    return res.status(400).json({ error: 'Invalid folder name' });
  }
  const cleanDrive = path.normalize(drive);
  const parent = subDir ? path.resolve(cleanDrive, subDir) : cleanDrive;
  const target = path.join(parent, cleanName);
  try {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }
    const result = getDriveFolders(cleanDrive, subDir ? String(subDir) : '');
    res.json({ success: true, message: `Folder "${cleanName}" created`, createdPath: target, ...result });
  } catch (err) {
    res.status(500).json({ error: `Failed to create folder: ${err.message}` });
  }
});

app.get('/api/admin/users/:id/folders', requireAdmin, (req, res) => {
  const id = req.params.id;
  for (const u of users.values()) {
    if (u.id === id) {
      return res.json({ success: true, userId: u.id, username: u.username, allowedFolders: u.allowedFolders || [] });
    }
  }
  res.status(404).json({ error: 'User not found' });
});

app.post('/api/admin/users/:id/folders', requireAdmin, (req, res) => {
  const id = req.params.id;
  const { folders } = req.body || {};
  if (!Array.isArray(folders)) {
    return res.status(400).json({ error: 'Folders must be an array of folder paths' });
  }
  for (const u of users.values()) {
    if (u.id === id || u.username.toLowerCase() === id.toLowerCase()) {
      u.allowedFolders = Array.from(new Set(folders.map(f => String(f).trim()).filter(Boolean)));
      if (u.allowedFolders.length > 0) {
        const first = u.allowedFolders.find(f => f && f !== '*');
        if (first) {
          u.downloadFolder = first;
          ensureCategorySubfolders(first);
        }
      }
      saveUsers();
      return res.json({
        success: true,
        message: `Allocated ${u.allowedFolders.length} folder(s) to "${u.username}". Category subfolders (Movies and Shows, Music, Adult, Links) configured.`,
        allowedFolders: u.allowedFolders,
        downloadFolder: u.downloadFolder,
        subfolders: Object.values(CATEGORY_SUBFOLDERS)
      });
    }
  }
  res.status(404).json({ error: 'User not found' });
});

// User Allocated Folders API & File Move/Save
app.get('/api/user/allocated-folders', identifyUser, (req, res) => {
  const u = req.currentUser;
  if (!u || u.role === 'guest') {
    return res.status(401).json({ error: 'Authentication required' });
  }
  let folders = u.allowedFolders || [];
  if (u.isOwner) {
    folders = getSystemDrives().map(d => d.path);
  }
  res.json({ success: true, isOwner: u.isOwner, folders });
});

// User Assign Own Download Folder API (Owner & Authenticated Members)
app.post('/api/user/download-folder', identifyUser, (req, res) => {
  const u = req.currentUser;
  if (!u || u.role === 'guest') {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { downloadFolder } = req.body || {};
  let cleanFolder = (downloadFolder || '').trim();

  // Find user record in users map
  let userRecord = null;
  for (const record of users.values()) {
    if (record.id === u.userId || (record.username && record.username.toLowerCase() === (u.username || '').toLowerCase())) {
      userRecord = record;
      break;
    }
  }

  if (!userRecord) {
    return res.status(404).json({ error: 'User account not found' });
  }

  if (cleanFolder) {
    cleanFolder = path.resolve(cleanFolder);

    // If not owner, verify folder permission
    if (!u.isOwner && !isFeatureAllowed(u, 'custom_storage')) {
      return res.status(403).json({ error: 'Custom folder storage is not enabled for your account' });
    }

    if (!u.isOwner) {
      const allowed = (userRecord.allowedFolders || []).map(f => path.resolve(f));
      const isPermitted = allowed.some(a => cleanFolder === a || cleanFolder.startsWith(a + path.sep));
      if (!isPermitted) {
        return res.status(403).json({ error: 'Selected folder is outside your permitted storage allocations' });
      }
    }

    try {
      if (!fs.existsSync(cleanFolder)) {
        fs.mkdirSync(cleanFolder, { recursive: true });
        if (process.platform !== 'win32') {
          try { fs.chmodSync(cleanFolder, 0o775); } catch (e) {}
        }
      }
    } catch (e) {
      return res.status(400).json({ error: `Cannot access or create directory "${cleanFolder}": ${e.message}` });
    }

    // Ensure 3 category subfolders exist
    ensureCategorySubfolders(cleanFolder);
  }

  userRecord.downloadFolder = cleanFolder;
  if (cleanFolder) {
    userRecord.allowedFolders = Array.isArray(userRecord.allowedFolders) ? userRecord.allowedFolders : [];
    if (!userRecord.allowedFolders.includes(cleanFolder)) {
      userRecord.allowedFolders.push(cleanFolder);
    }
  }
  saveUsers();

  // Update in-memory session user if present
  u.downloadFolder = cleanFolder;

  return res.json({
    success: true,
    message: cleanFolder
      ? `Permanent storage assigned: ${cleanFolder}`
      : 'Permanent storage cleared. Using temporary storage.',
    downloadFolder: cleanFolder,
    subfolders: Object.values(CATEGORY_SUBFOLDERS)
  });
});

app.post('/api/jobs/:id/save-to-folder', identifyUser, (req, res) => {
  const u = req.currentUser;
  if (!u || u.role === 'guest') {
    return res.status(401).json({ error: 'Authentication required to save to server storage' });
  }
  const jobId = req.params.id;
  const { folderPath } = req.body || {};
  if (!folderPath || typeof folderPath !== 'string') {
    return res.status(400).json({ error: 'Destination folderPath is required' });
  }

  const targetDir = path.normalize(folderPath.trim());

  if (!u.isOwner) {
    const userFolders = (u.allowedFolders || []).map(f => path.normalize(f));
    const isAllowed = userFolders.some(f => targetDir === f || targetDir.startsWith(f + path.sep));
    if (!isAllowed) {
      return res.status(403).json({ error: 'Access denied: You are not authorized to write to this folder' });
    }
  }

  const job = jobs.get(jobId);
  let sourceFile = job ? job.filePath : null;
  if (!sourceFile || !fs.existsSync(sourceFile)) {
    const candidates = [
      path.join(TEMP_DIR, `${jobId}_${job?.fileName || ''}`),
      path.join(TEMP_DIR, job?.fileName || '')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) { sourceFile = c; break; }
    }
  }

  if (!sourceFile || !fs.existsSync(sourceFile)) {
    return res.status(404).json({ error: 'Source media file not found on server storage' });
  }

  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const destFileName = path.basename(sourceFile);
    const destPath = path.join(targetDir, destFileName);
    fs.copyFileSync(sourceFile, destPath);

    res.json({
      success: true,
      message: `File successfully saved to ${destPath}`,
      destination: destPath,
      folder: targetDir,
      filename: destFileName
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to save file to destination: ${err.message}` });
  }
});

// Helper: FLAC storage directories on server (only temporary staging cache directories)
function getFlacStorageDirs() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const candidateDirs = [
    TEMP_DIR,
    path.join(__dirname, 'temp_media'),
    path.join(homeDir, 'slskd_downloads'),
    path.join(homeDir, 'OrpheusDL', 'downloads')
  ];
  return candidateDirs.filter(d => Boolean(d) && !isPermanentUserDirectory(d));
}

function scanFlacFiles() {
  const dirs = getFlacStorageDirs();
  const results = [];
  const seen = new Set();

  function scanDir(dir, maxDepth = 2, currentDepth = 0) {
    if (!dir || !fs.existsSync(dir) || isPermanentUserDirectory(dir) || currentDepth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.flac')) {
          if (isPermanentUserFile(fullPath)) continue;
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
          if (!isPermanentUserDirectory(fullPath)) {
            scanDir(fullPath, maxDepth, currentDepth + 1);
          }
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
      activePaths.add(path.resolve(j.filePath));
    }
  }

  const allFlacs = scanFlacFiles();
  let deletedCount = 0;
  let freedBytes = 0;

  for (const f of allFlacs) {
    if (!f.filePath || isPermanentUserFile(f.filePath)) {
      continue; // Strictly preserve permanent files
    }

    const resolvedFile = path.resolve(f.filePath);
    if (!activePaths.has(resolvedFile)) {
      let deleted = false;
      try {
        if (!isPermanentUserFile(resolvedFile)) {
          fs.unlinkSync(resolvedFile);
          deleted = true;
        }
      } catch (err) {
        if (process.platform !== 'win32') {
          try {
            if (!isPermanentUserFile(resolvedFile)) {
              execSync(`rm -f "${resolvedFile}"`, { stdio: 'ignore' });
              deleted = true;
            }
          } catch (e) {
            try {
              if (!isPermanentUserFile(resolvedFile)) {
                execSync(`echo 'sakura' | sudo -S -p '' rm -f "${resolvedFile}"`, { stdio: 'ignore' });
                deleted = true;
              }
            } catch (e2) {}
          }
        }
      }

      if (deleted) {
        deletedCount++;
        freedBytes += f.sizeBytes;
        try {
          const parent = path.dirname(resolvedFile);
          if (!isPermanentUserDirectory(parent) && fs.readdirSync(parent).length === 0) {
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
      if (fs.existsSync(targetDir) && !isPermanentUserDirectory(targetDir)) {
        try {
          const files = fs.readdirSync(targetDir);
          for (const f of files) {
            const full = path.join(targetDir, f);
            if (isPermanentUserFile(full)) continue;

            if (f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.temp') || targetDir.includes('incomplete')) {
              let isCurrent = false;
              for (const act of activeFiles) {
                if (f.includes(act)) isCurrent = true;
              }
              if (!isCurrent) {
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
  const gemKey = process.env.GEMINI_API_KEY || '';
  res.json({
    deezerArl: arl ? (arl.slice(0, 8) + '...' + arl.slice(-6)) : '',
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
    spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET ? '••••••••••••••••' : '',
    geminiApiKey: gemKey ? (gemKey.slice(0, 6) + '...' + gemKey.slice(-4)) : '',
    hasGeminiKey: !!gemKey,
    adminUser: process.env.ADMIN_USER || 'sakura'
  });
});

// 8. Update Creds & Persist to .env
app.post('/api/admin/creds', requireAdmin, (req, res) => {
  try {
    const { deezerArl, spotifyClientId, spotifyClientSecret, geminiApiKey, adminUser, adminPass } = req.body || {};

    if (deezerArl && !deezerArl.includes('...') && !deezerArl.includes('•')) {
      process.env.DEEZER_ARL = deezerArl.trim();
    }
    if (spotifyClientId) {
      process.env.SPOTIFY_CLIENT_ID = spotifyClientId.trim();
    }
    if (spotifyClientSecret && !spotifyClientSecret.includes('••')) {
      process.env.SPOTIFY_CLIENT_SECRET = spotifyClientSecret.trim();
    }
    if (geminiApiKey && !geminiApiKey.includes('...') && !geminiApiKey.includes('•')) {
      process.env.GEMINI_API_KEY = geminiApiKey.trim();
    }
    if (adminUser) {
      process.env.ADMIN_USER = adminUser.trim();
    }
    if (adminPass) {
      process.env.ADMIN_PASS = adminPass.trim();
      const currentToken = req.headers['authorization']?.replace('Bearer ', '').trim() || req.headers['x-admin-token'];
      for (const t of adminSessions.keys()) {
        if (t !== currentToken) adminSessions.delete(t);
      }
      saveAdminSessions();
    }
    ensureOwnerAccount();

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
      if (process.env.GEMINI_API_KEY) envMap.set('GEMINI_API_KEY', process.env.GEMINI_API_KEY);
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
    if (typeof updates.maintenanceMode === 'boolean') {
      engineConfig.maintenanceMode = updates.maintenanceMode;
    }
    if (typeof updates.maintenanceMessage === 'string' && updates.maintenanceMessage.trim()) {
      engineConfig.maintenanceMessage = updates.maintenanceMessage.trim();
    }
    if (updates.features && typeof updates.features === 'object') {
      engineConfig.features = {
        ...engineConfig.features,
        ...updates.features
      };
    }
    if (updates.bandwidthCaps && typeof updates.bandwidthCaps === 'object') {
      const bwc = updates.bandwidthCaps;
      if (!engineConfig.bandwidthCaps) {
        engineConfig.bandwidthCaps = { ...defaultEngineConfig.bandwidthCaps };
      }
      if (typeof bwc.enabled === 'boolean') engineConfig.bandwidthCaps.enabled = bwc.enabled;
      if (bwc.guestLimit !== undefined) engineConfig.bandwidthCaps.guestLimit = normalizeBandwidthString(bwc.guestLimit);
      if (bwc.userLimit !== undefined) engineConfig.bandwidthCaps.userLimit = normalizeBandwidthString(bwc.userLimit);
      if (bwc.premiumLimit !== undefined) engineConfig.bandwidthCaps.premiumLimit = normalizeBandwidthString(bwc.premiumLimit);
      if (bwc.customUserLimits && typeof bwc.customUserLimits === 'object') {
        engineConfig.bandwidthCaps.customUserLimits = {
          ...(engineConfig.bandwidthCaps.customUserLimits || {}),
          ...bwc.customUserLimits
        };
      }
    }
    saveEngineConfig();
    broadcastMaintenanceUpdate();
    res.json({ success: true, config: engineConfig, message: 'Engine configuration updated and saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12.1 Dedicated Maintenance Mode (Work In Progress) APIs
app.get('/api/admin/maintenance', requireAdmin, (req, res) => {
  res.json({
    success: true,
    maintenanceMode: !!engineConfig.maintenanceMode,
    maintenanceMessage: engineConfig.maintenanceMessage || defaultEngineConfig.maintenanceMessage
  });
});

app.post('/api/admin/maintenance', requireAdmin, (req, res) => {
  try {
    const { maintenanceMode, maintenanceMessage } = req.body || {};
    if (typeof maintenanceMode === 'boolean') {
      engineConfig.maintenanceMode = maintenanceMode;
    }
    if (typeof maintenanceMessage === 'string' && maintenanceMessage.trim()) {
      engineConfig.maintenanceMessage = maintenanceMessage.trim();
    }
    saveEngineConfig();
    broadcastMaintenanceUpdate();
    console.log(`[Maintenance] Work In Progress toggled: ${engineConfig.maintenanceMode ? 'ACTIVE' : 'INACTIVE'}`);
    res.json({
      success: true,
      maintenanceMode: !!engineConfig.maintenanceMode,
      maintenanceMessage: engineConfig.maintenanceMessage,
      message: `Work In Progress mode is now ${engineConfig.maintenanceMode ? 'ENABLED' : 'DISABLED'}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12.2 Dedicated Bandwidth Capping & Traffic Allocation APIs
app.get('/api/admin/bandwidth-caps', requireAdmin, (req, res) => {
  res.json({
    success: true,
    bandwidthCaps: engineConfig.bandwidthCaps || defaultEngineConfig.bandwidthCaps
  });
});

app.post('/api/admin/bandwidth-caps', requireAdmin, (req, res) => {
  try {
    const { enabled, guestLimit, userLimit, premiumLimit, customUserLimits } = req.body || {};
    if (!engineConfig.bandwidthCaps) {
      engineConfig.bandwidthCaps = { ...defaultEngineConfig.bandwidthCaps };
    }
    if (typeof enabled === 'boolean') {
      engineConfig.bandwidthCaps.enabled = enabled;
    }
    if (guestLimit !== undefined) {
      engineConfig.bandwidthCaps.guestLimit = normalizeBandwidthString(guestLimit);
    }
    if (userLimit !== undefined) {
      engineConfig.bandwidthCaps.userLimit = normalizeBandwidthString(userLimit);
    }
    if (premiumLimit !== undefined) {
      engineConfig.bandwidthCaps.premiumLimit = normalizeBandwidthString(premiumLimit);
    }
    if (customUserLimits && typeof customUserLimits === 'object') {
      const sanitized = {};
      for (const [k, v] of Object.entries(customUserLimits)) {
        if (typeof k === 'string' && k.trim()) {
          sanitized[k.trim()] = normalizeBandwidthString(v);
        }
      }
      engineConfig.bandwidthCaps.customUserLimits = sanitized;
    }
    saveEngineConfig();
    console.log(`[Bandwidth] Caps updated: enabled=${engineConfig.bandwidthCaps.enabled}, guest=${engineConfig.bandwidthCaps.guestLimit}, user=${engineConfig.bandwidthCaps.userLimit}, premium=${engineConfig.bandwidthCaps.premiumLimit}`);
    res.json({
      success: true,
      bandwidthCaps: engineConfig.bandwidthCaps,
      message: 'Bandwidth caps updated successfully'
    });
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

    for (const u of users.values()) {
      const uFolders = [];
      if (u.downloadFolder && typeof u.downloadFolder === 'string' && u.downloadFolder.trim()) {
        uFolders.push(u.downloadFolder.trim());
      }
      if (Array.isArray(u.allowedFolders)) {
        for (const f of u.allowedFolders) {
          if (typeof f === 'string' && f.trim() && f.trim() !== '*' && !uFolders.includes(f.trim())) {
            uFolders.push(f.trim());
          }
        }
      }
      for (const p of uFolders) {
        if (!targetDirs.some(t => t.path === p)) {
          targetDirs.push({ path: p, category: `User: ${u.username} (Permanent)` });
        }
      }
    }

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
    res.json({
      success: true,
      disk: diskStats,
      directories: targetDirs.map(t => ({ path: t.path, category: t.category })),
      files: fileList.slice(0, 150)
    });
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
  let isAllowed = resolved.startsWith(temp) || resolved.startsWith(home);
  if (!isAllowed) {
    for (const u of users.values()) {
      if (u.downloadFolder && typeof u.downloadFolder === 'string' && u.downloadFolder.trim()) {
        const uFolder = path.resolve(u.downloadFolder.trim());
        if (resolved === uFolder || resolved.startsWith(uFolder + path.sep)) {
          isAllowed = true;
          break;
        }
      }
      if (Array.isArray(u.allowedFolders)) {
        for (const f of u.allowedFolders) {
          if (typeof f === 'string' && f.trim() && f.trim() !== '*') {
            const uFolder = path.resolve(f.trim());
            if (resolved === uFolder || resolved.startsWith(uFolder + path.sep)) {
              isAllowed = true;
              break;
            }
          }
        }
        if (isAllowed) break;
      }
    }
  }
  if (!isAllowed) {
    return res.status(403).send('Forbidden: Access outside download directories');
  }
  res.download(resolved);
});

// Delete specific file
app.post('/api/admin/storage/delete', requireAdmin, (req, res) => {
  try {
    const { filePath, forcePermanent } = req.body || {};
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    const resolved = path.resolve(filePath);
    if (isPermanentUserFile(resolved) && !forcePermanent) {
      return res.status(403).json({ error: 'Cannot delete files in permanent user storage' });
    }
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

// Bulk delete files or delete all
app.post('/api/admin/storage/delete-bulk', requireAdmin, (req, res) => {
  try {
    const { filePaths, deleteAll } = req.body || {};
    let targets = [];

    const home = path.resolve(process.env.HOME || process.env.USERPROFILE || '');
    const temp = path.resolve(TEMP_DIR);

    if (deleteAll) {
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const targetDirs = [
        TEMP_DIR,
        path.join(homeDir, 'slskd_downloads')
      ];

      function gatherFiles(dirPath, maxDepth = 3, currentDepth = 0) {
        if (!dirPath || !fs.existsSync(dirPath) || isPermanentUserDirectory(dirPath) || currentDepth > maxDepth) return;
        try {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          for (const ent of entries) {
            const full = path.join(dirPath, ent.name);
            if (ent.isFile() && !ent.name.startsWith('.')) {
              if (!isPermanentUserFile(full)) {
                targets.push(full);
              }
            } else if (ent.isDirectory() && !ent.name.startsWith('.') && currentDepth < maxDepth) {
              if (!isPermanentUserDirectory(full)) {
                gatherFiles(full, maxDepth, currentDepth + 1);
              }
            }
          }
        } catch (e) {}
      }

      for (const td of targetDirs) {
        gatherFiles(td, 3, 0);
      }
    } else if (Array.isArray(filePaths)) {
      targets = filePaths;
    }

    if (targets.length === 0) {
      return res.json({ success: true, deletedCount: 0, message: 'No files to delete' });
    }

    let deletedCount = 0;
    let failedCount = 0;
    let freedBytes = 0;

    for (const fp of targets) {
      if (!fp) continue;
      const resolved = path.resolve(fp);
      if (isPermanentUserFile(resolved)) {
        failedCount++;
        continue;
      }
      if (!resolved.startsWith(temp) && !resolved.startsWith(home)) {
        failedCount++;
        continue;
      }
      if (!fs.existsSync(resolved)) continue;

      try {
        const sz = fs.statSync(resolved).size;
        fs.unlinkSync(resolved);
        freedBytes += sz;
        deletedCount++;
      } catch (err) {
        if (process.platform !== 'win32') {
          try {
            const sz = fs.existsSync(resolved) ? fs.statSync(resolved).size : 0;
            execSync(`echo 'sakura' | sudo -S -p '' rm -f "${resolved}"`, { stdio: 'ignore' });
            freedBytes += sz;
            deletedCount++;
          } catch (e2) {
            failedCount++;
          }
        } else {
          failedCount++;
        }
      }
    }

    // Clean up empty directories in TEMP_DIR
    try {
      if (fs.existsSync(TEMP_DIR)) {
        const subdirs = fs.readdirSync(TEMP_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
        for (const sub of subdirs) {
          const subPath = path.join(TEMP_DIR, sub.name);
          try {
            if (!isPermanentUserDirectory(subPath) && fs.readdirSync(subPath).length === 0) {
              fs.rmdirSync(subPath);
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    const freedMB = (freedBytes / (1024 * 1024)).toFixed(1);
    res.json({
      success: true,
      deletedCount,
      failedCount,
      freedMB,
      message: `Successfully deleted ${deletedCount} files (freed ${freedMB} MB)`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
      if (!fs.existsSync(dirPath) || isPermanentUserDirectory(dirPath)) return;
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const ent of entries) {
          const full = path.join(dirPath, ent.name);
          if (ent.isFile()) {
            if (isPermanentUserFile(full)) continue;
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
            if (!isPermanentUserDirectory(full)) {
              cleanIncomplete(full);
              try {
                if (!isPermanentUserDirectory(full) && fs.readdirSync(full).length === 0) {
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
    {
      name: 'Tidal Monochrome API',
      url: 'https://monochrome.tf/api',
      fallbacks: ['https://api.monochrome-music.com', 'https://api.tidal.com/v1/ping'],
      method: 'HEAD',
      expect: [200, 301, 302, 401, 403]
    },
    { name: 'Deezer Core API', url: 'https://api.deezer.com', method: 'HEAD', expect: [200] },
    { name: 'Local Soulseek Daemon', url: 'http://127.0.0.1:5030/api/v0/application', method: 'GET', expect: [200, 401] },
    { name: 'Direct DDL Movie API', url: 'https://v3-cinemeta.strem.io/manifest.json', method: 'GET', expect: [200] },
    {
      name: 'YTS Movie API',
      url: 'https://movies-api.accel.li/api/v2/list_movies.json?limit=1',
      fallbacks: [
        'https://yts.gg/api/v2/list_movies.json?limit=1',
        'https://yts.lt/api/v2/list_movies.json?limit=1'
      ],
      method: 'HEAD',
      expect: [200]
    },
    { name: 'YouTube / Google Core', url: 'https://www.youtube.com', method: 'HEAD', expect: [200, 302] },
    { name: 'GitHub Upstream API', url: 'https://api.github.com/zen', method: 'HEAD', expect: [200] }
  ];

  const results = await Promise.all(targets.map(async (t) => {
    const urlsToTry = [t.url, ...(t.fallbacks || [])];

    // Concurrently race configured mirrors to measure the fastest healthy route
    const probeSingle = async (testUrl) => {
      const start = Date.now();
      const resp = await fetch(testUrl, {
        method: t.method || 'HEAD',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*'
        },
        signal: AbortSignal.timeout(4500)
      });
      const latencyMs = Date.now() - start;
      const isExpected = (t.expect || [200]).includes(resp.status);
      if (!isExpected) throw new Error(`Unexpected status ${resp.status}`);
      return {
        name: t.name,
        url: testUrl,
        status: resp.status,
        statusText: resp.statusText || String(resp.status),
        latencyMs,
        ok: true,
        tier: latencyMs < 500 ? 'optimal' : (latencyMs < 900 ? 'fair' : 'slow')
      };
    };

    try {
      if (urlsToTry.length === 1) {
        return await probeSingle(urlsToTry[0]);
      }
      // Pick the fastest responding healthy mirror
      return await Promise.any(urlsToTry.map(u => probeSingle(u)));
    } catch (e) {
      return {
        name: t.name,
        url: t.url,
        status: 0,
        statusText: e.message || 'Connection Error',
        latencyMs: 4500,
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
app.get('/api/flac-check/recent', identifyUser, (req, res) => {
  try {
    if (!isFeatureAllowed(req.currentUser, 'flac_checker')) {
      return res.status(403).json({ error: 'FLAC Checker is restricted for your role.', requireAuth: req.currentUser.role === 'guest' });
    }
    const results = scanFlacFiles();
    res.json(results.slice(0, 35));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Purge / Clear Recent Downloaded FLAC files from server storage
app.post('/api/flac-check/clear-recent', identifyUser, (req, res) => {
  try {
    if (!req.currentUser || req.currentUser.role === 'guest') {
      return res.status(403).json({ error: 'FLAC files purge is restricted for guests.', requireAuth: true });
    }
    const stats = purgeFlacFiles();
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run FLAC Authenticity Analysis
app.post('/api/flac-check', identifyUser, async (req, res) => {
  let targetPath = null;
  let isTempFile = false;

  try {
    const { filePath, fileBase64, fileName, jobId } = req.body || {};
    const isKnownJob = jobId && jobs.has(jobId);

    if (!isFeatureAllowed(req.currentUser, 'flac_checker') && !isKnownJob) {
      return res.status(403).json({
        error: 'FLAC Checker is restricted for your role. Please contact the administrator.',
        requireAuth: req.currentUser.role === 'guest'
      });
    }

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

const NON_JAV_PREFIXES = new Set([
  'ANSH', 'YEAR', 'MOVIE', 'FILM', 'SERIES', 'SEASON', 'EPISODE', 'PART', 'VOL', 'VOLUME',
  'DISC', 'DISK', 'HINDI', 'TAMIL', 'TELUGU', 'KANNADA', 'MALAYALAM', 'BENGALI', 'MARATHI',
  'PUNJABI', 'ENGLISH', 'FRENCH', 'GERMAN', 'SPANISH', 'JAPAN', 'KOREA', 'CHINA', 'ASIAN',
  'WORLD', 'INDIA', 'AUDIO', 'VIDEO', 'SOUND', 'TRACK', 'SCENE', 'CLIP', 'TRAILER', 'TEASER',
  'HDTS', 'HDCAM', 'CAMRIP', 'BLURAY', 'WEBDL', 'WEBRIP', 'HDRIP', 'DVDRIP', 'REPACK',
  'PROPER', 'COMPLETE', 'SUPER', 'ULTRA', 'MEGA', 'EXTRA', 'PLUS', 'BONUS', 'LIVE', 'LIFE',
  'TIME', 'NIGHT', 'DARK', 'LIGHT', 'HERO', 'KING', 'LORD', 'GAME', 'WAR', 'STAR', 'CITY',
  'ROAD', 'PARK', 'ZONE', 'TRUE', 'REAL', 'GOOD', 'BEST', 'LOVE', 'DEAD', 'FAST', 'LAST',
  'LOST', 'ROOM', 'FIRE', 'WIND', 'WATER', 'GOLD', 'IRON', 'ROCK', 'BOOK', 'SONG', 'SHOW'
]);

function extractJavCode(title) {
  if (!title || typeof title !== 'string') return null;
  const clean = title.trim();

  // 1. FC2 PPV format (e.g. FC2-PPV-1234567 or FC2-123456)
  const fc2Match = clean.match(/\bFC2[-_ ]?(?:PPV[-_ ]?)?(\d{5,7})\b/i);
  if (fc2Match) {
    return `FC2-PPV-${fc2Match[1]}`;
  }

  // 2. Standard JAV Studio codes with hyphen/underscore delimiter (e.g. SSIS-001, IPX-534)
  const stdMatch = clean.match(/\b([A-Za-z]{2,6})[-_](\d{2,5})\b/);
  if (stdMatch) {
    const letters = stdMatch[1].toUpperCase();
    const numStr = stdMatch[2];
    const num = parseInt(numStr, 10);
    if (NON_JAV_PREFIXES.has(letters)) return null;
    if (numStr.length === 4 && num >= 1920 && num <= 2099) return null;
    return `${letters}-${numStr}`;
  }

  // 3. Compact JAV code without space or delimiter (e.g. IPX534, SSIS001) - 3 to 5 digits only
  const compactMatch = clean.match(/\b([A-Za-z]{2,5})(\d{3,5})\b/);
  if (compactMatch) {
    const letters = compactMatch[1].toUpperCase();
    const numStr = compactMatch[2];
    const num = parseInt(numStr, 10);
    if (NON_JAV_PREFIXES.has(letters)) return null;
    if (numStr.length === 4 && num >= 1920 && num <= 2099) return null;
    return `${letters}-${numStr}`;
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

    let thumb = '';
    const imgTagMatch = chunk.match(/<img[^>]+>/i);
    if (imgTagMatch) {
      const imgTag = imgTagMatch[0];
      const candidates = [
        (imgTag.match(/data-src="([^"]+)"/i) || [])[1],
        (imgTag.match(/data-image="([^"]+)"/i) || [])[1],
        (imgTag.match(/src="([^"]+)"/i) || [])[1]
      ];
      for (const c of candidates) {
        if (c && c.startsWith('http') && !c.includes('blank.gif') && !c.includes('placeholder')) {
          thumb = c;
          break;
        }
      }
    }
    if (!thumb) {
      const fallback = chunk.match(/https:\/\/[^"'\s]*(?:xvideos-cdn|xv-cdn)[^"'\s]*\.(?:jpg|jpeg|webp|png)[^"'\s]*/i);
      if (fallback) thumb = fallback[0];
    }

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
      thumb: thumb ? `/api/proxy-image?url=${encodeURIComponent(thumb)}` : '',
      rawThumb: thumb,
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
      const hdMatch = block.match(/<span class="hd-thumbnail">([^<]+)<\/span>/i);
      const previewMatch = block.match(/data-mediabook="([^"]+)"/i);

      let thumb = '';
      const imgTagMatch = block.match(/<img[^>]+class="[^"]*(?:thumb|videoThumb|rotating)[^"]*"[^>]*>/i) || block.match(/<img[^>]+>/i);
      if (imgTagMatch) {
        const imgTag = imgTagMatch[0];
        const candidates = [
          (imgTag.match(/data-image="([^"]+)"/i) || [])[1],
          (imgTag.match(/data-mediumthumb="([^"]+)"/i) || [])[1],
          (imgTag.match(/data-thumb_url="([^"]+)"/i) || [])[1],
          (imgTag.match(/data-src="([^"]+)"/i) || [])[1],
          (imgTag.match(/src="([^"]+)"/i) || [])[1]
        ];
        for (const c of candidates) {
          if (c && c.startsWith('http') && !c.includes('blank.gif') && !c.includes('placeholder')) {
            thumb = c;
            break;
          }
        }
      }
      if (!thumb) {
        const fallback = block.match(/https:\/\/[^"'\s]+\.phncdn\.com\/[^"'\s]+\.(?:jpg|jpeg|webp|png)[^"'\s]*/i);
        if (fallback) thumb = fallback[0];
      }

      const title = titleMatch ? titleMatch[1].trim() : 'Pornhub Video';
      const isTeaser = /\b(preview|trailer|teaser)\b/i.test(title);

      results.push({
        id: vkey,
        title,
        url: `https://www.pornhub.com/view_video.php?viewkey=${vkey}`,
        thumb: thumb ? `/api/proxy-image?url=${encodeURIComponent(thumb)}` : '',
        rawThumb: thumb,
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

async function searchEporner(query, page = 1) {
  try {
    const url = `https://www.eporner.com/api/v2/video/search/?query=${encodeURIComponent(query)}&page=${page}&per_page=25&thumbsize=big&order=top-weekly`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list = data.videos || [];
    return list.map(v => {
      const thumb = (v.default_thumb && v.default_thumb.src) || (v.thumbs && v.thumbs[0] && v.thumbs[0].src) || '';
      return {
        id: v.id,
        title: v.title || 'Eporner Video',
        url: v.url,
        thumb: thumb ? `/api/proxy-image?url=${encodeURIComponent(thumb)}` : '',
        rawThumb: thumb,
        previewVideo: '',
        duration: v.length_min || '',
        quality: '1080p 60fps',
        provider: 'eporner',
        type: 'tube',
        isTeaser: false
      };
    });
  } catch (e) {
    console.warn('[AdultSearch] Eporner search error:', e.message);
    return [];
  }
}

async function searchRedTube(query, page = 1) {
  try {
    const url = `https://api.redtube.com/?data=redtube.Videos.searchVideos&output=json&search=${encodeURIComponent(query)}&page=${page}&thumbsize=big`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list = data.videos || [];
    return list.map(item => {
      const v = item.video || item;
      const thumb = v.default_thumb || v.thumb || (v.thumbs && v.thumbs[0] && v.thumbs[0].src) || '';
      return {
        id: String(v.video_id || v.id || ''),
        title: v.title || 'RedTube Video',
        url: v.url || `https://www.redtube.com/${v.video_id}`,
        thumb: thumb ? `/api/proxy-image?url=${encodeURIComponent(thumb)}` : '',
        rawThumb: thumb,
        previewVideo: '',
        duration: v.duration || '',
        quality: '1080p HD',
        provider: 'redtube',
        type: 'tube',
        isTeaser: false
      };
    });
  } catch (e) {
    console.warn('[AdultSearch] RedTube search error:', e.message);
    return [];
  }
}

async function searchHQPorner(query, page = 1) {
  try {
    const url = `https://hqporner.com/?q=${encodeURIComponent(query)}&p=${page}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://hqporner.com/' },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const html = await res.text();
    const results = [];
    const cardRegex = /<section class="box feature">([\s\S]*?)<\/section>/gi;
    let m;
    while ((m = cardRegex.exec(html)) !== null && results.length < 25) {
      const block = m[1];
      const linkMatch = block.match(/href="(\/hdporn\/[^"]+)"/i);
      if (!linkMatch) continue;
      const href = linkMatch[1];
      const fullUrl = `https://hqporner.com${href}`;

      const titleMatch = block.match(/class="click-trigger"[^>]*>([^<]+)<\/a>/i) || block.match(/alt="([^"]+)"/i);
      const title = titleMatch ? titleMatch[1].trim() : 'HQPorner Video';

      const durMatch = block.match(/class="icon fa-clock-o meta-data">([^<]+)<\/span>/i);
      const duration = durMatch ? durMatch[1].trim() : '';

      const imgMatch = block.match(/<img[^>]+src=["']([^"']+)["']/i);
      let thumb = imgMatch ? imgMatch[1] : '';
      if (thumb.startsWith('//')) thumb = 'https:' + thumb;

      results.push({
        id: href,
        title,
        url: fullUrl,
        thumb: thumb ? `/api/proxy-image?url=${encodeURIComponent(thumb)}` : '',
        rawThumb: thumb,
        previewVideo: '',
        duration,
        quality: '4K / 1080p',
        provider: 'hqporner',
        type: 'tube',
        isTeaser: false
      });
    }
    return results;
  } catch (e) {
    console.warn('[AdultSearch] HQPorner search error:', e.message);
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
      thumb: coverUrl ? `/api/proxy-image?url=${encodeURIComponent(coverUrl)}` : '',
      rawThumb: coverUrl,
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
  let targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.startsWith('http')) {
    return res.status(400).send('Invalid image URL');
  }
  targetUrl = targetUrl.replace(/&amp;/g, '&');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
  };
  if (targetUrl.includes('phncdn.com') || targetUrl.includes('pornhub')) {
    headers['Referer'] = 'https://www.pornhub.com/';
  } else if (targetUrl.includes('xvideos')) {
    headers['Referer'] = 'https://www.xvideos.com/';
  } else if (targetUrl.includes('dmm.co.jp')) {
    headers['Referer'] = 'https://www.dmm.co.jp/';
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers,
      signal: AbortSignal.timeout(10000)
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
// MOVIE & TV SHOW HUB ENGINE (Native Direct DDL & Torrents Dual Pipeline)
// ==========================================================================

async function searchDdlMovies(query, page = 1) {
  try {
    const q = (query || '').trim();
    if (!q) return [];

    const qLower = q.toLowerCase();

    // Query Cinemeta open catalog for both Movies and TV Series concurrently
    const [movieRes, seriesRes] = await Promise.allSettled([
      fetch(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(q)}.json`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(6000)
      }),
      fetch(`https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(q)}.json`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(6000)
      })
    ]);

    let movieMetas = [];
    if (movieRes.status === 'fulfilled' && movieRes.value.ok) {
      const data = await movieRes.value.json();
      if (Array.isArray(data.metas)) {
        movieMetas = data.metas.map(m => ({ ...m, type: m.type || 'movie' }));
      }
    }

    let seriesMetas = [];
    if (seriesRes.status === 'fulfilled' && seriesRes.value.ok) {
      const data = await seriesRes.value.json();
      if (Array.isArray(data.metas)) {
        seriesMetas = data.metas.map(m => ({ ...m, type: 'series' }));
      }
    }

    // Combine and deduplicate by id
    const seenIds = new Set();
    const combinedMetas = [];
    for (const m of [...seriesMetas, ...movieMetas]) {
      const id = m.imdb_id || m.id;
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        combinedMetas.push(m);
      }
    }

    // Relevance scoring: exact title matches first, then prefix matches, then substring
    combinedMetas.sort((a, b) => {
      const aName = (a.name || '').toLowerCase().trim();
      const bName = (b.name || '').toLowerCase().trim();
      const aExact = aName === qLower ? 1 : 0;
      const bExact = bName === qLower ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;

      const aStarts = aName.startsWith(qLower) ? 1 : 0;
      const bStarts = bName.startsWith(qLower) ? 1 : 0;
      if (aStarts !== bStarts) return bStarts - aStarts;

      const aIncludes = aName.includes(qLower) ? 1 : 0;
      const bIncludes = bName.includes(qLower) ? 1 : 0;
      if (aIncludes !== bIncludes) return bIncludes - aIncludes;

      // When both are exact, give series with seasons/popularity preference
      if (aExact && bExact) {
        if (a.type === 'series' && b.type !== 'series') return -1;
        if (b.type === 'series' && a.type !== 'series') return 1;
      }

      return 0;
    });

    // Enrich top TV series with accurate IMDb rating, genres, and episode/season lists
    const topSeriesToEnrich = combinedMetas.filter(m => m.type === 'series').slice(0, 4);
    await Promise.allSettled(topSeriesToEnrich.map(async (m) => {
      try {
        const sRes = await fetch(`https://v3-cinemeta.strem.io/meta/series/${m.id}.json`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(4000)
        });
        if (sRes.ok) {
          const sData = await sRes.json();
          if (sData && sData.meta) {
            m.imdbRating = sData.meta.imdbRating || m.imdbRating || '';
            m.genres = sData.meta.genres || m.genres || [];
            m.description = sData.meta.description || m.description || '';
            m.videos = sData.meta.videos || [];
          }
        }
      } catch (e) {}
    }));

    // Enrich top movies with authentic verified releases (exact sizes, seeders, and torrent hashes)
    const topMoviesToEnrich = combinedMetas.filter(m => m.type === 'movie').slice(0, 6);
    await Promise.allSettled(topMoviesToEnrich.map(async (m) => {
      try {
        const imdbId = m.imdb_id || m.id;
        const qTerm = imdbId ? imdbId : `${m.name || ''} ${m.releaseInfo || m.year || ''}`.trim();
        const mirrors = [
          'https://movies-api.accel.li/api/v2/list_movies.json',
          'https://yts.gg/api/v2/list_movies.json',
          'https://yts.lt/api/v2/list_movies.json'
        ];
        for (const mirror of mirrors) {
          try {
            const url = `${mirror}?query_term=${encodeURIComponent(qTerm)}&limit=5`;
            const res = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
              signal: AbortSignal.timeout(3500)
            });
            if (!res.ok) continue;
            const data = await res.json();
            if (data?.data?.movies?.length > 0) {
              const ytsMovie = data.data.movies.find(ym => (imdbId && ym.imdb_code === imdbId)) || data.data.movies[0];
              if (ytsMovie && Array.isArray(ytsMovie.torrents) && ytsMovie.torrents.length > 0) {
                m.ytsTorrents = ytsMovie.torrents;
                if (!m.imdbRating && ytsMovie.rating) m.imdbRating = String(ytsMovie.rating);
                if ((!m.genres || m.genres.length === 0) && ytsMovie.genres) m.genres = ytsMovie.genres;
                break;
              }
            }
          } catch (e) {}
        }
      } catch (e) {}
    }));

    const items = [];
    for (const m of combinedMetas) {
      const title = m.name || 'Title';
      const year = m.releaseInfo || m.year || '';
      const imdbId = m.imdb_id || m.id || '';
      let poster = m.poster || (m.background ? m.background : '');
      const summary = m.description || '';
      const genres = m.genres || (m.genre ? (Array.isArray(m.genre) ? m.genre : [m.genre]) : []);
      const rating = parseFloat(m.imdbRating) || 0;
      const isSeries = m.type === 'series';

      // Upgrade Cinemeta / IMDb Amazon poster resolution to crisp 600px
      if (poster && poster.includes('media-amazon.com/images/M/') && poster.includes('._V1_')) {
        poster = poster.replace(/\._V1_.*?\.(jpg|jpeg|png|webp)/i, '._V1_SX600.$1');
      }

      const cleanBaseName = `${title.replace(/[^\w\s.-]/g, '').trim().replace(/\s+/g, '.')}${year ? `.${String(year).replace(/[^\w]/g, '-')}` : ''}`;

      let releases = [];
      if (isSeries) {
        const uniqueSeasons = [...new Set((m.videos || []).map(v => v.season).filter(s => typeof s === 'number' && s > 0))].sort((a, b) => a - b);

        // 1. Complete Series Box Set (All Seasons)
        releases.push({
          label: uniqueSeasons.length > 1
            ? `Complete Series Box Set (Seasons 1–${uniqueSeasons.length} • All Episodes) [1080p]`
            : `Complete Series Pack [1080p Full HD]`,
          filename: `${cleanBaseName}.Complete.Series.1080p.mkv`,
          size: uniqueSeasons.length > 1 ? `~18–25 GB (All Seasons)` : '~20 GB',
          quality: '1080p',
          provider: 'ddl',
          imdbId,
          type: 'ddl'
        });

        // 2. Individual Episodes of Season 1 (for fast single-episode watching!)
        const s1Videos = (m.videos || []).filter(v => v.season === 1);
        const topEpisodes = s1Videos.length > 0 ? s1Videos.slice(0, 10) : [
          { episode: 1, name: 'Pilot' },
          { episode: 2, name: 'Red Hair and Silver Tape' },
          { episode: 3, name: 'Red Tide' }
        ];

        for (const ep of topEpisodes) {
          const epNum = ep.number || ep.episode || 1;
          const epPad = String(epNum).padStart(2, '0');
          const epName = ep.name ? ` - ${ep.name}` : '';
          releases.push({
            label: `S01E${epPad}${epName} [1080p Full HD]`,
            filename: `${cleanBaseName}.S01E${epPad}.1080p.mkv`,
            size: '~1.8 GB (Single Episode)',
            quality: '1080p',
            provider: 'ddl',
            imdbId,
            type: 'ddl'
          });
          releases.push({
            label: `S01E${epPad}${epName} [720p HD]`,
            filename: `${cleanBaseName}.S01E${epPad}.720p.mkv`,
            size: '~650 MB (Single Episode)',
            quality: '720p',
            provider: 'ddl',
            imdbId,
            type: 'ddl'
          });
        }

        // 3. Full Season Packs (with transparent, realistic sizes for all episodes combined)
        const seasonsToRender = uniqueSeasons.length > 0 ? uniqueSeasons : [1, 2, 3, 4, 5, 6, 7];
        for (const sNum of seasonsToRender) {
          const sPad = String(sNum).padStart(2, '0');
          const seasonEps = (m.videos || []).filter(v => v.season === sNum);
          const epCount = seasonEps.length || 23;
          const size1080p = Math.round(epCount * 1.45);
          const size720p = Math.max(1, Math.round(epCount * 0.7));

          releases.push({
            label: `Season ${sNum} Complete (${epCount} Episodes) [1080p BluRay / WEB]`,
            filename: `${cleanBaseName}.S${sPad}.Complete.1080p.mkv`,
            size: `~${size1080p} GB (All ${epCount} Ep)`,
            quality: '1080p',
            provider: 'ddl',
            imdbId,
            type: 'ddl'
          });
          releases.push({
            label: `Season ${sNum} Complete (${epCount} Episodes) [720p HD]`,
            filename: `${cleanBaseName}.S${sPad}.Complete.720p.mkv`,
            size: `~${size720p} GB (All ${epCount} Ep)`,
            quality: '720p',
            provider: 'ddl',
            imdbId,
            type: 'ddl'
          });
        }
      } else {
        // Movie releases: populate with authentic verified swarm releases if indexed
        if (Array.isArray(m.ytsTorrents) && m.ytsTorrents.length > 0) {
          releases = m.ytsTorrents.map(t => {
            const q = t.quality === '2160p' ? '4K UHD' : (t.quality || '1080p');
            const hash = t.hash;
            const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(cleanBaseName)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&tr=udp%3A%2F%2Fexplodie.org%3A6969%2Fannounce`;
            const sizeBytes = t.size_bytes || parseSizeToBytes(t.size);
            return {
              label: `${q} (${(t.type || 'BLURAY').toUpperCase()}) [${t.size}]`,
              filename: `${cleanBaseName}.${t.quality}.${t.type || 'bluray'}.mp4`,
              quality: q,
              size: t.size,
              sizeBytes,
              seeders: t.seeds || 0,
              peers: t.peers || 0,
              hash,
              magnet,
              torrentUrl: t.url || `https://yts.gg/torrent/download/${hash}`,
              provider: 'yts',
              type: 'torrent'
            };
          });
        } else {
          // If no pre-indexed swarm releases found, provide clean dynamic resolution options
          releases = [
            {
              label: '1080p Full HD [Cloud Mirror / Swarm Auto-Resolve]',
              filename: `${cleanBaseName}.1080p.mkv`,
              size: 'Auto-Detect',
              quality: '1080p',
              provider: 'ddl',
              imdbId,
              type: 'ddl'
            },
            {
              label: '720p HD [Cloud Mirror / Swarm Auto-Resolve]',
              filename: `${cleanBaseName}.720p.mkv`,
              size: 'Auto-Detect',
              quality: '720p',
              provider: 'ddl',
              imdbId,
              type: 'ddl'
            },
            {
              label: '4K UHD Ultra HD [Cloud Mirror / Swarm Auto-Resolve]',
              filename: `${cleanBaseName}.2160p.mkv`,
              size: 'Auto-Detect',
              quality: '4K UHD',
              provider: 'ddl',
              imdbId,
              type: 'ddl'
            }
          ];
        }
      }

      items.push({
        id: `ddl_${imdbId || Math.random().toString(36).substring(2, 8)}`,
        title: `${title}${year ? ` (${year})` : ''}`,
        pureTitle: title,
        year: String(year),
        poster,
        rating,
        genres,
        summary,
        imdbId,
        provider: 'ddl',
        type: isSeries ? 'series' : 'movie',
        releasesCount: releases.length,
        releases
      });
    }

    return items;
  } catch (err) {
    console.warn('[MovieSearch] DDL search error:', err.message);
    return [];
  }
}

async function searchYtsMovies(query, page = 1) {
  const mirrors = [
    'https://movies-api.accel.li/api/v2/list_movies.json',
    'https://yts.gg/api/v2/list_movies.json',
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
          const sizeBytes = t.size_bytes || parseSizeToBytes(t.size);
          return {
            label: `${q} (${(t.type || 'WEB').toUpperCase()}) [${t.size}]`,
            filename: `${title}.${year}.${t.quality}.${t.type || 'WEB'}.mp4`,
            quality: q,
            size: t.size,
            sizeBytes,
            seeders: t.seeds || 0,
            peers: t.peers || 0,
            hash,
            magnet,
            torrentUrl: t.url || `https://yts.gg/torrent/download/${hash}`,
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

// Parse human-readable file size string (e.g., '1.45 GB', '650 MB') to bytes
function parseSizeToBytes(sizeStr) {
  if (!sizeStr) return 0;
  if (typeof sizeStr === 'number') return sizeStr;
  const s = String(sizeStr).trim();
  const m = s.match(/^([\d.]+)\s*(GB|MB|KB|B|bytes)?/i);
  if (!m) return 0;
  const num = parseFloat(m[1]) || 0;
  const unit = (m[2] || 'MB').toUpperCase();
  if (unit === 'GB') return Math.round(num * 1024 * 1024 * 1024);
  if (unit === 'MB') return Math.round(num * 1024 * 1024);
  if (unit === 'KB') return Math.round(num * 1024);
  return Math.round(num);
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
    const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0 || items[0].name === 'No results returned') return [];

    // Filter for video categories (200-299) and files >= 100 MB to reject tiny sample clips, fake torrents & audiobooks
    const validItems = items.filter(it => {
      const cat = parseInt(it.category, 10);
      if (cat && (cat < 200 || cat >= 300)) return false;
      const sz = parseInt(it.size, 10) || 0;
      if (sz < 100 * 1024 * 1024) return false;
      return true;
    });

    const activeItems = validItems.filter(it => parseInt(it.seeders, 10) > 0);
    const candidateList = activeItems.length > 0 ? activeItems : validItems;
    candidateList.sort((a, b) => (parseInt(b.seeders, 10) || 0) - (parseInt(a.seeders, 10) || 0));
    const itemsToProcess = candidateList.slice(0, 15);

    const results = [];
    for (const it of itemsToProcess) {
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

      const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}&${BT_TRACKER_PARAMS}`;

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
          sizeBytes,
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
      ddl: feat.ddlSource !== false,
      yts: !!feat.ytsSource,
      torrents: !!feat.torrentsSource
    }
  });
});

// Unified Movie Search API (Direct DDL + YTS + Torrents)
app.get('/api/movies/search', identifyUser, async (req, res) => {
  try {
    if (!isFeatureAllowed(req.currentUser, 'movies')) {
      return res.status(403).json({
        success: false,
        results: [],
        total: 0,
        error: 'Movie & TV Hub is restricted for your role.',
        requireAuth: req.currentUser.role === 'guest'
      });
    }

    if (engineConfig.features && engineConfig.features.movieHub === false) {
      return res.json({ success: true, results: [], query: '', total: 0, disabled: true, message: 'Movie & TV Hub is currently disabled by administrator in Admin Settings.' });
    }

    const q = (req.query.q || '').trim();
    let requestedSource = req.query.source || 'all'; // 'all', 'ddl', 'yts', 'torrents'
    const qualityFilter = req.query.quality || 'all'; // 'all', '4k', '1080p', '720p'
    const page = parseInt(req.query.page, 10) || 1;

    if (!q) {
      return res.json({ success: true, results: [], query: '', total: 0 });
    }

    const feat = (engineConfig && engineConfig.features) || {};
    const ddlEnabled = feat.ddlSource !== false;
    const ytsEnabled = !!feat.ytsSource;
    const torrentsEnabled = !!feat.torrentsSource;

    if (!ddlEnabled && !ytsEnabled && !torrentsEnabled) {
      return res.json({ success: true, results: [], query: q, total: 0, message: 'All movie providers are currently disabled in Admin Settings.' });
    }

    // Auto-resolve requested source against active provider states
    if (requestedSource === 'ddl' && !ddlEnabled) {
      requestedSource = ytsEnabled ? 'yts' : (torrentsEnabled ? 'torrents' : 'none');
    } else if (requestedSource === 'yts' && !ytsEnabled) {
      requestedSource = ddlEnabled ? 'ddl' : (torrentsEnabled ? 'torrents' : 'none');
    } else if (requestedSource === 'torrents' && !torrentsEnabled) {
      requestedSource = ddlEnabled ? 'ddl' : (ytsEnabled ? 'yts' : 'none');
    }

    if (requestedSource === 'none') {
      return res.json({ success: true, results: [], query: q, total: 0, message: 'Requested provider is currently disabled by administrator.' });
    }

    let combined = [];

    if (requestedSource === 'yts') {
      combined = await searchYtsMovies(q, page);
    } else if (requestedSource === 'torrents') {
      combined = await searchApibayMovies(q);
    } else if (requestedSource === 'ddl') {
      combined = await searchDdlMovies(q, page);
    } else {
      // 'all': query all currently enabled providers concurrently
      const tasks = [];
      if (ddlEnabled) tasks.push(searchDdlMovies(q, page));
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
app.post('/api/movies/download', identifyUser, async (req, res) => {
  try {
    const item = req.body || {};
    let magnet = item.magnet || '';
    let torrentUrl = item.torrentUrl || '';
    let target = item.url || item.href || '';

    const rawTitle = item.releaseFilename || item.filename || item.title || '';
    const pureTitle = item.pureTitle || item.title || '';
    const releaseLabel = item.releaseLabel || item.label || '';
    const requestedQuality = (item.quality || '1080p').toLowerCase();

    // Role-based feature enforcement for Movie & TV Hub
    if (!isFeatureAllowed(req.currentUser, 'movies')) {
      return res.status(403).json({
        success: false,
        error: 'Movie & TV Hub downloads are restricted for your role. Please contact the administrator.',
        requireAuth: req.currentUser.role === 'guest'
      });
    }


    // 1. Detect TV Show Episode notation (e.g. S01E01, S02E03, Ep 01, Episode 1)
    const combinedText = `${rawTitle} ${releaseLabel} ${item.title || ''}`;
    let seasonEpStr = '';
    const seMatch = combinedText.match(/\b(S\d\d?E\d\d?)\b/i);
    if (seMatch) {
      seasonEpStr = seMatch[1].toUpperCase();
    } else {
      const epMatch = combinedText.match(/(?:Season\s*(\d+))?\s*(?:Episode|Ep)\s*(\d+)/i);
      if (epMatch) {
        const sNum = epMatch[1] ? String(epMatch[1]).padStart(2, '0') : '01';
        const eNum = String(epMatch[2]).padStart(2, '0');
        seasonEpStr = `S${sNum}E${eNum}`;
      }
    }

    // 2. If magnet/torrent not pre-attached, dynamically resolve high-speed torrent stream on-the-fly
    if (!magnet && !torrentUrl) {
      // Clean base title for search
      let cleanTitle = pureTitle || item.title || '';
      cleanTitle = cleanTitle
        .replace(/\[.*?\]|\(.*?\)/g, ' ')
        .replace(/\b(19\d\d|20\d\d)\b.*$/, '')
        .replace(/\b(Season\s*\d+|S\d\d?E\d\d?|4k|2160p|1080p|720p|bluray|web-?dl|hevc|x265|x264|hindi|english|multi audio)\b.*/i, '')
        .replace(/[^a-zA-Z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!cleanTitle) {
        cleanTitle = (pureTitle || item.title || '').replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
      }

      // Build prioritized search queries
      const queriesToTry = [];
      if (seasonEpStr) {
        queriesToTry.push(`${cleanTitle} ${seasonEpStr}`);
        queriesToTry.push(`${cleanTitle} ${seasonEpStr.replace(/^S0?(\d+)E0?(\d+)$/i, 'S$1E$2')}`);
      } else {
        const year = item.year || (combinedText.match(/\b(19\d\d|20\d\d)\b/) || [])[1] || '';
        const qTag = requestedQuality.includes('4k') || requestedQuality.includes('2160') ? '2160p' : (requestedQuality.includes('720') ? '720p' : '1080p');
        if (year) {
          queriesToTry.push(`${cleanTitle} ${year} ${qTag}`);
          queriesToTry.push(`${cleanTitle} ${year}`);
        } else {
          queriesToTry.push(`${cleanTitle} ${qTag}`);
        }
        queriesToTry.push(cleanTitle);
      }

      const candidates = [];
      for (const qStr of queriesToTry) {
        if (candidates.length > 0) break;
        try {
          const [tpbRes, ytsRes] = await Promise.allSettled([
            searchApibayMovies(qStr),
            (!seasonEpStr) ? searchYtsMovies(qStr, 1) : Promise.resolve([])
          ]);
          const tpb = tpbRes.status === 'fulfilled' ? tpbRes.value : [];
          const yts = ytsRes.status === 'fulfilled' ? ytsRes.value : [];

          for (const t of tpb) {
            for (const r of t.releases || []) {
              if (r.magnet || r.torrentUrl) candidates.push({ ...r, sourceTitle: t.title });
            }
          }
          for (const y of yts) {
            for (const r of y.releases || []) {
              if (r.magnet || r.torrentUrl) candidates.push({ ...r, sourceTitle: y.title });
            }
          }
        } catch (e) {
          console.warn('[MovieDownload] Error searching torrent streams:', e.message);
        }
      }

      if (candidates.length > 0) {
        const minBytes = seasonEpStr ? 100 * 1024 * 1024 : 250 * 1024 * 1024;
        candidates = candidates.filter(c => {
          const sz = c.sizeBytes || parseSizeToBytes(c.size);
          return sz === 0 || sz >= minBytes;
        });

        const qTag = requestedQuality.includes('4k') || requestedQuality.includes('2160') ? '2160p' : (requestedQuality.includes('720') ? '720p' : '1080p');
        let matches = candidates.filter(c => {
          const combined = `${c.quality || ''} ${c.label || ''} ${c.filename || ''}`.toLowerCase();
          return combined.includes(qTag);
        });
        if (matches.length === 0) matches = candidates;

        // Rank by highest active seeders
        matches.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
        const best = matches[0];

        magnet = best.magnet || '';
        torrentUrl = best.torrentUrl || '';
        target = magnet || torrentUrl;
      }
    }

    // If no torrent was resolved
    if (!magnet && !torrentUrl) {
      return res.status(400).json({
        success: false,
        error: 'Valid download stream could not be resolved for this title.'
      });
    }

    const isTorrent = !!(magnet || torrentUrl || (target && target.startsWith('magnet:')));
    const finalTarget = magnet || torrentUrl || target;

    // Construct a clean, human-readable job title for display in the queue
    let displayJobTitle = item.pureTitle || item.title || 'Movie Media';
    if (item.pureTitle && item.year) {
      displayJobTitle = `${item.pureTitle} (${item.year})`;
    }
    if (seasonEpStr) {
      displayJobTitle += ` ${seasonEpStr}`;
    }
    const qLabel = requestedQuality.includes('4k') || requestedQuality.includes('2160') ? '4K UHD' : (requestedQuality.includes('720') ? '720p' : '1080p');
    displayJobTitle += ` [${qLabel}]`;

    const jobPayload = {
      url: finalTarget,
      magnet: magnet,
      torrentUrl: torrentUrl,
      title: displayJobTitle,
      poster: item.poster || '',
      code: seasonEpStr ? 'TV_SERIES' : 'MOVIE',
      mode: 'video',
      videoQuality: item.quality || 'best',
      type: isTorrent ? 'torrent' : 'video',
      ownerId: req.currentUser.userId,
      username: req.currentUser.username,
      role: req.currentUser.role,
      isOwner: req.currentUser.isOwner || req.currentUser.role === 'owner' || req.currentUser.userId === 'owner' || req.currentUser.username === 'sakura',
      isPremium: req.currentUser.isPremium
    };

    const job = createAndStartJob(jobPayload);
    res.json({
      success: true,
      jobId: job.id,
      title: job.title,
      type: jobPayload.type
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dedicated Direct DDL Movie Cloud Stream Resolver Endpoint (Non-Torrent)
app.post('/api/movies/resolve-ddl', identifyUser, async (req, res) => {
  try {
    const { link, url, title, pureTitle, year, poster, quality, filename, imdbId, magnet, torrentUrl, releaseLabel, releaseSize } = req.body || {};
    if (!title && !filename) return res.status(400).json({ success: false, error: 'Title or filename is required' });

    // Role-based feature enforcement for Movie & TV Hub DDL streaming
    if (!isFeatureAllowed(req.currentUser, 'movies')) {
      return res.status(403).json({
        success: false,
        error: 'Movie & TV Hub DDL streaming is restricted for your role.',
        requireAuth: req.currentUser.role === 'guest'
      });
    }

    let rawTitle = (filename || title || 'Movie Media').replace(/[\\/:*?"<>|]/g, '_').trim();
    if (!rawTitle.endsWith('.mkv') && !rawTitle.endsWith('.mp4')) {
      rawTitle += '.mp4';
    }
    const jobId = 'job_ddl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const ownerFolder = getUserDownloadFolder(req.currentUser.userId);
    const isOwner = req.currentUser.isOwner || req.currentUser.role === 'owner' || req.currentUser.userId === 'owner' || req.currentUser.username === 'sakura';

    // Fast-path: If release already has verified swarm magnet/torrent, start directly without redundant discovery
    if (magnet || torrentUrl) {
      const swarmJob = {
        id: jobId,
        url: magnet || torrentUrl,
        opts: {
          title: rawTitle,
          pureTitle: pureTitle || title || '',
          year: year || '',
          quality: quality || '1080p',
          imdbId: imdbId || '',
          magnet,
          torrentUrl,
          type: 'torrent',
          ownerId: req.currentUser.userId,
          username: req.currentUser.username,
          role: req.currentUser.role,
          isOwner,
          isPremium: req.currentUser.isPremium
        },
        title: rawTitle,
        poster: poster || '',
        filename: rawTitle,
        code: 'SWARM',
        mode: 'torrent',
        ownerId: req.currentUser.userId,
        username: req.currentUser.username,
        role: req.currentUser.role,
        isOwner,
        isPremium: req.currentUser.isPremium,
        downloadFolder: ownerFolder || '',
        isPermanent: !!ownerFolder,
        status: 'downloading',
        filesize: releaseSize || '',
        progress: {
          percent: 0,
          speed: 'Connecting',
          eta: 'Connecting to swarm...',
          downloadedSize: '0 MB',
          totalSize: releaseSize || ''
        },
        logs: [`[Swarm] Enqueued verified release: ${rawTitle}${releaseSize ? ` [${releaseSize}]` : ''}`],
        error: null,
        startTime: Date.now(),
        completedTime: null,
        process: null
      };

      jobs.set(jobId, swarmJob);
      broadcastGlobalJobSync();
      broadcastJobUpdate(jobId);
      startTorrentJob(swarmJob);

      return res.json({
        success: true,
        jobId: swarmJob.id,
        title: swarmJob.title
      });
    }

    const job = {
      id: jobId,
      url: url || link || '',
      opts: {
        title: (filename || title || 'Movie Media').trim(),
        pureTitle: pureTitle || title || '',
        year: year || '',
        quality: quality || '1080p',
        imdbId: imdbId || '',
        ownerId: req.currentUser.userId,
        username: req.currentUser.username,
        role: req.currentUser.role,
        isOwner,
        isPremium: req.currentUser.isPremium
      },
      title: (filename || title || 'Movie Media').trim(),
      poster: poster || '',
      filename: rawTitle,
      code: 'DDL_DIRECT',
      mode: 'ddl_direct',
      ownerId: req.currentUser.userId,
      username: req.currentUser.username,
      role: req.currentUser.role,
      isOwner,
      isPremium: req.currentUser.isPremium,
      downloadFolder: ownerFolder || '',
      isPermanent: !!ownerFolder,
      status: 'resolving_ddl',
      progress: {
        percent: 15,
        speed: 'Connecting',
        eta: 'Locating direct cloud stream...',
        downloadedSize: '',
        totalSize: ''
      },
      logs: [`[Direct DDL] Enqueued direct cloud resolution for: ${rawTitle}`],
      error: null,
      startTime: Date.now(),
      completedTime: null,
      process: null
    };

    jobs.set(jobId, job);
    broadcastGlobalJobSync();
    broadcastJobUpdate(jobId);

    // Launch direct DDL resolver
    startDdlMovieResolver(job);

    res.json({
      success: true,
      jobId: job.id,
      title: job.title
    });
  } catch (err) {
    console.error('[Direct DDL] Resolve dispatch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Backward compatibility alias for resolve-ola
app.post('/api/movies/resolve-ola', (req, res, next) => {
  req.url = '/api/movies/resolve-ddl';
  app.handle(req, res, next);
});

// ==========================================================================
// Music & Album Hub Helpers & Endpoints (Multi-Format, Multi-Codec, Audiophile Studio)
// ==========================================================================

async function searchDirectMusic(query, page = 1) {
  try {
    const limit = 25;
    const offset = (page - 1) * limit;
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data || !Array.isArray(data.results)) return [];

    return data.results.map(it => {
      const durationSec = Math.round((it.trackTimeMillis || 0) / 1000);
      const m = Math.floor(durationSec / 60);
      const s = durationSec % 60;
      const durationStr = `${m}:${s < 10 ? '0' : ''}${s}`;
      const year = (it.releaseDate || '').substring(0, 4);
      let cover = it.artworkUrl100 || '';
      if (cover) {
        cover = cover.replace(/100x100bb\.jpg/i, '600x600bb.jpg');
      }

      return {
        id: `itunes_${it.trackId}`,
        trackId: it.trackId,
        title: it.trackName || 'Unknown Track',
        artist: it.artistName || 'Unknown Artist',
        album: it.collectionName || '',
        year: year || '',
        duration: durationSec,
        durationStr,
        cover,
        previewUrl: it.previewUrl || '',
        genre: it.primaryGenreName || '',
        type: 'track',
        source: 'track'
      };
    });
  } catch (e) {
    console.warn('[MusicSearch] iTunes search error:', e.message);
    return [];
  }
}

async function searchMusicTorrents(query) {
  try {
    const [flacRes, generalRes] = await Promise.allSettled([
      fetch(`https://apibay.org/q.php?q=${encodeURIComponent(query + ' flac')}&cat=100`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(6000)
      }),
      fetch(`https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=100`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(6000)
      })
    ]);

    const items = [];
    const seen = new Set();

    for (const r of [flacRes, generalRes]) {
      if (r.status === 'fulfilled' && r.value.ok) {
        try {
          const list = await r.value.json();
          if (Array.isArray(list) && list.length > 0 && list[0].name !== 'No results returned') {
            for (const it of list) {
              if (parseInt(it.seeders, 10) > 0 && !seen.has(it.info_hash)) {
                seen.add(it.info_hash);
                items.push(it);
              }
            }
          }
        } catch (e) {}
      }
    }

    items.sort((a, b) => (parseInt(b.seeders, 10) || 0) - (parseInt(a.seeders, 10) || 0));

    return items.slice(0, 20).map(it => {
      const sizeBytes = parseInt(it.size, 10) || 0;
      const sizeStr = sizeBytes > (1024 ** 3)
        ? (sizeBytes / (1024 ** 3)).toFixed(2) + ' GB'
        : (sizeBytes / (1024 ** 2)).toFixed(1) + ' MB';
      const hash = it.info_hash;
      const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(it.name)}&${BT_TRACKER_PARAMS}`;

      let cleanArtist = '';
      if (it.name.includes(' - ')) {
        cleanArtist = it.name.split(' - ')[0].trim();
      }

      return {
        id: `tpb_music_${hash}`,
        title: it.name,
        artist: cleanArtist || query,
        album: it.name,
        size: sizeStr,
        seeders: parseInt(it.seeders, 10) || 0,
        leechers: parseInt(it.leechers, 10) || 0,
        magnet,
        cover: '/icon.svg',
        type: 'torrent',
        source: 'torrent'
      };
    });
  } catch (e) {
    console.warn('[MusicSearch] Torrent search error:', e.message);
    return [];
  }
}

// Unified Music Search API
app.get('/api/music/search', identifyUser, async (req, res) => {
  try {
    if (!isFeatureAllowed(req.currentUser, 'music') && !isFeatureAllowed(req.currentUser, 'audiophile_flac')) {
      return res.status(403).json({
        success: false,
        results: [],
        total: 0,
        error: 'Music Hub is restricted for your role.',
        requireAuth: req.currentUser.role === 'guest'
      });
    }

    const q = (req.query.q || '').trim();
    const source = req.query.source || 'direct'; // 'direct' or 'albums'
    const format = req.query.format || 'all';
    const page = parseInt(req.query.page, 10) || 1;

    if (!q) {
      return res.json({ success: true, results: [], query: '', total: 0 });
    }

    let results = [];
    if (source === 'albums') {
      results = await searchMusicTorrents(q);
    } else {
      results = await searchDirectMusic(q, page);
      if (results.length === 0) {
        results = await searchMusicTorrents(q);
      }
    }

    res.json({
      success: true,
      query: q,
      source,
      format,
      page,
      count: results.length,
      results
    });
  } catch (err) {
    console.error('[MusicSearch] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Music 1-Click Multi-Format Download API
app.post('/api/music/download', identifyUser, async (req, res) => {
  try {
    const item = req.body || {};
    const {
      title, artist, album, duration, cover, format, quality, source, magnet, torrentUrl
    } = item;

    if (!title && !magnet) {
      return res.status(400).json({ success: false, error: 'Title or magnet link is required' });
    }

    const isTorrent = source === 'torrent' || !!magnet || !!torrentUrl;
    const requestedFormat = (format || 'mp3').toLowerCase();
    const requestedQuality = (quality || '320k').toLowerCase();
    const isFlac = requestedFormat === 'flac';

    // Role-based feature enforcement for Music Hub & Audiophile FLAC
    if (isFlac && !isFeatureAllowed(req.currentUser, 'audiophile_flac')) {
      return res.status(403).json({
        success: false,
        error: 'Lossless Audiophile FLAC downloads are restricted for your role. Please contact administrator.',
        requireAuth: req.currentUser.role === 'guest'
      });
    }
    if (!isFeatureAllowed(req.currentUser, 'music')) {
      return res.status(403).json({
        success: false,
        error: 'Music Hub downloads are restricted for your role.',
        requireAuth: req.currentUser.role === 'guest'
      });
    }


    if (isTorrent) {
      const jobPayload = {
        url: magnet || torrentUrl || '',
        magnet: magnet || '',
        torrentUrl: torrentUrl || '',
        title: (title || 'Music Album').replace(/[\\/:*?"<>|]/g, '_').trim(),
        poster: cover || '',
        code: 'MUSIC_ALBUM',
        mode: 'torrent',
        type: 'torrent',
        ownerId: req.currentUser.userId,
        username: req.currentUser.username,
        role: req.currentUser.role,
        isOwner: req.currentUser.isOwner || req.currentUser.role === 'owner' || req.currentUser.userId === 'owner' || req.currentUser.username === 'sakura',
        isPremium: req.currentUser.isPremium
      };
      const job = createAndStartJob(jobPayload);
      return res.json({
        success: true,
        jobId: job.id,
        title: job.title,
        type: 'torrent'
      });
    }

    // Direct Track / Release Download with multi-format & multi-codec dispatch
    const cleanArtist = (artist || '').trim();
    const cleanTitle = (title || '').trim();
    const fullName = cleanArtist ? `${cleanArtist} - ${cleanTitle}` : cleanTitle;

    const jobPayload = {
      title: fullName,
      artist: cleanArtist,
      trackTitle: cleanTitle,
      album: album || '',
      cover: cover || '',
      poster: cover || '',
      duration: duration || 0,
      code: isFlac ? 'FLAC_HIFI' : `AUDIO_${requestedFormat.toUpperCase()}`,
      mode: isFlac ? 'audiophile_flac' : 'audio',
      format: requestedFormat,
      quality: requestedQuality,
      audioFormat: isFlac ? 'flac' : requestedFormat,
      audioBitrate: requestedQuality === '320k' ? '320k' : (requestedQuality === '256k' ? '256k' : '160k'),
      type: 'audio',
      isMusicTrack: true,
      ownerId: req.currentUser.userId,
      username: req.currentUser.username,
      role: req.currentUser.role,
      isOwner: req.currentUser.isOwner || req.currentUser.role === 'owner' || req.currentUser.userId === 'owner' || req.currentUser.username === 'sakura',
      isPremium: req.currentUser.isPremium
    };

    const job = createAndStartJob(jobPayload);
    res.json({
      success: true,
      jobId: job.id,
      title: job.title,
      format: requestedFormat,
      quality: requestedQuality
    });
  } catch (err) {
    console.error('[MusicDownload] Dispatch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Unified Adult Search API
app.get('/api/adult/search', identifyUser, async (req, res) => {
  try {
    if (!isFeatureAllowed(req.currentUser, 'adult')) {
      return res.status(403).json({
        success: false,
        results: [],
        total: 0,
        error: 'Adult & JAV Hub is restricted for your role.',
        requireAuth: req.currentUser.role === 'guest'
      });
    }

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
      const [xvRes, phRes, epRes, rtRes, hqRes] = await Promise.allSettled([
        searchXVideos(q, page, duration),
        searchPornhub(q, page),
        searchEporner(q, page),
        searchRedTube(q, page),
        searchHQPorner(q, page)
      ]);
      const xv = xvRes.status === 'fulfilled' ? xvRes.value : [];
      const ph = phRes.status === 'fulfilled' ? phRes.value : [];
      const ep = epRes.status === 'fulfilled' ? epRes.value : [];
      const rt = rtRes.status === 'fulfilled' ? rtRes.value : [];
      const hq = hqRes.status === 'fulfilled' ? hqRes.value : [];
      const maxTube = Math.max(xv.length, ph.length, ep.length, rt.length, hq.length);
      for (let i = 0; i < maxTube; i++) {
        if (i < xv.length) tubeResults.push(xv[i]);
        if (i < ph.length) tubeResults.push(ph[i]);
        if (i < ep.length) tubeResults.push(ep[i]);
        if (i < rt.length) tubeResults.push(rt[i]);
        if (i < hq.length) tubeResults.push(hq[i]);
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

    for (const item of combined) {
      if (item.thumb && item.thumb.startsWith('http') && !item.thumb.startsWith('/api/proxy-image')) {
        item.thumb = `/api/proxy-image?url=${encodeURIComponent(item.thumb)}`;
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
app.post('/api/adult/download', identifyUser, async (req, res) => {
  try {
    const item = req.body || {};
    if (!isFeatureAllowed(req.currentUser, 'adult')) {
      return res.status(403).json({
        error: 'Adult & JAV Hub downloads are restricted for your role.',
        requireAuth: req.currentUser.role === 'guest'
      });
    }

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
      type: isTorrent ? 'torrent' : 'tube',
      ownerId: req.currentUser.userId,
      username: req.currentUser.username,
      role: req.currentUser.role,
      isOwner: req.currentUser.isOwner || req.currentUser.role === 'owner' || req.currentUser.userId === 'owner' || req.currentUser.username === 'sakura',
      isPremium: req.currentUser.isPremium
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
    '--bt-max-peers=200',
    '--bt-max-open-files=500',
    '--async-dns=true',
    '--bt-stop-timeout=600',
    '--summary-interval=1',
    '--enable-dht=true',
    '--bt-enable-lpd=true',
    '--enable-peer-exchange=true',
    '--peer-id-prefix=-qB4520-',
    '--user-agent=qBittorrent/4.5.2',
    '--bt-min-crypto-level=plain',
    '--bt-require-crypto=false',
    '--bt-request-peer-speed-limit=0',
    '--listen-port=6881-6999',
    '--dht-listen-port=6881-6999',
    `--max-overall-download-limit=${resolveUserBandwidthCap(job) || '0'}`,
    `--max-download-limit=${resolveUserBandwidthCap(job) || '0'}`,
    '--dht-entry-point=router.bittorrent.com:6881',
    '--dht-entry-point=dht.transmissionbt.com:6881',
    '--dht-entry-point=router.utorrent.com:6881',
    `--bt-tracker=${HIGH_SPEED_BT_TRACKERS.join(',')}`,
    '--file-allocation=none',
    '--disk-cache=64M',
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
      const lines = text.split(/[\r\n]+/).filter(Boolean);
      for (const line of lines) {
        const clean = stripAnsi(line).trim();
        if (!clean) continue;

        appendJobLog(job, clean);

        // Update real media filename if aria2c outputs file line
        const fileMatch = clean.match(/^FILE:\s*(?:\[MEMORY\]\[METADATA\])?\s*(.+)$/i);
        if (fileMatch) {
          const rawTarget = fileMatch[1].trim();
          const baseTarget = path.basename(rawTarget);
          if (baseTarget && !baseTarget.startsWith('.') && !baseTarget.endsWith('.aria2')) {
            if (/\.(mp4|mkv|avi|ts|mov|m4v|webm)$/i.test(baseTarget)) {
              job.filename = baseTarget;
              job.title = baseTarget;
            } else if (!job.title || job.title.includes('WEB-DL') || job.title.includes('Movie Media')) {
              job.title = baseTarget;
            }
          }
        }

        // Robust match for aria2c output with or without ETA / DL speed
        const m = clean.match(/\[#\w+\s+([\d.]+\s*[a-zA-Z]+)\/([\d.]+\s*[a-zA-Z]+)\((\d+)%\)(?:.*?DL:([\d.]+\s*[a-zA-Z]+))?(?:.*?ETA:([\w\d:]+))?/i);
        if (m) {
          job.progress.downloadedSize = m[1];
          job.progress.totalSize = m[2];
          job.progress.percent = parseInt(m[3], 10);
          job.progress.speed = m[4] ? m[4] + '/s' : '0 B/s';
          job.progress.eta = m[5] || (job.progress.percent === 0 ? 'Connecting...' : 'Calculating...');
          if (m[2] && (!job.filesize || job.filesize === 'Auto-Detect' || job.filesize.startsWith('~'))) {
            job.filesize = m[2];
          }
        } else if (clean.includes('METADATA')) {
          job.progress.eta = 'Resolving metadata...';
        }
      }
      scheduleJobUpdate(job.id, false);
    });

    child.stderr.on('data', data => {
      const text = stripAnsi(data.toString()).trim();
      if (text) {
        const errLines = text.split(/[\r\n]+/).filter(Boolean);
        for (const el of errLines) {
          appendJobLog(job, `[ERR] ${el}`);
        }
      }
      scheduleJobUpdate(job.id, false);
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

        finalizeJobPermanentStorage(job);
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

function startDirectHttpJob(job) {
  job.status = 'downloading';
  job.startTime = Date.now();
  job.progress.eta = 'Connecting to high-speed cloud stream...';
  job.progress.speed = '0 MB/s';
  job.logs.push('Starting Direct Cloud stream acceleration via aria2c (32 connections)...');
  broadcastJobUpdate(job.id);

  const ariaBin = process.platform === 'linux' ? '/usr/bin/aria2c' : 'aria2c';
  const outDir = TEMP_DIR;
  let rawBase = (job.filename || `${job.title}.mkv`).replace(/[\\/:*?"<>|]/g, '_');
  if (!rawBase.endsWith('.mkv') && !rawBase.endsWith('.mp4') && !rawBase.endsWith('.webm')) {
    rawBase += '.mkv';
  }
  const targetFilename = `${job.id}_${rawBase}`;

  const args = [
    '--dir=' + outDir,
    '--out=' + targetFilename,
    '--max-connection-per-server=16',
    '--split=32',
    '--min-split-size=1M',
    '--disk-cache=64M',
    '--stream-piece-selector=geom',
    '--connect-timeout=10',
    '--timeout=15',
    '--max-tries=5',
    '--retry-wait=2',
    '--async-dns=true',
    '--summary-interval=1',
    '--allow-overwrite=true',
    '--auto-file-renaming=false',
    '--file-allocation=none',
    '--check-certificate=false',
    '--header=User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    `--max-download-limit=${resolveUserBandwidthCap(job) || '0'}`,
    `--max-overall-download-limit=${resolveUserBandwidthCap(job) || '0'}`
  ];

  if (job.url && (job.url.includes('workers.dev') || job.url.includes('omd-'))) {
    args.push('--header=Referer: https://drive.google.com/');
  }

  args.push(job.url);

  try {
    const child = spawn(ariaBin, args, { windowsHide: true });
    job.process = child;
    job.pid = child.pid;
    attachProcessListeners(job, child);
  } catch (err) {
    job.status = 'failed';
    job.error = `Failed to start aria2c: ${err.message}`;
    broadcastJobUpdate(job.id);
    processDownloadQueue();
  }
}

async function startDdlMovieResolver(job) {
  job.status = 'resolving_ddl';
  job.startTime = Date.now();
  job.progress.percent = 20;
  job.progress.eta = 'Locating high-speed direct cloud stream...';
  job.progress.speed = 'Querying DDL mirrors';
  job.logs.push(`[Direct DDL] Resolving direct high-speed stream for: "${job.title}"...`);
  broadcastJobUpdate(job.id);

  try {
    const rawTitle = (job.opts && (job.opts.pureTitle || job.opts.title)) || job.title || '';
    const { title: cleanTitle, year: cleanYear } = extractCleanMovieTitle(rawTitle);
    const effectiveTitle = cleanTitle || rawTitle;
    let rawYear = (job.opts && job.opts.year) || cleanYear || '';
    // Handle year ranges like 2008-2015 -> extract start year 2008
    const startYearMatch = String(rawYear).match(/\b(19\d\d|20\d\d)\b/);
    const effectiveYear = startYearMatch ? startYearMatch[1] : '';

    const quality = ((job.opts && job.opts.quality) || '1080p').toLowerCase();
    const qTag = quality.includes('4k') || quality.includes('2160') ? '2160p' : (quality.includes('720') ? '720p' : '1080p');

    // Detect Season or Episode notation
    const combinedFullTitle = `${job.title} ${rawTitle} ${(job.opts && job.opts.title) || ''}`;
    let seTag = '';
    const seMatch = combinedFullTitle.match(/\b(S\d\d?E\d\d?)\b/i);
    if (seMatch) {
      seTag = seMatch[1].toUpperCase();
    } else {
      const seasonMatch = combinedFullTitle.match(/\b(?:Season\s*(\d+)|(S\d\d?))\b/i);
      if (seasonMatch) {
        seTag = seasonMatch[1] ? `Season ${seasonMatch[1]}` : seasonMatch[2].toUpperCase();
      }
    }

    job.logs.push(`[Direct DDL] Target Title: "${effectiveTitle}" | Quality: ${qTag.toUpperCase()}${seTag ? ` | Tag: ${seTag}` : ''}${effectiveYear ? ` | Year: ${effectiveYear}` : ''}`);

    // 1. If a direct HTTP/HTTPS media stream was already provided (not a search catalog or open archive)
    if (job.url && job.url.startsWith('http') && !job.url.includes('strem.io') && !job.url.includes('cinemeta') && !job.url.includes('archive.org')) {
      job.logs.push(`[Direct DDL] Direct stream link detected: ${job.url}`);
      job.mode = 'direct_http';
      startDirectHttpJob(job);
      return;
    }

    // 2. Query open internet cloud archives (e.g. Archive.org open collections API)
    job.progress.percent = 35;
    job.progress.eta = 'Checking direct cloud archives...';
    let directStreamUrl = null;
    if (!seTag) {
      try {
        const searchTerms = `${effectiveTitle} ${effectiveYear}`.trim();
        const iaUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(searchTerms)}+AND+mediatype%3Amovies&fl%5B%5D=identifier%2Ctitle&rows=5&page=1&output=json`;
        const iaRes = await fetch(iaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) });
        if (iaRes.ok) {
          const iaData = await iaRes.json();
          const docs = iaData?.response?.docs || [];
          for (const doc of docs) {
            const docId = doc.identifier || '';
            const docTitle = (doc.title || '').toLowerCase().trim();

            // 1. REJECT YouTube scrapes, teasers, trailers, clips, reviews, podcasts, satire
            if (docId.toLowerCase().startsWith('youtube-') || docId.toLowerCase().startsWith('yt-')) continue;
            if (/trailer|teaser|clip|sample|promo|review|reaction|podcast|satire|short|soundtrack|behind the scenes/i.test(docTitle)) continue;
            if (/trailer|teaser|clip|sample/i.test(docId)) continue;

            // 2. Strict title relevance: check that clean title words are present in docTitle
            const cleanTargetWords = effectiveTitle.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
            if (cleanTargetWords.length > 0) {
              const matchesAll = cleanTargetWords.every(w => docTitle.includes(w));
              if (!matchesAll) continue;
            }

            // 3. Inspect files in archive item
            const filesRes = await fetch(`https://archive.org/metadata/${docId}/files`, { signal: AbortSignal.timeout(3500) });
            if (filesRes.ok) {
              const filesData = await filesRes.json();
              const mp4s = (filesData?.result || []).filter(f => {
                if (!f.name || (!f.name.endsWith('.mp4') && !f.name.endsWith('.mkv') && !f.name.endsWith('.avi'))) return false;
                if (/trailer|sample|preview|clip|teaser/i.test(f.name)) return false;

                const sizeBytes = parseInt(f.size, 10) || 0;
                // STRICT REQUIREMENT: Real feature movies are 350 MB to 3+ GB.
                // Any 5MB-50MB video is a trailer, clip, or sample, NOT a movie!
                const minBytes = (qTag === '720p') ? 500 * 1024 * 1024 : (qTag === '1080p' ? 800 * 1024 * 1024 : 350 * 1024 * 1024);
                if (sizeBytes < minBytes) return false;

                // If duration (length in seconds) is provided, verify >= 40 minutes (2400s)
                if (f.length) {
                  const durSec = parseFloat(f.length) || 0;
                  if (durSec > 0 && durSec < 2400) return false;
                }

                return true;
              });

              if (mp4s.length > 0) {
                mp4s.sort((a, b) => (parseInt(b.size, 10) || 0) - (parseInt(a.size, 10) || 0));
                const bestFile = mp4s.find(f => f.name.toLowerCase().includes(qTag)) || mp4s[0];
                directStreamUrl = `https://archive.org/download/${docId}/${encodeURIComponent(bestFile.name)}`;
                const sizeMb = ((parseInt(bestFile.size, 10) || 0) / (1024 * 1024)).toFixed(1);
                job.logs.push(`[Direct DDL] Found verified direct archive mirror: ${bestFile.name} (${sizeMb} MB)`);
                job.title = bestFile.name;
                job.filename = bestFile.name;
                job.filesize = sizeMb > 1024 ? (sizeMb / 1024).toFixed(2) + ' GB' : sizeMb + ' MB';
                job.progress.totalSize = job.filesize;
                job.code = 'DDL_DIRECT';
                job.mode = 'direct_http';
                broadcastGlobalJobSync();
                broadcastJobUpdate(job.id);
                break;
              }
            }
          }
        }
      } catch (e) {
        job.logs.push(`[Direct DDL] Archive query note: ${e.message}`);
      }
    }

    if (directStreamUrl) {
      job.url = directStreamUrl;
      job.mode = 'direct_http';
      job.logs.push(`[Direct DDL] Launching 32-thread multi-connection Turbo download...`);
      startDirectHttpJob(job);
      return;
    }

    // 3. High-Speed Verified Swarm Fallback (YTS / 1337x / TPB)
    job.progress.percent = 60;
    job.progress.eta = 'Connecting to verified swarm stream...';
    job.logs.push(`[Direct DDL] Direct cloud mirror unindexed. Resolving verified high-speed release bitstream...`);

    const isCompleteSeries = /Complete\s*Series|All\s*Seasons|Box\s*Set|S01-S0\d/i.test(combinedFullTitle);

    const queriesToTry = [];
    if (isCompleteSeries) {
      queriesToTry.push(`${effectiveTitle} Complete Series`);
      queriesToTry.push(`${effectiveTitle} Season 1 2 3 4 5 6 7`);
      queriesToTry.push(`${effectiveTitle} Complete`);
      queriesToTry.push(effectiveTitle);
    } else if (seTag) {
      queriesToTry.push(`${effectiveTitle} ${seTag} ${qTag}`);
      queriesToTry.push(`${effectiveTitle} ${seTag}`);
      queriesToTry.push(`${effectiveTitle} ${qTag}`);
    } else {
      if (effectiveYear) {
        queriesToTry.push(`${effectiveTitle} ${effectiveYear} ${qTag}`);
        queriesToTry.push(`${effectiveTitle} ${effectiveYear}`);
      }
      queriesToTry.push(`${effectiveTitle} ${qTag}`);
      queriesToTry.push(effectiveTitle);
    }

    let candidates = [];
    for (const qStr of queriesToTry) {
      if (candidates.length > 0) break;
      try {
        const [ytsCandidates, tpbCandidates] = await Promise.allSettled([
          (!seTag) ? searchYtsMovies(qStr, 1) : Promise.resolve([]),
          searchApibayMovies(qStr)
        ]);

        if (ytsCandidates.status === 'fulfilled' && Array.isArray(ytsCandidates.value)) {
          for (const m of ytsCandidates.value) {
            for (const r of m.releases || []) {
              if (r.magnet || r.torrentUrl) candidates.push({ ...r, sourceTitle: m.title });
            }
          }
        }
        if (tpbCandidates.status === 'fulfilled' && Array.isArray(tpbCandidates.value)) {
          for (const m of tpbCandidates.value) {
            for (const r of m.releases || []) {
              if (r.magnet || r.torrentUrl) candidates.push({ ...r, sourceTitle: m.title });
            }
          }
        }
      } catch (e) {}
    }

    if (candidates.length > 0) {
      // Filter out any candidates with size under 250 MB (unless it's a TV episode where min is 100 MB)
      const minReleaseSize = seTag ? 100 * 1024 * 1024 : 250 * 1024 * 1024;
      candidates = candidates.filter(c => {
        const sz = c.sizeBytes || parseSizeToBytes(c.size);
        return sz === 0 || sz >= minReleaseSize;
      });

      let matched = candidates.filter(c => (c.quality || c.label || '').toLowerCase().includes(qTag));
      if (matched.length === 0) matched = candidates;
      matched.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
      const best = matched[0];

      const lockedName = best.filename || (best.sourceTitle ? `${best.sourceTitle} [${best.quality || '1080p'}]` : null);
      if (lockedName) {
        job.title = lockedName;
        job.filename = lockedName;
      }
      if (best.size) {
        job.filesize = best.size;
        job.progress.totalSize = best.size;
      }
      job.code = 'SWARM';
      job.mode = 'torrent';
      job.logs.push(`[Direct DDL] Stream locked: ${best.label || best.quality} (${best.seeders || 0} active seeders)${best.size ? ` [${best.size}]` : ''}`);
      job.opts = job.opts || {};
      job.opts.magnet = best.magnet;
      job.opts.torrentUrl = best.torrentUrl;
      job.opts.type = 'torrent';
      job.url = best.magnet || best.torrentUrl;
      broadcastGlobalJobSync();
      broadcastJobUpdate(job.id);
      startTorrentJob(job);
      return;
    }

    job.status = 'failed';
    job.error = `No active direct DDL cloud mirror or verified swarm stream found for "${effectiveTitle}".`;
    job.logs.push(`[Direct DDL] Stream resolution exhausted.`);
    broadcastJobUpdate(job.id);
    processDownloadQueue();
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    job.logs.push(`[Direct DDL Error] ${err.message}`);
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
  concurrentFragments = parseInt(concurrentFragments, 10) || 32;
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
  const isJioSaavn = url && (url.includes('jiosaavn.com') || url.includes('saavn.com'));

  if (isJioSaavn) {
    const pythonBin = getPythonBin();
    const saavnScript = path.join(__dirname, 'jiosaavn_engine.py');
    const isFlac = (mode === 'audio' && audioFormat === 'flac');
    const ext = isFlac ? 'flac' : (audioFormat || 'm4a');
    const safeTitle = (job.title || 'jiosaavn_track').replace(/[\\/:*?"<>|]/g, '_').trim();
    const finalOutPath = path.join(TEMP_DIR, `${job.id}_${safeTitle}.${ext}`);

    job.logs.push(`Starting JioSaavn High-Fidelity Music Engine...`);
    job.logs.push(`Target: ${url}`);

    const child = spawn(pythonBin, [
      saavnScript,
      url,
      finalOutPath,
      isFlac ? 'flac' : (audioFormat || 'auto')
    ], { 
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    });
    job.process = child;
    attachProcessListeners(job, child);
  } else if (isTikTok) {
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
  } else if (isYouTubeFlac || isDeezerFlac || (isTidal && isAudioFlac) || mode === 'audiophile_flac' || (mode === 'audio' && audioFormat === 'flac')) {
    const pythonBin = getPythonBin();
    const audiophileScript = path.join(__dirname, 'audiophile_flac_engine.py');
    const safeTitle = (job.title || 'audiophile_track').replace(/[\\/:*?"<>|]/g, '_').trim();
    const finalOutPath = path.join(TEMP_DIR, `${job.id}_${safeTitle}.flac`);

    let artist = (opts && opts.artist) || '';
    let trackTitle = (opts && opts.trackTitle) || '';
    if (!artist || !trackTitle) {
      if (job.title && job.title.includes(' - ')) {
        const parts = job.title.split(' - ');
        if (!artist) artist = parts[0].trim();
        if (!trackTitle) trackTitle = parts.slice(1).join(' - ').trim();
      } else {
        if (!trackTitle) trackTitle = job.title || '';
        if (!artist) artist = job.uploader || '';
      }
    }

    const targetQuality = (opts && (opts.quality || opts.audioBitrate)) ? String(opts.quality || opts.audioBitrate) : 'auto';
    job.logs.push(`Lossless FLAC requested: "${job.title}" (Quality: ${targetQuality})`);
    job.logs.push(`Initiating 3-Tier Audiophile Resolution Pipeline (Tidal Hi-Res → Soulseek P2P → Deezer HiFi)...`);
    job.logs.push(`Strict Quality Guarantee: Fake/upscaled transcodes prohibited; full spectral authenticity analysis will be enforced.`);

    const flacArgs = [
      audiophileScript,
      artist,
      trackTitle,
      finalOutPath,
      (opts && opts.isrc) || 'None',
      (opts && (opts.cover || opts.poster)) || 'None',
      (opts && opts.duration) ? String(opts.duration) : 'None',
      targetQuality
    ];

    const child = spawn(pythonBin, flacArgs, { 
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
    const isRateLimitedHost = (url && (url.includes('googleusercontent') || url.includes('turbovid') || url.includes('turboviplay') || url.includes('turbosplayer') || url.includes('lh3.google'))) ||
                              (rawTarget && (rawTarget.includes('googleusercontent') || rawTarget.includes('turbovid') || rawTarget.includes('turboviplay') || rawTarget.includes('turbosplayer') || rawTarget.includes('lh3.google')));

    let concurrentFragments = parseInt(opts.concurrentFragments, 10) || engineConfig.aria2cFragments || 32;
    if (isRateLimitedHost) {
      // Google User Content and Turbovid aggressively rate-limit (HTTP 429) when blasted with high concurrency
      concurrentFragments = Math.min(concurrentFragments, 2);
    } else {
      // Cap general HLS fragment concurrency to 6 to prevent server-side 429 rate limit errors
      concurrentFragments = Math.min(concurrentFragments, 6);
    }

    const outputTemplate = path.join(TEMP_DIR, `${job.id}_${job.title}.%(ext)s`);
    const args = [
      '--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      '--concurrent-fragments', String(concurrentFragments),
      '--buffer-size', engineConfig.bufferSize || '32M',
      '--retries', String(isRateLimitedHost ? 30 : (engineConfig.retries || 15)),
      '--fragment-retries', String(isRateLimitedHost ? 50 : 30),
      '--retry-sleep', 'fragment:exp=1:20',
      '--retry-sleep', 'http:exp=1:20',
      '--socket-timeout', isRateLimitedHost ? '30' : '20',
      '--hls-use-mpegts',
      '--newline',
      '--no-skip-unavailable-fragments',
      '--abort-on-unavailable-fragment',
      '--js-runtimes', process.platform === 'win32' ? 'node' : (fs.existsSync('/usr/bin/node') ? 'node:/usr/bin/node' : 'node'),
      '-o', outputTemplate
    ];

    const effectiveChunk = (engineConfig.httpChunkSize && engineConfig.httpChunkSize !== 'default' && engineConfig.httpChunkSize !== 'none')
      ? engineConfig.httpChunkSize
      : '16M';
    args.push('--http-chunk-size', effectiveChunk);

    const bwCap = resolveUserBandwidthCap(job);
    if (bwCap) {
      args.push('--limit-rate', bwCap);
    }

    // Never force aria2c on YouTube or tokenized streaming sites (causes 403 Forbidden & severe throttling)
    const isDirectMediaUrl = (url && /\.(mp4|mkv|webm|avi|mov|flv|ts|mp3|flac|wav|m4a)(\?|$)/i.test(url)) || (rawTarget && /\.(mp4|mkv|webm|avi|mov|flv|ts|mp3|flac|wav|m4a)(\?|$)/i.test(rawTarget));
    const allowAria2c = !isYouTube && (isDirectMediaUrl || (opts.customArgs && opts.customArgs.includes('aria2c')));

    if (process.platform === 'linux' && allowAria2c) {
      try {
        execSync('which aria2c', { stdio: 'ignore' });
        const frag = engineConfig.aria2cFragments || 32;
        const split = engineConfig.aria2cMinSplitSize || '1M';
        const ariaLimitStr = bwCap ? ` --max-download-limit=${bwCap}` : '';
        args.push('--downloader', 'http,https:aria2c');
        args.push('--downloader-args', `aria2c:-s ${frag} -x 16 -k 1M -j ${frag} --disk-cache=64M --min-split-size=${split} --summary-interval=1${ariaLimitStr}`);
      } catch (e) {}
    } else if (process.platform === 'win32') {
      args.push('--impersonate', 'chrome');
    }

    if (tools.ffmpegDir) {
      args.unshift(tools.ffmpegDir);
      args.unshift('--ffmpeg-location');
    }

    // Dynamic Referers for JAV streaming CDNs & adult networks
    if (opts.referer || job.referer) {
      args.push('--add-header', `Referer: ${opts.referer || job.referer}`);
    } else if (rawTarget.includes('phncdn.com') || (url && url.includes('pornhub'))) {
      args.push('--add-header', 'Referer: https://www.pornhub.com/');
    } else if (rawTarget.includes('surrit.com') || rawTarget.includes('sixyik.com') || (url && url.includes('missav'))) {
      args.push('--add-header', 'Referer: https://missav.ws/');
    } else if (rawTarget.includes('mushroomtrack.com') || (url && url.includes('jable.tv'))) {
      args.push('--add-header', 'Referer: https://en.jable.tv/');
    } else if (rawTarget.includes('turbovid') || rawTarget.includes('turboviplay') || rawTarget.includes('turbosplayer')) {
      args.push('--add-header', 'Referer: https://turboviplay.com/');
    } else if ((url && url.includes('javgg')) || rawTarget.includes('javstream') || rawTarget.includes('cdn-centaurus') || rawTarget.includes('earnvid') || rawTarget.includes('acek-cdn')) {
      args.push('--add-header', 'Referer: https://javgg.net/');
    } else if (url && (url.includes('supjav') || url.includes('supremejav'))) {
      args.push('--add-header', 'Referer: https://supjav.com/');
    } else if (url && url.includes('njav')) {
      args.push('--add-header', 'Referer: https://njav.tv/');
    } else if (url && (url.includes('xvideos') || url.includes('xnxx'))) {
      args.push('--add-header', 'Referer: https://www.xvideos.com/');
    } else if (url && url.includes('xhamster')) {
      args.push('--add-header', 'Referer: https://xhamster.com/');
    } else if (url && (url.includes('k-mib.com') || url.includes('kmib') || rawTarget.includes('kollus.com') || rawTarget.includes('charlla.video'))) {
      args.push('--add-header', 'Referer: https://k-mib.com/index.php');
    } else if (url && (url.includes('eporner.com') || rawTarget.includes('eporner.com'))) {
      args.push('--add-header', 'Referer: https://www.eporner.com/');
    } else if (url && (url.includes('netflav.com') || rawTarget.includes('netflav.com'))) {
      args.push('--add-header', 'Referer: https://netflav.com/');
    } else if (url && (url.includes('redtube.com') || rawTarget.includes('redtube.com') || rawTarget.includes('rdtcdn.com'))) {
      args.push('--add-header', 'Referer: https://www.redtube.com/');
    } else if (url && (url.includes('hqporner.com') || rawTarget.includes('hqporner.com') || rawTarget.includes('mydaddy.cc') || rawTarget.includes('bigcdn.cc'))) {
      args.push('--add-header', 'Referer: https://mydaddy.cc/');
    } else if (url && (url.includes('beeg.com') || rawTarget.includes('beeg.com'))) {
      args.push('--add-header', 'Referer: https://beeg.com/');
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
      if (videoQuality && videoQuality !== 'best') {
        const maxHeight = parseInt(videoQuality, 10);
        args.push('-f', `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`);
      } else {
        args.push('-f', 'bestvideo+bestaudio/best');
      }
      args.push('--merge-output-format', targetFmt);
      if (targetFmt === 'mp4') {
        args.push('--postprocessor-args', 'Merger:-movflags +faststart');
      }
    }

    // Subtitles (only for video)
    if (embedSubtitles && mode !== 'audio') {
      args.push('--embed-subs');
      let requestedLangs = (subLangs && subLangs.trim()) ? subLangs.trim() : 'en,hi,ja';

      if (autoSubs) {
        args.push('--write-auto-subs');
      }

      // Sanitize requested languages to prevent YouTube HTTP 429 rate limit errors:
      // YouTube generates ~150 auto-translated language combinations (e.g. en-ar, en-zh, hi-ar, ja-ar).
      // If broad wildcards like 'en.*' are passed, yt-dlp queries 50+ VTT tracks sequentially,
      // triggering HTTP 429 Too Many Requests, multiple warnings, and stalling the download.
      let cleanLangs = requestedLangs
        .replace(/\ben\.\*/gi, 'en,en-US,en-GB')
        .replace(/\bhi\.\*/gi, 'hi,hi-IN')
        .replace(/\bja\.\*/gi, 'ja,ja-JP')
        .replace(/\bzh\.\*/gi, 'zh,zh-TW,zh-CN,zh-Hans,zh-Hant')
        .replace(/\bes\.\*/gi, 'es,es-ES,es-419')
        .replace(/\bfr\.\*/gi, 'fr,fr-FR')
        .replace(/\bde\.\*/gi, 'de,de-DE')
        .replace(/\bko\.\*/gi, 'ko,ko-KR');

      if (cleanLangs === 'all' || cleanLangs === 'all,-live_chat') {
        cleanLangs = 'en,hi,ja,zh,es,fr,de,ko';
      }

      // Deduplicate tokens and trim
      const langTokens = [...new Set(cleanLangs.split(',').map(s => s.trim()).filter(Boolean))];
      args.push('--sub-langs', langTokens.join(','));
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
    let targetUrl = (isJable && hlsUrl) ? hlsUrl : (downloadTargetUrl || url);
    if (opts.isMusicTrack && (!targetUrl || !targetUrl.startsWith('http'))) {
      const qArtist = (opts.artist || '').trim();
      const qTitle = (opts.trackTitle || opts.title || '').trim();
      targetUrl = `ytsearch1:${qArtist} - ${qTitle} audio`;
    }
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

  const parseProgress = (cleanLine) => {
    const line = cleanLine;
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

    // Telegram / Torrent / Swarm progress matching
    const tgMatch = line.match(/(?:Progress|Swarm Progress):\s*([\d.]+)%(?:\s*\(([\d.]+\s*[a-zA-Z/]+)\))?/i);
    if (tgMatch) {
      job.progress.percent = parseFloat(tgMatch[1]) || 0;
      if (tgMatch[2]) job.progress.speed = tgMatch[2];
      job.progress.eta = (job.progress.percent >= 100) ? 'Ready' : 'Downloading...';
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

    // Post-processing and stage detection for accurate user ETA / speed indicators
    if (line.includes('[ExtractAudio]') || (line.includes('Destination:') && line.endsWith('.mp3'))) {
      job.progress.eta = 'Extracting audio...';
      job.progress.speed = 'Encoding';
      return;
    }
    if (line.includes('[Metadata]') || line.includes('Adding metadata')) {
      job.progress.eta = 'Adding metadata...';
      job.progress.speed = 'Tagging';
      return;
    }
    if (line.includes('[ThumbnailsConvertor]') || line.includes('[EmbedThumbnail]')) {
      job.progress.eta = 'Embedding cover art...';
      job.progress.speed = 'Art';
      return;
    }
    if (line.includes('[Merger]') || line.includes('Merging formats')) {
      job.progress.eta = 'Merging streams...';
      job.progress.speed = 'Muxing';
      return;
    }
    if (line.includes('[FixupM3u8]') || line.includes('[FixupM4a]')) {
      job.progress.eta = 'Finalizing container...';
      job.progress.speed = 'Processing';
      return;
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

  const handleLogLine = (rawLine, isErr = false) => {
    const clean = stripAnsi(rawLine).trim();
    if (!clean) return;
    const finalLine = isErr && !clean.startsWith('[ERR]') ? `[ERR] ${clean}` : clean;
    parseProgress(clean);
    appendJobLog(job, finalLine);
  };

  child.stdout.on('data', (data) => {
    const lines = data.toString().split(/[\r\n]+/).filter(Boolean);
    for (const line of lines) {
      handleLogLine(line, false);
    }
    scheduleJobUpdate(jobId, false);
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().split(/[\r\n]+/).filter(Boolean);
    for (const line of lines) {
      handleLogLine(line, true);
    }
    scheduleJobUpdate(jobId, false);
  });

  child.on('close', (code) => {
    job.completedTime = Date.now();
    job.process = null;

    if (job.status === 'paused') {
      job.isSuspended = false;
      job.logs.push('Download paused. State preserved for resumption.');
      scheduleJobUpdate(jobId, true);
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
            finalizeJobPermanentStorage(job);
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
    scheduleJobUpdate(jobId, true);
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

  const ext = (mode === 'audio' || mode === 'audiophile_flac') ? (audioFormat || (mode === 'audiophile_flac' ? 'flac' : 'mp3')) : (videoFormat && videoFormat !== 'auto' ? videoFormat : 'mp4');
  const finalFilename = `${safeTitle}.${ext}`;
  const filePath = path.join(TEMP_DIR, `${jobId}_${finalFilename}`);
  const isPremium = !!opts.isPremium;
  const isOwner = !!(opts.isOwner || opts.role === 'owner' || opts.ownerId === 'owner' || opts.username === 'sakura');
  const role = opts.role || (isOwner ? 'owner' : (isPremium ? 'premium' : 'user'));
  const username = opts.username || (isOwner ? 'sakura' : 'User');
  const ownerId = opts.ownerId || 'guest';
  const assignedFolder = (opts.downloadFolder && typeof opts.downloadFolder === 'string' && opts.downloadFolder.trim() && opts.downloadFolder.trim() !== '*')
    ? path.resolve(opts.downloadFolder.trim())
    : getUserDownloadFolder(ownerId);

  const initialLogs = [];
  if (isOwner) {
    initialLogs.push('🌟 Priority Bandwidth: Uncapped (Owner Access)');
  } else {
    const bwCap = resolveUserBandwidthCap({ ...opts, isOwner, isPremium, role, username, ownerId });
    if (bwCap) {
      initialLogs.push(`⚡ Bandwidth Allocation: Capped at ${bwCap} (${isPremium ? 'Premium Tier' : (role === 'guest' ? 'Guest Tier' : 'Standard Member Tier')})`);
    } else {
      initialLogs.push('⚡ Bandwidth Allocation: Uncapped (Full Pipe Speed)');
    }
  }
  if (assignedFolder) {
    const category = getJobCategory(opts);
    const subfolderName = CATEGORY_SUBFOLDERS[category] || 'Links';
    initialLogs.push(`📁 Permanent Storage [${subfolderName}]: Destination routed to ${path.join(assignedFolder, subfolderName)}`);
  }

  const job = {
    id: jobId,
    url,
    opts,
    title: safeTitle,
    code: code || 'MEDIA',
    poster: poster || '',
    mode,
    ownerId,
    username,
    role,
    isOwner,
    isPremium,
    downloadFolder: assignedFolder || '',
    isPermanent: !!assignedFolder,
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
    logs: initialLogs,
    error: null,
    startTime: Date.now(),
    completedTime: null,
    process: null
  };

  jobs.set(jobId, job);
  broadcastGlobalJobSync();

  // Check if we can start immediately or queue
  if (getActiveDownloadCount() < getMaxConcurrentDownloads()) {
    if (job.opts && (job.opts.magnet || job.opts.torrentUrl || job.opts.type === 'torrent')) {
      startTorrentJob(job);
    } else if (job.url && (job.url.includes('workers.dev') || job.mode === 'direct_http')) {
      startDirectHttpJob(job);
    } else if (job.mode === 'ddl_direct' || job.status === 'resolving_ddl') {
      startDdlMovieResolver(job);
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
app.post('/api/download', identifyUser, async (req, res) => {
  try {
    const payload = req.body || {};
    let { url, title } = payload;

    if (!url) return res.status(400).json({ error: 'URL is required' });

    // Role-based feature checks
    if (!isFeatureAllowed(req.currentUser, 'downloader')) {
      return res.status(403).json({
        error: 'Media Downloader is disabled for your role. Please contact administrator.',
        requireAuth: req.currentUser.role === 'guest'
      });
    }

    // 1. Lossless Audio check: FLAC / WAV
    const audioFmt = (payload.audioFormat || '').toLowerCase();
    if ((audioFmt === 'flac' || audioFmt === 'wav' || payload.mode === 'audiophile_flac') && !isFeatureAllowed(req.currentUser, 'audiophile_flac')) {
      return res.status(403).json({
        error: 'Lossless Studio Master FLAC and Uncompressed WAV are restricted for your role. Please upgrade or contact administrator.',
        requireAuth: req.currentUser.role === 'guest'
      });
    }

    // 2. Video quality check: 4K & 8K vs 1080p / 720p
    const vidQ = String(payload.videoQuality || '').toLowerCase();
    if (['4320', '2160', '1440', 'best'].includes(vidQ) && !isFeatureAllowed(req.currentUser, 'quality_4k')) {
      payload.videoQuality = req.currentUser.role === 'guest' ? '720' : '1080';
      payload.qualityNotice = `Resolution capped at ${payload.videoQuality}p for your role. 4K/8K Ultra HD is restricted.`;
    } else if (req.currentUser.role === 'guest' && ['1080', 'best'].includes(vidQ)) {
      payload.videoQuality = '720';
      payload.qualityNotice = 'Resolution capped at 720p HD for Guest. Sign in to download in Full HD & 4K Ultra HD.';
    }

    // 3. Concurrency check: max 1 active download if unlimited_concurrency is not allowed
    if (!isFeatureAllowed(req.currentUser, 'unlimited_concurrency')) {
      let activeGuestJobs = 0;
      for (const j of jobs.values()) {
        if (['downloading', 'processing', 'resolving', 'queued'].includes(j.status) && j.ownerId === req.currentUser.userId) {
          activeGuestJobs++;
        }
      }
      if (activeGuestJobs >= 1) {
        return res.status(429).json({
          error: 'Concurrency limit reached: only 1 active download at a time is permitted for your role.',
          requireAuth: req.currentUser.role === 'guest'
        });
      }
    }

    // 4. Daily quota check for guests (10 downloads)
    if (req.currentUser.role === 'guest') {
      const dailyCount = getGuestDailyDownloads(req.currentUser.ip);
      if (dailyCount >= 10) {
        return res.status(429).json({
          error: 'Guest daily download quota reached (10/10). Please sign in or register to enjoy unlimited high-speed downloads.',
          requireAuth: true
        });
      }
      incrementGuestDailyDownloads(req.currentUser.ip);
    }

    payload.ownerId = req.currentUser.userId;
    payload.username = req.currentUser.username;
    payload.role = req.currentUser.role;
    payload.isOwner = req.currentUser.isOwner || req.currentUser.role === 'owner' || req.currentUser.userId === 'owner' || req.currentUser.username === 'sakura';
    payload.isPremium = req.currentUser.isPremium;

    if (payload.downloadFolder && typeof payload.downloadFolder === 'string' && payload.downloadFolder.trim()) {
      const reqPath = path.resolve(payload.downloadFolder.trim());
      const isOwner = req.currentUser.isOwner;
      const allowedList = (req.currentUser.allowedFolders || []).map(f => path.resolve(f));
      const userAssigned = getUserDownloadFolder(req.currentUser.userId);
      if (userAssigned) allowedList.push(path.resolve(userAssigned));

      const isAuthorized = isOwner || allowedList.some(f => reqPath === f || reqPath.startsWith(f + path.sep));
      if (isAuthorized) {
        payload.downloadFolder = reqPath;
      } else {
        delete payload.downloadFolder;
      }
    }

    const isDirectStream = url.includes('workers.dev') || url.includes('archive.org');

    if (isDirectStream) {
      payload.mode = 'direct_http';
      payload.type = 'direct_http';
    }

    if (!title && !isDirectStream) {
      try {
        const meta = await extractMetadata(url);
        payload.hlsUrl = meta.hlsUrl;
        payload.title = meta.title;
        payload.code = meta.code;
        payload.poster = meta.poster;
        payload.downloadTargetUrl = meta.downloadTargetUrl;
        if (meta.referer) payload.referer = meta.referer;
      } catch (e) {}
    }

    const job = createAndStartJob(payload);
    res.json({
      success: true,
      jobId: job.id,
      title: job.title,
      filename: job.filename,
      mode: job.mode,
      qualityNotice: payload.qualityNotice || null
    });
  } catch (err) {
    console.error('Download dispatch error:', err);
    res.status(500).json({ error: err.message || 'Failed to initialize download' });
  }
});

// 3. Batch Download
app.post('/api/batch-download', identifyUser, async (req, res) => {
  try {
    let { urls, ...opts } = req.body || {};
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'No URLs provided' });
    }

    if (!isFeatureAllowed(req.currentUser, 'batch')) {
      return res.status(403).json({
        error: 'Batch Downloader is disabled for your role. Please contact administrator.',
        requireAuth: req.currentUser.role === 'guest'
      });
    }

    let cappedNotice = null;
    if (req.currentUser.role === 'guest' && urls.length > 2) {
      urls = urls.slice(0, 2);
      cappedNotice = 'Guest batch download capped at 2 URLs. Sign in to process unlimited links at once.';
    }

    const audioFmt = (opts.audioFormat || '').toLowerCase();
    if ((audioFmt === 'flac' || audioFmt === 'wav' || opts.mode === 'audiophile_flac') && !isFeatureAllowed(req.currentUser, 'audiophile_flac')) {
      return res.status(403).json({
        error: 'Lossless Studio FLAC batch downloads are restricted for your role. Please upgrade or contact administrator.',
        requireAuth: req.currentUser.role === 'guest'
      });
    }

    if (['4320', '2160', '1440', 'best'].includes(String(opts.videoQuality || '').toLowerCase()) && !isFeatureAllowed(req.currentUser, 'quality_4k')) {
      opts.videoQuality = req.currentUser.role === 'guest' ? '720' : '1080';
    } else if (req.currentUser.role === 'guest' && ['1080', 'best'].includes(String(opts.videoQuality || '').toLowerCase())) {
      opts.videoQuality = '720';
    }

    if (req.currentUser.role === 'guest') {
      incrementGuestDailyDownloads(req.currentUser.ip);
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
        downloadTargetUrl: meta ? meta.downloadTargetUrl : '',
        referer: (meta && meta.referer) ? meta.referer : '',
        ownerId: req.currentUser.userId,
        username: req.currentUser.username,
        role: req.currentUser.role,
        isOwner: req.currentUser.isOwner || req.currentUser.role === 'owner' || req.currentUser.userId === 'owner' || req.currentUser.username === 'sakura',
        isPremium: req.currentUser.isPremium
      };

      const job = createAndStartJob(jobOpts);
      createdJobs.push({
        id: job.id,
        url: trimmed,
        title: job.title,
        filename: job.filename
      });
    }

    res.json({ success: true, count: createdJobs.length, jobs: createdJobs, notice: cappedNotice });
  } catch (err) {
    console.error('Batch error:', err);
    res.status(500).json({ error: err.message || 'Failed to process batch' });
  }
});

// 4. SSE Events Stream with Keep-Alive Heartbeat
app.get('/api/jobs/:id/events', identifyUser, (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);

  if (!job) return res.status(404).send('Job not found');

  if (job.ownerId && job.ownerId !== req.currentUser.userId && !req.currentUser.isOwner) {
    return res.status(403).send('Forbidden: Access denied to job events');
  }

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

// On-demand job logs endpoint
app.get('/api/jobs/:id/logs', identifyUser, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.ownerId && job.ownerId !== req.currentUser.userId && !req.currentUser.isOwner) {
    return res.status(403).json({ error: 'Forbidden: Access denied to job logs' });
  }
  const cleanLogs = (job.logs || []).map(stripAnsi);
  res.json({ id: job.id, logs: cleanLogs, lastLog: cleanLogs[cleanLogs.length - 1] || '' });
});

// Get jobs filtered by authenticated user or owner
app.get('/api/jobs', identifyUser, (req, res) => {
  const showAll = req.query.all === '1' && req.currentUser.isOwner;
  const list = getJobsForUser(req.currentUser, { all: showAll, detailed: true });
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
app.post('/api/jobs/:id/pause', identifyUser, (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.ownerId && job.ownerId !== req.currentUser.userId && !req.currentUser.isOwner) {
    return res.status(403).json({ error: 'Permission denied: job belongs to another user' });
  }

  const ok = pauseJob(job);
  if (ok) {
    broadcastGlobalJobSync();
    res.json({ success: true, status: 'paused' });
  } else {
    res.status(400).json({ error: `Cannot pause job with status: ${job.status}` });
  }
});

// 6. Resume Job Endpoint
app.post('/api/jobs/:id/resume', identifyUser, (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.ownerId && job.ownerId !== req.currentUser.userId && !req.currentUser.isOwner) {
    return res.status(403).json({ error: 'Permission denied: job belongs to another user' });
  }

  const ok = resumeJob(job);
  if (ok) {
    broadcastGlobalJobSync();
    res.json({ success: true, status: job.status });
  } else {
    res.status(400).json({ error: `Cannot resume job with status: ${job.status}` });
  }
});

// 7. Pause All Jobs Endpoint
app.post('/api/jobs/pause-all', identifyUser, (req, res) => {
  let count = 0;
  for (const job of jobs.values()) {
    if ((job.ownerId || 'owner') === req.currentUser.userId || (req.query.all === '1' && req.currentUser.isOwner)) {
      if (job.status === 'downloading' || job.status === 'queued') {
        if (pauseJob(job)) count++;
      }
    }
  }
  if (count > 0) broadcastGlobalJobSync();
  res.json({ success: true, pausedCount: count });
});

// 8. Resume All Jobs Endpoint
app.post('/api/jobs/resume-all', identifyUser, (req, res) => {
  let count = 0;
  for (const job of jobs.values()) {
    if ((job.ownerId || 'owner') === req.currentUser.userId || (req.query.all === '1' && req.currentUser.isOwner)) {
      if (job.status === 'paused') {
        if (resumeJob(job)) count++;
      }
    }
  }
  if (count > 0) broadcastGlobalJobSync();
  res.json({ success: true, resumedCount: count });
});

// 9. Cancel Job (Tree termination & partial cleanup)
app.post('/api/jobs/:id/cancel', identifyUser, (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.ownerId && job.ownerId !== req.currentUser.userId && !req.currentUser.isOwner) {
    return res.status(403).json({ error: 'Permission denied: job belongs to another user' });
  }

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
app.delete('/api/jobs/:id', identifyUser, (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);

  if (job && job.ownerId && job.ownerId !== req.currentUser.userId && !req.currentUser.isOwner) {
    return res.status(403).json({ error: 'Permission denied: job belongs to another user' });
  }

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

  // 2. Remove specific job.filePath ONLY if it is still a temporary unfinalized download (NEVER if permanent!)
  try {
    if (job && job.filePath && !job.isPermanent && !isPermanentUserFile(job.filePath) && fs.existsSync(job.filePath)) {
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
  broadcastGlobalJobSync();
  processDownloadQueue();
  res.json({ success: true, message: 'Job deleted' });
});

// Clear All Inactive Jobs (Filtered by User or Server-Wide if Owner with ?all=1)
app.delete('/api/jobs', identifyUser, (req, res) => {
  const clearAll = req.query.all === '1' && req.currentUser.isOwner;
  const targetUserId = req.currentUser.userId;

  for (const [id, job] of jobs.entries()) {
    const jobOwner = job.ownerId || 'owner';
    if (!clearAll && jobOwner !== targetUserId) continue;

    if (job.status !== 'downloading' && job.status !== 'queued' && job.status !== 'paused') {
      try {
        const jobDir = path.join(TEMP_DIR, id);
        if (fs.existsSync(jobDir)) {
          fs.rmSync(jobDir, { recursive: true, force: true });
        }
        if (job.filePath && !job.isPermanent && !isPermanentUserFile(job.filePath) && fs.existsSync(job.filePath)) {
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
  broadcastGlobalJobUpdate();
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

// Periodic cleanup of temp files and parts folders older than 2 hours (exempting permanent user files)
setInterval(() => {
  try {
    const now = Date.now();
    const files = fs.readdirSync(TEMP_DIR);
    for (const f of files) {
      const full = path.join(TEMP_DIR, f);
      if (isPermanentUserFile(full)) continue;
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

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 Universal Downloader Web Service is running!`);
  console.log(`🌐 Server listening on http://0.0.0.0:${PORT}`);
  console.log(`====================================================`);
  startEmbeddedSlskd();
});

// Configure Node.js HTTP server keepAlive timeouts for Cloudflare Tunnel / Reverse Proxies
server.keepAliveTimeout = 65000; // 65 seconds (longer than Cloudflare 60s window)
server.headersTimeout = 66000;   // Must exceed keepAliveTimeout
