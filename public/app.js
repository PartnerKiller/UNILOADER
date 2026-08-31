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
  // 1. Hide all view panels and show target panel
  const panels = {
    downloader: document.getElementById('viewDownloader'),
    vault: document.getElementById('viewVault'),
    supported: document.getElementById('viewSupported'),
    about: document.getElementById('viewAbout')
  };

  Object.keys(panels).forEach(key => {
    if (panels[key]) {
      if (key === viewName) {
        panels[key].style.display = 'block';
        panels[key].classList.add('active');
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

  if (viewName === 'vault') {
    renderVaultItems();
  }

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
  previewPoster.src = data.poster || 'https://assets-cdn.jable.tv/contents/videos_screenshots/51000/51638/preview.jpg';
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
    if (audioFormatSelect) audioFormatSelect.value = 'mp3';
    if (audioBitrateSelect) audioBitrateSelect.value = '320k';
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

// 3. Trigger Browser Download & Show Ready Popup
function triggerDeviceDownload(job) {
  activeReadyJob = job;

  if (readyModalTitle) readyModalTitle.textContent = job.filename || job.title || 'Download Ready';
  if (readyModalSize) readyModalSize.textContent = job.filesize ? `Size: ${job.filesize}` : '';

  if (readyModalSaveBtn) {
    readyModalSaveBtn.href = job.downloadUrl;
    readyModalSaveBtn.setAttribute('download', job.filename || 'download');
  }

  if (readyModal) readyModal.style.display = 'flex';

  // Automatically trigger native browser file save
  try {
    const autoAnchor = document.createElement('a');
    autoAnchor.href = job.downloadUrl;
    autoAnchor.setAttribute('download', job.filename || 'download');
    document.body.appendChild(autoAnchor);
    autoAnchor.click();
    document.body.removeChild(autoAnchor);
  } catch (e) {}
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
    // Only display jobs that are actively downloading OR belong to the current session
    const visibleJobs = allJobs.filter(j => {
      if (j.status === 'downloading') return true;
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
    return;
  }

  emptyJobsState.style.display = 'none';

  const activeJobs = jobs.filter(j => j.status === 'downloading');
  activeCountLabel.textContent = `${activeJobs.length} Active`;
  
  if (activeJobs.length > 0) {
    queueStatusIndicator.querySelector('.status-dot').classList.add('active');
  } else {
    queueStatusIndicator.querySelector('.status-dot').classList.remove('active');
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

    if (job.status === 'downloading' && !activeEventSources.has(job.id)) {
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
        <span class="metric-value" id="job-metric-frag-${job.id}">${job.filesize || job.progress.totalSize || 'Processing'}</span>
      </div>
    </div>

    <!-- Actions & Drawer Toggle -->
    <div class="job-actions">
      <button class="btn-log-toggle" onclick="toggleJobLogs('${job.id}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
        <span>Toggle Logs</span>
      </button>
      <div class="job-controls" id="job-controls-${job.id}">
        ${job.status === 'downloading' ? `
          <button class="btn btn-danger" onclick="cancelJob('${job.id}')">Cancel</button>
        ` : ''}
        ${job.status === 'completed' ? `
          <a href="${job.downloadUrl}" class="btn btn-primary btn-sm" download>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            <span>Save to Device</span>
          </a>
          <button class="btn btn-secondary btn-sm" onclick="playMediaById('${job.id}')">
            <span>Watch</span>
          </button>
        ` : ''}
        ${job.status === 'cancelled' || job.status === 'failed' ? `
          <button class="btn btn-secondary btn-sm" onclick="removeJob('${job.id}')">Dismiss</button>
        ` : ''}
      </div>
    </div>

    <!-- Collapsible Log Drawer -->
    <div class="log-drawer" id="job-logs-${job.id}" style="display: none;">
      <pre id="job-logs-content-${job.id}">${job.logs ? job.logs.join('\n') : ''}</pre>
    </div>
  `;

  return card;
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
  if (eta) eta.textContent = job.progress.eta || (job.status === 'completed' ? 'Ready' : '--:--');

  const frag = document.getElementById(`job-metric-frag-${job.id}`);
  if (frag) {
    frag.textContent = job.filesize || job.progress.totalSize || 'Ready';
  }

  // Update controls
  const controls = document.getElementById(`job-controls-${job.id}`);
  if (controls) {
    if (job.status === 'completed') {
      controls.innerHTML = `
        <a href="${job.downloadUrl}" class="btn btn-primary btn-sm" download>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          <span>Save to Device</span>
        </a>
        <button class="btn btn-secondary btn-sm" onclick="playMediaById('${job.id}')">
          <span>Watch</span>
        </button>
      `;
    } else if (job.status === 'cancelled' || job.status === 'failed') {
      controls.innerHTML = `
        <button class="btn btn-secondary btn-sm" onclick="removeJob('${job.id}')">Dismiss</button>
      `;
    } else if (job.status === 'downloading') {
      controls.innerHTML = `
        <button class="btn btn-danger" onclick="cancelJob('${job.id}')">Cancel</button>
      `;
    }
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
          // Check completed jobs and save to client Vault
          jobs.forEach(j => {
            if (j.status === 'completed' && sessionJobIds.has(j.id)) {
              saveJobToVault(j);
            }
          });
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

// ==========================================================================
// 9. Client-Side Private Media Vault (IndexedDB)
// ==========================================================================

const DB_NAME = 'UniversalMediaVaultDB';
const DB_VERSION = 1;
const STORE_NAME = 'media_items';
let vaultDB = null;

function initVaultDB() {
  return new Promise((resolve) => {
    if (!window.indexedDB) return resolve(null);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('platform', 'platform', { unique: false });
      }
    };
    req.onsuccess = (e) => {
      vaultDB = e.target.result;
      resolve(vaultDB);
    };
    req.onerror = () => resolve(null);
  });
}

async function saveJobToVault(job) {
  if (!vaultDB || !job || !job.id) return;
  try {
    let platform = 'Universal';
    const titleLower = (job.title || '').toLowerCase();
    if (titleLower.includes('spotify') || job.mode === 'audio') platform = 'Spotify';
    else if (titleLower.includes('tiktok')) platform = 'TikTok';
    else if (titleLower.includes('instagram')) platform = 'Instagram';
    else if (titleLower.includes('youtube')) platform = 'YouTube';

    const item = {
      id: job.id,
      title: job.title || 'Downloaded Media',
      filename: job.filename || 'media',
      filesize: job.filesize || '',
      mode: job.mode || 'video',
      platform,
      downloadUrl: job.downloadUrl || `/api/download-file/${job.id}`,
      streamUrl: job.streamUrl || `/api/stream/${job.id}`,
      timestamp: Date.now()
    };

    const tx = vaultDB.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(item);
  } catch (e) {}
}

async function getVaultItems() {
  if (!vaultDB) await initVaultDB();
  if (!vaultDB) return [];

  return new Promise((resolve) => {
    try {
      const tx = vaultDB.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result || []).reverse());
      req.onerror = () => resolve([]);
    } catch (e) {
      resolve([]);
    }
  });
}

const vaultSearchInput = document.getElementById('vaultSearchInput');
const vaultGridList = document.getElementById('vaultGridList');
const vaultEmptyState = document.getElementById('vaultEmptyState');
const btnClearVaultBtn = document.getElementById('btnClearVaultBtn');
let currentVaultFilter = 'all';

async function renderVaultItems() {
  const items = await getVaultItems();
  const query = vaultSearchInput ? vaultSearchInput.value.trim().toLowerCase() : '';

  const filtered = items.filter(item => {
    if (currentVaultFilter !== 'all') {
      const p = (item.platform || '').toLowerCase();
      if (!p.includes(currentVaultFilter)) return false;
    }
    if (query) {
      const t = (item.title || '').toLowerCase();
      return t.includes(query);
    }
    return true;
  });

  if (!vaultGridList) return;

  if (filtered.length === 0) {
    vaultGridList.innerHTML = '';
    if (vaultEmptyState) {
      vaultGridList.appendChild(vaultEmptyState);
      vaultEmptyState.style.display = 'block';
    }
    return;
  }

  vaultGridList.innerHTML = filtered.map(item => `
    <div class="vault-card">
      <div class="vault-card-top">
        <div class="vault-thumb-wrap">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-primary);">
            ${item.mode === 'audio' ? '<path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>' : '<polygon points="5 3 19 12 5 21 5 3"></polygon>'}
          </svg>
        </div>
        <div class="vault-meta">
          <h4 class="vault-item-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h4>
          <div class="vault-item-tags">
            <span class="vault-source-badge">${escapeHtml(item.platform)}</span>
            <span class="vault-size-badge">${escapeHtml(item.filesize || '')}</span>
          </div>
        </div>
      </div>
      <div class="vault-card-actions">
        <button type="button" class="btn btn-secondary btn-sm" onclick="playMedia('${escapeHtml(item.streamUrl)}', '${escapeHtml(item.title)}', '${escapeHtml(item.downloadUrl)}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          <span>Preview</span>
        </button>
        <a href="${escapeHtml(item.downloadUrl)}" class="btn btn-primary btn-sm" download>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          <span>Save</span>
        </a>
      </div>
    </div>
  `).join('');
}

if (vaultSearchInput) {
  vaultSearchInput.addEventListener('input', renderVaultItems);
}

document.querySelectorAll('.vault-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.vault-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentVaultFilter = chip.getAttribute('data-filter') || 'all';
    renderVaultItems();
  });
});

if (btnClearVaultBtn) {
  btnClearVaultBtn.addEventListener('click', () => {
    if (!vaultDB) return;
    try {
      const tx = vaultDB.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => {
        showToast('Media vault cleared', 'info');
        renderVaultItems();
      };
    } catch (e) {}
  });
}

// Initialize Vault DB and SSE on startup
initVaultDB();
initGlobalSSEStream();


