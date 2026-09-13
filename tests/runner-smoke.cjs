// Exercise the actual Hecaton runner with a mock RPC peer, without touching the app.
// Usage: node tests/runner-smoke.cjs <path-to-deno_runner/main.ts>
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const runner = process.argv[2];
if (!runner) throw new Error('Pass the installed Hecaton deno_runner/main.ts path');
const root = path.resolve(__dirname, '..');
const child = spawn('deno', ['run', '--allow-all', runner, path.join(root, 'main.js')], {
  windowsHide: true,
  env: { ...process.env, HECA_LOCALE: 'ko', HECA_COLS: '100', HECA_ROWS: '40' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let output = '', stderr = '', buffer = '', rendered = false, agentSeenAt = null, refreshSent = false;
const methods = [];
function send(value) {
  const json = JSON.stringify(value);
  if (!child.stdin.destroyed) child.stdin.write(`__HECA_RPC__${Buffer.byteLength(json)}:${json}\n`);
}
child.stdin.on('error', () => {});
child.stdout.on('data', data => { output += data.toString(); });
child.stderr.on('data', data => {
  buffer += data.toString();
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line.startsWith('__HECA_RPC__')) { stderr += line + '\n'; continue; }
    const request = JSON.parse(line.slice('__HECA_RPC__'.length));
    methods.push(request.method);
    const p = request.params || {};
    let result = { ok: true };
    if (request.method === 'fs.read_file') result = p.path.endsWith('plugin.json')
      ? { ok: true, content: fs.readFileSync(path.join(root, 'plugin.json'), 'utf8') } : { ok: false };
    if (request.method === 'fs.read_file' && p.path.endsWith('.credentials.json')) {
      result = { ok: true, content: JSON.stringify({ claudeAiOauth: { accessToken: 'mock-token' } }) };
    }
    if (request.method === 'env.get_home') result = { path: '/mock-home' };
    if (request.method === 'env.get') result = { value: p.name === 'HECA_COLS' ? '100' : p.name === 'HECA_ROWS' ? '40' : '' };
    if (request.method === 'permissions.query') result = { state: 'granted' };
    if (request.method === 'http.get') result = { ok: false, error: 'offline smoke test' };
    if (request.method === 'http.get' && p.url.includes('/oauth/usage')) {
      result = { ok: true, status: 200, body: JSON.stringify({ five_hour: { utilization: 25 } }) };
    }
    if (request.method === 'terminal.list') result = { terminals: [] };
    if (request.method === 'web.serve') result = { ok: true, server_id: 7, port: 9218 };
    send({ jsonrpc: '2.0', id: request.id, result });
  }
});
// The real host sends ticks to wake the runner's synchronous stdin read.
const tick = setInterval(() => {
  send({ jsonrpc: '2.0', method: 'tick', params: {} });
  if (!rendered && output.includes('25%') && methods.includes('web.serve')) {
    rendered = true;
    child.stdin.write('a');
  }
  if (rendered && output.includes('훅 서버') && agentSeenAt === null) agentSeenAt = Date.now();
  if (agentSeenAt !== null && !refreshSent) {
    refreshSent = true;
    child.stdin.write('1r');
  }
  if (agentSeenAt !== null && Date.now() - agentSeenAt >= 1000) child.stdin.end();
}, 50);
const timeout = setTimeout(() => {
  // Only this test-owned runner process; never terminate hecaton.exe.
  child.kill();
}, 8000);
child.on('error', error => { clearInterval(tick); clearTimeout(timeout); throw error; });
child.on('exit', code => {
  clearInterval(tick); clearTimeout(timeout);
  assert.ok(rendered && output.includes('훅 서버'), `Runner failed to initialize/navigate (exit ${code}); RPC: ${methods.join(', ')}; stderr: ${stderr}`);
  assert.ok(!/Plugin (?:async )?error|ReferenceError|TypeError/.test(stderr), stderr);
  assert.equal(code, 0, stderr);
  assert.ok(refreshSent && methods.filter(m => m === 'http.get').length >= 3, 'refresh path was not exercised');
  console.log('PASS: actual Deno runner renders authenticated usage, switches tabs and survives refresh');
});
