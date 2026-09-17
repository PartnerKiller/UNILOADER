// Universal Downloader &bull; Online Media Downloader Controller

let currentExtractedData = null;
let activeEventSources = new Map(); // jobId -> EventSource
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
    <div class="toast-icon">${type === 'error' ? '⚠️' : '✓'}</div>
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

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadJobs();
  setInterval(loadJobs, 4000);
});

function setupEventListeners() {
  // Mode Tabs
  tabVideoMode.addEventListener('click', () => setMode('video'));
  tabAudioMode.addEventListener('click', () => setMode('audio'));
  tabBatchMode.addEventListener('click', () => setMode('batch'));

  // Quick Presets (Desktop & Mobile Synchronized)
  presetBestVideo.addEventListener('click', () => applyPreset('bestVideo'));
  presetAudioMp3.addEventListener('click', () => applyPreset('audioMp3'));
  presetAudioFlac.addEventListener('click', () => applyPreset('audioFlac'));
  presetSubtitles.addEventListener('click', () => applyPreset('subtitles'));
  presetSponsorBlock.addEventListener('click', () => applyPreset('sponsorBlock'));

  const mobilePresetSelect = document.getElementById('mobilePresetSelect');
  if (mobilePresetSelect) {
    mobilePresetSelect.addEventListener('change', (e) => applyPreset(e.target.value));
  }

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
}

function switchView(viewName) {
  // Ephemeral Adult Hub:
  // If navigating to ANY other option, immediately hide the Adult Hub buttons from the navigation!
  if (viewName !== 'adult-search') {
    isAdultHubActive = false;
    updateAdultHubVisibility(false);
  } else {
    // Only allow entering adult-search if explicitly triggered by the 7-tap gesture
    if (!isAdultHubActive) {
      viewName = 'downloader';
      updateAdultHubVisibility(false);
    } else {
      updateAdultHubVisibility(true);
    }
  }

  // 1. Hide all view panels and show target panel
  const panels = {
    downloader: document.getElementById('viewDownloader'),
    movies: document.getElementById('viewMovies'),
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
  const mobileSelect = document.getElementById('mobilePresetSelect');
  if (mobileSelect && mobileSelect.value !== presetKey) {
    mobileSelect.value = presetKey;
  }

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
    if (!subLangsInput.value || subLangsInput.value === 'all,-live_chat') {
      subLangsInput.value = 'en.*,hi.*,ja.*';
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
  previewCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// 2. Start Single Download Job
async function startDownload() {
  if (!currentExtractedData) return;

  const payload = {
    url: currentExtractedData.sourceUrl || urlInput.value.trim(),
    hlsUrl: currentExtractedData.hlsUrl,
    downloadTargetUrl: currentExtractedData.downloadTargetUrl,
    title: currentExtractedData.title,
    code: currentExtractedData.code,
    poster: currentExtractedData.poster,
    concurrentFragments: parseInt(concurrencySelect.value, 10) || 8,
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
      throw new Error(data.error || 'Failed to dispatch download');
    }

    previewCard.style.display = 'none';
    urlInput.value = '';
    currentExtractedData = null;

    sessionJobIds.add(data.jobId);
    saveSessionJobs();

    subscribeToJob(data.jobId);
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
    concurrentFragments: parseInt(concurrencySelect.value, 10) || 8
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
      throw new Error(data.error || 'Batch download failed');
    }

    batchUrlsInput.value = '';
    batchCountHint.textContent = '0 URLs detected';

    if (data.jobs) {
      data.jobs.forEach(j => {
        sessionJobIds.add(j.jobId);
        subscribeToJob(j.jobId);
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
      title: 'Download Complete! 🎉',
      body: `${job.title || job.filename || 'Media'} is ready in your Downloads folder.`
    });
  }
}

// 4. SSE Stream Connection for Live Progress with Auto-Reconnect Backoff
function subscribeToJob(jobId, retryCount = 0) {
  if (activeEventSources.has(jobId)) return;

  const es = new EventSource(`/api/jobs/${jobId}/events`);
  activeEventSources.set(jobId, es);

  es.onmessage = (event) => {
    try {
      const job = JSON.parse(event.data);
      updateJobCard(job);

      if (job.status === 'completed') {
        es.close();
        activeEventSources.delete(jobId);
        triggerDeviceDownload(job);
      } else if (job.status === 'failed' || job.status === 'cancelled') {
        es.close();
        activeEventSources.delete(jobId);
      }
    } catch (e) {
      console.error('SSE parse error:', e);
    }
  };

  es.onerror = () => {
    es.close();
    activeEventSources.delete(jobId);
    // If job card is still in downloading state, retry SSE connection with backoff
    const card = document.getElementById(`job-card-${jobId}`);
    if (card && card.classList.contains('downloading') && retryCount < 6) {
      const delay = Math.min(1000 * Math.pow(1.5, retryCount), 8000);
      setTimeout(() => subscribeToJob(jobId, retryCount + 1), delay);
    }
  };
}

// 5. Job List Rendering & Updates
async function loadJobs() {
  try {
    const res = await fetch('/api/jobs');
    const allJobs = await res.json();

    // Auto-remove completed/inactive jobs on refresh:
    // Only display jobs that are actively downloading, paused, queued, OR belong to the current session
    const visibleJobs = allJobs.filter(j => {
      if (j.status === 'downloading' || j.status === 'paused' || j.status === 'queued') return true;
      return sessionJobIds.has(j.id);
    });

    renderJobsList(visibleJobs);
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
    return;
  }

  emptyJobsState.style.display = 'none';

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
    let card = document.getElementById(`job-card-${job.id}`);
    if (!card) {
      card = createJobCardElement(job);
      jobsList.appendChild(card);
    }
    updateJobCard(job);

    if ((job.status === 'downloading' || job.status === 'queued') && !activeEventSources.has(job.id)) {
      subscribeToJob(job.id);
    }
  });
}

function createJobCardElement(job) {
  const card = document.createElement('div');
  card.id = `job-card-${job.id}`;
  card.className = `job-card ${job.status}`;

  const isAudio = job.mode === 'audio';

  card.innerHTML = `
    <div class="job-header">
      <div class="job-header-top">
        <div class="job-badges-row">
          <span class="job-mode-tag ${isAudio ? 'audio' : 'video'}">${isAudio ? 'AUDIO' : 'VIDEO'}</span>
          <span class="job-code">${job.code || 'MEDIA'}</span>
        </div>
        <div class="job-header-right">
          <span class="job-status-badge status-${job.status}" id="job-badge-${job.id}">${job.status === 'completed' ? 'READY' : job.status.toUpperCase()}</span>
          <button type="button" class="btn-job-remove" onclick="removeJob('${job.id}')" title="Remove task">&times;</button>
        </div>
      </div>
      <div class="job-title-group">
        <h4 class="job-title" id="job-title-${job.id}">${job.title}</h4>
        <div class="job-meta">${job.filename} ${job.filesize ? `&bull; ${job.filesize}` : ''}</div>
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
      <pre id="job-logs-content-${job.id}">${job.logs ? job.logs.join('\n') : ''}</pre>
    </div>
  `;

  return card;
}

function renderJobControls(job) {
  try {
    if (job.status === 'completed') {
      const isFlac = (job.filename && job.filename.toLowerCase().endsWith('.flac')) || (job.opts && job.opts.audioFormat === 'flac');
      const directPath = job.filePath ? job.filePath.replace(/\\/g, '\\\\') : '';
      const isElectron = window.electronAPI && window.electronAPI.isElectron;
      const downloadName = escapeHtml(job.filename || 'download');

      return `
        ${isElectron ? `
          <button class="btn btn-primary btn-sm" onclick="openFileInFolder('${directPath}')" title="Open in File Explorer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            <span>Folder</span>
          </button>
        ` : `
          <a href="${job.downloadUrl}" class="btn btn-primary btn-sm" download="${downloadName}" title="Save to Device">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            <span>Save to Device</span>
          </a>
        `}
        <button class="btn btn-secondary btn-sm" onclick="playMediaById('${job.id}')" title="Watch Media">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          <span>Watch</span>
        </button>
        ${isFlac ? `
          <button class="btn btn-flac-verify btn-sm" onclick="inspectFlacFile('${job.id}', '${directPath}')" title="Inspect Lossless FLAC Authenticity">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
            <span>Check FLAC</span>
          </button>
        ` : ''}
      `;
    } else if (job.status === 'cancelled' || job.status === 'failed') {
      return `<button class="btn btn-secondary btn-sm" onclick="removeJob('${job.id}')">Dismiss</button>`;
    } else if (job.status === 'paused') {
      return `
        <button class="btn btn-success btn-sm" onclick="resumeJob('${job.id}')" title="Resume download">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          <span>Resume</span>
        </button>
        <button class="btn btn-danger btn-sm" onclick="cancelJob('${job.id}')" title="Cancel download">Cancel</button>
      `;
    } else if (job.status === 'downloading' || job.status === 'queued') {
      return `
        <button class="btn btn-warning btn-sm" onclick="pauseJob('${job.id}')" title="Pause download">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
          <span>Pause</span>
        </button>
        <button class="btn btn-danger btn-sm" onclick="cancelJob('${job.id}')" title="Cancel download">Cancel</button>
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
  const card = document.getElementById(`job-card-${job.id}`);
  if (!card) return;

  card.className = `job-card ${job.status}`;

  const badge = document.getElementById(`job-badge-${job.id}`);
  if (badge) {
    badge.className = `job-status-badge status-${job.status}`;
    badge.textContent = job.status === 'completed' ? 'READY' : job.status.toUpperCase();
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
  if (logsEl && job.logs) {
    logsEl.textContent = job.logs.join('\n');
    const drawer = document.getElementById(`job-logs-${job.id}`);
    if (drawer && drawer.style.display !== 'none') {
      drawer.scrollTop = drawer.scrollHeight;
    }
  }
}

window.toggleJobLogs = function(jobId) {
  const drawer = document.getElementById(`job-logs-${jobId}`);
  if (drawer) {
    drawer.style.display = drawer.style.display === 'none' ? 'block' : 'none';
    if (drawer.style.display === 'block') {
      drawer.scrollTop = drawer.scrollHeight;
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
      subscribeToJob(jobId);
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

    await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    loadJobs();
  } catch (err) {
    console.warn('Cancel error:', err);
  }
};

window.removeJob = async function(jobId) {
  try {
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
window.playMedia = function(streamUrl, title, downloadUrl) {
  if (!playerModal) return;
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
  fetch('/api/jobs').then(r => r.json()).then(jobs => {
    const job = jobs.find(j => j.id === jobId);
    if (job) {
      playMedia(job.streamUrl, job.title, job.downloadUrl);
    } else {
      playMedia(`/api/stream/${jobId}`, 'Media Player', `/api/download-file/${jobId}`);
    }
  }).catch(() => {
    playMedia(`/api/stream/${jobId}`, 'Media Player', `/api/download-file/${jobId}`);
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
  if (btnInstallApp) {
    btnInstallApp.style.display = 'flex';
    btnInstallApp.addEventListener('click', async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const choiceResult = await deferredInstallPrompt.userChoice;
        if (choiceResult.outcome === 'accepted') {
          showToast('Universal Downloader installed successfully!', 'success');
        }
        deferredInstallPrompt = null;
        btnInstallApp.style.display = 'none';
      }
    });
  }
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

function initGlobalSSEStream() {
  if (typeof EventSource === 'undefined') {
    // Fallback to interval polling
    setInterval(loadJobs, 2500);
    return;
  }

  function connect() {
    sseEventSource = new EventSource('/api/jobs/stream');

    sseEventSource.onmessage = (event) => {
      if (!event.data || event.data.startsWith(':')) return;
      try {
        const jobs = JSON.parse(event.data);
        if (Array.isArray(jobs)) {
          renderJobs(jobs);
        }
      } catch (e) {}
    };

    sseEventSource.onerror = () => {
      sseEventSource.close();
      setTimeout(connect, 4000);
    };
  }

  connect();
}

// Initialize SSE Stream on startup
initGlobalSSEStream();

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

async function initDownloadFolderUI() {
  const sidebarFolderCard = document.getElementById('sidebarFolderCard');
  const isElectron = !!(window.electronAPI && window.electronAPI.isElectron);

  if (!isElectron) {
    if (sidebarFolderCard) sidebarFolderCard.style.display = 'none';
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
  switchView('flac-checker');
  if (directPath) {
    runFlacCheck({ filePath: directPath });
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
      cutEl.style.color = 'hsl(0, 85%, 65%)';
      if (cutHint) cutHint.textContent = 'Lossy compression cutoff detected';
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

      const row = document.createElement('div');
      row.className = 'energy-bar-row';
      row.innerHTML = `
        <div class="energy-bar-header">
          <span class="energy-band-label">${b.label}</span>
          <span class="energy-band-val" style="color: ${isActive ? 'hsl(158, 85%, 48%)' : 'hsl(0, 85%, 65%)'}">
            ${mean > -90 ? `${mean.toFixed(1)} dB (Active)` : 'Silence (Cutoff)'}
          </span>
        </div>
        <div class="energy-track">
          <div class="energy-fill ${isActive ? 'active' : 'dead'}" style="width: ${pct}%"></div>
        </div>
      `;
      barsList.appendChild(row);
    });
  }

  // 4. Spectrogram Image
  const specBox = document.getElementById('flacSpectrogramBox');
  const specImg = document.getElementById('spectrogramImg');
  if (report.spectrogram && specImg) {
    specImg.src = report.spectrogram;
    specBox.style.display = 'block';
  } else if (specBox) {
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
          <div class="empty-icon">🔍</div>
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
        <div class="empty-icon">⚠️</div>
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
    }

    const metaTag = isJav 
      ? `🎬 ${item.size || 'Full Movie'} &bull; ${item.seeders || 0} Seeds`
      : `⏱️ ${item.duration || 'Full Video'} &bull; ${item.quality || 'HD'}`;

    const defaultImg = isJav
      ? 'https://pics.dmm.co.jp/mono/movie/adult/default/defaultpl.jpg'
      : 'data:image/svg+xml;charset=UTF-8,%3Csvg%20width%3D%22400%22%20height%3D%22260%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%23111%22%2F%3E%3Ctext%20x%3D%2250%25%22%20y%3D%2250%25%22%20fill%3D%22%23555%22%20font-size%3D%2224%22%20text-anchor%3D%22middle%22%20dominant-baseline%3D%22middle%22%3ENo%20Cover%3C%2Ftext%3E%3C%2Fsvg%3E';

    const thumbUrl = item.thumb || defaultImg;

    return `
      <div class="adult-card ${isTeaser ? 'card-teaser' : ''}" data-index="${idx}">
        <div class="adult-card-media">
          <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(item.title)}" class="adult-card-thumb" loading="lazy" onerror="this.src='${defaultImg}'" />
          ${item.previewVideo ? `
            <video class="adult-card-hover-video" muted loop playsinline preload="none" data-src="${escapeHtml(item.previewVideo)}"></video>
          ` : ''}
          <div class="adult-card-badges">
            <span class="adult-badge ${badgeClass}">${sourceLabel}</span>
            ${item.code ? `<span class="adult-badge badge-code">${escapeHtml(item.code)}</span>` : ''}
            ${isTeaser ? `<span class="adult-badge badge-teaser">⚠️ Short Clip</span>` : ''}
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
  meta.innerHTML = `${(item.provider || '').toUpperCase()} &bull; ${item.duration || item.size || 'HD'} &bull; ${item.quality || (isJav ? 'Studio Master' : 'HD')}`;

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
// Easter Egg: Tap Version 7 Times to Unlock & Open Adult & JAV Hub
// ==========================================================================

let versionTapCount = 0;
let versionTapTimeout = null;
let isAdultHubActive = false;

function isAdultHubUnlocked() {
  return isAdultHubActive;
}

function updateAdultHubVisibility(visible) {
  const sidebarBtn = document.getElementById('navAdultSearch');
  const bottomBtn = document.getElementById('bottomNavAdultSearch');
  if (sidebarBtn) {
    sidebarBtn.style.display = visible ? 'flex' : 'none';
  }
  if (bottomBtn) {
    bottomBtn.style.display = visible ? 'flex' : 'none';
  }
}

function setupVersionTapEasterEgg() {
  // Purge any lingering localStorage key so it never persists across reloads
  try {
    localStorage.removeItem('adult_hub_unlocked');
  } catch (e) {}

  // Strictly hidden by default on every page load and reload
  isAdultHubActive = false;
  updateAdultHubVisibility(false);

  const versionTags = document.querySelectorAll('.version-tag');
  versionTags.forEach(tag => {
    tag.style.cursor = 'pointer';
    tag.style.userSelect = 'none';

    tag.addEventListener('click', (e) => {
      e.preventDefault();
      versionTapCount++;
      clearTimeout(versionTapTimeout);

      versionTapTimeout = setTimeout(() => {
        versionTapCount = 0;
      }, 3500);

      if (versionTapCount >= 7) {
        versionTapCount = 0;
        clearTimeout(versionTapTimeout);

        // Temporarily reveal and open Adult Hub for this session
        isAdultHubActive = true;
        updateAdultHubVisibility(true);

        showToast('🔞 Adult & JAV Hub Opened!', 'success');
        switchView('adult-search');

        const navBtn = document.getElementById('navAdultSearch');
        if (navBtn) {
          navBtn.classList.add('pulse-highlight');
          setTimeout(() => navBtn.classList.remove('pulse-highlight'), 2000);
        }
      } else if (versionTapCount >= 4) {
        const remaining = 7 - versionTapCount;
        showToast(`Tap ${remaining} more time${remaining > 1 ? 's' : ''} to reveal hidden options...`, 'info');
      }
    });
  });

  // Lock Hub button in Adult Hub header
  const lockBtn = document.getElementById('btnLockAdultHub');
  if (lockBtn) {
    lockBtn.addEventListener('click', () => {
      isAdultHubActive = false;
      updateAdultHubVisibility(false);
      showToast('Adult & JAV Hub hidden from navigation', 'info');
      switchView('downloader');
    });
  }
}

// ==========================================================================
// MOVIE & TV SHOW HUB CONTROLLER (OlaMovies & Torrents Dual-Pipeline)
// ==========================================================================

let currentMovieResults = [];
let currentMoviePage = 1;
let currentMovieQuery = '';
let currentMovieSource = 'olamovies';
let currentMovieQuality = 'all';

function initMoviesView() {
  const form = document.getElementById('movieSearchForm');
  const input = document.getElementById('movieSearchInput');
  const clearBtn = document.getElementById('btnClearMovieSearch');
  const sourceTabs = document.getElementById('movieSourceTabs');
  const qualityFilters = document.getElementById('movieQualityFilters');
  const quickTags = document.getElementById('movieQuickTags');
  const prevBtn = document.getElementById('btnMoviePrevPage');
  const nextBtn = document.getElementById('btnMovieNextPage');
  const modalClose = document.getElementById('btnCloseMovieReleasesModal');
  const modal = document.getElementById('movieReleasesModal');

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
      currentMovieSource = btn.dataset.source || 'olamovies';
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

  if (quickTags) {
    quickTags.addEventListener('click', (e) => {
      const chip = e.target.closest('.movie-quick-chip');
      if (!chip) return;
      const q = chip.dataset.query;
      if (!q) return;
      if (input) {
        input.value = q;
        if (clearBtn) clearBtn.style.display = 'block';
      }
      currentMoviePage = 1;
      executeMovieSearch(q, currentMoviePage);
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
          <div class="empty-icon">🔍</div>
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
        <div class="empty-icon">⚠️</div>
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

  const defaultPoster = 'data:image/svg+xml;charset=UTF-8,%3Csvg%20width%3D%22300%22%20height%3D%22450%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%2312151c%22%2F%3E%3Ctext%20x%3D%2250%25%22%20y%3D%2248%25%22%20fill%3D%22%234a5568%22%20font-size%3D%2242%22%20text-anchor%3D%22middle%22%20dominant-baseline%3D%22middle%22%3E🎬%3C%2Ftext%3E%3Ctext%20x%3D%2250%25%22%20y%3D%2260%25%22%20fill%3D%22%23718096%22%20font-size%3D%2216%22%20text-anchor%3D%22middle%22%20font-family%3D%22sans-serif%22%3ENo%20Poster%3C%2Ftext%3E%3C%2Fsvg%3E';

  grid.innerHTML = items.map((item, idx) => {
    const isOla = item.provider === 'olamovies';
    const isYts = item.provider === 'yts';
    const isTorrent = item.provider === 'torrent';

    let providerBadge = 'OlaMovies';
    let providerClass = 'badge-provider-ola';
    if (isYts) {
      providerBadge = 'YTS 4K';
      providerClass = 'badge-provider-yts';
    } else if (isTorrent) {
      providerBadge = 'BitTorrent';
      providerClass = 'badge-provider-torrent';
    }

    const posterUrl = item.poster || defaultPoster;
    const yearText = item.year ? `${item.year}` : '';
    const ratingText = item.rating ? `⭐ ${item.rating}` : '';

    const has4K = (item.releases || []).some(r => /4k|2160p/i.test(r.quality || r.label));
    const has1080p = (item.releases || []).some(r => /1080p/i.test(r.quality || r.label));
    const has720p = (item.releases || []).some(r => /720p/i.test(r.quality || r.label));
    const hasMultiAudio = (item.releases || []).some(r => r.isMultiAudio);

    const bestRelease = (item.releases && item.releases[0]) || null;
    const can1Click = bestRelease && (bestRelease.magnet || bestRelease.torrentUrl || item.torrentFallback);
    const releaseCount = item.releasesCount || (item.releases ? item.releases.length : 0);

    return `
      <div class="movie-card" data-index="${idx}">
        <div class="movie-card-media">
          <img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(item.title)}" class="movie-card-poster" loading="lazy" onerror="this.src='${defaultPoster}'" />
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
          <h4 class="movie-card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h4>
          
          <div class="movie-card-meta-line">
            ${isOla && item.torrentFallback ? `
              <span class="movie-meta-item meta-fallback" title="High-speed BitTorrent stream available for 1-click download">⚡ Torrent Ready</span>
            ` : ''}
            ${bestRelease && bestRelease.size ? `
              <span class="movie-meta-item meta-size">💾 ${escapeHtml(bestRelease.size)}</span>
            ` : ''}
            ${bestRelease && bestRelease.seeders !== undefined ? `
              <span class="movie-meta-item meta-seeds" title="Active BitTorrent Seeders">🟢 ${bestRelease.seeders} Seeds</span>
            ` : ''}
          </div>

          <div class="movie-card-actions">
            ${can1Click ? `
              <button type="button" class="btn btn-primary btn-sm movie-dl-btn" id="btnMovieDl_${idx}" onclick="dispatchMovieDownload(${idx})">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                <span>1-Click Download</span>
              </button>
            ` : ''}

            ${releaseCount > 0 ? `
              <button type="button" class="btn ${can1Click ? 'btn-secondary' : 'btn-primary'} btn-sm movie-options-btn" onclick="openMovieReleasesModal(${idx})">
                <span>📦 Releases (${releaseCount})</span>
              </button>
            ` : ''}

            ${isOla && item.link ? `
              <a href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm movie-link-btn" title="Open OlaMovies page for direct Google Drive / fast links">
                <span>🔗 Ola Link</span>
              </a>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

window.dispatchMovieDownload = async function(idx, releaseIdx = 0) {
  const item = currentMovieResults[idx];
  if (!item) return;

  const release = (item.releases && item.releases[releaseIdx]) || item.torrentFallback || {};
  const isTorrent = !!(release.magnet || release.torrentUrl || item.torrentFallback);

  const payload = {
    title: release.filename || item.title,
    poster: item.poster || '',
    quality: release.quality || 'best',
    magnet: release.magnet || (item.torrentFallback && item.torrentFallback.magnet),
    torrentUrl: release.torrentUrl || (item.torrentFallback && item.torrentFallback.torrentUrl),
    url: release.href || release.magnet || release.torrentUrl,
    provider: release.provider || item.provider,
    type: isTorrent ? 'torrent' : 'video'
  };

  const btn = document.getElementById(`btnMovieDl_${idx}`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span>Starting Download...</span>`;
  }

  try {
    const res = await fetch('/api/movies/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Added to Download Queue: ${item.title.substring(0, 30)}...`, 'success');
      if (btn) {
        btn.innerHTML = `<span>✓ Enqueued</span>`;
        btn.classList.add('btn-success');
      }
      const modal = document.getElementById('movieReleasesModal');
      if (modal) modal.style.display = 'none';
    } else {
      showToast(data.error || 'Failed to start download', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<span>1-Click Download</span>`;
      }
    }
  } catch (err) {
    showToast(`Download error: ${err.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<span>1-Click Download</span>`;
    }
  }
};

window.openMovieReleasesModal = function(idx) {
  const item = currentMovieResults[idx];
  if (!item) return;

  const modal = document.getElementById('movieReleasesModal');
  const titleEl = document.getElementById('movieModalTitle');
  const badgeEl = document.getElementById('movieModalProviderBadge');
  const listEl = document.getElementById('movieReleasesList');
  if (!modal || !listEl) return;

  if (titleEl) titleEl.textContent = item.title;
  if (badgeEl) {
    badgeEl.textContent = item.provider === 'olamovies' ? 'OlaMovies HD' : (item.provider === 'yts' ? 'YTS 4K' : 'BitTorrent');
  }

  listEl.innerHTML = (item.releases || []).map((rel, rIdx) => {
    return `
      <div class="movie-release-item">
        <div class="release-info">
          <div class="release-primary-row">
            <span class="release-badge badge-${(rel.quality || '1080p').toLowerCase().replace(/[^a-z0-9]/g, '')}">${escapeHtml(rel.quality || 'HD')}</span>
            <span class="release-label">${escapeHtml(rel.label || rel.filename)}</span>
          </div>
          <div class="release-secondary-row">
            ${rel.size ? `<span class="release-size">💾 ${escapeHtml(rel.size)}</span>` : ''}
            ${rel.seeders !== undefined ? `<span class="release-seeds">🟢 ${rel.seeders} Seeds</span>` : ''}
            ${rel.isMultiAudio ? `<span class="release-tag">Multi-Audio</span>` : ''}
            ${rel.isHevc ? `<span class="release-tag">HEVC 10-bit</span>` : ''}
            ${rel.isHdr ? `<span class="release-tag">HDR / DV</span>` : ''}
          </div>
        </div>
        <div class="release-actions">
          ${rel.magnet || rel.torrentUrl ? `
            <button type="button" class="btn btn-primary btn-sm btn-rel-dl" onclick="dispatchMovieDownload(${idx}, ${rIdx})">
              <span>⚡ Download</span>
            </button>
          ` : ''}
          ${rel.href ? `
            <a href="${escapeHtml(rel.href)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm btn-rel-link" title="Open OlaMovies fast link">
              <span>⚡ Get Link</span>
            </a>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  modal.style.display = 'flex';
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  initFlacChecker();
  initAdultSearch();
  initMoviesView();
  setupVersionTapEasterEgg();
});
