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
  setupServiceAndLogs();
  setupEngineSettings();
  setupStorageExplorer();
  setupNetworkHealth();
  setupTerminalConsole();
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

      const tabName = btn.getAttribute('data-tab');
      if (tabName === 'service') {
        loadServiceStatus();
        loadServiceLogs();
      } else if (tabName === 'engine') {
        loadEngineConfig();
      } else if (tabName === 'storage') {
        loadStorageFiles();
      } else if (tabName === 'network') {
        loadNetworkHealth();
      } else if (tabName === 'terminal') {
        focusTerminalInput();
      } else if (tabName === 'queue') {
        loadQueueData();
      } else if (tabName === 'tools') {
        loadSystemMetrics();
      } else if (tabName === 'creds') {
        loadCredsData();
      } else if (tabName === 'flac-lab') {
        loadRecentFlacFiles();
      }
    });
  });
}

function loadAllAdminData() {
  loadServiceStatus();
  loadEngineConfig();
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

  const slskdLink = document.getElementById('slskdWebUiLink');
  if (slskdLink) {
    const host = window.location.hostname;
    if (host.includes('nazuna.dpdns.org')) {
      slskdLink.href = 'https://slskd.nazuna.dpdns.org';
    } else if (host === 'localhost' || host === '127.0.0.1') {
      slskdLink.href = 'http://127.0.0.1:5030';
    } else {
      slskdLink.href = `http://${host}:5030`;
    }
  }

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

  const purgeFlacBtn = document.getElementById('purgeFlacCacheBtn');
  if (purgeFlacBtn) {
    purgeFlacBtn.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to purge all downloaded FLAC files from server storage?')) return;
      purgeFlacBtn.disabled = true;
      purgeFlacBtn.innerHTML = '<span>Purging...</span>';
      try {
        const res = await fetch('/api/admin/purge-flac-cache', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        const data = await res.json();
        if (res.ok) {
          const statusText = document.getElementById('purgeFlacStatusText');
          if (statusText) statusText.textContent = `Purged ${data.deletedCount} files (${data.freedMB} MB freed)`;
          loadSystemMetrics();
          loadRecentFlacFiles();
          showToast(`Purged ${data.deletedCount} FLAC files (${data.freedMB} MB freed)`);
        } else {
          showToast(data.error || 'Failed to purge FLAC cache', 'error');
        }
      } catch (err) {
        showToast('Purge error: ' + err.message, 'error');
      } finally {
        purgeFlacBtn.disabled = false;
        purgeFlacBtn.innerHTML = '<span>Purge FLAC Cache</span>';
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
    const tempFileCount = data.storage.tempFileCount || 0;
    document.getElementById('statTempFiles').textContent = tempFileCount === 1 ? '1 File' : `${tempFileCount} Files`;

    const orphBadge = document.getElementById('orphanedCountBadge');
    if (orphBadge) {
      const orphCount = data.storage.orphanedPartials || 0;
      orphBadge.textContent = `${orphCount} Orphaned`;
      orphBadge.className = orphCount > 0 ? 'badge-tag warning' : 'badge-tag success';
    }

    // FLAC Library Cache
    if (data.storage && data.storage.flacCache) {
      const fc = data.storage.flacCache;
      const countBadge = document.getElementById('flacCacheCountBadge');
      const sizeLabel = document.getElementById('flacCacheSizeLabel');
      if (countBadge) {
        const fcCount = fc.fileCount || 0;
        countBadge.textContent = fcCount === 1 ? '1 File' : `${fcCount} Files`;
        countBadge.className = 'badge-tag accent';
      }
      if (sizeLabel) sizeLabel.textContent = `${fc.sizeMB} MB`;
    }

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
        dzBadge.className = 'badge-tag success';
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
        spBadge.className = 'badge-tag success';
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

  const clearBenchBtn = document.getElementById('adminClearFlacBenchBtn');
  if (clearBenchBtn) {
    clearBenchBtn.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to purge all downloaded FLAC files from server storage?')) return;
      clearBenchBtn.disabled = true;
      try {
        const res = await fetch('/api/admin/purge-flac-cache', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        const data = await res.json();
        if (res.ok) {
          showToast(`Purged ${data.deletedCount} FLAC files (${data.freedMB} MB freed)`);
          loadRecentFlacFiles();
          loadSystemMetrics();
          const inputEl = document.getElementById('flacFilePath');
          if (inputEl) inputEl.value = '';
        } else {
          showToast(data.error || 'Failed to purge FLAC cache', 'error');
        }
      } catch (err) {
        showToast('Purge error: ' + err.message, 'error');
      } finally {
        clearBenchBtn.disabled = false;
      }
    });
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

// ==========================================================================
// 6. SERVICE & LIVE LOGS CONTROLLER
// ==========================================================================
let logsAutoRefreshTimer = null;
let rawLogsBuffer = '';
let currentLogFilter = 'all';

function setupServiceAndLogs() {
  const restartBtn = document.getElementById('btnRestartService');
  if (restartBtn) {
    restartBtn.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to restart the JAV Downloader system service? Active downloads may be interrupted.')) {
        return;
      }
      restartBtn.disabled = true;
      restartBtn.innerHTML = '<span>Restarting...</span>';
      try {
        const res = await fetch('/api/admin/service/restart', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        const data = await res.json();
        showToast(data.message || 'Service restart initiated', 'info');
        setTimeout(() => {
          loadServiceStatus();
          loadServiceLogs();
        }, 2000);
      } catch (e) {
        showToast('Restart failed: ' + e.message, 'error');
      } finally {
        setTimeout(() => {
          restartBtn.disabled = false;
          restartBtn.innerHTML = '<span>Restart Service</span>';
        }, 3000);
      }
    });
  }

  const refreshLogsBtn = document.getElementById('btnRefreshLogs');
  if (refreshLogsBtn) {
    refreshLogsBtn.addEventListener('click', loadServiceLogs);
  }

  const copyLogsBtn = document.getElementById('btnCopyLogs');
  if (copyLogsBtn) {
    copyLogsBtn.addEventListener('click', () => {
      if (rawLogsBuffer) {
        navigator.clipboard.writeText(rawLogsBuffer).then(() => {
          showToast('Journal logs copied to clipboard!');
        }).catch(() => {
          showToast('Failed to copy to clipboard', 'error');
        });
      }
    });
  }

  const clearLogsBtn = document.getElementById('btnClearLogsView');
  if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', () => {
      const out = document.getElementById('serviceLogsOutput');
      if (out) out.textContent = '[Console logs cleared from view]';
    });
  }

  const searchInput = document.getElementById('logsSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', renderFilteredLogs);
  }

  document.querySelectorAll('.btn-filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.btn-filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentLogFilter = pill.getAttribute('data-filter') || 'all';
      renderFilteredLogs();
    });
  });

  const autoRefreshCheckbox = document.getElementById('autoRefreshLogsCheckbox');
  if (autoRefreshCheckbox) {
    autoRefreshCheckbox.addEventListener('change', () => {
      if (autoRefreshCheckbox.checked) {
        startLogsAutoRefresh();
      } else {
        stopLogsAutoRefresh();
      }
    });
  }
}

function startLogsAutoRefresh() {
  stopLogsAutoRefresh();
  logsAutoRefreshTimer = setInterval(() => {
    const activeTab = document.querySelector('.admin-tabs .tab-btn.active');
    if (activeTab && activeTab.getAttribute('data-tab') === 'service') {
      loadServiceLogs(true);
      loadServiceStatus();
    }
  }, 3000);
}

function stopLogsAutoRefresh() {
  if (logsAutoRefreshTimer) {
    clearInterval(logsAutoRefreshTimer);
    logsAutoRefreshTimer = null;
  }
}

async function loadServiceStatus() {
  try {
    const res = await fetch('/api/admin/service/status', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    const dot = document.getElementById('serviceStatusDot');
    const sub = document.getElementById('serviceStatusSub');
    const pidBadge = document.getElementById('servicePidBadge');
    const uptimeBadge = document.getElementById('serviceUptimeBadge');
    const nodeBadge = document.getElementById('serviceNodeBadge');
    const archBadge = document.getElementById('serviceArchBadge');
    const headerUptime = document.getElementById('headerUptime');

    if (dot) {
      if (data.active) {
        dot.className = 'status-indicator-dot';
      } else {
        dot.className = 'status-indicator-dot inactive';
      }
    }

    if (sub) sub.textContent = data.active ? 'Active (Running) & Healthy' : 'Service Inactive / Reloading';
    if (pidBadge) pidBadge.textContent = `PID: ${data.pid || '--'}`;
    
    const upH = Math.floor((data.uptimeSeconds || 0) / 3600);
    const upM = Math.floor(((data.uptimeSeconds || 0) % 3600) / 60);
    if (uptimeBadge) uptimeBadge.textContent = `Uptime: ${upH}h ${upM}m`;
    if (headerUptime) headerUptime.textContent = `Uptime: ${upH}h ${upM}m`;
    if (nodeBadge) nodeBadge.textContent = `Node: ${data.nodeVersion || '--'}`;
    if (archBadge) archBadge.textContent = `${data.platform || 'linux'} (${data.arch || 'x64'})`;
  } catch (e) {}
}

async function loadServiceLogs(silent = false) {
  const out = document.getElementById('serviceLogsOutput');
  try {
    const res = await fetch('/api/admin/service/logs?lines=200', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    rawLogsBuffer = data.logs || '';
    renderFilteredLogs();
  } catch (e) {
    if (!silent && out) out.textContent = 'Error loading logs: ' + e.message;
  }
}

function renderFilteredLogs() {
  const out = document.getElementById('serviceLogsOutput');
  if (!out) return;
  const keyword = (document.getElementById('logsSearchInput')?.value || '').toLowerCase();
  
  if (!rawLogsBuffer) {
    out.textContent = 'No log entries available.';
    return;
  }

  const lines = rawLogsBuffer.split('\n');
  const filtered = lines.filter(line => {
    const lower = line.toLowerCase();
    if (keyword && !lower.includes(keyword)) return false;
    if (currentLogFilter === 'error') return lower.includes('error') || lower.includes('err') || lower.includes('fail');
    if (currentLogFilter === 'warn') return lower.includes('warn');
    if (currentLogFilter === 'download') return lower.includes('download') || lower.includes('job_') || lower.includes('progress');
    if (currentLogFilter === 'flac') return lower.includes('flac') || lower.includes('audio') || lower.includes('soulseek');
    return true;
  });

  out.textContent = filtered.join('\n') || '[No log entries matched your filter]';
  const consoleWin = document.getElementById('serviceLogsConsole');
  if (consoleWin && !keyword) {
    consoleWin.scrollTop = consoleWin.scrollHeight;
  }
}

// ==========================================================================
// 7. ENGINE SETTINGS CONTROLLER
// ==========================================================================
function setupEngineSettings() {
  const saveBtn = document.getElementById('btnSaveEngineConfig');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span>Saving...</span>';

      const maxConcurrentJobs = parseInt(document.getElementById('cfgMaxConcurrent').value, 10) || 4;
      const aria2cFragments = parseInt(document.getElementById('cfgAriaFragments').value, 10) || 16;
      const bufferSize = document.getElementById('cfgBufferSize').value || '16M';
      const httpChunkSize = document.getElementById('cfgChunkSize').value || '10M';
      const retries = parseInt(document.getElementById('cfgRetries').value, 10) || 10;
      const aria2cMinSplitSize = document.getElementById('cfgMinSplit').value || '1M';

      const features = {
        movieHub: document.getElementById('switchMovieHub').checked,
        adultHub: document.getElementById('switchAdultHub').checked,
        torrentFallback: document.getElementById('switchTorrentFallback').checked,
        soulseekP2P: document.getElementById('switchSoulseekP2P').checked,
        strictLossless: document.getElementById('switchStrictLossless').checked,
        embedSubs: document.getElementById('switchEmbedSubs').checked,
        embedChapters: document.getElementById('switchEmbedChapters').checked,
        sponsorBlock: document.getElementById('switchSponsorBlock').checked
      };

      try {
        const res = await fetch('/api/admin/engine-config', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`
          },
          body: JSON.stringify({
            maxConcurrentJobs,
            aria2cFragments,
            bufferSize,
            httpChunkSize,
            retries,
            aria2cMinSplitSize,
            features
          })
        });

        const data = await res.json();
        if (res.ok && data.success) {
          showToast('Engine configuration saved and active!');
        } else {
          showToast(data.error || 'Failed to save configuration', 'error');
        }
      } catch (err) {
        showToast('Error saving configuration: ' + err.message, 'error');
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<span>💾 Save &amp; Apply Configuration</span>';
      }
    });
  }
}

async function loadEngineConfig() {
  try {
    const res = await fetch('/api/admin/engine-config', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    const cfg = data.config || {};

    if (cfg.maxConcurrentJobs) document.getElementById('cfgMaxConcurrent').value = cfg.maxConcurrentJobs;
    if (cfg.aria2cFragments) document.getElementById('cfgAriaFragments').value = cfg.aria2cFragments;
    if (cfg.bufferSize) document.getElementById('cfgBufferSize').value = cfg.bufferSize;
    if (cfg.httpChunkSize) document.getElementById('cfgChunkSize').value = cfg.httpChunkSize;
    if (cfg.retries) document.getElementById('cfgRetries').value = cfg.retries;
    if (cfg.aria2cMinSplitSize) document.getElementById('cfgMinSplit').value = cfg.aria2cMinSplitSize;

    const feat = cfg.features || {};
    if (feat.movieHub !== undefined) document.getElementById('switchMovieHub').checked = !!feat.movieHub;
    if (feat.adultHub !== undefined) document.getElementById('switchAdultHub').checked = !!feat.adultHub;
    if (feat.torrentFallback !== undefined) document.getElementById('switchTorrentFallback').checked = !!feat.torrentFallback;
    if (feat.soulseekP2P !== undefined) document.getElementById('switchSoulseekP2P').checked = !!feat.soulseekP2P;
    if (feat.strictLossless !== undefined) document.getElementById('switchStrictLossless').checked = !!feat.strictLossless;
    if (feat.embedSubs !== undefined) document.getElementById('switchEmbedSubs').checked = !!feat.embedSubs;
    if (feat.embedChapters !== undefined) document.getElementById('switchEmbedChapters').checked = !!feat.embedChapters;
    if (feat.sponsorBlock !== undefined) document.getElementById('switchSponsorBlock').checked = !!feat.sponsorBlock;
  } catch (e) {}
}

// ==========================================================================
// 8. STORAGE EXPLORER & FILE MANAGER CONTROLLER
// ==========================================================================
let allStorageFiles = [];

function setupStorageExplorer() {
  const refreshBtn = document.getElementById('btnRefreshStorage');
  if (refreshBtn) refreshBtn.addEventListener('click', loadStorageFiles);

  const purgeIncompleteBtn = document.getElementById('btnStoragePurgeIncomplete');
  if (purgeIncompleteBtn) {
    purgeIncompleteBtn.addEventListener('click', async () => {
      if (!confirm('Purge all temporary fragment files (.part, .ytdl, .aria2)?')) return;
      try {
        const res = await fetch('/api/admin/storage/purge-incomplete', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        const data = await res.json();
        showToast(`Purged ${data.deletedCount} fragments, freed ${data.freedMB} MB!`);
        loadStorageFiles();
      } catch (e) {
        showToast('Purge failed: ' + e.message, 'error');
      }
    });
  }

  const searchInput = document.getElementById('storageSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', renderStorageTable);
  }
}

async function loadStorageFiles() {
  const tbody = document.getElementById('storageFilesTbody');
  try {
    const res = await fetch('/api/admin/storage/files', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    allStorageFiles = data.files || [];

    // Update disk bar
    const disk = data.disk || {};
    const numbers = document.getElementById('diskUsageNumbers');
    const barFill = document.getElementById('diskBarFill');
    if (numbers) numbers.textContent = `Used: ${disk.used || '--'} / Total: ${disk.total || '--'} (${disk.percentUsed || 0}% used)`;
    if (barFill) {
      barFill.style.width = `${Math.min(100, Math.max(0, disk.percentUsed || 0))}%`;
      if (disk.percentUsed > 85) barFill.style.background = '#f43f5e';
    }

    renderStorageTable();
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">Failed to load files: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderStorageTable() {
  const tbody = document.getElementById('storageFilesTbody');
  const countEl = document.getElementById('storageFileCount');
  if (!tbody) return;

  const q = (document.getElementById('storageSearchInput')?.value || '').toLowerCase();
  const filtered = allStorageFiles.filter(f => !q || f.name.toLowerCase().includes(q) || (f.ext && f.ext.includes(q)));

  if (countEl) countEl.textContent = `Showing ${filtered.length} of ${allStorageFiles.length} files`;

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center">No matching files found on storage.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(f => {
    const isFlac = f.ext === '.flac';
    const isVideo = f.isVideo;
    let badgeType = f.isFragment ? '<span class="badge-tag" style="background:#f59e0b20;color:#f59e0b">Fragment</span>' : '<span class="badge-tag">Completed</span>';

    return `
      <tr>
        <td class="file-name-cell" title="${escapeHtml(f.name)}">
          ${isFlac ? '🎵' : (isVideo ? '🎬' : '📄')} ${escapeHtml(f.name)}
        </td>
        <td><span class="badge-tag">${escapeHtml(f.category)}</span></td>
        <td><strong>${escapeHtml(f.sizeFormatted)}</strong></td>
        <td style="font-size: 0.78rem; color: var(--admin-text-muted);">${escapeHtml(f.mtimeFormatted)}</td>
        <td>
          <div class="table-actions-cell">
            ${f.downloadUrl ? `
              <a href="${f.downloadUrl}&admin_token=${encodeURIComponent(adminToken)}" class="btn btn-primary btn-xs" download title="Download to local device">⬇ Save</a>
            ` : ''}
            ${isFlac ? `
              <button type="button" class="btn btn-outline btn-xs" onclick="sendToFlacLab('${escapeHtml(f.fullPath)}')" title="Inspect spectrum in FLAC Analyzer">🔬 Analyze</button>
            ` : ''}
            <button type="button" class="btn btn-danger-outline btn-xs" onclick="deleteStorageFile('${escapeHtml(f.fullPath)}')" title="Delete file">🗑 Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

window.deleteStorageFile = async function(filePath) {
  if (!confirm(`Permanently delete file: ${filePath}?`)) return;
  try {
    const res = await fetch('/api/admin/storage/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ filePath })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'File deleted');
      loadStorageFiles();
    } else {
      showToast(data.error || 'Failed to delete file', 'error');
    }
  } catch (e) {
    showToast('Delete error: ' + e.message, 'error');
  }
};

window.sendToFlacLab = function(filePath) {
  const tabBtn = document.querySelector('.admin-tabs button[data-tab="flac-lab"]');
  if (tabBtn) tabBtn.click();
  const input = document.getElementById('flacFilePath');
  if (input) {
    input.value = filePath;
    const runBtn = document.getElementById('runFlacTestBtn');
    if (runBtn) runBtn.click();
  }
};

// ==========================================================================
// 9. NETWORK HEALTH BENCH CONTROLLER
// ==========================================================================
function setupNetworkHealth() {
  const btn = document.getElementById('btnTestNetworkHealth');
  if (btn) btn.addEventListener('click', loadNetworkHealth);
}

async function loadNetworkHealth() {
  const grid = document.getElementById('networkHealthGrid');
  const btn = document.getElementById('btnTestNetworkHealth');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = 'Probing APIs...';
  }
  if (grid) grid.innerHTML = '<div class="empty-state">Running live latency probes to all 7 upstream services...</div>';

  try {
    const res = await fetch('/api/admin/health-bench', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const results = data.results || [];

    if (grid) {
      grid.innerHTML = results.map(r => `
        <div class="health-card">
          <div class="health-card-top">
            <span class="health-name">${escapeHtml(r.name)}</span>
            <span class="latency-badge ${r.tier}">${r.ok ? `${r.latencyMs} ms` : 'FAILED'}</span>
          </div>
          <span class="health-url">${escapeHtml(r.url)}</span>
          <div class="health-status-text">
            <span>Status: <strong>${r.status || 'ERR'} (${escapeHtml(r.statusText)})</strong></span>
          </div>
        </div>
      `).join('');
    }
  } catch (e) {
    if (grid) grid.innerHTML = `<div class="empty-state text-danger">Health probe failed: ${escapeHtml(e.message)}</div>`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '⚡ Test All Services Now';
    }
  }
}

// ==========================================================================
// 10. TERMINAL CONSOLE & MAINTAINER SHELL CONTROLLER
// ==========================================================================
function setupTerminalConsole() {
  const form = document.getElementById('terminalShellForm');
  const input = document.getElementById('terminalShellInput');
  const clearBtn = document.getElementById('btnClearTerminalBtn');

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const cmd = (input?.value || '').trim();
      if (cmd) {
        runTerminalCommand(cmd);
        if (input) input.value = '';
      }
    });
  }

  document.querySelectorAll('.btn-preset-cmd').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = btn.getAttribute('data-cmd');
      if (cmd) runTerminalCommand(cmd);
    });
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const out = document.getElementById('terminalShellOutput');
      if (out) out.textContent = 'Ready. Select a 1-click preset above or enter a custom command below.';
    });
  }
}

function focusTerminalInput() {
  setTimeout(() => {
    const input = document.getElementById('terminalShellInput');
    if (input) input.focus();
  }, 100);
}

async function runTerminalCommand(command) {
  const out = document.getElementById('terminalShellOutput');
  const btn = document.getElementById('btnRunShellCmd');
  if (out) out.textContent = `$ ${command}\nExecuting command on server...`;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = 'Running...';
  }

  try {
    const res = await fetch('/api/admin/terminal/exec', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ command })
    });

    const data = await res.json();
    if (out) {
      out.textContent = `$ ${command}\n[Exit Code: ${data.exitCode}]\n\n${data.output || '(No output)'}`;
      out.scrollTop = out.scrollHeight;
    }
  } catch (err) {
    if (out) out.textContent = `$ ${command}\nExecution error: ${err.message}`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'Execute';
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
