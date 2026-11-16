'use strict';
// 다른 컴퓨터의 보드(예: 집 PC)를 이 보드 안에 합쳐 보여 준다.
// 그 보드가 이 서버에 내준 기기 토큰으로 /api/state·/api/session·/api/diff·/api/commit을 대신 물어본다.
// 세션 id 앞에 "<원격 id>~"를 붙여(예: r1~1234-…) 어느 컴퓨터 세션인지 구분하고, 요청을 그쪽으로 넘긴다.

const fs = require('fs');
const path = require('path');

const SEP = '~';
const FRESH_MS = 8000; // 화면 요청이 이 안에 다시 오면 다시 묻지 않는다
const DROP_MS = 5 * 60 * 1000; // 이만큼 못 읽으면 그 컴퓨터 세션은 목록에서 뺀다(오래된 정보로 착각하지 않게)
const MAX_BODY = 8 * 1024 * 1024;

// https만 받는다. 시험용으로 같은 컴퓨터(127.0.0.1)의 http만 예외
function validUrl(u) {
  return typeof u === 'string' && (/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(u) || /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(u));
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadRemotes(stateDir) {
  const d = readJson(path.join(stateDir, 'remotes.json'), { remotes: [] });
  return (Array.isArray(d.remotes) ? d.remotes : []).filter((r) => r && /^r\d{1,3}$/.test(r.id) && typeof r.name === 'string' && r.name.length <= 30 && validUrl(r.url) && typeof r.token === 'string' && r.token.length >= 20 && r.token.length <= 200);
}

function saveRemotes(stateDir, list) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'remotes.json');
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ remotes: list }, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// "r1~abcd" → { id: 'r1', sid: 'abcd' }. 원격 세션이 아니면 null
function splitSid(sid) {
  const i = String(sid || '').indexOf(SEP);
  if (i < 0) return null;
  const id = sid.slice(0, i);
  const rest = sid.slice(i + 1);
  return /^r\d{1,3}$/.test(id) && /^[A-Za-z0-9._:-]{1,100}$/.test(rest) ? { id, sid: rest } : null;
}

function createRemotes(stateDir, opts = {}) {
  const fetchFn = opts.fetch || ((...a) => globalThis.fetch(...a));
  const timeoutMs = opts.timeoutMs || 4000;
  // remotes.json이 바뀌면(`node cli.js link`) 보드를 다시 시작하지 않아도 다음 요청부터 반영한다
  const file = path.join(stateDir, 'remotes.json');
  const mtimeOf = () => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
  let mtime = mtimeOf();
  let all = opts.remotes || loadRemotes(stateDir);
  function current() {
    if (opts.remotes) return all;
    const m = mtimeOf();
    if (m !== mtime) { mtime = m; all = loadRemotes(stateDir); }
    return all;
  }
  const cache = new Map(); // `${id}:${win}` → { at, ok, okAt, data, err }
  const inflight = new Map();

  async function get(r, pathQs) {
    const res = await fetchFn(r.url.replace(/\/$/, '') + pathQs, {
      // X-Board-Peer: 받는 쪽은 이 요청에 자기 원격을 합치지 않는다(서로 합쳐도 끝없이 묻지 않게)
      headers: { Cookie: 'sb=' + encodeURIComponent(r.token), Accept: 'application/json', 'X-Board-Peer': '1' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    if (body.length > MAX_BODY) throw new Error('too large');
    return { status: res.status, body };
  }

  async function refresh(r, win) {
    const key = r.id + ':' + win;
    const old = cache.get(key) || {};
    try {
      const { status, body } = await get(r, '/api/state?win=' + win);
      if (status === 401) throw new Error('토큰이 거절됨(그 컴퓨터에서 기기 연결이 끊김)');
      if (status !== 200) throw new Error('HTTP ' + status);
      const data = JSON.parse(body);
      if (!data || !Array.isArray(data.sections)) throw new Error('모양이 다른 응답');
      cache.set(key, { at: Date.now(), ok: true, okAt: Date.now(), data, err: null });
    } catch (e) {
      cache.set(key, { ...old, at: Date.now(), ok: false, err: String((e && e.message) || e).slice(0, 120) });
    }
  }

  // 화면 요청: 8초 안에 읽은 것이 있으면 그대로, 아니면 새로 묻는다.
  // 예전에 읽은 것이 있으면 기다리지 않고 그것을 주고(뒤에서 갱신), 처음이면 답을 기다린다(최대 timeoutMs)
  async function states(win) {
    return Promise.all(current().map(async (r) => {
      const key = r.id + ':' + win;
      const c = cache.get(key);
      if (!c || Date.now() - c.at >= FRESH_MS) {
        let p = inflight.get(key);
        if (!p) { p = refresh(r, win).finally(() => inflight.delete(key)); inflight.set(key, p); }
        if (!c) await p;
      }
      return { r, c: cache.get(key) };
    }));
  }

  // 세션 하나·바뀐 줄·커밋: 그대로 넘겨 묻고 답을 돌려준다
  async function proxy(id, pathQs) {
    const r = current().find((x) => x.id === id);
    if (!r) return { status: 404, body: JSON.stringify({ error: 'no such remote' }) };
    try {
      return await get(r, pathQs);
    } catch (e) {
      return { status: 502, body: JSON.stringify({ error: (r.name + ' 보드에 닿지 못함: ' + String((e && e.message) || e)).slice(0, 160) }) };
    }
  }

  return { list: () => current().map(({ id, name, url }) => ({ id, name, url })), states, proxy };
}

// 연결 링크(그 서버에서 `node cli.js pair`로 만든 https://…/pair?c=코드)로 다른 보드를 합친다.
// 그 보드가 코드를 받고 열쇠를 돌려주므로 열쇠를 사람이 옮기지 않는다. 같은 주소를 다시 합치면 열쇠만 바꾼다
async function linkRemote(stateDir, link, myLabel, opts = {}) {
  const fetchFn = opts.fetch || ((...a) => globalThis.fetch(...a));
  let u;
  try { u = new URL(String(link || '').trim()); } catch { throw new Error('연결 링크 모양이 아닙니다(https://…/pair?c=코드)'); }
  const origin = u.origin;
  const code = u.searchParams.get('c') || '';
  if (!validUrl(origin) || u.pathname !== '/pair' || !/^[A-Za-z0-9]{6,20}$/.test(code)) throw new Error('연결 링크 모양이 아닙니다(https://…/pair?c=코드)');
  let res;
  try {
    res = await fetchFn(origin + '/api/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: String(myLabel || '').slice(0, 30) }), signal: AbortSignal.timeout(10000) });
  } catch (e) {
    throw new Error('그 서버 보드에 닿지 못했습니다(' + String((e && e.message) || e) + '). 그 서버에서 보드와 tailscale serve가 켜져 있는지 확인하세요');
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 403) throw new Error('코드가 틀렸거나 10분이 지났거나 이미 쓴 코드입니다. 그 서버에서 새 링크를 만드세요');
  if (res.status !== 200 || !/^[A-Za-z0-9_-]{20,200}$/.test(String(body.token || ''))) throw new Error('합치기 실패(HTTP ' + res.status + ')');
  const list = loadRemotes(stateDir);
  const old = list.find((r) => r.url === origin);
  let id = old && old.id;
  if (!id) { let n = 1; while (list.some((r) => r.id === 'r' + n)) n++; id = 'r' + n; }
  const name = String(body.label || u.hostname.split('.')[0]).slice(0, 30);
  saveRemotes(stateDir, [...list.filter((r) => r.url !== origin), { id, name, url: origin, token: body.token }]);
  return { id, name, url: origin, replaced: !!old };
}

// 이 보드 상태(local)에 원격 보드 상태를 합친다. 원격 세션은 sid 앞에 "<id>~", host에 컴퓨터 이름을 붙인다
function mergeState(local, remotes, now = Date.now()) {
  if (!remotes.length) return local;
  const st = {
    ...local,
    sections: local.sections.map((s) => ({ ...s, host: local.label })),
    attention: local.attention.map((a) => ({ ...a, host: local.label })),
    closedAsks: (local.closedAsks || []).map((a) => ({ ...a, host: local.label })),
    recent: (local.recent || []).map((x) => ({ ...x, host: local.label, bucket: local.label + ' · ' + x.bucket })),
    count: { ...local.count },
    recentFilesBy: { [local.label]: local.recentFiles || 0 },
    remotes: [],
  };
  const urls = new Set();
  for (const { r, c } of remotes) {
    urls.add(r.url.replace(/\/$/, ''));
    st.remotes.push({ id: r.id, name: r.name, ok: !!(c && c.ok), okAt: (c && c.okAt) || 0, error: c && !c.ok ? c.err : null });
    const d = c && c.data;
    if (!d || now - (c.okAt || 0) > DROP_MS) continue;
    const tag = (x) => ({ ...x, sid: r.id + SEP + x.sid, host: r.name });
    for (const sec of d.sections || []) st.sections.push({ ...sec, id: r.id + SEP + sec.id, host: r.name, sessions: (sec.sessions || []).map(tag) });
    for (const a of d.attention || []) st.attention.push(tag(a));
    for (const a of d.closedAsks || []) st.closedAsks.push(tag(a));
    for (const x of d.recent || []) st.recent.push({ ...tag(x), bucket: r.name + ' · ' + x.bucket });
    for (const k of ['work', 'idle', 'closed']) st.count[k] = (st.count[k] || 0) + ((d.count && d.count[k]) || 0);
    st.recentFiles = (st.recentFiles || 0) + (d.recentFiles || 0);
    st.recentFilesBy[r.name] = d.recentFiles || 0;
  }
  st.count.wait = st.attention.length;
  st.recent.sort((a, b) => b.since - a.since);
  st.closedAsks.sort((a, b) => b.since - a.since);
  // 합쳐 보이는 보드로 가는 "서버 고르기" 단추는 뺀다(같은 내용이 이미 이 화면에 있음)
  st.peers = (local.peers || []).filter((p) => !urls.has(String(p.url).replace(/\/$/, '')));
  return st;
}

module.exports = { createRemotes, mergeState, splitSid, loadRemotes, saveRemotes, validUrl, linkRemote, SEP };
