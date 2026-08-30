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
const readyFileExt = document.getElementById('readyFileExt');
const readyFileName = document.getElementById('readyFileName');
const readyFileSize = document.getElementById('readyFileSize');
const saveToDeviceBtn = document.getElementById('saveToDeviceBtn');
const watchInBrowserBtn = document.getElementById('watchInBrowserBtn');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const copyLinkText = document.getElementById('copyLinkText');

// Video Player Modal
const videoModal = document.getElementById('videoModal');
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
  closeModalBtn.addEventListener('click', closePlayerModal);
  videoModal.addEventListener('click', (e) => {
    if (e.target === videoModal) closePlayerModal();
  });

  closeReadyModalBtn.addEventListener('click', () => {
    readyModal.style.display = 'none';
  });
  readyModal.addEventListener('click', (e) => {
    if (e.target === readyModal) readyModal.style.display = 'none';
  });

  // Ready Modal Actions
  watchInBrowserBtn.addEventListener('click', () => {
    if (activeReadyJob) {
      readyModal.style.display = 'none';
      playMedia(activeReadyJob.streamUrl, activeReadyJob.title, activeReadyJob.downloadUrl);
    }
  });

  copyLinkBtn.addEventListener('click', () => {
    if (activeReadyJob) {
      const fullUrl = window.location.origin + activeReadyJob.downloadUrl;
      navigator.clipboard.writeText(fullUrl).then(() => {
        copyLinkText.textContent = 'Copied to Clipboard!';
        setTimeout(() => { copyLinkText.textContent = 'Copy Download Link'; }, 2000);
      });
    }
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
    downloadBtnText.textContent = isAudio ? 'Extract Audio' : 'Download Now';
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
    alert(`Download Error: ${err.message}`);
  } finally {
    startDownloadBtn.disabled = false;
    downloadBtnText.textContent = currentMode === 'audio' ? 'Extract Audio' : 'Download Now';
  }
}

// 2b. Start Batch Download
async function startBatchDownload() {
  const urls = batchUrlsInput.value.split('\n').map(u => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    alert('Please enter at least one URL');
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
    alert(`Batch Error: ${err.message}`);
  } finally {
    startBatchBtn.disabled = false;
    startBatchBtn.querySelector('span').textContent = 'Process & Download All';
  }
}

// 3. Trigger Browser Download & Show Ready Popup
function triggerDeviceDownload(job) {
  activeReadyJob = job;

  readyFileName.textContent = job.filename || job.title;
  readyFileSize.textContent = job.filesize ? `Size: ${job.filesize}` : '';
  const ext = (job.filename.split('.').pop() || 'MP4').toUpperCase();
  readyFileExt.textContent = ext;

  saveToDeviceBtn.href = job.downloadUrl;
  saveToDeviceBtn.setAttribute('download', job.filename);

  readyModal.style.display = 'flex';

  // Automatically trigger native browser file save
  const autoAnchor = document.createElement('a');
  autoAnchor.href = job.downloadUrl;
  autoAnchor.setAttribute('download', job.filename);
  document.body.appendChild(autoAnchor);
  autoAnchor.click();
  document.body.removeChild(autoAnchor);
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
          <button class="btn btn-secondary btn-sm" onclick="playMedia('${job.streamUrl}', '${job.title.replace(/'/g, "\\'")}', '${job.downloadUrl}')">
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
        <button class="btn btn-secondary btn-sm" onclick="playMedia('${job.streamUrl}', '${job.title.replace(/'/g, "\\'")}', '${job.downloadUrl}')">
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
  modalVideoTitle.textContent = title;
  modalFileInfo.textContent = title;
  html5Player.src = streamUrl;
  modalDownloadDeviceBtn.href = downloadUrl;
  videoModal.style.display = 'flex';
  html5Player.play().catch(e => console.log('Autoplay deferred:', e));
};

function closePlayerModal() {
  html5Player.pause();
  html5Player.src = '';
  videoModal.style.display = 'none';
}
