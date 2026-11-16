'use strict';
// 휴대폰 보드를 이 확장 안에서 켜고 끄기(설정 phoneBoard.enabled, 기본 꺼짐) — vscode 없이 돌아가는 부분.
// 보드 본체는 board/(session-board의 커밋된 판을 tools/sync-board.sh로 복사한 것)이고, 여기서는 켤지 말지만 정한다.
// - 127.0.0.1에만 연다(바꾸는 설정 없음). 휴대폰은 각자 Tailscale serve(https)로 들어온다. funnel(인터넷 공개)은 쓰지 않는다.
// - 창이 여러 개면 포트가 자물쇠다: 먼저 연 창이 보드를 맡고, 나머지 창은 비켜 있다가 그 창이 닫히면 넘겨받는다.
// - 이 컴퓨터에 따로 설치한 보드(session-board)나 다른 창의 보드가 이미 그 포트에서 돌면 켜지 않는다.
// - 다른 컴퓨터 보드가 넘겨받은 포트(원격 창의 포트 전달)거나 보드가 아닌 프로그램이 포트를 쓰면 켜지 않고 이유를 돌려준다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const phoneboard = require('./phoneboard');

const BOARD_DIR = path.join(__dirname, 'board');

// 보드 설정(board/lib/config.js의 loadConfig와 같은 필드). 주소는 127.0.0.1로 고정
function boardConfig(o) {
  return {
    host: '127.0.0.1',
    port: o.port,
    label: String(o.label || os.hostname() || 'Phone board').slice(0, 30),
    peers: [],
    stateDir: o.stateDir,
    groupsFile: o.groupsFile,
    archiveFile: o.archiveFile,
    attentionDir: o.attentionDir,
    registryDir: o.registryDir,
    lookbackHours: 24,
    closedHours: 6,
    listDays: 14,
    scanMs: Math.max(3000, Number(o.scanMs) || 10000),
    secureCookie: false, // https 뒤(Tailscale serve)에서는 보드가 x-forwarded-proto를 보고 Secure를 붙인다
    pushDelayS: Math.max(0, Number(o.pushDelayS ?? 60) || 0),
    pushSubject: 'mailto:session-board@localhost', // 푸시 서버에 밝히는 연락처: 개인 메일을 넣지 않는다
  };
}

// 보드가 스스로 적는 실행 정보(<상태 폴더>/run.json)가 살아 있는 프로세스 것이면 { port, label, pid }
function liveRun(dir) {
  let r;
  try { r = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')); } catch { return null; }
  const port = Number(r && r.port);
  const pid = Number(r && r.pid);
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); } catch (e) { if (!e || e.code !== 'EPERM') return null; }
  return { port, label: typeof r.label === 'string' ? r.label.slice(0, 60) : '', pid };
}

// 그 포트를 누가 쓰는가: 'local'(이 컴퓨터의 보드 — 다른 창이나 따로 설치한 보드) / 'foreign'(보드가 답하지만 이 컴퓨터 것이 아님) / 'free'
async function portOwner(port, runDirs) {
  const b = await phoneboard.probe(port);
  if (!b) return 'free';
  return runDirs.some((d) => { const r = liveRun(d); return r && r.port === port; }) ? 'local' : 'foreign';
}

// o: { log, workerPath?, scanner? } — 시험에서 바꿔 끼울 수 있게
function createHost(o = {}) {
  const log = o.log || { info() {}, error() {} };
  let server = null;
  let worker = null;
  let busy = null;
  let state = 'off'; // off | mine | local | foreign | busy | error
  let detail = '';
  let port = 0;

  // c: { port, label, stateDir, standaloneDir, groupsFile, archiveFile, attentionDir, registryDir, pushDelayS, scanMs }
  async function start(c) {
    if (server && port === c.port) return state;
    if (server) await stop();
    const owner = await portOwner(c.port, [c.stateDir, c.standaloneDir].filter(Boolean));
    if (owner !== 'free') { state = owner; detail = ''; return state; }
    const { createBoardServer } = require(path.join(BOARD_DIR, 'lib', 'board-server.js'));
    const cfg = boardConfig(c);
    let feedCb = null;
    const w = new Worker(o.workerPath || path.join(__dirname, 'board-worker.js'), { workerData: { ...cfg, cacheFile: path.join(c.stateDir, 'scan-cache.json') } });
    w.on('message', (m) => { if (feedCb) feedCb(m); });
    w.on('error', (e) => { if (feedCb) feedCb({ error: String((e && e.message) || e) }); log.error('phone board scan', e); });
    if (w.unref) w.unref();
    const srv = createBoardServer(cfg, { feed: (cb) => { feedCb = cb; }, scanner: o.scanner || require('./scanner'), log });
    try {
      await srv.listen();
    } catch (e) {
      w.terminate();
      await srv.close();
      state = e && e.code === 'EADDRINUSE' ? 'busy' : 'error';
      detail = String((e && e.message) || e);
      return state;
    }
    server = srv;
    worker = w;
    port = c.port;
    state = 'mine';
    detail = '';
    return state;
  }

  async function stop() {
    const w = worker;
    const s = server;
    worker = null;
    server = null;
    port = 0;
    state = 'off';
    if (w) { try { w.postMessage('stop'); } catch { /* 이미 끝남 */ } w.terminate(); }
    if (s) await s.close();
  }

  // 켜기·끄기가 겹치지 않게 한 줄로 세운다
  function ensure(enabled, c) {
    const run = () => (enabled ? start(c) : stop().then(() => state));
    busy = (busy || Promise.resolve()).then(run, run);
    return busy;
  }

  return {
    ensure,
    stop: () => ensure(false),
    state: () => state,
    detail: () => detail,
    port: () => port,
  };
}

// 휴대폰 연결 코드(10분, 한 번만). 보드는 코드를 파일(상태 폴더의 pair.json)에서 읽으므로, 보드를 맡지 않은 창에서도 만들 수 있다
function pairCode(stateDir) {
  const { createStore } = require(path.join(BOARD_DIR, 'lib', 'auth.js'));
  return createStore(stateDir).createPairCode();
}

// 연결된 기기 모두 끊기. 끊은 수를 돌려준다
function revokeAll(stateDir) {
  const { createStore } = require(path.join(BOARD_DIR, 'lib', 'auth.js'));
  return createStore(stateDir).revoke('all');
}

function deviceCount(stateDir) {
  const { createStore } = require(path.join(BOARD_DIR, 'lib', 'auth.js'));
  return createStore(stateDir).devices().length;
}

module.exports = { createHost, boardConfig, liveRun, portOwner, pairCode, revokeAll, deviceCount, BOARD_DIR };
