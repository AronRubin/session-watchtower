'use strict';
// 휴대폰 보드(내장)용 세션 읽기 스레드. 보드를 맡은 창에서만 돈다.
// 이 확장의 scanner.js(정본)로 이 창 폴더만이 아니라 모든 폴더의 세션을 10초마다 읽는다(따로 설치하는 session-board와 같은 방식).
const { parentPort, workerData } = require('worker_threads');
const scanner = require('./scanner');

const cfg = workerData;
const model = scanner.createModel();
const opts = {
  lookbackHours: cfg.lookbackHours,
  includeCodex: true,
  attentionDir: cfg.attentionDir,
  cacheFile: cfg.cacheFile,
  listDays: 0,
  otherListDays: cfg.listDays,
  workspaceDirs: [],
  progressMs: 1e9,
};

let timer = null;
let stopped = false;
function tick() {
  if (stopped) return;
  try {
    const res = model.scan(opts);
    parentPort.postMessage({ sessions: res.sessions, at: Date.now() });
  } catch (e) {
    parentPort.postMessage({ error: String((e && e.message) || e) });
  }
  timer = setTimeout(tick, cfg.scanMs);
}
parentPort.on('message', (m) => { if (m === 'stop') { stopped = true; clearTimeout(timer); } });
tick();
