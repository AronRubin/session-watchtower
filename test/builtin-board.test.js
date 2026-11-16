'use strict';
// 확장에서 휴대폰 보드 켜기: 꺼져 있으면 묻고 켜면 이 창이 보드를 맡아 휴대폰 단추·QR 패널(이 확장이 만든 연결 코드)이 나오고,
// 끄면 포트를 닫는다. 연결된 기기 끊기는 확인을 받은 뒤에만. 진짜 tailscale은 부르지 않는다(PATH 앞에 대역).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const fx = require('./helpers/fixture');

const { home, project, markers } = fx.makeHome();
const fakeBin = path.join(home, 'fake-bin');
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(path.join(fakeBin, 'tailscale'), '#!/bin/sh\nexit 1\n');
fs.chmodSync(path.join(fakeBin, 'tailscale'), 0o755);
process.env.PATH = fakeBin + path.delimiter + process.env.PATH;

const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: p, headers: { Connection: 'close', ...headers }, agent: false }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })); });
  req.on('error', reject);
  req.setTimeout(5000, () => req.destroy(new Error('no answer in 5 s: ' + p))); // 답 없는 서버에 닿으면 끝없이 기다리지 않고 어디서 멈췄는지 남긴다
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 9000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('기다림 초과: ' + what); await sleep(50); }
}

let ext = null;
// 전체 시험에서 가끔 이 파일이 끝나지 않았다(혼자 돌리면 재현 안 됨). 멈추면 어느 단계였는지 남긴다
let step = 'start';
const at = (name) => { step = name; };
process.on('beforeExit', () => { if (step !== 'done') console.error('[builtin-board] stuck at step: ' + step); });
test.after(async () => { at('deactivate'); if (ext) await ext.deactivate(); at('done'); });

test('꺼져 있으면 켤지 묻고, 켜면 이 창이 보드를 맡아 휴대폰 단추와 QR 패널이 나오며, 끄면 포트를 닫는다', { skip: process.platform === 'win32', timeout: 60000 }, async () => {
  const port = await freePort();
  const stub = require('./helpers/vscode-stub').install({
    extDir: path.join(__dirname, '..'), language: 'en', workspace: project,
    config: { attentionMarkerDir: markers, pollSeconds: 2, notifyStuckMinutes: 0, notifyWaiting: false, 'phoneBoard.port': port, 'phoneBoard.label': 'Test PC' },
  });
  ext = require('../extension.js');
  ext.activate(stub.context);
  assert.strictEqual(ext._test.boardState(), 'off', '기본은 꺼짐');
  const web = stub.openWebview('claudeSessionChanges.sessions');
  web.send({ type: 'ready' });

  // 꺼진 채로 휴대폰 연결을 부르면 무엇인지 말하고 켤지 묻는다(아니라고 하면 그대로 꺼짐)
  stub.calls.length = 0;
  at('pair while off');
  await stub.commands.get('claudeSessionChanges.phoneBoardPair')();
  const ask = stub.calls.find((c) => c[0] === 'info' && /The phone board is off\. Turn it on\?/.test(c[1]));
  assert.ok(ask, '켤지 묻는다');
  assert.ok(!stub.calls.some((c) => c[0] === 'info' && /not published/.test(c[1])), '"공개 전 별도 프로그램" 안내는 더 나오지 않는다');
  assert.strictEqual(ext._test.boardState(), 'off');
  assert.strictEqual(stub.state.config['phoneBoard.enabled'], undefined, '묻기만 하고 설정은 바꾸지 않는다');

  // "켜기" → 설정이 켜지고 이 창이 보드를 맡고, 확장이 만든 코드로 QR 패널을 연다
  stub.state.answer = (m, b) => (/Turn it on\?/.test(m) ? b[0] : undefined);
  at('turn on');
  await stub.commands.get('claudeSessionChanges.phoneBoardToggle')();
  stub.state.answer = undefined;
  assert.strictEqual(stub.state.config['phoneBoard.enabled'], true);
  assert.strictEqual(ext._test.boardState(), 'mine');
  at('healthz after on');
  const hz = await get(port, '/healthz');
  assert.deepStrictEqual([hz.status, decodeURIComponent(hz.headers['x-session-board-label'])], [200, 'Test PC']);
  const html = await until(() => { const p = (stub.state.panels || []).find((x) => x.viewType === 'claudeSessionChanges.phone'); return p && /\/pair\?c=/.test(p.webview.html) && p.webview.html; }, 'QR 패널');
  const m = /http:\/\/127\.0\.0\.1:(\d+)\/pair\?c=([A-Z0-9]{10})/.exec(html);
  assert.ok(m, 'Tailscale이 없으면 이 컴퓨터 주소로 링크를 만든다');
  assert.strictEqual(Number(m[1]), port);
  assert.match(html, /Not ready yet: the link below only opens on this computer\./, '휴대폰에서 열리려면 Tailscale이 필요하다고 보여 준다');
  at('pair request');
  const paired = await get(port, '/pair?c=' + m[2]);
  assert.strictEqual(paired.status, 302, '패널의 코드로 실제 보드에 연결된다');

  // 보드가 뜨면 세션 창에 휴대폰·컴퓨터 단추
  await until(() => web.lastPayload() && web.lastPayload().phone, '휴대폰 단추');

  // 끊기는 확인을 받은 뒤에만
  stub.calls.length = 0;
  at('revoke');
  await stub.commands.get('claudeSessionChanges.phoneBoardRevoke')();
  const confirm = stub.calls.find((c) => c[0] === 'warn' && /Disconnect all 1 connected/.test(c[1]));
  assert.ok(confirm, '끊을지 묻는다');
  assert.strictEqual((await get(port, '/', { Cookie: String(paired.headers['set-cookie']).split(';')[0] })).status, 200, '아니라고 하면 그대로');

  // 끄기 → 포트를 닫는다
  at('turn off');
  await stub.commands.get('claudeSessionChanges.phoneBoardToggle')();
  assert.strictEqual(stub.state.config['phoneBoard.enabled'], false);
  assert.strictEqual(ext._test.boardState(), 'off');
  at('healthz after off');
  await assert.rejects(get(port, '/healthz'), /ECONNREFUSED/);
});
