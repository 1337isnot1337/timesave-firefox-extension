let state = null;
let analyticsRangeMs = 6 * 60 * 60 * 1000;
let analyticsRangePreset = '21600000';
const DAY_MS = 24 * 60 * 60 * 1000;

async function getState() {
  state = await browser.runtime.sendMessage({ type: 'GET_EXPORT_STATE' });
  return state;
}

function setStatus(message) {
  const el = document.getElementById('saveStatus');
  el.textContent = message || '';
  if (!message) return;
  setTimeout(() => {
    if (el.textContent === message) el.textContent = '';
  }, 2200);
}

function heroCard(label, value, note) {
  return `
    <div class="hero-metric">
      <div class="hero-metric-label">${escapeHtml(label)}</div>
      <div class="hero-metric-value">${escapeHtml(value)}</div>
      <div class="hero-metric-note">${escapeHtml(note)}</div>
    </div>
  `;
}

function renderOverview(data) {
  const today = sumDays(data.byDay || {}, 1);
  const week = sumDays(data.byDay || {}, 7);
  const month = sumDays(data.byDay || {}, 30);
  const bestWeek = rollingBestWeek(data.byDay || {});
  const streak = getStreak(data.byDay || {});
  const projectedMonth = previousMonthProjection(data.byDay || {});
  const efficiencyPct = data.totalMediaSeconds > 0
    ? ((data.totalSavedSeconds || 0) / Math.max(1, data.totalMediaSeconds)) * 100
    : 0;
  const avgSessionSaved = (data.totalSessions || 0) > 0
    ? (data.totalSavedSeconds || 0) / Math.max(1, data.totalSessions || 1)
    : 0;
  const classesSaved = (data.totalSavedSeconds || 0) / (50 * 60);

  document.getElementById('heroGrid').innerHTML = [
    heroCard('All-time saved', formatDuration(data.totalSavedSeconds || 0), `${data.totalSessions || 0} sessions tracked`),
    heroCard('Today', compactDuration(today.savedSeconds), `${today.sessions} sessions`),
    heroCard('Last 7 days', compactDuration(week.savedSeconds), `${formatRateFromValues(week.mediaSeconds, week.wallSeconds)} average speed`),
    heroCard('Last 30 days', compactDuration(month.savedSeconds), `${month.sessions} sessions`),
    heroCard('Efficiency', `${efficiencyPct.toFixed(efficiencyPct >= 10 ? 0 : 1)}%`, `${classesSaved.toFixed(classesSaved >= 10 ? 0 : 1)} class periods saved`),
    heroCard(
      'Best rolling week',
      compactDuration(bestWeek.savedSeconds),
      bestWeek.start
        ? `${formatDay(bestWeek.start)} – ${formatDay(bestWeek.end)} · ${streak} day streak · ${compactDuration(projectedMonth)} projected month pace · avg ${compactDuration(avgSessionSaved)} per session`
        : 'Need more history'
    )
  ].join('');
}

function clampCustomDays(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 14;
  return Math.min(365, Math.max(1, Math.round(numeric)));
}

function currentRangeLabel() {
  if (analyticsRangeMs < DAY_MS) {
    const hours = analyticsRangeMs / (60 * 60 * 1000);
    return `Showing the last ${hours % 1 === 0 ? hours.toFixed(0) : hours.toFixed(1)} hour${hours === 1 ? '' : 's'}`;
  }
  const days = analyticsRangeMs / DAY_MS;
  return `Showing the last ${days.toFixed(days >= 10 ? 0 : 0)} day${days === 1 ? '' : 's'}`;
}

function updateRangeCaption() {
  const caption = document.getElementById('analyticsRangeCaption');
  if (caption) caption.textContent = currentRangeLabel();
}

function updateRangeIndicator() {
  const root = document.getElementById('analyticsRangeButtons');
  const indicator = document.getElementById('analyticsRangeIndicator');
  if (!root || !indicator) return;
  const active = root.querySelector('.segmented-button.active, .segmented-custom.active');
  if (!active) {
    indicator.style.opacity = '0';
    return;
  }
  const rootRect = root.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  indicator.style.opacity = '1';
  indicator.style.left = `${rect.left - rootRect.left}px`;
  indicator.style.width = `${rect.width}px`;
}

function syncRangeUI() {
  const customDaysInput = document.getElementById('customRangeDays');
  const customChip = document.getElementById('customRangeChip');
  document.querySelectorAll('#analyticsRangeButtons .segmented-button').forEach((button) => {
    const isActive = String(button.dataset.range || '') === analyticsRangePreset;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
  if (customChip) customChip.classList.toggle('active', analyticsRangePreset === 'custom');
  if (customDaysInput && analyticsRangePreset === 'custom') {
    customDaysInput.value = String(clampCustomDays(analyticsRangeMs / DAY_MS));
  }
  updateRangeCaption();
  requestAnimationFrame(updateRangeIndicator);
}

function triggerTimelineAnimation(direction) {
  const chart = document.getElementById('analyticsTimeline');
  const legend = document.getElementById('analyticsLegend');
  if (!chart || !legend) return;
  chart.classList.remove('animate-forward', 'animate-backward');
  legend.classList.remove('animate');
  void chart.offsetWidth;
  chart.classList.add(direction >= 0 ? 'animate-forward' : 'animate-backward');
  legend.classList.add('animate');
  window.setTimeout(() => {
    chart.classList.remove('animate-forward', 'animate-backward');
    legend.classList.remove('animate');
  }, 320);
}

function setAnalyticsRange(nextRangeMs, preset = 'custom') {
  const previous = analyticsRangeMs;
  analyticsRangeMs = Number(nextRangeMs || analyticsRangeMs);
  analyticsRangePreset = preset;
  syncRangeUI();
  if (state) {
    triggerTimelineAnimation(analyticsRangeMs >= previous ? 1 : -1);
    renderTimeline(state);
  }
}

function handleCustomRangeCommit() {
  const customDaysInput = document.getElementById('customRangeDays');
  const days = clampCustomDays(customDaysInput?.value);
  if (customDaysInput) customDaysInput.value = String(days);
  setAnalyticsRange(days * DAY_MS, 'custom');
}

function setRangeButtons() {
  document.querySelectorAll('#analyticsRangeButtons .segmented-button').forEach((button) => {
    button.addEventListener('click', () => {
      const rangeMs = Number(button.dataset.range || analyticsRangeMs);
      setAnalyticsRange(rangeMs, String(button.dataset.range || 'custom'));
    });
  });
  const customDaysInput = document.getElementById('customRangeDays');
  const customChip = document.getElementById('customRangeChip');
  customChip?.addEventListener('click', (event) => {
    if (event.target !== customDaysInput) handleCustomRangeCommit();
  });
  customDaysInput?.addEventListener('change', handleCustomRangeCommit);
  customDaysInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleCustomRangeCommit();
    }
  });
  customDaysInput?.addEventListener('focus', () => {
    analyticsRangePreset = 'custom';
    syncRangeUI();
  });
  syncRangeUI();
  window.addEventListener('resize', updateRangeIndicator);
}

function renderTimeline(data) {
  renderTimelineChart(
    document.getElementById('analyticsTimeline'),
    data,
    analyticsRangeMs,
    document.getElementById('analyticsLegend')
  );
  requestAnimationFrame(updateRangeIndicator);
}

function renderDistribution(data) {
  renderMiniBars(
    document.getElementById('histogram'),
    RATE_ORDER.map((key) => ({ label: key, value: Number((data.rateHistogram || {})[key] || 0) })),
    compactDuration
  );

  renderMiniBars(
    document.getElementById('weekdayBars'),
    WEEKDAY_LABELS.map((label, index) => ({
      label,
      value: Number(((data.byWeekday || {})[String(index)]) || 0)
    })),
    compactDuration
  );

  renderMiniBars(
    document.getElementById('hourBars'),
    Array.from({ length: 24 }, (_, hour) => ({
      label: `${String(hour).padStart(2, '0')}:00`,
      value: Number(((data.byHour || {})[String(hour)]) || 0)
    })),
    compactDuration
  );
}

function filteredSourceEntries(data) {
  const query = document.getElementById('sourceSearch').value.trim().toLowerCase();
  const sort = document.getElementById('sourceSort').value;

  const entries = getSourceEntries(data).filter((entry) => {
    if (entry.savedSeconds <= 0) return false;
    if (!query) return true;
    return `${entry.label} ${entry.origin}`.toLowerCase().includes(query);
  });

  entries.sort((a, b) => {
    if (sort === 'name') return a.label.localeCompare(b.label);
    if (sort === 'rate') return b.avgRate - a.avgRate;
    if (sort === 'sessions') return b.sessions - a.sessions;
    if (sort === 'recent') return b.lastSeen - a.lastSeen;
    return b.savedSeconds - a.savedSeconds;
  });

  return entries;
}

function renderSourceTable(data) {
  const tbody = document.getElementById('sourceTableBody');
  tbody.innerHTML = '';

  const entries = filteredSourceEntries(data);
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="6">No source entries match the current filter.</td></tr>';
    return;
  }

  for (const entry of entries.slice(0, 300)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="source-name">
          <span class="source-dot" style="background:${entry.color}"></span>
          <span>${escapeHtml(entry.label)}</span>
        </div>
        <div class="subtle">${escapeHtml(entry.origin)}</div>
      </td>
      <td>${compactDuration(entry.savedSeconds)}</td>
      <td>${formatRateFromValues(entry.mediaSeconds, entry.wallSeconds)}</td>
      <td>${Number(entry.peakRate || 1).toFixed(2).replace(/\.00$/, '')}×</td>
      <td>${entry.sessions}</td>
      <td>${entry.lastSeen ? new Date(entry.lastSeen).toLocaleString() : '—'}</td>
    `;
    tbody.appendChild(tr);
  }
}

function filteredSiteEntries(data) {
  const query = document.getElementById('siteSearch').value.trim().toLowerCase();
  const sort = document.getElementById('siteSort').value;

  const entries = Object.entries(data.bySite || {})
    .map(([host, stats]) => ({ host, stats }))
    .filter(({ host, stats }) => Number(stats.savedSeconds || 0) > 0 && (!query || host.toLowerCase().includes(query)));

  entries.sort((a, b) => {
    if (sort === 'name') return a.host.localeCompare(b.host);
    if (sort === 'rate') {
      const ar = Number(a.stats.mediaSeconds || 0) / Math.max(1, Number(a.stats.wallSeconds || 0));
      const br = Number(b.stats.mediaSeconds || 0) / Math.max(1, Number(b.stats.wallSeconds || 0));
      return br - ar;
    }
    if (sort === 'sessions') return Number(b.stats.sessions || 0) - Number(a.stats.sessions || 0);
    if (sort === 'watch') return Number(b.stats.wallSeconds || 0) - Number(a.stats.wallSeconds || 0);
    return Number(b.stats.savedSeconds || 0) - Number(a.stats.savedSeconds || 0);
  });

  return entries;
}

function renderSiteTable(data) {
  const tbody = document.getElementById('siteTableBody');
  tbody.innerHTML = '';

  const entries = filteredSiteEntries(data);
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="6">No site entries match the current filter.</td></tr>';
    return;
  }

  for (const entry of entries.slice(0, 300)) {
    const stats = entry.stats;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(entry.host)}</td>
      <td>${compactDuration(stats.savedSeconds || 0)}</td>
      <td>${compactDuration(stats.wallSeconds || 0)}</td>
      <td>${formatRateFromValues(stats.mediaSeconds || 0, stats.wallSeconds || 0)}</td>
      <td>${Number(stats.peakRate || 1).toFixed(2).replace(/\.00$/, '')}×</td>
      <td>${stats.sessions || 0}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderDaily(data) {
  renderDailyColumns(document.getElementById('dailyChart'), data, 30);
}

function filteredSessions(data) {
  const query = document.getElementById('sessionSearch').value.trim().toLowerCase();
  const sort = document.getElementById('sessionSort').value;

  const sessions = (Array.isArray(data.recentSessions) ? [...data.recentSessions] : []).filter((session) => {
    if (!query) return true;
    const haystack = `${session.origin || ''} ${session.title || ''} ${session.url || ''} ${session.sourceLabel || ''}`.toLowerCase();
    return haystack.includes(query);
  });

  sessions.sort((a, b) => {
    if (sort === 'saved') return Number(b.savedSeconds || 0) - Number(a.savedSeconds || 0);
    if (sort === 'rate') return Number(b.avgRate || 1) - Number(a.avgRate || 1);
    return Number(b.endedAt || 0) - Number(a.endedAt || 0);
  });

  return sessions;
}

function renderSessions(data) {
  const root = document.getElementById('recentSessions');
  root.innerHTML = '';

  const sessions = filteredSessions(data).slice(0, 40);
  if (!sessions.length) {
    root.innerHTML = '<div class="session-item">No tracked sessions yet.</div>';
  } else {
    for (const session of sessions) {
      const meta = (data.sourceCatalog || {})[session.sourceId] || {};
      const title = session.title || session.sourceLabel || meta.label || session.origin || 'Untitled session';
      const el = document.createElement('div');
      el.className = 'session-item';
      el.innerHTML = `
        <div class="session-head">
          <div class="session-title">${escapeHtml(title)}</div>
          <div class="session-value">${compactDuration(session.savedSeconds || 0)}</div>
        </div>
        <div class="session-meta">
          <span>${escapeHtml(session.origin || 'unknown')}</span>
          <span>${formatRateFromValues(session.mediaSeconds || 0, session.wallSeconds || 0)}</span>
          <span>${Number(session.peakRate || 1).toFixed(2).replace(/\.00$/, '')}× peak</span>
          <span>${new Date(session.endedAt || Date.now()).toLocaleString()}</span>
        </div>
      `;
      root.appendChild(el);
    }
  }

  const achievementRoot = document.getElementById('achievementList');
  achievementRoot.innerHTML = '';

  const topSessions = Array.isArray(data.topSessions) ? data.topSessions.slice(0, 4) : [];
  const achievements = Array.isArray(data.achievements)
    ? [...data.achievements].sort((a, b) => (b.reachedAt || 0) - (a.reachedAt || 0))
    : [];

  if (!topSessions.length && !achievements.length) {
    achievementRoot.innerHTML = '<div class="session-item">No milestones or standout sessions yet.</div>';
    return;
  }

  for (const session of topSessions) {
    const el = document.createElement('div');
    el.className = 'session-item';
    el.innerHTML = `
      <div class="session-head">
        <div class="session-title">Top burst · ${escapeHtml(session.title || session.sourceLabel || session.origin || 'session')}</div>
        <div class="session-value">${compactDuration(session.savedSeconds || 0)}</div>
      </div>
      <div class="session-meta">
        <span>${formatRateFromValues(session.mediaSeconds || 0, session.wallSeconds || 0)}</span>
        <span>${Number(session.peakRate || 1).toFixed(2).replace(/\.00$/, '')}× peak</span>
        <span>${new Date(session.endedAt || Date.now()).toLocaleString()}</span>
      </div>
    `;
    achievementRoot.appendChild(el);
  }

  for (const item of achievements.slice(0, 4)) {
    const el = document.createElement('div');
    el.className = 'session-item';
    const when = item.reachedAt
      ? new Date(item.reachedAt).toLocaleString()
      : 'Reached before milestone timestamping';
    el.innerHTML = `
      <div class="session-head">
        <div class="session-title">Milestone · ${compactDuration(item.thresholdSeconds)} saved</div>
        <div class="session-value">✓</div>
      </div>
      <div class="session-meta"><span>${escapeHtml(when)}</span></div>
    `;
    achievementRoot.appendChild(el);
  }
}

function renderSettings(data) {
  const settings = data.settings || {};
  document.getElementById('badgeMode').value = settings.badgeMode || 'today_saved';
  document.getElementById('keepDays').value = String(settings.keepDays || 180);
  document.getElementById('sessionHistoryLimit').value = String(settings.sessionHistoryLimit || 180);
  document.getElementById('timelineRetentionDays').value = String(settings.timelineRetentionDays || 14);
  document.getElementById('trackOnlyVisible').checked = settings.trackOnlyVisible !== false;
  document.getElementById('storePageDetails').checked = settings.storePageDetails !== false;
  document.getElementById('excludedHosts').value = Array.isArray(settings.excludedHosts)
    ? settings.excludedHosts.join('\n')
    : '';
}

function renderDiagnostics(data) {
  document.getElementById('storageSizeValue').textContent = formatBytes(roughStorageSize(data));
  document.getElementById('timelinePointCountValue').textContent = String((data.speedTimeline || []).length);
  document.getElementById('schemaVersionValue').textContent = String(data.version || 4);
  document.getElementById('recentCountValue').textContent = String((data.recentSessions || []).length);
}

function buildCsv(data) {
  const lines = [[
    'type', 'name', 'origin_or_site', 'saved_seconds', 'media_seconds', 'wall_seconds',
    'avg_rate', 'peak_rate', 'sessions', 'last_seen'
  ]];

  for (const entry of getSourceEntries(data).sort((a, b) => b.savedSeconds - a.savedSeconds)) {
    lines.push([
      'source',
      entry.label,
      entry.origin,
      entry.savedSeconds,
      entry.mediaSeconds,
      entry.wallSeconds,
      entry.avgRate.toFixed(4),
      entry.peakRate,
      entry.sessions,
      entry.lastSeen ? new Date(entry.lastSeen).toISOString() : ''
    ]);
  }

  for (const [host, stats] of Object.entries(data.bySite || {}).sort((a, b) => Number(b[1].savedSeconds || 0) - Number(a[1].savedSeconds || 0))) {
    const avgRate = Number(stats.wallSeconds || 0) > 0
      ? Number(stats.mediaSeconds || 0) / Number(stats.wallSeconds || 1)
      : 1;
    lines.push([
      'site',
      host,
      host,
      Number(stats.savedSeconds || 0),
      Number(stats.mediaSeconds || 0),
      Number(stats.wallSeconds || 0),
      avgRate.toFixed(4),
      Number(stats.peakRate || 1),
      Number(stats.sessions || 0),
      stats.lastSeen ? new Date(stats.lastSeen).toISOString() : ''
    ]);
  }

  return lines
    .map((row) => row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(','))
    .join('\n');
}

function selectedImportMode() {
  return document.querySelector('input[name="importMode"]:checked')?.value === 'merge' ? 'merge' : 'replace';
}

async function saveSettings() {
  const settings = {
    badgeMode: document.getElementById('badgeMode').value,
    keepDays: Number(document.getElementById('keepDays').value),
    sessionHistoryLimit: Number(document.getElementById('sessionHistoryLimit').value),
    timelineRetentionDays: Number(document.getElementById('timelineRetentionDays').value),
    trackOnlyVisible: document.getElementById('trackOnlyVisible').checked,
    storePageDetails: document.getElementById('storePageDetails').checked,
    excludedHosts: document.getElementById('excludedHosts').value
      .split('\n')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  };

  await browser.runtime.sendMessage({ type: 'SET_SETTINGS', settings });
  state = await getState();
  renderSettings(state);
  renderDiagnostics(state);
  renderTimeline(state);
  renderSourceTable(state);
  renderSiteTable(state);
  renderSessions(state);
  setStatus('Settings saved.');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function exportJson() {
  const data = await browser.runtime.sendMessage({ type: 'GET_EXPORT_STATE' });
  downloadBlob(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    `speed-savings-export-${new Date().toISOString().slice(0, 10)}.json`
  );
}

async function exportCsv() {
  const data = await browser.runtime.sendMessage({ type: 'GET_EXPORT_STATE' });
  downloadBlob(
    new Blob([buildCsv(data)], { type: 'text/csv' }),
    `speed-savings-report-${new Date().toISOString().slice(0, 10)}.csv`
  );
}

async function importJson(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const parsed = JSON.parse(await file.text());
  await browser.runtime.sendMessage({ type: 'IMPORT_STATE', state: parsed, mode: selectedImportMode() });
  state = await getState();
  renderAll(state);
  setStatus('Import complete.');
  event.target.value = '';
}

async function resetStats() {
  if (!window.confirm('Reset all tracked statistics while keeping your settings?')) return;
  await browser.runtime.sendMessage({ type: 'RESET_ALL' });
  state = await getState();
  renderAll(state);
  setStatus('Tracked stats reset.');
}

async function resetEverything() {
  if (!window.confirm('Reset everything, including settings?')) return;
  await browser.runtime.sendMessage({ type: 'RESET_EVERYTHING' });
  state = await getState();
  renderAll(state);
  setStatus('Everything reset.');
}

function bindFilters() {
  ['sourceSearch', 'sourceSort'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => renderSourceTable(state));
    document.getElementById(id).addEventListener('change', () => renderSourceTable(state));
  });

  ['siteSearch', 'siteSort'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => renderSiteTable(state));
    document.getElementById(id).addEventListener('change', () => renderSiteTable(state));
  });

  ['sessionSearch', 'sessionSort'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => renderSessions(state));
    document.getElementById(id).addEventListener('change', () => renderSessions(state));
  });
}

function renderAll(data) {
  renderOverview(data);
  renderTimeline(data);
  renderDistribution(data);
  renderSourceTable(data);
  renderSiteTable(data);
  renderDaily(data);
  renderSessions(data);
  renderSettings(data);
  renderDiagnostics(data);
}

function bindQuickNavSpy() {
  const links = [...document.querySelectorAll('.quick-nav-link')];
  const sections = links
    .map((link) => document.querySelector(link.getAttribute('href')))
    .filter(Boolean);
  const activate = (id) => {
    links.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${id}`));
  };
  if (sections[0]) activate(sections[0].id);
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible?.target?.id) activate(visible.target.id);
  }, { rootMargin: '-20% 0px -55% 0px', threshold: [0.2, 0.45, 0.7] });
  sections.forEach((section) => observer.observe(section));
}

function bindEvents() {
  document.getElementById('saveSettingsButton').addEventListener('click', saveSettings);
  document.getElementById('exportJsonButton').addEventListener('click', exportJson);
  document.getElementById('exportCsvButton').addEventListener('click', exportCsv);
  document.getElementById('importInput').addEventListener('change', importJson);
  document.getElementById('resetButton').addEventListener('click', resetStats);
  document.getElementById('resetEverythingButton').addEventListener('click', resetEverything);
  bindFilters();
  bindQuickNavSpy();
}

async function init() {
  setRangeButtons();
  state = await getState();
  renderAll(state);
  requestAnimationFrame(() => document.body.classList.add('is-ready'));
}

bindEvents();
init().catch((error) => {
  console.error('Options page failed to initialize', error);
});
