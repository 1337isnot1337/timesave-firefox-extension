
const actionApi = browser.action || browser.browserAction;

const DEFAULT_SETTINGS = {
  trackOnlyVisible: true,
  badgeMode: 'today_saved',
  keepDays: 180,
  excludedHosts: [],
  sessionHistoryLimit: 180,
  timelineRetentionDays: 14,
  storePageDetails: true
};

const DEFAULTS = {
  version: 4,
  totalSavedSeconds: 0,
  totalMediaSeconds: 0,
  totalWallSeconds: 0,
  totalSessions: 0,
  bySite: {},
  bySource: {},
  sourceCatalog: {},
  byDay: {},
  byWeekday: {},
  byHour: {},
  rateHistogram: {},
  recentSessions: [],
  topSessions: [],
  longestSession: null,
  bestDay: null,
  achievements: [],
  speedTimeline: [],
  lastUpdated: null,
  settings: DEFAULT_SETTINGS
};

const RATE_BUCKETS = [
  { max: 1.24, key: '1.01–1.24×' },
  { max: 1.49, key: '1.25–1.49×' },
  { max: 1.99, key: '1.50–1.99×' },
  { max: 2.49, key: '2.00–2.49×' },
  { max: 2.99, key: '2.50–2.99×' },
  { max: 3.99, key: '3.00–3.99×' },
  { max: Infinity, key: '4.00×+' }
];

const ACHIEVEMENT_THRESHOLDS = [
  5 * 60, 15 * 60, 30 * 60, 1 * 3600, 2 * 3600, 5 * 3600, 10 * 3600, 25 * 3600, 50 * 3600, 100 * 3600
];

const TIMELINE_POINT_CAP = 20000;
let writeQueue = Promise.resolve();

function makeLocalDayKey(timestamp = Date.now()) {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function minuteBucket(timestamp = Date.now()) {
  return Math.floor(Number(timestamp || Date.now()) / 60000) * 60000;
}

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function safeUrl(raw) { try { return new URL(raw); } catch (_) { return null; } }
function sanitizeDetailString(value, enabled) { return enabled ? String(value || '') : ''; }

function normalizeSettings(settings = {}) {
  const excludedHosts = Array.isArray(settings.excludedHosts)
    ? settings.excludedHosts.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const keepDays = Number(settings.keepDays);
  const sessionHistoryLimit = Number(settings.sessionHistoryLimit);
  const timelineRetentionDays = Number(settings.timelineRetentionDays);
  return {
    trackOnlyVisible: settings.trackOnlyVisible !== false,
    badgeMode: ['off', 'today_saved', 'total_saved', 'avg_speed', 'week_saved'].includes(settings.badgeMode) ? settings.badgeMode : DEFAULT_SETTINGS.badgeMode,
    keepDays: Number.isFinite(keepDays) ? Math.min(365, Math.max(14, Math.round(keepDays))) : DEFAULT_SETTINGS.keepDays,
    excludedHosts: [...new Set(excludedHosts)],
    sessionHistoryLimit: Number.isFinite(sessionHistoryLimit) ? Math.min(500, Math.max(20, Math.round(sessionHistoryLimit))) : DEFAULT_SETTINGS.sessionHistoryLimit,
    timelineRetentionDays: Number.isFinite(timelineRetentionDays) ? Math.min(90, Math.max(1, Math.round(timelineRetentionDays))) : DEFAULT_SETTINGS.timelineRetentionDays,
    storePageDetails: settings.storePageDetails !== false,
    minTrackedRate: 1
  };
}

function normalizeSiteStats(site = {}) {
  return {
    savedSeconds: Number(site.savedSeconds || 0), mediaSeconds: Number(site.mediaSeconds || 0), wallSeconds: Number(site.wallSeconds || 0),
    sessions: Number(site.sessions || 0), lastSeen: site.lastSeen || null, lastTitle: String(site.lastTitle || ''), lastUrl: String(site.lastUrl || ''),
    rateWeightedMediaSum: Number(site.rateWeightedMediaSum || 0), peakRate: Number(site.peakRate || 1)
  };
}

function normalizeSourceStats(source = {}) {
  return {
    savedSeconds: Number(source.savedSeconds || 0), mediaSeconds: Number(source.mediaSeconds || 0), wallSeconds: Number(source.wallSeconds || 0),
    sessions: Number(source.sessions || 0), lastSeen: source.lastSeen || null, rateWeightedMediaSum: Number(source.rateWeightedMediaSum || 0), peakRate: Number(source.peakRate || 1)
  };
}

function normalizeSourceMeta(source = {}) {
  return {
    id: String(source.id || ''), origin: String(source.origin || 'unknown'), label: String(source.label || source.id || source.origin || 'source'), kind: String(source.kind || 'page'),
    lastSeen: source.lastSeen || null, lastTitle: String(source.lastTitle || ''), lastUrl: String(source.lastUrl || '')
  };
}

function normalizeDayStats(day = {}) {
  return {
    savedSeconds: Number(day.savedSeconds || 0), mediaSeconds: Number(day.mediaSeconds || 0), wallSeconds: Number(day.wallSeconds || 0), sessions: Number(day.sessions || 0)
  };
}

function normalizeHistogramMap(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) out[String(key)] = Number(value || 0);
  return out;
}

function deriveSourceIdentityFromData(origin, rawUrl, rawTitle) {
  const host = String(origin || 'unknown').toLowerCase();
  const title = String(rawTitle || '').trim();
  const url = safeUrl(rawUrl);
  if (!rawUrl && !rawTitle) return { sourceId: `host:${host}`, sourceLabel: host, sourceKind: 'host' };
  if (url) {
    const hostname = url.hostname.replace(/^www\./, '').toLowerCase();
    if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
      const v = url.searchParams.get('v');
      if (v) return { sourceId: `yt:${v}`, sourceLabel: title || `YouTube ${v}`, sourceKind: 'youtube' };
    }
    if (hostname === 'youtu.be') {
      const seg = url.pathname.split('/').filter(Boolean)[0];
      if (seg) return { sourceId: `yt:${seg}`, sourceLabel: title || `YouTube ${seg}`, sourceKind: 'youtube' };
    }
    if (hostname === 'vimeo.com' || hostname.endsWith('.vimeo.com')) {
      const seg = url.pathname.split('/').filter(Boolean)[0];
      if (seg && /^\d+$/.test(seg)) return { sourceId: `vimeo:${seg}`, sourceLabel: title || `Vimeo ${seg}`, sourceKind: 'vimeo' };
    }
    const path = url.pathname || '/';
    const coarsePath = path.length > 120 ? `${path.slice(0, 117)}…` : path;
    return { sourceId: `page:${hostname}${coarsePath}`, sourceLabel: title || `${hostname}${coarsePath}`, sourceKind: 'page' };
  }
  return { sourceId: `host:${host}`, sourceLabel: title || host, sourceKind: 'host' };
}

function normalizeSession(session = {}) {
  const derived = deriveSourceIdentityFromData(session.origin || 'unknown', session.url || '', session.title || '');
  return {
    id: String(session.id || ''), origin: String(session.origin || 'unknown'), url: String(session.url || ''), title: String(session.title || ''),
    sourceId: String(session.sourceId || derived.sourceId), sourceLabel: String(session.sourceLabel || derived.sourceLabel), sourceKind: String(session.sourceKind || derived.sourceKind),
    startedAt: Number(session.startedAt || Date.now()), endedAt: Number(session.endedAt || Date.now()),
    mediaSeconds: Number(session.mediaSeconds || 0), wallSeconds: Number(session.wallSeconds || 0), savedSeconds: Number(session.savedSeconds || 0),
    avgRate: Math.max(1, Number(session.avgRate || 1)), peakRate: Math.max(1, Number(session.peakRate || 1))
  };
}

function normalizeAchievement(item = {}) {
  return { thresholdSeconds: Number(item.thresholdSeconds || 0), reachedAt: item.reachedAt == null ? null : Number(item.reachedAt) };
}

function normalizeTimelinePoint(point = {}) {
  const mediaSeconds = Number(point.mediaSeconds || 0);
  const wallSeconds = Number(point.wallSeconds || 0);
  const rateWeightedMediaSum = Number(point.rateWeightedMediaSum || (Number(point.avgRate || 1) * Math.max(mediaSeconds, 0)));
  return {
    t: minuteBucket(point.t || Date.now()), sourceId: String(point.sourceId || ''), mediaSeconds, wallSeconds,
    savedSeconds: Number(point.savedSeconds || 0), rateWeightedMediaSum,
    avgRate: mediaSeconds > 0 ? rateWeightedMediaSum / mediaSeconds : Math.max(1, Number(point.avgRate || 1))
  };
}

function sortTopSessions(sessions) {
  return [...sessions].map(normalizeSession).filter((item) => item.savedSeconds > 0).sort((a, b) => {
    if (b.savedSeconds !== a.savedSeconds) return b.savedSeconds - a.savedSeconds;
    return b.endedAt - a.endedAt;
  });
}

function getRateBucket(rate) {
  for (const bucket of RATE_BUCKETS) if (rate <= bucket.max) return bucket.key;
  return RATE_BUCKETS[RATE_BUCKETS.length - 1].key;
}

function shortDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = seconds / 3600;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
}

function storageVersionData(raw) { return typeof raw === 'object' && raw ? Number(raw.version || 0) : 0; }

function migrateState(raw) {
  const incoming = typeof raw === 'object' && raw ? raw : {};
  const version = storageVersionData(incoming);
  const settings = normalizeSettings(incoming.settings || DEFAULT_SETTINGS);
  const bySite = {}; for (const [key, value] of Object.entries(incoming.bySite || {})) bySite[key] = normalizeSiteStats(value);
  const bySource = {}; for (const [key, value] of Object.entries(incoming.bySource || {})) bySource[key] = normalizeSourceStats(value);
  const sourceCatalog = {}; for (const [key, value] of Object.entries(incoming.sourceCatalog || {})) sourceCatalog[key] = normalizeSourceMeta({ ...value, id: value?.id || key });
  const byDay = {}; for (const [key, value] of Object.entries(incoming.byDay || {})) byDay[key] = normalizeDayStats(value);
  const byWeekday = normalizeHistogramMap(incoming.byWeekday || {});
  const byHour = normalizeHistogramMap(incoming.byHour || {});
  const rateHistogram = normalizeHistogramMap(incoming.rateHistogram || {});
  const recentSessions = Array.isArray(incoming.recentSessions) ? incoming.recentSessions.map(normalizeSession).filter((session) => session.mediaSeconds > 0) : [];
  let topSessions = Array.isArray(incoming.topSessions) ? sortTopSessions(incoming.topSessions).slice(0, 20) : [];
  let longestSession = incoming.longestSession ? normalizeSession(incoming.longestSession) : null;
  if (!longestSession && recentSessions.length) longestSession = sortTopSessions(recentSessions)[0] || null;
  if (topSessions.length === 0 && recentSessions.length) topSessions = sortTopSessions([...recentSessions, ...(longestSession ? [longestSession] : [])]).slice(0, 20);
  let bestDay = incoming.bestDay && typeof incoming.bestDay === 'object' ? { dateKey: String(incoming.bestDay.dateKey || ''), savedSeconds: Number(incoming.bestDay.savedSeconds || 0) } : null;
  if (!bestDay || !bestDay.dateKey) {
    for (const [dateKey, stats] of Object.entries(byDay)) {
      const savedSeconds = Number(stats.savedSeconds || 0);
      if (!bestDay || savedSeconds > bestDay.savedSeconds) bestDay = { dateKey, savedSeconds };
    }
  }
  if (version < 3) {
    for (const [dateKey, stats] of Object.entries(byDay)) {
      const d = new Date(`${dateKey}T12:00:00`);
      if (!Number.isNaN(d.getTime())) byWeekday[String(d.getDay())] = Number(byWeekday[String(d.getDay())] || 0) + Number(stats.savedSeconds || 0);
    }
  }
  const achievements = Array.isArray(incoming.achievements) ? incoming.achievements.map(normalizeAchievement).filter((item) => item.thresholdSeconds > 0) : [];
  const totalSavedSeconds = Number(incoming.totalSavedSeconds || 0);
  for (const thresholdSeconds of ACHIEVEMENT_THRESHOLDS) {
    if (thresholdSeconds <= totalSavedSeconds && !achievements.some((item) => item.thresholdSeconds === thresholdSeconds)) achievements.push({ thresholdSeconds, reachedAt: null });
  }
  achievements.sort((a, b) => a.thresholdSeconds - b.thresholdSeconds);
  const speedTimeline = Array.isArray(incoming.speedTimeline) ? incoming.speedTimeline.map(normalizeTimelinePoint).filter((point) => point.mediaSeconds > 0 && point.sourceId) : [];
  if (version < 4) {
    for (const session of recentSessions) {
      const sourceMeta = sourceCatalog[session.sourceId] || normalizeSourceMeta({
        id: session.sourceId, origin: session.origin, label: session.sourceLabel, kind: session.sourceKind,
        lastSeen: session.endedAt, lastTitle: settings.storePageDetails ? session.title : '', lastUrl: settings.storePageDetails ? session.url : ''
      });
      sourceMeta.lastSeen = Math.max(Number(sourceMeta.lastSeen || 0), Number(session.endedAt || 0)) || null;
      if (settings.storePageDetails) { if (session.title) sourceMeta.lastTitle = session.title; if (session.url) sourceMeta.lastUrl = session.url; }
      sourceCatalog[session.sourceId] = sourceMeta;
    }
  }
  return {
    version: DEFAULTS.version, totalSavedSeconds, totalMediaSeconds: Number(incoming.totalMediaSeconds || 0), totalWallSeconds: Number(incoming.totalWallSeconds || 0), totalSessions: Number(incoming.totalSessions || 0),
    bySite, bySource, sourceCatalog, byDay, byWeekday, byHour, rateHistogram, recentSessions: recentSessions.slice(0, settings.sessionHistoryLimit), topSessions,
    longestSession, bestDay, achievements, speedTimeline, lastUpdated: incoming.lastUpdated || null, settings
  };
}

async function getData() {
  const stored = await browser.storage.local.get();
  const merged = { ...deepClone(DEFAULTS), ...stored };
  return migrateState(merged);
}

function cleanupData(data) {
  const keepDays = data.settings.keepDays;
  const keys = Object.keys(data.byDay).sort();
  if (keys.length > keepDays) {
    const toRemove = keys.slice(0, keys.length - keepDays);
    for (const key of toRemove) delete data.byDay[key];
    recomputeBestDay(data);
  }
  data.recentSessions = data.recentSessions.map(normalizeSession).sort((a, b) => b.endedAt - a.endedAt).slice(0, data.settings.sessionHistoryLimit);
  data.topSessions = sortTopSessions(data.topSessions).slice(0, 20);
  if (data.longestSession) data.longestSession = normalizeSession(data.longestSession);
  const minTimelineTs = Date.now() - (data.settings.timelineRetentionDays * 86400000);
  data.speedTimeline = (data.speedTimeline || []).map(normalizeTimelinePoint).filter((point) => point.t >= minTimelineTs).sort((a, b) => a.t - b.t).slice(-TIMELINE_POINT_CAP);
  if (data.settings.storePageDetails === false) {
    for (const site of Object.values(data.bySite)) { site.lastTitle = ''; site.lastUrl = ''; }
    for (const meta of Object.values(data.sourceCatalog)) { meta.lastTitle = ''; meta.lastUrl = ''; if (meta.kind !== 'host') meta.label = meta.origin || meta.label; }
    data.recentSessions = data.recentSessions.map((session) => ({ ...session, title: '', url: '' }));
    data.topSessions = data.topSessions.map((session) => ({ ...session, title: '', url: '' }));
    if (data.longestSession) data.longestSession = { ...data.longestSession, title: '', url: '' };
  }
}

function recomputeBestDay(data) {
  let bestDay = null;
  for (const [dateKey, stats] of Object.entries(data.byDay)) {
    const savedSeconds = Number(stats.savedSeconds || 0);
    if (!bestDay || savedSeconds > bestDay.savedSeconds) bestDay = { dateKey, savedSeconds };
  }
  data.bestDay = bestDay;
}

function updateBestDay(data, dateKey) {
  const dayStats = data.byDay[dateKey];
  const savedSeconds = Number(dayStats?.savedSeconds || 0);
  if (!data.bestDay || savedSeconds > Number(data.bestDay.savedSeconds || 0)) data.bestDay = { dateKey, savedSeconds };
}

function updateAchievements(data, timestamp) {
  for (const thresholdSeconds of ACHIEVEMENT_THRESHOLDS) {
    if (data.totalSavedSeconds >= thresholdSeconds && !data.achievements.some((item) => item.thresholdSeconds === thresholdSeconds)) data.achievements.push({ thresholdSeconds, reachedAt: timestamp });
  }
  data.achievements.sort((a, b) => a.thresholdSeconds - b.thresholdSeconds);
}

async function updateBadge(data) {
  if (!actionApi || typeof actionApi.setBadgeText !== 'function') return;
  const mode = data.settings.badgeMode;
  let text = '';
  if (mode === 'today_saved') {
    const today = data.byDay[makeLocalDayKey()] || normalizeDayStats();
    text = today.savedSeconds > 0 ? shortDuration(today.savedSeconds) : '';
  } else if (mode === 'week_saved') {
    const now = Date.now(); let total = 0;
    for (let i = 0; i < 7; i += 1) total += Number(data.byDay[makeLocalDayKey(now - i * 86400000)]?.savedSeconds || 0);
    text = total > 0 ? shortDuration(total) : '';
  } else if (mode === 'total_saved') {
    text = data.totalSavedSeconds > 0 ? shortDuration(data.totalSavedSeconds) : '';
  } else if (mode === 'avg_speed') {
    const avgRate = data.totalWallSeconds > 0 ? data.totalMediaSeconds / data.totalWallSeconds : 1;
    text = avgRate > 1.01 ? `${avgRate.toFixed(avgRate >= 10 ? 0 : 1)}x` : '';
  }
  await actionApi.setBadgeText({ text });
  if (text) {
    await actionApi.setBadgeBackgroundColor({ color: '#1769aa' }).catch(() => {});
    if (typeof actionApi.setBadgeTextColor === 'function') await actionApi.setBadgeTextColor({ color: '#ffffff' }).catch(() => {});
  }
}

function enqueue(mutator) {
  writeQueue = writeQueue.then(async () => {
    const data = await getData();
    await mutator(data);
    data.lastUpdated = Date.now();
    cleanupData(data);
    await browser.storage.local.set(data);
    await updateBadge(data);
  }).catch((error) => { console.error('Speed Savings Tracker update failed', error); });
  return writeQueue;
}

function applyDeltaToAggregate(target, delta) {
  target.savedSeconds = Number(target.savedSeconds || 0) + delta.savedSeconds;
  target.mediaSeconds = Number(target.mediaSeconds || 0) + delta.mediaSeconds;
  target.wallSeconds = Number(target.wallSeconds || 0) + delta.wallSeconds;
  target.rateWeightedMediaSum = Number(target.rateWeightedMediaSum || 0) + (delta.avgRate * delta.mediaSeconds);
  target.peakRate = Math.max(Number(target.peakRate || 1), delta.avgRate);
  return target;
}

function noteSessionInTopSessions(data, session) {
  data.topSessions = sortTopSessions([session, ...(data.topSessions || [])]).slice(0, 20);
}

function ensureSourceCatalogEntry(data, sourceInput) {
  const identity = sourceInput && sourceInput.sourceId ? {
    sourceId: String(sourceInput.sourceId || ''), sourceLabel: String(sourceInput.sourceLabel || sourceInput.sourceId || ''), sourceKind: String(sourceInput.sourceKind || 'page')
  } : deriveSourceIdentityFromData(sourceInput.origin || 'unknown', sourceInput.url || '', sourceInput.title || '');
  if (!identity.sourceId) identity.sourceId = `host:${String(sourceInput.origin || 'unknown').toLowerCase()}`;
  const meta = normalizeSourceMeta(data.sourceCatalog[identity.sourceId] || {
    id: identity.sourceId, origin: String(sourceInput.origin || 'unknown'), label: identity.sourceLabel, kind: identity.sourceKind,
    lastSeen: sourceInput.timestamp || sourceInput.endedAt || null,
    lastTitle: sanitizeDetailString(sourceInput.title, data.settings.storePageDetails), lastUrl: sanitizeDetailString(sourceInput.url, data.settings.storePageDetails)
  });
  meta.id = identity.sourceId; meta.origin = String(sourceInput.origin || meta.origin || 'unknown'); meta.kind = identity.sourceKind || meta.kind || 'page';
  meta.lastSeen = Math.max(Number(meta.lastSeen || 0), Number(sourceInput.timestamp || sourceInput.endedAt || 0)) || meta.lastSeen || null;
  if (data.settings.storePageDetails) {
    if (identity.sourceLabel) meta.label = identity.sourceLabel;
    if (sourceInput.title) meta.lastTitle = String(sourceInput.title);
    if (sourceInput.url) meta.lastUrl = String(sourceInput.url);
  } else {
    meta.label = meta.origin || meta.label || identity.sourceId; meta.lastTitle = ''; meta.lastUrl = '';
  }
  data.sourceCatalog[identity.sourceId] = meta;
  data.bySource[identity.sourceId] = normalizeSourceStats(data.bySource[identity.sourceId]);
  return identity.sourceId;
}

function addTimelineSample(data, sample) {
  if (!sample.sourceId) return;
  const point = normalizeTimelinePoint({ t: sample.timestamp, sourceId: sample.sourceId, mediaSeconds: sample.mediaSeconds, wallSeconds: sample.wallSeconds, savedSeconds: sample.savedSeconds, avgRate: sample.avgRate });
  if (point.mediaSeconds <= 0 || point.avgRate <= 1.001) return;
  const timeline = data.speedTimeline || (data.speedTimeline = []);
  const last = timeline[timeline.length - 1];
  if (last && last.sourceId === point.sourceId && minuteBucket(last.t) === point.t) {
    last.mediaSeconds += point.mediaSeconds; last.wallSeconds += point.wallSeconds; last.savedSeconds += point.savedSeconds; last.rateWeightedMediaSum += point.rateWeightedMediaSum;
    last.avgRate = last.mediaSeconds > 0 ? last.rateWeightedMediaSum / last.mediaSeconds : point.avgRate;
  } else {
    timeline.push(point);
  }
}

function mergeTimelinePoints(existing, incoming) {
  const bucketed = new Map();
  for (const point of [...(existing || []), ...(incoming || [])].map(normalizeTimelinePoint)) {
    if (!point.sourceId || point.mediaSeconds <= 0) continue;
    const key = `${point.t}:${point.sourceId}`;
    const current = bucketed.get(key);
    if (!current) bucketed.set(key, { ...point });
    else {
      current.mediaSeconds += point.mediaSeconds; current.wallSeconds += point.wallSeconds; current.savedSeconds += point.savedSeconds; current.rateWeightedMediaSum += point.rateWeightedMediaSum;
      current.avgRate = current.mediaSeconds > 0 ? current.rateWeightedMediaSum / current.mediaSeconds : current.avgRate;
    }
  }
  return [...bucketed.values()].sort((a, b) => a.t - b.t).slice(-TIMELINE_POINT_CAP);
}

function mergeIncomingState(current, incomingRaw, mode = 'replace') {
  const incoming = migrateState({ ...deepClone(DEFAULTS), ...(incomingRaw || {}) });
  if (mode !== 'merge') return incoming;
  const merged = migrateState({ ...deepClone(DEFAULTS), ...current });
  merged.totalSavedSeconds += incoming.totalSavedSeconds; merged.totalMediaSeconds += incoming.totalMediaSeconds; merged.totalWallSeconds += incoming.totalWallSeconds; merged.totalSessions += incoming.totalSessions;
  for (const [host, stats] of Object.entries(incoming.bySite)) {
    merged.bySite[host] = applyDeltaToAggregate(normalizeSiteStats(merged.bySite[host]), {
      savedSeconds: Number(stats.savedSeconds || 0), mediaSeconds: Number(stats.mediaSeconds || 0), wallSeconds: Number(stats.wallSeconds || 0),
      avgRate: Number(stats.mediaSeconds || 0) > 0 ? Number(stats.rateWeightedMediaSum || 0) / Number(stats.mediaSeconds || 1) : 1
    });
    merged.bySite[host].sessions += Number(stats.sessions || 0); merged.bySite[host].lastSeen = Math.max(Number(merged.bySite[host].lastSeen || 0), Number(stats.lastSeen || 0)) || null;
    if (Number(stats.lastSeen || 0) >= Number(merged.bySite[host].lastSeen || 0)) { merged.bySite[host].lastTitle = stats.lastTitle || merged.bySite[host].lastTitle; merged.bySite[host].lastUrl = stats.lastUrl || merged.bySite[host].lastUrl; }
  }
  for (const [sourceId, stats] of Object.entries(incoming.bySource)) {
    merged.bySource[sourceId] = applyDeltaToAggregate(normalizeSourceStats(merged.bySource[sourceId]), {
      savedSeconds: Number(stats.savedSeconds || 0), mediaSeconds: Number(stats.mediaSeconds || 0), wallSeconds: Number(stats.wallSeconds || 0),
      avgRate: Number(stats.mediaSeconds || 0) > 0 ? Number(stats.rateWeightedMediaSum || 0) / Number(stats.mediaSeconds || 1) : 1
    });
    merged.bySource[sourceId].sessions += Number(stats.sessions || 0); merged.bySource[sourceId].lastSeen = Math.max(Number(merged.bySource[sourceId].lastSeen || 0), Number(stats.lastSeen || 0)) || null;
  }
  for (const [sourceId, meta] of Object.entries(incoming.sourceCatalog || {})) {
    const currentMeta = normalizeSourceMeta(merged.sourceCatalog[sourceId] || {}); const incomingMeta = normalizeSourceMeta(meta);
    const preferIncoming = Number(incomingMeta.lastSeen || 0) >= Number(currentMeta.lastSeen || 0);
    merged.sourceCatalog[sourceId] = {
      id: sourceId, origin: incomingMeta.origin || currentMeta.origin, label: preferIncoming ? incomingMeta.label : currentMeta.label, kind: incomingMeta.kind || currentMeta.kind,
      lastSeen: Math.max(Number(currentMeta.lastSeen || 0), Number(incomingMeta.lastSeen || 0)) || null,
      lastTitle: preferIncoming ? incomingMeta.lastTitle : currentMeta.lastTitle, lastUrl: preferIncoming ? incomingMeta.lastUrl : currentMeta.lastUrl
    };
  }
  for (const [key, stats] of Object.entries(incoming.byDay)) {
    merged.byDay[key] = applyDeltaToAggregate(normalizeDayStats(merged.byDay[key]), {
      savedSeconds: Number(stats.savedSeconds || 0), mediaSeconds: Number(stats.mediaSeconds || 0), wallSeconds: Number(stats.wallSeconds || 0),
      avgRate: Number(stats.mediaSeconds || 0) > 0 ? Number(stats.mediaSeconds || 0) / Math.max(1, Number(stats.wallSeconds || 1)) : 1
    });
    merged.byDay[key].sessions += Number(stats.sessions || 0);
  }
  for (const [key, value] of Object.entries(incoming.byWeekday)) merged.byWeekday[key] = Number(merged.byWeekday[key] || 0) + Number(value || 0);
  for (const [key, value] of Object.entries(incoming.byHour)) merged.byHour[key] = Number(merged.byHour[key] || 0) + Number(value || 0);
  for (const [key, value] of Object.entries(incoming.rateHistogram)) merged.rateHistogram[key] = Number(merged.rateHistogram[key] || 0) + Number(value || 0);
  const sessionIds = new Set();
  merged.recentSessions = [...(merged.recentSessions || []), ...(incoming.recentSessions || [])].map(normalizeSession).filter((session) => {
    if (!session.id) return true; if (sessionIds.has(session.id)) return false; sessionIds.add(session.id); return true;
  }).sort((a, b) => b.endedAt - a.endedAt).slice(0, merged.settings.sessionHistoryLimit);
  merged.topSessions = sortTopSessions([...(merged.topSessions || []), ...(incoming.topSessions || []), ...(incoming.longestSession ? [incoming.longestSession] : [])]).slice(0, 20);
  if (!merged.longestSession || (incoming.longestSession && incoming.longestSession.savedSeconds > merged.longestSession.savedSeconds)) merged.longestSession = incoming.longestSession;
  for (const item of incoming.achievements || []) if (!merged.achievements.some((existing) => existing.thresholdSeconds === item.thresholdSeconds)) merged.achievements.push(normalizeAchievement(item));
  merged.achievements.sort((a, b) => a.thresholdSeconds - b.thresholdSeconds);
  merged.speedTimeline = mergeTimelinePoints(merged.speedTimeline, incoming.speedTimeline);
  merged.settings = normalizeSettings({ ...merged.settings, ...incoming.settings });
  recomputeBestDay(merged); updateAchievements(merged, Date.now());
  return merged;
}

browser.runtime.onInstalled.addListener(async () => { const data = await getData(); await browser.storage.local.set(data); await updateBadge(data); });
browser.runtime.onStartup?.addListener(async () => { const data = await getData(); await browser.storage.local.set(data); await updateBadge(data); });

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== 'object') return undefined;
  if (message.type === 'TRACK_DELTA') {
    return enqueue(async (data) => {
      const delta = {
        origin: String(message.origin || 'unknown'), title: sanitizeDetailString(message.title, data.settings.storePageDetails), url: sanitizeDetailString(message.url, data.settings.storePageDetails),
        sourceId: String(message.sourceId || ''), sourceLabel: sanitizeDetailString(message.sourceLabel, data.settings.storePageDetails), sourceKind: String(message.sourceKind || 'page'),
        mediaSeconds: Math.max(0, Number(message.mediaSeconds || 0)), wallSeconds: Math.max(0, Number(message.wallSeconds || 0)), savedSeconds: Math.max(0, Number(message.savedSeconds || 0)),
        avgRate: Math.max(1, Number(message.avgRate || 1)), timestamp: Number(message.timestamp || Date.now())
      };
      if (delta.mediaSeconds <= 0 || delta.savedSeconds <= 0 || delta.wallSeconds < 0 || delta.avgRate <= 1.001) return;
      data.totalSavedSeconds += delta.savedSeconds; data.totalMediaSeconds += delta.mediaSeconds; data.totalWallSeconds += delta.wallSeconds;
      data.bySite[delta.origin] = applyDeltaToAggregate(normalizeSiteStats(data.bySite[delta.origin]), delta); data.bySite[delta.origin].lastSeen = delta.timestamp;
      if (data.settings.storePageDetails) { data.bySite[delta.origin].lastTitle = delta.title; data.bySite[delta.origin].lastUrl = delta.url; }
      const sourceId = ensureSourceCatalogEntry(data, delta);
      data.bySource[sourceId] = applyDeltaToAggregate(normalizeSourceStats(data.bySource[sourceId]), delta); data.bySource[sourceId].lastSeen = delta.timestamp;
      const dayKey = makeLocalDayKey(delta.timestamp);
      data.byDay[dayKey] = applyDeltaToAggregate(normalizeDayStats(data.byDay[dayKey]), delta);
      data.byWeekday[String(new Date(delta.timestamp).getDay())] = Number(data.byWeekday[String(new Date(delta.timestamp).getDay())] || 0) + delta.savedSeconds;
      data.byHour[String(new Date(delta.timestamp).getHours())] = Number(data.byHour[String(new Date(delta.timestamp).getHours())] || 0) + delta.savedSeconds;
      const bucket = getRateBucket(delta.avgRate); data.rateHistogram[bucket] = Number(data.rateHistogram[bucket] || 0) + delta.mediaSeconds;
      addTimelineSample(data, { ...delta, sourceId }); updateBestDay(data, dayKey); updateAchievements(data, delta.timestamp);
    });
  }
  if (message.type === 'SESSION_SUMMARY') {
    return enqueue(async (data) => {
      const session = normalizeSession(message.session || {});
      if (session.mediaSeconds <= 0 || session.savedSeconds <= 0) return;
      if (!data.settings.storePageDetails) { session.url = ''; session.title = ''; }
      const sourceId = ensureSourceCatalogEntry(data, {
        origin: session.origin, title: session.title, url: session.url, sourceId: session.sourceId, sourceLabel: session.sourceLabel, sourceKind: session.sourceKind, endedAt: session.endedAt
      });
      session.sourceId = sourceId; session.sourceLabel = data.sourceCatalog[sourceId]?.label || session.sourceLabel; session.sourceKind = data.sourceCatalog[sourceId]?.kind || session.sourceKind;
      data.totalSessions += 1;
      data.bySite[session.origin] = normalizeSiteStats(data.bySite[session.origin]); data.bySite[session.origin].sessions += 1; data.bySite[session.origin].lastSeen = session.endedAt; data.bySite[session.origin].peakRate = Math.max(Number(data.bySite[session.origin].peakRate || 1), Number(session.peakRate || 1));
      if (data.settings.storePageDetails) { data.bySite[session.origin].lastTitle = session.title; data.bySite[session.origin].lastUrl = session.url; }
      data.bySource[sourceId] = normalizeSourceStats(data.bySource[sourceId]); data.bySource[sourceId].sessions += 1; data.bySource[sourceId].lastSeen = session.endedAt; data.bySource[sourceId].peakRate = Math.max(Number(data.bySource[sourceId].peakRate || 1), Number(session.peakRate || 1));
      const dayKey = makeLocalDayKey(session.endedAt); data.byDay[dayKey] = normalizeDayStats(data.byDay[dayKey]); data.byDay[dayKey].sessions += 1;
      data.recentSessions = [session, ...data.recentSessions.filter((item) => item.id !== session.id)].slice(0, data.settings.sessionHistoryLimit); noteSessionInTopSessions(data, session);
      if (!data.longestSession || session.savedSeconds > data.longestSession.savedSeconds) data.longestSession = session;
      updateBestDay(data, dayKey); updateAchievements(data, session.endedAt);
    });
  }
  if (message.type === 'RESET_ALL') {
    return enqueue(async (data) => { const preservedSettings = normalizeSettings(data.settings); Object.assign(data, deepClone(DEFAULTS)); data.settings = preservedSettings; });
  }
  if (message.type === 'RESET_EVERYTHING') {
    return enqueue(async (data) => { Object.assign(data, deepClone(DEFAULTS)); data.settings = normalizeSettings(DEFAULT_SETTINGS); });
  }
  if (message.type === 'SET_SETTINGS') {
    return enqueue(async (data) => {
      const previousStorePageDetails = data.settings.storePageDetails !== false;
      data.settings = normalizeSettings({ ...data.settings, ...(message.settings || {}) });
      if (previousStorePageDetails && data.settings.storePageDetails === false) {
        for (const site of Object.values(data.bySite)) { site.lastTitle = ''; site.lastUrl = ''; }
        for (const meta of Object.values(data.sourceCatalog)) { meta.lastTitle = ''; meta.lastUrl = ''; meta.label = meta.origin || meta.label; }
        data.recentSessions = data.recentSessions.map((session) => ({ ...session, title: '', url: '', sourceId: `host:${String(session.origin || 'unknown').toLowerCase()}`, sourceLabel: String(session.origin || 'unknown'), sourceKind: 'host' }));
        data.topSessions = data.topSessions.map((session) => ({ ...session, title: '', url: '', sourceId: `host:${String(session.origin || 'unknown').toLowerCase()}`, sourceLabel: String(session.origin || 'unknown'), sourceKind: 'host' }));
        data.speedTimeline = data.speedTimeline.map((point) => { const meta = normalizeSourceMeta(data.sourceCatalog[point.sourceId] || {}); return { ...point, sourceId: `host:${String(meta.origin || 'unknown').toLowerCase()}` }; });
        if (data.longestSession) data.longestSession = { ...data.longestSession, title: '', url: '', sourceId: `host:${String(data.longestSession.origin || 'unknown').toLowerCase()}`, sourceLabel: String(data.longestSession.origin || 'unknown'), sourceKind: 'host' };
        const collapsedCatalog = {}; const collapsedBySource = {};
        for (const [oldSourceId, stats] of Object.entries(data.bySource)) {
          const meta = normalizeSourceMeta(data.sourceCatalog[oldSourceId] || {}); const collapsedId = `host:${String(meta.origin || 'unknown').toLowerCase()}`;
          collapsedCatalog[collapsedId] = normalizeSourceMeta({ id: collapsedId, origin: meta.origin, label: meta.origin || collapsedId, kind: 'host', lastSeen: Math.max(Number(collapsedCatalog[collapsedId]?.lastSeen || 0), Number(meta.lastSeen || 0)) || null });
          collapsedBySource[collapsedId] = applyDeltaToAggregate(normalizeSourceStats(collapsedBySource[collapsedId]), {
            savedSeconds: Number(stats.savedSeconds || 0), mediaSeconds: Number(stats.mediaSeconds || 0), wallSeconds: Number(stats.wallSeconds || 0),
            avgRate: Number(stats.mediaSeconds || 0) > 0 ? Number(stats.rateWeightedMediaSum || 0) / Number(stats.mediaSeconds || 1) : 1
          });
          collapsedBySource[collapsedId].sessions += Number(stats.sessions || 0); collapsedBySource[collapsedId].lastSeen = Math.max(Number(collapsedBySource[collapsedId].lastSeen || 0), Number(stats.lastSeen || 0)) || null;
        }
        data.sourceCatalog = collapsedCatalog; data.bySource = collapsedBySource;
      }
    });
  }
  if (message.type === 'IMPORT_STATE') {
    return enqueue(async (data) => { const mode = message.mode === 'merge' ? 'merge' : 'replace'; const merged = mergeIncomingState(data, message.state, mode); Object.assign(data, merged); });
  }
  if (message.type === 'GET_EXPORT_STATE') return getData();
  return undefined;
});
