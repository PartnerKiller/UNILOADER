// Sakura Admin Panel & UI/UX Studio Controller

let adminToken = sessionStorage.getItem('sakura_admin_token') || localStorage.getItem('sakura_admin_token') || '';
let currentActiveTheme = localStorage.getItem('preview_theme') || 'sakura';
let currentActiveDensity = localStorage.getItem('preview_density') || 'standard';

// DOM Elements
const loginModal = document.getElementById('loginModal');
const adminApp = document.getElementById('adminApp');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const previewIframe = document.getElementById('previewIframe');
const sandboxActiveTheme = document.getElementById('sandboxActiveTheme');

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupEyeToggles();
  setupUiLab();
  setupTools();
  setupCreds();
  setupQueue();
  setupFlacLab();

  if (adminToken) {
    verifySession();
  } else {
    showLogin();
  }
});

// Authentication & Session
function showLogin() {
  loginModal.style.display = 'flex';
  adminApp.style.display = 'none';
}

function showApp() {
  loginModal.style.display = 'none';
  adminApp.style.display = 'flex';
  loadAllAdminData();
}

async function verifySession() {
  try {
    const res = await fetch('/api/admin/me', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (res.ok) {
      showApp();
    } else {
      adminToken = '';
      sessionStorage.removeItem('sakura_admin_token');
      localStorage.removeItem('sakura_admin_token');
      showLogin();
    }
  } catch (e) {
    showLogin();
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.style.display = 'none';
  loginBtn.disabled = true;
  loginBtn.innerHTML = '<span>Authenticating...</span>';

  const username = document.getElementById('adminUser').value.trim();
  const password = document.getElementById('adminPass').value;

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      adminToken = data.token;
      sessionStorage.setItem('sakura_admin_token', adminToken);
      localStorage.setItem('sakura_admin_token', adminToken);
      showApp();
    } else {
      loginError.textContent = data.error || 'Authentication failed';
      loginError.style.display = 'block';
    }
  } catch (err) {
    loginError.textContent = 'Connection error: ' + err.message;
    loginError.style.display = 'block';
  } finally {
    loginBtn.disabled = false;
    loginBtn.innerHTML = '<span>Authenticate & Access</span>';
  }
});

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/admin/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
    } catch (e) {}
    adminToken = '';
    sessionStorage.removeItem('sakura_admin_token');
    localStorage.removeItem('sakura_admin_token');
    showLogin();
  });
}

// Navigation Tabs
function setupNavigation() {
  const tabs = document.querySelectorAll('.admin-tabs .tab-btn');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      btn.classList.add('active');

      const targetId = `tab-${btn.getAttribute('data-tab')}`;
      document.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.remove('active');
        if (p.id === targetId) p.classList.add('active');
      });

      if (btn.getAttribute('data-tab') === 'queue') {
        loadQueueData();
      } else if (btn.getAttribute('data-tab') === 'tools') {
        loadSystemMetrics();
      } else if (btn.getAttribute('data-tab') === 'creds') {
        loadCredsData();
      } else if (btn.getAttribute('data-tab') === 'flac-lab') {
        loadRecentFlacFiles();
      }
    });
  });
}

function loadAllAdminData() {
  loadSystemMetrics();
  loadCredsData();
  loadRecentFlacFiles();
  updateSandboxIframe();
}

// 1. UI/UX LAB LOGIC
function setupUiLab() {
  // Apply Local buttons
  document.querySelectorAll('.apply-theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.getAttribute('data-theme');
      currentActiveTheme = theme;
      localStorage.setItem('preview_theme', theme);
      updateSandboxIframe();
      showToast(`Applied local preview theme: ${theme}`);
    });
  });

  // Set Global buttons
  document.querySelectorAll('.set-global-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const theme = btn.getAttribute('data-theme');
      try {
        const res = await fetch('/api/admin/ui-settings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`
          },
          body: JSON.stringify({ theme, density: currentActiveDensity })
        });
        if (res.ok) {
          currentActiveTheme = theme;
          localStorage.setItem('preview_theme', theme);
          updateSandboxIframe();
          showToast(`Global theme updated to: ${theme}`);
        } else {
          showToast('Failed to set global theme', 'error');
        }
      } catch (err) {
        showToast('Error updating theme: ' + err.message, 'error');
      }
    });
  });

  // Density Toggles
  document.querySelectorAll('.density-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.density-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const density = btn.getAttribute('data-density');
      currentActiveDensity = density;
      localStorage.setItem('preview_density', density);
      updateSandboxIframe();
      showToast(`Density set to: ${density}`);
    });
  });

  // Reset to Default
  const resetBtn = document.getElementById('resetThemeBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      localStorage.removeItem('preview_theme');
      localStorage.removeItem('preview_density');
      currentActiveTheme = 'sakura';
      currentActiveDensity = 'standard';
      updateSandboxIframe();
      showToast('Reset to production default theme.');
    });
  }

  // Open Preview Tab
  const openPreviewBtn = document.getElementById('openPreviewTabBtn');
  if (openPreviewBtn) {
    openPreviewBtn.addEventListener('click', () => {
      window.open(`/?preview_theme=${currentActiveTheme}&preview_density=${currentActiveDensity}`, '_blank');
    });
  }
}

function updateSandboxIframe() {
  if (previewIframe) {
    previewIframe.src = `/?preview_theme=${currentActiveTheme}&preview_density=${currentActiveDensity}`;
  }
  if (sandboxActiveTheme) {
    sandboxActiveTheme.textContent = `Active Theme: ${currentActiveTheme.toUpperCase()} • Density: ${currentActiveDensity}`;
  }
  document.querySelectorAll('.theme-card').forEach(card => {
    if (card.getAttribute('data-theme-name') === currentActiveTheme) {
      card.classList.add('active-theme');
    } else {
      card.classList.remove('active-theme');
    }
  });
  document.querySelectorAll('.density-btn').forEach(btn => {
    if (btn.getAttribute('data-density') === currentActiveDensity) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

// 2. SYSTEM TOOLS LOGIC
function setupTools() {
  const refreshBtn = document.getElementById('refreshStatsBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadSystemMetrics);

  const cleanBtn = document.getElementById('cleanTempBtn');
  if (cleanBtn) {
    cleanBtn.addEventListener('click', async () => {
      cleanBtn.disabled = true;
      cleanBtn.innerHTML = '<span>Cleaning...</span>';
      try {
        const res = await fetch('/api/admin/clean-temp', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        const data = await res.json();
        if (res.ok) {
          const statusText = document.getElementById('cleanStatusText');
          if (statusText) statusText.textContent = `Cleaned ${data.deletedFiles} orphaned files (${(data.freedBytes / (1024*1024)).toFixed(1)} MB freed)`;
          loadSystemMetrics();
        }
      } catch (err) {
        showToast('Clean error: ' + err.message, 'error');
      } finally {
        cleanBtn.disabled = false;
        cleanBtn.innerHTML = '<span>Clean Orphaned Fragments</span>';
      }
    });
  }

  const updateYtdlpBtn = document.getElementById('updateYtdlpBtn');
  if (updateYtdlpBtn) {
    updateYtdlpBtn.addEventListener('click', async () => {
      updateYtdlpBtn.disabled = true;
      updateYtdlpBtn.innerHTML = '<span>Updating...</span>';
      const logBox = document.getElementById('ytdlpLogOutput');
      logBox.style.display = 'block';
      logBox.textContent = 'Running: yt-dlp -U ...\n';

      try {
        const res = await fetch('/api/admin/update-ytdlp', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        const data = await res.json();
        logBox.textContent += data.output || data.error || 'Done.';
        loadSystemMetrics();
      } catch (err) {
        logBox.textContent += 'Error: ' + err.message;
      } finally {
        updateYtdlpBtn.disabled = false;
        updateYtdlpBtn.innerHTML = '<span>Update yt-dlp (-U)</span>';
      }
    });
  }

  const checkFfmpegBtn = document.getElementById('checkFfmpegBtn');
  if (checkFfmpegBtn) {
    checkFfmpegBtn.addEventListener('click', async () => {
      checkFfmpegBtn.disabled = true;
      checkFfmpegBtn.innerHTML = '<span>Verifying...</span>';
      const box = document.getElementById('codecResultBox');
      if (box) {
        box.style.display = 'flex';
        box.innerHTML = '<span style="color: var(--admin-text-muted); font-size: 0.8rem;">Querying FFmpeg binary...</span>';
      }

      try {
        const res = await fetch('/api/admin/verify-codecs', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        const data = await res.json();
        if (res.ok && data.success && data.codecs) {
          const c = data.codecs;
          box.innerHTML = `
            <span class="codec-badge ${c.flac_lossless ? 'supported' : 'unsupported'}">FLAC ${c.flac_lossless ? '✓' : '✗'}</span>
            <span class="codec-badge ${c.opus ? 'supported' : 'unsupported'}">OPUS ${c.opus ? '✓' : '✗'}</span>
            <span class="codec-badge ${c.aac ? 'supported' : 'unsupported'}">AAC ${c.aac ? '✓' : '✗'}</span>
            <span class="codec-badge ${c.h264 ? 'supported' : 'unsupported'}">H.264 ${c.h264 ? '✓' : '✗'}</span>
            <span class="codec-badge ${c.h265_hevc ? 'supported' : 'unsupported'}">HEVC ${c.h265_hevc ? '✓' : '✗'}</span>
            <span class="codec-badge ${c.vp9 ? 'supported' : 'unsupported'}">VP9 ${c.vp9 ? '✓' : '✗'}</span>
            <span class="codec-badge ${c.av1 ? 'supported' : 'unsupported'}">AV1 ${c.av1 ? '✓' : '✗'}</span>
          `;
        } else {
          box.innerHTML = `<span style="color: var(--admin-pink); font-size: 0.8rem;">Verification failed: ${data.error || 'Unknown'}</span>`;
        }
      } catch (err) {
        if (box) box.innerHTML = `<span style="color: var(--admin-pink); font-size: 0.8rem;">Error: ${err.message}</span>`;
      } finally {
        checkFfmpegBtn.disabled = false;
        checkFfmpegBtn.innerHTML = 'Verify Codecs';
      }
    });
  }
}

async function loadSystemMetrics() {
  if (!adminToken) return;
  try {
    const res = await fetch('/api/admin/system-stats', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();

    // RAM
    const rssMb = (data.memory.rss / (1024 * 1024)).toFixed(1);
    const heapMb = (data.memory.heapUsed / (1024 * 1024)).toFixed(1);
    document.getElementById('statRam').textContent = `${rssMb} MB`;
    document.getElementById('statHeap').textContent = `Heap: ${heapMb} MB`;

    // System Free
    const freeGb = (data.system.free / (1024 * 1024 * 1024)).toFixed(2);
    const totalGb = (data.system.total / (1024 * 1024 * 1024)).toFixed(2);
    document.getElementById('statSysFree').textContent = `${freeGb} GB`;
    document.getElementById('statSysTotal').textContent = `Total: ${totalGb} GB`;

    // CPU
    const loadStr = data.system.loadavg ? data.system.loadavg[0].toFixed(2) : '0.00';
    document.getElementById('statCpuLoad').textContent = `${loadStr} load`;
    document.getElementById('statCores').textContent = `Cores: ${data.system.cpus}`;

    // Temp storage
    const tempMb = (data.storage.tempSizeBytes / (1024 * 1024)).toFixed(1);
    document.getElementById('statTempSize').textContent = `${tempMb} MB`;
    document.getElementById('statTempFiles').textContent = `${data.storage.tempFileCount} Files`;
    document.getElementById('orphanedCountBadge').textContent = `${data.storage.orphanedPartials} Orphaned`;

    // Tool versions
    if (data.tools.ytdlpVersion) {
      document.getElementById('ytdlpVersionLabel').textContent = `Version: ${data.tools.ytdlpVersion}`;
    }
    if (data.tools.ffmpegVersion) {
      document.getElementById('ffmpegStatusLabel').textContent = `Build: ${data.tools.ffmpegVersion.slice(0, 30)}`;
    }

    // SLSKD P2P Daemon Status
    if (data.tools.slskd) {
      const dot = document.getElementById('slskdStatusDot');
      const lbl = document.getElementById('slskdStatusLabel');
      if (dot) dot.className = `status-dot ${data.tools.slskd.running ? 'active' : 'inactive'}`;
      if (lbl) lbl.textContent = data.tools.slskd.running 
        ? `Embedded daemon: Active on port ${data.tools.slskd.port || 5030}` 
        : `Embedded daemon: Offline / Stopped`;
    }

    // Uptime
    const hours = Math.floor(data.system.uptime / 3600);
    const mins = Math.floor((data.system.uptime % 3600) / 60);
    document.getElementById('headerUptime').textContent = `Uptime: ${hours}h ${mins}m`;
  } catch (err) {
    console.warn('Metrics load error:', err);
  }
}

// 3. CREDENTIALS & TOKENS LOGIC
function setupCreds() {
  const testDeezerBtn = document.getElementById('testDeezerBtn');
  if (testDeezerBtn) {
    testDeezerBtn.addEventListener('click', async () => {
      const arl = document.getElementById('deezerArlInput').value.trim();
      const resBox = document.getElementById('deezerTestResult');
      resBox.style.display = 'block';
      resBox.className = 'test-result-box';
      resBox.textContent = 'Testing Deezer ARL Token...';

      try {
        const res = await fetch('/api/admin/test-deezer', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`
          },
          body: JSON.stringify({ arl })
        });
        const data = await res.json();
        if (res.ok && data.valid) {
          resBox.className = 'test-result-box success';
          resBox.textContent = `✓ Token Verified! Account: ${data.user || 'HiFi Subscriber'} • Country: ${data.country || 'Global'} • Lossless 1411k: ${data.canStreamLossless ? 'ACTIVE' : 'STANDARD'}`;
        } else {
          resBox.className = 'test-result-box error';
          resBox.textContent = `✗ Invalid Token: ${data.error || 'Cannot authenticate with Deezer API'}`;
        }
      } catch (err) {
        resBox.className = 'test-result-box error';
        resBox.textContent = `Error: ${err.message}`;
      }
    });
  }

  const saveCredsBtn = document.getElementById('saveCredsBtn');
  if (saveCredsBtn) {
    saveCredsBtn.addEventListener('click', async () => {
      saveCredsBtn.disabled = true;
      const statusEl = document.getElementById('saveCredsStatus');
      statusEl.textContent = 'Saving...';

      const deezerArl = document.getElementById('deezerArlInput').value.trim();
      const spotifyClientId = document.getElementById('spotifyClientId').value.trim();
      const spotifyClientSecret = document.getElementById('spotifyClientSecret').value.trim();
      const adminUser = document.getElementById('newAdminUser').value.trim();
      const adminPass = document.getElementById('newAdminPass').value.trim();

      try {
        const res = await fetch('/api/admin/creds', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`
          },
          body: JSON.stringify({
            deezerArl,
            spotifyClientId,
            spotifyClientSecret,
            adminUser,
            adminPass
          })
        });

        const data = await res.json();
        if (res.ok) {
          statusEl.textContent = '✓ Saved & Applied to Server Environment!';
          setTimeout(() => { statusEl.textContent = ''; }, 4000);
        } else {
          statusEl.textContent = 'Failed: ' + (data.error || 'Server error');
        }
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
      } finally {
        saveCredsBtn.disabled = false;
      }
    });
  }
}

async function loadCredsData() {
  if (!adminToken) return;
  try {
    const res = await fetch('/api/admin/creds', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();

    const dzBadge = document.getElementById('deezerStatusBadge');
    if (data.deezerArl) {
      document.getElementById('deezerArlInput').value = data.deezerArl;
      if (dzBadge) {
        dzBadge.textContent = 'Configured (Masked)';
        dzBadge.className = 'badge-tag';
      }
    } else {
      if (dzBadge) {
        dzBadge.textContent = 'Not Configured';
        dzBadge.className = 'badge-tag error';
      }
    }

    const spBadge = document.getElementById('spotifyStatusBadge');
    if (data.spotifyClientId) {
      document.getElementById('spotifyClientId').value = data.spotifyClientId;
    }
    if (data.spotifyClientSecret) {
      document.getElementById('spotifyClientSecret').value = data.spotifyClientSecret;
    }
    if (spBadge) {
      if (data.spotifyClientId && data.spotifyClientSecret) {
        spBadge.textContent = 'Configured';
        spBadge.className = 'badge-tag';
      } else {
        spBadge.textContent = 'Missing API Keys';
        spBadge.className = 'badge-tag error';
      }
    }

    if (data.adminUser) {
      document.getElementById('newAdminUser').value = data.adminUser;
    }
  } catch (err) {
    console.warn('Creds load error:', err);
  }
}

// 4. QUEUE INSPECTOR LOGIC
function setupQueue() {
  const refreshQueueBtn = document.getElementById('refreshQueueBtn');
  if (refreshQueueBtn) refreshQueueBtn.addEventListener('click', loadQueueData);

  const clearBtn = document.getElementById('adminClearCompletedBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/jobs', {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        loadQueueData();
        showToast('Cleared completed jobs.');
      } catch (e) {}
    });
  }
}

async function loadQueueData() {
  const listEl = document.getElementById('adminQueueList');
  if (!listEl) return;

  try {
    const res = await fetch('/api/jobs', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const jobs = await res.json();

    if (!jobs || jobs.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No downloads currently in queue.</div>';
      return;
    }

    listEl.innerHTML = jobs.map(job => `
      <div class="queue-row">
        <div class="queue-row-info">
          <h4>${escapeHtml(job.title || job.filename || 'Task ' + job.id)}</h4>
          <div class="queue-row-meta">
            <span>[${job.status.toUpperCase()}]</span> &bull; 
            <span>${(job.progress.percent || 0).toFixed(1)}%</span> &bull; 
            <span>${job.progress.speed || '0 MB/s'}</span> &bull; 
            <span>ETA: ${job.progress.eta || '--'}</span> &bull; 
            <span>PID: ${job.pid || 'N/A'}</span>
          </div>
        </div>
        <div class="queue-row-actions">
          ${job.status === 'downloading' ? `
            <button class="btn btn-warning btn-sm" onclick="adminPauseJob('${job.id}')">Pause</button>
          ` : job.status === 'paused' ? `
            <button class="btn btn-primary btn-sm" onclick="adminResumeJob('${job.id}')">Resume</button>
          ` : ''}
          <button class="btn btn-danger-outline btn-sm" onclick="adminCancelJob('${job.id}')">Cancel</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state">Error loading queue: ${err.message}</div>`;
  }
}

window.adminPauseJob = async function(id) {
  await fetch(`/api/jobs/${id}/pause`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  loadQueueData();
};

window.adminResumeJob = async function(id) {
  await fetch(`/api/jobs/${id}/resume`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  loadQueueData();
};

window.adminCancelJob = async function(id) {
  await fetch(`/api/jobs/${id}/cancel`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  loadQueueData();
};

// 5. FLAC TEST BENCH LOGIC
function setupFlacLab() {
  const refreshBtn = document.getElementById('refreshRecentFlacBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadRecentFlacFiles);

  const selectEl = document.getElementById('flacRecentSelect');
  if (selectEl) {
    selectEl.addEventListener('change', () => {
      if (selectEl.value) {
        const inputEl = document.getElementById('flacFilePath');
        if (inputEl) inputEl.value = selectEl.value;
      }
    });
  }

  const runBtn = document.getElementById('runFlacTestBtn');
  if (runBtn) {
    runBtn.addEventListener('click', runFlacAnalysis);
  }
}

async function loadRecentFlacFiles() {
  const selectEl = document.getElementById('flacRecentSelect');
  if (!selectEl) return;
  try {
    const res = await fetch('/api/flac-check/recent', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (!res.ok) return;
    const files = await res.json();
    selectEl.innerHTML = '<option value="">-- Choose a recent file on server --</option>';
    if (Array.isArray(files) && files.length > 0) {
      files.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.filePath;
        opt.textContent = `${f.filename} (${f.sizeMB} MB)`;
        selectEl.appendChild(opt);
      });
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(No recent FLAC files found in download directories)';
      selectEl.appendChild(opt);
    }
  } catch (e) {
    console.warn('Failed to load recent FLAC files:', e);
  }
}

async function runFlacAnalysis() {
  const inputEl = document.getElementById('flacFilePath');
  const filePath = inputEl ? inputEl.value.trim() : '';
  const runBtn = document.getElementById('runFlacTestBtn');
  const reportBox = document.getElementById('flacTestReport');

  if (!filePath) {
    showToast('Please specify a file path or choose a recent file', 'error');
    return;
  }

  if (runBtn) {
    runBtn.disabled = true;
    runBtn.innerHTML = '<span>Analyzing Spectrum...</span>';
  }

  if (reportBox) {
    reportBox.style.display = 'block';
    reportBox.innerHTML = '<div style="color: var(--admin-text-muted); padding: 16px; text-align: center;">Running deep Fourier spectral analysis & checking bitstream authenticity...</div>';
  }

  try {
    const res = await fetch('/api/flac-check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ filePath })
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      if (reportBox) reportBox.innerHTML = `<div class="test-result-box error">Error: ${escapeHtml(data.error || 'Analysis failed')}</div>`;
      return;
    }

    const isGenuine = data.verdict === 'GENUINE_LOSSLESS' || data.verdict === 'STUDIO_MASTER' || data.verdict === 'AUTHENTIC_CDDA';
    const verdictClass = isGenuine ? 'genuine' : (data.verdict === 'SUSPICIOUS_TRANSCODE' ? 'suspicious' : 'fake');
    const verdictText = data.verdictBadge || data.verdictTitle || data.verdict || 'FLAC Analyzed';

    const detailsList = Array.isArray(data.details) && data.details.length > 0
      ? data.details.map(d => `<div>&bull; ${escapeHtml(d)}</div>`).join('')
      : '';

    const warningsList = Array.isArray(data.warnings) && data.warnings.length > 0
      ? data.warnings.map(w => `<div style="color: var(--admin-pink); font-weight: 600;">⚠ ${escapeHtml(w)}</div>`).join('')
      : '';

    if (reportBox) {
      reportBox.innerHTML = `
        <div class="flac-report-header">
          <div>
            <h3>${escapeHtml(data.filename || filePath.split('/').pop().split('\\').pop())}</h3>
            <span style="font-size: 0.8rem; color: var(--admin-text-muted); font-family: var(--font-mono); word-break: break-all;">${escapeHtml(data.filePath || filePath)}</span>
          </div>
          <span class="flac-verdict-tag ${verdictClass}">${escapeHtml(verdictText)}</span>
        </div>

        <div class="flac-metrics-row">
          <div class="flac-metric-card">
            <span class="f-label">Sample Rate</span>
            <span class="f-val">${data.sampleRate ? (data.sampleRate / 1000).toFixed(1) + ' kHz' : '--'}</span>
          </div>
          <div class="flac-metric-card">
            <span class="f-label">Bit Depth</span>
            <span class="f-val">${data.bitsPerSample ? data.bitsPerSample + '-bit' : '--'}</span>
          </div>
          <div class="flac-metric-card">
            <span class="f-label">Bitrate</span>
            <span class="f-val">${data.bitrateKbps ? Math.round(data.bitrateKbps) + ' kbps' : '--'}</span>
          </div>
          <div class="flac-metric-card">
            <span class="f-label">Cutoff Frequency</span>
            <span class="f-val">${data.cutoffFrequencyHz ? (data.cutoffFrequencyHz / 1000).toFixed(1) + ' kHz' : '--'}</span>
          </div>
          <div class="flac-metric-card">
            <span class="f-label">Nyquist Limit</span>
            <span class="f-val">${data.nyquistLimitHz ? (data.nyquistLimitHz / 1000).toFixed(1) + ' kHz' : '--'}</span>
          </div>
          <div class="flac-metric-card">
            <span class="f-label">File Size</span>
            <span class="f-val">${data.fileSizeMB ? data.fileSizeMB + ' MB' : '--'}</span>
          </div>
        </div>

        ${(detailsList || warningsList) ? `
          <div class="flac-reason-text">
            ${warningsList}
            ${detailsList}
          </div>
        ` : ''}

        ${data.spectrogram ? `
          <div class="flac-spectrogram-box">
            <img src="${data.spectrogram}" alt="Spectrogram Analysis" />
          </div>
        ` : ''}
      `;
    }
  } catch (err) {
    if (reportBox) reportBox.innerHTML = `<div class="test-result-box error">Analysis failed: ${escapeHtml(err.message)}</div>`;
  } finally {
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.innerHTML = 'Analyze Spectrum';
    }
  }
}

// Toggle password eyes
function setupEyeToggles() {
  document.querySelectorAll('.toggle-eye').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const input = document.getElementById(targetId);
      if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
      }
    });
  });
}

// Simple Toast Helper
function showToast(msg, type = 'info') {
  let toast = document.createElement('div');
  toast.className = `admin-toast ${type}`;
  toast.textContent = msg;
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: ${type === 'error' ? 'rgba(244, 63, 94, 0.95)' : 'rgba(16, 185, 129, 0.95)'};
    color: #fff;
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 0.88rem;
    font-weight: 600;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    z-index: 9999;
    transition: opacity 0.3s;
  `;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
