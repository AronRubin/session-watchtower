'use strict';
// 커밋 하나의 자세한 내용: 전체 메시지, 만든 사람·시각, 파일별 바뀐 줄.
// git은 셸 없이 인자 배열로만 부르고, 커밋 번호는 이 세션의 변경 기록에 있는 것만 받는다(server.js에서 확인).

const { execFileSync } = require('child_process');
const T = require('./transcript');

const FILE_LINES_MAX = 400;
const TOTAL_LINES_MAX = 2000;

// core.quotePath=false: 한글 등 비ASCII 경로를 "\355…" 꼴로 감싸지 않게(파일 나누기가 섞이지 않게)
function git(top, args, maxBuffer) {
  return execFileSync('git', ['-C', top, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', timeout: 6000, maxBuffer: maxBuffer || 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

// git이 따옴표로 감싼 경로("b/\355\225\234.md", 특수 문자가 든 경로)를 푼다
function unquote(q) {
  const bytes = [];
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (c !== '\\') { for (const b of Buffer.from(c, 'utf8')) bytes.push(b); continue; }
    const n = q[i + 1];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(q.slice(i + 1, i + 4), 8)); i += 3; continue; }
    const esc = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }[n];
    bytes.push(esc != null ? esc : n.charCodeAt(0));
    i++;
  }
  return Buffer.from(bytes).toString('utf8');
}

// 따옴표 없는 경로: 이름이 바뀌지 않은 파일은 앞뒤 경로가 같으므로, 경로 안에 " b/"가 있어도 가운데에서 정확히 나눈다
function plainPath(line, greedy) {
  const rest = line.slice('diff --git a/'.length);
  const half = (rest.length - 3) / 2;
  if (Number.isInteger(half) && rest.slice(half, half + 3) === ' b/' && rest.slice(0, half) === rest.slice(half + 3)) return rest.slice(half + 3);
  return greedy;
}

// "diff --git a/x b/x" 단위로 나눈다. 경로가 따옴표로 감싸여 있으면("a/…" "b/…") 풀어서 쓴다
function splitFiles(text) {
  const files = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const q = /^diff --git "?a\/(?:[^"]|\\")*"? "b\/((?:[^"\\]|\\.)*)"$/.exec(line);
    const m = q ? null : /^diff --git "?a\/(.*)"? b\/(.*)$/.exec(line);
    if (q || m) { cur = { path: q ? unquote(q[1]) : plainPath(line, m[2]), lines: [] }; files.push(cur); continue; }
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
      const lines = T.maskLines(h.lines).slice(0, room).map(([t, s]) => [t, s.slice(0, 2000)]);
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
