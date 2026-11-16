'use strict';
// 확장 안의 휴대폰 보드: 켤지 말지(포트 자물쇠·이 컴퓨터 보드·다른 컴퓨터 보드·다른 프로그램), 127.0.0.1, 연결 코드·쿠키, 끊기, 끄기.
// 보드 본체(board/)는 session-board의 커밋된 판을 복사한 것이라, 복사본이 기록(SOURCE.txt)과 같은지도 본다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fx = require('./helpers/fixture');

const { home, project } = fx.makeHome();
const bh = require('../boardhost.js');

const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const serve = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { Connection: 'close', ...headers }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}
const refused = (port) => get(port, '/healthz').then(() => false, (e) => e.code === 'ECONNREFUSED');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function options(port, stateDir) {
  return {
    port, label: 'Test board', pushDelayS: 0, scanMs: 3000,
    stateDir, standaloneDir: path.join(home, '.config', 'session-board'),
    groupsFile: path.join(home, 'groups.json'), archiveFile: path.join(home, 'archived.json'),
    attentionDir: path.join(home, 'att'), registryDir: path.join(home, '.claude', 'sessions'),
  };
}

const SID = 'b0a0d000-1111-4111-8111-000000000001';
fx.claudeSession(home, project, SID, [fx.rec.user(project, Date.now() - 60000, 'Board test task'), fx.rec.aiTitle(SID, 'Board test task')]);

const hosts = [];
const others = [];
test.after(async () => { for (const h of hosts) await h.stop(); for (const s of others) s.close(); });

test('복사한 보드(board/)는 기록(SOURCE.txt)의 판과 같다: 여기서 고치지 않고 session-board에서 고쳐 다시 복사한다', () => {
  const dir = bh.BOARD_DIR;
  const lines = fs.readFileSync(path.join(dir, 'SOURCE.txt'), 'utf8').split('\n');
  assert.match(lines[0], /^session-board [0-9a-f]{40}$/);
  const listed = new Map(lines.filter((l) => /^[0-9a-f]{64}  /.test(l)).map((l) => [l.slice(66), l.slice(0, 64)]));
  const walk = (d) => fs.readdirSync(path.join(dir, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name).split(path.sep).join('/')]));
  const files = [...walk('lib'), ...walk('public')].sort();
  assert.deepStrictEqual(files, [...listed.keys()].sort(), '기록에 없는 파일이나 빠진 파일이 없다');
  for (const f of files) assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex'), listed.get(f), f + '가 기록과 다르다');
  assert.ok(!files.includes('lib/scan-worker.js'), '세션 읽기는 이 확장의 board-worker.js가 한다');
  assert.ok(!files.some((f) => /\.json$/.test(f) && !f.endsWith('.webmanifest')), '상태 파일(연결 코드·기기·알림 열쇠)은 복사하지 않는다');
});

test('켜기: 127.0.0.1에만 열고, 연결 안 된 기기는 막고, 연결 코드는 한 번만, 기기 쿠키로 들어가고, 끊으면 다시 막힌다', async () => {
  const port = await freePort();
  const stateDir = path.join(home, 'state-a');
  const host = bh.createHost();
  hosts.push(host);
  assert.strictEqual(bh.boardConfig(options(port, stateDir)).host, '127.0.0.1', '주소를 바꾸는 설정이 없다');
  assert.strictEqual(await host.ensure(true, options(port, stateDir)), 'mine');
  const hz = await get(port, '/healthz');
  assert.deepStrictEqual([hz.status, hz.headers['x-session-board'], decodeURIComponent(hz.headers['x-session-board-label'])], [200, '1', 'Test board']);
  assert.strictEqual(bh.liveRun(stateDir).port, port, '실행 정보를 적는다(다른 창이 이 보드를 알아본다)');
  const first = await get(port, '/');
  assert.strictEqual(first.status, 401, '연결 안 된 기기는 막는다');
  assert.match(first.headers['content-security-policy'], /default-src 'none'/);
  assert.strictEqual((await get(port, '/api/state')).status, 401);

  const { code } = bh.pairCode(stateDir);
  const paired = await get(port, '/pair?c=' + code);
  assert.strictEqual(paired.status, 302);
  const cookie = String(paired.headers['set-cookie']);
  assert.match(cookie, /^sb=[^;]+; HttpOnly; SameSite=Lax; Path=\//, '자바스크립트가 못 읽는 기기 쿠키');
  assert.strictEqual((await get(port, '/pair?c=' + code)).status, 403, '같은 코드는 두 번 못 쓴다');
  const sb = cookie.split(';')[0];
  assert.strictEqual((await get(port, '/', { Cookie: sb })).status, 200);
  // 세션 읽기 스레드(이 확장의 scanner.js)가 모든 폴더 세션을 넘긴다
  let state = null;
  for (let i = 0; i < 60 && !(state && state.sessions && state.sessions.length); i++) { await sleep(100); state = JSON.parse((await get(port, '/api/state', { Cookie: sb })).body); }
  assert.ok(JSON.stringify(state).includes('Board test task'), '보드가 세션을 보여 준다');
  const devFile = fs.readFileSync(path.join(stateDir, 'devices.json'), 'utf8');
  assert.ok(!devFile.includes(decodeURIComponent(sb.slice(3))), '기기 토큰은 파일에 그대로 남기지 않는다(sha256만)');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(stateDir).mode & 0o077, 0, '상태 폴더는 나만 읽는다');

  assert.strictEqual(bh.deviceCount(stateDir), 1);
  assert.strictEqual(bh.revokeAll(stateDir), 1);
  assert.strictEqual((await get(port, '/', { Cookie: sb })).status, 401, '끊은 기기는 다시 막힌다');
});

test('창이 여러 개: 포트가 자물쇠라 먼저 연 창이 맡고, 다른 창은 비켜 있다가 그 창이 끄면 넘겨받는다', async () => {
  const port = await freePort();
  const stateDir = path.join(home, 'state-b');
  const a = bh.createHost();
  const b = bh.createHost();
  hosts.push(a, b);
  assert.strictEqual(await a.ensure(true, options(port, stateDir)), 'mine');
  assert.strictEqual(await b.ensure(true, options(port, stateDir)), 'local', '이 컴퓨터의 보드가 이미 그 포트에서 돈다');
  await a.stop();
  assert.ok(await refused(port), '끄면 포트를 닫는다');
  assert.strictEqual(bh.liveRun(stateDir), null, '끄면 실행 정보를 지운다');
  assert.strictEqual(await b.ensure(true, options(port, stateDir)), 'mine', '남은 창이 넘겨받는다');
  await b.stop();
});

test('다른 컴퓨터 보드가 넘겨받은 포트·보드 아닌 프로그램의 포트에서는 켜지 않고 이유를 돌려준다', async () => {
  const foreign = await serve((req, res) => { if (req.url === '/healthz') { res.writeHead(200, { 'X-Session-Board': '1', 'X-Session-Board-Label': 'other' }); res.end('ok'); } else { res.writeHead(404); res.end(); } });
  const plain = await serve((req, res) => { res.writeHead(404); res.end(); });
  others.push(foreign, plain);
  const h = bh.createHost();
  hosts.push(h);
  assert.strictEqual(await h.ensure(true, options(foreign.address().port, path.join(home, 'state-c'))), 'foreign');
  assert.strictEqual(await h.ensure(true, options(plain.address().port, path.join(home, 'state-c'))), 'busy');
  assert.match(h.detail(), /EADDRINUSE/);
  assert.strictEqual(await h.ensure(false), 'off');
});
