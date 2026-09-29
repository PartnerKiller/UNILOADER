// Universal Downloader &bull; Online Media Downloader Controller

let currentExtractedData = null;
let activeEventSources = new Map(); // Kept for legacy backward compatibility
let activeJobStatusTracker = new Map(); // jobId -> previous status for completion triggers
let currentMode = 'video'; // 'video' | 'audio' | 'batch'
let activeReadyJob = null;

// Track session jobs in sessionStorage so completed tasks auto-remove on fresh reload
let sessionJobIds = new Set(JSON.parse(sessionStorage.getItem('vortex_session_jobs') || '[]'));

function saveSessionJobs() {
  sessionStorage.setItem('vortex_session_jobs', JSON.stringify(Array.from(sessionJobIds)));
}

// Theme & Layout Density Initializer (Testing & Non-Production Preview Support)
async function initThemeAndDensity() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const paramTheme = urlParams.get('preview_theme') || urlParams.get('theme');
    const paramDensity = urlParams.get('preview_density') || urlParams.get('density');

    if (paramTheme) {
      document.documentElement.setAttribute('data-theme', paramTheme);
      localStorage.setItem('preview_theme', paramTheme);
    } else {
      const storedTheme = localStorage.getItem('preview_theme');
      if (storedTheme) {
        document.documentElement.setAttribute('data-theme', storedTheme);
      }
    }

    if (paramDensity) {
      document.documentElement.setAttribute('data-density', paramDensity);
      localStorage.setItem('preview_density', paramDensity);
    } else {
      const storedDensity = localStorage.getItem('preview_density');
      if (storedDensity) {
        document.documentElement.setAttribute('data-density', storedDensity);
      }
    }

    // Sync with server global settings if no client override is active
    if (!paramTheme && !localStorage.getItem('preview_theme')) {
      try {
        const res = await fetch('/api/ui-settings');
        if (res.ok) {
          const cfg = await res.json();
          if (cfg.theme && !localStorage.getItem('preview_theme')) {
            document.documentElement.setAttribute('data-theme', cfg.theme);
          }
          if (cfg.density && !localStorage.getItem('preview_density')) {
            document.documentElement.setAttribute('data-density', cfg.density);
          }
        }
      } catch (e) {}
    }
  } catch (e) {}
}

window.addEventListener('storage', (e) => {
  if (e.key === 'preview_theme') {
    if (e.newValue) {
      document.documentElement.setAttribute('data-theme', e.newValue);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }
  if (e.key === 'preview_density') {
    if (e.newValue) {
      document.documentElement.setAttribute('data-density', e.newValue);
    } else {
      document.documentElement.removeAttribute('data-density');
    }
  }
});

initThemeAndDensity();

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Toast Notifications
function showToast(message, type = 'error') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast-item toast-${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${type === 'error' ? '!' : '✓'}</div>
    <div class="toast-content">${message}</div>
    <button class="toast-close" type="button">&times;</button>
  `;

  toast.querySelector('.toast-close').addEventListener('click', () => {
    toast.classList.add('toast-hiding');
    setTimeout(() => toast.remove(), 250);
  });

  container.appendChild(toast);

  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.add('toast-hiding');
      setTimeout(() => toast.remove(), 250);
    }
  }, 6000);
}

// Global Jobs Cache Map
window.allJobsMap = window.allJobsMap || new Map();

// DOM Elements
const urlInput = document.getElementById('urlInput');
const fetchBtn = document.getElementById('fetchBtn');
const fetchSpinner = document.getElementById('fetchSpinner');
const pasteBtn = document.getElementById('pasteBtn');

// Mode Tabs
const tabVideoMode = document.getElementById('tabVideoMode');
const tabAudioMode = document.getElementById('tabAudioMode');
const tabBatchMode = document.getElementById('tabBatchMode');
const singleUrlFormWrapper = document.getElementById('singleUrlFormWrapper');
const batchFormWrapper = document.getElementById('batchFormWrapper');
const batchUrlsInput = document.getElementById('batchUrlsInput');
const batchCountHint = document.getElementById('batchCountHint');
const startBatchBtn = document.getElementById('startBatchBtn');

// Presets
const presetBestVideo = document.getElementById('presetBestVideo');
const presetAudioMp3 = document.getElementById('presetAudioMp3');
const presetAudioFlac = document.getElementById('presetAudioFlac');
const presetSubtitles = document.getElementById('presetSubtitles');
const presetSponsorBlock = document.getElementById('presetSponsorBlock');

// Preview Card
const previewCard = document.getElementById('previewCard');
const previewPoster = document.getElementById('previewPoster');
const previewCode = document.getElementById('previewCode');
const previewModel = document.getElementById('previewModel');
const previewDuration = document.getElementById('previewDuration');
const previewTitle = document.getElementById('previewTitle');
const previewTags = document.getElementById('previewTags');
const concurrencySelect = document.getElementById('concurrencySelect');
const startDownloadBtn = document.getElementById('startDownloadBtn');
const downloadBtnText = document.getElementById('downloadBtnText');
const clearPreviewBtn = document.getElementById('clearPreviewBtn');

// Config Groups
const cfgVideoQualityGroup = document.getElementById('cfgVideoQualityGroup');
const cfgVideoFormatGroup = document.getElementById('cfgVideoFormatGroup');
const cfgAudioFormatGroup = document.getElementById('cfgAudioFormatGroup');
const cfgAudioBitrateGroup = document.getElementById('cfgAudioBitrateGroup');
const videoQualitySelect = document.getElementById('videoQualitySelect');
const videoFormatSelect = document.getElementById('videoFormatSelect');
const audioFormatSelect = document.getElementById('audioFormatSelect');
const audioBitrateSelect = document.getElementById('audioBitrateSelect');

// Advanced Checkboxes
const chkEmbedSubtitles = document.getElementById('chkEmbedSubtitles');
const chkAutoSubs = document.getElementById('chkAutoSubs');
const chkEmbedThumbnail = document.getElementById('chkEmbedThumbnail');
const chkEmbedMetadata = document.getElementById('chkEmbedMetadata');
const chkSponsorBlock = document.getElementById('chkSponsorBlock');
const chkSplitChapters = document.getElementById('chkSplitChapters');
const subLangsInput = document.getElementById('subLangsInput');
const customArgsInput = document.getElementById('customArgsInput');

// Jobs & Queue
const jobsList = document.getElementById('jobsList');
const emptyJobsState = document.getElementById('emptyJobsState');
const activeCountLabel = document.getElementById('activeCountLabel');
const queueStatusIndicator = document.getElementById('queueStatusIndicator');
const clearAllCompletedBtn = document.getElementById('clearAllCompletedBtn');

// Ready Modal
const readyModal = document.getElementById('readyModal');
const closeReadyModalBtn = document.getElementById('closeReadyModalBtn');
const readyModalTitle = document.getElementById('readyModalTitle');
const readyModalSize = document.getElementById('readyModalSize');
const readyModalSaveBtn = document.getElementById('readyModalSaveBtn');
const readyModalWatchBtn = document.getElementById('readyModalWatchBtn');

// Video Player Modal
const playerModal = document.getElementById('playerModal');
const html5Player = document.getElementById('html5Player');
const modalVideoTitle = document.getElementById('modalVideoTitle');
const modalFileInfo = document.getElementById('modalFileInfo');
const closeModalBtn = document.getElementById('closeModalBtn');
const modalDownloadDeviceBtn = document.getElementById('modalDownloadDeviceBtn');

// ==========================================================================
// User Authentication, Premium Features & Guest State Manager
// ==========================================================================
let currentUser = null; // { id, username, role, isPremium, features }
let userAuthToken = localStorage.getItem('sakura_user_token') || sessionStorage.getItem('sakura_user_token') || localStorage.getItem('sakura_admin_token') || sessionStorage.getItem('sakura_admin_token') || '';

function getClientId() {
  let cid = localStorage.getItem('sakura_client_id');
  if (!cid) {
    cid = 'client_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
    localStorage.setItem('sakura_client_id', cid);
  }
  return cid;
}

function canAccess(featureKey) {
  if (featureKey === 'flac_checker') {
    return true;
  }
  if (!currentUser) {
    return featureKey === 'downloader';
  }
  if (currentUser.isOwner || currentUser.role === 'owner' || currentUser.role === 'admin' || currentUser.username?.toLowerCase() === 'sakura') {
    return true;
  }
  if (currentUser.features && typeof currentUser.features[featureKey] !== 'undefined') {
    return !!currentUser.features[featureKey];
  }
  if (currentUser.role === 'guest') {
    return featureKey === 'downloader';
  }
  return true;
}

// Transparent API Authorization & Client Identity Interceptor
const originalFetch = window.fetch;
window.fetch = function (url, options = {}) {
  if (typeof url === 'string' && url.startsWith('/api/')) {
    options = options || {};
    options.headers = options.headers || {};
    const effectiveToken = userAuthToken || localStorage.getItem('sakura_user_token') || sessionStorage.getItem('sakura_user_token') || localStorage.getItem('sakura_admin_token') || sessionStorage.getItem('sakura_admin_token') || '';
    const clientId = getClientId();

    if (options.headers instanceof Headers) {
      if (effectiveToken && !options.headers.has('Authorization')) {
        options.headers.set('Authorization', `Bearer ${effectiveToken}`);
      }
      if (clientId && !options.headers.has('X-Client-Id')) {
        options.headers.set('X-Client-Id', clientId);
      }
    } else if (Array.isArray(options.headers)) {
      if (effectiveToken && !options.headers.some(([k]) => k.toLowerCase() === 'authorization')) {
        options.headers.push(['Authorization', `Bearer ${effectiveToken}`]);
      }
      if (clientId && !options.headers.some(([k]) => k.toLowerCase() === 'x-client-id')) {
        options.headers.push(['X-Client-Id', clientId]);
      }
    } else {
      if (effectiveToken && !options.headers['Authorization'] && !options.headers['authorization']) {
        options.headers['Authorization'] = `Bearer ${effectiveToken}`;
      }
      if (clientId && !options.headers['X-Client-Id'] && !options.headers['x-client-id']) {
        options.headers['X-Client-Id'] = clientId;
      }
    }
  }

  return originalFetch.call(this, url, options).then(async (response) => {
    if (response.status === 503) {
      try {
        const clone = response.clone();
        const data = await clone.json();
        if (data && data.maintenance) {
          maintenanceState = {
            active: true,
            message: data.message || maintenanceState.message
          };
          applyMaintenanceUI();
        }
      } catch (e) {}
    }
    return response;
  });
};

// Work In Progress / Maintenance Mode State & UI Controller
let maintenanceState = {
  active: false,
  message: 'We are currently performing scheduled maintenance and system upgrades. The site will be back online shortly. Thank you for your patience!'
};

function applyMaintenanceUI() {
  const overlay = document.getElementById('maintenanceOverlay');
  const banner = document.getElementById('ownerTestingBanner');
  const msgText = document.getElementById('maintenanceMessageText');

  if (msgText && maintenanceState.message) {
    msgText.textContent = maintenanceState.message;
  }

  const isOwner = currentUser && (currentUser.isOwner || currentUser.role === 'owner');

  if (maintenanceState.active) {
    if (isOwner) {
      if (overlay) overlay.style.display = 'none';
      if (banner) banner.style.display = 'flex';
    } else {
      if (overlay) overlay.style.display = 'flex';
      if (banner) banner.style.display = 'none';
    }
  } else {
    if (overlay) overlay.style.display = 'none';
    if (banner) banner.style.display = 'none';
  }
}

function updateAuthUI(user, limits) {
  currentUser = user;

  const sidebarUserName = document.getElementById('sidebarUserName');
  const sidebarUserRole = document.getElementById('sidebarUserRole');
  const sidebarUserAvatar = document.getElementById('sidebarUserAvatar');
  const sidebarAuthBtnText = document.getElementById('sidebarAuthBtnText');
  const sidebarAuthBtn = document.getElementById('sidebarAuthBtn');

  const mobileAuthBtnText = document.getElementById('mobileAuthBtnText');
  const drawerUserName = document.getElementById('drawerUserName');
  const drawerUserRole = document.getElementById('drawerUserRole');
  const drawerUserAvatar = document.getElementById('drawerUserAvatar');
  const drawerAuthBtnText = document.getElementById('drawerAuthBtnText');

  const applyGuestBox = document.getElementById('applyAccessGuestBox');
  const applyMemberBox = document.getElementById('applyAccessMemberBox');
  const applyMemberUsername = document.getElementById('applyMemberUsername');
  const applyMemberRoleBadge = document.getElementById('applyMemberRoleBadge');

  if (user && user.role !== 'guest') {
    // Registered Member, Premium, Admin, or Owner
    let badgeText = 'MEMBER';
    let badgeClass = 'badge-tier badge-tier-premium';
    if (user.role === 'owner' || user.isOwner) {
      badgeText = 'OWNER';
      badgeClass = 'badge-tier badge-tier-owner';
    } else if (user.role === 'admin') {
      badgeText = 'ADMIN';
      badgeClass = 'badge-tier badge-tier-admin';
    } else if (user.role === 'premium') {
      badgeText = 'PREMIUM';
      badgeClass = 'badge-tier badge-tier-premium';
    }

    if (sidebarUserName) sidebarUserName.textContent = user.username;
    if (sidebarUserRole) {
      sidebarUserRole.textContent = badgeText;
      sidebarUserRole.className = badgeClass;
    }
    if (sidebarUserAvatar) {
      sidebarUserAvatar.className = 'user-avatar-badge';
      if (user.role === 'owner' || user.isOwner) {
        sidebarUserAvatar.classList.add('is-owner');
      } else if (user.role === 'admin') {
        sidebarUserAvatar.classList.add('is-admin');
      } else {
        sidebarUserAvatar.classList.add('is-premium');
      }
    }
    if (sidebarAuthBtnText) sidebarAuthBtnText.textContent = 'Account';
    if (sidebarAuthBtn) sidebarAuthBtn.classList.add('btn-user-active');

    if (mobileAuthBtnText) mobileAuthBtnText.textContent = user.username;
    if (drawerUserName) drawerUserName.textContent = user.username;
    if (drawerUserRole) {
      drawerUserRole.textContent = badgeText;
      drawerUserRole.className = badgeClass;
    }
    if (drawerUserAvatar) {
      drawerUserAvatar.className = 'user-avatar-badge';
      if (user.role === 'owner' || user.isOwner) {
        drawerUserAvatar.classList.add('is-owner');
      } else if (user.role === 'admin') {
        drawerUserAvatar.classList.add('is-admin');
      } else {
        drawerUserAvatar.classList.add('is-premium');
      }
    }
    if (drawerAuthBtnText) drawerAuthBtnText.textContent = 'Account';

    const isOwner = user && (user.role === 'owner' || user.isOwner || user.username?.toLowerCase() === 'sakura');
    if (isOwner) {
      document.body.classList.add('user-is-owner');
    } else {
      document.body.classList.remove('user-is-owner');
    }

    document.body.classList.add('authenticated-user');
    document.querySelectorAll('.guest-only-nav').forEach(el => {
      el.style.display = 'none';
    });

    // Hide tool locks for registered members
    document.querySelectorAll('.nav-lock-badge, .drawer-lock-badge').forEach(el => {
      el.style.display = 'none';
    });

    // Update About & Privacy access status
    if (applyGuestBox) applyGuestBox.style.display = 'none';
    if (applyMemberBox) applyMemberBox.style.display = 'block';
    if (applyMemberUsername) applyMemberUsername.textContent = user.username;
    if (applyMemberRoleBadge) {
      applyMemberRoleBadge.textContent = badgeText;
      applyMemberRoleBadge.className = badgeClass;
    }
  } else {
    // Guest User
    document.body.classList.remove('authenticated-user');
    document.body.classList.remove('user-is-owner');
    document.querySelectorAll('.guest-only-nav').forEach(el => {
      el.style.display = 'flex';
    });

    if (sidebarUserName) sidebarUserName.textContent = 'Guest Visitor';
    if (sidebarUserRole) {
      sidebarUserRole.textContent = 'GUEST ACCESS';
      sidebarUserRole.className = 'badge-tier badge-tier-guest';
    }
    if (sidebarUserAvatar) {
      sidebarUserAvatar.classList.remove('is-premium');
      sidebarUserAvatar.classList.remove('is-owner');
    }
    if (sidebarAuthBtnText) sidebarAuthBtnText.textContent = 'Sign In';
    if (sidebarAuthBtn) sidebarAuthBtn.classList.remove('btn-user-active');

    if (mobileAuthBtnText) mobileAuthBtnText.textContent = 'Sign In';
    if (drawerUserName) drawerUserName.textContent = 'Guest Visitor';
    if (drawerUserRole) {
      drawerUserRole.textContent = 'GUEST ACCESS';
      drawerUserRole.className = 'badge-tier badge-tier-guest';
    }
    if (drawerUserAvatar) {
      drawerUserAvatar.classList.remove('is-premium');
      drawerUserAvatar.classList.remove('is-owner');
    }
    if (drawerAuthBtnText) drawerAuthBtnText.textContent = 'Sign In';

    // Show application form for guests in About & Privacy
    if (applyGuestBox) applyGuestBox.style.display = 'block';
    if (applyMemberBox) applyMemberBox.style.display = 'none';
  }

  // Dynamic navigation item visibility based on assigned role permissions
  const navFeatureMap = [
    { feat: 'movies', selectors: ['#navMovies', '#drawerNavMovies'] },
    { feat: 'music', selectors: ['#navMusic', '#drawerNavMusic'] },
    { feat: 'flac_checker', selectors: ['#navFlacChecker', '#drawerNavFlacChecker'] },
    { feat: 'adult', selectors: ['#navAdultSearch', '#drawerNavAdultSearch', '#bottomNavAdultSearch'] }
  ];

  navFeatureMap.forEach(item => {
    const isAllowed = canAccess(item.feat);
    item.selectors.forEach(sel => {
      const el = document.querySelector(sel);
      if (el) el.style.display = isAllowed ? 'flex' : 'none';
    });
  });

  // If user is currently viewing any restricted panel they don't have access to, redirect to downloader
  const activeRestricted = document.querySelector('.view-panel.active');
  const panelToFeature = {
    viewMovies: 'movies',
    viewMusic: 'music',
    viewFlacChecker: 'flac_checker',
    viewAdultSearch: 'adult'
  };
  if (activeRestricted && panelToFeature[activeRestricted.id] && !canAccess(panelToFeature[activeRestricted.id])) {
    switchView('downloader');
  }

  updateStorageTargetUI();
  applyMaintenanceUI();
}

function updateStorageTargetUI() {
  const grp = document.getElementById('cfgStorageTargetGroup');
  const displayEl = document.getElementById('storageTargetDisplay');
  const selectEl = document.getElementById('storageFolderSelect');

  if (!grp || !displayEl) return;

  if (!currentUser || currentUser.role === 'guest') {
    grp.style.display = 'none';
    return;
  }

  const assignedFolder = currentUser.downloadFolder;
  const allowedFolders = Array.isArray(currentUser.allowedFolders) ? currentUser.allowedFolders.filter(f => f && f !== '*') : [];

  if (assignedFolder || allowedFolders.length > 0) {
    grp.style.display = 'block';
    if (allowedFolders.length > 1 && selectEl) {
      displayEl.style.display = 'none';
      selectEl.style.display = 'block';
      selectEl.innerHTML = allowedFolders.map(f => `
        <option value="${escapeHtml(f)}" ${f === assignedFolder ? 'selected' : ''}>${escapeHtml(f)}</option>
      `).join('');
    } else {
      if (selectEl) selectEl.style.display = 'none';
      displayEl.style.display = 'block';
      displayEl.textContent = assignedFolder || (allowedFolders[0] || 'Default Storage');
    }
  } else {
    grp.style.display = 'none';
  }
}

async function checkUserSession() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      if (data.maintenance && typeof data.maintenance.active === 'boolean') {
        maintenanceState = {
          active: data.maintenance.active,
          message: data.maintenance.message || maintenanceState.message
        };
      }
      if (data.authenticated && data.user) {
        const u = Object.assign({}, data.user, { features: data.features || {} });
        updateAuthUI(u, data.limits);
      } else {
        const guestUser = { role: 'guest', username: 'Guest', features: data.features || {} };
        updateAuthUI(guestUser, data.limits);
      }
    } else {
      updateAuthUI({ role: 'guest', username: 'Guest', features: {} }, null);
    }
  } catch (e) {
    updateAuthUI({ role: 'guest', username: 'Guest', features: {} }, null);
  }
  applyMaintenanceUI();
}

// Auth Modal Management
let currentAuthTab = 'login';

function openAuthModal(tab = 'login', notice = '') {
  const modal = document.getElementById('authModal');
  if (!modal) return;

  const alertEl = document.getElementById('authAlert');
  if (alertEl) {
    if (notice) {
      alertEl.textContent = notice;
      alertEl.className = 'auth-alert auth-alert-error';
      alertEl.style.display = 'block';
    } else {
      alertEl.style.display = 'none';
      alertEl.textContent = '';
    }
  }

  modal.style.display = 'flex';
  const rememberedUser = localStorage.getItem('sakura_remembered_username') || '';
  const rememberCheckbox = document.getElementById('authRememberMe');
  if (rememberCheckbox) {
    rememberCheckbox.checked = localStorage.getItem('sakura_remember_me') !== 'false';
  }
  const userInput = document.getElementById('authUsername');
  const passInput = document.getElementById('authPassword');
  if (userInput && rememberedUser) {
    userInput.value = rememberedUser;
    if (passInput) setTimeout(() => passInput.focus(), 60);
  } else if (userInput) {
    setTimeout(() => userInput.focus(), 60);
  }
}

function closeAuthModal() {
  const modal = document.getElementById('authModal');
  if (modal) modal.style.display = 'none';
  const alertEl = document.getElementById('authAlert');
  if (alertEl) alertEl.style.display = 'none';
}

function setAuthTab(tab) {
  currentAuthTab = 'login';
}

function openAccountModal() {
  const modal = document.getElementById('accountModal');
  if (!modal) return;
  const nameEl = document.getElementById('accountModalUsername');
  const roleEl = document.getElementById('accountModalRoleBadge');
  const adminLinkBtn = document.getElementById('btnAccountAdminStudio');
  const folderPathEl = document.getElementById('accountModalFolderPath');
  const folderBadgeEl = document.getElementById('accountModalFolderBadge');

  const modalAvatar = document.getElementById('accountModalAvatar');

  if (nameEl && currentUser) nameEl.textContent = currentUser.username;
  if (roleEl && currentUser) {
    if (currentUser.role === 'owner' || currentUser.isOwner) {
      roleEl.textContent = 'OWNER / SYSTEM ADMIN';
      roleEl.className = 'badge-tier badge-tier-owner';
    } else if (currentUser.role === 'admin') {
      roleEl.textContent = 'ADMIN';
      roleEl.className = 'badge-tier badge-tier-admin';
    } else {
      roleEl.textContent = 'PREMIUM MEMBER';
      roleEl.className = 'badge-tier badge-tier-premium';
    }
  }

  if (modalAvatar && currentUser) {
    modalAvatar.className = 'user-avatar-badge';
    if (currentUser.role === 'owner' || currentUser.isOwner) {
      modalAvatar.classList.add('is-owner');
    } else if (currentUser.role === 'admin') {
      modalAvatar.classList.add('is-admin');
    } else {
      modalAvatar.classList.add('is-premium');
    }
  }

  const subfoldersNoteEl = document.getElementById('accountModalSubfoldersNote');
  const changeFolderBtn = document.getElementById('btnChangeDownloadFolder');

  if (folderPathEl && folderBadgeEl && currentUser) {
    if (currentUser.downloadFolder && currentUser.downloadFolder !== '*') {
      folderPathEl.textContent = currentUser.downloadFolder;
      folderPathEl.title = currentUser.downloadFolder;
      folderBadgeEl.textContent = 'Permanent Storage';
      folderBadgeEl.className = 'badge-tag badge-tag-emerald';
      if (subfoldersNoteEl) subfoldersNoteEl.style.display = 'block';
    } else if (currentUser.downloadFolder === '*' || (!currentUser.downloadFolder && (currentUser.role === 'owner' || currentUser.isOwner))) {
      folderPathEl.textContent = 'Unrestricted (Full Server Storage)';
      folderPathEl.title = 'Full server storage access';
      folderBadgeEl.textContent = 'Full Access';
      folderBadgeEl.className = 'badge-tag badge-tag-emerald';
      if (subfoldersNoteEl) subfoldersNoteEl.style.display = 'none';
    } else {
      folderPathEl.textContent = 'Default Temporary Media Directory';
      folderPathEl.title = 'Default server temp storage';
      folderBadgeEl.textContent = 'Temporary Storage';
      folderBadgeEl.className = 'badge-tag';
      if (subfoldersNoteEl) subfoldersNoteEl.style.display = 'none';
    }
  }

  if (changeFolderBtn && currentUser) {
    const isOwnerOrAdmin = currentUser.role === 'owner' || currentUser.isOwner || currentUser.role === 'admin' || canAccess('custom_storage');
    changeFolderBtn.style.display = isOwnerOrAdmin ? 'inline-flex' : 'none';
    changeFolderBtn.textContent = (currentUser.downloadFolder && currentUser.downloadFolder !== '*') ? '✏️ Change Storage Folder' : '📁 Set Permanent Download Folder';
  }

  if (adminLinkBtn) {
    const isOwnerOrAdmin = currentUser && (currentUser.role === 'owner' || currentUser.isOwner || currentUser.role === 'admin');
    adminLinkBtn.style.display = isOwnerOrAdmin ? 'inline-flex' : 'none';
  }
  modal.style.display = 'flex';
}

function closeAccountModal() {
  const modal = document.getElementById('accountModal');
  if (modal) modal.style.display = 'none';
}

function setupAuthModalEvents() {
  const sidebarUserCard = document.getElementById('sidebarUserCard');
  const sidebarAuthBtn = document.getElementById('sidebarAuthBtn');
  const drawerUserCard = document.getElementById('drawerUserCard');
  const drawerAuthBtn = document.getElementById('drawerAuthBtn');
  const mobileAuthBtn = document.getElementById('mobileAuthBtn');
  const closeAuthBtn = document.getElementById('btnCloseAuthModal');
  const closeAccountBtn = document.getElementById('btnCloseAccountModal');
  const authModal = document.getElementById('authModal');
  const accountModal = document.getElementById('accountModal');
  const authApplyLink = document.getElementById('authApplyLink');
  const authForm = document.getElementById('authForm');
  const logoutBtn = document.getElementById('btnLogoutBtn');
  const applyForm = document.getElementById('applyAccessForm');

  function handleAuthClick() {
    if (currentUser && currentUser.role !== 'guest') {
      openAccountModal();
    } else {
      openAuthModal('login');
    }
  }

  if (sidebarUserCard) {
    sidebarUserCard.addEventListener('click', handleAuthClick);
    sidebarUserCard.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleAuthClick();
      }
    });
  }

  if (drawerUserCard) {
    drawerUserCard.addEventListener('click', () => {
      const drawer = document.getElementById('mobileDrawerBackdrop');
      if (drawer) drawer.style.display = 'none';
      handleAuthClick();
    });
    drawerUserCard.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const drawer = document.getElementById('mobileDrawerBackdrop');
        if (drawer) drawer.style.display = 'none';
        handleAuthClick();
      }
    });
  }

  if (sidebarAuthBtn) {
    sidebarAuthBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleAuthClick();
    });
  }
  if (mobileAuthBtn) mobileAuthBtn.addEventListener('click', handleAuthClick);
  if (drawerAuthBtn) {
    drawerAuthBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const drawer = document.getElementById('mobileDrawerBackdrop');
      if (drawer) drawer.style.display = 'none';
      handleAuthClick();
    });
  }

  if (closeAuthBtn) closeAuthBtn.addEventListener('click', closeAuthModal);
  if (closeAccountBtn) closeAccountBtn.addEventListener('click', closeAccountModal);

  const changeFolderBtn = document.getElementById('btnChangeDownloadFolder');
  if (changeFolderBtn) {
    changeFolderBtn.addEventListener('click', async () => {
      const current = (currentUser && currentUser.downloadFolder) || (currentUser && (currentUser.role === 'owner' || currentUser.isOwner) ? '/media/storage/sakura' : '');
      const entered = prompt(
        'Enter permanent download folder path on server:\n(Subfolders "Movies and Shows", "Music", "Adult", and "Links" will be automatically created inside)',
        current
      );
      if (entered === null) return;
      const cleanPath = entered.trim();
      try {
        const res = await fetch('/api/user/download-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ downloadFolder: cleanPath })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          currentUser.downloadFolder = data.downloadFolder;
          showToast(data.message || 'Permanent download folder updated successfully!', 'success');
          openAccountModal();
        } else {
          showToast(data.error || 'Failed to update download folder', 'error');
        }
      } catch (err) {
        showToast('Network error updating download folder', 'error');
      }
    });
  }

  if (authModal) {
    authModal.addEventListener('click', (e) => {
      if (e.target === authModal) closeAuthModal();
    });
  }
  if (accountModal) {
    accountModal.addEventListener('click', (e) => {
      if (e.target === accountModal) closeAccountModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAuthModal();
      closeAccountModal();
    }
  });

  if (authApplyLink) {
    authApplyLink.addEventListener('click', (e) => {
      e.preventDefault();
      closeAuthModal();
      switchView('about');
      setTimeout(() => {
        const sec = document.getElementById('applyAccessSection');
        if (sec) {
          sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const userInp = document.getElementById('applyUsername');
          if (userInp) userInp.focus();
        }
      }, 150);
    });
  }

  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const usernameInput = document.getElementById('authUsername');
      const passwordInput = document.getElementById('authPassword');
      const alertEl = document.getElementById('authAlert');
      const spinner = document.getElementById('authSpinner');
      const submitText = document.getElementById('authSubmitText');

      const username = usernameInput ? usernameInput.value.trim() : '';
      const password = passwordInput ? passwordInput.value : '';

      if (!username || username.length < 3) {
        if (alertEl) {
          alertEl.textContent = 'Username must be at least 3 characters long.';
          alertEl.className = 'auth-alert auth-alert-error';
          alertEl.style.display = 'block';
        }
        return;
      }

      if (!password || password.length < 6) {
        if (alertEl) {
          alertEl.textContent = 'Password must be at least 6 characters long.';
          alertEl.className = 'auth-alert auth-alert-error';
          alertEl.style.display = 'block';
        }
        return;
      }

      if (spinner) spinner.style.display = 'inline-block';
      if (submitText) submitText.style.opacity = '0.5';

      const rememberCheckbox = document.getElementById('authRememberMe');
      const rememberMe = rememberCheckbox ? rememberCheckbox.checked : true;

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, rememberMe })
        });
        const data = await res.json();

        if (res.ok && data.success && data.token) {
          userAuthToken = data.token;
          sessionStorage.setItem('sakura_user_token', data.token);

          if (rememberMe) {
            localStorage.setItem('sakura_user_token', data.token);
            localStorage.setItem('sakura_remembered_username', username);
            localStorage.setItem('sakura_remember_me', 'true');
          } else {
            localStorage.removeItem('sakura_user_token');
            localStorage.removeItem('sakura_remembered_username');
            localStorage.setItem('sakura_remember_me', 'false');
          }

          if (alertEl) {
            alertEl.textContent = 'Welcome back, ' + (data.user?.username || username) + '!';
            alertEl.className = 'auth-alert auth-alert-success';
            alertEl.style.display = 'block';
          }

          updateAuthUI(data.user, null);
          showToast('Signed in successfully', 'success');
          if (typeof restartJobsSSE === 'function') restartJobsSSE();
          if (typeof loadJobs === 'function') loadJobs();

          setTimeout(() => {
            closeAuthModal();
            if (passwordInput) passwordInput.value = '';
          }, 600);
        } else {
          if (alertEl) {
            alertEl.textContent = data.error || 'Authentication failed. Please check your credentials.';
            alertEl.className = 'auth-alert auth-alert-error';
            alertEl.style.display = 'block';
          }
        }
      } catch (err) {
        if (alertEl) {
          alertEl.textContent = 'Connection error. Please try again.';
          alertEl.className = 'auth-alert auth-alert-error';
          alertEl.style.display = 'block';
        }
      } finally {
        if (spinner) spinner.style.display = 'none';
        if (submitText) submitText.style.opacity = '1';
      }
    });
  }

  if (applyForm) {
    applyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const applyUserInput = document.getElementById('applyUsername');
      const applyReasonInput = document.getElementById('applyReason');
      const alertEl = document.getElementById('applyStatusAlert');
      const btnSubmit = document.getElementById('btnApplySubmit');
      const btnText = document.getElementById('btnApplyText');

      const username = applyUserInput ? applyUserInput.value.trim() : '';
      const reason = applyReasonInput ? applyReasonInput.value.trim() : '';

      if (!username || username.length < 3) {
        if (alertEl) {
          alertEl.textContent = 'Please enter a desired username of at least 3 characters.';
          alertEl.className = 'apply-status-alert alert-error';
          alertEl.style.display = 'block';
        }
        return;
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
        if (alertEl) {
          alertEl.textContent = 'Username can only contain letters, numbers, underscores, and hyphens.';
          alertEl.className = 'apply-status-alert alert-error';
          alertEl.style.display = 'block';
        }
        return;
      }

      if (btnSubmit) btnSubmit.disabled = true;
      if (btnText) btnText.textContent = 'Submitting...';

      try {
        const res = await fetch('/api/access-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, reason })
        });
        const data = await res.json();

        if (res.ok && data.success) {
          if (alertEl) {
            alertEl.textContent = data.message || 'Access request submitted! Sakura (Owner) will review and activate your account.';
            alertEl.className = 'apply-status-alert alert-success';
            alertEl.style.display = 'block';
          }
          if (applyUserInput) applyUserInput.value = '';
          if (applyReasonInput) applyReasonInput.value = '';
          showToast('Access request submitted to Sakura!', 'success');
        } else {
          if (alertEl) {
            alertEl.textContent = data.error || 'Failed to submit access request.';
            alertEl.className = 'apply-status-alert alert-error';
            alertEl.style.display = 'block';
          }
        }
      } catch (err) {
        if (alertEl) {
          alertEl.textContent = 'Network error while contacting server. Please try again.';
          alertEl.className = 'apply-status-alert alert-error';
          alertEl.style.display = 'block';
        }
      } finally {
        if (btnSubmit) btnSubmit.disabled = false;
        if (btnText) btnText.textContent = 'Submit Access Request';
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch (e) {}
      userAuthToken = '';
      localStorage.removeItem('sakura_user_token');
      sessionStorage.removeItem('sakura_user_token');
      currentUser = null;
      updateAuthUI(null, null);
      if (typeof restartJobsSSE === 'function') restartJobsSSE();
      if (typeof loadJobs === 'function') loadJobs();
      closeAccountModal();
      showToast('Signed out. You are now browsing as Guest.', 'info');
    });
  }

  // Interactivity warning / modal open on selecting premium items
  const videoQualitySelect = document.getElementById('videoQualitySelect');
  if (videoQualitySelect) {
    videoQualitySelect.addEventListener('change', (e) => {
      const val = String(e.target.value).toLowerCase();
      if (['4320', '2160', '1440', '1080'].includes(val) && !canAccess('quality_4k')) {
        showToast('4K, 8K & Full HD resolutions are restricted for your role. Please sign in or upgrade.', 'info');
      }
    });
  }

  const audioFormatSelect = document.getElementById('audioFormatSelect');
  if (audioFormatSelect) {
    audioFormatSelect.addEventListener('change', (e) => {
      const val = String(e.target.value).toLowerCase();
      if ((val === 'flac' || val === 'wav') && !canAccess('audiophile_flac')) {
        showToast('Lossless Studio Master FLAC is restricted for your role. Please sign in or upgrade.', 'info');
      }
    });
  }
}

// Maintenance Mode Button Event Handlers
function setupMaintenanceEvents() {
  const btnUnlock = document.getElementById('btnOwnerTestingUnlock');
  const btnRefresh = document.getElementById('btnRefreshMaintenance');
  const btnDisable = document.getElementById('btnOwnerDisableMaintenance');

  if (btnUnlock) {
    btnUnlock.addEventListener('click', () => {
      openAuthModal('login', 'Please sign in with Owner credentials to access testing mode.');
    });
  }

  if (btnRefresh) {
    btnRefresh.addEventListener('click', async () => {
      btnRefresh.disabled = true;
      try {
        const res = await fetch('/api/maintenance/status');
        if (res.ok) {
          const data = await res.json();
          maintenanceState = {
            active: !!data.maintenance,
            message: data.message || maintenanceState.message
          };
          applyMaintenanceUI();
          if (typeof showToast === 'function') {
            showToast(data.maintenance ? 'Site is still under maintenance' : 'Site is back online!', data.maintenance ? 'info' : 'success');
          }
        }
      } catch (err) {
        if (typeof showToast === 'function') showToast('Could not reach server', 'error');
      } finally {
        btnRefresh.disabled = false;
      }
    });
  }

  if (btnDisable) {
    btnDisable.addEventListener('click', async () => {
      if (!confirm('Disable Work In Progress mode and restore public access for all visitors?')) {
        return;
      }
      btnDisable.disabled = true;
      try {
        const res = await fetch('/api/admin/maintenance', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            maintenanceMode: false
          })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          maintenanceState = {
            active: false,
            message: data.maintenanceMessage || maintenanceState.message
          };
          applyMaintenanceUI();
          if (typeof showToast === 'function') showToast('Work In Progress mode deactivated — Public access restored', 'success');
        } else {
          if (typeof showToast === 'function') showToast(data.error || 'Failed to disable maintenance', 'error');
        }
      } catch (err) {
        if (typeof showToast === 'function') showToast('Network error: ' + err.message, 'error');
      } finally {
        btnDisable.disabled = false;
      }
    });
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  setupAuthModalEvents();
  setupMaintenanceEvents();
  checkUserSession();
  loadJobs();
  initGlobalSSEStream();

  // Passive fallback watchdog (every 30s) in case SSE connection closes silently or network changes
  setInterval(() => {
    if (!sseEventSource || sseEventSource.readyState !== EventSource.OPEN) {
      loadJobs();
    }
  }, 30000);
});

function setupEventListeners() {
  // Mode Tabs
  tabVideoMode.addEventListener('click', () => setMode('video'));
  tabAudioMode.addEventListener('click', () => setMode('audio'));
  tabBatchMode.addEventListener('click', () => setMode('batch'));

  // Quick Presets
  presetBestVideo.addEventListener('click', () => applyPreset('bestVideo'));
  presetAudioMp3.addEventListener('click', () => applyPreset('audioMp3'));
  presetAudioFlac.addEventListener('click', () => applyPreset('audioFlac'));
  presetSubtitles.addEventListener('click', () => applyPreset('subtitles'));
  presetSponsorBlock.addEventListener('click', () => applyPreset('sponsorBlock'));

  // Fetch Form
  document.getElementById('fetchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    fetchVideoMetadata();
  });

  // Paste Button
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        urlInput.value = text.trim();
        urlInput.focus();
        fetchVideoMetadata();
      }
    } catch (err) {
      console.warn('Clipboard read failed:', err);
      urlInput.focus();
    }
  });

  // Batch URLs input listener
  batchUrlsInput.addEventListener('input', () => {
    const urls = batchUrlsInput.value.split('\n').map(u => u.trim()).filter(Boolean);
    batchCountHint.textContent = `${urls.length} URL${urls.length === 1 ? '' : 's'} detected`;
  });

  // Start Batch Download
  startBatchBtn.addEventListener('click', startBatchDownload);

  // Start Single Download
  startDownloadBtn.addEventListener('click', startDownload);

  // Clear preview
  clearPreviewBtn.addEventListener('click', () => {
    previewCard.style.display = 'none';
    currentExtractedData = null;
  });

  // Clear all completed tasks button
  if (clearAllCompletedBtn) {
    clearAllCompletedBtn.addEventListener('click', clearAllCompletedJobs);
  }

  // Global Pause All and Resume All buttons
  const pauseAllBtn = document.getElementById('pauseAllBtn');
  const resumeAllBtn = document.getElementById('resumeAllBtn');
  if (pauseAllBtn) {
    pauseAllBtn.addEventListener('click', pauseAllJobs);
  }
  if (resumeAllBtn) {
    resumeAllBtn.addEventListener('click', resumeAllJobs);
  }

  // Close modals
  if (closeModalBtn) closeModalBtn.addEventListener('click', closePlayerModal);
  if (playerModal) {
    playerModal.addEventListener('click', (e) => {
      if (e.target === playerModal) closePlayerModal();
    });
  }

  if (closeReadyModalBtn) {
    closeReadyModalBtn.addEventListener('click', () => {
      if (readyModal) readyModal.style.display = 'none';
    });
  }
  if (readyModal) {
    readyModal.addEventListener('click', (e) => {
      if (e.target === readyModal) readyModal.style.display = 'none';
    });
  }

  // Ready Modal Actions
  if (readyModalWatchBtn) {
    readyModalWatchBtn.addEventListener('click', () => {
      if (activeReadyJob) {
        if (readyModal) readyModal.style.display = 'none';
        playMedia(activeReadyJob.streamUrl, activeReadyJob.title, activeReadyJob.downloadUrl);
      }
    });
  }

  // Sidebar & Mobile Navigation View Switching
  const allNavButtons = document.querySelectorAll('[data-view]');
  allNavButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const view = btn.getAttribute('data-view');
      switchView(view);
    });
  });

  // Mobile Navigation Drawer Listeners
  initMobileDrawer();
}

function openMobileDrawer() {
  const backdrop = document.getElementById('mobileDrawerBackdrop');
  if (backdrop) {
    backdrop.style.display = 'block';
    setTimeout(() => backdrop.classList.add('open'), 10);
    document.body.style.overflow = 'hidden';
  }
}

function closeMobileDrawer() {
  const backdrop = document.getElementById('mobileDrawerBackdrop');
  if (backdrop && (backdrop.classList.contains('open') || backdrop.style.display !== 'none')) {
    backdrop.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => {
      if (!backdrop.classList.contains('open')) {
        backdrop.style.display = 'none';
      }
    }, 250);
  }
}

function initMobileDrawer() {
  const openBtn = document.getElementById('mobileMenuBtn');
  const moreBtn = document.getElementById('bottomNavMoreBtn');
  const closeBtn = document.getElementById('closeMobileDrawerBtn');
  const backdrop = document.getElementById('mobileDrawerBackdrop');

  if (openBtn) openBtn.addEventListener('click', openMobileDrawer);
  if (moreBtn) moreBtn.addEventListener('click', openMobileDrawer);
  if (closeBtn) closeBtn.addEventListener('click', closeMobileDrawer);
  if (backdrop) {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeMobileDrawer();
    });
  }
}

function switchView(viewName, forceAllow = false) {
  // Close mobile drawer if open
  closeMobileDrawer();

  // Role Permissions Feature Gating
  const viewToFeature = {
    movies: 'movies',
    music: 'music',
    'flac-checker': 'flac_checker',
    'adult-search': 'adult'
  };

  if (!forceAllow && viewToFeature[viewName] && !canAccess(viewToFeature[viewName])) {
    switchView('downloader');
    return;
  }

  // Close any lingering overlay modals on view switch
  const movieReleasesModal = document.getElementById('movieReleasesModal');
  if (movieReleasesModal) movieReleasesModal.style.display = 'none';
  const musicFormatsModal = document.getElementById('musicFormatsModal');
  if (musicFormatsModal) musicFormatsModal.style.display = 'none';

  // Stop any active preview audio
  if (currentAudioPreview) {
    currentAudioPreview.pause();
    currentAudioPreview = null;
    currentPreviewTrackId = null;
    document.querySelectorAll('.music-preview-btn').forEach(b => b.classList.remove('playing'));
  }

  // 1. Hide all view panels and show target panel
  const panels = {
    downloader: document.getElementById('viewDownloader'),
    movies: document.getElementById('viewMovies'),
    music: document.getElementById('viewMusic'),
    'flac-checker': document.getElementById('viewFlacChecker'),
    'adult-search': document.getElementById('viewAdultSearch'),
    supported: document.getElementById('viewSupported'),
    about: document.getElementById('viewAbout')
  };

  Object.keys(panels).forEach(key => {
    if (panels[key]) {
      if (key === viewName) {
        panels[key].style.display = 'block';
        panels[key].classList.add('active');
        if (key === 'flac-checker') {
          loadRecentFlacFiles();
        } else if (key === 'movies') {
          syncMovieSourceTabs();
        }
      } else {
        panels[key].style.display = 'none';
        panels[key].classList.remove('active');
      }
    }
  });

  // 2. Update active state across sidebar and bottom navigation
  document.querySelectorAll('[data-view]').forEach(btn => {
    const isCurrent = btn.getAttribute('data-view') === viewName;
    btn.classList.toggle('active', isCurrent);
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setMode(mode) {
  currentMode = mode;

  tabVideoMode.classList.toggle('active', mode === 'video');
  tabAudioMode.classList.toggle('active', mode === 'audio');
  tabBatchMode.classList.toggle('active', mode === 'batch');

  if (mode === 'batch') {
    singleUrlFormWrapper.style.display = 'none';
    batchFormWrapper.style.display = 'block';
  } else {
    singleUrlFormWrapper.style.display = 'block';
    batchFormWrapper.style.display = 'none';
  }

  const isAudio = mode === 'audio';
  cfgVideoQualityGroup.style.display = isAudio ? 'none' : 'flex';
  cfgVideoFormatGroup.style.display = isAudio ? 'none' : 'flex';
  cfgAudioFormatGroup.style.display = isAudio ? 'flex' : 'none';
  cfgAudioBitrateGroup.style.display = isAudio ? 'flex' : 'none';

  if (downloadBtnText) {
    downloadBtnText.textContent = isAudio ? 'Extract Audio' : 'Download Now';
  }
}

function applyPreset(presetKey) {

  if (presetKey === 'bestVideo') {
    setMode('video');
    videoQualitySelect.value = 'best';
    videoFormatSelect.value = 'mp4';
    chkEmbedThumbnail.checked = true;
    highlightPreset(presetBestVideo);
  } else if (presetKey === 'audioMp3') {
    setMode('audio');
    audioFormatSelect.value = 'mp3';
    audioBitrateSelect.value = '320k';
    chkEmbedThumbnail.checked = true;
    highlightPreset(presetAudioMp3);
  } else if (presetKey === 'audioFlac') {
    setMode('audio');
    audioFormatSelect.value = 'flac';
    chkEmbedThumbnail.checked = true;
    highlightPreset(presetAudioFlac);
  } else if (presetKey === 'subtitles') {
    setMode('video');
    chkEmbedSubtitles.checked = true;
    chkAutoSubs.checked = true;
    if (!subLangsInput.value || subLangsInput.value === 'all,-live_chat' || subLangsInput.value === 'en.*,hi.*,ja.*') {
      subLangsInput.value = 'en,hi,ja';
    }
    highlightPreset(presetSubtitles);
  } else if (presetKey === 'sponsorBlock') {
    chkSponsorBlock.checked = !chkSponsorBlock.checked;
    if (chkSponsorBlock.checked) highlightPreset(presetSponsorBlock);
    else presetSponsorBlock.classList.remove('active');
  }
}

function highlightPreset(element) {
  document.querySelectorAll('.preset-chip').forEach(p => p.classList.remove('active'));
  if (element) element.classList.add('active');
}

// 1. Fetch Video Metadata
async function fetchVideoMetadata() {
  const url = urlInput.value.trim();
  if (!url) return;

  setFetchingState(true);

  try {
    const res = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Failed to extract media information');
    }

    currentExtractedData = data;
    renderPreviewCard(data);
  } catch (err) {
    showToast(`${err.message}`, 'error');
  } finally {
    setFetchingState(false);
  }
}

function setFetchingState(isLoading) {
  if (isLoading) {
    fetchBtn.disabled = true;
    fetchSpinner.style.display = 'block';
    fetchBtn.querySelector('.btn-text').textContent = 'Extracting...';
  } else {
    fetchBtn.disabled = false;
    fetchSpinner.style.display = 'none';
    fetchBtn.querySelector('.btn-text').textContent = 'Fetch Info';
  }
}

function renderPreviewCard(data) {
  previewPoster.src = data.poster || '/icon.svg';
  previewCode.textContent = data.code || (data.extractor ? data.extractor.toUpperCase() : 'MEDIA');
  previewTitle.textContent = data.title;

  const qualityBadge = document.getElementById('previewQualityBadge');
  if (qualityBadge) {
    if (data.qualityLabel) {
      qualityBadge.textContent = data.qualityLabel;
      qualityBadge.style.display = 'block';
    } else if (data.mode === 'audio' || data.extractor === 'Spotify') {
      qualityBadge.textContent = 'Hi-Fi Audio';
      qualityBadge.style.display = 'block';
    } else {
      qualityBadge.textContent = 'HD Video';
      qualityBadge.style.display = 'block';
    }
  }

  if (data.model) {
    previewModel.textContent = data.model;
    previewModel.style.display = 'inline-block';
  } else {
    previewModel.style.display = 'none';
  }

  if (data.duration) {
    previewDuration.textContent = data.duration;
    previewDuration.style.display = 'inline-block';
  } else {
    previewDuration.style.display = 'none';
  }

  // Tags
  previewTags.innerHTML = '';
  if (data.tags && data.tags.length > 0) {
    data.tags.forEach(t => {
      const span = document.createElement('span');
      span.className = 'tag-pill';
      span.textContent = t;
      previewTags.appendChild(span);
    });
  }

  // Auto-switch to audio mode for Spotify
  if (data.extractor === 'Spotify' || data.mode === 'audio') {
    setMode('audio');
    const isFlacPreset = presetAudioFlac && presetAudioFlac.classList.contains('active');
    if (audioFormatSelect) {
      if (isFlacPreset || audioFormatSelect.value === 'flac') {
        audioFormatSelect.value = 'flac';
      } else if (!audioFormatSelect.value) {
        audioFormatSelect.value = 'mp3';
      }
    }
    if (audioBitrateSelect && audioFormatSelect && audioFormatSelect.value !== 'flac') {
      audioBitrateSelect.value = '320k';
    }
    if (chkEmbedThumbnail) chkEmbedThumbnail.checked = true;
  }

  previewCard.style.display = 'block';
  updateStorageTargetUI();
  previewCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 2. Start Single Download Job
async function startDownload() {
  if (!currentExtractedData) return;

  const storageSelect = document.getElementById('storageFolderSelect');
  const selectedFolder = (storageSelect && storageSelect.style.display !== 'none' && storageSelect.value)
    ? storageSelect.value
    : (currentUser && currentUser.downloadFolder ? currentUser.downloadFolder : '');

  const payload = {
    url: currentExtractedData.sourceUrl || urlInput.value.trim(),
    hlsUrl: currentExtractedData.hlsUrl,
    downloadTargetUrl: currentExtractedData.downloadTargetUrl,
    referer: currentExtractedData.referer || undefined,
    title: currentExtractedData.title,
    code: currentExtractedData.code,
    poster: currentExtractedData.poster,
    downloadFolder: selectedFolder || undefined,
    concurrentFragments: parseInt(concurrencySelect.value, 10) || 32,
    mode: currentMode,
    videoQuality: videoQualitySelect.value,
    videoFormat: videoFormatSelect.value,
    audioFormat: audioFormatSelect.value,
    audioBitrate: audioBitrateSelect.value,
    embedThumbnail: chkEmbedThumbnail.checked,
    embedMetadata: chkEmbedMetadata.checked,
    embedSubtitles: chkEmbedSubtitles.checked,
    autoSubs: chkAutoSubs.checked,
    subLangs: subLangsInput.value.trim(),
    sponsorBlock: chkSponsorBlock.checked,
    splitChapters: chkSplitChapters.checked,
    customArgs: customArgsInput.value.trim()
  };

  startDownloadBtn.disabled = true;
  downloadBtnText.textContent = 'Processing...';

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      if (data.requireAuth) {
        openAuthModal('login', data.error);
      }
      throw new Error(data.error || 'Failed to dispatch download');
    }

    if (data.qualityNotice) {
      showToast(data.qualityNotice, 'info');
    }

    previewCard.style.display = 'none';
    urlInput.value = '';
    currentExtractedData = null;

    sessionJobIds.add(data.jobId);
    saveSessionJobs();

    activeJobStatusTracker.set(data.jobId, 'queued');
    loadJobs();
  } catch (err) {
    showToast(`Download Error: ${err.message}`, 'error');
  } finally {
    startDownloadBtn.disabled = false;
    downloadBtnText.textContent = currentMode === 'audio' ? 'Extract Audio' : 'Download Now';
  }
}

// 2b. Start Batch Download
async function startBatchDownload() {
  const urls = batchUrlsInput.value.split('\n').map(u => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    showToast('Please enter at least one URL', 'error');
    return;
  }

  const options = {
    mode: currentMode,
    videoQuality: videoQualitySelect.value,
    videoFormat: videoFormatSelect.value,
    audioFormat: audioFormatSelect.value,
    audioBitrate: audioBitrateSelect.value,
    embedThumbnail: chkEmbedThumbnail.checked,
    embedMetadata: chkEmbedMetadata.checked,
    embedSubtitles: chkEmbedSubtitles.checked,
    sponsorBlock: chkSponsorBlock.checked,
    concurrentFragments: parseInt(concurrencySelect.value, 10) || 32
  };

  startBatchBtn.disabled = true;
  startBatchBtn.querySelector('span').textContent = 'Processing queue...';

  try {
    const res = await fetch('/api/batch-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls, ...options })
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      if (data.requireAuth) {
        openAuthModal('login', data.error);
      }
      throw new Error(data.error || 'Batch download failed');
    }

    if (data.notice) {
      showToast(data.notice, 'info');
    }

    batchUrlsInput.value = '';
    batchCountHint.textContent = '0 URLs detected';

    if (data.jobs) {
      data.jobs.forEach(j => {
        sessionJobIds.add(j.jobId);
        activeJobStatusTracker.set(j.jobId, 'queued');
      });
      saveSessionJobs();
    }
    loadJobs();
    setMode('video');
  } catch (err) {
    showToast(`Batch Error: ${err.message}`, 'error');
  } finally {
    startBatchBtn.disabled = false;
    startBatchBtn.querySelector('span').textContent = 'Process & Download All';
  }
}

// 3. Handle Download Completion (Non-Intrusive, No Auto-Download)
function triggerDeviceDownload(job) {
  activeReadyJob = job;

  if (readyModalTitle) readyModalTitle.textContent = job.filename || job.title || 'Download Ready';
  if (readyModalSize) readyModalSize.textContent = job.filesize ? `Size: ${job.filesize}` : '';

  if (readyModalSaveBtn) {
    readyModalSaveBtn.href = job.downloadUrl;
    readyModalSaveBtn.setAttribute('download', job.filename || 'download');
  }

  const readyModalFolderBtn = document.getElementById('readyModalFolderBtn');
  const isElectron = !!(window.electronAPI && window.electronAPI.isElectron);
  if (readyModalFolderBtn) {
    if (isElectron) {
      readyModalFolderBtn.style.display = 'inline-flex';
      readyModalFolderBtn.onclick = () => openFileInFolder(job.filePath);
    } else {
      readyModalFolderBtn.style.display = 'none';
    }
  }

  // Show non-intrusive success notification toast
  showToast(`✓ Download completed: ${job.title || job.filename || 'Media'}`, 'success');

  // Native Windows Desktop Notification
  if (window.electronAPI && window.electronAPI.notify) {
    window.electronAPI.notify({
      title: 'Download Complete!',
      body: `${job.title || job.filename || 'Media'} is ready in your Downloads folder.`
    });
  }
}

// 4. SSE Stream Connection (Legacy backward compatibility wrapper)
function subscribeToJob(jobId, retryCount = 0) {
  // Real-time synchronization is now unified via the persistent Global SSE stream (/api/jobs/stream)
}

// 5. Job List Rendering & Updates
async function loadJobs() {
  try {
    const res = await fetch('/api/jobs');
    const userJobs = await res.json();

    if (Array.isArray(userJobs)) {
      renderJobsList(userJobs);
    }
  } catch (err) {
    console.warn('Failed to load jobs:', err);
  }
}

function renderJobsList(jobs) {
  if (!jobs || jobs.length === 0) {
    emptyJobsState.style.display = 'block';
    activeCountLabel.textContent = '0 Active';
    queueStatusIndicator.querySelector('.status-dot').classList.remove('active');
    if (clearAllCompletedBtn) clearAllCompletedBtn.style.display = 'none';
    const pauseAllBtn = document.getElementById('pauseAllBtn');
    const resumeAllBtn = document.getElementById('resumeAllBtn');
    if (pauseAllBtn) pauseAllBtn.style.display = 'none';
    if (resumeAllBtn) resumeAllBtn.style.display = 'none';
    for (const [jid, es] of activeEventSources.entries()) {
      try { es.close(); } catch (e) {}
    }
    activeEventSources.clear();
    activeJobStatusTracker.clear();
    jobsList.innerHTML = '';
    return;
  }

  emptyJobsState.style.display = 'none';

  // Prune any existing DOM cards that are not in incoming jobs
  const incomingIds = new Set(jobs.map(j => j.id));
  const existingCards = jobsList.querySelectorAll('.job-card');
  existingCards.forEach(card => {
    const id = card.id.replace('job-card-', '');
    if (!incomingIds.has(id)) {
      if (activeEventSources.has(id)) {
        try { activeEventSources.get(id).close(); } catch (e) {}
        activeEventSources.delete(id);
      }
      activeJobStatusTracker.delete(id);
      card.remove();
    }
  });

  const activeJobs = jobs.filter(j => j.status === 'downloading');
  const pausedJobs = jobs.filter(j => j.status === 'paused');
  const queuedJobs = jobs.filter(j => j.status === 'queued');

  let activeText = `${activeJobs.length} Active`;
  if (pausedJobs.length > 0) {
    activeText += ` • ${pausedJobs.length} Paused`;
  }
  activeCountLabel.textContent = activeText;
  
  if (activeJobs.length > 0) {
    queueStatusIndicator.querySelector('.status-dot').classList.add('active');
  } else {
    queueStatusIndicator.querySelector('.status-dot').classList.remove('active');
  }

  const pauseAllBtn = document.getElementById('pauseAllBtn');
  const resumeAllBtn = document.getElementById('resumeAllBtn');
  if (pauseAllBtn) {
    pauseAllBtn.style.display = (activeJobs.length > 0 || queuedJobs.length > 0) ? 'inline-flex' : 'none';
  }
  if (resumeAllBtn) {
    resumeAllBtn.style.display = (pausedJobs.length > 0) ? 'inline-flex' : 'none';
  }

  const hasCompleted = jobs.some(j => j.status === 'completed' || j.status === 'cancelled' || j.status === 'failed');
  if (clearAllCompletedBtn) {
    clearAllCompletedBtn.style.display = hasCompleted ? 'inline-flex' : 'none';
  }

  jobs.forEach(job => {
    if (window.allJobsMap) window.allJobsMap.set(job.id, job);

    // Track state transitions to trigger device download modal / notification on completion
    const prevStatus = activeJobStatusTracker.get(job.id);
    if ((prevStatus === 'downloading' || prevStatus === 'queued' || prevStatus === 'resolving_ddl' || prevStatus === 'resolving_olamovies') && job.status === 'completed') {
      activeJobStatusTracker.delete(job.id);
      triggerDeviceDownload(job);
    } else if (job.status === 'downloading' || job.status === 'queued' || job.status === 'resolving_ddl' || job.status === 'resolving_olamovies') {
      activeJobStatusTracker.set(job.id, job.status);
    } else if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      activeJobStatusTracker.delete(job.id);
    }

    let card = document.getElementById(`job-card-${job.id}`);
    if (!card) {
      card = createJobCardElement(job);
      jobsList.appendChild(card);
    }
    updateJobCard(job);
  });
}

window.renderJobs = renderJobsList;

function createJobCardElement(job) {
  const card = document.createElement('div');
  card.id = `job-card-${job.id}`;
  card.className = `job-card ${job.status}`;
  if (job.downloadFolder) {
    card.dataset.downloadFolder = job.downloadFolder;
  }

  const isAudio = job.mode === 'audio' || 
                  job.mode === 'audiophile_flac' || 
                  (job.opts && (job.opts.isMusicTrack || job.opts.audioFormat || job.opts.type === 'audio')) ||
                  (job.filename && /\.(flac|mp3|m4a|aac|opus|wav|ogg)$/i.test(job.filename)) ||
                  (job.code && job.code.startsWith('FLAC_') || job.code && job.code.startsWith('AUDIO_'));

  card.innerHTML = `
    <div class="job-header">
      <div class="job-header-top">
        <div class="job-badges-row">
          <span class="job-mode-tag ${isAudio ? 'audio' : 'video'}" id="job-mode-tag-${job.id}">${isAudio ? 'AUDIO' : 'VIDEO'}</span>
          <span class="job-code" id="job-code-${job.id}">${job.code || 'MEDIA'}</span>
        </div>
        <div class="job-header-right">
          <span class="job-status-badge status-${job.status}" id="job-badge-${job.id}">${job.status === 'completed' ? 'READY' : ((job.status === 'resolving_ddl' || job.status === 'resolving_olamovies') ? 'RESOLVING DDL' : job.status.toUpperCase())}</span>
          <button type="button" class="btn-job-remove" onclick="removeJob('${job.id}')" title="Remove task">&times;</button>
        </div>
      </div>
      <div class="job-title-group">
        <h4 class="job-title" id="job-title-${job.id}">${job.title}</h4>
        <div class="job-meta" id="job-meta-${job.id}">${job.filename} ${job.filesize ? `&bull; ${job.filesize}` : ''}</div>
        ${job.downloadFolder ? `<div class="job-storage-tag" style="font-size: 0.72rem; color: #34d399; margin-top: 3px; display: inline-flex; align-items: center; gap: 4px;" title="Assigned permanent storage folder: ${escapeHtml(job.downloadFolder)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg> <span style="font-family: monospace; word-break: break-all;">${escapeHtml(job.downloadFolder)}</span></div>` : ''}
      </div>
    </div>

    <!-- Progress Bar -->
    <div class="progress-container">
      <div class="progress-fill ${job.status === 'completed' ? 'completed' : ''}" id="job-prog-fill-${job.id}" style="width: ${job.progress.percent || 0}%"></div>
    </div>

    <!-- Stats Grid -->
    <div class="job-metrics-grid">
      <div class="metric-item">
        <span class="metric-label">Progress</span>
        <span class="metric-value" id="job-metric-pct-${job.id}">${(job.progress.percent || 0).toFixed(1)}%</span>
      </div>
      <div class="metric-item">
        <span class="metric-label">Speed</span>
        <span class="metric-value" id="job-metric-spd-${job.id}">${job.progress.speed || '0 MB/s'}</span>
      </div>
      <div class="metric-item">
        <span class="metric-label">ETA</span>
        <span class="metric-value" id="job-metric-eta-${job.id}">${job.progress.eta || '--:--'}</span>
      </div>
      <div class="metric-item">
        <span class="metric-label">Size / Streams</span>
        <span class="metric-value" id="job-metric-frag-${job.id}">${job.filesize || (job.progress.totalSize && job.progress.totalSize !== '0 MB' ? job.progress.totalSize : 'Calculating...')}</span>
      </div>
    </div>

    <!-- Actions & Drawer Toggle -->
    <div class="job-actions">
      <button class="btn-log-toggle" onclick="toggleJobLogs('${job.id}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
        <span>Toggle Logs</span>
      </button>
      <div class="job-controls" id="job-controls-${job.id}">
        ${renderJobControls(job)}
      </div>
    </div>

    <!-- Collapsible Log Drawer -->
    <div class="log-drawer" id="job-logs-${job.id}" style="display: none;">
      <div class="log-drawer-header">
        <div class="log-header-left">
          <span class="log-header-dot"></span>
          <span class="log-header-title">Process Logs</span>
          <span class="log-line-count" id="job-logs-count-${job.id}">${(job.logs && job.logs.length) || 0} lines</span>
        </div>
        <div class="log-header-actions">
          <button type="button" class="btn-log-action" onclick="scrollJobLogs('${job.id}', 'top')" title="Scroll to Beginning / Top">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg>
            <span>Top</span>
          </button>
          <button type="button" class="btn-log-action" onclick="scrollJobLogs('${job.id}', 'bottom')" title="Scroll to Latest / Bottom">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
            <span>Bottom</span>
          </button>
          <button type="button" class="btn-log-action" onclick="copyJobLogs('${job.id}')" title="Copy all logs">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span>Copy</span>
          </button>
        </div>
      </div>
      <div class="log-drawer-body" id="job-logs-body-${job.id}">
        <pre id="job-logs-content-${job.id}">${escapeHtml(job.logs ? job.logs.join('\n') : '')}</pre>
      </div>
    </div>
  `;

  return card;
}

function renderJobControls(job) {
  try {
    const safeJobId = escapeHtml(job.id);
    if (job.status === 'completed') {
      const isFlac = (job.filename && job.filename.toLowerCase().endsWith('.flac')) || (job.opts && job.opts.audioFormat === 'flac');
      const isElectron = window.electronAPI && window.electronAPI.isElectron;
      const downloadName = escapeHtml(job.filename || 'download');

      return `
        ${isElectron ? `
          <button class="btn btn-primary btn-sm" onclick="openFileInFolderByJobId('${safeJobId}')" title="Open in File Explorer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            <span>Folder</span>
          </button>
        ` : `
          <a href="${job.downloadUrl}" class="btn btn-primary btn-sm" download="${downloadName}" title="Save to Device">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            <span>Save to Device</span>
          </a>
        `}
        <button class="btn btn-secondary btn-sm" onclick="playMediaById('${safeJobId}')" title="${(isFlac || job.mode === 'audio' || job.mode === 'audiophile_flac') ? 'Listen Audio' : 'Watch Media'}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          <span>${(isFlac || job.mode === 'audio' || job.mode === 'audiophile_flac' || (job.opts && job.opts.isMusicTrack)) ? 'Listen' : 'Watch'}</span>
        </button>
        ${isFlac ? `
          <button class="btn btn-flac-verify btn-sm" onclick="inspectFlacFile('${safeJobId}')" title="Inspect Lossless FLAC Authenticity">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
            <span>Check FLAC</span>
          </button>
        ` : ''}
      `;
    } else if (job.status === 'cancelled' || job.status === 'failed') {
      return `
        <button class="btn btn-secondary btn-sm" onclick="removeJob('${safeJobId}')">Dismiss</button>
      `;
    } else if (job.status === 'paused') {
      return `
        <button class="btn btn-success btn-sm" onclick="resumeJob('${safeJobId}')" title="Resume download">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          <span>Resume</span>
        </button>
        <button class="btn btn-danger btn-sm" onclick="cancelJob('${safeJobId}')" title="Cancel download">Cancel</button>
      `;
    } else if (job.status === 'downloading' || job.status === 'queued' || job.status === 'resolving_ddl' || job.status === 'resolving_olamovies') {
      return `
        <button class="btn btn-warning btn-sm" onclick="pauseJob('${safeJobId}')" title="Pause download">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
          <span>Pause</span>
        </button>
        <button class="btn btn-danger btn-sm" onclick="cancelJob('${safeJobId}')" title="Cancel download">Cancel</button>
      `;
    }
  } catch (err) {
    console.error('Error rendering job controls:', err);
    return `
      <a href="${job.downloadUrl}" class="btn btn-primary btn-sm" download title="Save to Device">
        <span>Save to Device</span>
      </a>
      <button class="btn btn-secondary btn-sm" onclick="playMediaById('${job.id}')" title="Watch Media">
        <span>Watch</span>
      </button>
    `;
  }
  return '';
}

function formatEtaDisplay(eta, status) {
  if (status === 'completed') return 'Ready';
  if (status === 'paused') return 'Paused';
  if (status === 'resolving_ddl' || status === 'resolving_olamovies') return eta || 'Resolving DDL...';
  if (!eta || eta === '--' || eta === '0' || eta === '--:--') return '--:--';
  if (typeof eta === 'string' && /^\d+$/.test(eta.trim())) {
    const sec = parseInt(eta.trim(), 10);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return eta;
}

function updateJobCard(job) {
  if (window.allJobsMap) window.allJobsMap.set(job.id, job);
  const card = document.getElementById(`job-card-${job.id}`);
  if (!card) return;

  card.className = `job-card ${job.status}`;

  const badge = document.getElementById(`job-badge-${job.id}`);
  if (badge) {
    badge.className = `job-status-badge status-${job.status}`;
    badge.textContent = job.status === 'completed' ? 'READY' : ((job.status === 'resolving_ddl' || job.status === 'resolving_olamovies') ? 'RESOLVING DDL' : job.status.toUpperCase());
  }

  const titleEl = document.getElementById(`job-title-${job.id}`);
  if (titleEl && job.title && titleEl.textContent !== job.title) {
    titleEl.textContent = job.title;
    titleEl.title = job.title;
  }

  const metaEl = document.getElementById(`job-meta-${job.id}`);
  if (metaEl) {
    const metaText = `${job.filename || ''} ${job.filesize ? `• ${job.filesize}` : ''}`.trim();
    if (metaEl.textContent !== metaText) metaEl.textContent = metaText;
  }

  const codeEl = document.getElementById(`job-code-${job.id}`);
  if (codeEl && codeEl.textContent !== (job.code || 'MEDIA')) {
    codeEl.textContent = job.code || 'MEDIA';
  }

  const fill = document.getElementById(`job-prog-fill-${job.id}`);
  if (fill) {
    fill.style.width = `${job.progress.percent || 0}%`;
    if (job.status === 'completed') fill.classList.add('completed');
  }

  const pct = document.getElementById(`job-metric-pct-${job.id}`);
  if (pct) pct.textContent = `${(job.progress.percent || 0).toFixed(1)}%`;

  const spd = document.getElementById(`job-metric-spd-${job.id}`);
  if (spd) spd.textContent = job.progress.speed || '0 MB/s';

  const eta = document.getElementById(`job-metric-eta-${job.id}`);
  if (eta) eta.textContent = formatEtaDisplay(job.progress.eta, job.status);

  const frag = document.getElementById(`job-metric-frag-${job.id}`);
  if (frag) {
    const sz = job.filesize || (job.progress.totalSize && job.progress.totalSize !== '0 MB' ? job.progress.totalSize : null);
    frag.textContent = sz || (job.status === 'completed' ? 'Ready' : 'Calculating...');
  }

  // Update controls
  const controls = document.getElementById(`job-controls-${job.id}`);
  if (controls) {
    controls.innerHTML = renderJobControls(job);
  }

  const logsEl = document.getElementById(`job-logs-content-${job.id}`);
  const logCountEl = document.getElementById(`job-logs-count-${job.id}`);
  if (logsEl && Array.isArray(job.logs) && job.logs.length > 0) {
    const text = job.logs.join('\n');
    if (logsEl.textContent !== text) {
      const scrollBody = document.getElementById(`job-logs-body-${job.id}`) || document.getElementById(`job-logs-${job.id}`);
      const drawer = document.getElementById(`job-logs-${job.id}`);
      const isVisible = drawer && drawer.style.display !== 'none';

      // Smart auto-scroll: only snap to bottom if user is already near the bottom (within 50px)
      const isNearBottom = isVisible && scrollBody &&
        (scrollBody.scrollHeight - scrollBody.clientHeight - scrollBody.scrollTop < 50);
      const prevScrollTop = scrollBody ? scrollBody.scrollTop : 0;

      logsEl.textContent = text;
      if (logCountEl) {
        logCountEl.textContent = `${job.logs.length} line${job.logs.length === 1 ? '' : 's'}`;
      }

      if (isVisible && scrollBody) {
        if (isNearBottom) {
          scrollBody.scrollTop = scrollBody.scrollHeight;
        } else {
          scrollBody.scrollTop = prevScrollTop;
        }
      }
    }
  }

  // Retain download folder permanently so it never flickers or disappears during active downloading
  const incomingFolder = (job.downloadFolder && typeof job.downloadFolder === 'string' && job.downloadFolder.trim() !== '*')
    ? job.downloadFolder.trim()
    : '';
  if (incomingFolder) {
    card.dataset.downloadFolder = incomingFolder;
  }
  const effectiveFolder = card.dataset.downloadFolder || incomingFolder;

  const titleGroup = card.querySelector('.job-title-group');
  let storageTag = card.querySelector('.job-storage-tag');
  if (effectiveFolder) {
    if (!storageTag && titleGroup) {
      storageTag = document.createElement('div');
      storageTag.className = 'job-storage-tag';
      storageTag.style.cssText = 'font-size: 0.72rem; color: #34d399; margin-top: 3px; display: inline-flex; align-items: center; gap: 4px;';
      titleGroup.appendChild(storageTag);
    }
    if (storageTag) {
      storageTag.title = `Assigned permanent storage folder: ${effectiveFolder}`;
      storageTag.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg> <span style="font-family: monospace; word-break: break-all;">${escapeHtml(effectiveFolder)}</span>`;
    }
  } else if (storageTag && job.downloadFolder === null) {
    storageTag.remove();
  }
}

window.toggleJobLogs = async function(jobId) {
  const drawer = document.getElementById(`job-logs-${jobId}`);
  if (!drawer) return;
  const isOpening = drawer.style.display === 'none';
  drawer.style.display = isOpening ? 'flex' : 'none';
  if (isOpening) {
    const scrollBody = document.getElementById(`job-logs-body-${jobId}`) || drawer;
    const logsEl = document.getElementById(`job-logs-content-${jobId}`);
    const countEl = document.getElementById(`job-logs-count-${jobId}`);

    setTimeout(() => {
      if (scrollBody) scrollBody.scrollTop = scrollBody.scrollHeight;
    }, 40);

    try {
      const token = userAuthToken || localStorage.getItem('sakura_user_token') || sessionStorage.getItem('sakura_user_token') || localStorage.getItem('sakura_admin_token') || sessionStorage.getItem('sakura_admin_token') || '';
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
      const res = await fetch(`/api/jobs/${jobId}/logs`, { headers });
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.logs) && logsEl) {
          const isNearBottom = scrollBody ? (scrollBody.scrollHeight - scrollBody.clientHeight - scrollBody.scrollTop < 50) : true;
          const prevScrollTop = scrollBody ? scrollBody.scrollTop : 0;
          logsEl.textContent = data.logs.join('\n');
          if (countEl) countEl.textContent = `${data.logs.length} line${data.logs.length === 1 ? '' : 's'}`;
          if (scrollBody) {
            if (isNearBottom) scrollBody.scrollTop = scrollBody.scrollHeight;
            else scrollBody.scrollTop = prevScrollTop;
          }
        }
      }
    } catch (e) {}
  }
};

window.scrollJobLogs = function(jobId, direction) {
  const scrollBody = document.getElementById(`job-logs-body-${jobId}`) || document.getElementById(`job-logs-${jobId}`);
  if (!scrollBody) return;
  if (direction === 'top') {
    scrollBody.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    scrollBody.scrollTo({ top: scrollBody.scrollHeight, behavior: 'smooth' });
  }
};

window.copyJobLogs = function(jobId) {
  const content = document.getElementById(`job-logs-content-${jobId}`);
  if (!content || !content.textContent) {
    showToast('No logs available to copy', 'warning');
    return;
  }
  const text = content.textContent;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => showToast('Logs copied to clipboard!', 'success'))
      .catch(() => copyFallback(text));
  } else {
    copyFallback(text);
  }

  function copyFallback(str) {
    try {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Logs copied to clipboard!', 'success');
    } catch (e) {
      showToast('Failed to copy logs', 'error');
    }
  }
};

window.pauseJob = async function(jobId) {
  try {
    const card = document.getElementById(`job-card-${jobId}`);
    if (card) {
      card.className = 'job-card paused';
      const badge = document.getElementById(`job-badge-${jobId}`);
      if (badge) {
        badge.className = 'job-status-badge status-paused';
        badge.textContent = 'PAUSED';
      }
      const eta = document.getElementById(`job-metric-eta-${jobId}`);
      if (eta) eta.textContent = 'Paused';
      const spd = document.getElementById(`job-metric-spd-${jobId}`);
      if (spd) spd.textContent = '0 MB/s';
    }

    const res = await fetch(`/api/jobs/${jobId}/pause`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Failed to pause download', 'error');
    }
    loadJobs();
  } catch (err) {
    console.warn('Pause error:', err);
    showToast('Error pausing download', 'error');
  }
};

window.resumeJob = async function(jobId) {
  try {
    const card = document.getElementById(`job-card-${jobId}`);
    if (card) {
      card.className = 'job-card downloading';
      const badge = document.getElementById(`job-badge-${jobId}`);
      if (badge) {
        badge.className = 'job-status-badge status-downloading';
        badge.textContent = 'RESUMING...';
      }
    }

    const res = await fetch(`/api/jobs/${jobId}/resume`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Failed to resume download', 'error');
    } else {
      activeJobStatusTracker.set(jobId, 'downloading');
    }
    loadJobs();
  } catch (err) {
    console.warn('Resume error:', err);
    showToast('Error resuming download', 'error');
  }
};

window.pauseAllJobs = async function() {
  try {
    const res = await fetch('/api/jobs/pause-all', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast(`Paused ${data.pausedCount || 0} active download(s)`, 'info');
    }
    loadJobs();
  } catch (err) {
    console.warn('Pause all error:', err);
  }
};

window.resumeAllJobs = async function() {
  try {
    const res = await fetch('/api/jobs/resume-all', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast(`Resumed ${data.resumedCount || 0} download(s)`, 'success');
    }
    loadJobs();
  } catch (err) {
    console.warn('Resume all error:', err);
  }
};

window.cancelJob = async function(jobId) {
  try {
    // Immediately reflect cancelled state in UI
    const card = document.getElementById(`job-card-${jobId}`);
    if (card) {
      const badge = document.getElementById(`job-badge-${jobId}`);
      if (badge) {
        badge.className = 'job-status-badge status-cancelled';
        badge.textContent = 'CANCELLED';
      }
      const controls = document.getElementById(`job-controls-${jobId}`);
      if (controls) {
        controls.innerHTML = `<button class="btn btn-secondary btn-sm" onclick="removeJob('${jobId}')">Dismiss</button>`;
      }
    }

    if (activeEventSources.has(jobId)) {
      activeEventSources.get(jobId).close();
      activeEventSources.delete(jobId);
    }
    activeJobStatusTracker.delete(jobId);

    await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    loadJobs();
  } catch (err) {
    console.warn('Cancel error:', err);
  }
};

window.removeJob = async function(jobId) {
  try {
    if (window.allJobsMap) window.allJobsMap.delete(jobId);
    const card = document.getElementById(`job-card-${jobId}`);
    if (card) {
      card.style.opacity = '0';
      card.style.transform = 'translateY(-6px)';
      setTimeout(() => card.remove(), 200);
    }

    if (activeEventSources.has(jobId)) {
      activeEventSources.get(jobId).close();
      activeEventSources.delete(jobId);
    }
    activeJobStatusTracker.delete(jobId);

    sessionJobIds.delete(jobId);
    saveSessionJobs();

    await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
    loadJobs();
  } catch (err) {
    console.warn('Remove job error:', err);
  }
};

async function clearAllCompletedJobs() {
  try {
    document.querySelectorAll('.job-card.completed, .job-card.cancelled, .job-card.failed').forEach(el => {
      el.remove();
    });

    sessionJobIds.clear();
    saveSessionJobs();

    await fetch('/api/jobs', { method: 'DELETE' });
    loadJobs();
  } catch (err) {
    console.warn('Clear all error:', err);
  }
}

// 6. In-Browser Media Player
window.playMedia = function(streamUrl, title, downloadUrl, jobId = null) {
  if (!playerModal) return;

  const urlJobMatch = (streamUrl || '').match(/\/api\/stream\/([a-zA-Z0-9_\-]+)/);
  window.currentPlayingJobId = jobId || (urlJobMatch ? urlJobMatch[1] : (window.activeReadyJob?.id || null));

  // Immediately close any other open dialogs so they never cover or obscure the video player
  const movieReleasesModal = document.getElementById('movieReleasesModal');
  if (movieReleasesModal) movieReleasesModal.style.display = 'none';
  const musicFormatsModal = document.getElementById('musicFormatsModal');
  if (musicFormatsModal) musicFormatsModal.style.display = 'none';
  const readyModal = document.getElementById('readyModal');
  if (readyModal) readyModal.style.display = 'none';
  const adultPreviewModal = document.getElementById('adultPreviewModal');
  if (adultPreviewModal) adultPreviewModal.style.display = 'none';

  if (modalVideoTitle) modalVideoTitle.textContent = title || 'Media Player';
  if (modalFileInfo) modalFileInfo.textContent = title || '';
  if (html5Player) {
    html5Player.onerror = function() {
      console.warn('Playback error on:', streamUrl);
      showToast('Stream playback issue. Click "Save to Device" to download the file directly.', 'warning');
    };
    html5Player.src = streamUrl;
    html5Player.load();
    html5Player.play().catch(e => console.log('Autoplay deferred:', e));
  }
  if (modalDownloadDeviceBtn) modalDownloadDeviceBtn.href = downloadUrl || streamUrl;
  playerModal.style.display = 'flex';
};

window.playMediaById = function(jobId) {
  window.currentPlayingJobId = jobId;
  fetch('/api/jobs').then(r => r.json()).then(jobs => {
    const job = jobs.find(j => j.id === jobId);
    if (job) {
      playMedia(job.streamUrl, job.title, job.downloadUrl, jobId);
    } else {
      playMedia(`/api/stream/${jobId}`, 'Media Player', `/api/download-file/${jobId}`, jobId);
    }
  }).catch(() => {
    playMedia(`/api/stream/${jobId}`, 'Media Player', `/api/download-file/${jobId}`, jobId);
  });
};

function closePlayerModal() {
  if (html5Player) {
    html5Player.pause();
    html5Player.src = '';
  }
  if (playerModal) playerModal.style.display = 'none';
}

// ==========================================================================
// 7. Progressive Web App (PWA) & Web Share Target Handler
// ==========================================================================

let deferredInstallPrompt = null;
const btnInstallApp = document.getElementById('btnInstallApp');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('PWA ServiceWorker registered:', reg.scope))
      .catch(err => console.warn('PWA ServiceWorker registration failed:', err));
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const drawerDownloadsSection = document.getElementById('drawerSectionAppDownloads');
  if (drawerDownloadsSection) drawerDownloadsSection.style.display = 'block';
  const installButtons = document.querySelectorAll('.btn-install-app');
  installButtons.forEach(btn => {
    btn.style.display = 'flex';
    btn.onclick = async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const choiceResult = await deferredInstallPrompt.userChoice;
        if (choiceResult.outcome === 'accepted') {
          showToast('Universal Downloader installed successfully!', 'success');
        }
        deferredInstallPrompt = null;
        installButtons.forEach(b => b.style.display = 'none');
        if (drawerDownloadsSection) drawerDownloadsSection.style.display = 'none';
      }
    };
  });
});

// Handle incoming Web Share Target parameters (?url=... or ?text=...)
window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const sharedUrl = urlParams.get('url') || urlParams.get('text');
  if (sharedUrl && urlInput) {
    const matchedUrl = sharedUrl.match(/https?:\/\/[^\s]+/);
    if (matchedUrl) {
      urlInput.value = matchedUrl[0];
      showToast('Link imported from share sheet!', 'info');
      switchView('downloader');
      handleFetchInfo();
    }
  }
});

// ==========================================================================
// 8. Global Real-Time SSE (Server-Sent Events) Stream
// ==========================================================================

let sseEventSource = null;
let sseReconnectTimer = null;
let sseReconnectAttempts = 0;
let sseLastMessageTime = Date.now();
let sseDisconnectGraceTimer = null;

function updateSseStatus(status) {
  const badge = document.getElementById('liveSyncBadge');
  if (!badge) return;
  if (status === 'connected') {
    badge.style.background = 'rgba(16, 185, 129, 0.15)';
    badge.style.color = '#10b981';
    badge.innerHTML = '<span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;"></span><span>SYNC</span>';
    badge.title = 'Real-time Live Sync Connected';
  } else if (status === 'connecting') {
    badge.style.background = 'rgba(245, 158, 11, 0.15)';
    badge.style.color = '#f59e0b';
    badge.innerHTML = '<span style="width:5px;height:5px;border-radius:50%;background:#f59e0b;display:inline-block;"></span><span>CONNECTING...</span>';
    badge.title = 'Reconnecting to live sync...';
  } else {
    badge.style.background = 'rgba(239, 68, 68, 0.15)';
    badge.style.color = '#ef4444';
    badge.innerHTML = '<span style="width:5px;height:5px;border-radius:50%;background:#ef4444;display:inline-block;"></span><span>OFFLINE</span>';
    badge.title = 'Live sync offline';
  }
}

function restartJobsSSE() {
  if (sseEventSource) {
    try { sseEventSource.close(); } catch (e) {}
    sseEventSource = null;
  }
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  if (sseDisconnectGraceTimer) {
    clearTimeout(sseDisconnectGraceTimer);
    sseDisconnectGraceTimer = null;
  }
  sseReconnectAttempts = 0;
  initGlobalSSEStream();
}

function initGlobalSSEStream() {
  if (typeof EventSource === 'undefined') {
    // Fallback to interval polling
    setInterval(loadJobs, 2500);
    return;
  }

  function scheduleReconnect() {
    if (sseReconnectTimer) return;
    sseReconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.3, sseReconnectAttempts - 1), 6000);
    sseReconnectTimer = setTimeout(() => {
      sseReconnectTimer = null;
      connect();
    }, delay);
  }

  function markAlive() {
    sseLastMessageTime = Date.now();
    if (sseDisconnectGraceTimer) {
      clearTimeout(sseDisconnectGraceTimer);
      sseDisconnectGraceTimer = null;
    }
    updateSseStatus('connected');
  }

  function connect() {
    if (sseEventSource) {
      try { sseEventSource.close(); } catch (e) {}
      sseEventSource = null;
    }

    const token = userAuthToken || localStorage.getItem('sakura_user_token') || sessionStorage.getItem('sakura_user_token') || localStorage.getItem('sakura_admin_token') || sessionStorage.getItem('sakura_admin_token') || '';
    const cid = getClientId();
    const q = new URLSearchParams();
    if (token) q.set('token', token);
    if (cid) q.set('client_id', cid);
    const qs = q.toString() ? `?${q.toString()}` : '';

    try {
      sseEventSource = new EventSource(`/api/jobs/stream${qs}`);
    } catch (e) {
      console.warn('Failed to construct EventSource:', e);
      scheduleReconnect();
      return;
    }

    sseEventSource.onopen = () => {
      sseReconnectAttempts = 0;
      markAlive();
      // Silently refresh jobs list on connect/reconnect to guarantee queue accuracy
      loadJobs();
    };

    // Heartbeat ping from server (prevents idle proxy timeouts)
    sseEventSource.addEventListener('ping', () => {
      markAlive();
    });

    // Real-time Work In Progress / Maintenance state event
    sseEventSource.addEventListener('maintenance', (event) => {
      markAlive();
      if (!event.data || event.data.startsWith(':')) return;
      try {
        const data = JSON.parse(event.data);
        if (data && typeof data.active === 'boolean') {
          maintenanceState = {
            active: data.active,
            message: data.message || maintenanceState.message
          };
          applyMaintenanceUI();
        }
      } catch (e) {
        console.warn('SSE maintenance parse error:', e);
      }
    });

    // Full queue synchronization event
    sseEventSource.addEventListener('sync', (event) => {
      markAlive();
      if (!event.data || event.data.startsWith(':')) return;
      try {
        const jobs = JSON.parse(event.data);
        if (Array.isArray(jobs)) {
          renderJobsList(jobs);
        }
      } catch (e) {
        console.warn('SSE sync parse error:', e);
      }
    });

    // Default message fallback (sync payload)
    sseEventSource.onmessage = (event) => {
      markAlive();
      if (!event.data || event.data.startsWith(':')) return;
      try {
        const jobs = JSON.parse(event.data);
        if (Array.isArray(jobs)) {
          renderJobsList(jobs);
        }
      } catch (e) {}
    };

    // Real-time incremental job progress event
    sseEventSource.addEventListener('job_progress', (event) => {
      markAlive();
      if (!event.data || event.data.startsWith(':')) return;
      try {
        const job = JSON.parse(event.data);
        if (!job || !job.id) return;

        // Check completion transition
        const prevStatus = activeJobStatusTracker.get(job.id);
        if ((prevStatus === 'downloading' || prevStatus === 'queued' || prevStatus === 'resolving_ddl' || prevStatus === 'resolving_olamovies') && job.status === 'completed') {
          activeJobStatusTracker.delete(job.id);
          triggerDeviceDownload(job);
        } else if (job.status === 'downloading' || job.status === 'queued' || job.status === 'resolving_ddl' || job.status === 'resolving_olamovies') {
          activeJobStatusTracker.set(job.id, job.status);
        } else if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
          activeJobStatusTracker.delete(job.id);
        }

        let card = document.getElementById(`job-card-${job.id}`);
        if (!card) {
          if (emptyJobsState) emptyJobsState.style.display = 'none';
          card = createJobCardElement(job);
          if (jobsList) jobsList.prepend(card);
        }
        updateJobCard(job);

        // Update active count & header dot dynamically
        const activeElements = document.querySelectorAll('.job-card.downloading');
        const pausedElements = document.querySelectorAll('.job-card.paused');
        if (activeCountLabel) {
          let txt = `${activeElements.length} Active`;
          if (pausedElements.length > 0) txt += ` • ${pausedElements.length} Paused`;
          activeCountLabel.textContent = txt;
        }
        if (queueStatusIndicator) {
          const dot = queueStatusIndicator.querySelector('.status-dot');
          if (dot) {
            if (activeElements.length > 0) dot.classList.add('active');
            else dot.classList.remove('active');
          }
        }
      } catch (e) {
        console.warn('SSE job_progress parse error:', e);
      }
    });

    sseEventSource.onerror = () => {
      // If browser EventSource is automatically reconnecting natively (readyState === CONNECTING),
      // do not forcefully close it or show jarring OFFLINE badge immediately.
      // Use a graceful 4-second dampening window so momentary HTTP/2 frame renegotiations are invisible.
      if (!sseDisconnectGraceTimer) {
        sseDisconnectGraceTimer = setTimeout(() => {
          sseDisconnectGraceTimer = null;
          if (!sseEventSource || sseEventSource.readyState !== EventSource.OPEN) {
            updateSseStatus(sseEventSource && sseEventSource.readyState === EventSource.CONNECTING ? 'connecting' : 'offline');
          }
        }, 4000);
      }

      // If the browser permanently closed the connection, initiate reconnection
      if (sseEventSource && sseEventSource.readyState === EventSource.CLOSED) {
        try { sseEventSource.close(); } catch (e) {}
        sseEventSource = null;
        scheduleReconnect();
      }
    };
  }

  connect();

  // Re-establish connection automatically on tab visibility change or network recovery
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!sseEventSource || sseEventSource.readyState !== EventSource.OPEN) {
        restartJobsSSE();
      } else {
        loadJobs();
      }
    }
  });

  window.addEventListener('online', () => {
    restartJobsSSE();
  });

  // Watchdog timer to automatically recover from silent mobile zombie connections
  if (!window._sseWatchdogInterval) {
    window._sseWatchdogInterval = setInterval(() => {
      if (sseEventSource && sseEventSource.readyState === EventSource.OPEN) {
        // If more than 25 seconds have elapsed without any event or ping
        if (Date.now() - sseLastMessageTime > 25000) {
          console.warn('[SSE Watchdog] Stale stream detected (>25s), auto-recovering...');
          restartJobsSSE();
        }
      }
    }, 10000);
  }
}

// ==========================================================================
// 9. Windows Desktop & Downloads Folder Management
// ==========================================================================

async function openFileInFolder(targetPath) {
  try {
    if (window.electronAPI && window.electronAPI.openFolder) {
      window.electronAPI.openFolder(targetPath);
    } else {
      const res = await fetch('/api/config/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: targetPath })
      });
      const data = await res.json();
      if (!data.success && data.error) {
        showToast(data.error, 'error');
      }
    }
  } catch (err) {
    showToast(`Cannot open folder: ${err.message}`, 'error');
  }
}

function openFileInFolderByJobId(jobId) {
  const job = window.allJobsMap?.get(jobId);
  if (job && job.filePath) {
    openFileInFolder(job.filePath);
  } else {
    openFileInFolder();
  }
}

async function initDownloadFolderUI() {
  const sidebarFolderCard = document.getElementById('sidebarFolderCard') || document.getElementById('storagePathDisplay');
  const isElectron = !!(window.electronAPI && window.electronAPI.isElectron);

  if (!isElectron) {
    if (sidebarFolderCard) sidebarFolderCard.style.display = 'none';
    const legacyStorage = document.getElementById('storagePathDisplay');
    if (legacyStorage) legacyStorage.style.display = 'none';
    return;
  }

  if (sidebarFolderCard) {
    sidebarFolderCard.style.display = 'flex';
  }

  const folderPathText = document.getElementById('folderPathText');
  const btnChangeFolder = document.getElementById('btnChangeFolder');
  const folderPathDisplay = document.getElementById('folderPathDisplay');

  function updateFolderDisplay(dir) {
    if (folderPathText) {
      // Shorten path for display
      folderPathText.textContent = dir || 'Downloads\\JAV-Downloader';
      folderPathText.title = dir || '';
    }
  }

  // Load current download folder from server
  try {
    const res = await fetch('/api/config/download-dir');
    if (res.ok) {
      const data = await res.json();
      if (data.downloadDir) updateFolderDisplay(data.downloadDir);
    }
  } catch (e) {}

  if (btnChangeFolder) {
    btnChangeFolder.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (window.electronAPI && window.electronAPI.selectDownloadDir) {
        const chosen = await window.electronAPI.selectDownloadDir();
        if (chosen) {
          updateFolderDisplay(chosen);
          showToast(`Downloads destination updated!`, 'success');
        }
      } else {
        const current = folderPathText ? folderPathText.textContent : '';
        const input = prompt('Enter new destination folder path on server:', current);
        if (input && input.trim()) {
          try {
            const res = await fetch('/api/config/download-dir', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ downloadDir: input.trim() })
            });
            const data = await res.json();
            if (data.success) {
              updateFolderDisplay(data.downloadDir);
              showToast('Downloads folder updated!', 'success');
            } else {
              showToast(data.error || 'Failed to update folder', 'error');
            }
          } catch (err) {
            showToast(err.message, 'error');
          }
        }
      }
    });
  }

  if (folderPathDisplay) {
    folderPathDisplay.addEventListener('click', () => {
      openFileInFolder();
    });
  }
}

initDownloadFolderUI();

// ==========================================================================
// Inbuilt FLAC Checker Controller
// ==========================================================================

function initFlacChecker() {
  const dropZone = document.getElementById('flacDropZone');
  const fileInput = document.getElementById('flacFileInput');
  const btnBrowse = document.getElementById('btnBrowseFlac');
  const selectRecent = document.getElementById('selectRecentFlac');
  const btnRefreshRecent = document.getElementById('btnRefreshRecentFlac');
  const btnToggleMeta = document.getElementById('btnToggleMetaAccordion');
  const metaContent = document.getElementById('metaAccordionContent');

  if (!dropZone) return;

  // Browse File (Electron native dialog or standard HTML input)
  if (btnBrowse) {
    btnBrowse.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (window.electronAPI && window.electronAPI.selectFlacFile) {
        try {
          const pickedPath = await window.electronAPI.selectFlacFile();
          if (pickedPath) {
            runFlacCheck({ filePath: pickedPath });
          }
        } catch (err) {
          if (fileInput) fileInput.click();
        }
      } else if (fileInput) {
        fileInput.click();
      }
    });
  }

  // Click on dropzone to browse
  dropZone.addEventListener('click', (e) => {
    if (e.target !== selectRecent && !e.target.closest('.select-recent-flac')) {
      if (btnBrowse) btnBrowse.click();
    }
  });

  // Drag & drop handlers
  ['dragenter', 'dragover'].forEach(name => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-over');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleFileSelected(files[0]);
    }
  });

  // HTML file input change
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        handleFileSelected(fileInput.files[0]);
      }
    });
  }

  function handleFileSelected(file) {
    // If running in Electron with local file path available
    if (file.path) {
      runFlacCheck({ filePath: file.path });
      return;
    }

    // Read as Base64 for web browser usage
    const reader = new FileReader();
    reader.onload = () => {
      runFlacCheck({
        fileBase64: reader.result,
        fileName: file.name
      });
    };
    reader.readAsDataURL(file);
  }

  // Select Recent Downloads dropdown
  if (selectRecent) {
    selectRecent.addEventListener('change', () => {
      const val = selectRecent.value;
      if (val) {
        runFlacCheck({ filePath: val });
      }
    });
  }

  // Refresh recent downloads button
  if (btnRefreshRecent) {
    btnRefreshRecent.addEventListener('click', () => {
      loadRecentFlacFiles();
      showToast('Scanned recent FLAC downloads', 'info');
    });
  }

  // Clear / Purge Recent Downloads button
  const btnClearRecent = document.getElementById('btnClearRecentFlac');
  if (btnClearRecent) {
    btnClearRecent.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to purge all downloaded FLAC files from server storage?')) return;
      btnClearRecent.disabled = true;
      try {
        const res = await fetch('/api/flac-check/clear-recent', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          showToast(`Purged ${data.deletedCount} FLAC files (${data.freedMB} MB freed)`, 'success');
          loadRecentFlacFiles();
          const results = document.getElementById('flacResultsContainer');
          if (results) results.style.display = 'none';
        } else {
          showToast(data.error || 'Failed to clear files', 'error');
        }
      } catch (err) {
        showToast('Clear error: ' + err.message, 'error');
      } finally {
        btnClearRecent.disabled = false;
      }
    });
  }

  // Vorbis Metadata accordion toggle
  if (btnToggleMeta && metaContent) {
    btnToggleMeta.addEventListener('click', () => {
      const isHidden = metaContent.style.display === 'none';
      metaContent.style.display = isHidden ? 'block' : 'none';
    });
  }

  loadRecentFlacFiles();
}

async function loadRecentFlacFiles() {
  const selectRecent = document.getElementById('selectRecentFlac');
  if (!selectRecent) return;

  try {
    const res = await fetch('/api/flac-check/recent');
    if (!res.ok) return;
    const list = await res.json();
    selectRecent.innerHTML = '<option value="">-- Inspect Recent Downloaded FLAC --</option>';
    list.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.filePath;
      opt.textContent = `${item.filename} (${item.sizeMB} MB)`;
      selectRecent.appendChild(opt);
    });
  } catch (e) {}
}

async function inspectFlacFile(jobId, directPath) {
  switchView('flac-checker', true);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const job = window.allJobsMap?.get(jobId);
  const path = directPath || job?.filePath;
  if (path) {
    runFlacCheck({ filePath: path, jobId: jobId });
  } else if (jobId) {
    runFlacCheck({ jobId: jobId });
  }
}

async function runFlacCheck(payload) {
  const loading = document.getElementById('flacLoadingState');
  const results = document.getElementById('flacResultsContainer');
  if (loading) loading.style.display = 'flex';
  if (results) results.style.display = 'none';

  try {
    const res = await fetch('/api/flac-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to analyze FLAC audio');
    }

    const report = await res.json();
    renderFlacReport(report);
  } catch (err) {
    showToast(`FLAC Check: ${err.message}`, 'error');
  } finally {
    if (loading) loading.style.display = 'none';
  }
}

function renderFlacReport(report) {
  const results = document.getElementById('flacResultsContainer');
  if (!results) return;

  // 1. Verdict Banner
  const banner = document.getElementById('flacVerdictBanner');
  const badge = document.getElementById('verdictBadge');
  const score = document.getElementById('verdictScore');
  const title = document.getElementById('verdictTitle');
  const desc = document.getElementById('verdictDesc');
  const fileName = document.getElementById('verdictFileName');
  const iconWrap = document.getElementById('verdictIconWrap');

  banner.className = `flac-verdict-banner verdict-${report.verdictBadge || 'success'}`;
  badge.textContent = report.verdict === 'UPSCALED_HIRES' ? 'UPSCALED HI-RES' : (report.verdictBadge === 'success' ? '100% GENUINE' : (report.verdictBadge === 'warning' ? 'SUSPICIOUS' : 'FAKE FLAC'));
  score.textContent = `Score: ${report.authenticityScore || 0}/100`;
  title.textContent = report.verdictTitle || 'Analysis Complete';
  fileName.textContent = report.filename || 'Audio File';

  if (iconWrap) {
    iconWrap.innerHTML = report.verdictBadge === 'success'
      ? '<span class="verdict-symbol">✓</span>'
      : (report.verdictBadge === 'warning' ? '<span class="verdict-symbol">!</span>' : '<span class="verdict-symbol">✕</span>');
  }

  if (desc) {
    if (report.warnings && report.warnings.length > 0) {
      desc.textContent = report.warnings.join(' • ');
    } else if (report.details && report.details.length > 0) {
      desc.textContent = report.details.join(' • ');
    } else {
      desc.textContent = 'Audio frequency spectrum matches true uncompressed studio PCM standards.';
    }
  }

  // 2. Specs
  const srEl = document.getElementById('specSampleRate');
  const nyqEl = document.getElementById('specNyquist');
  const bitsEl = document.getElementById('specBitDepth');
  const bitrEl = document.getElementById('specBitrate');
  const chanEl = document.getElementById('specChannels');
  const cutEl = document.getElementById('specCutoff');
  const cutHint = document.getElementById('specCutoffHint');
  const sizeEl = document.getElementById('specSize');
  const durEl = document.getElementById('specDuration');
  const md5El = document.getElementById('specMd5');

  if (srEl) srEl.textContent = `${(report.sampleRate / 1000).toFixed(1)} kHz`;
  if (nyqEl) nyqEl.textContent = `Nyquist Limit: ${(report.nyquistLimitHz / 1000).toFixed(1)} kHz`;
  if (bitsEl) bitsEl.textContent = `${report.bitsPerSample}-bit ${report.bitsPerSample >= 24 ? 'Studio PCM' : 'CDDA PCM'}`;
  if (bitrEl) bitrEl.textContent = `${report.bitrateKbps || 0} kbps`;
  if (chanEl) chanEl.textContent = report.channelLayout || 'Stereo';

  if (cutEl) {
    if (report.cutoffFrequencyHz) {
      cutEl.textContent = `Cutoff at ${(report.cutoffFrequencyHz / 1000).toFixed(1)} kHz`;
      if (report.verdict === 'UPSCALED_HIRES' || report.cutoffFrequencyHz >= 22000) {
        cutEl.style.color = '#fbbf24';
        if (cutHint) cutHint.textContent = '44.1 kHz Studio CDDA Limit (Official 48kHz Film Resample)';
      } else {
        cutEl.style.color = 'hsl(0, 85%, 65%)';
        if (cutHint) cutHint.textContent = 'Lossy compression cutoff detected';
      }
    } else {
      cutEl.textContent = 'None (Full Bandwidth)';
      cutEl.style.color = 'var(--text-primary)';
      if (cutHint) cutHint.textContent = 'Natural acoustic harmonics intact';
    }
  }

  if (sizeEl) sizeEl.textContent = `${report.fileSizeMB || 0} MB`;
  if (durEl) {
    const s = Math.floor(report.durationSec || 0);
    const m = Math.floor(s / 60);
    durEl.textContent = `Duration: ${m}:${(s % 60).toString().padStart(2, '0')}`;
  }
  if (md5El) {
    md5El.textContent = report.md5Signature ? 'Verified ✓' : 'OK';
  }

  // 3. Multi-Band Energy Bars
  const barsList = document.getElementById('energyBarsList');
  if (barsList && report.energyAnalysis) {
    barsList.innerHTML = '';
    const bands = [
      { key: 'above_16000hz', label: '16.0 kHz (128k MP3 Cutoff)', threshold: -80 },
      { key: 'above_18500hz', label: '18.5 kHz (192k MP3 Cutoff)', threshold: -80 },
      { key: 'above_20000hz', label: '20.0 kHz (Opus & 320k Cutoff)', threshold: -75 },
      { key: 'above_22000hz', label: '22.0 kHz (CDDA Nyquist Edge)', threshold: -75 },
      { key: 'above_24000hz', label: '24.0 kHz (Hi-Res Studio Master)', threshold: -75 }
    ];

    bands.forEach(b => {
      const data = report.energyAnalysis[b.key];
      if (!data) return;

      const mean = data.mean_db !== null ? data.mean_db : -91.0;
      const isActive = data.active && mean > b.threshold;
      
      const pct = Math.max(5, Math.min(100, ((mean + 90) / 80) * 100));

      let valText = '';
      let valColor = '';
      let fillClass = '';

      if (isActive) {
        valText = `${mean.toFixed(1)} dB (Active)`;
        valColor = 'hsl(158, 85%, 48%)';
        fillClass = 'active';
      } else if (report.verdict === 'UPSCALED_HIRES' && b.key === 'above_22000hz') {
        valText = `${mean.toFixed(1)} dB (CDDA Cutoff)`;
        valColor = '#fbbf24';
        fillClass = 'cdda-warn';
      } else if (mean > -88) {
        valText = `${mean.toFixed(1)} dB (Cutoff / Inactive)`;
        valColor = 'hsl(0, 85%, 65%)';
        fillClass = 'dead';
      } else {
        valText = 'Silence (Cutoff)';
        valColor = 'hsl(0, 85%, 65%)';
        fillClass = 'dead';
      }

      const row = document.createElement('div');
      row.className = 'energy-bar-row';
      row.innerHTML = `
        <div class="energy-bar-header">
          <span class="energy-band-label">${b.label}</span>
          <span class="energy-band-val" style="color: ${valColor}">
            ${valText}
          </span>
        </div>
        <div class="energy-track">
          <div class="energy-fill ${fillClass}" style="width: ${pct}%"></div>
        </div>
      `;
      barsList.appendChild(row);
    });
  }

  // 4. Spectrogram Image
  const specBox = document.getElementById('flacSpectrogramBox');
  const specImg = document.getElementById('spectrogramImg');
  const aiVerdictCard = document.getElementById('flacAiVerdictCard');
  if (aiVerdictCard) aiVerdictCard.style.display = 'none';

  if (report.spectrogram && specImg) {
    window.currentFlacSpectrogram = report.spectrogram;
    window.currentFlacMetadata = report;
    specImg.src = report.spectrogram;
    specBox.style.display = 'block';
  } else if (specBox) {
    window.currentFlacSpectrogram = null;
    window.currentFlacMetadata = null;
    specBox.style.display = 'none';
  }

  // 5. Metadata Accordion
  const metaRaw = document.getElementById('flacMetaRaw');
  if (metaRaw) {
    const rawObj = {
      stream: {
        sampleRate: `${report.sampleRate} Hz`,
        bitDepth: `${report.bitsPerSample}-bit`,
        bitrate: `${report.bitrateKbps} kbps`,
        channels: report.channels,
        md5: report.md5Signature
      },
      tags: report.tags || {}
    };
    metaRaw.textContent = JSON.stringify(rawObj, null, 2);
  }

  results.style.display = 'flex';
  results.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ==========================================================================
// Adult Search & JAV Hub Controller
// ==========================================================================

let currentAdultQuery = '';
let currentAdultSource = 'all'; // 'all', 'tubes', 'jav'
let currentAdultDuration = 'full'; // 'full' (10m+), 'extended' (20m+), 'all'
let currentAdultPage = 1;
let currentAdultResults = [];

function initAdultSearch() {
  const form = document.getElementById('adultSearchForm');
  const input = document.getElementById('adultSearchInput');
  const clearBtn = document.getElementById('btnClearAdultSearch');
  const submitBtn = document.getElementById('btnAdultSearchSubmit');
  const sourceTabs = document.getElementById('adultSourceTabs');
  const durationFilters = document.getElementById('adultDurationFilters');
  const quickTags = document.getElementById('adultQuickTags');
  const prevPageBtn = document.getElementById('btnAdultPrevPage');
  const nextPageBtn = document.getElementById('btnAdultNextPage');
  const closePreviewBtn = document.getElementById('closeAdultModalBtn');
  const previewModal = document.getElementById('adultPreviewModal');
  const modalPlayer = document.getElementById('adultModalPlayer');

  if (!input) return;

  // Input typing and clear button
  input.addEventListener('input', () => {
    if (clearBtn) clearBtn.style.display = input.value.trim() ? 'block' : 'none';
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.style.display = 'none';
      input.focus();
    });
  }

  // Submit search
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      currentAdultQuery = q;
      currentAdultPage = 1;
      executeAdultSearch();
    });
  }

  if (submitBtn) {
    submitBtn.addEventListener('click', () => {
      const q = input.value.trim();
      if (!q) return;
      currentAdultQuery = q;
      currentAdultPage = 1;
      executeAdultSearch();
    });
  }

  // Source tabs
  if (sourceTabs) {
    sourceTabs.querySelectorAll('.source-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        sourceTabs.querySelectorAll('.source-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentAdultSource = tab.getAttribute('data-type') || 'all';
        if (currentAdultQuery) {
          currentAdultPage = 1;
          executeAdultSearch();
        }
      });
    });
  }

  // Duration filters (Full 10m+ vs Extended 20m+ vs All)
  if (durationFilters) {
    durationFilters.querySelectorAll('.duration-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        durationFilters.querySelectorAll('.duration-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        currentAdultDuration = pill.getAttribute('data-duration') || 'full';
        if (currentAdultQuery) {
          currentAdultPage = 1;
          executeAdultSearch();
        }
      });
    });
  }

  // Quick tag chips
  if (quickTags) {
    quickTags.querySelectorAll('.quick-tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const q = chip.getAttribute('data-query');
        if (q) {
          input.value = q;
          if (clearBtn) clearBtn.style.display = 'block';
          currentAdultQuery = q;
          currentAdultPage = 1;
          executeAdultSearch();
        }
      });
    });
  }

  // Pagination
  if (prevPageBtn) {
    prevPageBtn.addEventListener('click', () => {
      if (currentAdultPage > 1) {
        currentAdultPage--;
        executeAdultSearch();
      }
    });
  }

  if (nextPageBtn) {
    nextPageBtn.addEventListener('click', () => {
      currentAdultPage++;
      executeAdultSearch();
    });
  }

  // Modal preview close
  if (closePreviewBtn && previewModal) {
    closePreviewBtn.addEventListener('click', () => {
      previewModal.style.display = 'none';
      if (modalPlayer) {
        modalPlayer.pause();
        modalPlayer.src = '';
      }
    });
    previewModal.addEventListener('click', (e) => {
      if (e.target === previewModal) {
        previewModal.style.display = 'none';
        if (modalPlayer) {
          modalPlayer.pause();
          modalPlayer.src = '';
        }
      }
    });
  }
}

async function executeAdultSearch() {
  const loading = document.getElementById('adultLoadingState');
  const emptyState = document.getElementById('adultEmptyState');
  const resultsGrid = document.getElementById('adultResultsGrid');
  const paginationBar = document.getElementById('adultPaginationBar');
  const pageIndicator = document.getElementById('adultPageIndicator');
  const prevBtn = document.getElementById('btnAdultPrevPage');
  const nextBtn = document.getElementById('btnAdultNextPage');

  if (!currentAdultQuery) return;

  if (loading) loading.style.display = 'flex';
  if (emptyState) emptyState.style.display = 'none';
  if (resultsGrid) resultsGrid.style.display = 'none';
  if (paginationBar) paginationBar.style.display = 'none';

  try {
    const res = await fetch(`/api/adult/search?q=${encodeURIComponent(currentAdultQuery)}&type=${currentAdultSource}&duration=${currentAdultDuration}&page=${currentAdultPage}`);
    if (!res.ok) {
      throw new Error(`Server returned HTTP ${res.status}`);
    }
    const data = await res.json();
    currentAdultResults = data.results || [];

    if (currentAdultResults.length === 0) {
      if (emptyState) {
        emptyState.innerHTML = `
          <div class="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg></div>
          <h3>No Results Found for "${escapeHtml(currentAdultQuery)}"</h3>
          <p>Try switching Duration to "All Lengths", or search by JAV product code (e.g. SSIS, IPX, MIDV), actress name, or broader keywords.</p>
        `;
        emptyState.style.display = 'flex';
      }
    } else {
      renderAdultResults(currentAdultResults);
      if (resultsGrid) resultsGrid.style.display = 'grid';
      if (paginationBar) {
        paginationBar.style.display = 'flex';
        if (pageIndicator) pageIndicator.textContent = `Page ${currentAdultPage}`;
        if (prevBtn) prevBtn.disabled = currentAdultPage <= 1;
        if (nextBtn) nextBtn.disabled = currentAdultResults.length < 10;
      }
    }
  } catch (err) {
    showToast(`Search failed: ${err.message}`, 'error');
    if (emptyState) {
      emptyState.innerHTML = `
        <div class="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg></div>
        <h3>Search Encountered an Error</h3>
        <p>${escapeHtml(err.message)}</p>
      `;
      emptyState.style.display = 'flex';
    }
  } finally {
    if (loading) loading.style.display = 'none';
  }
}

function renderAdultResults(items) {
  const grid = document.getElementById('adultResultsGrid');
  if (!grid) return;

  grid.innerHTML = items.map((item, idx) => {
    const isJav = item.type === 'jav';
    const isTeaser = item.isTeaser;

    let sourceLabel = 'Tube Stream';
    let badgeClass = 'badge-tube';
    if (isJav) {
      sourceLabel = 'JAV Full Master';
      badgeClass = 'badge-jav';
    } else if (item.provider === 'pornhub') {
      sourceLabel = 'Pornhub HD';
      badgeClass = 'badge-pornhub';
    } else if (item.provider === 'xvideos') {
      sourceLabel = 'XVideos HD';
      badgeClass = 'badge-xvideos';
    } else if (item.provider === 'eporner') {
      sourceLabel = 'Eporner 4K';
      badgeClass = 'badge-eporner';
    } else if (item.provider === 'redtube') {
      sourceLabel = 'RedTube HD';
      badgeClass = 'badge-redtube';
    } else if (item.provider === 'hqporner') {
      sourceLabel = 'HQPorner 4K';
      badgeClass = 'badge-hqporner';
    }

    const metaTag = isJav 
      ? `${item.size || 'Full Movie'} • ${item.seeders || 0} Seeds`
      : `${item.duration || 'Full Video'} • ${item.quality || 'HD'}`;

    const defaultImg = isJav
      ? 'https://pics.dmm.co.jp/mono/movie/adult/default/defaultpl.jpg'
      : 'data:image/svg+xml;charset=UTF-8,%3Csvg%20width%3D%22400%22%20height%3D%22260%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%23111%22%2F%3E%3Ctext%20x%3D%2250%25%22%20y%3D%2250%25%22%20fill%3D%22%23555%22%20font-size%3D%2224%22%20text-anchor%3D%22middle%22%20dominant-baseline%3D%22middle%22%3ENo%20Cover%3C%2Ftext%3E%3C%2Fsvg%3E';

    let thumbUrl = item.thumb || defaultImg;
    if (thumbUrl && thumbUrl.startsWith('http') && !thumbUrl.startsWith('/api/proxy-image')) {
      thumbUrl = `/api/proxy-image?url=${encodeURIComponent(thumbUrl)}`;
    }

    return `
      <div class="adult-card ${isTeaser ? 'card-teaser' : ''}" data-index="${idx}">
        <div class="adult-card-media">
          <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(item.title)}" class="adult-card-thumb" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null; this.src='${defaultImg}'" />
          ${item.previewVideo ? `
            <video class="adult-card-hover-video" muted loop playsinline preload="none" data-src="${escapeHtml(item.previewVideo)}"></video>
          ` : ''}
          <div class="adult-card-badges">
            <span class="adult-badge ${badgeClass}">${sourceLabel}</span>
            ${item.code ? `<span class="adult-badge badge-code">${escapeHtml(item.code)}</span>` : ''}
            ${isTeaser ? `<span class="adult-badge badge-teaser">Short Clip</span>` : ''}
            ${isJav ? `<span class="adult-badge badge-full-movie">Full Movie</span>` : ''}
          </div>
          <span class="adult-card-meta-pill">${escapeHtml(metaTag)}</span>
          ${item.previewVideo ? `
            <button type="button" class="btn-hover-preview-play" title="Click to watch preview trailer" onclick="openAdultPreview(${idx})">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            </button>
          ` : ''}
        </div>
        <div class="adult-card-body">
          <h4 class="adult-card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h4>
          <div class="adult-card-actions">
            <button type="button" class="btn btn-download btn-sm adult-dl-btn" id="btnAdultDl_${idx}" onclick="dispatchAdultDownload(${idx})">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              <span>1-Click Download Full</span>
            </button>
            ${item.previewVideo ? `
              <button type="button" class="btn btn-secondary btn-sm adult-preview-btn" onclick="openAdultPreview(${idx})">
                <span>Preview</span>
              </button>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Setup hover video preview on desktop
  grid.querySelectorAll('.adult-card').forEach(card => {
    const video = card.querySelector('.adult-card-hover-video');
    if (!video) return;
    let hoverTimer = null;

    card.addEventListener('mouseenter', () => {
      hoverTimer = setTimeout(() => {
        if (!video.src && video.dataset.src) {
          video.src = video.dataset.src;
        }
        video.play().catch(() => {});
        video.style.opacity = '1';
      }, 250);
    });

    card.addEventListener('mouseleave', () => {
      if (hoverTimer) clearTimeout(hoverTimer);
      video.pause();
      video.style.opacity = '0';
    });
  });
}

window.openAdultPreview = function(idx) {
  const item = currentAdultResults[idx];
  if (!item) return;

  const modal = document.getElementById('adultPreviewModal');
  const player = document.getElementById('adultModalPlayer');
  const title = document.getElementById('adultModalTitle');
  const meta = document.getElementById('adultModalMeta');
  const dlBtn = document.getElementById('btnAdultModalDownload');
  const banner = document.getElementById('adultModalBanner');
  const dlText = document.getElementById('adultModalDownloadText');

  if (!modal || !player) return;

  title.textContent = item.title;
  const isJav = item.type === 'jav';
  meta.innerHTML = `${escapeHtml((item.provider || '').toUpperCase())} • ${escapeHtml(item.duration || item.size || 'HD')} • ${escapeHtml(item.quality || (isJav ? 'Studio Master' : 'HD'))}`;

  if (dlText) {
    dlText.textContent = isJav
      ? `Download Full JAV Movie (${item.size || '1080p'})`
      : `Download Full Video (${item.quality || '1080p'})`;
  }

  if (item.previewVideo) {
    player.src = item.previewVideo;
    player.style.display = 'block';
    player.play().catch(() => {});
    if (banner) banner.style.display = 'block';
  } else {
    player.pause();
    player.src = '';
    player.style.display = 'none';
    if (banner) banner.style.display = 'none';
  }

  modal.style.display = 'flex';

  if (dlBtn) {
    dlBtn.onclick = () => {
      dispatchAdultDownload(idx);
      modal.style.display = 'none';
      player.pause();
      player.src = '';
    };
  }
};

window.dispatchAdultDownload = async function(idx) {
  const item = currentAdultResults[idx];
  if (!item) return;

  const btn = document.getElementById(`btnAdultDl_${idx}`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span>Starting Full Download...</span>`;
  }

  try {
    const res = await fetch('/api/adult/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Added to Active Queue: ${item.title.substring(0, 30)}...`, 'success');
      if (btn) {
        btn.innerHTML = `<span>✓ Enqueued</span>`;
        btn.classList.add('btn-success');
      }
    } else {
      showToast(data.error || 'Failed to dispatch download', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<span>1-Click Download Full</span>`;
      }
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<span>1-Click Download Full</span>`;
    }
  }
};

// ==========================================================================
// Adult & JAV Hub Navigation Visibility (Direct Menu Access for Members)
// ==========================================================================

function isAdultHubUnlocked() {
  return canAccess('adult');
}

function updateAdultHubVisibility(visible) {
  const isAllowed = visible !== undefined ? visible : canAccess('adult');
  const sidebarBtn = document.getElementById('navAdultSearch');
  const bottomBtn = document.getElementById('bottomNavAdultSearch');
  const drawerBtn = document.getElementById('drawerNavAdultSearch');
  if (sidebarBtn) {
    sidebarBtn.style.display = isAllowed ? 'flex' : 'none';
  }
  if (bottomBtn) {
    bottomBtn.style.display = isAllowed ? 'flex' : 'none';
  }
  if (drawerBtn) {
    drawerBtn.style.display = isAllowed ? 'flex' : 'none';
  }
}

function setupVersionTapEasterEgg() {
  // Easter egg tap gesture disabled: access-gained users now see Adult & JAV Hub directly in the navigation menu.
  try {
    localStorage.removeItem('adult_hub_unlocked');
  } catch (e) {}
}

// ==========================================================================
// MOVIE & TV SHOW HUB CONTROLLER (Native Direct DDL & Torrents Dual-Pipeline)
// ==========================================================================

let currentMovieResults = [];
let currentMoviePage = 1;
let currentMovieQuery = '';
let currentMovieSource = 'ddl';
let currentMovieQuality = 'all';

async function syncMovieSourceTabs() {
  try {
    const res = await fetch('/api/movie-sources');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.success || !data.sources) return;

    const sources = data.sources; // { ddl: bool, yts: bool, torrents: bool }
    const sourceTabs = document.getElementById('movieSourceTabs');
    if (!sourceTabs) return;

    const tabs = sourceTabs.querySelectorAll('.movie-tab');
    let hasActiveSelected = false;

    tabs.forEach(tab => {
      const src = tab.dataset.source;
      const isEnabled = !!sources[src];

      if (isEnabled) {
        tab.disabled = false;
        tab.classList.remove('disabled-source');
        tab.removeAttribute('style');
        if (src === 'ddl') {
          tab.textContent = 'Direct DDL (Fast Cloud)';
          tab.title = 'Native Direct DDL Cloud Releases';
        } else if (src === 'yts') {
          tab.textContent = 'YTS';
          tab.title = 'YTS High-Res Torrents';
        } else if (src === 'torrents') {
          tab.textContent = 'Torrents';
          tab.title = 'BitTorrent / Apibay P2P Swarm';
        }
      } else {
        tab.disabled = true;
        tab.classList.add('disabled-source');
        tab.style.opacity = '0.45';
        tab.style.cursor = 'not-allowed';
        tab.title = 'Disabled in Admin Settings';
        if (src === 'ddl') tab.textContent = 'Direct DDL (Disabled)';
        else if (src === 'yts') tab.textContent = 'YTS (Disabled)';
        else if (src === 'torrents') tab.textContent = 'Torrents (Disabled)';
        tab.classList.remove('active');
      }

      if (src === currentMovieSource && isEnabled) {
        tab.classList.add('active');
        hasActiveSelected = true;
      }
    });

    // If currently selected source is disabled, pick first enabled source
    if (!hasActiveSelected) {
      const firstEnabledTab = sourceTabs.querySelector('.movie-tab:not([disabled])');
      if (firstEnabledTab) {
        tabs.forEach(t => t.classList.remove('active'));
        firstEnabledTab.classList.add('active');
        currentMovieSource = firstEnabledTab.dataset.source;
      } else {
        currentMovieSource = 'none';
      }
    }

    // Update search placeholder
    const searchInput = document.getElementById('movieSearchInput');
    if (searchInput) {
      if (currentMovieSource === 'ddl') {
        searchInput.placeholder = 'Search movies, anime, or TV shows (e.g. A Silent Voice, Oppenheimer, Deadpool)...';
      } else if (currentMovieSource === 'yts') {
        searchInput.placeholder = 'Search high-res movies on YTS (e.g. Oppenheimer, Interstellar, Dune)...';
      } else if (currentMovieSource === 'torrents') {
        searchInput.placeholder = 'Search BitTorrent movies & series (e.g. Game of Thrones, Breaking Bad, Dune)...';
      } else if (currentMovieSource === 'none') {
        searchInput.placeholder = 'All movie search providers are currently disabled in Admin Settings.';
      }
    }
  } catch (err) {
    console.warn('[Movies] Failed to sync movie source tabs:', err.message);
  }
}

function initMoviesView() {
  const form = document.getElementById('movieSearchForm');
  const input = document.getElementById('movieSearchInput');
  const clearBtn = document.getElementById('btnClearMovieSearch');
  const sourceTabs = document.getElementById('movieSourceTabs');
  const qualityFilters = document.getElementById('movieQualityFilters');
  const prevBtn = document.getElementById('btnMoviePrevPage');
  const nextBtn = document.getElementById('btnMovieNextPage');
  const modalClose = document.getElementById('btnCloseMovieReleasesModal');
  const modal = document.getElementById('movieReleasesModal');

  // Synchronize dynamic enabled/disabled states of movie tabs with admin configuration
  syncMovieSourceTabs();

  if (modalClose && modal) {
    modalClose.onclick = () => { modal.style.display = 'none'; };
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
  }

  if (input && clearBtn) {
    input.addEventListener('input', () => {
      clearBtn.style.display = input.value.trim() ? 'block' : 'none';
    });
    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.style.display = 'none';
      input.focus();
    });
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = (input ? input.value : '').trim();
      if (!q) return;
      currentMoviePage = 1;
      executeMovieSearch(q, currentMoviePage);
    });
  }

  if (sourceTabs) {
    sourceTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.movie-tab');
      if (!btn || btn.disabled) return;
      sourceTabs.querySelectorAll('.movie-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMovieSource = btn.dataset.source || 'ddl';

      if (input) {
        if (currentMovieSource === 'ddl') {
          input.placeholder = 'Search movies, anime, or TV shows (e.g. A Silent Voice, Oppenheimer, Deadpool)...';
        } else if (currentMovieSource === 'yts') {
          input.placeholder = 'Search high-res movies on YTS (e.g. Oppenheimer, Interstellar, Dune)...';
        } else if (currentMovieSource === 'torrents') {
          input.placeholder = 'Search BitTorrent movies & series (e.g. Game of Thrones, Breaking Bad, Dune)...';
        }
      }

      if (currentMovieQuery) {
        currentMoviePage = 1;
        executeMovieSearch(currentMovieQuery, currentMoviePage);
      }
    });
  }

  if (qualityFilters) {
    qualityFilters.addEventListener('click', (e) => {
      const btn = e.target.closest('.movie-q-pill');
      if (!btn) return;
      qualityFilters.querySelectorAll('.movie-q-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMovieQuality = btn.dataset.quality || 'all';
      if (currentMovieQuery) {
        currentMoviePage = 1;
        executeMovieSearch(currentMovieQuery, currentMoviePage);
      }
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (currentMoviePage > 1 && currentMovieQuery) {
        currentMoviePage--;
        executeMovieSearch(currentMovieQuery, currentMoviePage);
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (currentMovieQuery) {
        currentMoviePage++;
        executeMovieSearch(currentMovieQuery, currentMoviePage);
      }
    });
  }
}

async function executeMovieSearch(query, page = 1) {
  currentMovieQuery = query;
  currentMoviePage = page;

  const loading = document.getElementById('movieLoadingState');
  const emptyState = document.getElementById('movieEmptyState');
  const grid = document.getElementById('movieResultsGrid');
  const paginationBar = document.getElementById('moviePaginationBar');
  const pageIndicator = document.getElementById('moviePageIndicator');
  const prevBtn = document.getElementById('btnMoviePrevPage');
  const nextBtn = document.getElementById('btnMovieNextPage');

  if (loading) loading.style.display = 'flex';
  if (emptyState) emptyState.style.display = 'none';
  if (grid) grid.style.display = 'none';
  if (paginationBar) paginationBar.style.display = 'none';

  if (currentMovieSource === 'none') {
    if (loading) loading.style.display = 'none';
    if (emptyState) {
      emptyState.innerHTML = `
        <div class="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg></div>
        <h3>Movie Providers Disabled</h3>
        <p>All movie catalog and torrent search engines are currently disabled in Admin Engine Settings.</p>
      `;
      emptyState.style.display = 'flex';
    }
    return;
  }

  try {
    const params = new URLSearchParams({
      q: query,
      page: String(page),
      source: currentMovieSource,
      quality: currentMovieQuality
    });

    const res = await fetch(`/api/movies/search?${params.toString()}`);
    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to fetch movies');
    }

    currentMovieResults = data.results || [];

    if (currentMovieResults.length === 0) {
      if (emptyState) {
        emptyState.innerHTML = `
          <div class="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg></div>
          <h3>No Movies Found</h3>
          <p>No results found for "<strong>${escapeHtml(query)}</strong>" under the selected filter. Try another keyword or switch source filter to "All Sources".</p>
        `;
        emptyState.style.display = 'flex';
      }
    } else {
      renderMovieResults(currentMovieResults);
      if (grid) grid.style.display = 'grid';
      if (paginationBar) {
        paginationBar.style.display = 'flex';
        if (pageIndicator) pageIndicator.textContent = `Page ${currentMoviePage}`;
        if (prevBtn) prevBtn.disabled = currentMoviePage <= 1;
        if (nextBtn) nextBtn.disabled = currentMovieResults.length < 8;
      }
    }
  } catch (err) {
    showToast(`Movie search failed: ${err.message}`, 'error');
    if (emptyState) {
      emptyState.innerHTML = `
        <div class="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg></div>
        <h3>Search Error</h3>
        <p>${escapeHtml(err.message)}</p>
      `;
      emptyState.style.display = 'flex';
    }
  } finally {
    if (loading) loading.style.display = 'none';
  }
}

function renderMovieResults(items) {
  const grid = document.getElementById('movieResultsGrid');
  if (!grid) return;

  const defaultPoster = 'data:image/svg+xml;charset=UTF-8,%3Csvg%20width%3D%22300%22%20height%3D%22450%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%2312151c%22%2F%3E%3Cpath%20d%3D%22M110%20195h80v60h-80z%22%20fill%3D%22%232d3748%22%20rx%3D%226%22%2F%3E%3Ctext%20x%3D%2250%25%22%20y%3D%2252%25%22%20fill%3D%22%23718096%22%20font-size%3D%2215%22%20text-anchor%3D%22middle%22%20font-family%3D%22sans-serif%22%3ENo%20Poster%3C%2Ftext%3E%3C%2Fsvg%3E';

  grid.innerHTML = items.map((item, idx) => {
    const isDdl = item.provider === 'ddl';
    const isYts = item.provider === 'yts';
    const isTorrent = item.provider === 'torrent';
    const isSeries = item.type === 'series';

    let providerBadge = isSeries ? 'TV Series' : 'Direct DDL';
    let providerClass = isSeries ? 'badge-provider-series' : 'badge-provider-ddl';
    if (isYts) {
      providerBadge = 'YTS 4K';
      providerClass = 'badge-provider-yts';
    } else if (isTorrent) {
      providerBadge = isSeries ? 'TV Series • Swarm' : 'BitTorrent';
      providerClass = isSeries ? 'badge-provider-series' : 'badge-provider-torrent';
    }

    let posterUrl = item.poster || defaultPoster;
    if (posterUrl && posterUrl.startsWith('http') && !posterUrl.startsWith('/api/proxy-image')) {
      posterUrl = `/api/proxy-image?url=${encodeURIComponent(posterUrl)}`;
    }
    const yearText = item.year ? `${item.year}` : '';
    const ratingText = item.rating ? `★ ${item.rating}` : '';

    const has4K = (item.releases || []).some(r => /4k|2160p/i.test(r.quality || r.label));
    const has1080p = (item.releases || []).some(r => /1080p/i.test(r.quality || r.label));
    const has720p = (item.releases || []).some(r => /720p/i.test(r.quality || r.label));
    const hasMultiAudio = (item.releases || []).some(r => r.isMultiAudio);

    const bestRelease = (item.releases && item.releases[0]) || null;
    const releaseCount = item.releasesCount || (item.releases ? item.releases.length : 0);

    const displayTitle = item.pureTitle || item.title;

    return `
      <div class="movie-card" data-index="${idx}">
        <div class="movie-card-media">
          <img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(displayTitle)}" class="movie-card-poster" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null; this.src='${defaultPoster}'" />
          <div class="movie-card-overlay-gradient"></div>
          
          <div class="movie-card-top-badges">
            <span class="movie-badge ${providerClass}">${providerBadge}</span>
            ${yearText ? `<span class="movie-badge badge-year">${escapeHtml(yearText)}</span>` : ''}
            ${ratingText ? `<span class="movie-badge badge-rating">${escapeHtml(ratingText)}</span>` : ''}
          </div>

          <div class="movie-card-quality-row">
            ${has4K ? `<span class="quality-badge badge-4k">4K UHD</span>` : ''}
            ${has1080p ? `<span class="quality-badge badge-1080p">1080p</span>` : ''}
            ${has720p ? `<span class="quality-badge badge-720p">720p</span>` : ''}
            ${hasMultiAudio ? `<span class="quality-badge badge-multi">Multi-Audio</span>` : ''}
          </div>
        </div>

        <div class="movie-card-body">
          <h4 class="movie-card-title" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</h4>
          
          <div class="movie-card-meta-line">
            ${bestRelease && bestRelease.size ? `
              <span class="movie-meta-item meta-size">${escapeHtml(bestRelease.size)}</span>
            ` : ''}
            ${bestRelease && bestRelease.seeders !== undefined ? `
              <span class="movie-meta-item meta-seeds">${bestRelease.seeders} Seeds</span>
            ` : ''}
            ${bestRelease && (bestRelease.magnet || bestRelease.torrentUrl) ? `
              <span class="movie-meta-item meta-cloud" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border-color: rgba(16, 185, 129, 0.3);">Verified Swarm</span>
            ` : (isDdl ? `
              <span class="movie-meta-item meta-cloud">Direct Cloud</span>
            ` : '')}
          </div>

          <div class="movie-card-actions">
            <button type="button" class="btn btn-primary btn-sm movie-dl-btn" id="btnMovieDl_${idx}" onclick="${(bestRelease && (bestRelease.magnet || bestRelease.torrentUrl)) ? `dispatchMovieDownload(${idx}, 0, event)` : (isDdl ? `dispatchDdlDownload(${idx}, 0, event)` : `dispatchMovieDownload(${idx}, 0, event)`)}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              <span>${(bestRelease && (bestRelease.magnet || bestRelease.torrentUrl)) ? 'Download' : (isDdl ? 'Direct DDL' : 'Download')}</span>
            </button>

            ${releaseCount > 0 ? `
              <button type="button" class="btn btn-secondary btn-sm movie-options-btn" onclick="openMovieReleasesModal(${idx})">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
                <span>Releases (${releaseCount})</span>
              </button>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

window.copyMovieReleaseLink = function(text, btnEl) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    if (btnEl) {
      const orig = btnEl.innerHTML;
      btnEl.innerHTML = '<span>✓ Copied</span>';
      setTimeout(() => { btnEl.innerHTML = orig; }, 1800);
    }
    showToast('Direct link copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Failed to copy link to clipboard', 'error');
  });
};

window.dispatchMovieDownload = async function(idx, releaseIdx = 0, event = null) {
  const item = currentMovieResults[idx];
  if (!item) return;

  const isSpecificRelease = item.releases && item.releases.length > 0 && item.releases[releaseIdx];
  const release = isSpecificRelease ? item.releases[releaseIdx] : (item.torrentFallback || {});

  const payload = {
    title: release.filename || item.title,
    pureTitle: item.title,
    year: item.year || '',
    releaseLabel: release.label || '',
    releaseFilename: release.filename || '',
    poster: item.poster || '',
    quality: release.quality || '1080p',
    magnet: release.magnet || (!isSpecificRelease && item.torrentFallback ? item.torrentFallback.magnet : ''),
    torrentUrl: release.torrentUrl || (!isSpecificRelease && item.torrentFallback ? item.torrentFallback.torrentUrl : ''),
    url: release.href || release.magnet || release.torrentUrl || item.link || '',
    provider: item.provider || 'ddl',
    type: 'torrent'
  };

  const clickedBtn = event ? event.currentTarget : null;
  const mainCardBtn = document.getElementById(`btnMovieDl_${idx}`);

  if (clickedBtn) {
    clickedBtn.disabled = true;
    clickedBtn.innerHTML = `<span>Starting...</span>`;
  } else if (mainCardBtn) {
    mainCardBtn.disabled = true;
    mainCardBtn.innerHTML = `<span>Starting Download...</span>`;
  }

  try {
    const res = await fetch('/api/movies/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Added to Download Queue: ${payload.title.substring(0, 32)}...`, 'success');
      
      if (clickedBtn) {
        clickedBtn.innerHTML = `<span>✓ Enqueued</span>`;
        clickedBtn.classList.add('btn-success', 'enqueued');
        clickedBtn.disabled = true;
      }
      if (mainCardBtn && !clickedBtn) {
        mainCardBtn.innerHTML = `<span>✓ Enqueued</span>`;
        mainCardBtn.classList.add('btn-success');
      }

      // Keep modal open so user can queue other releases/episodes; update modal footer status
      const modal = document.getElementById('movieReleasesModal');
      const footer = document.getElementById('movieModalFooter');
      const footerText = document.getElementById('movieModalFooterStatusText');
      const btnGo = document.getElementById('btnGoToDownloads');

      if (modal && footer && footerText) {
        footer.style.display = 'flex';
        const displayShortTitle = payload.title.length > 36 ? payload.title.substring(0, 36) + '...' : payload.title;
        footerText.textContent = `Enqueued: ${displayShortTitle}`;
        if (btnGo) {
          btnGo.onclick = () => {
            modal.style.display = 'none';
            switchView('downloader');
          };
        }

        // Auto-transition to downloader after brief visual confirmation
        setTimeout(() => {
          if (modal && modal.style.display === 'flex') {
            modal.style.display = 'none';
            switchView('downloader');
          }
        }, 900);
      }
    } else {
      if (data.requireAuth) {
        openAuthModal('login', data.error);
      }
      showToast(data.error || 'Failed to start download', 'error');
      if (clickedBtn) {
        clickedBtn.disabled = false;
        clickedBtn.innerHTML = `<span>Download</span>`;
      }
      if (mainCardBtn && !clickedBtn) {
        mainCardBtn.disabled = false;
        mainCardBtn.innerHTML = `<span>1-Click Download</span>`;
      }
    }
  } catch (err) {
    showToast(`Download error: ${err.message}`, 'error');
    if (clickedBtn) {
      clickedBtn.disabled = false;
      clickedBtn.innerHTML = `<span>Download</span>`;
    }
    if (mainCardBtn && !clickedBtn) {
      mainCardBtn.disabled = false;
      mainCardBtn.innerHTML = `<span>1-Click Download</span>`;
    }
  }
};

window.dispatchDdlDownload = async function(idx, rIdx = 0, event = null) {
  const item = currentMovieResults[idx];
  if (!item) return;
  const release = (item.releases && item.releases[rIdx]) || {};

  const clickedBtn = event ? event.currentTarget : null;
  const mainCardBtn = document.getElementById(`btnMovieDdl_${item.id}`);

  if (clickedBtn) {
    clickedBtn.disabled = true;
    clickedBtn.innerHTML = `<span>Resolving...</span>`;
  }
  if (mainCardBtn && !clickedBtn) {
    mainCardBtn.disabled = true;
    mainCardBtn.innerHTML = `<span>Resolving...</span>`;
  }

  const payload = {
    title: item.title,
    pureTitle: item.pureTitle || item.title,
    year: item.year || '',
    poster: item.poster || '',
    quality: release.quality || '1080p',
    filename: release.filename || '',
    imdbId: item.imdbId || '',
    url: release.url || '',
    magnet: release.magnet || '',
    torrentUrl: release.torrentUrl || '',
    releaseLabel: release.label || '',
    releaseSize: release.size || ''
  };

  try {
    const res = await fetch('/api/movies/resolve-ddl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Started Direct DDL Download: ${item.title.substring(0, 30)}...`, 'success');
      if (clickedBtn) {
        clickedBtn.innerHTML = `<span>✓ Enqueued</span>`;
        clickedBtn.classList.add('btn-success');
      }
      if (mainCardBtn && !clickedBtn) {
        mainCardBtn.innerHTML = `<span>✓ Enqueued</span>`;
        mainCardBtn.classList.add('btn-success');
      }

      const modal = document.getElementById('movieReleasesModal');
      const footer = document.getElementById('movieModalFooter');
      const footerText = document.getElementById('movieModalFooterStatusText');
      const btnGo = document.getElementById('btnGoToDownloads');

      if (modal && footer && footerText) {
        footer.style.display = 'flex';
        footerText.textContent = `Direct DDL Active: ${item.title.substring(0, 32)}...`;
        if (btnGo) {
          btnGo.onclick = () => {
            modal.style.display = 'none';
            switchView('downloader');
          };
        }

        // Auto-transition to downloader after brief visual confirmation
        setTimeout(() => {
          if (modal && modal.style.display === 'flex') {
            modal.style.display = 'none';
            switchView('downloader');
          }
        }, 900);
      }
    } else {
      if (data.requireAuth) {
        openAuthModal('login', data.error);
      }
      showToast(data.error || 'Failed to start DDL download', 'error');
      if (clickedBtn) {
        clickedBtn.disabled = false;
        clickedBtn.innerHTML = `<span>Direct DDL</span>`;
      }
      if (mainCardBtn && !clickedBtn) {
        mainCardBtn.disabled = false;
        mainCardBtn.innerHTML = `<span>Direct DDL</span>`;
      }
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    if (clickedBtn) {
      clickedBtn.disabled = false;
      clickedBtn.innerHTML = `<span>Direct DDL</span>`;
    }
    if (mainCardBtn && !clickedBtn) {
      mainCardBtn.disabled = false;
      mainCardBtn.innerHTML = `<span>Direct DDL</span>`;
    }
  }
};

window.dispatchOlaDirectDownload = window.dispatchDdlDownload;

let currentModalItemIdx = -1;
let currentModalReleases = [];
let currentModalActiveQuality = 'ALL';
let currentModalSearchQuery = '';

function renderModalReleasesList() {
  const listEl = document.getElementById('movieReleasesList');
  if (!listEl) return;

  let filtered = currentModalReleases.map((rel, rIdx) => ({ rel, rIdx }));

  if (currentModalActiveQuality !== 'ALL') {
    const qLower = currentModalActiveQuality.toLowerCase();
    filtered = filtered.filter(({ rel }) => {
      const rq = (rel.quality || '').toLowerCase();
      if (qLower === '4k' || qLower === '2160p') return rq.includes('4k') || rq.includes('2160');
      if (qLower === '1080p') return rq.includes('1080');
      if (qLower === '720p') return rq.includes('720');
      if (qLower === '480p') return rq.includes('480');
      return rq.includes(qLower);
    });
  }

  if (currentModalSearchQuery) {
    const q = currentModalSearchQuery;
    filtered = filtered.filter(({ rel }) => {
      const haystack = `${rel.label || ''} ${rel.filename || ''} ${rel.quality || ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }

  const curItem = currentModalItemIdx >= 0 ? currentMovieResults[currentModalItemIdx] : null;
  const isDdl = (curItem && curItem.provider === 'ddl');

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div style="text-align: center; padding: 36px 16px; color: var(--text-muted); font-size: 0.88rem;">
        No releases match your filter. Try clearing your search or choosing "All".
      </div>
    `;
    return;
  }

  listEl.innerHTML = filtered.map(({ rel, rIdx }) => {
    const qStr = (rel.quality || '1080p').toUpperCase();
    let qClass = 'quality-default';
    if (qStr.includes('4K') || qStr.includes('2160')) {
      qClass = 'quality-4k';
    } else if (qStr.includes('1080')) {
      qClass = 'quality-1080p';
    } else if (qStr.includes('720')) {
      qClass = 'quality-720p';
    }

    const relTitle = rel.label || rel.filename || (curItem ? `${curItem.title} [${rel.quality || 'HD'}]` : 'Movie Release');

    return `
      <div class="movie-release-item" data-release-index="${rIdx}">
        <div class="release-info">
          <div class="release-quality-pill ${qClass}">${escapeHtml(rel.quality || 'HD')}</div>
          <div class="release-text-block">
            <span class="release-label" title="${escapeHtml(relTitle)}">${escapeHtml(relTitle)}</span>
            <div class="release-secondary-row">
              ${rel.size ? `<span class="release-meta-badge meta-size">${escapeHtml(rel.size)}</span>` : ''}
              ${rel.seeders !== undefined ? `<span class="release-meta-badge">${rel.seeders} Seeds</span>` : ''}
              ${(rel.magnet || rel.torrentUrl) ? `<span class="release-meta-badge" style="color: #60a5fa; border-color: rgba(96, 165, 250, 0.3);">High-Speed Swarm</span>` : (isDdl ? `<span class="release-meta-badge">Direct Cloud</span>` : '')}
              ${rel.isMultiAudio ? `<span class="release-tag">Multi-Audio</span>` : ''}
              ${rel.isHevc ? `<span class="release-tag">HEVC 10-bit</span>` : ''}
              ${rel.isHdr ? `<span class="release-tag">HDR / DV</span>` : ''}
            </div>
          </div>
        </div>
        <div class="release-actions">
          ${(rel.magnet || rel.torrentUrl) ? `
            <button type="button" class="btn btn-primary btn-sm btn-rel-dl" id="btnModalRelDl_${rIdx}" onclick="dispatchMovieDownload(${currentModalItemIdx}, ${rIdx}, event)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              <span>Download</span>
            </button>
          ` : (isDdl ? `
            <button type="button" class="btn btn-primary btn-sm btn-rel-ddl" id="btnModalRelDdl_${rIdx}" onclick="dispatchDdlDownload(${currentModalItemIdx}, ${rIdx}, event)" title="Direct DDL Multi-Thread Download">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              <span>Direct DDL</span>
            </button>
          ` : `
            <button type="button" class="btn btn-primary btn-sm btn-rel-dl" id="btnModalRelDl_${rIdx}" onclick="dispatchMovieDownload(${currentModalItemIdx}, ${rIdx}, event)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              <span>Download</span>
            </button>
          `)}
          ${rel.magnet ? `
            <button type="button" class="btn btn-secondary btn-sm btn-rel-copy" onclick="copyMovieReleaseLink('${escapeHtml(rel.magnet)}', this)" title="Copy magnet link">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
              <span>Magnet</span>
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

window.openMovieReleasesModal = function(idx) {
  const item = currentMovieResults[idx];
  if (!item) return;

  currentModalItemIdx = idx;
  currentModalReleases = item.releases || [];
  currentModalActiveQuality = 'ALL';
  currentModalSearchQuery = '';

  const modal = document.getElementById('movieReleasesModal');
  const titleEl = document.getElementById('movieModalTitle');
  const badgeEl = document.getElementById('movieModalProviderBadge');
  const filtersEl = document.getElementById('movieModalFilters');
  const searchInput = document.getElementById('movieModalSearchInput');
  const footerEl = document.getElementById('movieModalFooter');

  const posterEl = document.getElementById('movieModalPoster');
  const heroBgEl = document.getElementById('movieModalHeroBg');
  const yearEl = document.getElementById('movieModalYear');
  const ratingEl = document.getElementById('movieModalRating');
  const subEl = document.getElementById('movieModalSubtitle');

  if (!modal) return;

  if (titleEl) titleEl.textContent = item.title;
  if (badgeEl) {
    if (item.type === 'series') {
      badgeEl.textContent = item.provider === 'ddl' ? 'TV Series • Direct DDL' : 'TV Series • Swarm';
    } else {
      badgeEl.textContent = item.provider === 'ddl' ? 'Direct DDL Cloud' : (item.provider === 'yts' ? 'YTS 4K' : 'BitTorrent');
    }
  }

  // Populate hero elements
  if (posterEl) {
    posterEl.src = item.poster || '/icon.svg';
  }
  if (heroBgEl) {
    heroBgEl.style.backgroundImage = item.poster ? `url('${item.poster}')` : 'none';
  }
  if (yearEl) {
    if (item.year) {
      yearEl.textContent = item.year;
      yearEl.style.display = 'inline-block';
    } else {
      yearEl.style.display = 'none';
    }
  }
  if (ratingEl) {
    if (item.rating) {
      ratingEl.textContent = `★ ${item.rating}`;
      ratingEl.style.display = 'inline-flex';
    } else {
      ratingEl.style.display = 'none';
    }
  }
  if (subEl) {
    let genreText = (item.genres && item.genres.length > 0) ? item.genres.join(' • ') : '';
    if (item.type === 'series') {
      subEl.textContent = genreText ? `${genreText} • TV Series` : 'Select season or preferred quality';
    } else {
      subEl.textContent = genreText || 'Select preferred quality and download directly';
    }
  }

  // Reset search input
  if (searchInput) {
    searchInput.value = '';
    searchInput.oninput = (e) => {
      currentModalSearchQuery = e.target.value.trim().toLowerCase();
      renderModalReleasesList();
    };
  }

  // Hide footer on initial modal open
  if (footerEl) {
    footerEl.style.display = 'none';
  }

  // Extract unique qualities
  const qualitySet = new Set();
  currentModalReleases.forEach(r => {
    const q = (r.quality || '').trim().toUpperCase();
    if (q) qualitySet.add(q);
  });

  const standardOrder = ['4K', '2160P', '1080P', '720P', '480P'];
  const sortedQualities = Array.from(qualitySet).sort((a, b) => {
    let ai = standardOrder.indexOf(a);
    let bi = standardOrder.indexOf(b);
    if (ai === -1) ai = 99;
    if (bi === -1) bi = 99;
    return ai - bi;
  });

  if (filtersEl) {
    if (sortedQualities.length > 1) {
      filtersEl.innerHTML = [
        `<button type="button" class="modal-q-chip active" data-quality="ALL">All (${currentModalReleases.length})</button>`,
        ...sortedQualities.map(q => {
          const count = currentModalReleases.filter(r => (r.quality || '').toUpperCase() === q).length;
          return `<button type="button" class="modal-q-chip" data-quality="${escapeHtml(q)}">${escapeHtml(q)} (${count})</button>`;
        })
      ].join('');

      filtersEl.querySelectorAll('.modal-q-chip').forEach(chip => {
        chip.onclick = () => {
          filtersEl.querySelectorAll('.modal-q-chip').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          currentModalActiveQuality = chip.getAttribute('data-quality');
          renderModalReleasesList();
        };
      });
      filtersEl.style.display = 'flex';
    } else {
      filtersEl.innerHTML = '';
      filtersEl.style.display = 'none';
    }
  }

  renderModalReleasesList();
  modal.style.display = 'flex';
};

// ==========================================================================
// MUSIC & ALBUM HUB CONTROLLER (Multi-Format, Multi-Codec, Audiophile Studio)
// ==========================================================================
let currentMusicResults = [];
let currentMusicPage = 1;
let currentMusicQuery = '';
let currentMusicSource = 'direct'; // 'direct' or 'albums'
let currentMusicFormat = 'all'; // 'all', 'flac', 'mp3', 'm4a', 'opus'
let currentAudioPreview = null;
let currentPreviewTrackId = null;

function formatMusicDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '03:30';
  const sec = Math.round(Number(seconds));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

window.toggleAudioPreview = function(previewUrl, trackId, btnEl) {
  if (currentAudioPreview && currentPreviewTrackId === trackId) {
    currentAudioPreview.pause();
    currentAudioPreview = null;
    currentPreviewTrackId = null;
    if (btnEl) {
      btnEl.classList.remove('playing');
      const playIcon = btnEl.querySelector('.icon-play');
      const pauseIcon = btnEl.querySelector('.icon-pause');
      if (playIcon) playIcon.style.display = 'block';
      if (pauseIcon) pauseIcon.style.display = 'none';
    }
    return;
  }

  if (currentAudioPreview) {
    currentAudioPreview.pause();
    document.querySelectorAll('.music-preview-btn').forEach(b => {
      b.classList.remove('playing');
      const playIcon = b.querySelector('.icon-play');
      const pauseIcon = b.querySelector('.icon-pause');
      if (playIcon) playIcon.style.display = 'block';
      if (pauseIcon) pauseIcon.style.display = 'none';
    });
  }

  if (!previewUrl) {
    showToast('Audio sample preview not available for this track', 'info');
    return;
  }

  currentAudioPreview = new Audio(previewUrl);
  currentPreviewTrackId = trackId;
  if (btnEl) {
    btnEl.classList.add('playing');
    const playIcon = btnEl.querySelector('.icon-play');
    const pauseIcon = btnEl.querySelector('.icon-pause');
    if (playIcon) playIcon.style.display = 'none';
    if (pauseIcon) pauseIcon.style.display = 'block';
  }

  currentAudioPreview.play().catch(e => {
    console.warn('Audio preview playback error:', e);
    if (btnEl) {
      btnEl.classList.remove('playing');
      const playIcon = btnEl.querySelector('.icon-play');
      const pauseIcon = btnEl.querySelector('.icon-pause');
      if (playIcon) playIcon.style.display = 'block';
      if (pauseIcon) pauseIcon.style.display = 'none';
    }
  });

  currentAudioPreview.onended = () => {
    if (btnEl) {
      btnEl.classList.remove('playing');
      const playIcon = btnEl.querySelector('.icon-play');
      const pauseIcon = btnEl.querySelector('.icon-pause');
      if (playIcon) playIcon.style.display = 'block';
      if (pauseIcon) pauseIcon.style.display = 'none';
    }
    currentAudioPreview = null;
    currentPreviewTrackId = null;
  };
};

async function executeMusicSearch(query, page = 1) {
  const loading = document.getElementById('musicLoadingState');
  const empty = document.getElementById('musicEmptyState');
  const grid = document.getElementById('musicResultsGrid');
  const pagBar = document.getElementById('musicPaginationBar');
  const prevBtn = document.getElementById('btnMusicPrevPage');
  const nextBtn = document.getElementById('btnMusicNextPage');
  const pageIndicator = document.getElementById('musicPageIndicator');

  if (!query) return;
  currentMusicQuery = query;
  currentMusicPage = page;

  // Stop any active preview
  if (currentAudioPreview) {
    currentAudioPreview.pause();
    currentAudioPreview = null;
    currentPreviewTrackId = null;
    document.querySelectorAll('.music-preview-btn').forEach(b => b.classList.remove('playing'));
  }

  if (loading) loading.style.display = 'flex';
  if (empty) empty.style.display = 'none';
  if (grid) grid.style.display = 'none';
  if (pagBar) pagBar.style.display = 'none';

  try {
    const url = `/api/music/search?q=${encodeURIComponent(query)}&source=${currentMusicSource}&format=${currentMusicFormat}&page=${page}`;
    const res = await fetch(url);
    const data = await res.json();

    if (loading) loading.style.display = 'none';

    if (!res.ok || !data.success || !data.results || data.results.length === 0) {
      if (empty) {
        empty.style.display = 'flex';
        empty.querySelector('h3').textContent = 'No Music Tracks Found';
        empty.querySelector('p').textContent = `No tracks found for "${query}". Try searching with different song or artist keywords.`;
      }
      currentMusicResults = [];
      return;
    }

    currentMusicResults = data.results;
    renderMusicResults(currentMusicResults);

    if (grid) grid.style.display = 'grid';
    if (pagBar) {
      pagBar.style.display = 'flex';
      if (pageIndicator) pageIndicator.textContent = `Page ${page}`;
      if (prevBtn) prevBtn.disabled = page <= 1;
      if (nextBtn) nextBtn.disabled = currentMusicResults.length < 15;
    }
  } catch (err) {
    if (loading) loading.style.display = 'none';
    if (empty) {
      empty.style.display = 'flex';
      empty.querySelector('h3').textContent = 'Search Error';
      empty.querySelector('p').textContent = `Failed to fetch search results: ${err.message}`;
    }
  }
}

function renderMusicResults(results) {
  const grid = document.getElementById('musicResultsGrid');
  if (!grid) return;

  grid.innerHTML = results.map((item, idx) => {
    const coverUrl = item.cover || '/icon.svg';
    const title = item.title || 'Unknown Track';
    const artist = item.artist || 'Unknown Artist';
    const album = item.album || '';
    const duration = item.durationStr || (item.duration ? formatMusicDuration(item.duration) : '');
    const isTorrent = item.type === 'torrent' || item.source === 'torrent';

    return `
      <div class="music-card" data-index="${idx}">
        <div class="music-card-cover-wrap">
          <img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(title)}" class="music-card-cover" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null; this.src='/icon.svg'" />
          <div class="music-card-cover-overlay"></div>
          ${duration ? `<span class="music-card-duration-badge">${escapeHtml(duration)}</span>` : ''}
          ${item.previewUrl ? `
            <button type="button" class="music-preview-btn" title="Preview 30s audio sample" onclick="toggleAudioPreview('${escapeHtml(item.previewUrl)}', '${item.id || idx}', this)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="icon-play"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="icon-pause" style="display:none;"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
              <div class="music-soundwave"><span></span><span></span><span></span></div>
            </button>
          ` : ''}
        </div>
        <div class="music-card-body">
          <h4 class="music-card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</h4>
          <span class="music-card-artist" title="${escapeHtml(artist)}">${escapeHtml(artist)}</span>
          ${album ? `<span class="music-card-album" title="${escapeHtml(album)}">${escapeHtml(album)}</span>` : ''}
          <div class="music-card-badges-row">
            ${isTorrent ? `
              <span class="music-badge-pill badge-pill-hires" title="Full lossless album torrent">ALBUM TORRENT</span>
              <span class="music-badge-pill badge-pill-cdda" title="Torrent size">${escapeHtml(item.size || 'Lossless')}</span>
              <span class="music-badge-pill badge-pill-mp3" title="Active torrent seeds">${item.seeders || 0} Seeds</span>
            ` : `
              <button type="button" class="music-badge-pill badge-pill-hires" title="Download 24-bit Studio Master FLAC" onclick="event.stopPropagation(); dispatchTrackDownload(${idx}, 'flac', '24bit', event)">24-BIT HI-RES</button>
              <button type="button" class="music-badge-pill badge-pill-cdda" title="Download 16-bit 44.1kHz CDDA FLAC (Deezer HiFi CDN)" onclick="event.stopPropagation(); dispatchTrackDownload(${idx}, 'flac', '16bit', event)">16-BIT CD</button>
              <button type="button" class="music-badge-pill badge-pill-mp3" title="Download MP3 320kbps CBR" onclick="event.stopPropagation(); dispatchTrackDownload(${idx}, 'mp3', '320k', event)">MP3 320K</button>
              <button type="button" class="music-badge-pill badge-pill-aac" title="Download Apple AAC 256kbps M4A" onclick="event.stopPropagation(); dispatchTrackDownload(${idx}, 'm4a', '256k', event)">AAC</button>
              <button type="button" class="music-badge-pill badge-pill-opus" title="Download Opus 160kbps" onclick="event.stopPropagation(); dispatchTrackDownload(${idx}, 'opus', '160k', event)">OPUS</button>
            `}
          </div>
          <button type="button" class="btn-music-open-modal" onclick="${isTorrent ? `dispatchTorrentAlbumDownload(${idx}, event)` : `openMusicFormatsModal(${idx})`}">
            ${isTorrent ? `
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              <span>Download Full Album (${escapeHtml(item.size || 'FLAC')})</span>
            ` : `
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
              <span>Choose Format &amp; Quality</span>
            `}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

window.openMusicFormatsModal = function(idx) {
  const item = currentMusicResults[idx];
  if (!item) return;

  const modal = document.getElementById('musicFormatsModal');
  const heroBg = document.getElementById('musicModalHeroBg');
  const cover = document.getElementById('musicModalCover');
  const title = document.getElementById('musicModalTitle');
  const subtitle = document.getElementById('musicModalSubtitle');
  const yearEl = document.getElementById('musicModalYear');
  const durationEl = document.getElementById('musicModalDuration');
  const listEl = document.getElementById('musicFormatsList');
  const filtersEl = document.getElementById('musicModalFilters');
  const searchInput = document.getElementById('musicModalSearchInput');
  const footerEl = document.getElementById('musicModalFooter');

  if (footerEl) footerEl.style.display = 'none';

  const coverUrl = item.cover || '/icon.svg';
  if (cover) cover.src = coverUrl;
  if (heroBg) heroBg.style.backgroundImage = `url('${coverUrl}')`;
  if (title) title.textContent = item.title;
  if (subtitle) subtitle.textContent = `${item.artist}${item.album ? ' • ' + item.album : ''}`;
  if (yearEl) yearEl.textContent = item.year || '2024';
  if (durationEl) durationEl.textContent = item.durationStr || (item.duration ? formatMusicDuration(item.duration) : '03:45');
  if (searchInput) searchInput.value = '';

  const formats = [
    {
      id: 'flac_hires',
      format: 'flac',
      quality: '24bit',
      name: 'FLAC Studio Master (24-bit Hi-Res)',
      spec: '24-bit / 96kHz / 48kHz True PCM • Tidal Hi-Res / Soulseek Master',
      badge: '24-BIT HI-RES',
      badgeClass: 'btn-music-dl-hires',
      badgePillClass: 'badge-pill-hires',
      size: '~45–90 MB',
      btnText: 'Download FLAC 24-bit'
    },
    {
      id: 'flac_cdda',
      format: 'flac',
      quality: '16bit',
      name: 'FLAC Lossless CDDA (16-bit / 44.1kHz)',
      spec: '16-bit / 44.1kHz • 1411 kbps Bitstream • Deezer HiFi Studio CD',
      badge: '16-BIT CDDA',
      badgeClass: 'btn-music-dl-cdda',
      badgePillClass: 'badge-pill-cdda',
      size: '~25–40 MB',
      btnText: 'Download FLAC 16-bit'
    },
    {
      id: 'mp3_320',
      format: 'mp3',
      quality: '320k',
      name: 'MP3 Extreme Quality (320 kbps CBR)',
      spec: 'LAME 320 kbps Extreme CBR • 48kHz • Embedded Cover & ID3 Tags',
      badge: 'MP3 320K',
      badgeClass: 'btn-music-dl-lossy',
      badgePillClass: 'badge-pill-mp3',
      size: '~8–14 MB',
      btnText: 'Download MP3 320k'
    },
    {
      id: 'm4a_256',
      format: 'm4a',
      quality: '256k',
      name: 'Apple AAC / M4A (256 kbps VBR)',
      spec: 'Native iTunes 256 kbps AAC Bitstream • Crystal-Clear M4A Audio',
      badge: 'AAC 256K',
      badgeClass: 'btn-music-dl-lossy',
      badgePillClass: 'badge-pill-aac',
      size: '~6–10 MB',
      btnText: 'Download M4A 256k'
    },
    {
      id: 'opus_160',
      format: 'opus',
      quality: '160k',
      name: 'Opus High-Fidelity (160 kbps VBR)',
      spec: 'Next-Gen Opus Codec • Superior acoustic fidelity at lower filesize',
      badge: 'OPUS 160K',
      badgeClass: 'btn-music-dl-lossy',
      badgePillClass: 'badge-pill-opus',
      size: '~4–7 MB',
      btnText: 'Download Opus'
    },
    {
      id: 'wav_pcm',
      format: 'wav',
      quality: 'pcm',
      name: 'WAV Studio PCM (Uncompressed Audio)',
      spec: '16-bit / 44.1kHz Raw PCM • Zero Compression / Maximum Compatibility',
      badge: 'RAW WAV',
      badgeClass: 'btn-music-dl-lossy',
      badgePillClass: 'badge-pill-hires',
      size: '~35–50 MB',
      btnText: 'Download WAV'
    }
  ];

  let activeFilter = 'all';

  function renderFormatsList() {
    const filterQuery = (searchInput ? searchInput.value : '').toLowerCase().trim();
    const filtered = formats.filter(fmt => {
      if (activeFilter !== 'all' && fmt.format !== activeFilter) return false;
      if (filterQuery) {
        return fmt.name.toLowerCase().includes(filterQuery) ||
               fmt.spec.toLowerCase().includes(filterQuery) ||
               fmt.badge.toLowerCase().includes(filterQuery);
      }
      return true;
    });

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="music-modal-empty">
          <p>No audio formats match your search filter.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = filtered.map(fmt => `
      <div class="music-format-card">
        <div class="music-format-info">
          <div class="music-format-badge-wrap">
            <span class="music-badge-pill ${fmt.badgePillClass}">${fmt.badge}</span>
          </div>
          <div class="music-format-text">
            <div class="music-format-title">${escapeHtml(fmt.name)}</div>
            <div class="music-format-desc">${escapeHtml(fmt.spec)}</div>
          </div>
        </div>
        <div class="music-format-actions">
          <span class="music-format-size">Est. ${fmt.size.replace('Estimated Size:', '').trim()}</span>
          <button type="button" class="btn btn-sm ${fmt.badgeClass} btn-music-download" onclick="event.stopPropagation(); dispatchTrackDownload(${idx}, '${fmt.format}', '${fmt.quality}', event)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            <span>${fmt.btnText}</span>
          </button>
        </div>
      </div>
    `).join('');
  }

  if (filtersEl) {
    filtersEl.innerHTML = `
      <button type="button" class="modal-filter-pill active" data-filter="all">All Formats</button>
      <button type="button" class="modal-filter-pill" data-filter="flac">FLAC Lossless</button>
      <button type="button" class="modal-filter-pill" data-filter="mp3">MP3 320k</button>
      <button type="button" class="modal-filter-pill" data-filter="m4a">AAC / M4A</button>
      <button type="button" class="modal-filter-pill" data-filter="opus">Opus</button>
      <button type="button" class="modal-filter-pill" data-filter="wav">WAV</button>
    `;
    filtersEl.onclick = (e) => {
      const btn = e.target.closest('.modal-filter-pill');
      if (!btn) return;
      filtersEl.querySelectorAll('.modal-filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter || 'all';
      renderFormatsList();
    };
  }

  if (searchInput) {
    searchInput.oninput = () => { renderFormatsList(); };
  }

  renderFormatsList();
  modal.style.display = 'flex';
};

window.dispatchTrackDownload = async function(idx, format, quality, event = null) {
  const item = currentMusicResults[idx];
  if (!item) return;

  const clickedBtn = event ? event.currentTarget : null;
  if (clickedBtn) {
    clickedBtn.disabled = true;
    clickedBtn.innerHTML = `<span>Enqueuing...</span>`;
  }

  const payload = {
    title: item.title,
    artist: item.artist,
    album: item.album || '',
    year: item.year || '',
    duration: item.duration || 0,
    cover: item.cover || '',
    isrc: item.isrc || '',
    previewUrl: item.previewUrl || '',
    format: format || 'mp3',
    quality: quality || '320k',
    source: 'track'
  };

  try {
    const res = await fetch('/api/music/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Enqueued ${format.toUpperCase()}: ${item.title.substring(0, 28)}...`, 'success');
      if (clickedBtn) {
        clickedBtn.innerHTML = `<span>✓ Enqueued</span>`;
        clickedBtn.classList.add('btn-success');
      }
      const footerEl = document.getElementById('musicModalFooter');
      const footerStatus = document.getElementById('musicModalFooterStatusText');
      if (footerEl && footerStatus) {
        footerStatus.textContent = `Enqueued ${format.toUpperCase()} (${quality}) • Task active in Downloader`;
        footerEl.style.display = 'flex';
      }
    } else {
      if (data.requireAuth) {
        openAuthModal('login', data.error);
      }
      showToast(`Download failed: ${data.error || 'Server error'}`, 'error');
      if (clickedBtn) {
        clickedBtn.disabled = false;
        clickedBtn.innerHTML = `<span>Retry</span>`;
      }
    }
  } catch (err) {
    showToast(`Download error: ${err.message}`, 'error');
    if (clickedBtn) {
      clickedBtn.disabled = false;
      clickedBtn.innerHTML = `<span>Retry</span>`;
    }
  }
};

window.dispatchTorrentAlbumDownload = async function(idx, event = null) {
  const item = currentMusicResults[idx];
  if (!item) return;

  const clickedBtn = event ? event.currentTarget : null;
  if (clickedBtn) {
    clickedBtn.disabled = true;
    clickedBtn.innerHTML = `<span>Enqueuing Album...</span>`;
  }

  const payload = {
    title: item.title,
    artist: item.artist || '',
    cover: item.cover || '',
    magnet: item.magnet || '',
    torrentUrl: item.torrentUrl || '',
    source: 'torrent',
    format: 'flac',
    quality: 'lossless'
  };

  try {
    const res = await fetch('/api/music/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Album Enqueued: ${item.title.substring(0, 30)}...`, 'success');
      if (clickedBtn) {
        clickedBtn.innerHTML = `<span>✓ Enqueued Album</span>`;
        clickedBtn.classList.add('btn-success');
      }
    } else {
      if (data.requireAuth) {
        openAuthModal('login', data.error);
      }
      showToast(`Album download error: ${data.error || 'Server error'}`, 'error');
      if (clickedBtn) {
        clickedBtn.disabled = false;
        clickedBtn.innerHTML = `<span>Retry</span>`;
      }
    }
  } catch (err) {
    showToast(`Download error: ${err.message}`, 'error');
    if (clickedBtn) {
      clickedBtn.disabled = false;
      clickedBtn.innerHTML = `<span>Retry</span>`;
    }
  }
};

function initMusicView() {
  const form = document.getElementById('musicSearchForm');
  const input = document.getElementById('musicSearchInput');
  const clearBtn = document.getElementById('btnClearMusicSearch');
  const sourceTabs = document.getElementById('musicSourceTabs');
  const formatFilters = document.getElementById('musicFormatFilters');
  const quickTags = document.getElementById('musicQuickTags');
  const prevBtn = document.getElementById('btnMusicPrevPage');
  const nextBtn = document.getElementById('btnMusicNextPage');
  const modalClose = document.getElementById('btnCloseMusicFormatsModal');
  const modal = document.getElementById('musicFormatsModal');
  const goToDlBtn = document.getElementById('btnMusicGoToDownloads');

  if (modalClose && modal) {
    modalClose.onclick = () => { modal.style.display = 'none'; };
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
  }

  if (goToDlBtn) {
    goToDlBtn.onclick = () => {
      if (modal) modal.style.display = 'none';
      switchView('downloader');
    };
  }

  if (input && clearBtn) {
    input.addEventListener('input', () => {
      clearBtn.style.display = input.value.trim() ? 'block' : 'none';
    });
    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.style.display = 'none';
      input.focus();
    });
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = (input ? input.value : '').trim();
      if (!q) return;
      currentMusicPage = 1;
      executeMusicSearch(q, currentMusicPage);
    });
  }

  if (sourceTabs) {
    sourceTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.music-tab');
      if (!btn) return;
      sourceTabs.querySelectorAll('.music-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMusicSource = btn.dataset.source || 'direct';

      if (input) {
        if (currentMusicSource === 'direct') {
          input.placeholder = 'Search songs, artists, or albums (e.g. Bohemian Rhapsody, Taylor Swift, Hans Zimmer)...';
        } else {
          input.placeholder = 'Search full albums & discographies (e.g. Pink Floyd FLAC, Queen Discography, Daft Punk)...';
        }
      }

      if (currentMusicQuery) {
        currentMusicPage = 1;
        executeMusicSearch(currentMusicQuery, currentMusicPage);
      }
    });
  }

  if (formatFilters) {
    formatFilters.addEventListener('click', (e) => {
      const btn = e.target.closest('.music-f-pill');
      if (!btn) return;
      formatFilters.querySelectorAll('.music-f-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMusicFormat = btn.dataset.format || 'all';

      if (currentMusicQuery) {
        currentMusicPage = 1;
        executeMusicSearch(currentMusicQuery, currentMusicPage);
      }
    });
  }

  if (quickTags) {
    quickTags.addEventListener('click', (e) => {
      const chip = e.target.closest('.music-quick-chip');
      if (!chip) return;
      const q = chip.dataset.query;
      if (!q) return;
      if (input) {
        input.value = q;
        if (clearBtn) clearBtn.style.display = 'block';
      }
      currentMusicPage = 1;
      executeMusicSearch(q, currentMusicPage);
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (currentMusicPage > 1) {
        executeMusicSearch(currentMusicQuery, currentMusicPage - 1);
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      executeMusicSearch(currentMusicQuery, currentMusicPage + 1);
    });
  }
}

// ==========================================================================
// 8. GEMINI MULTIMODAL AI INTELLIGENCE SUITE (OWNER EXCLUSIVE)
// ==========================================================================
function initAiFeatures() {
  // 1. AI Media Copilot
  const btnAiCopilotTrigger = document.getElementById('btnAiCopilotTrigger');
  const aiCopilotContainer = document.getElementById('aiCopilotContainer');
  const aiCopilotClose = document.getElementById('btnCloseCopilot') || document.getElementById('aiCopilotClose');
  const aiCopilotInput = document.getElementById('aiCopilotInput');
  const btnAiCopilotSubmit = document.getElementById('btnAiCopilotSubmit');
  const aiCopilotFeedback = document.getElementById('aiCopilotFeedback');
  const aiFeedbackSpinner = document.getElementById('aiFeedbackSpinner');
  const aiFeedbackText = document.getElementById('aiFeedbackText');
  const exampleChips = document.querySelectorAll('.ai-example-chip, .ai-copilot-chip');

  if (btnAiCopilotTrigger && aiCopilotContainer) {
    btnAiCopilotTrigger.addEventListener('click', () => {
      const isHidden = aiCopilotContainer.style.display === 'none' || !aiCopilotContainer.style.display;
      aiCopilotContainer.style.display = isHidden ? 'flex' : 'none';
      btnAiCopilotTrigger.classList.toggle('active', isHidden);
      if (isHidden && aiCopilotInput) {
        aiCopilotInput.focus();
      }
    });
  }

  if (aiCopilotClose && aiCopilotContainer) {
    aiCopilotClose.addEventListener('click', () => {
      aiCopilotContainer.style.display = 'none';
      if (btnAiCopilotTrigger) btnAiCopilotTrigger.classList.remove('active');
    });
  }

  // Keyboard shortcut: Esc closes AI Copilot
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && aiCopilotContainer && aiCopilotContainer.style.display !== 'none') {
      aiCopilotContainer.style.display = 'none';
      if (btnAiCopilotTrigger) btnAiCopilotTrigger.classList.remove('active');
    }
  });

  async function handleAiCopilotSubmit(promptText) {
    const prompt = (promptText || (aiCopilotInput ? aiCopilotInput.value : '')).trim();
    if (!prompt) {
      showToast('Please enter a media prompt for AI Copilot', 'warning');
      return;
    }

    if (btnAiCopilotSubmit) btnAiCopilotSubmit.disabled = true;
    if (aiCopilotFeedback) aiCopilotFeedback.style.display = 'flex';
    if (aiFeedbackSpinner) aiFeedbackSpinner.style.display = 'inline-flex';
    if (aiFeedbackText) aiFeedbackText.textContent = 'Consulting Gemini AI...';

    try {
      const res = await fetch('/api/ai/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      const data = await res.json();

      if (res.ok && data.success && data.intent) {
        const intent = data.intent;
        if (aiFeedbackText) {
          aiFeedbackText.textContent = intent.explanation || 'Intent resolved successfully';
        }

        // Auto-route based on intent category and suggestedTab
        const targetTab = intent.suggestedTab || intent.intent;
        if (targetTab === 'adult-search' || intent.intent === 'adult_jav') {
          switchView('adult-search');
          const adultInput = document.getElementById('adultSearchInput');
          const q = intent.javCode || intent.javActress || intent.query;
          if (adultInput && q) {
            adultInput.value = q;
            currentAdultQuery = q;
            currentAdultPage = 1;
            if (typeof executeAdultSearch === 'function') executeAdultSearch();
          }
        } else if (targetTab === 'music' || intent.intent === 'music') {
          switchView('music');
          const musicInput = document.getElementById('musicSearchInput');
          if (musicInput && intent.query) {
            musicInput.value = intent.query;
            currentMusicQuery = intent.query;
            currentMusicPage = 1;
            if (typeof executeMusicSearch === 'function') executeMusicSearch(intent.query, 1);
          }
        } else if (targetTab === 'movies' || intent.intent === 'movies') {
          switchView('movies');
          const movieInput = document.getElementById('movieSearchInput');
          if (movieInput && intent.query) {
            movieInput.value = intent.query;
            currentMovieQuery = intent.query;
            currentMoviePage = 1;
            if (typeof executeMovieSearch === 'function') executeMovieSearch(intent.query, 1);
          }
        } else if (intent.directUrl || intent.intent === 'direct_url') {
          switchView('downloader');
          if (urlInput) {
            urlInput.value = intent.directUrl || intent.query;
            if (fetchBtn) fetchBtn.click();
          }
        } else {
          switchView('downloader');
          if (urlInput && intent.query) {
            urlInput.value = intent.query;
            if (fetchBtn) fetchBtn.click();
          }
        }

        showToast(`Copilot: ${intent.explanation || intent.query}`, 'success');
      } else {
        if (data.ownerOnly) {
          showToast('AI features are strictly reserved for Owner account (Sakura)', 'error');
        } else {
          showToast(data.error || 'AI Copilot could not resolve request', 'error');
        }
        if (aiFeedbackText) aiFeedbackText.textContent = data.error || 'Request failed';
      }
    } catch (err) {
      showToast(`AI Copilot error: ${err.message}`, 'error');
      if (aiFeedbackText) aiFeedbackText.textContent = `Error: ${err.message}`;
    } finally {
      if (btnAiCopilotSubmit) btnAiCopilotSubmit.disabled = false;
      if (aiFeedbackSpinner) aiFeedbackSpinner.style.display = 'none';
    }
  }

  if (btnAiCopilotSubmit) {
    btnAiCopilotSubmit.addEventListener('click', () => handleAiCopilotSubmit());
  }

  if (aiCopilotInput) {
    aiCopilotInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAiCopilotSubmit();
      }
    });
  }

  exampleChips.forEach(chip => {
    chip.addEventListener('click', () => {
      const ex = chip.dataset.prompt || chip.dataset.example || chip.textContent.trim();
      if (aiCopilotInput) aiCopilotInput.value = ex;
      handleAiCopilotSubmit(ex);
    });
  });

  // 2. FLAC Checker Spectrogram AI Audit
  const btnFlacAiAudit = document.getElementById('btnFlacAiAudit');
  const flacAiVerdictCard = document.getElementById('flacAiVerdictCard');
  const aiVerdictBadge = document.getElementById('aiVerdictBadge');
  const aiVerdictScore = document.getElementById('aiVerdictScore');
  const aiEstimatedSource = document.getElementById('aiEstimatedSource');
  const aiCutoffFreq = document.getElementById('aiCutoffFreq');
  const aiTechnicalAnalysis = document.getElementById('aiTechnicalAnalysis');
  const aiVerdictBadges = document.getElementById('aiVerdictBadges');

  if (btnFlacAiAudit) {
    btnFlacAiAudit.addEventListener('click', async () => {
      if (!window.currentFlacSpectrogram) {
        showToast('No spectrogram image available. Upload and analyze an audio file first.', 'warning');
        return;
      }

      btnFlacAiAudit.disabled = true;
      btnFlacAiAudit.innerHTML = `<div class="ai-feedback-spinner" style="width:12px;height:12px;display:inline-block;"></div><span>Auditing Spectrogram...</span>`;

      try {
        const res = await fetch('/api/ai/audit-spectrogram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageBase64: window.currentFlacSpectrogram,
            metadata: window.currentFlacMetadata || {}
          })
        });

        const data = await res.json();
        if (res.ok && data.success && data.audit) {
          const audit = data.audit;
          if (flacAiVerdictCard) flacAiVerdictCard.style.display = 'block';

          if (aiVerdictBadge) {
            aiVerdictBadge.textContent = (audit.verdict || 'AUTHENTIC').replace(/_/g, ' ');
            aiVerdictBadge.className = 'ai-verdict-badge ' + (audit.isAuthenticLossless ? 'badge-genuine' : 'badge-fake');
          }

          if (aiVerdictScore) {
            aiVerdictScore.textContent = `Fidelity: ${audit.fidelityScore || 90}/100`;
          }

          if (aiEstimatedSource) {
            aiEstimatedSource.textContent = audit.estimatedOriginalSource || '16-bit / 44.1 kHz CDDA';
          }

          if (aiCutoffFreq) {
            aiCutoffFreq.textContent = audit.cutoffFrequency || 'No cutoff detected';
          }

          if (aiTechnicalAnalysis) {
            aiTechnicalAnalysis.textContent = audit.technicalAnalysis || '';
          }

          if (aiVerdictBadges) {
            const badges = Array.isArray(audit.badges) ? audit.badges : [];
            aiVerdictBadges.innerHTML = badges.map(b => `<span class="ai-pill-tag">${escapeHtml(b)}</span>`).join('');
          }

          flacAiVerdictCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          showToast(`Audiophile Audit: ${audit.verdict}`, audit.isAuthenticLossless ? 'success' : 'warning');
        } else {
          showToast(data.error || 'Failed to complete spectrogram audit', 'error');
        }
      } catch (err) {
        showToast(`Audit failed: ${err.message}`, 'error');
      } finally {
        btnFlacAiAudit.disabled = false;
        btnFlacAiAudit.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"></path></svg><span>AI Lossless Audit</span>`;
      }
    });
  }

  // 3. Adult & JAV Hub AI Assistant
  const btnToggleJavAi = document.getElementById('btnToggleJavAi');
  const aiJavContent = document.getElementById('aiJavContent');
  const tabJavImageMatch = document.getElementById('tabJavImageMatch');
  const tabJavTranslate = document.getElementById('tabJavTranslate');
  const panelJavImageMatch = document.getElementById('panelJavImageMatch');
  const panelJavTranslate = document.getElementById('panelJavTranslate');

  const javAiDropzone = document.getElementById('javAiDropzone');
  const javAiFileInput = document.getElementById('javAiFileInput');
  const javAiResult = document.getElementById('javAiResult');

  const javRawTitleInput = document.getElementById('javRawTitleInput');
  const btnJavTranslateSubmit = document.getElementById('btnJavTranslateSubmit');
  const javTranslateResult = document.getElementById('javTranslateResult');

  if (btnToggleJavAi && aiJavContent) {
    btnToggleJavAi.addEventListener('click', () => {
      const isHidden = aiJavContent.style.display === 'none' || !aiJavContent.style.display;
      aiJavContent.style.display = isHidden ? 'block' : 'none';
      btnToggleJavAi.classList.toggle('active', isHidden);
    });
  }

  if (tabJavImageMatch && tabJavTranslate && panelJavImageMatch && panelJavTranslate) {
    tabJavImageMatch.addEventListener('click', () => {
      tabJavImageMatch.classList.add('active');
      tabJavTranslate.classList.remove('active');
      panelJavImageMatch.style.display = 'block';
      panelJavTranslate.style.display = 'none';
    });

    tabJavTranslate.addEventListener('click', () => {
      tabJavTranslate.classList.add('active');
      tabJavImageMatch.classList.remove('active');
      panelJavTranslate.style.display = 'block';
      panelJavImageMatch.style.display = 'none';
    });
  }

  // Image recognition
  async function processJavImageFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      showToast('Please select a valid image file', 'warning');
      return;
    }

    if (javAiResult) {
      javAiResult.style.display = 'block';
      javAiResult.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:12px;color:var(--text-muted);">
          <div class="ai-feedback-spinner" style="display:inline-block;"></div>
          <span>Analyzing visual features, actress face, and studio codes with Gemini Vision...</span>
        </div>
      `;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64Data = e.target.result;
      try {
        const res = await fetch('/api/ai/jav-recognize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: base64Data })
        });
        const data = await res.json();
        if (res.ok && data.success && data.recognition) {
          const r = data.recognition;
          const searchTag = r.detectedCode || r.actressName || r.searchQuerySuggestion || '';
          if (javAiResult) {
            javAiResult.innerHTML = `
              <div class="ai-result-card" style="padding:10px;background:rgba(255,255,255,0.03);border-radius:6px;">
                <div class="ai-result-row" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
                  ${r.detectedCode ? `<span class="ai-pill-tag tag-code">${escapeHtml(r.detectedCode)}</span>` : ''}
                  ${r.actressName ? `<span class="ai-pill-tag tag-actress">${escapeHtml(r.actressName)}${r.actressKanji ? ` (${escapeHtml(r.actressKanji)})` : ''}</span>` : ''}
                  ${r.maker ? `<span class="ai-pill-tag">${escapeHtml(r.maker)}</span>` : ''}
                  <span class="ai-pill-tag tag-confidence">Confidence: ${escapeHtml(r.confidence || 'HIGH')}</span>
                </div>
                ${r.cleanEnglishTitle ? `<div style="font-weight:600;margin:6px 0;font-size:0.92rem;color:var(--text-primary);">${escapeHtml(r.cleanEnglishTitle)}</div>` : ''}
                ${searchTag ? `
                  <button type="button" class="btn btn-sm btn-primary" style="margin-top:8px;" onclick="searchAdultByAiTag('${escapeHtml(searchTag)}')">
                    <span>Search Adult Hub for "${escapeHtml(searchTag)}"</span>
                  </button>
                ` : ''}
              </div>
            `;
          }
        } else {
          if (javAiResult) javAiResult.innerHTML = `<div style="color:var(--danger);padding:8px;">${escapeHtml(data.error || 'Image recognition failed')}</div>`;
        }
      } catch (err) {
        if (javAiResult) javAiResult.innerHTML = `<div style="color:var(--danger);padding:8px;">Error: ${escapeHtml(err.message)}</div>`;
      }
    };
    reader.readAsDataURL(file);
  }

  if (javAiDropzone && javAiFileInput) {
    javAiDropzone.addEventListener('click', () => javAiFileInput.click());
    javAiFileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) processJavImageFile(file);
    });

    javAiDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      javAiDropzone.classList.add('drag-over');
    });

    javAiDropzone.addEventListener('dragleave', () => {
      javAiDropzone.classList.remove('drag-over');
    });

    javAiDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      javAiDropzone.classList.remove('drag-over');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) processJavImageFile(file);
    });
  }

  // Japanese Title Translation
  async function handleJavTitleTranslate() {
    const rawTitle = (javRawTitleInput ? javRawTitleInput.value : '').trim();
    if (!rawTitle) {
      showToast('Please enter a Japanese title to translate', 'warning');
      return;
    }

    if (btnJavTranslateSubmit) btnJavTranslateSubmit.disabled = true;
    if (javTranslateResult) {
      javTranslateResult.style.display = 'block';
      javTranslateResult.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:12px;color:var(--text-muted);">
          <div class="ai-feedback-spinner" style="display:inline-block;"></div>
          <span>Translating and removing marketing noise with Gemini AI...</span>
        </div>
      `;
    }

    try {
      const res = await fetch('/api/ai/jav-translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: rawTitle })
      });
      const data = await res.json();
      if (res.ok && data.success && data.translated) {
        const t = data.translated;
        const searchVal = t.code || t.cleanTitle || '';
        if (javTranslateResult) {
          javTranslateResult.innerHTML = `
            <div class="ai-result-card" style="padding:10px;background:rgba(255,255,255,0.03);border-radius:6px;">
              <div class="ai-result-row" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
                ${t.code ? `<span class="ai-pill-tag tag-code">${escapeHtml(t.code)}</span>` : ''}
                ${(t.actresses || []).map(a => `<span class="ai-pill-tag tag-actress">${escapeHtml(a)}</span>`).join('')}
              </div>
              <div style="font-weight:600;margin:6px 0;font-size:0.92rem;color:var(--text-primary);">${escapeHtml(t.cleanTitle || rawTitle)}</div>
              ${t.englishSynopsis ? `<p style="font-size:0.83rem;color:var(--text-muted);margin:4px 0 8px 0;">${escapeHtml(t.englishSynopsis)}</p>` : ''}
              ${searchVal ? `
                <button type="button" class="btn btn-sm btn-primary" onclick="searchAdultByAiTag('${escapeHtml(searchVal)}')">
                  <span>Search Adult Hub for "${escapeHtml(searchVal)}"</span>
                </button>
              ` : ''}
            </div>
          `;
        }
      } else {
        if (javTranslateResult) javTranslateResult.innerHTML = `<div style="color:var(--danger);padding:8px;">${escapeHtml(data.error || 'Translation failed')}</div>`;
      }
    } catch (err) {
      if (javTranslateResult) javTranslateResult.innerHTML = `<div style="color:var(--danger);padding:8px;">Error: ${escapeHtml(err.message)}</div>`;
    } finally {
      if (btnJavTranslateSubmit) btnJavTranslateSubmit.disabled = false;
    }
  }

  if (btnJavTranslateSubmit) {
    btnJavTranslateSubmit.addEventListener('click', handleJavTitleTranslate);
  }
  if (javRawTitleInput) {
    javRawTitleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleJavTitleTranslate();
      }
    });
  }

  // 4. Auto-Subtitles (.srt) Generation
  const modalAiSubsBtn = document.getElementById('modalAiSubsBtn');
  const readyModalAiSubsBtn = document.getElementById('readyModalAiSubsBtn');

  async function handleSubtitleGeneration(jobId, filename, triggerBtn) {
    if (!jobId) {
      showToast('No active download job available for subtitle generation', 'warning');
      return;
    }

    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.setAttribute('data-original-html', triggerBtn.innerHTML);
      triggerBtn.innerHTML = `<div class="ai-feedback-spinner" style="width:13px;height:13px;display:inline-block;margin-right:6px;"></div><span>Transcribing Audio with Gemini...</span>`;
    }
    showToast('Gemini Multimodal AI is transcribing audio & synchronizing SRT subtitles...', 'info');

    try {
      const res = await fetch('/api/ai/generate-subtitles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, language: 'en' })
      });
      const data = await res.json();

      if (res.ok && data.success && data.srt) {
        const srtContent = data.srt;
        const cleanName = (filename || 'video').replace(/\.[^/.]+$/, '');

        // 1. Download .srt file directly
        const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
        const srtUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = srtUrl;
        a.download = `${cleanName}.srt`;
        document.body.appendChild(a);
        a.click();
        a.remove();

        // 2. If in-browser video player is open, convert to WebVTT and attach as active track
        if (html5Player && playerModal && playerModal.style.display !== 'none') {
          try {
            const vttContent = "WEBVTT\n\n" + srtContent.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
            const vttBlob = new Blob([vttContent], { type: 'text/vtt' });
            const vttUrl = URL.createObjectURL(vttBlob);

            Array.from(html5Player.querySelectorAll('track[data-ai="true"]')).forEach(t => t.remove());

            const track = document.createElement('track');
            track.kind = 'subtitles';
            track.label = 'Gemini AI Subtitles (English)';
            track.srclang = 'en';
            track.src = vttUrl;
            track.default = true;
            track.dataset.ai = 'true';
            html5Player.appendChild(track);

            if (html5Player.textTracks && html5Player.textTracks.length > 0) {
              const lastTrack = html5Player.textTracks[html5Player.textTracks.length - 1];
              if (lastTrack) lastTrack.mode = 'showing';
            }
          } catch (trackErr) {
            console.warn('Could not attach WebVTT track to player:', trackErr);
          }
        }

        showToast('✓ AI Subtitles generated successfully and saved as .srt!', 'success');
      } else {
        showToast(data.error || 'Failed to generate subtitles', 'error');
      }
    } catch (err) {
      showToast(`Subtitle generation error: ${err.message}`, 'error');
    } finally {
      if (triggerBtn) {
        triggerBtn.disabled = false;
        const orig = triggerBtn.getAttribute('data-original-html');
        if (orig) triggerBtn.innerHTML = orig;
      }
    }
  }

  if (readyModalAiSubsBtn) {
    readyModalAiSubsBtn.addEventListener('click', () => {
      const job = window.activeReadyJob;
      if (job) {
        handleSubtitleGeneration(job.id, job.filename || job.title, readyModalAiSubsBtn);
      } else {
        showToast('No active download selected', 'warning');
      }
    });
  }

  if (modalAiSubsBtn) {
    modalAiSubsBtn.addEventListener('click', () => {
      const jobId = window.currentPlayingJobId || (window.activeReadyJob ? window.activeReadyJob.id : null);
      const title = modalVideoTitle ? modalVideoTitle.textContent : 'media';
      if (jobId) {
        handleSubtitleGeneration(jobId, title, modalAiSubsBtn);
      } else {
        showToast('No active media stream found for subtitle generation', 'warning');
      }
    });
  }
}

window.searchAdultByAiTag = function(tag) {
  if (!tag) return;
  switchView('adult-search');
  const input = document.getElementById('adultSearchInput');
  if (input) {
    input.value = tag;
  }
  currentAdultQuery = tag;
  currentAdultPage = 1;
  if (typeof executeAdultSearch === 'function') {
    executeAdultSearch();
  }
};

window.aiCleanFilename = async function(rawFilename) {
  if (!rawFilename) return null;
  try {
    const res = await fetch('/api/ai/clean-filename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: rawFilename })
    });
    const data = await res.json();
    if (res.ok && data.success && data.parsed) {
      return data.parsed;
    }
  } catch (e) {
    console.warn('AI clean-filename error:', e);
  }
  return null;
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  initFlacChecker();
  initAdultSearch();
  initMoviesView();
  initMusicView();
  initAiFeatures();
  setupVersionTapEasterEgg();
});

