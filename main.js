#!/usr/bin/env node

/**
 * Claude Dashboard - Hecaton Plugin
 *
 * Displays Claude API usage, rate limits, and session info
 * as a TUI overlay inside the Hecaton terminal.
 *
 * Keyboard:
 *   r / R   - Refresh data
 *   q / ESC - Close (handled by host)
 *   1/2/3   - Switch display mode (compact/normal/detailed)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

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

// Color palette (Claude brand: coral/terracotta)
const colors = {
  bg: ansi.bg(30, 16, 12),
  title: ansi.fg(215, 105, 70),
  label: ansi.fg(180, 180, 200),
  value: ansi.fg(255, 255, 255),
  dim: ansi.fg(120, 100, 95),
  green: ansi.fg(120, 220, 150),
  yellow: ansi.fg(230, 200, 100),
  red: ansi.fg(230, 110, 110),
  cyan: ansi.fg(100, 200, 230),
  orange: ansi.fg(230, 170, 100),
  border: ansi.fg(100, 55, 45),
  separator: ansi.fg(75, 45, 38),
};

function colorForPercent(pct) {
  if (pct <= 50) return colors.green;
  if (pct <= 80) return colors.yellow;
  return colors.red;
}

// ============================================================
// Credentials & API
// ============================================================
let credentialsCache = null;

async function getCredentials() {
  try {
    if (process.platform === 'darwin') {
      return getCredentialsFromKeychain();
    }
    return await getCredentialsFromFile();
  } catch {
    return null;
  }
}

function getCredentialsFromKeychain() {
  try {
    const result = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    const creds = JSON.parse(result);
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return getCredentialsFromFile();
  }
}

async function getCredentialsFromFile() {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const content = await fs.promises.readFile(credPath, 'utf-8');
    const creds = JSON.parse(content);
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

async function fetchUsageLimits(token) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'hecaton-claude-dashboard/1.0',
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json();
    return {
      five_hour: data.five_hour ?? null,
      seven_day: data.seven_day ?? null,
      seven_day_sonnet: data.seven_day_sonnet ?? null,
    };
  } catch {
    return null;
  }
}

// ============================================================
// Config & Settings
// ============================================================

async function loadConfig() {
  try {
    const configPath = path.join(os.homedir(), '.claude', 'claude-dashboard.local.json');
    const content = await fs.promises.readFile(configPath, 'utf-8');
    return { plan: 'max', displayMode: 'detailed', ...JSON.parse(content) };
  } catch {
    return { plan: 'max', displayMode: 'detailed', language: 'auto' };
  }
}

async function getEffortLevel() {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const content = await fs.promises.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(content);
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
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
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
let termCols = parseInt(process.env.HECA_COLS || '80', 10);
let termRows = parseInt(process.env.HECA_ROWS || '24', 10);

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

function render(state) {
  const { cols, rows } = getTermSize();
  const width = Math.min(cols, 72);
  const lines = [];

  // Title
  lines.push('');
  lines.push(centerText(
    colors.title + ansi.bold + ' Claude Dashboard ' + ansi.reset +
    colors.dim + 'v1.0.1' + ansi.reset,
    width
  ));
  lines.push('');

  if (state.error) {
    lines.push(centerText(colors.red + state.error + ansi.reset, width));
    lines.push('');
    lines.push(centerText(colors.dim + '[r] Refresh  [ESC] Close' + ansi.reset, width));
  } else if (state.loading) {
    lines.push(centerText(colors.dim + 'Loading...' + ansi.reset, width));
  } else {
    const data = state.data;

    // ── Model & Effort ──
    const effortMap = { high: 'H', medium: 'M', low: 'L' };
    const effortLabel = effortMap[state.effort] || 'H';
    lines.push(
      '  ' + colors.label + 'Model: ' + ansi.reset +
      colors.value + ansi.bold + (state.effort !== 'high' ? `[${effortLabel}] ` : '') + 'Claude' + ansi.reset
    );
    lines.push('');

    // ── Rate Limits ──
    lines.push('  ' + colors.title + ansi.bold + 'Rate Limits' + ansi.reset);
    lines.push('  ' + drawSeparator(width - 3));

    if (data) {
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
    } else {
      lines.push('  ' + colors.yellow + 'Failed to fetch rate limits' + ansi.reset);
      lines.push('  ' + colors.dim + 'Check ~/.claude/.credentials.json' + ansi.reset);
    }

    lines.push('');

    // ── Session Info ──
    lines.push('  ' + colors.title + ansi.bold + 'Session' + ansi.reset);
    lines.push('  ' + drawSeparator(width - 3));

    const elapsed = Date.now() - state.startTime;
    lines.push(
      '  ' + colors.label + 'Uptime: ' + ansi.reset +
      colors.value + formatDuration(elapsed) + ansi.reset +
      colors.dim + '  |  ' + ansi.reset +
      colors.label + 'Refreshes: ' + ansi.reset +
      colors.value + state.refreshCount + ansi.reset
    );

    if (state.lastRefresh) {
      const ago = Math.floor((Date.now() - state.lastRefresh) / 1000);
      lines.push(
        '  ' + colors.label + 'Last update: ' + ansi.reset +
        colors.dim + ago + 's ago' + ansi.reset
      );
    }

    lines.push('');

    // ── Plan Info ──
    lines.push('  ' + colors.title + ansi.bold + 'Account' + ansi.reset);
    lines.push('  ' + drawSeparator(width - 3));
    lines.push(
      '  ' + colors.label + 'Plan: ' + ansi.reset +
      colors.value + (state.config.plan === 'max' ? 'Max' : 'Pro') + ansi.reset
    );

    lines.push('');

    // ── Keyboard ──
    lines.push('  ' + drawSeparator(width - 3));
    lines.push(
      '  ' + colors.dim +
      '[r] Refresh  [ESC] Close  [1] Compact  [2] Normal  [3] Detailed' +
      ansi.reset
    );
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
}

// ============================================================
// JSON-RPC via stderr
// ============================================================

function sendRpc(method, params = {}, id = 1) {
  const rpc = JSON.stringify({ jsonrpc: '2.0', method, params, id });
  process.stderr.write('__HECA_RPC__' + rpc + '\n');
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
  };

  // Initial render
  render(state);

  // Load config
  state.config = await loadConfig();
  state.effort = await getEffortLevel();

  // Fetch data
  async function refresh() {
    state.loading = true;
    state.error = null;
    render(state);

    try {
      const token = await getCredentials();
      if (!token) {
        state.error = 'No credentials found';
        state.loading = false;
        render(state);
        return;
      }
      const data = await fetchUsageLimits(token);
      state.data = data;
      state.loading = false;
      state.lastRefresh = Date.now();
      state.refreshCount++;
      render(state);
    } catch (e) {
      state.error = 'Failed to fetch: ' + (e.message || 'unknown error');
      state.loading = false;
      render(state);
    }
  }

  await refresh();

  // Auto-refresh every 60 seconds
  const autoRefreshInterval = setInterval(() => {
    refresh().catch(() => {});
  }, 60000);

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

  process.stdin.on('data', async (key) => {
    // Check for RPC message from host
    if (key.startsWith('__HECA_RPC__')) {
      try {
        const json = JSON.parse(key.slice(12).trim());
        if (json.method === 'resize' && json.params) {
          termCols = json.params.cols || termCols;
          termRows = json.params.rows || termRows;
          render(state);
        }
      } catch { /* ignore parse errors */ }
      return;
    }

    switch (key) {
      case 'r':
      case 'R':
        await refresh();
        break;
      case 'q':
      case 'Q':
        cleanup();
        sendRpc('close');
        break;
      case '1':
        state.config.displayMode = 'compact';
        render(state);
        break;
      case '2':
        state.config.displayMode = 'normal';
        render(state);
        break;
      case '3':
        state.config.displayMode = 'detailed';
        render(state);
        break;
    }
  });

  function cleanup() {
    clearInterval(autoRefreshInterval);
    process.stdout.write(ansi.showCursor + ansi.reset + ansi.clear);
  }

  // Graceful shutdown
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.stdin.on('end', () => { cleanup(); process.exit(0); });
}

main().catch((e) => {
  process.stderr.write('Error: ' + e.message + '\n');
  process.exit(1);
});
