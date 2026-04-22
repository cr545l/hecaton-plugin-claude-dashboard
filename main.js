#!/usr/bin/env node

/**
 * Claude Dashboard - Hecaton Plugin
 *
 * Displays Claude API usage, rate limits, and session info
 * as a TUI overlay inside the Hecaton terminal.
 *
 * Keyboard:
 *   r / R   - Refresh data
 *   h / H   - Toggle heatmap view
 *   q / ESC - Close (handled by host)
 */

// ============================================================
// Hecaton Host API helpers & path utilities
// ============================================================

function joinPath(...parts) {
  return parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/');
}

// Read plugin.json inline (synchronous hecaton call)
const _pluginJsonResult = await hecaton.fs.read_file({ path: joinPath(__dirname, 'plugin.json') });
const PLUGIN_VERSION = _pluginJsonResult.ok ? JSON.parse(_pluginJsonResult.content).version : '0.0.0';

// ============================================================
// ANSI Helpers
// ============================================================
const ESC = '\x1b';
const CSI = ESC + '[';

const ansi = {
  clear: CSI + '2J' + CSI + 'H',
  hideCursor: CSI + '?25l',
  showCursor: CSI + '?25h',
  reset: CSI + '0m',
  bold: CSI + '1m',
  dim: CSI + '2m',
  fg: (r, g, b) => `${CSI}38;2;${r};${g};${b}m`,
  bg: (r, g, b) => `${CSI}48;2;${r};${g};${b}m`,
  fg256: (n) => `${CSI}38;5;${n}m`,
  moveTo: (row, col) => `${CSI}${row};${col}H`,
};

// Color palette (ANSI palette for theme compatibility)
const colors = {
  bg: CSI + '49m',            // default background
  title: CSI + '91m',         // bright red (coral)
  label: CSI + '39m',         // default foreground
  value: CSI + '39m',         // default foreground
  dim: CSI + '2m',            // SGR dim
  green: CSI + '32m',         // green
  yellow: CSI + '33m',        // yellow
  red: CSI + '31m',           // red
  cyan: CSI + '36m',          // cyan
  orange: CSI + '33m',        // yellow
  border: CSI + '2m',         // SGR dim
  separator: CSI + '2m',      // SGR dim
  // Extra usage 4-tier color ramp
  extraCool: CSI + '36m',     // cyan (< 50%)
  extraWarm: CSI + '33m',     // yellow (50-75%)
  extraHot: CSI + '31m',      // red (75-90%)
  extraCritical: CSI + '91m', // bright red (>= 90%)
};

// Heatmap color palette (orange gradient)
const heatmapColors = {
  empty: ansi.fg(68, 68, 68),
  level1: ansi.fg(196, 160, 0),
  level2: ansi.fg(218, 140, 0),
  level3: ansi.fg(240, 100, 0),
  level4: ansi.fg(255, 60, 0),
  future: ansi.fg(38, 38, 38),
};

function colorForPercent(pct) {
  if (pct <= 50) return colors.green;
  if (pct <= 80) return colors.yellow;
  return colors.red;
}

function colorForExtraUsage(utilization) {
  if (utilization < 0.50) return colors.extraCool;
  if (utilization < 0.75) return colors.extraWarm;
  if (utilization < 0.90) return colors.extraHot;
  return colors.extraCritical;
}

function formatCents(cents) {
  const absCents = Math.abs(Math.round(cents));
  const dollars = Math.floor(absCents / 100);
  const remainder = absCents % 100;
  const prefix = cents < 0 ? '-' : '';
  return `${prefix}$${dollars}.${String(remainder).padStart(2, '0')}`;
}

function extraUsageProgressBar(utilization, width = 20) {
  const pct = Math.min(utilization, 1.0);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const color = colorForExtraUsage(utilization);
  return color + '\u2588'.repeat(filled) + colors.dim + '\u2591'.repeat(empty) + ansi.reset;
}

// ============================================================
// Heatmap Data Layer
// ============================================================

function toLocalDateStr(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadStatsCache() {
  try {
    const home = (await hecaton.env.get_home()).path;
    const cachePath = joinPath(home, '.claude', 'stats-cache.json');
    const result = await hecaton.fs.read_file({ path: cachePath });
    if (!result.ok) return null;
    return JSON.parse(result.content);
  } catch {
    return null;
  }
}

async function scanRecentActivity(afterDate) {
  const activity = new Map();
  const home = (await hecaton.env.get_home()).path;
  const projectsDir = joinPath(home, '.claude', 'projects');
  const statResult = await hecaton.fs.stat({ path: projectsDir });
  if (!statResult.ok || !statResult.exists) return activity;
  const cutoff = afterDate ? new Date(afterDate).getTime() : 0;

  async function scanDir(dir) {
    try {
      const dirResult = await hecaton.fs.read_dir({ path: dir });
      if (!dirResult.ok) return;
      for (const entry of dirResult.entries) {
        const fullPath = joinPath(dir, entry.name);
        if (entry.is_dir) {
          await scanDir(fullPath);
        } else if (entry.name.endsWith('.jsonl')) {
          try {
            const st = await hecaton.fs.stat({ path: fullPath });
            if (st.ok && st.mtime_ms > cutoff) {
              const dateStr = toLocalDateStr(new Date(st.mtime_ms));
              activity.set(dateStr, (activity.get(dateStr) || 0) + 1);
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }

  await scanDir(projectsDir);
  return activity;
}

function buildDailyActivityMap(cache, recentScans) {
  const map = new Map();
  if (cache && cache.dailyActivity) {
    for (const entry of cache.dailyActivity) {
      map.set(entry.date, (map.get(entry.date) || 0) + entry.sessionCount);
    }
  }
  for (const [date, count] of recentScans) {
    if (!map.has(date)) map.set(date, count);
  }
  return map;
}

function calculateThresholds(activityMap) {
  const values = [...activityMap.values()].filter(v => v > 0).sort((a, b) => a - b);
  if (values.length === 0) return [1, 2, 3, 4];
  const p25 = values[Math.floor(values.length * 0.25)] || 1;
  const p50 = values[Math.floor(values.length * 0.50)] || 2;
  const p75 = values[Math.floor(values.length * 0.75)] || 3;
  const pMax = values[values.length - 1] || 4;
  return [Math.max(1, p25), Math.max(p25 + 1, p50), Math.max(p50 + 1, p75), Math.max(p75 + 1, pMax)];
}

function getActivityLevel(count, thresholds) {
  if (!count || count <= 0) return 0;
  if (count <= thresholds[0]) return 1;
  if (count <= thresholds[1]) return 2;
  if (count <= thresholds[2]) return 3;
  return 4;
}

function calculateStreaks(activityMap) {
  const today = toLocalDateStr(new Date());
  let currentStreak = 0;
  let longestStreak = 0;
  let tempStreak = 0;
  const dates = [...activityMap.keys()].sort();

  for (let i = 0; i < dates.length; i++) {
    if (i === 0) { tempStreak = 1; }
    else {
      const diffDays = Math.round((new Date(dates[i]) - new Date(dates[i - 1])) / 86400000);
      tempStreak = diffDays === 1 ? tempStreak + 1 : 1;
    }
    longestStreak = Math.max(longestStreak, tempStreak);
  }

  const d = new Date();
  if (activityMap.has(today)) {
    currentStreak = 1;
    const check = new Date(d);
    while (true) {
      check.setDate(check.getDate() - 1);
      if (activityMap.has(toLocalDateStr(check))) currentStreak++;
      else break;
    }
  } else {
    const yesterday = new Date(d);
    yesterday.setDate(yesterday.getDate() - 1);
    if (activityMap.has(toLocalDateStr(yesterday))) {
      currentStreak = 1;
      const check = new Date(yesterday);
      while (true) {
        check.setDate(check.getDate() - 1);
        if (activityMap.has(toLocalDateStr(check))) currentStreak++;
        else break;
      }
    }
  }

  return { currentStreak, longestStreak };
}

function buildCalendarGrid(activityMap, thresholds) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = toLocalDateStr(today);
  const todayDow = today.getDay(); // 0=Sun
  const todayRow = (todayDow + 6) % 7; // 0=Mon, 6=Sun

  const numWeeks = 52;
  const currentMonday = new Date(today);
  currentMonday.setDate(currentMonday.getDate() - todayRow);
  const firstMonday = new Date(currentMonday);
  firstMonday.setDate(firstMonday.getDate() - (numWeeks - 1) * 7);

  const grid = Array.from({ length: 7 }, () => []);
  const monthLabels = [];
  let lastMonth = -1;

  for (let week = 0; week < numWeeks; week++) {
    for (let row = 0; row < 7; row++) {
      const d = new Date(firstMonday);
      d.setDate(d.getDate() + week * 7 + row);
      const dateStr = toLocalDateStr(d);
      const isFuture = d > today;
      const count = activityMap.get(dateStr) || 0;
      const level = isFuture ? -1 : getActivityLevel(count, thresholds);
      grid[row][week] = { date: dateStr, level, count, isFuture, isToday: dateStr === todayStr };
      if (row === 0) {
        const month = d.getMonth();
        if (month !== lastMonth) {
          monthLabels.push({ col: week, label: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][month] });
          lastMonth = month;
        }
      }
    }
  }

  return { grid, monthLabels, numWeeks };
}

async function loadHeatmapData() {
  const cache = await loadStatsCache();
  const afterDate = cache?.lastComputedDate || null;
  const recentScans = await scanRecentActivity(afterDate);
  const activityMap = buildDailyActivityMap(cache, recentScans);
  const thresholds = calculateThresholds(activityMap);
  const streaks = calculateStreaks(activityMap);
  const { grid, monthLabels, numWeeks } = buildCalendarGrid(activityMap, thresholds);
  const totalDays = [...activityMap.keys()].length;
  const totalSessions = [...activityMap.values()].reduce((a, b) => a + b, 0);
  return { grid, monthLabels, numWeeks, thresholds, streaks, totalDays, totalSessions };
}

// ============================================================
// Credentials & API
// ============================================================
let credentialsCache = null;

async function getCredentials() {
  try {
    const platform = await hecaton.sys.get_platform();
    if (platform.os === 'macos') {
      return await getCredentialsFromKeychain();
    }
    return await getCredentialsFromFile();
  } catch {
    return null;
  }
}

async function getCredentialsFromKeychain() {
  try {
    const result = await hecaton.process.exec({
      program: 'security',
      args: ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      timeout_ms: 5000,
    });
    if (!result.ok) return await getCredentialsFromFile();
    const creds = JSON.parse(result.stdout.trim());
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return await getCredentialsFromFile();
  }
}

async function getCredentialsFromFile() {
  try {
    const homeResult = await hecaton.env.get_home();
    const home = homeResult ? homeResult.path : null;
    if (!home) {
      process.stderr.write('[claude-dashboard] env.get_home failed: ' + JSON.stringify(homeResult) + '\n');
      return null;
    }
    const credPath = joinPath(home, '.claude', '.credentials.json');
    process.stderr.write('[claude-dashboard] Reading credentials from: ' + credPath + '\n');
    const result = await hecaton.fs.read_file({ path: credPath });
    process.stderr.write('[claude-dashboard] fs.read_file result: ok=' + result.ok + ' error=' + (result.error || 'none') + '\n');
    if (!result.ok) return null;
    const creds = JSON.parse(result.content);
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch (e) {
    process.stderr.write('[claude-dashboard] getCredentialsFromFile error: ' + (e.message || e) + '\n');
    return null;
  }
}

let autoRefreshMs = 300000; // 5 minutes default

const PLUGIN_DIR_NAME = (function() {
  // Extract directory name from __dirname
  const parts = __dirname.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || 'hecaton-plugin-claude-dashboard';
})();
const CACHE_DIR = joinPath((await hecaton.env.get_home()).path, '.hecaton', 'data', PLUGIN_DIR_NAME);
const CACHE_FILE = joinPath(CACHE_DIR, 'cache.json');

async function loadCache() {
  try {
    const result = await hecaton.fs.read_file({ path: CACHE_FILE });
    if (!result.ok) return null;
    return JSON.parse(result.content);
  } catch {
    return null;
  }
}

async function saveCache(data) {
  try {
    await hecaton.fs.mkdir({ path: CACHE_DIR, recursive: true });
    await hecaton.fs.write_file({ path: CACHE_FILE, content: JSON.stringify({ ...data, _cachedAt: Date.now() }) });
  } catch { /* ignore write errors */ }
}

async function fetchUsageLimits(token) {
  try {
    const resp = await hecaton.http.get({
      url: 'https://api.anthropic.com/api/oauth/usage',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'hecaton-claude-dashboard/1.0',
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      timeout_sec: 5,
    });

    if (!resp.ok) {
      return { _error: 'Network error: ' + (resp.error || 'Request failed') };
    }

    if (resp.status === 429) {
      autoRefreshMs = Math.min(autoRefreshMs * 2, 1800000);
      return { _error: 'API rate limited (429). Retrying in ' + Math.round(autoRefreshMs / 60000) + 'min...' };
    }
    if (resp.status === 401) {
      return { _error: 'Token expired or invalid (401). Re-login to Claude Code.' };
    }
    if (resp.status !== 200) {
      return { _error: `API error (HTTP ${resp.status})` };
    }

    // Successful response: reset interval to default
    autoRefreshMs = 300000;
    const data = JSON.parse(resp.body);
    return {
      five_hour: data.five_hour ?? null,
      seven_day: data.seven_day ?? null,
      seven_day_sonnet: data.seven_day_sonnet ?? null,
      extra_usage: data.extra_usage ?? null,
    };
  } catch (e) {
    return { _error: 'Network error: ' + (e.message || 'unknown') };
  }
}

// ============================================================
// Config & Settings
// ============================================================

async function loadConfig() {
  try {
    const home = (await hecaton.env.get_home()).path;
    const configPath = joinPath(home, '.claude', 'claude-dashboard.local.json');
    const result = await hecaton.fs.read_file({ path: configPath });
    if (!result.ok) return { plan: 'max', displayMode: 'detailed', language: 'auto' };
    return { plan: 'max', displayMode: 'detailed', ...JSON.parse(result.content) };
  } catch {
    return { plan: 'max', displayMode: 'detailed', language: 'auto' };
  }
}

async function getEffortLevel() {
  try {
    const home = (await hecaton.env.get_home()).path;
    const settingsPath = joinPath(home, '.claude', 'settings.json');
    const result = await hecaton.fs.read_file({ path: settingsPath });
    if (!result.ok) return 'high';
    const settings = JSON.parse(result.content);
    return settings?.effortLevel ?? 'high';
  } catch {
    return 'high';
  }
}

// ============================================================
// Progress Bar
// ============================================================

function progressBar(percent, width = 20) {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const color = colorForPercent(percent);
  const bar = color + '\u2588'.repeat(filled) + colors.dim + '\u2591'.repeat(empty) + ansi.reset;
  return bar;
}

function formatPercent(pct) {
  const color = colorForPercent(pct);
  return color + pct.toFixed(0) + '%' + ansi.reset;
}

function formatTokens(tokens) {
  if (tokens >= 1e6) return (tokens / 1e6).toFixed(1) + 'M';
  if (tokens >= 1e3) return (tokens / 1e3).toFixed(0) + 'K';
  return tokens.toString();
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d${hours > 0 ? hours + 'h' : ''}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? minutes + 'm' : ''}`;
  return `${minutes}m`;
}

function formatResetTime(resetAt) {
  if (!resetAt) return '';
  try {
    const resetMs = new Date(resetAt).getTime();
    const remainMs = resetMs - Date.now();
    if (remainMs <= 0) return 'now';
    return formatDuration(remainMs);
  } catch {
    return '';
  }
}

// ============================================================
// Rendering
// ============================================================

// Dynamic terminal size (updated by host resize notifications)
let termCols = parseInt((await hecaton.env.get({ name: 'HECA_COLS' })).value || '80', 10);
let termRows = parseInt((await hecaton.env.get({ name: 'HECA_ROWS' })).value || '24', 10);
let clickableAreas = [];
let hoveredAreaIndex = -1;
let currentButtons = [];

function buildHintText(buttons) {
  let result = '';
  for (let i = 0; i < buttons.length; i++) {
    if (i > 0) result += '  ';
    const color = (i === hoveredAreaIndex) ? colors.value + ansi.bold : colors.dim;
    result += color + buttons[i].label + ansi.reset;
  }
  return result;
}

function getTermSize() {
  return { cols: termCols, rows: termRows };
}

function centerText(text, width) {
  // Strip ANSI for length calculation
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, Math.floor((width - plain.length) / 2));
  return ' '.repeat(pad) + text;
}

function padRight(text, width) {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, width - plain.length);
  return text + ' '.repeat(pad);
}

function truncate(text, maxLen) {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  if (plain.length <= maxLen) return text;
  // Simple truncation (works for non-ANSI parts)
  return text.substring(0, maxLen - 3) + '...';
}

function drawBox(lines, width) {
  const topBorder = colors.border + '\u250c' + '\u2500'.repeat(width - 2) + '\u2510' + ansi.reset;
  const botBorder = colors.border + '\u2514' + '\u2500'.repeat(width - 2) + '\u2518' + ansi.reset;
  const result = [topBorder];
  for (const line of lines) {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    const pad = Math.max(0, width - 2 - plain.length);
    result.push(colors.border + '\u2502' + ansi.reset + ' ' + line + ' '.repeat(pad > 0 ? pad - 1 : 0) + colors.border + '\u2502' + ansi.reset);
  }
  result.push(botBorder);
  return result;
}

function drawSeparator(width) {
  return colors.separator + '\u2500'.repeat(width - 2) + ansi.reset;
}

function renderMinimized(state) {
  const { cols } = getTermSize();
  const data = state.data;
  let line = '';

  if (data) {
    if (data.five_hour) {
      const pct = Math.round(data.five_hour.utilization);
      const reset = formatResetTime(data.five_hour.resets_at);
      line += colors.label + (reset || '5h') + ': ' + ansi.reset;
      line += formatPercent(pct) + ' ' + progressBar(pct, 10);
    }
    if (data.seven_day) {
      const pct = Math.round(data.seven_day.utilization);
      const reset = formatResetTime(data.seven_day.resets_at);
      line += colors.dim + ' | ' + ansi.reset;
      line += colors.label + (reset || '7d') + ': ' + ansi.reset;
      line += formatPercent(pct) + ' ' + progressBar(pct, 10);
    }

    // Extra usage in minimized mode
    if (data.extra_usage && data.extra_usage.is_enabled) {
      const eu = data.extra_usage;
      const usedCents = eu.used_credits != null ? Math.round(eu.used_credits) : 0;
      const limitCents = eu.monthly_limit != null ? Math.round(eu.monthly_limit) : null;
      const utilization = eu.utilization != null ? eu.utilization / 100 : 0;
      const pctDisplay = Math.round(utilization * 100);
      const usageColor = colorForExtraUsage(utilization);
      line += colors.dim + ' | ' + ansi.reset;
      const label = limitCents != null && limitCents > 0
        ? formatCents(limitCents - usedCents)
        : formatCents(usedCents);
      line += colors.label + label + ': ' + ansi.reset;
      line += usageColor + pctDisplay + '%' + ansi.reset + ' ';
      line += extraUsageProgressBar(utilization, 10);
    }
  }

  if (state.lastRefresh) {
    const ago = Math.floor((Date.now() - state.lastRefresh) / 1000);
    const cacheTag = (state.data && state.data._fromCache) ? ' (cached)' : '';
    line += colors.dim + ' | ' + ansi.reset;
    line += colors.dim + '\u21bb ' + ago + 's' + cacheTag + ansi.reset;
  }

  // Pad/truncate to terminal width
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, cols - plain.length);
  line += ' '.repeat(pad);

  process.stdout.write(ansi.clear + ansi.hideCursor);
  process.stdout.write(ansi.moveTo(1, 1) + line + ansi.reset);
}

function render(state) {
  const { cols, rows } = getTermSize();
  const width = Math.min(cols, 72);
  const lines = [];
  let buttonLineIdx = -1;
  currentButtons = [];

  // Title
  lines.push('');
  lines.push(centerText(
    colors.title + ansi.bold + ' Claude Dashboard ' + ansi.reset +
    colors.dim + 'v' + PLUGIN_VERSION + ansi.reset,
    width
  ));
  lines.push('');

  if (state.error) {
    lines.push(centerText(colors.red + state.error + ansi.reset, width));
    lines.push('');
    currentButtons = [{ label: '[r] Refresh', action: 'refresh' }, { label: '[h] Heatmap', action: 'heatmap_toggle' }];
    buttonLineIdx = lines.length;
    lines.push(centerText(buildHintText(currentButtons), width));
  } else if (state.loading) {
    lines.push(centerText(colors.dim + 'Loading...' + ansi.reset, width));
  } else {
    const data = state.data;

    // -- Plan & Effort --
    const effortMap = { high: 'H', medium: 'M', low: 'L' };
    const effortLabel = effortMap[state.effort] || 'H';
    const planLabel = state.config.plan === 'max' ? 'Max' : 'Pro';
    lines.push(
      '  ' + colors.label + 'Plan: ' + ansi.reset +
      colors.value + ansi.bold + planLabel + ansi.reset +
      (state.effort !== 'high' ? colors.dim + '  Effort: ' + ansi.reset + colors.value + effortLabel + ansi.reset : '')
    );
    lines.push('');

    // -- Rate Limits --
    lines.push('  ' + colors.title + ansi.bold + 'Rate Limits' + ansi.reset);
    lines.push('  ' + drawSeparator(width - 3));

    if (data && !data._error) {
      // 5-hour
      if (data.five_hour) {
        const pct = Math.round(data.five_hour.utilization);
        const reset = formatResetTime(data.five_hour.resets_at);
        lines.push(
          '  ' + colors.label + '5h   ' + ansi.reset +
          progressBar(pct, 25) + '  ' + formatPercent(pct) +
          (reset ? colors.dim + '  (' + reset + ')' + ansi.reset : '')
        );
      }

      // 7-day
      if (data.seven_day) {
        const pct = Math.round(data.seven_day.utilization);
        const reset = formatResetTime(data.seven_day.resets_at);
        lines.push(
          '  ' + colors.label + '7d   ' + ansi.reset +
          progressBar(pct, 25) + '  ' + formatPercent(pct) +
          (reset ? colors.dim + '  (' + reset + ')' + ansi.reset : '')
        );
      }

      // 7-day Sonnet
      if (data.seven_day_sonnet) {
        const pct = Math.round(data.seven_day_sonnet.utilization);
        const reset = formatResetTime(data.seven_day_sonnet.resets_at);
        lines.push(
          '  ' + colors.label + '7d-S ' + ansi.reset +
          progressBar(pct, 25) + '  ' + formatPercent(pct) +
          (reset ? colors.dim + '  (' + reset + ')' + ansi.reset : '')
        );
      }

      if (!data.five_hour && !data.seven_day && !data.seven_day_sonnet) {
        lines.push('  ' + colors.dim + 'No rate limit data available' + ansi.reset);
      }

      // -- Extra Usage --
      if (data.extra_usage && data.extra_usage.is_enabled) {
        lines.push('');
        lines.push('  ' + colors.title + ansi.bold + 'Extra Usage' + ansi.reset);
        lines.push('  ' + drawSeparator(width - 3));

        const eu = data.extra_usage;
        const usedCents = eu.used_credits != null ? Math.round(eu.used_credits) : 0;
        const limitCents = eu.monthly_limit != null ? Math.round(eu.monthly_limit) : null;
        // API returns utilization as percentage (e.g. 2.82 = 2.82%), convert to 0-1 fraction
        const utilization = eu.utilization != null ? eu.utilization / 100 : 0;

        if (usedCents > 0 || (limitCents != null && limitCents > 0)) {
          const usageColor = colorForExtraUsage(utilization);
          const pctDisplay = Math.round(utilization * 100);

          // Currency + progress bar on one line: $1.41 / $50.00  ██░░░░░░░░░░░░  3%
          let currencyText;
          if (limitCents != null && limitCents > 0) {
            currencyText = formatCents(usedCents) + ' / ' + formatCents(limitCents);
          } else {
            currencyText = formatCents(usedCents) + ' spent';
          }
          lines.push(
            '  ' + usageColor + ansi.bold + currencyText + ansi.reset +
            '  ' + extraUsageProgressBar(utilization, 15) + '  ' +
            usageColor + pctDisplay + '%' + ansi.reset
          );

          // Remaining balance
          if (limitCents != null && limitCents > 0) {
            const remainingCents = limitCents - usedCents;
            lines.push(
              '  ' + colors.label + 'Remaining: ' + ansi.reset +
              colors.value + formatCents(remainingCents) + ansi.reset
            );
          }
        } else {
          lines.push('  ' + colors.dim + 'Extra usage enabled, no spend this period' + ansi.reset);
        }
      }
    } else if (data && data._error) {
      lines.push('  ' + colors.yellow + data._error + ansi.reset);
    } else {
      lines.push('  ' + colors.yellow + 'Failed to fetch rate limits' + ansi.reset);
      lines.push('  ' + colors.dim + 'Check ~/.claude/.credentials.json' + ansi.reset);
    }

    lines.push('');

    // -- Session Info --
    lines.push('  ' + colors.title + ansi.bold + 'Session' + ansi.reset);
    lines.push('  ' + drawSeparator(width - 3));

    const elapsed = Date.now() - state.startTime;
    let sessionLine = '  ' + colors.label + 'Uptime: ' + ansi.reset +
      colors.value + formatDuration(elapsed) + ansi.reset;
    if (state.lastRefresh) {
      const ago = Math.floor((Date.now() - state.lastRefresh) / 1000);
      const cacheTag = (state.data && state.data._fromCache) ? ' (cached)' : '';
      sessionLine += colors.dim + '  |  ' + ansi.reset +
        colors.label + 'Updated: ' + ansi.reset +
        colors.dim + ago + 's ago' + cacheTag + ansi.reset;
    }
    lines.push(sessionLine);

    lines.push('');

    // -- Keyboard --
    lines.push('  ' + drawSeparator(width - 3));
    currentButtons = [
      { label: '[r] Refresh', action: 'refresh' },
      { label: '[h] Heatmap', action: 'heatmap_toggle' },
    ];
    buttonLineIdx = lines.length;
    lines.push('  ' + buildHintText(currentButtons));
  }

  lines.push('');

  // Draw
  const boxed = drawBox(lines, width);
  process.stdout.write(ansi.clear + ansi.hideCursor);
  // Center vertically
  const startRow = Math.max(1, Math.floor((rows - boxed.length) / 2));
  const startCol = Math.max(1, Math.floor((cols - width) / 2));
  for (let i = 0; i < boxed.length; i++) {
    process.stdout.write(ansi.moveTo(startRow + i, startCol) + colors.bg + boxed[i] + ansi.reset);
  }

  // Record clickable areas for mouse support
  clickableAreas = [];
  if (buttonLineIdx >= 0 && currentButtons.length > 0) {
    const screenRow = startRow + buttonLineIdx + 1; // +1 for box top border
    const contentStart = startCol + 2; // after | and space in box
    const plainLine = lines[buttonLineIdx].replace(/\x1b\[[0-9;]*m/g, '');
    for (const btn of currentButtons) {
      const idx = plainLine.indexOf(btn.label);
      if (idx >= 0) {
        clickableAreas.push({
          row: screenRow,
          colStart: contentStart + idx,
          colEnd: contentStart + idx + btn.label.length - 1,
          action: btn.action,
        });
      }
    }
  }
  if (hoveredAreaIndex >= clickableAreas.length) hoveredAreaIndex = -1;
}

function renderHeatmap(state) {
  const { cols, rows } = getTermSize();
  const width = Math.min(cols, 72);
  const lines = [];
  let buttonLineIdx = -1;
  currentButtons = [];

  lines.push('');
  lines.push(centerText(
    colors.title + ansi.bold + ' Activity Heatmap ' + ansi.reset +
    colors.dim + '(52 weeks)' + ansi.reset,
    width
  ));
  lines.push('');

  if (state.heatmapLoading) {
    lines.push(centerText(colors.dim + 'Loading heatmap data...' + ansi.reset, width));
  } else if (!state.heatmapData) {
    lines.push(centerText(colors.dim + 'No activity data available' + ansi.reset, width));
  } else {
    const hd = state.heatmapData;
    const labelWidth = 4;
    const dayLabels = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];

    // Month labels
    const monthChars = new Array(hd.numWeeks).fill(' ');
    let lastEnd = -1;
    for (const { col, label } of hd.monthLabels) {
      if (col > lastEnd) {
        for (let i = 0; i < label.length && col + i < hd.numWeeks; i++) {
          monthChars[col + i] = label[i];
        }
        lastEnd = col + label.length;
      }
    }
    lines.push('  ' + ' '.repeat(labelWidth) + colors.dim + monthChars.join('') + ansi.reset);

    // Grid rows (Mon=0 to Sun=6)
    for (let dow = 0; dow < 7; dow++) {
      let line = '  ' + colors.dim + (dayLabels[dow] || ' ').padEnd(labelWidth) + ansi.reset;
      for (let week = 0; week < hd.numWeeks; week++) {
        const cell = hd.grid[dow] && hd.grid[dow][week];
        if (!cell) { line += ' '; continue; }
        let color;
        if (cell.isFuture) color = heatmapColors.future;
        else switch (cell.level) {
          case 1: color = heatmapColors.level1; break;
          case 2: color = heatmapColors.level2; break;
          case 3: color = heatmapColors.level3; break;
          case 4: color = heatmapColors.level4; break;
          default: color = heatmapColors.empty;
        }
        line += color + '\u2588' + ansi.reset;
      }
      lines.push(line);
    }

    lines.push('');

    // Legend
    let legend = '  ' + colors.dim + 'Less ' + ansi.reset;
    legend += heatmapColors.empty + '\u2588' + ansi.reset + ' ';
    legend += heatmapColors.level1 + '\u2588' + ansi.reset + ' ';
    legend += heatmapColors.level2 + '\u2588' + ansi.reset + ' ';
    legend += heatmapColors.level3 + '\u2588' + ansi.reset + ' ';
    legend += heatmapColors.level4 + '\u2588' + ansi.reset;
    legend += colors.dim + ' More' + ansi.reset;
    lines.push(legend);

    lines.push('');

    // Statistics
    lines.push('  ' + colors.title + ansi.bold + 'Statistics' + ansi.reset);
    lines.push('  ' + drawSeparator(width - 3));
    lines.push(
      '  ' + colors.label + 'Active days: ' + ansi.reset +
      colors.value + ansi.bold + hd.totalDays + ansi.reset +
      colors.dim + '  |  ' + ansi.reset +
      colors.label + 'Sessions: ' + ansi.reset +
      colors.value + ansi.bold + hd.totalSessions + ansi.reset
    );
    lines.push(
      '  ' + colors.label + 'Current streak: ' + ansi.reset +
      colors.value + ansi.bold + hd.streaks.currentStreak + ' days' + ansi.reset +
      colors.dim + '  |  ' + ansi.reset +
      colors.label + 'Longest: ' + ansi.reset +
      colors.value + ansi.bold + hd.streaks.longestStreak + ' days' + ansi.reset
    );
  }

  lines.push('');
  lines.push('  ' + drawSeparator(width - 3));
  currentButtons = [
    { label: '[r] Refresh', action: 'heatmap_refresh' },
    { label: '[h] Dashboard', action: 'heatmap_toggle' },
  ];
  buttonLineIdx = lines.length;
  lines.push('  ' + buildHintText(currentButtons));
  lines.push('');

  const boxed = drawBox(lines, width);
  process.stdout.write(ansi.clear + ansi.hideCursor);
  const startRow = Math.max(1, Math.floor((rows - boxed.length) / 2));
  const startCol = Math.max(1, Math.floor((cols - width) / 2));
  for (let i = 0; i < boxed.length; i++) {
    process.stdout.write(ansi.moveTo(startRow + i, startCol) + colors.bg + boxed[i] + ansi.reset);
  }

  clickableAreas = [];
  if (buttonLineIdx >= 0 && currentButtons.length > 0) {
    const screenRow = startRow + buttonLineIdx + 1;
    const contentStart = startCol + 2;
    const plainLine = lines[buttonLineIdx].replace(/\x1b\[[0-9;]*m/g, '');
    for (const btn of currentButtons) {
      const idx = plainLine.indexOf(btn.label);
      if (idx >= 0) {
        clickableAreas.push({
          row: screenRow,
          colStart: contentStart + idx,
          colEnd: contentStart + idx + btn.label.length - 1,
          action: btn.action,
        });
      }
    }
  }
  if (hoveredAreaIndex >= clickableAreas.length) hoveredAreaIndex = -1;
}

// ============================================================
// JSON-RPC via stderr
// ============================================================

function sendRpc(method, params = {}) {
  // Support dotted paths like "window.close" for v1.0 namespaced API.
  const parts = method.split('.');
  let target = hecaton;
  for (let i = 0; i < parts.length - 1; i++) {
    target = target?.[parts[i]];
    if (!target) return;
  }
  const fn = target?.[parts[parts.length - 1]];
  if (typeof fn === 'function') {
    fn.call(target, params).catch(() => {});
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  const state = {
    loading: true,
    error: null,
    data: null,
    config: { plan: 'max', displayMode: 'detailed' },
    effort: 'high',
    startTime: Date.now(),
    lastRefresh: null,
    refreshCount: 0,
    minimized: hecaton.initialState?.minimized ?? false,
    heatmapView: false,
    heatmapData: null,
    heatmapLoading: false,
  };

  // Initial render
  rerender();

  // Load config
  state.config = await loadConfig();
  state.effort = await getEffortLevel();

  // Fetch data
  function rerender() {
    if (state.minimized) renderMinimized(state);
    else if (state.heatmapView) renderHeatmap(state);
    else render(state);
  }

  async function refresh() {
    state.loading = true;
    state.error = null;
    rerender();

    try {
      const token = await getCredentials();
      if (!token) {
        state.error = 'No credentials found';
        state.loading = false;
        rerender();
        return;
      }
      const data = await fetchUsageLimits(token);
      if (data && !data._error) {
        state.data = data;
        state.lastRefresh = Date.now();
        state.refreshCount++;
        await saveCache(data);
      } else {
        // API error -- fall back to cached data
        const cached = await loadCache();
        if (cached) {
          state.data = cached;
          state.data._fromCache = true;
          state.lastRefresh = cached._cachedAt || null;
        } else {
          state.data = data; // show error message
        }
      }
      state.loading = false;
      rerender();
    } catch (e) {
      // Network error -- fall back to cached data
      const cached = await loadCache();
      if (cached) {
        state.data = cached;
        state.data._fromCache = true;
        state.lastRefresh = cached._cachedAt || null;
      } else {
        state.error = 'Failed to fetch: ' + (e.message || 'unknown error');
      }
      state.loading = false;
      rerender();
    }
  }

  async function refreshHeatmap() {
    state.heatmapLoading = true;
    rerender();
    try {
      state.heatmapData = await loadHeatmapData();
    } catch {
      state.heatmapData = null;
    }
    state.heatmapLoading = false;
    rerender();
  }

  // Setup stdin to keep the deno event loop alive.
  // Handle stdin for keyboard input
  // In Hecaton plugin mode, stdin is a pipe (not TTY), so rawMode is not needed.
  // The host forwards keystrokes as VT sequences directly.
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
  } catch { /* ignore if not a TTY */ }
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  hecaton.on('window_resized', (params) => {
    termCols = params.cols || termCols;
    termRows = params.rows || termRows;
    rerender();
  });
  hecaton.on('window_minimized', () => {
    state.minimized = true;
    renderMinimized(state);
  });
  hecaton.on('window_restored', () => {
    state.minimized = false;
    rerender();
  });

  process.stdin.on('data', (key) => {
    // Handle SGR mouse sequences: ESC [ < Cb ; Cx ; Cy M/m
    const mouseRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let mouseMatch;
    let hadMouse = false;
    while ((mouseMatch = mouseRegex.exec(key)) !== null) {
      hadMouse = true;
      const cb = parseInt(mouseMatch[1], 10);
      const cx = parseInt(mouseMatch[2], 10);
      const cy = parseInt(mouseMatch[3], 10);
      const isRelease = mouseMatch[4] === 'm';

      // Motion events (cb bit 5 set)
      if ((cb & 32) !== 0) {
        let newHover = -1;
        for (let i = 0; i < clickableAreas.length; i++) {
          const area = clickableAreas[i];
          if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
            newHover = i;
            break;
          }
        }
        if (newHover !== hoveredAreaIndex) {
          hoveredAreaIndex = newHover;
          rerender();
        }
        continue;
      }

      if (isRelease) continue;

      // Scroll wheel up -> refresh
      if (cb === 64) { refresh(); continue; }
      if (cb === 65) continue; // scroll down -> ignore

      // Left click -> check clickable areas
      if (cb === 0) {
        for (const area of clickableAreas) {
          if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
            switch (area.action) {
              case 'refresh': refresh(); break;
              case 'heatmap_toggle':
                if (!state.minimized) {
                  state.heatmapView = !state.heatmapView;
                  if (state.heatmapView && !state.heatmapData) refreshHeatmap();
                  else rerender();
                }
                break;
              case 'heatmap_refresh': refreshHeatmap(); break;
            }
            break;
          }
        }
      }
    }
    if (hadMouse) return;

    switch (key) {
      case 'r':
      case 'R':
        if (state.heatmapView) refreshHeatmap();
        else refresh();
        break;
      case 'h':
      case 'H':
        if (state.minimized) break;
        state.heatmapView = !state.heatmapView;
        if (state.heatmapView && !state.heatmapData) refreshHeatmap();
        else rerender();
        break;
      case 'q':
      case 'Q':
        cleanup();
        sendRpc('window.close');
        break;
    }
  });

  // Auto-refresh with dynamic interval (backs off on 429)
  let autoRefreshTimer = null;
  function scheduleAutoRefresh() {
    if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
    autoRefreshTimer = setTimeout(async () => {
      try { await refresh(); } catch { /* ignore */ }
      scheduleAutoRefresh();
    }, autoRefreshMs);
  }

  function cleanup() {
    clearTimeout(autoRefreshTimer);
    process.stdout.write(ansi.showCursor + ansi.reset + ansi.clear);
  }

  // Graceful shutdown
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.stdin.on('end', () => { cleanup(); process.exit(0); });

  // Start initial refresh and auto-refresh (AFTER stdin is registered)
  refresh();
  scheduleAutoRefresh();
}

main().catch((e) => {
  process.stderr.write('Error: ' + (e && e.message ? e.message : e) + '\n');
  process.exit(1);
});
