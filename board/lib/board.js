'use strict';
// 스캐너 결과 → 휴대폰 화면에 보낼 모양. HTTP와 떨어진 순수 함수라 시험하기 쉽다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('./transcript');

const HOME = os.homedir();
const RECENT_DONE_MS = 30 * 60 * 1000;
// 바뀐 파일을 보는 기간(분). 스캐너가 24시간까지만 읽으므로 그보다 길게는 받지 않는다
const WINDOWS = [30, 60, 180, 720, 1440];
const DEFAULT_WIN = 1440;

function parseWin(v) {
  const n = Number(v);
  return WINDOWS.includes(n) ? n : DEFAULT_WIN;
}

// 기간 밖의 변경 기록을 뺀 세션(원본은 건드리지 않는다)
function inWindow(s, since) {
  return since > 0 ? { ...s, changes: (s.changes || []).filter((c) => (c.ts || 0) >= since) } : s;
}

const WIN = process.platform === 'win32';
// 리눅스: /tmp/claude-1000/<프로젝트>/<세션>/scratchpad, Windows: …\Temp\claude\<해시>\<세션>\scratchpad
const SCRATCH_RE = /^\/tmp\/claude-\d+\/[^/]+\/[0-9a-f-]{36}\/scratchpad(?=\/|$)/;
const SCRATCH_WIN_RE = /^[A-Za-z]:[\\/].*?[\\/]Temp[\\/]claude[\\/][^\\/]+[\\/][0-9a-f-]{36}[\\/]scratchpad(?=[\\/]|$)/i;
function tilde(p, win = WIN, home = HOME) {
  if (!p) return '';
  const scratch = SCRATCH_RE.exec(p) || (win ? SCRATCH_WIN_RE.exec(p) : null);
  if (scratch) return '(임시 작업 폴더)' + p.slice(scratch[0].length);
  if (win) {
    // git은 C:/a/b, 대화 기록은 c:\a\b처럼 적으므로 \로 맞추고 대소문자 없이 비교한다
    const n = p.replace(/\//g, '\\');
    const h = home.replace(/\//g, '\\');
    if (n.toLowerCase() === h.toLowerCase()) return '~';
    if (n.toLowerCase().startsWith(h.toLowerCase() + '\\')) return '~' + n.slice(h.length);
    return n;
  }
  return p === home ? '~' : p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

function statusOf(s) {
  if (!s.alive) return 'closed';
  if (s.status === 'waiting') return 'wait';
  if (s.status === 'busy') return 'work';
  return 'idle';
}

const RANK = { wait: 0, work: 1, idle: 2, closed: 3 };

// 세션의 변경 기록 → 파일별 묶음. 커밋 기록은 같은 줄을 두 번 세지 않도록 편집 기록이 없을 때만 줄 수에 넣는다
function aggregate(changes) {
  const byPath = new Map();
  const shas = new Set();
  for (const c of changes || []) {
    if (c.kind === 'commit' && c.sha) shas.add(c.sha);
    if (!c.path) continue;
    let f = byPath.get(c.path);
    if (!f) { f = { path: c.path, add: 0, del: 0, cAdd: 0, cDel: 0, ts: 0, created: false, deleted: false, edited: false, committed: false, guessed: false, scratch: !!c.scratch }; byPath.set(c.path, f); }
    f.ts = Math.max(f.ts, c.ts || 0);
    if (c.created) f.created = true;
    if (c.deleted) f.deleted = true;
    if (c.kind === 'commit') { f.committed = true; f.cAdd += c.add || 0; f.cDel += c.del || 0; continue; }
    if (c.kind === 'shell') { f.guessed = true; continue; }
    f.edited = true;
    f.add += c.add || 0;
    f.del += c.del || 0;
  }
  const files = [...byPath.values()].map((f) => {
    const useCommit = !f.edited && f.committed;
    return { path: f.path, add: useCommit ? f.cAdd : f.add, del: useCommit ? f.cDel : f.del, ts: f.ts, created: f.created, deleted: f.deleted, committed: f.committed, guessed: f.guessed && !f.edited && !f.committed, scratch: f.scratch };
  }).sort((a, b) => b.ts - a.ts);
  return { files, add: files.reduce((n, f) => n + f.add, 0), del: files.reduce((n, f) => n + f.del, 0), commits: shas.size };
}

// Watchtower 그룹 파일 → 세션별 { group, role }
function groupIndex(groupsData) {
  const idx = new Map();
  const list = groupsData && Array.isArray(groupsData.groups) ? groupsData.groups : [];
  for (const g of list) {
    if (!g || typeof g.id !== 'string' || typeof g.name !== 'string') continue;
    const m = g.members && typeof g.members === 'object' ? g.members : {};
    for (const [sid, v] of Object.entries(m)) {
      if (idx.has(sid)) continue;
      idx.set(sid, { id: g.id, name: g.name.slice(0, 60), role: v && typeof v.role === 'string' ? v.role.slice(0, 40) : '' });
    }
  }
  return { idx, order: list.filter((g) => g && typeof g.id === 'string').map((g) => g.id) };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ~/.claude/sessions/*.json → 세션 ID → Remote Control 주소(연결된 세션만)
function readBridges(registryDir) {
  const map = new Map();
  let names = [];
  try { names = fs.readdirSync(registryDir); } catch { return map; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const d = readJson(path.join(registryDir, n), null);
    if (!d || typeof d.sessionId !== 'string') continue;
    const b = d.bridgeSessionId;
    if (typeof b === 'string' && /^session_[A-Za-z0-9]{10,64}$/.test(b)) map.set(d.sessionId, 'https://claude.ai/code/' + b);
  }
  return map;
}

function summarize(s, gi, bridges) {
  const g = gi.idx.get(s.sid) || null;
  const agg = aggregate(s.changes);
  const act = s.activity && s.activity.ts ? { tool: String(s.activity.tool || ''), arg: T.maskSecrets(s.activity.arg || ''), ts: s.activity.ts } : null;
  return {
    sid: s.sid,
    title: T.maskSecrets(String(s.title || '')).slice(0, 200),
    agent: s.agent || 'claude',
    project: s.project || '',
    worktree: s.worktree || null,
    cwd: tilde(s.cwd),
    status: statusOf(s),
    waitingFor: s.waitingFor || null,
    since: s.statusSince || s.lastActivity || 0,
    lastActivity: s.lastActivity || 0,
    group: g ? { id: g.id, name: g.name } : null,
    role: g ? g.role : '',
    files: agg.files.length,
    add: agg.add,
    del: agg.del,
    commits: agg.commits,
    activity: act,
    subagents: s.subagents || { total: 0, active: 0 },
    rc: bridges.get(s.sid) || null,
  };
}

// 전체 화면용 상태
function buildState(sessions, ctx) {
  const now = ctx.now || Date.now();
  const win = parseWin(ctx.win);
  const since = now - win * 60000;
  const gi = groupIndex(ctx.groups);
  const archived = (ctx.archive && ctx.archive.archived) || {};
  const bySid = new Map((sessions || []).map((s) => [s.sid, s]));
  const empty = { question: '', tool: null, lastLine: '', turn: null };
  const words = (sid) => {
    const s = bySid.get(sid);
    return s && s.file && ctx.lastWords ? ctx.lastWords(s.file) : empty;
  };
  const shown = [];
  for (const s of sessions || []) {
    const st = statusOf(s);
    if (st === 'closed') {
      if (s.programmatic) continue;
      if (archived[s.sid]) continue;
      // 그룹에 넣은 세션은 사용자가 고른 팀이라, 닫힌 지 오래돼도 그룹 안에 남긴다(기록을 읽는 24시간 안)
      if (!gi.idx.has(s.sid) && now - (s.lastActivity || 0) > ctx.closedHours * 3600e3) continue;
    }
    const x = summarize(inWindow(s, since), gi, ctx.bridges || new Map());
    // 쉬는 세션·닫힌 세션: 마지막 글이 질문·요청이면 'ask'(내 차례), 할 일 없다고 했으면 'none'
    x.turn = st === 'idle' || st === 'closed' ? words(s.sid).turn || null : null;
    shown.push(x);
  }
  const rank = (x) => (x.status === 'idle' && x.turn === 'ask' ? 0.5 : RANK[x.status]);
  const byRank = (a, b) => rank(a) - rank(b) || b.lastActivity - a.lastActivity;
  const sections = [];
  const live = shown.filter((x) => x.status !== 'closed');
  for (const gid of gi.order) {
    // 그룹은 켜진 세션 먼저, 닫힌 세션은 뒤에 흐리게(그룹이 통째로 사라지지 않게)
    const list = shown.filter((x) => x.group && x.group.id === gid).sort(byRank);
    if (list.length) sections.push({ id: 'g:' + gid, name: list[0].group.name, kind: 'group', sessions: list });
  }
  const projects = new Map();
  for (const x of live) {
    if (x.group) continue;
    const k = x.project || '(폴더 없음)';
    if (!projects.has(k)) projects.set(k, []);
    projects.get(k).push(x);
  }
  for (const [k, list] of [...projects.entries()].sort((a, b) => Math.max(...b[1].map((x) => x.lastActivity)) - Math.max(...a[1].map((x) => x.lastActivity)))) {
    sections.push({ id: 'p:' + k, name: k, kind: 'project', sessions: list.sort(byRank) });
  }
  const allClosed = shown.filter((x) => x.status === 'closed');
  const closed = allClosed.filter((x) => !x.group).sort((a, b) => b.lastActivity - a.lastActivity);
  if (closed.length) sections.push({ id: 'closed', name: `닫힌 세션 (${ctx.closedHours}시간 안)`, kind: 'closed', sessions: closed });

  const recentPaths = new Set();
  for (const s of sessions || []) for (const c of s.changes || []) if (c.path && c.ts >= since) recentPaths.add(c.path);

  // 나를 기다리는 세션: 승인·질문 창이 뜬 세션 + 질문·요청으로 끝나고 쉬는 세션(시간이 지나도 남는다)
  const waiting = live.filter((x) => x.status === 'wait');
  const asking = live.filter((x) => x.status === 'idle' && x.turn === 'ask').sort((a, b) => b.since - a.since);
  const attention = [
    ...waiting.map((x) => {
      const w = words(x.sid);
      const ask = w.question || (w.tool ? `${w.tool.name}${w.tool.text ? ': ' + w.tool.text : ''}` : '');
      return { sid: x.sid, title: x.title, since: x.since, rc: x.rc, agent: x.agent, kind: x.waitingFor === 'permission prompt' ? 'permission' : 'question', text: ask || w.lastLine };
    }),
    ...asking.map((x) => ({ sid: x.sid, title: x.title, since: x.since, rc: x.rc, agent: x.agent, kind: 'turn', text: words(x.sid).lastLine })),
  ];
  // 방금 끝남(30분 안): 내 차례로 올라간 세션은 빼고, 할 일 없다고 한 세션은 흐리게 보이도록 turn을 붙인다
  // 묶음 이름은 세션 목록과 같은 규칙: Watchtower 그룹이 있으면 그룹, 없으면 프로젝트 폴더
  const recent = live
    .filter((x) => x.status === 'idle' && x.turn !== 'ask' && x.since > 0 && now - x.since < RECENT_DONE_MS)
    .sort((a, b) => b.since - a.since).slice(0, 12)
    .map((x) => ({ sid: x.sid, title: x.title, since: x.since, rc: x.rc, text: words(x.sid).lastLine, turn: x.turn, bucket: x.group ? x.group.name : x.project || '(폴더 없음)' }));

  // 질문으로 끝난 채 닫힌 세션(VS Code가 다시 시작돼 꺼진 경우 등): 대기에서 사라지지 않게 따로 모은다
  const closedAsks = allClosed.filter((x) => x.turn === 'ask' && now - x.lastActivity <= ctx.closedHours * 3600e3)
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map((x) => ({ sid: x.sid, title: x.title, since: x.lastActivity, text: words(x.sid).lastLine, bucket: x.group ? x.group.name : x.project || '(폴더 없음)' }));

  const count = { wait: attention.length, work: 0, idle: 0, closed: closed.length };
  for (const x of live) if (x.status === 'work') count.work++; else if (x.status === 'idle' && x.turn !== 'ask') count.idle++;

  return { label: ctx.label, peers: ctx.peers || [], now, win, windows: WINDOWS, scannedAt: ctx.scannedAt || 0, error: ctx.error || null, count, recentFiles: recentPaths.size, attention, closedAsks, recent, sections };
}

// ---------- 세션 하나 ----------

const topCache = new Map();
function gitTop(dir) {
  if (!dir) return null;
  const hit = topCache.get(dir);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.top;
  let top = null;
  try { top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { top = null; }
  topCache.set(dir, { top, at: Date.now() });
  return top;
}

const dirtyCache = new Map();
const samePath = process.platform === 'win32' ? (p) => path.normalize(p).toLowerCase() : (p) => p;
function dirtySet(top) {
  const hit = dirtyCache.get(top);
  if (hit && Date.now() - hit.at < 15000) return hit.set;
  const set = new Set();
  try {
    const out = execFileSync('git', ['-C', top, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8', timeout: 4000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      set.add(samePath(path.join(top, e.slice(3))));
      if (e[0] === 'R' || e[0] === 'C') i++; // 이름 바뀜은 다음 칸이 옛 이름
    }
  } catch { /* git 아님 */ }
  dirtyCache.set(top, { set, at: Date.now() });
  return set;
}

function sessionDetail(s0, ctx) {
  const win = parseWin(ctx.win);
  const s = inWindow(s0, (ctx.now || Date.now()) - win * 60000);
  const gi = groupIndex(ctx.groups);
  const sum = summarize(s, gi, ctx.bridges || new Map());
  const agg = aggregate(s.changes);
  let uncommitted = 0;
  const groups = new Map();
  for (const f of agg.files) {
    const dir = path.dirname(f.path);
    const top = gitTop(dir);
    const dirty = top ? dirtySet(top).has(samePath(f.path)) : false;
    if (dirty) uncommitted++;
    const key = top || dir;
    if (!groups.has(key)) groups.set(key, { dir: tilde(key), git: !!top, files: [] });
    const sub = top ? path.relative(top, dir) : '';
    groups.get(key).files.push({ path: f.path, name: path.basename(f.path), sub: sub === '.' ? '' : sub, add: f.add, del: f.del, ts: f.ts, created: f.created, deleted: f.deleted, committed: f.committed, guessed: f.guessed, dirty, scratch: f.scratch });
  }
  const page = s.file ? T.conversationTail(s.file, ctx.convLimit || 10, true) : { items: [], more: false };
  const conversation = page.items;
  return { ...sum, win, uncommitted, fileGroups: [...groups.values()], conversation, convMore: page.more, commitList: commitList(s.changes) };
}

// 세션이 만든 커밋(기간 안): 커밋 하나에 바뀐 파일·줄 수를 모은다. 최근 것이 위
function commitList(changes) {
  const bySha = new Map();
  for (const c of changes || []) {
    if (c.kind !== 'commit' || !c.sha) continue;
    let k = bySha.get(c.sha);
    if (!k) {
      k = { sha: String(c.sha).slice(0, 8), msg: T.maskSecrets(String(c.msg || '').split('\n')[0]).slice(0, 200), ts: c.ts || 0, repo: c.top ? tilde(c.top) : '', files: [], add: 0, del: 0, unresolved: !!c.unresolved };
      bySha.set(c.sha, k);
    }
    k.ts = Math.max(k.ts, c.ts || 0);
    if (c.path) {
      k.files.push({ path: c.path, name: path.basename(c.path), rel: c.rel || path.basename(c.path), add: c.add || 0, del: c.del || 0 });
      k.add += c.add || 0;
      k.del += c.del || 0;
    }
  }
  return [...bySha.values()].sort((a, b) => b.ts - a.ts).slice(0, 100);
}

module.exports = { WINDOWS, DEFAULT_WIN, parseWin, inWindow, tilde, statusOf, aggregate, groupIndex, readBridges, readJson, summarize, buildState, sessionDetail, commitList };
