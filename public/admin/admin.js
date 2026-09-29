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
  setupUsersTab();

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
  const rememberedAdmin = localStorage.getItem('sakura_admin_remembered_user');
  const userInp = document.getElementById('adminUser');
  const passInp = document.getElementById('adminPass');
  const rememberCheckbox = document.getElementById('adminRememberMe');
  if (rememberCheckbox) {
    rememberCheckbox.checked = localStorage.getItem('sakura_admin_remember_me') !== 'false';
  }
  if (userInp && rememberedAdmin) {
    userInp.value = rememberedAdmin;
    if (passInp) setTimeout(() => passInp.focus(), 60);
  } else if (userInp) {
    setTimeout(() => userInp.focus(), 60);
  }
}

function showApp() {
  loginModal.style.display = 'none';
  adminApp.style.display = 'flex';
  loadAllAdminData();
  if (typeof initAdminQueueSSE === 'function') initAdminQueueSSE();
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
  const rememberCheckbox = document.getElementById('adminRememberMe');
  const rememberMe = rememberCheckbox ? rememberCheckbox.checked : true;

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, rememberMe })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      adminToken = data.token;
      sessionStorage.setItem('sakura_admin_token', adminToken);
      if (rememberMe) {
        localStorage.setItem('sakura_admin_token', adminToken);
        localStorage.setItem('sakura_admin_remembered_user', username);
        localStorage.setItem('sakura_admin_remember_me', 'true');
      } else {
        localStorage.removeItem('sakura_admin_token');
        localStorage.removeItem('sakura_admin_remembered_user');
        localStorage.setItem('sakura_admin_remember_me', 'false');
      }
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

// Theme Metadata Presets Map
const THEME_PRESETS = {
  sakura: {
    title: 'Sakura Dark (Default)',
    desc: 'Production glassmorphism with deep navy hues and neon-rose/cyan highlights.',
    previewClass: 'preview-sakura',
    badgeClass: 'p-badge pink',
    badgeText: 'READY',
    btnClass: 'p-btn primary',
    btnText: 'Download',
    bg: '#090d16',
    accent: '#38bdf8',
    badge: '#f43f5e'
  },
  cyberpunk: {
    title: 'Cyberpunk Synthwave',
    desc: 'High-contrast neon styling with radioactive cyan, hot pink glow, and dark grid vibes.',
    previewClass: 'preview-cyberpunk',
    badgeClass: 'p-badge pink',
    badgeText: 'SYNTH',
    btnClass: 'p-btn cyan',
    btnText: 'Download',
    bg: '#090814',
    accent: '#00f0ff',
    badge: '#ff007f'
  },
  obsidian: {
    title: 'Midnight Obsidian',
    desc: 'Ultra-dark OLED stealth matte black UI with emerald green status accents.',
    previewClass: 'preview-obsidian',
    badgeClass: 'p-badge green',
    badgeText: 'ACTIVE',
    btnClass: 'p-btn green',
    btnText: 'Download',
    bg: '#050507',
    accent: '#10b981',
    badge: '#10b981'
  },
  frost: {
    title: 'Frost Glassmorphism',
    desc: 'Nordic frosted translucent acrylic cards with sky-blue accents and soft backdrop blur.',
    previewClass: 'preview-frost',
    badgeClass: 'p-badge ice',
    badgeText: 'ICE',
    btnClass: 'p-btn ice',
    btnText: 'Download',
    bg: '#0b1320',
    accent: '#7dd3fc',
    badge: '#38bdf8'
  },
  matrix: {
    title: 'Retro Matrix Terminal',
    desc: 'Hacker CRT phosphor-green palette with monospace typography and scanline aesthetics.',
    previewClass: 'preview-matrix',
    badgeClass: 'p-badge green',
    badgeText: 'TERM',
    btnClass: 'p-btn green',
    btnText: 'Download',
    bg: '#020703',
    accent: '#00ff41',
    badge: '#00ff41'
  },
  'minimal-slate': {
    title: 'Minimalist Slate',
    desc: 'Clean modern UI with high-contrast slate surfaces and indigo action buttons.',
    previewClass: 'preview-slate',
    badgeClass: 'p-badge indigo',
    badgeText: 'SLATE',
    btnClass: 'p-btn indigo',
    btnText: 'Download',
    bg: '#0f172a',
    accent: '#6366f1',
    badge: '#818cf8'
  }
};

function updateCompactThemeBanner(themeName) {
  const preset = THEME_PRESETS[themeName] || THEME_PRESETS.sakura;
  const bannerBox = document.getElementById('bannerPreviewBox');
  const bannerBadge = document.getElementById('bannerBadge');
  const bannerBtn = document.getElementById('bannerBtn');
  const bannerTitle = document.getElementById('bannerThemeTitle');
  const bannerDesc = document.getElementById('bannerThemeDesc');
  const swatchBg = document.getElementById('swatchBg');
  const swatchAccent = document.getElementById('swatchAccent');
  const swatchBadge = document.getElementById('swatchBadge');
  const activeSwatch = document.getElementById('themeActiveSwatch');

  if (bannerBox) {
    bannerBox.className = `banner-preview-box ${preset.previewClass}`;
  }
  if (bannerBadge) {
    bannerBadge.className = preset.badgeClass;
    bannerBadge.textContent = preset.badgeText;
  }
  if (bannerBtn) {
    bannerBtn.className = preset.btnClass;
    bannerBtn.textContent = preset.btnText;
  }
  if (bannerTitle) {
    bannerTitle.textContent = preset.title;
  }
  if (bannerDesc) {
    bannerDesc.textContent = preset.desc;
  }
  if (swatchBg) swatchBg.style.background = preset.bg;
  if (swatchAccent) swatchAccent.style.background = preset.accent;
  if (swatchBadge) swatchBadge.style.background = preset.badge;
  if (activeSwatch) {
    activeSwatch.style.backgroundColor = preset.accent;
    activeSwatch.style.boxShadow = `0 0 8px ${preset.accent}`;
  }
}

// Navigation Tabs with Dropdown Jump Sync
function setupNavigation() {
  const tabs = document.querySelectorAll('.admin-tabs .tab-btn');
  const tabDropdown = document.getElementById('adminTabDropdown');

  function activateTab(tabName) {
    tabs.forEach(t => {
      if (t.getAttribute('data-tab') === tabName) {
        t.classList.add('active');
      } else {
        t.classList.remove('active');
      }
    });

    const targetId = `tab-${tabName}`;
    document.querySelectorAll('.tab-panel').forEach(p => {
      p.classList.remove('active');
      if (p.id === targetId) p.classList.add('active');
    });

    if (tabDropdown && tabDropdown.value !== tabName) {
      tabDropdown.value = tabName;
    }

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
    } else if (tabName === 'users') {
      loadAdminUsers();
      loadAccessRequests();
      loadRolePermissions();
    }
  }

  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.getAttribute('data-tab');
      activateTab(tabName);
    });
  });

  if (tabDropdown) {
    tabDropdown.addEventListener('change', () => {
      activateTab(tabDropdown.value);
    });
  }
}

function loadAllAdminData() {
  loadServiceStatus();
  loadEngineConfig();
  loadSystemMetrics();
  loadCredsData();
  loadAdminUsers();
  loadAccessRequests();
  loadRolePermissions();
  updateSandboxIframe();
}

// 1. UI/UX LAB LOGIC (Compact Dropdown + Full Accordion Suite)
function setupUiLab() {
  const themeDropdown = document.getElementById('themeSelectDropdown');
  const densityDropdown = document.getElementById('densitySelectDropdown');
  const viewModeDropdown = document.getElementById('themeViewModeDropdown');
  const galleryWrap = document.getElementById('themeGalleryWrap');
  const btnApply = document.getElementById('btnApplySelectedTheme');
  const btnSetGlobal = document.getElementById('btnSetGlobalSelectedTheme');

  // Theme Dropdown Change
  if (themeDropdown) {
    themeDropdown.value = currentActiveTheme;
    themeDropdown.addEventListener('change', () => {
      const theme = themeDropdown.value;
      currentActiveTheme = theme;
      localStorage.setItem('preview_theme', theme);
      updateSandboxIframe();
      showToast(`Selected theme: ${theme}`);
    });
  }

  // Density Dropdown Change
  if (densityDropdown) {
    densityDropdown.value = currentActiveDensity;
    densityDropdown.addEventListener('change', () => {
      const density = densityDropdown.value;
      currentActiveDensity = density;
      localStorage.setItem('preview_density', density);
      updateSandboxIframe();
      showToast(`Density set to: ${density}`);
    });
  }

  // Cards View Mode Dropdown
  if (viewModeDropdown) {
    viewModeDropdown.addEventListener('change', () => {
      if (galleryWrap) {
        galleryWrap.style.display = viewModeDropdown.value === 'gallery' ? 'block' : 'none';
      }
    });
  }

  // Quick Action: Apply Local
  if (btnApply) {
    btnApply.addEventListener('click', () => {
      const theme = themeDropdown ? themeDropdown.value : currentActiveTheme;
      const density = densityDropdown ? densityDropdown.value : currentActiveDensity;
      currentActiveTheme = theme;
      currentActiveDensity = density;
      localStorage.setItem('preview_theme', theme);
      localStorage.setItem('preview_density', density);
      updateSandboxIframe();
      showToast(`Applied local preview: ${theme} • ${density}`);
    });
  }

  // Quick Action: Set Global
  if (btnSetGlobal) {
    btnSetGlobal.addEventListener('click', async () => {
      const theme = themeDropdown ? themeDropdown.value : currentActiveTheme;
      const density = densityDropdown ? densityDropdown.value : currentActiveDensity;
      try {
        const res = await fetch('/api/admin/ui-settings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`
          },
          body: JSON.stringify({ theme, density })
        });
        if (res.ok) {
          currentActiveTheme = theme;
          currentActiveDensity = density;
          localStorage.setItem('preview_theme', theme);
          localStorage.setItem('preview_density', density);
          updateSandboxIframe();
          showToast(`Global settings updated: ${theme} • ${density}`);
        } else {
          showToast('Failed to set global settings', 'error');
        }
      } catch (err) {
        showToast('Error updating settings: ' + err.message, 'error');
      }
    });
  }

  // Apply Local buttons (in 6-card gallery)
  document.querySelectorAll('.apply-theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.getAttribute('data-theme');
      currentActiveTheme = theme;
      localStorage.setItem('preview_theme', theme);
      if (themeDropdown) themeDropdown.value = theme;
      updateSandboxIframe();
      showToast(`Applied local preview theme: ${theme}`);
    });
  });

  // Set Global buttons (in 6-card gallery)
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
          if (themeDropdown) themeDropdown.value = theme;
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
  // Density Buttons (in collapsible accordion)
  document.querySelectorAll('.density-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.density-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const density = btn.getAttribute('data-density');
      currentActiveDensity = density;
      localStorage.setItem('preview_density', density);
      if (densityDropdown) densityDropdown.value = density;
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
      if (themeDropdown) themeDropdown.value = 'sakura';
      if (densityDropdown) densityDropdown.value = 'standard';
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
  const densityLabels = {
    standard: 'Standard',
    compact: 'Compact',
    grid: 'Grid',
    minimal: 'Minimalist Corporate'
  };
  const formattedDensity = densityLabels[currentActiveDensity] || (currentActiveDensity.charAt(0).toUpperCase() + currentActiveDensity.slice(1));
  if (sandboxActiveTheme) {
    sandboxActiveTheme.textContent = `Active Theme: ${currentActiveTheme.toUpperCase()} • Density: ${formattedDensity}`;
  }
  const densityBadge = document.getElementById('activeDensityBadge');
  if (densityBadge) {
    densityBadge.textContent = `Current: ${formattedDensity}`;
  }
  const themeDropdown = document.getElementById('themeSelectDropdown');
  if (themeDropdown && themeDropdown.value !== currentActiveTheme) {
    themeDropdown.value = currentActiveTheme;
  }
  const densityDropdown = document.getElementById('densitySelectDropdown');
  if (densityDropdown && densityDropdown.value !== currentActiveDensity) {
    densityDropdown.value = currentActiveDensity;
  }

  updateCompactThemeBanner(currentActiveTheme);

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
        if (res.status === 401) {
          resBox.className = 'test-result-box error';
          resBox.textContent = `✗ Session Expired: Please log in again.`;
          showToast('Admin session expired. Please sign in again.', 'error');
          setTimeout(() => showLogin(), 1000);
          return;
        }

        const data = await res.json();
        if (res.ok && data.valid) {
          resBox.className = 'test-result-box success';
          resBox.textContent = `✓ Token Verified! Account: ${data.user || 'HiFi Subscriber'} • Country: ${data.country || 'Global'} • Lossless 1411k: ${data.canStreamLossless ? 'ACTIVE' : 'STANDARD'}`;
          const dzBadge = document.getElementById('deezerStatusBadge');
          if (dzBadge) {
            dzBadge.textContent = 'Configured (Verified)';
            dzBadge.className = 'badge-tag success';
          }
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

        if (res.status === 401) {
          statusEl.textContent = '✗ Session Expired: Please log in again.';
          showToast('Admin session expired. Please sign in again.', 'error');
          setTimeout(() => showLogin(), 1000);
          return;
        }

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
let adminQueueSSE = null;

function renderAdminQueue(jobs) {
  const listEl = document.getElementById('adminQueueList');
  if (!listEl) return;

  if (!jobs || jobs.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No downloads currently in queue.</div>';
    return;
  }

  listEl.innerHTML = jobs.map(job => renderAdminQueueRowHtml(job)).join('');
}

function renderAdminQueueRowHtml(job) {
  const safeTitle = escapeHtml(job.title || job.filename || 'Task ' + job.id);
  const safeOwner = escapeHtml(job.ownerId || 'owner');
  const pct = (job.progress && typeof job.progress.percent === 'number') ? job.progress.percent.toFixed(1) : '0.0';
  const spd = (job.progress && job.progress.speed) || '0 MB/s';
  const eta = (job.progress && job.progress.eta) || '--';

  return `
    <div class="queue-row" id="admin-queue-row-${job.id}">
      <div class="queue-row-info">
        <h4>${safeTitle}</h4>
        <div class="queue-row-meta" id="admin-queue-meta-${job.id}">
          <span>[${job.status.toUpperCase()}]</span> &bull; 
          <span>User: <strong>${safeOwner}</strong></span> &bull; 
          <span>${pct}%</span> &bull; 
          <span>${spd}</span> &bull; 
          <span>ETA: ${eta}</span>
        </div>
      </div>
      <div class="queue-row-actions" id="admin-queue-actions-${job.id}">
        ${job.status === 'downloading' ? `
          <button class="btn btn-warning btn-sm" onclick="adminPauseJob('${job.id}')">Pause</button>
        ` : job.status === 'paused' ? `
          <button class="btn btn-primary btn-sm" onclick="adminResumeJob('${job.id}')">Resume</button>
        ` : ''}
        <button class="btn btn-danger-outline btn-sm" onclick="adminCancelJob('${job.id}')">Cancel</button>
      </div>
    </div>
  `;
}

function updateAdminQueueRow(job) {
  const listEl = document.getElementById('adminQueueList');
  if (!listEl) return;

  const existingRow = document.getElementById(`admin-queue-row-${job.id}`);
  if (!existingRow) {
    const emptyState = listEl.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
    listEl.insertAdjacentHTML('afterbegin', renderAdminQueueRowHtml(job));
    return;
  }

  const metaEl = document.getElementById(`admin-queue-meta-${job.id}`);
  if (metaEl) {
    const safeOwner = escapeHtml(job.ownerId || 'owner');
    const pct = (job.progress && typeof job.progress.percent === 'number') ? job.progress.percent.toFixed(1) : '0.0';
    const spd = (job.progress && job.progress.speed) || '0 MB/s';
    const eta = (job.progress && job.progress.eta) || '--';
    metaEl.innerHTML = `
      <span>[${job.status.toUpperCase()}]</span> &bull; 
      <span>User: <strong>${safeOwner}</strong></span> &bull; 
      <span>${pct}%</span> &bull; 
      <span>${spd}</span> &bull; 
      <span>ETA: ${eta}</span>
    `;
  }

  const actionsEl = document.getElementById(`admin-queue-actions-${job.id}`);
  if (actionsEl) {
    actionsEl.innerHTML = `
      ${job.status === 'downloading' ? `
        <button class="btn btn-warning btn-sm" onclick="adminPauseJob('${job.id}')">Pause</button>
      ` : job.status === 'paused' ? `
        <button class="btn btn-primary btn-sm" onclick="adminResumeJob('${job.id}')">Resume</button>
      ` : ''}
      <button class="btn btn-danger-outline btn-sm" onclick="adminCancelJob('${job.id}')">Cancel</button>
    `;
  }
}

function initAdminQueueSSE() {
  if (adminQueueSSE) {
    try { adminQueueSSE.close(); } catch (e) {}
    adminQueueSSE = null;
  }
  if (!adminToken) return;

  try {
    const es = new EventSource(`/api/jobs/stream?token=${encodeURIComponent(adminToken)}&all=1`);
    adminQueueSSE = es;

    es.addEventListener('sync', (e) => {
      try {
        const jobs = JSON.parse(e.data);
        if (Array.isArray(jobs)) renderAdminQueue(jobs);
      } catch (err) {}
    });

    es.onmessage = (e) => {
      if (!e.data || e.data.startsWith(':')) return;
      try {
        const jobs = JSON.parse(e.data);
        if (Array.isArray(jobs)) renderAdminQueue(jobs);
      } catch (err) {}
    };

    es.addEventListener('job_progress', (e) => {
      try {
        const job = JSON.parse(e.data);
        if (job && job.id) updateAdminQueueRow(job);
      } catch (err) {}
    });

    es.addEventListener('ping', () => {});

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        try { es.close(); } catch (err) {}
        adminQueueSSE = null;
        setTimeout(initAdminQueueSSE, 3000);
      }
    };
  } catch (err) {
    console.warn('Failed to start Admin Queue SSE:', err);
  }
}

function setupQueue() {
  const refreshQueueBtn = document.getElementById('refreshQueueBtn');
  if (refreshQueueBtn) refreshQueueBtn.addEventListener('click', loadQueueData);

  const clearBtn = document.getElementById('adminClearCompletedBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/jobs?all=1', {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        loadQueueData();
        showToast('Cleared completed jobs.');
      } catch (e) {}
    });
  }

  initAdminQueueSSE();
}

async function loadQueueData() {
  const listEl = document.getElementById('adminQueueList');
  if (!listEl) return;

  try {
    const res = await fetch('/api/jobs?all=1', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const jobs = await res.json();
    renderAdminQueue(jobs);
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
        sponsorBlock: document.getElementById('switchSponsorBlock').checked,
        ddlSource: document.getElementById('switchSourceDdl') ? document.getElementById('switchSourceDdl').checked : true,
        ytsSource: document.getElementById('switchSourceYts') ? document.getElementById('switchSourceYts').checked : false,
        torrentsSource: document.getElementById('switchSourceTorrents') ? document.getElementById('switchSourceTorrents').checked : false
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

  // Work In Progress / Maintenance Mode Controls
  const switchMaintenance = document.getElementById('switchMaintenanceMode');
  const inputMaintMsg = document.getElementById('inputMaintenanceMessage');
  const btnSaveMaintMsg = document.getElementById('btnSaveMaintenanceMsg');

  function updateAdminMaintenanceUI(active, msg) {
    const pill = document.getElementById('adminMaintStatusPill');
    const text = document.getElementById('adminMaintStatusText');
    const hdrBadge = document.getElementById('headerMaintBadge');
    if (switchMaintenance) switchMaintenance.checked = !!active;
    if (inputMaintMsg && typeof msg === 'string' && msg.trim()) inputMaintMsg.value = msg.trim();
    if (pill && text) {
      if (active) {
        pill.className = 'maint-status-pill pill-active';
        text.textContent = 'ACTIVE (Public Blocked)';
      } else {
        pill.className = 'maint-status-pill pill-inactive';
        text.textContent = 'INACTIVE (Public Live)';
      }
    }
    if (hdrBadge) {
      hdrBadge.style.display = active ? 'inline-flex' : 'none';
    }
  }

  async function saveMaintenanceSettings(active, message, showFeedback = true) {
    try {
      const res = await fetch('/api/admin/maintenance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          maintenanceMode: !!active,
          maintenanceMessage: message || (inputMaintMsg ? inputMaintMsg.value : '')
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        updateAdminMaintenanceUI(data.maintenanceMode, data.maintenanceMessage);
        if (showFeedback) {
          showToast(data.message || (data.maintenanceMode ? 'Work In Progress Mode Activated' : 'Work In Progress Mode Deactivated'));
        }
      } else {
        showToast(data.error || 'Failed to update maintenance setting', 'error');
        if (switchMaintenance) switchMaintenance.checked = !active;
      }
    } catch (err) {
      showToast('Network error: ' + err.message, 'error');
      if (switchMaintenance) switchMaintenance.checked = !active;
    }
  }

  if (switchMaintenance) {
    switchMaintenance.addEventListener('change', () => {
      const isChecked = switchMaintenance.checked;
      const msg = inputMaintMsg ? inputMaintMsg.value.trim() : '';
      saveMaintenanceSettings(isChecked, msg);
    });
  }

  if (btnSaveMaintMsg) {
    btnSaveMaintMsg.addEventListener('click', () => {
      const isChecked = switchMaintenance ? switchMaintenance.checked : false;
      const msg = inputMaintMsg ? inputMaintMsg.value.trim() : '';
      saveMaintenanceSettings(isChecked, msg);
    });
  }

  // Category Filter Dropdown
  const engineCategoryDropdown = document.getElementById('engineCategoryDropdown');
  if (engineCategoryDropdown) {
    engineCategoryDropdown.addEventListener('change', () => {
      const selected = engineCategoryDropdown.value;
      const cardMap = {
        maintenance: document.getElementById('engineCardMaintenance'),
        concurrency: document.getElementById('engineCardConcurrency'),
        ddl: document.getElementById('engineCardDdl'),
        switches: document.getElementById('engineCardSwitches'),
        providers: document.getElementById('engineCardProviders')
      };

      if (selected === 'all') {
        Object.values(cardMap).forEach(card => {
          if (card) card.style.display = '';
        });
      } else {
        Object.entries(cardMap).forEach(([key, card]) => {
          if (card) card.style.display = key === selected ? '' : 'none';
        });
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

    // Work In Progress (Maintenance Mode) Status
    const switchMaint = document.getElementById('switchMaintenanceMode');
    const inputMsg = document.getElementById('inputMaintenanceMessage');
    const pill = document.getElementById('adminMaintStatusPill');
    const pillText = document.getElementById('adminMaintStatusText');
    const hdrBadge = document.getElementById('headerMaintBadge');

    const isMaintActive = !!cfg.maintenanceMode;
    if (switchMaint) switchMaint.checked = isMaintActive;
    if (inputMsg && cfg.maintenanceMessage) inputMsg.value = cfg.maintenanceMessage;
    if (pill && pillText) {
      if (isMaintActive) {
        pill.className = 'maint-status-pill pill-active';
        pillText.textContent = 'ACTIVE (Public Blocked)';
      } else {
        pill.className = 'maint-status-pill pill-inactive';
        pillText.textContent = 'INACTIVE (Public Live)';
      }
    }
    if (hdrBadge) {
      hdrBadge.style.display = isMaintActive ? 'inline-flex' : 'none';
    }

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
    if (feat.ddlSource !== undefined && document.getElementById('switchSourceDdl')) {
      document.getElementById('switchSourceDdl').checked = !!feat.ddlSource;
    }
    if (feat.ytsSource !== undefined && document.getElementById('switchSourceYts')) {
      document.getElementById('switchSourceYts').checked = !!feat.ytsSource;
    }
    if (feat.torrentsSource !== undefined && document.getElementById('switchSourceTorrents')) {
      document.getElementById('switchSourceTorrents').checked = !!feat.torrentsSource;
    }
  } catch (e) {}
}

// ==========================================================================
// 8. STORAGE EXPLORER & FILE MANAGER CONTROLLER
// ==========================================================================
let allStorageFiles = [];

function updateSelectedStorageUI() {
  const allCheckboxes = document.querySelectorAll('.storage-file-checkbox');
  const checkedBoxes = document.querySelectorAll('.storage-file-checkbox:checked');
  const selectAll = document.getElementById('storageSelectAll');
  const deleteSelectedBtn = document.getElementById('btnStorageDeleteSelected');
  const countSpan = document.getElementById('selectedFilesCount');

  if (selectAll) {
    selectAll.checked = allCheckboxes.length > 0 && checkedBoxes.length === allCheckboxes.length;
    selectAll.indeterminate = checkedBoxes.length > 0 && checkedBoxes.length < allCheckboxes.length;
  }

  if (deleteSelectedBtn) {
    if (checkedBoxes.length > 0) {
      deleteSelectedBtn.style.display = 'inline-flex';
      if (countSpan) countSpan.textContent = checkedBoxes.length;
    } else {
      deleteSelectedBtn.style.display = 'none';
    }
  }
}
window.updateSelectedStorageUI = updateSelectedStorageUI;

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

  const selectAllCheckbox = document.getElementById('storageSelectAll');
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('change', () => {
      const checked = selectAllCheckbox.checked;
      const checkboxes = document.querySelectorAll('.storage-file-checkbox');
      checkboxes.forEach(cb => { cb.checked = checked; });
      updateSelectedStorageUI();
    });
  }

  const deleteSelectedBtn = document.getElementById('btnStorageDeleteSelected');
  if (deleteSelectedBtn) {
    deleteSelectedBtn.addEventListener('click', async () => {
      const checkboxes = Array.from(document.querySelectorAll('.storage-file-checkbox:checked'));
      const paths = checkboxes.map(cb => cb.getAttribute('data-path')).filter(Boolean);

      if (paths.length === 0) {
        showToast('No files selected', 'warning');
        return;
      }

      if (!confirm(`Permanently delete ${paths.length} selected files? This action cannot be undone.`)) return;

      deleteSelectedBtn.disabled = true;
      deleteSelectedBtn.textContent = 'Deleting...';

      try {
        const res = await fetch('/api/admin/storage/delete-bulk', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`
          },
          body: JSON.stringify({ filePaths: paths })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(data.message || `Deleted ${data.deletedCount} files`);
          loadStorageFiles();
        } else {
          showToast(data.error || 'Failed to delete files', 'error');
        }
      } catch (e) {
        showToast('Delete error: ' + e.message, 'error');
      } finally {
        deleteSelectedBtn.disabled = false;
        deleteSelectedBtn.innerHTML = `🗑 Delete Selected (<span id="selectedFilesCount">0</span>)`;
        updateSelectedStorageUI();
      }
    });
  }

  const deleteAllBtn = document.getElementById('btnStorageDeleteAll');
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener('click', async () => {
      const q = (document.getElementById('storageSearchInput')?.value || '').trim();
      const filtered = allStorageFiles.filter(f => !q || f.name.toLowerCase().includes(q.toLowerCase()) || (f.ext && f.ext.toLowerCase().includes(q.toLowerCase())));

      if (filtered.length === 0) {
        showToast('No files to delete', 'warning');
        return;
      }

      const isFiltered = !!q && filtered.length < allStorageFiles.length;
      const msg = isFiltered
        ? `Permanently delete all ${filtered.length} filtered files matching "${q}"? This action cannot be undone.`
        : `Permanently delete ALL ${allStorageFiles.length} files from storage? This will remove all downloaded media and temporary files. This action cannot be undone.`;

      if (!confirm(msg)) return;

      deleteAllBtn.disabled = true;
      deleteAllBtn.textContent = 'Deleting...';

      try {
        const body = isFiltered
          ? { filePaths: filtered.map(f => f.fullPath) }
          : { deleteAll: true };

        const res = await fetch('/api/admin/storage/delete-bulk', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`
          },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(data.message || `Deleted ${data.deletedCount} files`);
          loadStorageFiles();
        } else {
          showToast(data.error || 'Failed to delete files', 'error');
        }
      } catch (e) {
        showToast('Delete error: ' + e.message, 'error');
      } finally {
        deleteAllBtn.disabled = false;
        deleteAllBtn.textContent = '🗑 Delete All';
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
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-center text-danger">Failed to load files: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderStorageTable() {
  const tbody = document.getElementById('storageFilesTbody');
  const countEl = document.getElementById('storageFileCount');
  const deleteAllBtn = document.getElementById('btnStorageDeleteAll');
  const selectAll = document.getElementById('storageSelectAll');
  const deleteSelectedBtn = document.getElementById('btnStorageDeleteSelected');

  if (selectAll) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
  }
  if (deleteSelectedBtn) {
    deleteSelectedBtn.style.display = 'none';
  }

  if (!tbody) return;

  const q = (document.getElementById('storageSearchInput')?.value || '').toLowerCase();
  const filtered = allStorageFiles.filter(f => !q || f.name.toLowerCase().includes(q) || (f.ext && f.ext.includes(q)));

  if (countEl) countEl.textContent = `Showing ${filtered.length} of ${allStorageFiles.length} files`;

  if (deleteAllBtn) {
    if (filtered.length === 0) {
      deleteAllBtn.disabled = true;
      deleteAllBtn.textContent = '🗑 Delete All';
    } else {
      deleteAllBtn.disabled = false;
      deleteAllBtn.textContent = q ? `🗑 Delete Filtered (${filtered.length})` : `🗑 Delete All (${allStorageFiles.length})`;
    }
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">No matching files found on storage.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(f => {
    const isFlac = f.ext === '.flac';
    const isVideo = f.isVideo;
    let badgeType = f.isFragment ? '<span class="badge-tag" style="background:#f59e0b20;color:#f59e0b">Fragment</span>' : '<span class="badge-tag">Completed</span>';

    return `
      <tr>
        <td style="text-align: center;">
          <input type="checkbox" class="storage-file-checkbox" data-path="${escapeHtml(f.fullPath)}" data-name="${escapeHtml(f.name)}" onchange="updateSelectedStorageUI()">
        </td>
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

// ==========================================================================
// User Accounts & Tier Administration
// ==========================================================================
function setupUsersTab() {
  const btnRefresh = document.getElementById('btnRefreshUsers');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      loadAdminUsers();
      loadAccessRequests();
      loadRolePermissions();
    });
  }

  initFolderAllocationModal();
  initChangePasswordModal();
  initUserPermissionsModal();

  const btnSavePerms = document.getElementById('btnSavePermissions');
  if (btnSavePerms) {
    btnSavePerms.addEventListener('click', saveRolePermissions);
  }

  const btnResetPerms = document.getElementById('btnResetPermissions');
  if (btnResetPerms) {
    btnResetPerms.addEventListener('click', resetRolePermissions);
  }

  const modal = document.getElementById('createUserModal');
  const btnOpen = document.getElementById('btnOpenCreateUserModal');
  const btnClose = document.getElementById('btnCloseCreateUserModal');
  const btnCancel = document.getElementById('btnCancelCreateUser');
  const btnGenPass = document.getElementById('btnGenPassword');
  const form = document.getElementById('createUserForm');

  function openCreateModal() {
    if (modal) {
      modal.style.display = 'flex';
      const userInp = document.getElementById('newAccountUsername');
      if (userInp) {
        userInp.value = '';
        setTimeout(() => userInp.focus(), 50);
      }
      const passInp = document.getElementById('newAccountPassword');
      if (passInp) passInp.value = 'User_' + Math.random().toString(36).substring(2, 8);
      const folderInp = document.getElementById('newAccountFolder');
      if (folderInp) folderInp.value = '';
      const errEl = document.getElementById('createUserError');
      if (errEl) errEl.style.display = 'none';
    }
  }

  function closeCreateModal() {
    if (modal) modal.style.display = 'none';
  }

  if (btnOpen) btnOpen.addEventListener('click', openCreateModal);
  if (btnClose) btnClose.addEventListener('click', closeCreateModal);
  if (btnCancel) btnCancel.addEventListener('click', closeCreateModal);
  if (btnGenPass) {
    btnGenPass.addEventListener('click', () => {
      const passInp = document.getElementById('newAccountPassword');
      if (passInp) passInp.value = 'User_' + Math.random().toString(36).substring(2, 8);
    });
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const userInp = document.getElementById('newAccountUsername');
      const passInp = document.getElementById('newAccountPassword');
      const roleInp = document.getElementById('newAccountRole');
      const folderInp = document.getElementById('newAccountFolder');
      const errEl = document.getElementById('createUserError');
      const submitBtn = document.getElementById('btnSubmitCreateUser');

      const username = userInp ? userInp.value.trim() : '';
      const password = passInp ? passInp.value : '';
      const role = roleInp ? roleInp.value : 'premium';
      const downloadFolder = folderInp ? folderInp.value.trim() : '';

      if (!username || username.length < 3) {
        if (errEl) {
          errEl.textContent = 'Username must be at least 3 characters.';
          errEl.style.display = 'block';
        }
        return;
      }
      if (!password || password.length < 6) {
        if (errEl) {
          errEl.textContent = 'Password must be at least 6 characters.';
          errEl.style.display = 'block';
        }
        return;
      }

      if (submitBtn) submitBtn.disabled = true;
      try {
        const res = await fetch('/api/admin/users/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`
          },
          body: JSON.stringify({ username, password, role, downloadFolder })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(`Account "${username}" created successfully!`, 'success');
          closeCreateModal();
          loadAdminUsers();
        } else {
          if (errEl) {
            errEl.textContent = data.error || 'Failed to create user account.';
            errEl.style.display = 'block';
          }
        }
      } catch (err) {
        if (errEl) {
          errEl.textContent = 'Network error while contacting server.';
          errEl.style.display = 'block';
        }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  // Assign Permanent Download Folder Modal Events
  const assignModal = document.getElementById('assignFolderModal');
  const btnCloseAssign = document.getElementById('btnCloseAssignFolderModal');
  const btnCancelAssign = document.getElementById('btnCancelAssignFolder');
  const assignForm = document.getElementById('assignFolderForm');

  window.closeAssignFolderModal = function() {
    if (assignModal) assignModal.style.display = 'none';
  };

  if (btnCloseAssign) btnCloseAssign.addEventListener('click', closeAssignFolderModal);
  if (btnCancelAssign) btnCancelAssign.addEventListener('click', closeAssignFolderModal);
  if (assignModal) {
    assignModal.addEventListener('click', (e) => {
      if (e.target === assignModal) closeAssignFolderModal();
    });
  }

  window.openAssignFolderModal = function(id, username, currentFolder) {
    if (!assignModal) return;
    const idInp = document.getElementById('assignFolderUserId');
    const userLabel = document.getElementById('assignFolderTargetUser');
    const pathInp = document.getElementById('assignFolderPath');
    const errEl = document.getElementById('assignFolderError');

    if (idInp) idInp.value = id;
    if (userLabel) userLabel.textContent = username;
    if (pathInp) pathInp.value = currentFolder || '';
    if (errEl) errEl.style.display = 'none';

    const btnSakura = document.getElementById('btnQuickFolderSakura');
    if (btnSakura) {
      btnSakura.onclick = () => {
        if (pathInp) pathInp.value = `/home/sakura/downloads/${username}`;
      };
    }
    const btnSlskd = document.getElementById('btnQuickFolderSlskd');
    if (btnSlskd) {
      btnSlskd.onclick = () => {
        if (pathInp) pathInp.value = `/home/sakura/slskd_downloads/${username}`;
      };
    }
    const btnClear = document.getElementById('btnClearFolder');
    if (btnClear) {
      btnClear.onclick = () => {
        if (pathInp) pathInp.value = '';
      };
    }

    assignModal.style.display = 'flex';
  };

  if (assignForm) {
    assignForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const idInp = document.getElementById('assignFolderUserId');
      const pathInp = document.getElementById('assignFolderPath');
      const errEl = document.getElementById('assignFolderError');
      const submitBtn = document.getElementById('btnSubmitAssignFolder');

      const id = idInp ? idInp.value : '';
      const downloadFolder = pathInp ? pathInp.value.trim() : '';

      if (submitBtn) submitBtn.disabled = true;
      try {
        const res = await fetch('/api/admin/users/folder', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`
          },
          body: JSON.stringify({ id, downloadFolder })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(data.message || 'Permanent folder updated successfully!', 'success');
          closeAssignFolderModal();
          loadAdminUsers();
        } else {
          if (errEl) {
            errEl.textContent = data.error || 'Failed to update user folder.';
            errEl.style.display = 'block';
          }
        }
      } catch (err) {
        if (errEl) {
          errEl.textContent = 'Network error while contacting server.';
          errEl.style.display = 'block';
        }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }
}

async function loadAdminUsers() {
  try {
    const res = await fetch('/api/admin/users', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    const users = data.users || [];

    const badge = document.getElementById('userCountBadge');
    if (badge) badge.textContent = `${users.length} Users`;

    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;

    if (users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 24px;">No registered members yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = users.map(u => {
      const dateStr = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : 'N/A';
      const isOwner = u.role === 'owner' || u.username.toLowerCase() === 'sakura';
      const isPrem = u.role === 'premium';
      const folders = Array.isArray(u.allowedFolders) && u.allowedFolders.length > 0
        ? u.allowedFolders
        : (u.downloadFolder ? [u.downloadFolder] : []);
      const folderCount = folders.length;
      const ownerDownloadFolder = u.downloadFolder || (folders.length > 0 ? folders[0] : '');

      let passwordCellHtml = '';
      if (u.password) {
        passwordCellHtml = `
          <div style="display: inline-flex; align-items: center; gap: 4px; background: rgba(0,0,0,0.35); padding: 4px 8px; border-radius: 6px; border: 1px solid var(--admin-border);">
            <code id="user-pw-${escapeHtml(u.id)}" data-pw="${escapeHtml(u.password)}" data-masked="true" style="font-family: monospace; font-size: 0.82rem; color: #a5f3fc; letter-spacing: 2px;">••••••••</code>
            <button type="button" class="btn btn-outline btn-xs" onclick="toggleInlinePassword('${escapeHtml(u.id)}')" title="Reveal / Hide password" style="border: none; background: transparent; padding: 2px 4px; font-size: 0.8rem; cursor: pointer; color: #94a3b8;">👁️</button>
            <button type="button" class="btn btn-outline btn-xs" onclick="copyInlinePassword('${escapeHtml(u.id)}')" title="Copy password" style="border: none; background: transparent; padding: 2px 4px; font-size: 0.8rem; cursor: pointer; color: #94a3b8;">📋</button>
          </div>
        `;
      } else {
        passwordCellHtml = `
          <div style="display: inline-flex; align-items: center; gap: 6px;">
            <span style="font-size: 0.72rem; color: var(--text-muted); font-style: italic; background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px;">Legacy Hashed</span>
            <button type="button" class="btn btn-outline btn-xs" onclick="openChangePasswordModal('${escapeHtml(u.id)}', '${escapeHtml(u.username)}', '', '${escapeHtml(u.role || 'user')}')" style="font-size: 0.72rem; padding: 2px 6px; border-color: #f59e0b; color: #fbbf24;" title="Set known password">Set 🔑</button>
          </div>
        `;
      }

      const folderDisplay = isOwner
        ? (ownerDownloadFolder
          ? `<div style="display: flex; flex-direction: column; gap: 3px;">
               <div style="display: inline-flex; align-items: center; gap: 4px; color: #fbbf24; font-size: 0.72rem; font-weight: 600;">
                 <span style="width: 6px; height: 6px; border-radius: 50%; background: #fbbf24;"></span> Root System Access
               </div>
               <span style="font-size: 0.75rem; color: #93c5fd; font-weight: 600;">📁 Permanent Folder:</span>
               <code style="font-size: 0.72rem; color: #a7f3d0; background: rgba(16,185,129,0.1); padding: 2px 6px; border-radius: 4px; word-break: break-all; max-width: 220px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(ownerDownloadFolder)}">
                 ${escapeHtml(ownerDownloadFolder)}
               </code>
               <span style="font-size: 0.68rem; color: #94a3b8;">🎬 Movies &amp; Shows • 🎵 Music • 🔞 Adult</span>
             </div>`
          : `<div style="display: flex; flex-direction: column; gap: 2px;">
               <div style="display: inline-flex; align-items: center; gap: 4px; color: #fbbf24; font-size: 0.72rem; font-weight: 600;">
                 <span style="width: 6px; height: 6px; border-radius: 50%; background: #fbbf24;"></span> Root System Access
               </div>
               <span style="font-size: 0.72rem; color: var(--text-muted); font-style: italic;">No permanent folder assigned (uses temp cache)</span>
             </div>`)
        : (folderCount > 0
          ? `<div style="display: flex; flex-direction: column; gap: 3px;">
               <span style="font-size: 0.75rem; color: #93c5fd; font-weight: 600;">📁 ${folderCount} folder${folderCount === 1 ? '' : 's'}:</span>
               <code style="font-size: 0.72rem; color: #a7f3d0; background: rgba(16,185,129,0.1); padding: 2px 6px; border-radius: 4px; word-break: break-all; max-width: 220px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(folders.join(', '))}">
                 ${escapeHtml(folders[0])}${folderCount > 1 ? ` +${folderCount - 1} more` : ''}
               </code>
               <span style="font-size: 0.68rem; color: #94a3b8;">🎬 Movies &amp; Shows • 🎵 Music • 🔞 Adult</span>
             </div>`
          : `<span style="font-size: 0.75rem; color: var(--text-muted); font-style: italic;">Default (Temp Cache)</span>`);

      return `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05); ${isOwner ? 'background: rgba(245,158,11,0.04);' : ''}">
          <td style="padding: 12px 14px;">
            <div><strong>${escapeHtml(u.username)}</strong></div>
            ${isOwner 
              ? '<div style="font-size: 0.72rem; color: #fbbf24; margin-top: 2px;">⚡ Full System Access</div>' 
              : `<div style="display: flex; align-items: center; gap: 6px; margin-top: 2px; flex-wrap: wrap;">
                   <span style="font-size: 0.72rem; color: #94a3b8;">📁 ${folderCount} folder${folderCount === 1 ? '' : 's'}</span>
                   ${u.hasCustomPermissions 
                     ? '<span style="font-size: 0.68rem; color: #c4b5fd; background: rgba(139,92,246,0.18); border: 1px solid rgba(139,92,246,0.4); padding: 1px 6px; border-radius: 4px; font-weight: 600;" title="Individual permissions customized by owner">⚡ Custom Perms</span>' 
                     : '<span style="font-size: 0.68rem; color: var(--text-muted); background: rgba(255,255,255,0.05); padding: 1px 5px; border-radius: 4px;">Role Default</span>'}
                 </div>`}
          </td>
          <td style="padding: 12px 14px;"><code style="font-size: 0.8rem; color: #93c5fd;">${escapeHtml(u.id)}</code></td>
          <td style="padding: 12px 14px;">
            <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 700; ${isOwner ? 'background: linear-gradient(135deg, rgba(245,158,11,0.3) 0%, rgba(217,119,6,0.3) 100%); color: #fef08a; border: 1px solid rgba(245,158,11,0.6);' : (isPrem ? 'background: rgba(245,158,11,0.2); color: #fbbf24; border: 1px solid rgba(245,158,11,0.4);' : 'background: rgba(255,255,255,0.08); color: #94a3b8; border: 1px solid rgba(255,255,255,0.12);')}">
              ${isOwner ? '👑 OWNER' : escapeHtml(u.role ? u.role.toUpperCase() : 'USER')}
            </span>
          </td>
          <td style="padding: 12px 14px;">${passwordCellHtml}</td>
          <td style="padding: 12px 14px;">${folderDisplay}</td>
          <td style="padding: 12px 14px; color: var(--text-muted);">${dateStr}</td>
          <td style="padding: 12px 14px; text-align: right;">
            <div style="display: inline-flex; gap: 6px; align-items: center; justify-content: flex-end;">
              ${isOwner ? `
                <button type="button" class="btn btn-outline btn-xs" onclick="openChangePasswordModal('${escapeHtml(u.id)}', '${escapeHtml(u.username)}', '${escapeHtml(u.password || '')}', 'owner')" style="border-color: #eab308; color: #fde047; font-size: 0.75rem; padding: 3px 8px;" title="View or change owner password">
                  🔑 Password
                </button>
                <button type="button" class="btn btn-primary btn-xs" onclick="openFolderAllocationModal('${escapeHtml(u.id)}', '${escapeHtml(u.username)}', 'owner')" style="font-size: 0.75rem; padding: 3px 8px;" title="Browse drives and assign permanent folder">
                  📁 Assign Folder
                </button>
                <button type="button" class="btn btn-outline btn-xs" onclick="openQuickFolderPrompt('${escapeHtml(u.id)}', '${escapeHtml(u.username)}', '${escapeHtml(ownerDownloadFolder)}')" style="border-color: #3b82f6; color: #60a5fa; font-size: 0.75rem; padding: 3px 8px;" title="Set or edit path directly">
                  ✏️ Path
                </button>
                <span style="display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 600; color: #fbbf24; background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.3);">
                  👑 Owner
                </span>
              ` : `
                <button type="button" class="btn btn-outline btn-xs" onclick="openUserPermissionsModal('${escapeHtml(u.id)}', '${escapeHtml(u.username)}', '${escapeHtml(u.role || 'user')}')" style="border-color: #8b5cf6; color: #c4b5fd; font-size: 0.75rem; padding: 3px 8px;" title="Configure individual feature permissions for this user">
                  🛡️ Perms${u.hasCustomPermissions ? ' ⚡' : ''}
                </button>
                <button type="button" class="btn btn-outline btn-xs" onclick="openChangePasswordModal('${escapeHtml(u.id)}', '${escapeHtml(u.username)}', '${escapeHtml(u.password || '')}', '${escapeHtml(u.role || 'user')}')" style="border-color: #eab308; color: #fde047; font-size: 0.75rem; padding: 3px 8px;" title="View or change user password">
                  🔑 Password
                </button>
                <button type="button" class="btn btn-outline btn-xs" onclick="openFolderAllocationModal('${escapeHtml(u.id)}', '${escapeHtml(u.username)}', '${escapeHtml(u.role || 'user')}')" style="border-color: #3b82f6; color: #60a5fa;" title="Configure folder allocations">
                  📁 Folders (${folderCount})
                </button>
                <button type="button" class="btn btn-outline btn-xs" onclick="openQuickFolderPrompt('${escapeHtml(u.id)}', '${escapeHtml(u.username)}', '${escapeHtml(u.downloadFolder || '')}')" style="border-color: #3b82f6; color: #60a5fa; font-size: 0.75rem; padding: 3px 8px;" title="Set or edit path directly">
                  ✏️ Path
                </button>
                <button type="button" class="btn btn-outline btn-xs" onclick="toggleUserRole('${escapeHtml(u.id)}', '${isPrem ? 'user' : 'premium'}')">
                  ${isPrem ? 'Demote' : 'Make Premium'}
                </button>
                <button type="button" class="btn btn-danger-outline btn-xs" onclick="deleteUserAccount('${escapeHtml(u.id)}', '${escapeHtml(u.username)}')">
                  Delete
                </button>
              `}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (e) {}
}

window.openQuickFolderPrompt = async function(userId, username, currentPath) {
  const defaultVal = currentPath || (username.toLowerCase() === 'sakura' ? '/media/storage/sakura' : `/media/storage/${username}`);
  const entered = prompt(
    `Assign permanent download folder for "${username}":\n(Subfolders "Movies and Shows", "Music", "Adult", and "Links" will be automatically created inside)`,
    defaultVal
  );
  if (entered === null) return;
  const cleanPath = entered.trim();
  try {
    const res = await fetch('/api/admin/users/folder', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ id: userId, downloadFolder: cleanPath })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message || `Assigned folder for "${username}" updated!`, 'success');
      loadAdminUsers();
    } else {
      showToast(data.error || 'Failed to update folder', 'error');
    }
  } catch (err) {
    showToast('Network error updating download folder', 'error');
  }
};

async function loadAccessRequests() {
  try {
    const res = await fetch('/api/admin/access-requests', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    const requests = data.requests || [];

    const badge = document.getElementById('requestsCountBadge');
    if (badge) {
      const pendingCount = requests.filter(r => r.status === 'pending').length;
      badge.textContent = `${pendingCount} Pending (${requests.length} Total)`;
    }

    const tbody = document.getElementById('accessRequestsTableBody');
    if (!tbody) return;

    if (requests.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 24px;">No guest access applications submitted yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = requests.map(r => {
      const dateStr = r.createdAt ? new Date(r.createdAt).toLocaleString() : 'N/A';
      const isPending = r.status === 'pending';
      const isApproved = r.status === 'approved';
      const isRejected = r.status === 'rejected';

      let statusBadge = `<span style="padding: 2px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 700; background: rgba(245,158,11,0.2); color: #fbbf24; border: 1px solid rgba(245,158,11,0.4);">PENDING</span>`;
      if (isApproved) {
        statusBadge = `<span style="padding: 2px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 700; background: rgba(16,185,129,0.2); color: #34d399; border: 1px solid rgba(16,185,129,0.4);">APPROVED</span>`;
      } else if (isRejected) {
        statusBadge = `<span style="padding: 2px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 700; background: rgba(239,68,68,0.2); color: #f87171; border: 1px solid rgba(239,68,68,0.4);">REJECTED</span>`;
      }

      return `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
          <td style="padding: 12px 14px;">
            <strong style="color: #60a5fa; font-size: 0.95rem;">${escapeHtml(r.username)}</strong>
            ${isApproved && r.assignedPassword ? `<div style="font-size: 0.75rem; color: #34d399; margin-top: 2px;">Pass: <code>${escapeHtml(r.assignedPassword)}</code></div>` : ''}
          </td>
          <td style="padding: 12px 14px; max-width: 250px; font-size: 0.82rem; color: var(--text-secondary); word-break: break-word;">
            ${escapeHtml(r.reason || 'No note provided')}
          </td>
          <td style="padding: 12px 14px; font-size: 0.78rem; color: var(--text-muted);">${dateStr}</td>
          <td style="padding: 12px 14px;">${statusBadge}</td>
          <td style="padding: 12px 14px; text-align: right;">
            <div style="display: inline-flex; gap: 6px; justify-content: flex-end;">
              ${isPending ? `
                <button type="button" class="btn btn-primary btn-xs" onclick="approveAccessRequest('${escapeHtml(r.id)}', '${escapeHtml(r.username)}')">
                  ✓ Approve &amp; Create
                </button>
                <button type="button" class="btn btn-outline btn-xs" onclick="rejectAccessRequest('${escapeHtml(r.id)}', '${escapeHtml(r.username)}')">
                  ✕ Reject
                </button>
              ` : ''}
              <button type="button" class="btn btn-danger-outline btn-xs" onclick="deleteAccessRequest('${escapeHtml(r.id)}', '${escapeHtml(r.username)}')">
                Delete
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (e) {}
}

window.approveAccessRequest = async function(id, username) {
  const customPass = prompt(`Approve and create account for "${username}".\nEnter initial password (leave blank to generate automatically):`, 'User_' + Math.random().toString(36).substring(2, 8));
  if (customPass === null) return;

  const customFolder = prompt(`Assign permanent download folder for "${username}" (optional, leave blank for default temp storage):`, `/home/sakura/downloads/${username}`);
  if (customFolder === null) return;

  try {
    const res = await fetch(`/api/admin/access-requests/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        password: customPass.trim() || undefined,
        role: 'premium',
        downloadFolder: customFolder.trim() || undefined
      })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert(`🎉 Account created for "${username}"!\nInitial Password: ${data.user.initialPassword}\nRole: ${data.user.role}\nAssigned Folder: ${data.user.downloadFolder || 'Default Temporary'}\n\nPlease share this password with the user.`);
      showToast(`User "${username}" approved and created!`, 'success');
      loadAdminUsers();
      loadAccessRequests();
    } else {
      showToast(data.error || 'Failed to approve access request', 'error');
    }
  } catch (err) {
    showToast('Failed to approve request', 'error');
  }
};

window.rejectAccessRequest = async function(id, username) {
  if (!confirm(`Mark access request from "${username}" as rejected?`)) return;
  try {
    const res = await fetch(`/api/admin/access-requests/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (res.ok) {
      showToast(`Request from "${username}" rejected`, 'info');
      loadAccessRequests();
    }
  } catch (e) {
    showToast('Failed to reject request', 'error');
  }
};

window.deleteAccessRequest = async function(id, username) {
  if (!confirm(`Delete access request record for "${username}"?`)) return;
  try {
    const res = await fetch(`/api/admin/access-requests/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (res.ok) {
      showToast('Access request deleted', 'info');
      loadAccessRequests();
    }
  } catch (e) {
    showToast('Failed to delete request', 'error');
  }
};

window.toggleUserRole = async function(id, newRole) {
  try {
    const res = await fetch('/api/admin/users/role', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ id, role: newRole })
    });
    if (res.ok) {
      showToast(`User membership updated to ${newRole.toUpperCase()}`, 'success');
      loadAdminUsers();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to update user role', 'error');
    }
  } catch (e) {
    showToast('Failed to update user role', 'error');
  }
};

window.deleteUserAccount = async function(id, username) {
  if (!confirm(`Are you sure you want to delete user account "${username}"?`)) return;
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (res.ok) {
      showToast(`User "${username}" deleted`, 'info');
      loadAdminUsers();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to delete user', 'error');
    }
  } catch (e) {
    showToast('Failed to delete user', 'error');
  }
};

// ==========================================================================
// User Password Management (Owner Only)
// ==========================================================================
window.toggleInlinePassword = function(userId) {
  const codeEl = document.getElementById(`user-pw-${userId}`);
  if (!codeEl) return;
  const isMasked = codeEl.dataset.masked === 'true';
  if (isMasked) {
    codeEl.textContent = codeEl.dataset.pw;
    codeEl.dataset.masked = 'false';
    codeEl.style.letterSpacing = 'normal';
  } else {
    codeEl.textContent = '••••••••';
    codeEl.dataset.masked = 'true';
    codeEl.style.letterSpacing = '2px';
  }
};

window.copyInlinePassword = async function(userId) {
  const codeEl = document.getElementById(`user-pw-${userId}`);
  if (!codeEl || !codeEl.dataset.pw) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(codeEl.dataset.pw);
    } else {
      const ta = document.createElement('textarea');
      ta.value = codeEl.dataset.pw;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showToast('Password copied to clipboard!', 'info');
  } catch (e) {
    showToast('Failed to copy password', 'error');
  }
};

window.openChangePasswordModal = function(userId, username, currentPw, role) {
  const modal = document.getElementById('changeUserPasswordModal');
  if (!modal) return;

  const idInp = document.getElementById('changePasswordUserId');
  const userEl = document.getElementById('changePasswordTargetUsername');
  const badgeEl = document.getElementById('changePasswordTargetBadge');
  const curText = document.getElementById('changePasswordCurrentText');
  const btnToggle = document.getElementById('btnToggleCurrentPwModal');
  const btnCopy = document.getElementById('btnCopyCurrentPwModal');
  const subtext = document.getElementById('changePasswordCurrentSubtext');
  const newInp = document.getElementById('changePasswordNewInput');
  const errEl = document.getElementById('changePasswordError');

  if (idInp) idInp.value = userId;
  if (userEl) userEl.textContent = username;
  if (badgeEl) badgeEl.textContent = (role || 'user').toUpperCase();

  if (currentPw) {
    if (curText) {
      curText.dataset.pw = currentPw;
      curText.dataset.masked = 'true';
      curText.textContent = '••••••••';
      curText.style.letterSpacing = '2px';
    }
    if (btnToggle) {
      btnToggle.style.display = 'inline-block';
      btnToggle.textContent = '👁️ Show';
    }
    if (btnCopy) btnCopy.style.display = 'inline-block';
    if (subtext) subtext.style.display = 'none';
  } else {
    if (curText) {
      curText.dataset.pw = '';
      curText.dataset.masked = 'false';
      curText.textContent = 'Legacy Hashed (PBKDF2)';
      curText.style.letterSpacing = 'normal';
    }
    if (btnToggle) btnToggle.style.display = 'none';
    if (btnCopy) btnCopy.style.display = 'none';
    if (subtext) {
      subtext.textContent = 'Initial password was created prior to plain-text storage. Enter a new password below to update and reveal.';
      subtext.style.display = 'block';
    }
  }

  if (newInp) {
    newInp.value = 'User_' + Math.random().toString(36).substring(2, 8) + (Math.floor(Math.random() * 90) + 10);
  }
  if (errEl) errEl.style.display = 'none';

  modal.style.display = 'flex';
};

window.closeChangePasswordModal = function() {
  const modal = document.getElementById('changeUserPasswordModal');
  if (modal) modal.style.display = 'none';
};

function initChangePasswordModal() {
  const modal = document.getElementById('changeUserPasswordModal');
  const btnClose = document.getElementById('btnCloseChangePasswordModal');
  const btnCancel = document.getElementById('btnCancelChangePasswordModal');
  const btnToggle = document.getElementById('btnToggleCurrentPwModal');
  const btnCopy = document.getElementById('btnCopyCurrentPwModal');
  const btnGen = document.getElementById('btnGenNewPassword');
  const form = document.getElementById('changePasswordForm');

  if (btnClose) btnClose.addEventListener('click', closeChangePasswordModal);
  if (btnCancel) btnCancel.addEventListener('click', closeChangePasswordModal);

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeChangePasswordModal();
    });
  }

  if (btnToggle) {
    btnToggle.addEventListener('click', () => {
      const curText = document.getElementById('changePasswordCurrentText');
      if (!curText || !curText.dataset.pw) return;
      const isMasked = curText.dataset.masked === 'true';
      if (isMasked) {
        curText.textContent = curText.dataset.pw;
        curText.dataset.masked = 'false';
        curText.style.letterSpacing = 'normal';
        btnToggle.textContent = '🙈 Hide';
      } else {
        curText.textContent = '••••••••';
        curText.dataset.masked = 'true';
        curText.style.letterSpacing = '2px';
        btnToggle.textContent = '👁️ Show';
      }
    });
  }

  if (btnCopy) {
    btnCopy.addEventListener('click', async () => {
      const curText = document.getElementById('changePasswordCurrentText');
      if (!curText || !curText.dataset.pw) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(curText.dataset.pw);
        } else {
          const ta = document.createElement('textarea');
          ta.value = curText.dataset.pw;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        showToast('Current password copied to clipboard!', 'info');
      } catch (e) {
        showToast('Failed to copy password', 'error');
      }
    });
  }

  if (btnGen) {
    btnGen.addEventListener('click', () => {
      const newInp = document.getElementById('changePasswordNewInput');
      if (newInp) {
        newInp.value = 'User_' + Math.random().toString(36).substring(2, 8) + (Math.floor(Math.random() * 90) + 10);
      }
    });
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const userId = document.getElementById('changePasswordUserId')?.value;
      const newInp = document.getElementById('changePasswordNewInput');
      const errEl = document.getElementById('changePasswordError');
      const submitBtn = document.getElementById('btnSubmitChangePassword');
      const newPassword = newInp ? newInp.value.trim() : '';

      if (!newPassword || newPassword.length < 6) {
        if (errEl) {
          errEl.textContent = 'Password must be at least 6 characters.';
          errEl.style.display = 'block';
        }
        return;
      }

      if (submitBtn) submitBtn.disabled = true;
      try {
        const res = await fetch('/api/admin/users/password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`
          },
          body: JSON.stringify({ id: userId, password: newPassword })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(data.message || 'Password updated successfully!', 'success');
          closeChangePasswordModal();
          loadAdminUsers();
        } else {
          if (errEl) {
            errEl.textContent = data.error || 'Failed to update password.';
            errEl.style.display = 'block';
          }
        }
      } catch (err) {
        if (errEl) {
          errEl.textContent = 'Network error while updating password.';
          errEl.style.display = 'block';
        }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }
}

// ==========================================================================
// Individual User Permissions Management (Owner Only)
// ==========================================================================
let currentUserPermsData = null;

window.openUserPermissionsModal = async function(userId, username, role) {
  const modal = document.getElementById('userPermissionsModal');
  if (!modal) return;

  const userEl = document.getElementById('userPermTargetUsername');
  const roleEl = document.getElementById('userPermTargetRoleBadge');
  const customBadge = document.getElementById('userPermCustomBadge');
  const banner = document.getElementById('userPermStatusBanner');
  const listEl = document.getElementById('userPermFeatureList');
  const errEl = document.getElementById('userPermError');

  if (userEl) userEl.textContent = username;
  if (roleEl) {
    roleEl.textContent = (role || 'user').toUpperCase();
    roleEl.style.background = role === 'premium' ? 'rgba(245, 158, 11, 0.2)' : 'rgba(255, 255, 255, 0.08)';
    roleEl.style.color = role === 'premium' ? '#fbbf24' : '#94a3b8';
  }
  if (errEl) errEl.style.display = 'none';
  if (customBadge) customBadge.style.display = 'none';
  if (banner) banner.textContent = 'Fetching individual user permissions...';
  if (listEl) {
    listEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 24px; font-size: 0.84rem;">Loading permissions...</div>';
  }

  modal.style.display = 'flex';

  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/permissions`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      if (listEl) {
        listEl.innerHTML = `<div style="text-align: center; color: #f87171; padding: 20px;">Failed to load user permissions: ${escapeHtml(data.error || 'Server error')}</div>`;
      }
      return;
    }

    currentUserPermsData = data;
    renderUserPermsModalBody();
  } catch (err) {
    if (listEl) {
      listEl.innerHTML = `<div style="text-align: center; color: #f87171; padding: 20px;">Network error loading user permissions</div>`;
    }
  }
};

function renderUserPermsModalBody() {
  if (!currentUserPermsData) return;
  const { user, features } = currentUserPermsData;
  const listEl = document.getElementById('userPermFeatureList');
  const customBadge = document.getElementById('userPermCustomBadge');
  const banner = document.getElementById('userPermStatusBanner');

  const hasCustom = !!user.hasCustomPermissions;
  if (customBadge) customBadge.style.display = hasCustom ? 'inline-block' : 'none';

  if (banner) {
    banner.innerHTML = hasCustom
      ? `<span style="color: #c4b5fd; font-weight: 600;">⚡ Custom Overrides Active</span> &bull; Overriding <strong>${escapeHtml(user.role.toUpperCase())}</strong> defaults.`
      : `<span style="color: #94a3b8;">Currently inheriting <strong>${escapeHtml(user.role.toUpperCase())}</strong> role defaults.</span>`;
  }

  if (!listEl) return;
  const rolePerms = user.rolePermissions || {};
  const currentPerms = user.customPermissions || user.effectivePermissions || rolePerms;

  listEl.innerHTML = features.map(f => {
    const isChecked = currentPerms[f.key] === true;
    const roleDefault = rolePerms[f.key] === true;
    const isFlacChecker = f.key === 'flac_checker';

    return `
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; background: rgba(0,0,0,0.3); border: 1px solid var(--admin-border); border-radius: 8px; padding: 10px 14px; transition: background 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='rgba(0,0,0,0.3)'">
        <div style="flex: 1;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <strong style="font-size: 0.88rem; color: #f1f5f9;">${escapeHtml(f.label)}</strong>
            <span style="font-size: 0.68rem; padding: 1px 6px; border-radius: 4px; ${roleDefault ? 'color: #34d399; background: rgba(16,185,129,0.12);' : 'color: #94a3b8; background: rgba(255,255,255,0.06);'}">
              Role default: ${roleDefault ? 'Allowed' : 'Disabled'}
            </span>
          </div>
          <div style="font-size: 0.74rem; color: var(--text-muted); margin-top: 3px;">${escapeHtml(f.description)}</div>
        </div>
        <div style="padding-left: 8px;">
          <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 6px; user-select: none;">
            <input type="checkbox" 
                   data-feature="${escapeHtml(f.key)}" 
                   class="user-individual-perm-checkbox"
                   ${isChecked ? 'checked' : ''}
                   ${isFlacChecker ? 'disabled title="Core system utility"' : ''}
                   style="width: 19px; height: 19px; accent-color: #8b5cf6; cursor: pointer;">
          </label>
        </div>
      </div>
    `;
  }).join('');
}

window.closeUserPermissionsModal = function() {
  const modal = document.getElementById('userPermissionsModal');
  if (modal) modal.style.display = 'none';
  currentUserPermsData = null;
};

function initUserPermissionsModal() {
  const modal = document.getElementById('userPermissionsModal');
  const btnClose = document.getElementById('btnCloseUserPermsModal');
  const btnCancel = document.getElementById('btnCancelUserPermsModal');
  const btnSelectAll = document.getElementById('btnUserPermSelectAll');
  const btnDeselectAll = document.getElementById('btnUserPermDeselectAll');
  const btnRevertRole = document.getElementById('btnUserPermRevertRole');
  const btnResetToRole = document.getElementById('btnUserPermResetToRole');
  const btnSave = document.getElementById('btnSaveUserPermsModal');

  if (btnClose) btnClose.addEventListener('click', closeUserPermissionsModal);
  if (btnCancel) btnCancel.addEventListener('click', closeUserPermissionsModal);

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeUserPermissionsModal();
    });
  }

  if (btnSelectAll) {
    btnSelectAll.addEventListener('click', () => {
      document.querySelectorAll('.user-individual-perm-checkbox').forEach(cb => {
        if (!cb.disabled) cb.checked = true;
      });
    });
  }

  if (btnDeselectAll) {
    btnDeselectAll.addEventListener('click', () => {
      document.querySelectorAll('.user-individual-perm-checkbox').forEach(cb => {
        if (!cb.disabled) cb.checked = false;
      });
    });
  }

  if (btnRevertRole) {
    btnRevertRole.addEventListener('click', () => {
      if (!currentUserPermsData?.user?.rolePermissions) return;
      const rolePerms = currentUserPermsData.user.rolePermissions;
      document.querySelectorAll('.user-individual-perm-checkbox').forEach(cb => {
        const feat = cb.getAttribute('data-feature');
        if (!cb.disabled && feat) {
          cb.checked = rolePerms[feat] === true;
        }
      });
      showToast('Checkboxes reset to role defaults', 'info');
    });
  }

  // Reset to Role Defaults via API (clears customPermissions from user in .users.json)
  if (btnResetToRole) {
    btnResetToRole.addEventListener('click', async () => {
      if (!currentUserPermsData?.user?.id) return;
      if (!confirm(`Revert permissions for "${currentUserPermsData.user.username}" back to ${currentUserPermsData.user.role.toUpperCase()} role defaults?`)) return;

      btnResetToRole.disabled = true;
      btnResetToRole.textContent = 'Resetting...';
      try {
        const res = await fetch('/api/admin/users/permissions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`
          },
          body: JSON.stringify({
            id: currentUserPermsData.user.id,
            resetToRole: true
          })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(data.message || 'Permissions reset to role defaults!', 'success');
          closeUserPermissionsModal();
          loadAdminUsers();
        } else {
          showToast(data.error || 'Failed to reset permissions', 'error');
        }
      } catch (err) {
        showToast('Network error resetting permissions', 'error');
      } finally {
        btnResetToRole.disabled = false;
        btnResetToRole.textContent = '↺ Reset to Role Defaults';
      }
    });
  }

  // Save Custom Permissions via API
  if (btnSave) {
    btnSave.addEventListener('click', async () => {
      if (!currentUserPermsData?.user?.id) return;
      const errEl = document.getElementById('userPermError');
      if (errEl) errEl.style.display = 'none';

      btnSave.disabled = true;
      btnSave.textContent = 'Saving...';

      const perms = {};
      document.querySelectorAll('.user-individual-perm-checkbox').forEach(cb => {
        const feat = cb.getAttribute('data-feature');
        if (feat) {
          perms[feat] = cb.checked;
        }
      });

      try {
        const res = await fetch('/api/admin/users/permissions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`
          },
          body: JSON.stringify({
            id: currentUserPermsData.user.id,
            permissions: perms
          })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(data.message || 'Individual permissions saved successfully!', 'success');
          closeUserPermissionsModal();
          loadAdminUsers();
        } else {
          if (errEl) {
            errEl.textContent = data.error || 'Failed to save permissions.';
            errEl.style.display = 'block';
          }
        }
      } catch (err) {
        if (errEl) {
          errEl.textContent = 'Network error saving user permissions.';
          errEl.style.display = 'block';
        }
      } finally {
        btnSave.disabled = false;
        btnSave.textContent = '💾 Save Permissions';
      }
    });
  }
}

// ==========================================================================
// Folder Allocation Modal (Owner Only)
// ==========================================================================

let allocUserId = null;
let allocUsername = '';
let allocUserRole = '';
let allocDrives = [];
let allocCurrentDrive = '';
let allocCurrentSubDir = '';
let allocCurrentPath = '';
let allocParentPath = null;
let allocGrantedFolders = new Set();
let allocFolderItems = [];

function initFolderAllocationModal() {
  const modal = document.getElementById('allocateFoldersModal');
  const btnClose = document.getElementById('btnCloseAllocModal');
  const btnCancel = document.getElementById('btnCancelAllocModal');
  const driveSelect = document.getElementById('allocDriveSelect');
  const btnUp = document.getElementById('btnAllocUpFolder');
  const btnSelectAll = document.getElementById('btnAllocSelectAllFolders');
  const btnDeselectAll = document.getElementById('btnAllocDeselectAllFolders');
  const btnAddChecked = document.getElementById('btnAddCheckedFolders');
  const btnCreateFolder = document.getElementById('btnAllocCreateFolder');
  const newFolderInp = document.getElementById('allocNewFolderName');
  const btnClearAll = document.getElementById('btnClearAllAllocations');
  const btnSave = document.getElementById('btnSaveAllocModal');

  if (btnClose) btnClose.addEventListener('click', closeFolderAllocationModal);
  if (btnCancel) btnCancel.addEventListener('click', closeFolderAllocationModal);

  if (driveSelect) {
    driveSelect.addEventListener('change', () => {
      allocCurrentDrive = driveSelect.value;
      allocCurrentSubDir = '';
      updateDriveCapacityBadge();
      if (allocCurrentDrive) {
        loadDriveFolders(allocCurrentDrive, '');
      } else {
        renderDriveFolderList([]);
      }
    });
  }

  if (btnUp) {
    btnUp.addEventListener('click', () => {
      if (!allocCurrentDrive) return;
      const parts = allocCurrentSubDir.split(/[/\\]/).filter(Boolean);
      parts.pop();
      allocCurrentSubDir = parts.join('/');
      loadDriveFolders(allocCurrentDrive, allocCurrentSubDir);
    });
  }

  if (btnSelectAll) {
    btnSelectAll.addEventListener('click', () => {
      const cbs = document.querySelectorAll('.alloc-folder-chk');
      cbs.forEach(cb => { cb.checked = true; });
    });
  }

  if (btnDeselectAll) {
    btnDeselectAll.addEventListener('click', () => {
      const cbs = document.querySelectorAll('.alloc-folder-chk');
      cbs.forEach(cb => { cb.checked = false; });
    });
  }

  if (btnAddChecked) {
    btnAddChecked.addEventListener('click', () => {
      const cbs = document.querySelectorAll('.alloc-folder-chk:checked');
      if (cbs.length === 0) {
        showToast('Please check at least one folder to grant', 'info');
        return;
      }
      let added = 0;
      cbs.forEach(cb => {
        const folderPath = cb.dataset.path;
        if (folderPath && !allocGrantedFolders.has(folderPath)) {
          allocGrantedFolders.add(folderPath);
          added++;
        }
      });
      renderAllocatedBadges();
      showToast(`Added ${added} folder(s) to allocation list`, 'success');
    });
  }

  if (btnCreateFolder) {
    btnCreateFolder.addEventListener('click', async () => {
      if (!allocCurrentDrive) {
        showToast('Please select a drive first', 'error');
        return;
      }
      const folderName = (newFolderInp ? newFolderInp.value : '').trim();
      if (!folderName) {
        showToast('Please enter a valid folder name', 'error');
        return;
      }
      btnCreateFolder.disabled = true;
      try {
        const res = await fetch('/api/admin/drive-folders/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`
          },
          body: JSON.stringify({
            drive: allocCurrentDrive,
            subDir: allocCurrentSubDir,
            folderName
          })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(data.message || 'Folder created', 'success');
          if (newFolderInp) newFolderInp.value = '';
          if (data.createdPath) {
            allocGrantedFolders.add(data.createdPath);
            renderAllocatedBadges();
          }
          loadDriveFolders(allocCurrentDrive, allocCurrentSubDir);
        } else {
          showToast(data.error || 'Failed to create folder', 'error');
        }
      } catch (err) {
        showToast('Network error while creating folder', 'error');
      } finally {
        btnCreateFolder.disabled = false;
      }
    });
  }

  if (btnClearAll) {
    btnClearAll.addEventListener('click', () => {
      if (allocGrantedFolders.size === 0) return;
      if (confirm(`Remove all ${allocGrantedFolders.size} allocated folders for this user?`)) {
        allocGrantedFolders.clear();
        renderAllocatedBadges();
      }
    });
  }

  if (btnSave) {
    btnSave.addEventListener('click', async () => {
      if (!allocUserId) return;
      btnSave.disabled = true;
      btnSave.textContent = 'Saving...';
      try {
        const folders = Array.from(allocGrantedFolders);
        const res = await fetch(`/api/admin/users/${encodeURIComponent(allocUserId)}/folders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${adminToken}`
          },
          body: JSON.stringify({ folders })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(data.message || 'Folder allocations updated successfully', 'success');
          closeFolderAllocationModal();
          loadAdminUsers();
        } else {
          showToast(data.error || 'Failed to save folder allocations', 'error');
        }
      } catch (err) {
        showToast('Network error saving allocations', 'error');
      } finally {
        btnSave.disabled = false;
        btnSave.textContent = '💾 Save Allocation';
      }
    });
  }
}

function updateDriveCapacityBadge() {
  const badge = document.getElementById('allocDriveCapacityBadge');
  if (!badge) return;
  const drive = allocDrives.find(d => d.path === allocCurrentDrive);
  if (drive) {
    badge.textContent = `${drive.free} free / ${drive.total} total (${drive.percentUsed} used)`;
  } else {
    badge.textContent = '';
  }
}

window.openFolderAllocationModal = async function(userId, username, role) {
  allocUserId = userId;
  allocUsername = username;
  allocUserRole = role || 'user';
  allocGrantedFolders = new Set();
  allocCurrentDrive = '';
  allocCurrentSubDir = '';

  const modal = document.getElementById('allocateFoldersModal');
  const userEl = document.getElementById('allocTargetUsername');
  const roleEl = document.getElementById('allocTargetRoleBadge');

  if (userEl) userEl.textContent = username;
  if (roleEl) {
    roleEl.textContent = (role || 'user').toUpperCase();
    if (role === 'owner') {
      roleEl.className = 'badge-tag';
      roleEl.style.cssText = 'background: rgba(245,158,11,0.3); color: #fef08a; border: 1px solid rgba(245,158,11,0.6); margin-left: 6px;';
    } else if (role === 'premium') {
      roleEl.className = 'badge-tag';
      roleEl.style.cssText = 'background: rgba(245,158,11,0.2); color: #fbbf24; border: 1px solid rgba(245,158,11,0.4); margin-left: 6px;';
    } else {
      roleEl.className = 'badge-tag';
      roleEl.style.cssText = 'background: rgba(255,255,255,0.08); color: #94a3b8; border: 1px solid rgba(255,255,255,0.12); margin-left: 6px;';
    }
  }

  if (modal) modal.style.display = 'flex';

  // Load user's currently granted folders
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/folders`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.allowedFolders)) {
        data.allowedFolders.forEach(f => allocGrantedFolders.add(f));
      }
    }
  } catch (e) {
    console.error('Failed to load user folders', e);
  }
  renderAllocatedBadges();

  // Load system drives
  await loadSystemDrives();
};

function closeFolderAllocationModal() {
  const modal = document.getElementById('allocateFoldersModal');
  if (modal) modal.style.display = 'none';
  allocUserId = null;
}

async function loadSystemDrives() {
  const select = document.getElementById('allocDriveSelect');
  if (!select) return;
  select.innerHTML = '<option value="">Detecting drives...</option>';

  try {
    const res = await fetch('/api/admin/system-drives', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (res.ok && data.success && Array.isArray(data.drives)) {
      allocDrives = data.drives;
      if (allocDrives.length === 0) {
        select.innerHTML = '<option value="">No drives detected</option>';
        return;
      }
      select.innerHTML = '<option value="">-- Select a Drive / Storage Mount --</option>' + allocDrives.map(d => {
        return `<option value="${escapeHtml(d.path)}">${escapeHtml(d.label)} [${escapeHtml(d.path)}] - Free: ${escapeHtml(d.free)} / Total: ${escapeHtml(d.total)}</option>`;
      }).join('');

      // Auto-select preferred storage drive if available, e.g. /media/storage or first drive
      const pref = allocDrives.find(d => d.path === '/media/storage') || allocDrives[0];
      if (pref) {
        select.value = pref.path;
        allocCurrentDrive = pref.path;
        allocCurrentSubDir = '';
        updateDriveCapacityBadge();
        loadDriveFolders(pref.path, '');
      }
    } else {
      select.innerHTML = '<option value="">Failed to detect drives</option>';
    }
  } catch (err) {
    select.innerHTML = '<option value="">Error loading drives</option>';
  }
}

async function loadDriveFolders(drive, subDir) {
  const container = document.getElementById('allocFolderListContainer');
  const pathText = document.getElementById('allocCurrentPathText');
  const btnUp = document.getElementById('btnAllocUpFolder');

  if (container) {
    container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 14px; font-size: 0.82rem;">Scanning folders...</div>';
  }

  try {
    const url = `/api/admin/drive-folders?drive=${encodeURIComponent(drive)}${subDir ? `&subDir=${encodeURIComponent(subDir)}` : ''}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (res.ok && data.success) {
      allocCurrentPath = data.currentPath || drive;
      allocParentPath = data.parentPath;
      if (pathText) pathText.textContent = allocCurrentPath;
      if (btnUp) btnUp.style.display = allocCurrentSubDir ? 'inline-flex' : 'none';

      allocFolderItems = data.folders || [];
      renderDriveFolderList(allocFolderItems);
    } else {
      if (container) {
        container.innerHTML = `<div style="text-align: center; color: #f87171; padding: 14px; font-size: 0.82rem;">${escapeHtml(data.error || 'Failed to list folders')}</div>`;
      }
    }
  } catch (err) {
    if (container) {
      container.innerHTML = `<div style="text-align: center; color: #f87171; padding: 14px; font-size: 0.82rem;">Network error scanning folders</div>`;
    }
  }
}

function renderDriveFolderList(folders) {
  const container = document.getElementById('allocFolderListContainer');
  if (!container) return;

  if (!folders || folders.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 16px; font-size: 0.82rem;">No subdirectories found in current folder. You can create one below.</div>`;
    return;
  }

  container.innerHTML = folders.map(f => {
    const isGranted = allocGrantedFolders.has(f.path);
    return `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-radius: 4px; margin-bottom: 3px; background: rgba(255,255,255,0.03); transition: background 0.15s ease;" onmouseover="this.style.background='rgba(255,255,255,0.07)'" onmouseout="this.style.background='rgba(255,255,255,0.03)'">
        <label style="display: flex; align-items: center; gap: 8px; margin: 0; cursor: pointer; flex: 1; min-width: 0; font-size: 0.82rem;">
          <input type="checkbox" class="alloc-folder-chk" data-path="${escapeHtml(f.path)}" ${isGranted ? 'checked' : ''} style="cursor: pointer;">
          <span style="font-size: 1rem;">📁</span>
          <span style="font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; ${isGranted ? 'color: #93c5fd;' : ''}">${escapeHtml(f.name)}</span>
          ${isGranted ? '<span style="font-size: 0.7rem; color: #34d399; margin-left: 4px;">(Granted)</span>' : ''}
        </label>
        <button type="button" class="btn btn-outline btn-xs" style="padding: 2px 7px; font-size: 0.72rem; margin-left: 6px;" onclick="navigateAllocSubFolder('${escapeHtml(f.name)}')">
          Open ➡
        </button>
      </div>
    `;
  }).join('');
}

window.navigateAllocSubFolder = function(folderName) {
  if (!allocCurrentDrive) return;
  allocCurrentSubDir = allocCurrentSubDir ? `${allocCurrentSubDir}/${folderName}` : folderName;
  loadDriveFolders(allocCurrentDrive, allocCurrentSubDir);
};

function renderAllocatedBadges() {
  const container = document.getElementById('allocGrantedBadges');
  const countText = document.getElementById('allocCountText');
  if (countText) countText.textContent = allocGrantedFolders.size;
  if (!container) return;

  if (allocGrantedFolders.size === 0) {
    container.innerHTML = `<span style="color: var(--text-muted); font-size: 0.8rem; font-style: italic;">No folders granted yet. Select folders above to give access.</span>`;
    return;
  }

  container.innerHTML = Array.from(allocGrantedFolders).map(folderPath => {
    return `
      <span style="display: inline-flex; align-items: center; gap: 6px; background: rgba(59, 130, 246, 0.18); border: 1px solid rgba(59, 130, 246, 0.4); color: #93c5fd; padding: 4px 8px; border-radius: 6px; font-size: 0.78rem; font-family: monospace;">
        <span>📁 ${escapeHtml(folderPath)}</span>
        <button type="button" onclick="removeAllocatedFolder('${escapeHtml(folderPath)}')" style="background: none; border: none; color: #f87171; cursor: pointer; font-size: 0.9rem; padding: 0 2px; line-height: 1;" title="Revoke folder access">&times;</button>
      </span>
    `;
  }).join('');
}

window.removeAllocatedFolder = function(folderPath) {
  allocGrantedFolders.delete(folderPath);
  renderAllocatedBadges();
  const cbs = document.querySelectorAll('.alloc-folder-chk');
  cbs.forEach(cb => {
    if (cb.dataset.path === folderPath) cb.checked = false;
  });
};

// Dynamic Role Permissions & Feature Access Matrix Logic
// ==========================================================================
let currentPermissionsMatrix = null;
let currentFeaturesList = [];

async function loadRolePermissions() {
  const tbody = document.getElementById('rolePermissionsTableBody');
  try {
    const res = await fetch('/api/admin/role-permissions', {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) {
      currentPermissionsMatrix = data.permissions;
      currentFeaturesList = data.features || [];
      renderRolePermissionsTable(currentFeaturesList, currentPermissionsMatrix);
    }
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #f87171; padding: 20px;">Failed to load permissions matrix: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

function renderRolePermissionsTable(features, permissions) {
  const tbody = document.getElementById('rolePermissionsTableBody');
  if (!tbody) return;

  if (!features || features.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">No features defined.</td></tr>`;
    return;
  }

  const roles = [
    { key: 'guest', label: 'Guest Visitor' },
    { key: 'user', label: 'Standard Member' },
    { key: 'premium', label: 'Premium Member' }
  ];

  tbody.innerHTML = features.map(feat => {
    const roleCheckboxes = roles.map(r => {
      const isChecked = permissions[r.key] && permissions[r.key][feat.key] === true;
      return `
        <td style="padding: 10px 14px; text-align: center;">
          <label style="cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 4px;">
            <input type="checkbox" 
                   data-role="${r.key}" 
                   data-feature="${feat.key}" 
                   class="role-perm-checkbox"
                   ${isChecked ? 'checked' : ''}
                   style="width: 17px; height: 17px; accent-color: #3b82f6; cursor: pointer;">
          </label>
        </td>
      `;
    }).join('');

    const ownerCell = `
      <td style="padding: 10px 14px; text-align: center;">
        <span title="Owner/Admin has full permanent access to all platform features" style="display: inline-flex; align-items: center; gap: 4px; color: #fbbf24; font-size: 0.8rem; font-weight: 600; background: rgba(245, 158, 11, 0.12); padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(245, 158, 11, 0.25);">
          ✓ 🔒
        </span>
      </td>
    `;

    return `
      <tr style="border-bottom: 1px solid rgba(255,255,255,0.05); transition: background 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
        <td style="padding: 12px 14px;">
          <div style="font-weight: 600; color: #f1f5f9; font-size: 0.88rem;">${escapeHtml(feat.label)}</div>
          <div style="font-size: 0.74rem; color: var(--text-muted); margin-top: 2px;">${escapeHtml(feat.description)}</div>
          <code style="font-size: 0.68rem; color: #64748b; background: rgba(0,0,0,0.25); padding: 1px 4px; border-radius: 3px; display: inline-block; margin-top: 3px;">${escapeHtml(feat.key)}</code>
        </td>
        ${roleCheckboxes}
        ${ownerCell}
      </tr>
    `;
  }).join('');
}

async function saveRolePermissions() {
  const btn = document.getElementById('btnSavePermissions');
  const alertEl = document.getElementById('rolePermissionsAlert');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving...';
  }

  const updated = {
    guest: {},
    user: {},
    premium: {}
  };

  document.querySelectorAll('.role-perm-checkbox').forEach(cb => {
    const role = cb.getAttribute('data-role');
    const feat = cb.getAttribute('data-feature');
    if (role && feat && updated[role]) {
      updated[role][feat] = cb.checked;
    }
  });

  try {
    const res = await fetch('/api/admin/role-permissions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ permissions: updated })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      currentPermissionsMatrix = data.permissions;
      showToast('Role permissions saved successfully', 'success');
      if (alertEl) {
        alertEl.style.display = 'block';
        alertEl.style.background = 'rgba(16, 185, 129, 0.15)';
        alertEl.style.color = '#34d399';
        alertEl.style.border = '1px solid rgba(16, 185, 129, 0.3)';
        alertEl.textContent = '✓ Role permissions saved to disk and active across all endpoints.';
        setTimeout(() => { alertEl.style.display = 'none'; }, 4000);
      }
    } else {
      showToast(data.error || 'Failed to save permissions', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '💾 Save Permissions';
    }
  }
}

async function resetRolePermissions() {
  if (!confirm('Reset all role permissions to factory defaults?')) return;
  const btn = document.getElementById('btnResetPermissions');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Resetting...';
  }

  try {
    const res = await fetch('/api/admin/role-permissions/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      }
    });
    const data = await res.json();
    if (res.ok && data.success) {
      currentPermissionsMatrix = data.permissions;
      renderRolePermissionsTable(currentFeaturesList, currentPermissionsMatrix);
      showToast('Role permissions reset to factory defaults', 'info');
    } else {
      showToast(data.error || 'Failed to reset permissions', 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '↺ Reset Defaults';
    }
  }
}
