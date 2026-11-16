'use strict';
// 커밋 하나의 자세한 내용: 전체 메시지, 만든 사람·시각, 파일별 바뀐 줄.
// git은 셸 없이 인자 배열로만 부르고, 커밋 번호는 이 세션의 변경 기록에 있는 것만 받는다(server.js에서 확인).

const { execFileSync } = require('child_process');
const T = require('./transcript');

const FILE_LINES_MAX = 400;
const TOTAL_LINES_MAX = 2000;

function git(top, args, maxBuffer) {
  return execFileSync('git', ['-C', top, ...args], { encoding: 'utf8', timeout: 6000, maxBuffer: maxBuffer || 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

// "diff --git a/x b/x" 단위로 나눈다
function splitFiles(text) {
  const files = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (m) { cur = { path: m[2], lines: [] }; files.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  return files;
}

function commitDetail(top, sha) {
  const meta = git(top, ['show', '-s', '--no-color', '--format=%H%x00%an%x00%aI%x00%B', sha]);
  const [full, author, date, ...rest] = meta.split('\0');
  const message = T.maskSecrets(rest.join('\0').replace(/\s+$/, '')).slice(0, 8000);
  const diffText = git(top, ['show', '--format=', '--unified=3', '--no-color', '--no-ext-diff', sha], 16 * 1024 * 1024);
  let total = 0;
  let truncated = false;
  const files = splitFiles(diffText).map((f) => {
    const body = f.lines.join('\n');
    const binary = /^Binary files /m.test(body);
    const created = /^new file mode/m.test(body);
    const deleted = /^deleted file mode/m.test(body);
    const hunks = [];
    let add = 0;
    let del = 0;
    let fileTrunc = false;
    for (const h of T.hunksFromUnified(body)) {
      for (const [t] of h.lines) { if (t === '+') add++; else if (t === '-') del++; }
      const room = Math.min(FILE_LINES_MAX - hunks.reduce((n, x) => n + x.lines.length, 0), TOTAL_LINES_MAX - total);
      if (room <= 0) { fileTrunc = true; continue; }
      const lines = h.lines.slice(0, room).map(([t, s]) => [t, T.maskSecrets(s).slice(0, 2000)]);
      if (lines.length < h.lines.length) fileTrunc = true;
      total += lines.length;
      hunks.push({ head: h.head, lines });
    }
    if (fileTrunc) truncated = true;
    return { path: f.path, add, del, binary, created, deleted, hunks, truncated: fileTrunc };
  });
  return { sha: full.trim(), author: author.trim(), date: date.trim(), message, files, truncated };
}

module.exports = { commitDetail, splitFiles };
