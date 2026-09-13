const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '..');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

async function harness({ legacy, serve, locale, envLocale, cols = 100, authenticated = false, usageStatus = 200 } = {}) {
  const events = new EventEmitter();
  const stdin = new EventEmitter();
  Object.assign(stdin, { resume() {}, setEncoding() {}, isTTY: false });
  const calls = [], output = [], files = new Map(), timers = new Map();
  let timer = 0;
  if (authenticated) files.set('/home/.claude/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: 'mock-token' } }));
  if (legacy) files.set('/home/.hecaton/data/dev.hecaton.claude-hook/config.json', JSON.stringify(legacy));
  files.set('/home/.claude/settings.json', JSON.stringify({ existing: true, hooks: {} }));
  const host = new Proxy({
    initialState: { cols, rows: 40, minimized: false, locale },
    on: (name, fn) => events.on(name, fn),
  }, {
    get(target, ns) {
      if (ns in target) return target[ns];
      return new Proxy({}, { get: (_, verb) => async args => {
        calls.push({ method: `${ns}.${verb}`, args });
        if (ns === 'env') {
          if (verb === 'get_home') return { path: '/home' };
          return { value: { HECA_COLS: String(cols), HECA_ROWS: '40', HECA_LOCALE: envLocale, HECA_PLUGIN_DATA_DIR: '/home/.hecaton/data/dev.hecaton.claude-dashboard' }[args.name] || '' };
        }
        if (ns === 'fs' && verb === 'read_file') {
          if (args.path.endsWith('/plugin.json')) return { ok: true, content: fs.readFileSync(path.join(root, 'plugin.json'), 'utf8') };
          return files.has(args.path) ? { ok: true, content: files.get(args.path) } : { ok: false };
        }
        if (ns === 'fs' && verb === 'write_file') { files.set(args.path, args.content); return { ok: true }; }
        if (ns === 'permissions') return { state: 'granted' };
        if (ns === 'web' && verb === 'serve') return serve ? serve() : { ok: true, server_id: 7, port: 9218 };
        if (ns === 'terminal' && verb === 'list') return { terminals: [{ id: 42, title: 'test project' }] };
        if (ns === 'terminal' && verb === 'subscribe') return { subscription_id: 9 };
        if (ns === 'http') {
          if (authenticated && args.url.includes('/oauth/usage')) return { ok: true, status: usageStatus,
            body: JSON.stringify({ five_hour: { utilization: 25, resets_at: '2099-01-01T00:00:00Z' },
              seven_day: { utilization: 10 }, extra_usage: { is_enabled: true, used_credits: 100, monthly_limit: 1000, utilization: 10 } }) };
          return { ok: false, error: 'offline test' };
        }
        return { ok: true };
      } });
    },
  });
  const proc = new EventEmitter();
  Object.assign(proc, { stdin, stdout: { write: s => output.push(s) }, stderr: { write() {} }, exit: code => calls.push({ method: 'exit', code }) });
  const context = vm.createContext({ hecaton: host, process: proc, __dirname: root, console, atob,
    setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: id => timers.delete(id),
  });
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8').replace(/^#![^\n]*\n/, '');
  const textHelpers = await new vm.Script(`(async () => {${source}\nreturn { displayWidth, clipCells };})()`).runInContext(context);
  await flush();
  const emit = async (name, data) => { events.emit(name, data); await flush(); };
  const input = async key => { stdin.emit('data', key); await flush(); };
  const hook = async event => emit('http_request_received', { method: 'POST', path: '/hook', body: JSON.stringify({ client: 'claude', terminal_id: 42, event }) });
  return { calls, output, files, emit, input, hook, stdin, timers, textHelpers, frame: () => output.join('').split('\x1b[2J').at(-1) };
}

test('background hooks update badges and notify without overwriting dashboard', async () => {
  const h = await harness();
  assert.equal(h.calls.filter(c => c.method === 'web.serve').length, 1);
  h.output.length = 0;
  await h.hook('UserPromptSubmit');
  await h.hook('Stop');
  assert.deepEqual(h.calls.filter(c => c.method === 'terminal.set_status').map(c => c.args.detail), ['running', 'waiting']);
  assert.equal(h.calls.filter(c => c.method === 'notify.send').length, 1);
  assert.equal(h.output.length, 0);
});

test('Agent State navigation, background refresh, minimize and restore share one renderer', async () => {
  const h = await harness();
  await h.input('a');
  assert.match(h.frame(), /Claude State/);
  await h.hook('UserPromptSubmit');
  assert.match(h.frame(), /Claude State/);
  await h.emit('window_minimized');
  h.output.length = 0;
  await h.hook('Stop');
  assert.equal(h.output.length, 0);
  await h.emit('window_restored');
  assert.match(h.frame(), /Claude State/);
  await h.input('a');
  assert.match(h.output.join(''), /Claude Dashboard/);
  h.output.length = 0;
  await h.hook('SessionEnd');
  assert.equal(h.output.length, 0);
});

test('hidden agent controls cannot toggle services; visible controls and mouse work', async () => {
  const h = await harness();
  await h.emit('menu_activated', { id: 'toggle-server' });
  assert.equal(h.calls.filter(c => c.method === 'web.stop').length, 0);
  await h.input('a');
  await h.input('p');
  assert.equal(h.calls.filter(c => c.method === 'terminal.subscribe').length, 1);
  await h.input('\x1b[<0;5;1M');
  h.output.length = 0;
  await h.hook('UserPromptSubmit');
  assert.equal(h.output.length, 0, 'mouse back button returns to dashboard');
});

test('compact suppresses completion notifications and malformed messages are ignored', async () => {
  const h = await harness();
  await h.hook('UserPromptSubmit');
  await h.hook('PreCompact');
  await h.hook('Stop');
  assert.equal(h.calls.filter(c => c.method === 'notify.send').length, 0);
  await h.emit('http_request_received', { body: 'null' });
  await h.emit('ws_message_received', { data: '{broken' });
  await h.hook('PostCompact');
  await h.hook('Stop');
  assert.equal(h.calls.filter(c => c.method === 'notify.send').length, 1);
});

test('legacy notification settings migrate to a separate dashboard settings file', async () => {
  const h = await harness({ legacy: { version: 1, notify: { Stop: false }, suppressDuringCompact: true } });
  await h.hook('UserPromptSubmit');
  await h.hook('Stop');
  assert.equal(h.calls.filter(c => c.method === 'notify.send').length, 0);
  await h.input('a');
  await h.input('n');
  assert.ok(h.files.has('/home/.hecaton/data/dev.hecaton.claude-dashboard/agent-state.json'));
});

test('hook installation preserves settings changed while the dialog was open', async () => {
  const h = await harness();
  const settingsPath = '/home/.claude/settings.json';
  h.files.set(settingsPath, JSON.stringify({ changed: 'preserve', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] } }));
  await h.emit('dialog_resolved', { button_id: 'install' });
  const settings = JSON.parse(h.files.get(settingsPath));
  assert.equal(settings.changed, 'preserve');
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo user-hook');
  assert.match(settings.hooks.Stop[0].hooks[1].command, /127\.0\.0\.1:9218\/hook/);
  assert.equal(Object.keys(settings.hooks).length, 9);
});

test('shutdown releases server, subscription and badges once without awaiting closed stdin', async () => {
  const h = await harness();
  await h.input('a');
  await h.input('p');
  await h.hook('UserPromptSubmit');
  h.stdin.emit('end');
  h.stdin.emit('close');
  assert.equal(h.calls.filter(c => c.method === 'web.stop').length, 1);
  assert.equal(h.calls.filter(c => c.method === 'terminal.unsubscribe').length, 1);
  assert.equal(h.calls.filter(c => c.method === 'terminal.set_status').at(-1).args.label, '');
});

test('shutdown during server startup releases the late server', async () => {
  let resolve;
  const h = await harness({ serve: () => new Promise(r => { resolve = r; }) });
  h.stdin.emit('end');
  resolve({ ok: true, server_id: 88, port: 9218 });
  await flush();
  assert.equal(h.calls.find(c => c.method === 'web.stop').args.server_id, 88);
  assert.equal(h.calls.filter(c => c.method === 'dialog.show').length, 0);
});

test('Korean startup, live locale switching, translated notifications and stable protocol keys', async () => {
  const h = await harness({ locale: 'KO_kr.UTF-8' });
  assert.match(h.output.join(''), /Claude 대시보드/);
  assert.match(h.output.join(''), /인증 정보를 찾을 수 없습니다/);
  await h.input('a');
  assert.match(h.frame(), /훅 서버/);
  assert.match(h.frame(), /응답 완료/);
  await h.hook('UserPromptSubmit');
  await h.hook('Stop');
  assert.match(h.calls.filter(c => c.method === 'notify.send').at(-1).args.body, /응답 완료/);
  await h.emit('menu_requested', {});
  const menu = h.calls.filter(c => c.method === 'menu.show').at(-1).args.items;
  assert.equal(menu.find(i => i.id === 'toggle-server').label, '훅 서버 중지');
  await h.emit('locale_changed', { locale: 'en-US' });
  assert.match(h.frame(), /Hook Server/);
  assert.equal(h.calls.filter(c => c.method === 'terminal.set_status').at(-1).args.detail, 'waiting');
  await h.input('a');
  assert.match(h.frame(), /No credentials found/);
  await h.emit('locale_changed', { locale: 'ko' });
  assert.match(h.frame(), /인증 정보를 찾을 수 없습니다/);
});

test('locale environment fallback, unsupported language fallback, and complete UTF-8 catalogs', async () => {
  const h = await harness({ envLocale: 'ko-KR' });
  assert.match(h.output.join(''), /Claude 대시보드/);
  await h.emit('locale_changed', { locale: 'fr-FR' });
  assert.match(h.frame(), /Claude Dashboard/);
  const en = JSON.parse(fs.readFileSync(path.join(root, 'locale/en.json'), 'utf8'));
  const ko = JSON.parse(fs.readFileSync(path.join(root, 'locale/ko.json'), 'utf8'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort());
  for (const key of Object.keys(en)) {
    assert.ok(!ko[key].includes('?'), `corrupt Korean translation: ${key}`);
    assert.deepEqual((en[key].match(/\{\w+\}/g) || []).sort(), (ko[key].match(/\{\w+\}/g) || []).sort(), key);
  }
});

test('Korean buttons use display columns for mouse hit testing and long text clips cleanly', async () => {
  const h = await harness({ locale: 'ko', cols: 72 });
  const width = h.textHelpers.displayWidth;
  assert.equal(width('한글 e\u0301'), 6);
  assert.equal(h.textHelpers.clipCells('한글', 3), '한');
  const frame = h.output.join('');
  const lines = [...frame.matchAll(/\x1b\[(\d+);(\d+)H([^]*?)(?=\x1b\[\d+;\d+H|$)/g)];
  const line = lines.filter(m => m[3].includes('[2] 에이전트 상태')).at(-1);
  assert.ok(line);
  const plain = line[3].replace(/\x1b\[[0-9;]*m/g, '');
  const offset = plain.indexOf('[2] 에이전트 상태');
  const col = Number(line[2]) + width(plain.slice(0, offset)) + width('[2] 에이전트 상태') - 1;
  await h.input(`\x1b[<0;${col};${line[1]}M`);
  assert.match(h.frame(), /훅 서버/);
  const agentFrame = h.frame();
  for (const m of agentFrame.matchAll(/\x1b\[(\d+);(\d+)H([^]*?)(?=\x1b\[\d+;\d+H|$)/g)) {
    assert.ok(Number(m[2]) - 1 + width(m[3]) <= 72, 'translated segment exceeds terminal width');
  }
  await h.input('\x1b[<0;5;1M');
  assert.match(h.frame(), /Claude 대시보드/);
});

test('shared tabs stay in row one across views, resizing and scrolling', async () => {
  const h = await harness({ locale: 'ko' });
  for (const [cols, rows] of [[40, 12], [120, 42], [60, 18]]) {
    await h.emit('window_resized', { cols, rows });
    for (const key of ['1', '2', '3']) {
      await h.input(key);
      let frame = h.frame();
      assert.match(frame, /\x1b\[1;1H[^]*\[1\]/);
      assert.match(frame, /\[2\]/);
      assert.match(frame, /\[3\]/);
      for (const m of frame.matchAll(/\x1b\[(\d+);(\d+)H([^]*?)(?=\x1b\[\d+;\d+H|$)/g)) {
        assert.ok(Number(m[1]) <= rows, `view ${key}: row outside resized viewport`);
        assert.ok(Number(m[2]) - 1 + h.textHelpers.displayWidth(m[3]) <= cols, `view ${key}: line too wide`);
      }
      await h.input('\x1b[<65;5;8M');
      assert.match(h.frame(), /\x1b\[1;1H[^]*\[1\]/);
      await h.input(`\x1b[<0;${Math.floor(cols / 3) + 2};1M`);
      assert.match(h.frame(), /훅 서버/);
    }
  }
  await h.input('1');
  await h.input('\t');
  assert.match(h.frame(), /훅 서버/);
  await h.input('\t');
  assert.match(h.frame(), /활동 기록/);
});

test('window supports host resize and maximize without changing release version', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  assert.equal(manifest.version, '1.6.0');
  for (const property of ['resizable', 'maximizable', 'bordered']) assert.equal(manifest.overlay[property], true);
});

test('authenticated dashboard renders usage and survives refresh, resize and tab return', async () => {
  const h = await harness({ authenticated: true, locale: 'ko' });
  assert.match(h.frame(), /25%/);
  assert.match(h.frame(), /추가 사용량/);
  assert.match(h.frame(), /\[r\] 새로고침/);
  await h.input('r');
  await h.emit('window_resized', { cols: 80, rows: 40 });
  await h.input('2');
  await h.input('1');
  assert.match(h.frame(), /25%/);
  assert.ok(!h.calls.some(c => c.method === 'exit'));
  assert.ok(h.calls.filter(c => c.method === 'http.get' && c.args.url.includes('/oauth/usage')).length >= 2);
});

test('authenticated API error responses still render the refresh button without exiting', async () => {
  for (const usageStatus of [401, 429, 500]) {
    const h = await harness({ authenticated: true, usageStatus });
    assert.match(h.frame(), new RegExp(String(usageStatus)));
    assert.match(h.frame(), /\[r\] Refresh/);
    await h.input('r');
    assert.ok(!h.calls.some(c => c.method === 'exit'));
  }
});
