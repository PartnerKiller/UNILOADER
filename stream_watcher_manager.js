'use strict';

/**
 * Stream Watcher Manager (omg.sexy & Stripchat Auto-Recorder Daemon)
 * 
 * Provides automated 24/7 background monitoring for cam streamers.
 * Watches user-specified models and automatically records, decrypts (via Mouflon v2 / local proxy),
 * and archives live broadcasts into permanent storage the instant they go live.
 */

const fs = require('fs');
const path = require('path');

const WATCHLIST_FILE = path.join(__dirname, 'stream_watchlist.json');
const DEFAULT_POLL_INTERVAL_MS = 25000;

class StreamWatcherManager {
  constructor() {
    this.watchlist = [];
    this.pollTimer = null;
    this.isPolling = false;
    this.lastCheckTime = null;
    this.serverPort = 3050;
    this.jobsRef = null;
    this.createAndStartJobFn = null;
    this.broadcastFn = null;
    this.saveStateFn = null;
    this.concurrencyLimit = 2; // Maximum simultaneous requests during polling
  }

  init({ port = 3050, jobs, createAndStartJob, broadcastJobUpdate, saveAllJobsState }) {
    this.serverPort = port;
    this.jobsRef = jobs;
    this.createAndStartJobFn = createAndStartJob;
    this.broadcastFn = broadcastJobUpdate;
    this.saveStateFn = saveAllJobsState;

    this.loadWatchlist();
    this.startPolling();
    console.log(`[Stream Watcher] Initialized with ${this.watchlist.length} watched streamer(s). Auto-recorder polling active every ${DEFAULT_POLL_INTERVAL_MS / 1000}s.`);
  }

  loadWatchlist() {
    try {
      if (fs.existsSync(WATCHLIST_FILE)) {
        const raw = fs.readFileSync(WATCHLIST_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          this.watchlist = data.map(item => ({
            username: String(item.username || '').trim(),
            displayName: String(item.displayName || item.username || '').trim(),
            modelId: item.modelId ? String(item.modelId) : null,
            avatarUrl: item.avatarUrl || null,
            status: item.status || 'offline',
            statusMessage: item.statusMessage || 'Standby monitoring active',
            enabled: item.enabled !== false,
            activeJobId: item.activeJobId || null,
            recordCount: parseInt(item.recordCount, 10) || 0,
            addedAt: item.addedAt || Date.now(),
            lastCheckedAt: item.lastCheckedAt || null,
            lastRecordedAt: item.lastRecordedAt || null,
            lastRecordedFile: item.lastRecordedFile || null,
            autoReconnect: item.autoReconnect !== false
          })).filter(s => Boolean(s.username));
        }
      }
    } catch (err) {
      console.warn('[Stream Watcher] Warning loading watchlist:', err.message);
      this.watchlist = [];
    }
  }

  saveWatchlist() {
    try {
      fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(this.watchlist, null, 2), 'utf8');
    } catch (err) {
      console.error('[Stream Watcher] Failed to save watchlist:', err.message);
    }
  }

  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      this.pollWatchers().catch(err => {
        console.warn('[Stream Watcher] Background poll warning:', err.message);
      });
    }, DEFAULT_POLL_INTERVAL_MS);

    // Initial check after a brief 3s delay on server boot
    setTimeout(() => {
      this.pollWatchers().catch(() => {});
    }, 3000);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getWatchlist() {
    // Reconcile live job statuses for accurate UI representation
    if (this.jobsRef) {
      for (const streamer of this.watchlist) {
        if (streamer.activeJobId) {
          const currentJob = this.jobsRef.get(streamer.activeJobId);
          if (!currentJob || ['completed', 'failed', 'cancelled'].includes(currentJob.status)) {
            streamer.activeJobId = null;
            if (streamer.status === 'recording') {
              streamer.status = 'offline';
            }
          } else {
            streamer.status = 'recording';
          }
        }
      }
    }

    return {
      success: true,
      watchers: this.watchlist,
      totalCount: this.watchlist.length,
      activeRecordings: this.watchlist.filter(w => w.status === 'recording').length,
      lastCheckTime: this.lastCheckTime,
      pollIntervalSec: DEFAULT_POLL_INTERVAL_MS / 1000
    };
  }

  normalizeUsername(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') return '';
    let clean = rawInput.trim();
    // Support full URLs e.g. https://omg.sexy/Princess_Venus or stripchat.com/Princess_Venus
    const match = clean.match(/(?:omg\.sexy|stripchat\.com)\/(?:(?:en|model|girls|user)\/)?([a-zA-Z0-9_\-]+)/i);
    if (match) {
      clean = match[1];
    }
    // Remove leading @ or slashes
    clean = clean.replace(/^[@/]+/, '').trim();
    return clean;
  }

  async checkRemoteModelInfo(username) {
    const cleanUser = this.normalizeUsername(username);
    if (!cleanUser) {
      throw new Error('Valid username or omg.sexy URL is required');
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': `https://omg.sexy/${cleanUser}`
    };

    let item = null;

    // 1. Primary: omg.sexy API
    try {
      const resp = await fetch(`https://omg.sexy/api/front/v1/broadcasts/${cleanUser}`, {
        headers,
        signal: AbortSignal.timeout(6000)
      });
      if (resp.ok) {
        const json = await resp.json();
        if (json && json.item) {
          item = json.item;
        }
      } else if (resp.status === 404) {
        throw new Error(`Streamer "${cleanUser}" was not found on omg.sexy.`);
      }
    } catch (err) {
      if (err.message && err.message.includes('not found')) throw err;
    }

    // 2. Fallback: stripchat.com API if omg.sexy was temporarily unreachable
    if (!item) {
      try {
        const scResp = await fetch(`https://stripchat.com/api/front/v1/broadcasts/${cleanUser}`, {
          headers: { ...headers, Referer: `https://stripchat.com/${cleanUser}` },
          signal: AbortSignal.timeout(6000)
        });
        if (scResp.ok) {
          const scJson = await scResp.json();
          if (scJson && scJson.item) item = scJson.item;
        }
      } catch (e) {}
    }

    if (!item) {
      return {
        username: cleanUser,
        displayName: cleanUser,
        modelId: null,
        isLive: false,
        status: 'offline',
        statusMessage: 'Could not resolve broadcast state (offline)',
        avatarUrl: null
      };
    }

    const modelId = String(item.modelId || item.streamName || '');
    const isLive = Boolean(item.isLive);
    const rawStatus = String(item.status || 'off').toLowerCase();
    const avatarUrl = modelId ? `https://img.strpst.com/thumbs/${modelId}/${modelId}.jpg` : null;

    let computedStatus = 'offline';
    let statusMessage = 'Model is currently offline';

    if (rawStatus === 'private' || rawStatus === 'pvt' || rawStatus === 'group_show') {
      computedStatus = 'private';
      statusMessage = 'Model is currently in a private show';
    } else if (isLive || (!['off', 'offline', 'none', 'idle_offline'].includes(rawStatus) && rawStatus !== '')) {
      computedStatus = 'online';
      statusMessage = 'Model is broadcasting live!';
    }

    return {
      username: item.username || cleanUser,
      displayName: item.username || cleanUser,
      modelId: modelId || null,
      isLive,
      status: computedStatus,
      rawStatus,
      statusMessage,
      avatarUrl
    };
  }

  async addStreamer(rawInput, opts = {}) {
    // Support bulk add with comma or newline separation
    const tokens = String(rawInput || '')
      .split(/[\r\n,]+/)
      .map(s => this.normalizeUsername(s))
      .filter(Boolean);

    if (tokens.length === 0) {
      throw new Error('Please provide at least one valid streamer username or omg.sexy link.');
    }

    const added = [];
    const alreadyExists = [];

    for (const userToken of tokens) {
      const existing = this.watchlist.find(w => w.username.toLowerCase() === userToken.toLowerCase());
      if (existing) {
        alreadyExists.push(existing.username);
        continue;
      }

      let info = null;
      try {
        info = await this.checkRemoteModelInfo(userToken);
      } catch (fetchErr) {
        info = {
          username: userToken,
          displayName: userToken,
          modelId: null,
          isLive: false,
          status: 'offline',
          statusMessage: fetchErr.message || 'Streamer offline',
          avatarUrl: null
        };
      }

      const newStreamer = {
        username: info.username || userToken,
        displayName: info.displayName || userToken,
        modelId: info.modelId || null,
        avatarUrl: info.avatarUrl || null,
        status: info.status || 'offline',
        statusMessage: info.statusMessage || 'Standby monitoring active',
        enabled: true,
        activeJobId: null,
        recordCount: 0,
        addedAt: Date.now(),
        lastCheckedAt: Date.now(),
        lastRecordedAt: null,
        lastRecordedFile: null,
        autoReconnect: true
      };

      this.watchlist.push(newStreamer);
      added.push(newStreamer);

      // If streamer happens to be online right now, immediately queue recording
      if (newStreamer.status === 'online' && !newStreamer.activeJobId) {
        this.startAutoRecording(newStreamer).catch(err => {
          console.warn(`[Stream Watcher] Initial recording trigger notice for ${newStreamer.username}:`, err.message);
        });
      }
    }

    this.saveWatchlist();

    return {
      success: true,
      added,
      alreadyExists,
      totalWatched: this.watchlist.length
    };
  }

  removeStreamer(rawUsername, stopRecording = false) {
    const cleanUser = this.normalizeUsername(rawUsername).toLowerCase();
    const idx = this.watchlist.findIndex(w => w.username.toLowerCase() === cleanUser);
    if (idx === -1) {
      throw new Error(`Streamer "${rawUsername}" is not in the watchlist.`);
    }

    const removed = this.watchlist[idx];
    if (stopRecording && removed.activeJobId && this.jobsRef) {
      const activeJob = this.jobsRef.get(removed.activeJobId);
      if (activeJob && activeJob.process) {
        try {
          activeJob.isStopping = true;
          activeJob.process.kill('SIGINT');
        } catch (e) {}
      }
    }

    this.watchlist.splice(idx, 1);
    this.saveWatchlist();

    return {
      success: true,
      removed: removed.username,
      totalWatched: this.watchlist.length
    };
  }

  toggleStreamer(rawUsername, enabled = null) {
    const cleanUser = this.normalizeUsername(rawUsername).toLowerCase();
    const streamer = this.watchlist.find(w => w.username.toLowerCase() === cleanUser);
    if (!streamer) {
      throw new Error(`Streamer "${rawUsername}" is not in the watchlist.`);
    }

    streamer.enabled = (enabled !== null) ? Boolean(enabled) : !streamer.enabled;
    if (!streamer.enabled && streamer.status !== 'recording') {
      streamer.statusMessage = 'Monitoring paused by user';
    } else if (streamer.enabled && streamer.status === 'offline') {
      streamer.statusMessage = 'Standby monitoring active';
    }

    this.saveWatchlist();

    return {
      success: true,
      username: streamer.username,
      enabled: streamer.enabled,
      status: streamer.status
    };
  }

  async checkSingleStreamerNow(rawUsername) {
    const cleanUser = this.normalizeUsername(rawUsername).toLowerCase();
    const streamer = this.watchlist.find(w => w.username.toLowerCase() === cleanUser);
    if (!streamer) {
      throw new Error(`Streamer "${rawUsername}" is not in the watchlist.`);
    }

    await this.pollSingleStreamer(streamer);
    this.saveWatchlist();

    return {
      success: true,
      streamer
    };
  }

  async pollSingleStreamer(streamer) {
    streamer.lastCheckedAt = Date.now();

    // If currently recording, check if job is still active
    if (streamer.activeJobId && this.jobsRef) {
      const currentJob = this.jobsRef.get(streamer.activeJobId);
      if (currentJob && ['downloading', 'queued', 'processing'].includes(currentJob.status)) {
        streamer.status = 'recording';
        streamer.statusMessage = `🔴 Recording in progress (Job: ${currentJob.id})`;
        return;
      } else {
        // Job finished or disappeared
        streamer.activeJobId = null;
        if (streamer.status === 'recording') {
          streamer.status = 'offline';
        }
      }
    }

    if (!streamer.enabled) {
      streamer.statusMessage = 'Monitoring paused';
      return;
    }

    try {
      const info = await this.checkRemoteModelInfo(streamer.username);
      if (info.modelId && !streamer.modelId) streamer.modelId = info.modelId;
      if (info.avatarUrl && !streamer.avatarUrl) streamer.avatarUrl = info.avatarUrl;

      // Check CDN master stream availability
      const resolvedModelId = info.modelId || streamer.modelId;
      let cdnActive = false;

      if (resolvedModelId && (info.isLive || info.status === 'online')) {
        try {
          const cdnMaster = `https://edge-hls.doppiocdn.org/hls/${resolvedModelId}/master/${resolvedModelId}_auto.m3u8`;
          const cdnResp = await fetch(cdnMaster, {
            method: 'HEAD',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
              'Referer': `https://omg.sexy/${streamer.username}`
            },
            signal: AbortSignal.timeout(4000)
          });
          if (cdnResp.status === 200) {
            cdnActive = true;
          }
        } catch (cdnErr) {}
      }

      if (info.status === 'online' || cdnActive) {
        streamer.status = 'online';
        streamer.statusMessage = '🔴 Model is broadcasting live! Auto-recorder engaged.';
        await this.startAutoRecording(streamer);
      } else if (info.status === 'private') {
        streamer.status = 'private';
        streamer.statusMessage = '🔒 Model in private show. Standby monitoring for public return...';
      } else {
        streamer.status = 'offline';
        streamer.statusMessage = 'Model is currently offline. Standby monitoring active.';
      }
    } catch (err) {
      streamer.statusMessage = `Check notice: ${err.message}`;
    }
  }

  async startAutoRecording(streamer) {
    if (!this.createAndStartJobFn || !this.jobsRef) return;
    if (streamer.activeJobId) {
      const currentJob = this.jobsRef.get(streamer.activeJobId);
      if (currentJob && ['downloading', 'queued', 'processing'].includes(currentJob.status)) {
        return;
      }
    }

    const streamerUrl = `https://omg.sexy/${streamer.username}`;

    // Verify if an identical job is already running to prevent duplicate recordings
    for (const j of this.jobsRef.values()) {
      if (['downloading', 'queued', 'processing', 'waiting_for_stream'].includes(j.status)) {
        const jUrl = (j.opts && (j.opts.url || j.opts.sourceUrl)) || j.url || '';
        if (jUrl.toLowerCase().includes(streamer.username.toLowerCase())) {
          streamer.activeJobId = j.id;
          streamer.status = 'recording';
          return;
        }
      }
    }

    const modelId = streamer.modelId || null;
    const masterHls = modelId ? `https://edge-hls.doppiocdn.org/hls/${modelId}/master/${modelId}_auto.m3u8` : null;

    const payload = {
      url: streamerUrl,
      title: `omg.sexy - ${streamer.displayName} Live Stream`,
      mode: 'video',
      videoFormat: 'mp4',
      isLiveCapture: true,
      isLiveStream: true,
      hlsUrl: masterHls,
      downloadTargetUrl: masterHls,
      camStreamName: modelId,
      isAutoWatchJob: true,
      watcherUsername: streamer.username,
      isOwner: true,
      role: 'owner',
      username: 'sakura',
      ownerId: 'owner'
    };

    console.log(`[Stream Watcher] 🚀 Streamer "${streamer.username}" is LIVE! Spawning automated recording job...`);
    const newJob = this.createAndStartJobFn(payload);
    if (newJob) {
      streamer.activeJobId = newJob.id;
      streamer.status = 'recording';
      streamer.statusMessage = `🔴 Active Live Recording in progress (Job ID: ${newJob.id})`;
      this.saveWatchlist();
      if (this.broadcastFn) {
        this.broadcastFn(newJob.id);
      }
    }
  }

  async pollWatchers() {
    if (this.isPolling) return;
    this.isPolling = true;
    this.lastCheckTime = Date.now();

    try {
      const activeList = this.watchlist.filter(w => w.enabled);
      for (const streamer of activeList) {
        await this.pollSingleStreamer(streamer);
        // Small pause between streamers to prevent burst queries
        await new Promise(r => setTimeout(r, 600));
      }
      this.saveWatchlist();
    } catch (err) {
      console.warn('[Stream Watcher] Polling cycle error:', err.message);
    } finally {
      this.isPolling = false;
    }
  }

  onJobFinished(job, finalFilename = null, isSuccess = false) {
    if (!job || !job.opts || !job.opts.isAutoWatchJob) return;
    const targetUser = String(job.opts.watcherUsername || '').toLowerCase();
    if (!targetUser) return;

    const streamer = this.watchlist.find(w => w.username.toLowerCase() === targetUser);
    if (!streamer) return;

    streamer.activeJobId = null;
    streamer.status = 'offline';

    if (isSuccess && finalFilename) {
      streamer.recordCount = (streamer.recordCount || 0) + 1;
      streamer.lastRecordedAt = Date.now();
      streamer.lastRecordedFile = finalFilename;
      streamer.statusMessage = `✅ Stream archived (${finalFilename}). Standby monitoring active.`;
      console.log(`[Stream Watcher] 🎉 Finished and archived broadcast for "${streamer.username}" (${finalFilename})! Total archived: ${streamer.recordCount}.`);
    } else {
      streamer.statusMessage = 'Broadcast ended. Standby monitoring active.';
    }

    this.saveWatchlist();
  }

  onJobCancelled(job) {
    if (!job || !job.opts || !job.opts.isAutoWatchJob) return;
    const targetUser = String(job.opts.watcherUsername || '').toLowerCase();
    if (!targetUser) return;

    const streamer = this.watchlist.find(w => w.username.toLowerCase() === targetUser);
    if (streamer && streamer.activeJobId === job.id) {
      streamer.activeJobId = null;
      streamer.status = 'offline';
      streamer.statusMessage = 'Recording stopped manually. Standby monitoring active.';
      this.saveWatchlist();
    }
  }
}

const streamWatcherManager = new StreamWatcherManager();
module.exports = streamWatcherManager;
