// Exercise both actual runners against a mock host; never launch or stop hecaton.exe.
// Usage: node tests/runner-smoke.cjs <path-to-deno_runner/main.ts>
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const runner = process.argv[2];
if (!runner) throw new Error('Pass the installed Hecaton deno_runner/main.ts path');
const root = path.resolve(__dirname, '..');
const methods = [], peers = {}, waiting = [];
let listening = false, connected = false, passed = false, navigating = false, refreshing = false;
let phaseAt = 0;
function send(peer, value) {
  const json = JSON.stringify(value);
  if (!peer.child.stdin.destroyed) peer.child.stdin.write(`__HECA_RPC__${Buffer.byteLength(json)}:${json}`);
}
function note(peer, method, params) { send(peer, { jsonrpc: '2.0', method, params }); }
function reply(peer, id, result) { send(peer, { jsonrpc: '2.0', id, result }); }
function connect(peer, id) {
  connected = true;
  note(peers.service, 'service_client_connected', { link_id: 'ui-1' });
  reply(peer, id, { ok: true, link_id: 'ui-1', protocol: 1 });
}
function rpc(peer, request) {
  const p = request.params || {};
  methods.push({ role: peer.role, method: request.method });
  if (request.method === 'lifecycle.shutdown_complete') {
    peer.shutdownComplete = true;
    reply(peer, request.id, { ok: true });
    // The real host ends the service process once its cleanup acknowledgment arrives.
    setTimeout(() => peer.child.kill(), 50);
    return;
  }
  if (request.method === 'service.listen') {
    listening = true;
    reply(peer, request.id, { ok: true });
    for (const pending of waiting.splice(0)) connect(...pending);
    return;
  }
  if (request.method === 'service.connect') {
    if (listening) connect(peer, request.id); else waiting.push([peer, request.id]);
    return;
  }
  if (request.method === 'service.send') {
    if (connected) note(peers[peer.role === 'ui' ? 'service' : 'ui'], 'service_message', { link_id: 'ui-1', data: p.data });
  }
  if (request.method === 'service.disconnect') {
    connected = false;
    note(peers.service, 'service_client_disconnected', { link_id: 'ui-1', reason: 'closed' });
  }
  let result = { ok: true };
  if (request.method === 'env.get_home') result = { path: '/mock-home' };
  if (request.method === 'env.get') result = { value: p.name === 'HECA_COLS' ? '100' : p.name === 'HECA_ROWS' ? '40' : '' };
  if (request.method === 'fs.read_file') result = { ok: false };
  if (request.method === 'fs.read_file' && p.path.endsWith('plugin.json')) result = { ok: true, content: fs.readFileSync(path.join(root, 'plugin.json'), 'utf8') };
  if (request.method === 'fs.read_file' && p.path.endsWith('.credentials.json')) result = { ok: true, content: JSON.stringify({ claudeAiOauth: { accessToken: 'mock-token' } }) };
  if (request.method === 'permissions.query') result = { state: 'granted' };
  if (request.method === 'http.get') result = { ok: false, error: 'offline smoke test' };
  if (request.method === 'http.get' && p.url.includes('/oauth/usage')) result = { ok: true, status: 200, body: JSON.stringify({ five_hour: { utilization: 25 } }) };
  if (request.method === 'terminal.list') result = { terminals: [] };
  if (request.method === 'web.serve') result = { ok: true, server_id: 7, port: 9218 };
  reply(peer, request.id, result);
}
for (const role of ['service', 'ui']) {
  const peer = peers[role] = { role, output: '', stderr: '', buffer: '', exited: false };
  peer.child = spawn('deno', ['run', '--allow-all', runner, path.join(root, role === 'ui' ? 'main.js' : 'service.js')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HECA_PLUGIN_ROLE: role, HECA_LOCALE: 'en', HECA_COLS: '100', HECA_ROWS: '40' },
  });
  peer.child.stdout.on('data', data => { peer.output += data; });
  peer.child.stderr.on('data', data => {
    peer.buffer += data;
    let index;
    while ((index = peer.buffer.indexOf('\n')) >= 0) {
      const line = peer.buffer.slice(0, index).trim(); peer.buffer = peer.buffer.slice(index + 1);
      if (!line.startsWith('__HECA_RPC__')) { peer.stderr += line + '\n'; continue; }
      rpc(peer, JSON.parse(line.slice(line.indexOf('{'))));
    }
  });
  peer.child.on('error', error => { peer.stderr += error.message; });
  peer.child.on('exit', code => { peer.exited = true; peer.code = code; });
}
const tick = setInterval(() => {
  for (const peer of Object.values(peers)) if (!peer.exited) note(peer, 'tick', {});
  if (!navigating && peers.ui.output.includes('25%') && methods.some(x => x.method === 'web.serve')) {
    navigating = true; peers.ui.child.stdin.write('a');
  }
  if (navigating && !refreshing && peers.ui.output.includes('Claude State')) {
    refreshing = true; peers.ui.child.stdin.write('1r'); phaseAt = Date.now();
  }
  if (refreshing && Date.now() - phaseAt > 700 && !passed) {
    passed = true;
    note(peers.service, 'shutdown', {});
    peers.ui.child.stdin.end();
    setTimeout(() => peers.service.child.stdin.end(), 500);
  }
  if (Object.values(peers).every(p => p.exited)) finish();
}, 50);
const timeout = setTimeout(() => {
  for (const peer of Object.values(peers)) if (!peer.exited) peer.child.kill(); // test-owned runners only
  finish();
}, 10000);
let finished = false;
function finish() {
  if (finished) return; finished = true;
  clearInterval(tick); clearTimeout(timeout);
  const diagnostic = Object.values(peers).map(p => p.role + ': ' + p.stderr).join('\n');
  assert.ok(passed, diagnostic + JSON.stringify(methods));
  assert.equal(peers.service.output, '', 'service must not render');
  assert.equal(methods.filter(x => x.method === 'web.serve').length, 1);
  assert.ok(methods.filter(x => x.method === 'web.serve').every(x => x.role === 'service'));
  assert.ok(!/Plugin (?:async )?error|ReferenceError|TypeError/.test(diagnostic), diagnostic);
  assert.equal(peers.ui.code, 0, diagnostic);
  assert.ok(peers.service.shutdownComplete, diagnostic);
  assert.ok(methods.some(x => x.role === 'service' && x.method === 'web.stop'));
  console.log('PASS: actual UI and service runners connect, render, navigate, refresh and shut down.');
}
