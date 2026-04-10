
(() => {
  const SAMPLE_MS = 1000;
  const MAX_RATE = 16;
  const TRACK_EPSILON = 1.001;
  const TOLERANCE_SECONDS = 0.35;
  const MIN_SESSION_MEDIA_SECONDS = 5;
  const states = new WeakMap();

  const defaultSettings = {
    trackOnlyVisible: true,
    excludedHosts: [],
    storePageDetails: true
  };

  let settings = { ...defaultSettings };

  function clampRate(rate) {
    if (!Number.isFinite(rate) || rate <= 0) return 1;
    return Math.min(rate, MAX_RATE);
  }

  function makeId() {
    try { return crypto.randomUUID(); }
    catch (_) { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  }

  function parseExcludedHosts(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
  }

  function hostIsExcluded(hostname) {
    const host = String(hostname || location.hostname || '').toLowerCase();
    return parseExcludedHosts(settings.excludedHosts).some((entry) => host === entry || host.endsWith(`.${entry}`));
  }

  async function loadSettings() {
    try {
      const data = await browser.storage.local.get({ settings: defaultSettings });
      const incoming = data.settings || {};
      settings = {
        trackOnlyVisible: incoming.trackOnlyVisible !== false,
        excludedHosts: parseExcludedHosts(incoming.excludedHosts),
        storePageDetails: incoming.storePageDetails !== false
      };
    } catch (_) {
      settings = { ...defaultSettings };
    }
  }

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.settings) return;
    const next = changes.settings.newValue || defaultSettings;
    settings = {
      trackOnlyVisible: next.trackOnlyVisible !== false,
      excludedHosts: parseExcludedHosts(next.excludedHosts),
      storePageDetails: next.storePageDetails !== false
    };
  });

  function pageDetails() {
    return {
      url: settings.storePageDetails ? location.href : '',
      title: settings.storePageDetails ? (document.title || '') : ''
    };
  }

  function makeState(video) {
    return {
      lastCurrentTime: Number(video.currentTime || 0),
      lastWallTime: performance.now(),
      lastRate: clampRate(video.playbackRate),
      armed: false,
      session: null
    };
  }

  function ensureState(video) {
    if (!states.has(video)) states.set(video, makeState(video));
    return states.get(video);
  }

  function resetState(video, finalizeFirst = false) {
    if (finalizeFirst) finalizeSession(video);
    states.set(video, makeState(video));
  }

  function shouldSkip(video) {
    return (
      video.paused || video.ended || video.readyState < 2 || hostIsExcluded(location.hostname) ||
      (settings.trackOnlyVisible && document.visibilityState === 'hidden')
    );
  }

  function safeUrl(raw) {
    try { return new URL(raw || location.href, location.href); }
    catch (_) { return null; }
  }

  function deriveSourceIdentity(video, details) {
    const host = String(location.hostname || 'unknown').toLowerCase();
    if (!settings.storePageDetails) {
      return { sourceId: `host:${host}`, sourceLabel: host, sourceKind: 'host' };
    }
    const url = safeUrl(details.url || location.href);
    const title = String(details.title || document.title || '').trim();
    if (url) {
      const h = url.hostname.replace(/^www\./, '').toLowerCase();
      if (h === 'youtube.com' || h.endsWith('.youtube.com')) {
        const v = url.searchParams.get('v');
        if (v) return { sourceId: `yt:${v}`, sourceLabel: title || `YouTube ${v}`, sourceKind: 'youtube' };
      }
      if (h === 'youtu.be') {
        const seg = url.pathname.split('/').filter(Boolean)[0];
        if (seg) return { sourceId: `yt:${seg}`, sourceLabel: title || `YouTube ${seg}`, sourceKind: 'youtube' };
      }
      if (h === 'vimeo.com' || h.endsWith('.vimeo.com')) {
        const seg = url.pathname.split('/').filter(Boolean)[0];
        if (seg && /^\d+$/.test(seg)) return { sourceId: `vimeo:${seg}`, sourceLabel: title || `Vimeo ${seg}`, sourceKind: 'vimeo' };
      }
      const path = url.pathname || '/';
      const coarsePath = path.length > 120 ? `${path.slice(0, 117)}…` : path;
      return { sourceId: `page:${h}${coarsePath}`, sourceLabel: title || `${h}${coarsePath}`, sourceKind: 'page' };
    }
    return { sourceId: `host:${host}`, sourceLabel: title || host, sourceKind: 'host' };
  }

  function ensureSession(state, video, rate) {
    if (!state.session) {
      const details = pageDetails();
      const source = deriveSourceIdentity(video, details);
      state.session = {
        id: makeId(), origin: location.hostname || 'unknown', url: details.url, title: details.title,
        sourceId: source.sourceId, sourceLabel: source.sourceLabel, sourceKind: source.sourceKind,
        startedAt: Date.now(), mediaSeconds: 0, wallSeconds: 0, savedSeconds: 0, peakRate: rate
      };
    }
    return state.session;
  }

  function maybeSendMessage(message) {
    browser.runtime.sendMessage(message).catch(() => {});
  }

  function finalizeSession(video) {
    const state = ensureState(video);
    const session = state.session;
    if (!session) return;
    state.session = null;
    if (session.mediaSeconds < MIN_SESSION_MEDIA_SECONDS || session.savedSeconds <= 0) return;
    maybeSendMessage({ type: 'SESSION_SUMMARY', session: {
      id: session.id, origin: session.origin, url: session.url, title: session.title,
      sourceId: session.sourceId, sourceLabel: session.sourceLabel, sourceKind: session.sourceKind,
      startedAt: session.startedAt, endedAt: Date.now(), mediaSeconds: session.mediaSeconds,
      wallSeconds: session.wallSeconds, savedSeconds: session.savedSeconds,
      avgRate: session.wallSeconds > 0 ? session.mediaSeconds / session.wallSeconds : 1,
      peakRate: session.peakRate
    }});
  }

  function sampleVideo(video) {
    const state = ensureState(video);
    const now = performance.now();
    const currentTime = Number(video.currentTime || 0);
    const rate = clampRate(video.playbackRate);

    if (shouldSkip(video)) {
      state.lastCurrentTime = currentTime; state.lastWallTime = now; state.lastRate = rate; state.armed = false; finalizeSession(video); return;
    }

    if (!state.armed) {
      state.lastCurrentTime = currentTime; state.lastWallTime = now; state.lastRate = rate; state.armed = true; return;
    }

    const mediaDelta = currentTime - state.lastCurrentTime;
    const wallDelta = Math.max(0, (now - state.lastWallTime) / 1000);
    const effectiveRate = clampRate((state.lastRate + rate) / 2);
    const plausibleMaxMediaDelta = wallDelta * effectiveRate + TOLERANCE_SECONDS;

    state.lastCurrentTime = currentTime; state.lastWallTime = now; state.lastRate = rate;

    if (!Number.isFinite(mediaDelta) || mediaDelta <= 0) return;
    if (mediaDelta > plausibleMaxMediaDelta) { finalizeSession(video); return; }
    if (effectiveRate <= TRACK_EPSILON) { finalizeSession(video); return; }

    const savedSeconds = mediaDelta * (1 - 1 / effectiveRate);
    if (savedSeconds <= 0.001) return;

    const details = pageDetails();
    const source = deriveSourceIdentity(video, details);
    const session = ensureSession(state, video, effectiveRate);
    session.mediaSeconds += mediaDelta; session.wallSeconds += wallDelta; session.savedSeconds += savedSeconds;
    session.peakRate = Math.max(session.peakRate, effectiveRate); session.url = details.url; session.title = details.title || session.title;
    session.sourceId = source.sourceId; session.sourceLabel = source.sourceLabel; session.sourceKind = source.sourceKind;

    maybeSendMessage({
      type: 'TRACK_DELTA', origin: location.hostname || 'unknown', url: details.url, title: details.title,
      sourceId: source.sourceId, sourceLabel: source.sourceLabel, sourceKind: source.sourceKind,
      mediaSeconds: mediaDelta, wallSeconds: wallDelta, savedSeconds, avgRate: effectiveRate, timestamp: Date.now()
    });
  }

  function watchVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    if (video.dataset.speedSavingsTrackerAttached === 'true') return;
    video.dataset.speedSavingsTrackerAttached = 'true';
    resetState(video);
    const reset = () => resetState(video, true);
    ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'loadedmetadata', 'ended', 'waiting', 'emptied'].forEach((eventName) => {
      video.addEventListener(eventName, reset, { passive: true });
    });
  }

  function getLiveStatus() {
    const videos = [...document.querySelectorAll('video')].filter((video) => video instanceof HTMLVideoElement);
    const playing = videos.filter((video) => !video.paused && !video.ended && video.readyState >= 2);
    const rates = playing.map((video) => clampRate(video.playbackRate));
    const trackedRates = rates.filter((videoRate) => videoRate > TRACK_EPSILON);
    const sessions = playing.map((video) => ensureState(video).session).filter(Boolean);
    const activeSavedSeconds = sessions.reduce((sum, session) => sum + Number(session.savedSeconds || 0), 0);
    const activeMediaSeconds = sessions.reduce((sum, session) => sum + Number(session.mediaSeconds || 0), 0);
    const activeWallSeconds = sessions.reduce((sum, session) => sum + Number(session.wallSeconds || 0), 0);
    const latestSession = sessions.sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0))[0] || null;

    return {
      host: location.hostname || 'unknown', href: settings.storePageDetails ? location.href : '', title: settings.storePageDetails ? (document.title || '') : '',
      pageExcluded: hostIsExcluded(location.hostname), trackOnlyVisible: settings.trackOnlyVisible, visibilityState: document.visibilityState,
      videosDetected: videos.length, videosPlaying: playing.length, trackedVideosPlaying: trackedRates.length, rates, trackedRates, trackingRule: '> 1.00× only',
      activeSession: latestSession ? {
        sourceId: latestSession.sourceId, sourceLabel: latestSession.sourceLabel, startedAt: Number(latestSession.startedAt || Date.now()),
        savedSeconds: activeSavedSeconds, mediaSeconds: activeMediaSeconds, wallSeconds: activeWallSeconds,
        avgRate: activeWallSeconds > 0 ? activeMediaSeconds / activeWallSeconds : (trackedRates[0] || 1),
        peakRate: Math.max(1, ...trackedRates, Number(latestSession.peakRate || 1))
      } : null
    };
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return undefined;
    if (message.type === 'GET_PAGE_STATUS') return Promise.resolve(getLiveStatus());
    return undefined;
  });

  function scan() {
    document.querySelectorAll('video').forEach(watchVideo);
    document.querySelectorAll('video').forEach(sampleVideo);
  }

  const observer = new MutationObserver(() => {
    document.querySelectorAll('video').forEach(watchVideo);
  });

  loadSettings().finally(() => {
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
    scan();
    setInterval(scan, SAMPLE_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') document.querySelectorAll('video').forEach((video) => finalizeSession(video));
      scan();
    }, { passive: true });
    window.addEventListener('pagehide', () => {
      document.querySelectorAll('video').forEach((video) => finalizeSession(video));
    }, { passive: true });
  });
})();
