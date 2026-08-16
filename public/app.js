// JAV-Downloader & Vortex Hub - Universal Frontend Controller

let currentExtractedData = null;
let activeEventSources = new Map(); // jobId -> EventSource
let targetDirectory = '';
let isConfigured = false;
let currentMode = 'video'; // 'video' | 'audio' | 'batch'
let libraryMedia = [];
let serverPlatform = 'win32';

// DOM Elements
const urlInput = document.getElementById('urlInput');
const fetchBtn = document.getElementById('fetchBtn');
const fetchSpinner = document.getElementById('fetchSpinner');
const pasteBtn = document.getElementById('pasteBtn');
const sampleLinkBtn = document.getElementById('sampleLinkBtn');
const samplePhBtn = document.getElementById('samplePhBtn');

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
const destinationInput = document.getElementById('destinationInput');
const concurrencySelect = document.getElementById('concurrencySelect');
const customFilenameInput = document.getElementById('customFilenameInput');
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

// Library
const libraryGrid = document.getElementById('libraryGrid');
const libraryFolderLabel = document.getElementById('libraryFolderLabel');
const librarySearchInput = document.getElementById('librarySearchInput');
const refreshLibraryBtn = document.getElementById('refreshLibraryBtn');
const openFolderBtn = document.getElementById('openFolderBtn');
const storageVal = document.getElementById('storageVal');
const targetDriveName = document.getElementById('targetDriveName');

// Player Modal
const videoModal = document.getElementById('videoModal');
const html5Player = document.getElementById('html5Player');
const modalVideoTitle = document.getElementById('modalVideoTitle');
const modalFileInfo = document.getElementById('modalFileInfo');
const closeModalBtn = document.getElementById('closeModalBtn');
const openInExplorerModalBtn = document.getElementById('openInExplorerModalBtn');

// Settings Modal
const settingsModal = document.getElementById('settingsModal');
const settingsBtn = document.getElementById('settingsBtn');
const closeSettingsModalBtn = document.getElementById('closeSettingsModalBtn');
const settingsDirInput = document.getElementById('settingsDirInput');
const quickDirsChips = document.getElementById('quickDirsChips');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const settingsStatusMsg = document.getElementById('settingsStatusMsg');
const settingsModalTitle = document.getElementById('settingsModalTitle');

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await loadServerConfig();
  loadStorageInfo();
  loadLibrary();
  loadJobs();

  setInterval(loadStorageInfo, 20000);
  setInterval(loadJobs, 4000);
});

async function loadServerConfig() {
  try {
    const configRes = await fetch('/api/config');
    const config = await configRes.json();
    serverPlatform = config.platform || 'win32';
    targetDirectory = config.downloadDir || '';
    isConfigured = config.isConfigured || false;

    renderSuggestedPaths();

    if (isConfigured && targetDirectory) {
      if (destinationInput) destinationInput.value = targetDirectory;
      if (libraryFolderLabel) libraryFolderLabel.textContent = targetDirectory;
      if (settingsDirInput) settingsDirInput.value = targetDirectory;
    } else {
      // First-run: prompt user to configure download directory
      openSettingsModal(true);
    }
  } catch (e) {
    console.warn('Failed to load server config:', e);
  }
}

function renderSuggestedPaths() {
  quickDirsChips.innerHTML = '';
  const suggestions = serverPlatform === 'win32'
    ? ['C:\\Downloads', 'C:\\Videos']
    : ['/var/downloads', '/tmp/downloads'];

  suggestions.forEach(pathVal => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'quick-dir-chip';
    chip.textContent = pathVal;
    chip.addEventListener('click', () => {
      settingsDirInput.value = pathVal;
    });
    quickDirsChips.appendChild(chip);
  });
}

function openSettingsModal(isFirstRun = false) {
  settingsModalTitle.textContent = isFirstRun ? 'Welcome! Set Your Download Directory' : 'Configure Download Directory';
  settingsDirInput.value = targetDirectory;
  settingsStatusMsg.textContent = '';
  settingsModal.style.display = 'flex';
}

function closeSettingsModal() {
  if (!isConfigured && !targetDirectory) {
    alert('Please configure a download directory to use the application.');
    return;
  }
  settingsModal.style.display = 'none';
}

async function saveSettings() {
  const dirPath = settingsDirInput.value.trim();
  if (!dirPath) {
    alert('Please enter a valid directory path.');
    return;
  }

  saveSettingsBtn.disabled = true;
  settingsStatusMsg.textContent = 'Saving...';

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadDir: dirPath })
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Failed to save configuration');
    }

    targetDirectory = data.downloadDir;
    isConfigured = true;
    destinationInput.value = targetDirectory;
    libraryFolderLabel.textContent = targetDirectory;

    settingsStatusMsg.textContent = 'Saved successfully!';
    setTimeout(() => {
      settingsModal.style.display = 'none';
      saveSettingsBtn.disabled = false;
      loadLibrary();
      loadStorageInfo();
    }, 600);
  } catch (err) {
    alert(`Error: ${err.message}`);
    saveSettingsBtn.disabled = false;
    settingsStatusMsg.textContent = '';
  }
}

function setupEventListeners() {
  // Settings Modal
  settingsBtn.addEventListener('click', () => openSettingsModal(false));
  closeSettingsModalBtn.addEventListener('click', closeSettingsModal);
  saveSettingsBtn.addEventListener('click', saveSettings);
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsModal();
  });

  // Mode Tabs
  tabVideoMode.addEventListener('click', () => setMode('video'));
  tabAudioMode.addEventListener('click', () => setMode('audio'));
  tabBatchMode.addEventListener('click', () => setMode('batch'));

  // Quick Presets
  presetBestVideo.addEventListener('click', () => {
    setMode('video');
    videoQualitySelect.value = 'best';
    videoFormatSelect.value = 'mp4';
    chkEmbedThumbnail.checked = true;
    highlightPreset(presetBestVideo);
  });

  presetAudioMp3.addEventListener('click', () => {
    setMode('audio');
    audioFormatSelect.value = 'mp3';
    audioBitrateSelect.value = '320k';
    chkEmbedThumbnail.checked = true;
    highlightPreset(presetAudioMp3);
  });

  presetAudioFlac.addEventListener('click', () => {
    setMode('audio');
    audioFormatSelect.value = 'flac';
    chkEmbedThumbnail.checked = true;
    highlightPreset(presetAudioFlac);
  });

  presetSubtitles.addEventListener('click', () => {
    setMode('video');
    chkEmbedSubtitles.checked = true;
    chkAutoSubs.checked = true;
    highlightPreset(presetSubtitles);
  });

  presetSponsorBlock.addEventListener('click', () => {
    chkSponsorBlock.checked = !chkSponsorBlock.checked;
    if (chkSponsorBlock.checked) highlightPreset(presetSponsorBlock);
    else presetSponsorBlock.classList.remove('active');
  });

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

  // Sample links
  sampleLinkBtn.addEventListener('click', () => {
    urlInput.value = sampleLinkBtn.dataset.url;
    fetchVideoMetadata();
  });

  if (samplePhBtn) {
    samplePhBtn.addEventListener('click', () => {
      urlInput.value = samplePhBtn.dataset.url;
      fetchVideoMetadata();
    });
  }

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

  // Open destination folder
  openFolderBtn.addEventListener('click', () => openFolderInExplorer(targetDirectory));
  openInExplorerModalBtn.addEventListener('click', () => openFolderInExplorer(targetDirectory));

  // Refresh library
  refreshLibraryBtn.addEventListener('click', loadLibrary);

  // Search filter
  librarySearchInput.addEventListener('input', (e) => {
    filterLibrary(e.target.value);
  });

  // Close modal
  closeModalBtn.addEventListener('click', closePlayerModal);
  videoModal.addEventListener('click', (e) => {
    if (e.target === videoModal) closePlayerModal();
  });

  // Destination folder input changes
  destinationInput.addEventListener('change', (e) => {
    targetDirectory = e.target.value.trim() || targetDirectory;
    libraryFolderLabel.textContent = targetDirectory;
    loadLibrary();
  });
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
    downloadBtnText.textContent = isAudio ? 'Extract Audio' : 'Start Download';
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
    alert(`Error: ${err.message}`);
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

  destinationInput.value = targetDirectory;
  customFilenameInput.value = '';

  previewCard.style.display = 'block';
  previewCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// 2. Start Single Download Job
async function startDownload() {
  if (!currentExtractedData) return;

  const saveFolder = destinationInput.value.trim() || targetDirectory;
  if (!saveFolder) {
    openSettingsModal(true);
    return;
  }
  targetDirectory = saveFolder;
  libraryFolderLabel.textContent = saveFolder;

  const payload = {
    url: currentExtractedData.sourceUrl || urlInput.value.trim(),
    hlsUrl: currentExtractedData.hlsUrl,
    downloadTargetUrl: currentExtractedData.downloadTargetUrl,
    title: currentExtractedData.title,
    code: currentExtractedData.code,
    poster: currentExtractedData.poster,
    outputDir: saveFolder,
    customFilename: customFilenameInput.value.trim(),
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
  downloadBtnText.textContent = 'Starting...';

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

    subscribeToJob(data.jobId);
    loadJobs();
  } catch (err) {
    alert(`Download Error: ${err.message}`);
  } finally {
    startDownloadBtn.disabled = false;
    downloadBtnText.textContent = currentMode === 'audio' ? 'Extract Audio' : 'Start Download';
  }
}

// 2b. Start Batch Download
async function startBatchDownload() {
  const urls = batchUrlsInput.value.split('\n').map(u => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    alert('Please enter at least one URL');
    return;
  }

  const saveFolder = destinationInput.value.trim() || targetDirectory;
  if (!saveFolder) {
    openSettingsModal(true);
    return;
  }

  const options = {
    outputDir: saveFolder,
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
  startBatchBtn.querySelector('span').textContent = 'Dispatching queue...';

  try {
    const res = await fetch('/api/download/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls, options })
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Batch download failed');
    }

    batchUrlsInput.value = '';
    batchCountHint.textContent = '0 URLs detected';

    if (data.jobs) {
      data.jobs.forEach(j => subscribeToJob(j.jobId));
    }
    loadJobs();
    setMode('video');
  } catch (err) {
    alert(`Batch Error: ${err.message}`);
  } finally {
    startBatchBtn.disabled = false;
    startBatchBtn.querySelector('span').textContent = 'Download All in Queue';
  }
}

// 3. SSE Stream Connection for Live Progress
function subscribeToJob(jobId) {
  if (activeEventSources.has(jobId)) return;

  const es = new EventSource(`/api/jobs/${jobId}/events`);
  activeEventSources.set(jobId, es);

  es.onmessage = (event) => {
    try {
      const job = JSON.parse(event.data);
      updateJobCard(job);

      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        es.close();
        activeEventSources.delete(jobId);
        loadLibrary();
        loadStorageInfo();
      }
    } catch (e) {
      console.error('SSE parse error:', e);
    }
  };

  es.onerror = () => {
    es.close();
    activeEventSources.delete(jobId);
  };
}

// 4. Job List Rendering & Updates
async function loadJobs() {
  try {
    const res = await fetch('/api/jobs');
    const jobs = await res.json();
    renderJobsList(jobs);
  } catch (err) {
    console.warn('Failed to load jobs:', err);
  }
}

function renderJobsList(jobs) {
  if (!jobs || jobs.length === 0) {
    emptyJobsState.style.display = 'block';
    activeCountLabel.textContent = '0 Active Jobs';
    queueStatusIndicator.querySelector('.status-dot').classList.remove('active');
    return;
  }

  emptyJobsState.style.display = 'none';

  const activeJobs = jobs.filter(j => j.status === 'downloading');
  activeCountLabel.textContent = `${activeJobs.length} Active Job${activeJobs.length === 1 ? '' : 's'}`;
  
  if (activeJobs.length > 0) {
    queueStatusIndicator.querySelector('.status-dot').classList.add('active');
  } else {
    queueStatusIndicator.querySelector('.status-dot').classList.remove('active');
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
      <div class="job-title-group">
        <div class="job-code-title">
          <span class="job-mode-tag ${isAudio ? 'audio' : 'video'}">${isAudio ? 'AUDIO' : 'VIDEO'}</span>
          <span class="job-code">${job.code || 'MEDIA'}</span>
          <span class="job-title" id="job-title-${job.id}">${job.title}</span>
        </div>
        <div class="job-meta">Destination: <strong>${job.outputDir}</strong> &bull; File: <code>${job.filename}</code></div>
      </div>
      <span class="job-status-badge status-${job.status}" id="job-badge-${job.id}">${job.status}</span>
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
        <span class="metric-label">Fragments / Size</span>
        <span class="metric-value" id="job-metric-frag-${job.id}">${job.progress.currentFrag || 0} / ${job.progress.totalFrag || 0}</span>
      </div>
    </div>

    <!-- Actions & Drawer Toggle -->
    <div class="job-actions">
      <button class="btn-log-toggle" onclick="toggleJobLogs('${job.id}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
        <span>Toggle Live Logs</span>
      </button>
      <div class="job-controls">
        ${job.status === 'downloading' ? `
          <button class="btn btn-danger" onclick="cancelJob('${job.id}')">Cancel</button>
        ` : ''}
        ${job.status === 'completed' ? `
          <button class="btn btn-secondary btn-sm" onclick="playMedia('${job.outputDir.replace(/\\/g, '\\\\') + (job.outputDir.endsWith('\\') || job.outputDir.endsWith('/') ? '' : '/') + job.filename.replace(/\\/g, '\\\\')}', '${job.title.replace(/'/g, "\\'")}')">Play Now</button>
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
    badge.textContent = job.status;
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
  if (eta) eta.textContent = job.progress.eta || (job.status === 'completed' ? 'Done' : '--:--');

  const frag = document.getElementById(`job-metric-frag-${job.id}`);
  if (frag) {
    if (job.progress.totalFrag > 0) {
      frag.textContent = `${job.progress.currentFrag} / ${job.progress.totalFrag} (${job.progress.totalSize || ''})`;
    } else {
      frag.textContent = job.progress.totalSize || 'Ready';
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
  if (!confirm('Are you sure you want to cancel this download?')) return;
  try {
    await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    loadJobs();
  } catch (err) {
    alert(`Failed to cancel: ${err.message}`);
  }
};

// 5. Local Library Viewer
async function loadLibrary() {
  if (!targetDirectory) {
    libraryGrid.innerHTML = `
      <div class="empty-state">
        <p>No download directory configured yet. Click the <strong>⚙️ Settings</strong> button above to set your folder.</p>
      </div>
    `;
    return;
  }

  try {
    const res = await fetch(`/api/library?dir=${encodeURIComponent(targetDirectory)}`);
    const data = await res.json();
    libraryMedia = data.files || [];
    renderLibraryGrid(libraryMedia);
  } catch (err) {
    console.warn('Library load error:', err);
  }
}

function filterLibrary(query) {
  const q = query.toLowerCase().trim();
  if (!q) {
    renderLibraryGrid(libraryMedia);
    return;
  }
  const filtered = libraryMedia.filter(v => v.name.toLowerCase().includes(q));
  renderLibraryGrid(filtered);
}

function renderLibraryGrid(files) {
  libraryGrid.innerHTML = '';

  if (!files || files.length === 0) {
    libraryGrid.innerHTML = `
      <div class="empty-state">
        <p>No media files found in <strong>${targetDirectory}</strong>.</p>
      </div>
    `;
    return;
  }

  files.forEach(file => {
    const card = document.createElement('div');
    card.className = 'video-card';

    const isAudio = file.type === 'audio';

    const modDate = new Date(file.modified).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const safePath = file.path.replace(/\\/g, '\\\\');
    const safeTitle = file.name.replace(/'/g, "\\'");

    card.innerHTML = `
      <div class="video-card-thumb ${isAudio ? 'audio-thumb' : ''}" onclick="playMedia('${safePath}', '${safeTitle}')">
        <span class="video-type-badge">${file.ext || (isAudio ? 'AUDIO' : 'VIDEO')}</span>
        <div class="play-overlay-icon">
          ${isAudio ? `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
          ` : `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          `}
        </div>
      </div>
      <div class="video-card-body">
        <div class="video-card-title" title="${file.name}">${file.name}</div>
        <div class="video-card-meta">
          <span>${file.sizeFormatted}</span>
          <span>${modDate}</span>
        </div>
        <div class="video-card-actions">
          <button class="btn btn-primary" onclick="playMedia('${safePath}', '${safeTitle}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            <span>Play</span>
          </button>
          <button class="btn btn-secondary" onclick="openFolderInExplorer('${safePath}')" title="Show file in folder">
            <span>Locate</span>
          </button>
        </div>
      </div>
    `;

    libraryGrid.appendChild(card);
  });
}

// 6. In-Browser Media Player (Video & Audio)
window.playMedia = function(filePath, title) {
  modalVideoTitle.textContent = title;
  modalFileInfo.textContent = filePath;
  html5Player.src = `/api/stream?file=${encodeURIComponent(filePath)}`;
  videoModal.style.display = 'flex';
  html5Player.play().catch(e => console.log('Autoplay deferred:', e));
};

function closePlayerModal() {
  html5Player.pause();
  html5Player.src = '';
  videoModal.style.display = 'none';
}

// 7. System Storage Query
async function loadStorageInfo() {
  try {
    const res = await fetch('/api/system/storage');
    const drives = await res.json();
    if (drives && drives.length > 0) {
      targetDriveName.textContent = drives[0].name || 'Storage';
      storageVal.textContent = `${drives[0].freeGB} GB free / ${drives[0].totalGB} GB`;
    }
  } catch (err) {
    storageVal.textContent = 'Ready';
  }
}

// 8. Open Folder in Explorer
async function openFolderInExplorer(folderPath) {
  try {
    await fetch('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: folderPath })
    });
  } catch (err) {
    console.warn('Failed to open folder:', err);
  }
}
