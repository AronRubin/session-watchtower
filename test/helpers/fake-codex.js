#!/usr/bin/env node
'use strict';
// 시험용 가짜 `codex app-server`: initialize → thread/name/set을 받아 $CODEX_HOME/session_index.jsonl에 덧붙인다(진짜 Codex와 같은 줄 모양).
// FAKE_CODEX_MODE: ok(기본) | error(thread/name/set 오류) | silent(대답 안 함) | exit(바로 끝남)
const fs = require('fs');
const path = require('path');
const mode = process.env.FAKE_CODEX_MODE || 'ok';
if (process.argv[2] !== 'app-server') process.exit(2);
if (mode === 'exit') process.exit(3);
const log = process.env.FAKE_CODEX_LOG;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const o = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (log) fs.appendFileSync(log, JSON.stringify(o) + '\n');
    if (mode === 'silent') continue;
    if (o.method === 'initialize') process.stdout.write(JSON.stringify({ id: o.id, result: { userAgent: 'fake' } }) + '\n');
    if (o.method === 'thread/name/set') {
      if (mode === 'error') { process.stdout.write(JSON.stringify({ id: o.id, error: { code: -32600, message: 'thread not found' } }) + '\n'); continue; }
      fs.appendFileSync(path.join(process.env.CODEX_HOME, 'session_index.jsonl'), JSON.stringify({ id: o.params.threadId, thread_name: o.params.name, updated_at: new Date().toISOString() }) + '\n');
      process.stdout.write(JSON.stringify({ id: o.id, result: {} }) + '\n');
    }
  }
});
