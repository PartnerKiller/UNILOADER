const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// In-memory TTL Cache (10 minutes)
const metaCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function getCachedMetadata(url) {
  const entry = metaCache.get(url);
  if (entry) {
    if (Date.now() < entry.expiresAt) {
      return entry.data;
    }
    metaCache.delete(url);
  }
  return null;
}

function setCachedMetadata(url, data) {
  if (!data || !data.title) return;
  // Cap cache size to 500 items to prevent RAM growth
  if (metaCache.size > 500) {
    const firstKey = metaCache.keys().next().value;
    metaCache.delete(firstKey);
  }
  metaCache.set(url, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}

function getYtDlpPath() {
  if (process.platform !== 'win32') {
    if (fs.existsSync('/usr/local/bin/yt-dlp')) return '/usr/local/bin/yt-dlp';
    if (fs.existsSync('/usr/bin/yt-dlp')) return '/usr/bin/yt-dlp';
    return 'yt-dlp';
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\sayan', 'AppData', 'Local');
  const candidates = [
    path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe', 'yt-dlp.exe'),
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
    'yt-dlp'
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'yt-dlp';
}

function getPythonBin() {
  if (process.platform !== 'win32') return 'python3';
  const candidates = [
    path.join(process.env.LOCALAPPDATA || 'C:\\Users\\sayan\\AppData\\Local', 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(process.env.LOCALAPPDATA || 'C:\\Users\\sayan\\AppData\\Local', 'Programs', 'Python', 'Python311', 'python.exe'),
    'python',
    'py'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'python';
}

function runPythonFetcherAsync(pyBin, scriptPath, url, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(pyBin, [scriptPath, url], { windowsHide: true });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) {}
      reject(new Error('Python fetcher timed out'));
    }, timeoutMs);

    child.stdout.on('data', (d) => stdout += d.toString());
    child.stderr.on('data', (d) => stderr += d.toString());

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        try {
          const match = stdout.match(/\{[\s\S]*\}/);
          if (match) {
            const json = JSON.parse(match[0]);
            if (json && !json.error && json.title) {
              return resolve(json);
            }
          }
        } catch (e) {}
      }
      reject(new Error(stderr.trim() || `Python fetcher exited with code ${code}`));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function runYtDlpDumpAsync(ytdlpPath, url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-single-json',
      '--skip-download',
      '--no-warnings',
      '--no-playlist',
      '--extractor-args', 'youtube:player_client=android,web',
      '--js-runtimes', process.platform === 'win32' ? 'node' : 'node:/usr/bin/node',
      url
    ];

    if (process.platform === 'win32') {
      args.splice(4, 0, '--impersonate', 'chrome');
    }

    const child = spawn(ytdlpPath, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) {}
      reject(new Error('yt-dlp extraction timed out'));
    }, timeoutMs);

    child.stdout.on('data', (d) => stdout += d.toString());
    child.stderr.on('data', (d) => stderr += d.toString());

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        return reject(new Error(stderr.trim() || `Failed to extract video info (code ${code})`));
      }

      try {
        const info = JSON.parse(stdout);
        const title = info.fulltitle || info.title || 'video_' + Date.now();
        const codeId = info.display_id || info.id || (url.includes('pornhub') ? (url.match(/viewkey=([^&]+)/) ? url.match(/viewkey=([^&]+)/)[1] : 'PORNHUB') : 'VIDEO');

        let poster = info.thumbnail || '';
        if (!poster && Array.isArray(info.thumbnails) && info.thumbnails.length > 0) {
          poster = info.thumbnails[info.thumbnails.length - 1].url;
        }

        const tags = Array.isArray(info.tags) ? info.tags.slice(0, 10) : (Array.isArray(info.categories) ? info.categories.slice(0, 10) : []);
        const model = info.uploader || info.channel || info.creator || '';
        const duration = info.duration_string || (info.duration ? `${Math.floor(info.duration / 60)}m ${info.duration % 60}s` : '');

        let hlsUrl = info.url || url;
        if (info.formats && Array.isArray(info.formats)) {
          const hlsFmt = info.formats.find(f => f.protocol === 'm3u8_native' || (f.url && f.url.includes('.m3u8')));
          if (hlsFmt) hlsUrl = hlsFmt.url;
        }

        resolve({
          title: title.trim(),
          code: String(codeId).toUpperCase(),
          poster,
          hlsUrl,
          downloadTargetUrl: url,
          tags,
          model,
          duration,
          extractor: info.extractor || 'Universal',
          sourceUrl: url
        });
      } catch (err) {
        reject(new Error(`Failed to parse metadata: ${err.message}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn extractor: ${err.message}`));
    });
  });
}

/**
 * Extracts metadata and stream information with caching, non-blocking async execution, and robust fallbacks.
 */
async function extractMetadata(inputUrl) {
  const url = inputUrl.trim();

  // 1. Direct stream links (.m3u8 or .mp4)
  if (url.endsWith('.m3u8') || url.endsWith('.mp4')) {
    const filename = url.split('/').pop().split('?')[0] || 'direct_video';
    return {
      title: filename.replace(/\.(m3u8|mp4)$/, ''),
      code: 'DIRECT',
      poster: '',
      hlsUrl: url,
      downloadTargetUrl: url,
      tags: ['Direct Stream'],
      model: '',
      duration: 'Unknown',
      sourceUrl: url
    };
  }

  // 2. Check in-memory cache
  const cached = getCachedMetadata(url);
  if (cached) {
    return cached;
  }

  // 3. Try Python fetcher first (non-blocking async)
  const fetcherScript = path.join(__dirname, 'fetcher.py');
  if (fs.existsSync(fetcherScript)) {
    const pyBin = getPythonBin();
    try {
      const meta = await runPythonFetcherAsync(pyBin, fetcherScript, url);
      if (meta && meta.title) {
        setCachedMetadata(url, meta);
        return meta;
      }
    } catch (e) {
      // Fallback silently to yt-dlp
    }
  }

  // 4. If music URL and Python fetcher couldn't extract, return helpful error rather than yt-dlp DRM message
  const isMusicUrl = url && (url.includes('spotify.com') || url.includes('music.apple.com') || url.includes('deezer.com'));
  if (isMusicUrl) {
    throw new Error('Unable to extract Spotify/music metadata. Please verify that the link is a valid public track, album, or playlist.');
  }

  // 5. Fallback to yt-dlp async dump for video & generic sites
  const ytdlpPath = getYtDlpPath();
  const meta = await runYtDlpDumpAsync(ytdlpPath, url);
  setCachedMetadata(url, meta);
  return meta;
}

module.exports = {
  extractMetadata,
  getYtDlpPath,
  getPythonBin
};
