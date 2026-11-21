const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// In-memory TTL Cache (10 minutes)
const metaCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

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
  // Never cache offline or private livestream states in long TTL cache
  if (data.isOffline || data.isPrivate || data.duration === 'OFFLINE' || data.duration === 'PRIVATE') return;
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
    const child = spawn(pyBin, [scriptPath, url], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    });
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
            if (json && json.error) {
              return reject(new Error(json.error));
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
      '--js-runtimes', process.platform === 'win32' ? 'node' : (fs.existsSync('/usr/bin/node') ? 'node:/usr/bin/node' : 'node')
    ];

    if (process.platform === 'win32') {
      args.push('--impersonate', 'chrome');
    }

    let targetUrl = url;
    if (targetUrl.includes('omg.sexy')) {
      targetUrl = targetUrl.replace(/omg\.sexy/i, 'stripchat.com');
    }
    args.push(targetUrl);

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
        const rawTitle = info.fulltitle || info.title || 'video_' + Date.now();
        const title = decodeHtmlEntities(rawTitle).trim();
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

        let maxHeight = info.height || 0;
        let maxFps = info.fps || 0;
        if (Array.isArray(info.formats)) {
          for (const f of info.formats) {
            if (f.height && f.height > maxHeight) maxHeight = f.height;
            if (f.fps && f.fps > maxFps) maxFps = f.fps;
          }
        }

        let qualityLabel = '1080p HD';
        if (maxHeight >= 4320) qualityLabel = '8K UHD';
        else if (maxHeight >= 2160) qualityLabel = maxFps >= 50 ? '4K 60fps' : '4K UHD';
        else if (maxHeight >= 1440) qualityLabel = maxFps >= 50 ? '2K 60fps' : '1440p QHD';
        else if (maxHeight >= 1080) qualityLabel = maxFps >= 50 ? '1080p60' : '1080p HD';
        else if (maxHeight >= 720) qualityLabel = '720p HD';
        else if (maxHeight > 0) qualityLabel = `${maxHeight}p`;

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
          sourceUrl: url,
          maxHeight,
          maxFps,
          qualityLabel
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

// Native metadata extractor for OlaM 18+ (olam18plus.com) media and studio rips
async function extractOlaM18Metadata(url) {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Referer': 'https://olam18plus.com/'
    };

    if (url.includes('/i/m/') && (url.endsWith('.clip.mp4') || url.endsWith('.mp4'))) {
      const filename = url.split('/').pop().split('?')[0];
      const poster = url.replace('.clip.mp4', '.poster.jpg');
      return {
        title: filename.replace(/\.(clip\.mp4|mp4)$/, ''),
        code: 'OLAM18+',
        poster,
        hlsUrl: url,
        downloadTargetUrl: url,
        tags: ['OlaM 18+', 'Direct Video'],
        model: '',
        duration: 'Unknown',
        sourceUrl: url
      };
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(6500) });
    if (!res.ok) return null;
    const html = await res.text();

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].replace('OLAM18PLUS.COM · ', '').replace('…', '').trim() : 'OlaM18+ Media';

    const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"(.*)"\]\)/g)].map(m => m[1]);
    const raw = chunks.join('').replace(/\\n/g, '\n').replace(/\\"/g, '"');

    let firstFile = null;
    const matchFiles = raw.match(/"initialFiles":(\[.*?\])(?:,"initialPageToken"|,"parentSlug")/s);
    if (matchFiles) {
      try {
        const files = JSON.parse(matchFiles[1]);
        if (Array.isArray(files) && files.length > 0) {
          firstFile = files[0];
        }
      } catch (e) {}
    }

    const finalTitle = (firstFile && firstFile.name) ? firstFile.name.replace(/\.mp4$/i, '') : pageTitle;
    const poster = (firstFile && firstFile.poster) ? `https://olam18plus.com${firstFile.poster}` : '';
    const previewUrl = (firstFile && firstFile.preview) ? `https://olam18plus.com${firstFile.preview}` : url;
    const codeMatch = finalTitle.match(/\b([A-Z]{2,6}[-_]\d{2,5})\b/i);

    return {
      title: finalTitle,
      code: codeMatch ? codeMatch[1].toUpperCase() : 'OLAM18+',
      poster,
      hlsUrl: previewUrl,
      downloadTargetUrl: previewUrl,
      tags: ['OlaM 18+', (firstFile && firstFile.res) ? firstFile.res : 'HD'],
      model: (firstFile && firstFile.parent && firstFile.parent.name) || '',
      duration: firstFile && firstFile.dur ? `${Math.round(firstFile.dur / 60000)} min` : 'Unknown',
      sourceUrl: url
    };
  } catch (e) {
    return null;
  }
}

/**
 * Extracts metadata and stream information with caching, non-blocking async execution, and robust fallbacks.
 */
async function extractMetadata(inputUrl, bypassCache = false) {
  const url = inputUrl.trim();

  // 1. Direct stream links (.m3u8 or .mp4)
  if (url.endsWith('.m3u8') || url.endsWith('.mp4')) {
    const filename = url.split('/').pop().split('?')[0] || 'direct_video';
    return {
      title: filename.replace(/\.(m3u8|mp4)$/, ''),
      code: url.includes('olam18plus') ? 'OLAM18+' : 'DIRECT',
      poster: url.includes('olam18plus') ? url.replace('.clip.mp4', '.poster.jpg') : '',
      hlsUrl: url,
      downloadTargetUrl: url,
      tags: url.includes('olam18plus') ? ['OlaM 18+', 'Direct Video'] : ['Direct Stream'],
      model: '',
      duration: 'Unknown',
      sourceUrl: url
    };
  }

  // 2. Check in-memory cache
  if (!bypassCache) {
    const cached = getCachedMetadata(url);
    if (cached) {
      return cached;
    }
  }

  // 3. OlaM 18+ (olam18plus.com) Native Resolution
  if (url.includes('olam18plus.com')) {
    const olaMeta = await extractOlaM18Metadata(url);
    if (olaMeta && olaMeta.title) {
      setCachedMetadata(url, olaMeta);
      return olaMeta;
    }
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
      if (url.includes('omg.sexy') || url.includes('stripchat.com') || (e.message && (e.message.includes('404') || e.message.toLowerCase().includes('not found') || e.message.toLowerCase().includes('offline') || e.message.toLowerCase().includes('private')))) {
        throw e;
      }
      // Fallback silently to yt-dlp
    }
  }

  // 4. If music URL and Python fetcher couldn't extract, try SpotiFLAC-Next direct Songlink scraper
  const isMusicUrl = url && (url.includes('spotify.com') || url.includes('music.apple.com') || url.includes('deezer.com'));
  if (isMusicUrl) {
    const nextScript = path.join(__dirname, 'spotiflac_next_engine.py');
    if (fs.existsSync(nextScript)) {
      const pyBin = getPythonBin();
      try {
        const meta = await runPythonFetcherAsync(pyBin, nextScript, url);
        if (meta && meta.title) {
          setCachedMetadata(url, meta);
          return meta;
        }
      } catch (e) {}
    }
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
