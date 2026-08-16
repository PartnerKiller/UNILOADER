const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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

/**
 * Extracts metadata and stream information for Jable, Pornhub, and universal video sites.
 * @param {string} inputUrl 
 * @returns {Promise<{title: string, code: string, poster: string, hlsUrl: string, tags: string[], model: string, duration: string, isDirectYtDlp?: boolean, sourceUrl: string}>}
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

  // 2. Try Python fetcher first (supports curl_cffi for Jable and Pornhub)
  const fetcherScript = path.join(__dirname, 'fetcher.py');
  if (fs.existsSync(fetcherScript)) {
    try {
      const pyBin = process.platform === 'win32' ? 'python' : 'python3';
      const output = execSync(`${pyBin} "${fetcherScript}" "${url}"`, { encoding: 'utf-8', maxBuffer: 15 * 1024 * 1024, timeout: 20000 });
      const json = JSON.parse(output.trim());
      if (json && !json.error && json.title) {
        return json;
      }
    } catch (e) {
      console.warn('Python fetcher error:', e.message);
    }
  }

  // 3. Fallback to yt-dlp JSON dump
  return new Promise((resolve, reject) => {
    const ytdlpPath = getYtDlpPath();
    const args = [
      '--dump-single-json',
      '--skip-download',
      '--no-warnings',
      '--no-playlist',
      url
    ];

    const child = spawn(ytdlpPath, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => stdout += d.toString());
    child.stderr.on('data', (d) => stderr += d.toString());

    child.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        return reject(new Error(stderr.trim() || `Failed to extract video information (exit code ${code})`));
      }

      try {
        const info = JSON.parse(stdout);
        const title = info.fulltitle || info.title || 'video_' + Date.now();
        const code = info.display_id || info.id || (url.includes('pornhub') ? (url.match(/viewkey=([^&]+)/) ? url.match(/viewkey=([^&]+)/)[1] : 'PORNHUB') : 'VIDEO');
        
        let poster = info.thumbnail || '';
        if (!poster && Array.isArray(info.thumbnails) && info.thumbnails.length > 0) {
          poster = info.thumbnails[info.thumbnails.length - 1].url;
        }

        const tags = Array.isArray(info.tags) ? info.tags.slice(0, 10) : (Array.isArray(info.categories) ? info.categories.slice(0, 10) : []);
        const model = info.uploader || info.channel || info.creator || '';
        const duration = info.duration_string || (info.duration ? `${Math.floor(info.duration / 60)}m ${info.duration % 60}s` : '');

        let hlsUrl = info.url || url;
        if (info.requested_downloads && info.requested_downloads[0] && info.requested_downloads[0].url) {
          hlsUrl = info.requested_downloads[0].url;
        }

        resolve({
          title: title.trim(),
          code: String(code).toUpperCase(),
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
        reject(new Error(`Failed to parse yt-dlp JSON: ${err.message}`));
      }
    });
  });
}

module.exports = { extractMetadata, getYtDlpPath };
