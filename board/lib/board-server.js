'use strict';
// 휴대폰 세션 보드 서버. 읽기 전용이다: 세션에 말을 보내거나 파일을 바꾸는 길은 없다.
// (POST는 이 기기의 알림 켜기·끄기·시험, 다른 서버 보드의 합치기 요청뿐이다)
// 기본은 127.0.0.1에만 열고, 밖에서는 tailscale serve(https)를 거쳐 들어온다.
// 명령줄(server.js)과 VS Code 확장(Session Watchtower에 합칠 때) 양쪽에서 쓰도록 함수 하나로 묶었다.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const T = require('./transcript');
const B = require('./board');
const C = require('./commits');
const { createStore } = require('./auth');
const { createPush, createNotifier } = require('./push');
const { createRemotes, mergeState, splitSid, linkRemote } = require('./remotes');
const { discover } = require('./discover');
const I18N = require('./i18n');

const PUBLIC = path.join(__dirname, '..', 'public');

// cfg: lib/config.js의 loadConfig() 결과. opts.log: { info, error } (기본 console), opts.feed: 아래 "읽어 둔 상태" 참고, opts.scanner: scanner.js 모듈
function createBoardServer(cfg, opts = {}) {
  const log = opts.log || console;
  // 확장에 넣을 때는 확장이 가진 scanner.js(정본)를 넘긴다. 없으면 vendor 복사본
  const scanner = opts.scanner || require('../vendor/scanner');
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const store = createStore(cfg.stateDir);
  const push = createPush(cfg.stateDir, { subject: cfg.pushSubject });
  const notifier = createNotifier({ delayMs: cfg.pushDelayS * 1000 });
  // 합쳐 보여 줄 다른 컴퓨터 보드(stateDir/remotes.json, `node cli.js remote-add`로 넣음)
  const remotes = opts.remotes || createRemotes(cfg.stateDir);
  let lastPush = { kind: null, at: 0 };

  // ---------- 읽어 둔 상태 ----------

  let latest = { sessions: [], at: 0, error: null };
  function onScan(m) {
    if (m.error) latest = { ...latest, error: m.error };
    else { latest = { sessions: m.sessions, at: m.at || Date.now(), error: null }; checkPush(); }
  }
  // opts.feed가 있으면(확장이 이미 세션을 읽고 있을 때) 그 결과를 받아 쓰고, 없으면 읽기 스레드를 따로 띄운다.
  // feed(cb): 읽을 때마다 cb({ sessions, at }) 또는 cb({ error })를 부르는 함수
  // feed가 바로(같은 순간에) 부르더라도 아래 준비(그룹 파일 읽기 등)가 끝난 뒤에 받도록 한 박자 미룬다
  let worker = null;
  let closing = false;
  let restartMs = 5000;
  function startWorker() {
    worker = new Worker(path.join(__dirname, 'scan-worker.js'), { workerData: cfg });
    worker.on('message', (m) => { restartMs = 5000; onScan(m); });
    worker.on('error', (e) => { latest = { ...latest, error: String((e && e.message) || e) }; log.error('scan worker error', e); });
    // 읽기 스레드가 죽으면(메모리 부족 등) 다시 띄운다. 그대로 두면 세션 목록과 휴대폰 알림이 소리 없이 멈춘다
    worker.on('exit', (code) => {
      if (closing) return;
      log.error(`scan worker exited (${code}); restarting in ${restartMs / 1000}s`);
      setTimeout(() => { if (!closing) startWorker(); }, restartMs).unref();
      restartMs = Math.min(restartMs * 2, 5 * 60 * 1000);
    });
  }
  if (typeof opts.feed === 'function') opts.feed((m) => queueMicrotask(() => onScan(m)));
  else startWorker();

  function memoJson(file) {
    let memo = { mtimeMs: -1, data: null };
    return () => {
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs !== memo.mtimeMs) memo = { mtimeMs: st.mtimeMs, data: B.readJson(file, null) };
      } catch { memo = { mtimeMs: -1, data: null }; }
      return memo.data;
    };
  }
  const groups = memoJson(cfg.groupsFile);
  const archive = memoJson(cfg.archiveFile);

  // 마지막 말은 기록 파일이 바뀔 때만 다시 읽는다
  const wordsCache = new Map();
  function lastWords(file) {
    let key = '';
    try { const st = fs.statSync(file); key = st.size + ':' + st.mtimeMs; } catch { return { question: '', tool: null, lastLine: '' }; }
    const hit = wordsCache.get(file);
    if (hit && hit.key === key) return hit.value;
    const value = T.lastWords(file);
    wordsCache.set(file, { key, value });
    if (wordsCache.size > 200) wordsCache.delete(wordsCache.keys().next().value);
    return value;
  }

  function ctx() {
    return { now: Date.now(), groups: groups(), archive: archive(), bridges: B.readBridges(cfg.registryDir), closedHours: cfg.closedHours, label: cfg.label, peers: cfg.peers, scannedAt: latest.at, error: latest.error, lastWords };
  }

  // ---------- 휴대폰 알림 ----------
  // 읽을 때마다 대기 목록을 보고, 새 대기가 delay 동안 그대로면 구독한 기기에 내용 없는 알림을 보낸다
  // 합친 상태(이 컴퓨터 + 다른 컴퓨터 보드)
  function fullState(win, localOnly) {
    const local = B.buildState(latest.sessions, { ...ctx(), win });
    if (localOnly || !remotes.list().length) return Promise.resolve(local);
    return remotes.states(win).then((rs) => mergeState(local, rs), () => local);
  }
  // 다른 컴퓨터 대기도 함께 본다(그 컴퓨터 보드를 10초마다 읽는 일도 겸함)
  function checkPush() {
    if (!cfg.pushDelayS && !remotes.list().length) return;
    fullState(B.parseWin(null)).then((st) => {
      if (!cfg.pushDelayS) return;
      const keys = new Set(st.attention.map((a) => a.sid + ':' + a.since));
      if (notifier.step(keys) && push.list().length) firePush('wait');
    }).catch((e) => log.error('push check failed', e));
  }
  function firePush(kind, only) {
    lastPush = { kind, at: Date.now() };
    const live = new Set(store.devices().map((d) => d.id));
    return push.sendAll(live, only).then((r) => {
      log.info(`push ${kind}: ${r.results.map((x) => x.host + ' ' + x.status).join(', ') || '보낼 곳 없음'}${r.removed ? ` (구독 ${r.removed}개 지움)` : ''}`);
      return r;
    }).catch((e) => { log.error('push failed', e); return { results: [], removed: 0 }; });
  }

  // ---------- HTTP 도우미 ----------

  const SEC_HEADERS = {
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };

  function send(res, code, body, type, extra) {
    res.writeHead(code, { ...SEC_HEADERS, 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...(extra || {}) });
    res.end(body);
  }

  function json(res, code, data) {
    send(res, code, JSON.stringify(data), 'application/json; charset=utf-8');
  }

  function cookieToken(req) {
    const h = req.headers.cookie || '';
    for (const part of h.split(';')) {
      const i = part.indexOf('=');
      // 깨진 쿠키(%zz 등)는 없는 것으로 본다(예외가 나면 모든 화면이 500이 되어 다시 연결도 못 한다)
      if (i > 0 && part.slice(0, i).trim() === 'sb') { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; } }
    }
    return null;
  }

  function authed(req) {
    return store.checkToken(cookieToken(req));
  }

  function isHttps(req) {
    return cfg.secureCookie || req.headers['x-forwarded-proto'] === 'https';
  }

  // 짝짓기 시도 제한: 10분에 20번
  let pairTries = [];
  function pairAllowed() {
    const now = Date.now();
    pairTries = pairTries.filter((t) => now - t < 10 * 60 * 1000);
    if (pairTries.length >= 20) return false;
    pairTries.push(now);
    return true;
  }

  const STATIC = {
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/app.css': ['app.css', 'text/css; charset=utf-8'],
    '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
    '/icon.svg': ['icon.svg', 'image/svg+xml'],
    '/icon-192.png': ['icon-192.png', 'image/png'],
    '/badge-96.png': ['badge-96.png', 'image/png'],
    '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  };

  // POST 본문(JSON, 4KB까지)
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > 4096) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
      req.on('error', reject);
    });
  }

  // 다른 사이트가 이 기기 쿠키로 POST를 보내지 못하게: 같은 사이트 요청 + JSON만 받는다
  function samePost(req) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return false;
    return String(req.headers['content-type'] || '').startsWith('application/json');
  }

  // 다른 서버 보드가 이 보드를 합칠 때: 연결 코드(휴대폰 연결과 같은 일회용 코드)를 받고 열쇠(기기 토큰)를 돌려준다.
  // 코드가 곧 허락이므로 쿠키 없이 받는다. 시도 수는 휴대폰 연결과 같이 10분 20번까지
  async function handleLink(req, res) {
    if (!pairAllowed()) return json(res, 429, { error: 'too many tries' });
    if (!samePost(req)) return json(res, 403, { error: 'json only' });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
    const code = String(body.code || '');
    if (!/^[A-Za-z0-9]{6,20}$/.test(code) || !store.consumePairCode(code)) return json(res, 403, { error: 'bad code' });
    const name = String(body.name || 'board').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 30) || 'board';
    const token = store.issueDevice('peer: ' + name);
    log.info(`link: "${name}" 보드가 이 보드를 합쳤습니다`);
    return json(res, 200, { token, label: cfg.label });
  }

  // 주변 찾기: 사설망 기기 중 보드가 켜진 것. 30초 동안은 다시 찾지 않는다
  let found = { at: 0, data: null, inflight: null };
  function findBoards(fresh) {
    if (!fresh && found.data && Date.now() - found.at < 30000) return Promise.resolve(found.data);
    if (!found.inflight) {
      found.inflight = (opts.discover || discover)({ linked: remotes.list() })
        .then((d) => { found = { at: Date.now(), data: d, inflight: null }; return d; })
        .catch((e) => { found.inflight = null; throw e; });
    }
    return found.inflight;
  }
  // 찾은 보드에 코드로 붙이기(휴대폰에서). 주소는 방금 찾은 목록에 있는 보드만 받는다(아무 주소로나 요청하지 않게)
  async function handleRemoteLink(req, res) {
    if (!samePost(req)) return json(res, 403, { error: 'same-origin json only' });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
    const target = found.data && found.data.devices.find((x) => x.board && x.url === body.url);
    if (!target) return json(res, 404, { error: I18N.tr(I18N.langOf(req), '찾은 목록에 없는 주소입니다. 다시 찾기를 눌러 주세요') });
    let code = String(body.code || '').trim();
    const inLink = /[?&]c=([A-Za-z0-9]{6,20})/.exec(code);
    if (inLink) code = inLink[1];
    code = code.replace(/[\s-]/g, '');
    if (!/^[A-Za-z0-9]{6,20}$/.test(code)) return json(res, 400, { error: I18N.tr(I18N.langOf(req), '코드 모양이 아닙니다') });
    try {
      const r = await linkRemote(cfg.stateDir, target.url + '/pair?c=' + code, cfg.label, { fetch: opts.fetch });
      found.at = 0; // 붙인 표시가 바로 보이게 다음 찾기는 새로
      log.info(`remote-link: ${r.name} (${r.url}) 합침`);
      return json(res, 200, { id: r.id, name: r.name, replaced: r.replaced });
    } catch (e) {
      return json(res, 400, { error: I18N.tr(I18N.langOf(req), String((e && e.message) || e)) });
    }
  }

  async function handlePushPost(req, res, p, dev) {
    if (!samePost(req)) return json(res, 403, { error: 'same-origin json only' });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
    if (p === '/api/push/subscribe') {
      return push.subscribe(dev, body.endpoint) ? json(res, 200, { ok: true }) : json(res, 400, { error: 'unsupported push service' });
    }
    if (p === '/api/push/unsubscribe') return json(res, 200, { removed: push.unsubscribe(dev, typeof body.endpoint === 'string' ? body.endpoint : null) });
    if (p === '/api/push/test') {
      if (!push.list().some((s) => s.deviceId === dev)) return json(res, 409, { error: 'this device is not subscribed' });
      const r = await firePush('test', dev);
      return json(res, 200, { statuses: r.results.map((x) => x.status) });
    }
    return json(res, 404, { error: 'no such action' });
  }

  // withForm: 연결 코드 입력칸을 붙인다. 아이폰 홈 화면 앱처럼 주소줄이 없는 곳에서도 코드만 쳐서 연결하게
  // lang: 'ko' | 'en'(lib/i18n.js의 langOf). 글은 한국어로 넘기고 여기서 그 언어로 바꾼다
  function page(lang, title, msg, withForm) {
    const L = (ko) => I18N.tr(lang, ko);
    title = L(title);
    msg = L(msg);
    const form = withForm ? `<form class="codeform" method="get" action="/pair"><label for="c">${L('연결 코드 (링크를 통째로 붙여 넣어도 됩니다)')}</label><input id="c" name="c" required autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="300" placeholder="${L('예: K7Q2XPMB4D')}"><button type="submit">${L('연결')}</button></form>` : '';
    return `<!doctype html><html lang="${lang === 'en' ? 'en' : 'ko'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><script src="/theme.js"></script><link rel="stylesheet" href="/app.css"></head><body class="plain"><main class="msgpage"><h1>${title}</h1><p>${msg}</p>${form}</main></body></html>`;
  }
  // 코드 입력칸이 있는 쪽만 같은 주소(/pair)로 보내는 것을 허락한다(나머지 화면은 form-action 'none' 그대로)
  const FORM_CSP = { 'Content-Security-Policy': SEC_HEADERS['Content-Security-Policy'].replace("form-action 'none'", "form-action 'self'") };

  // ---------- 요청 처리 ----------

  function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const pushPost = req.method === 'POST' && p.startsWith('/api/push/');
    const linkPost = req.method === 'POST' && p === '/api/link';
    const remoteLinkPost = req.method === 'POST' && p === '/api/remote-link';
    if (req.method !== 'GET' && req.method !== 'HEAD' && !pushPost && !linkPost && !remoteLinkPost) return send(res, 405, 'GET만 받습니다');
    if (linkPost) return void handleLink(req, res).catch((e) => { log.error(e); if (!res.headersSent) json(res, 500, { error: 'server error' }); });

    // 다른 보드가 사설망에서 보드를 찾을 때 알아보도록 표시와 이름을 붙인다(같은 사설망 기기만 닿음)
    if (p === '/healthz') return send(res, 200, 'ok', null, { 'X-Session-Board': '1', 'X-Session-Board-Label': encodeURIComponent(cfg.label) });

    // 앱 이름(홈 화면에 붙일 때 쓰는 이름)은 언어에 맞춘다
    if (p === '/manifest.webmanifest') {
      return fs.readFile(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8', (err, text) => {
        if (err) return send(res, 404, '없음');
        let body = text;
        if (I18N.langOf(req) === 'en') {
          try { body = JSON.stringify({ ...JSON.parse(text), name: 'Session Board', short_name: 'Session Board', lang: 'en' }, null, 2); } catch { /* 원본 그대로 */ }
        }
        return send(res, 200, body, 'application/manifest+json', { 'Cache-Control': 'no-cache', Vary: 'Accept-Language, Cookie' });
      });
    }
    if (STATIC[p]) {
      const [f, type] = STATIC[p];
      return fs.readFile(path.join(PUBLIC, f), (err, buf) => (err ? send(res, 404, '없음') : send(res, 200, buf, type, { 'Cache-Control': 'no-cache' })));
    }

    if (p === '/pair') {
      if (!pairAllowed()) return send(res, 429, page(I18N.langOf(req), '잠시 뒤에 다시', '시도가 너무 많습니다. 10분 뒤에 새 코드로 다시 해 주세요.'), 'text/html; charset=utf-8');
      // 입력칸에 링크 통째(https://…/pair?c=코드)나 띄어 쓴 코드를 넣어도 코드만 꺼낸다
      let code = String(url.searchParams.get('c') || '').trim();
      const inLink = /[?&]c=([A-Za-z0-9]{6,20})/.exec(code);
      if (inLink) code = inLink[1];
      code = code.replace(/[\s-]/g, '');
      // 안드로이드 앱 안 브라우저(WebView, 사용자 에이전트에 "; wv)")에서 열면 연결이 그 앱 안에만 남아 Chrome에서는 다시 막힌다.
      // 일회용 코드를 쓰지 않고 Chrome에서 열라고 안내한다(11-13 휴대폰에서 실제로 겪음)
      if (/; wv\)/.test(String(req.headers['user-agent'] || ''))) {
        return send(res, 200, page(I18N.langOf(req), 'Chrome에서 열어 주세요', '앱 안의 브라우저에서는 연결이 Chrome에 저장되지 않습니다. 이 주소를 복사해 Chrome 주소창에 붙여 넣어 열어 주세요. 코드는 아직 쓰지 않았으니 같은 링크를 그대로 쓰면 됩니다.'), 'text/html; charset=utf-8');
      }
      if (!/^[A-Za-z0-9]{6,20}$/.test(code) || !store.consumePairCode(code)) {
        return send(res, 403, page(I18N.langOf(req), '연결 코드가 맞지 않습니다', '코드가 틀렸거나 10분이 지났거나 이미 쓴 코드입니다. 서버에서 <code>node cli.js pair</code>로 새 코드를 받아 아래에 넣어 주세요.', true), 'text/html; charset=utf-8', FORM_CSP);
      }
      const ua = String(req.headers['user-agent'] || '').slice(0, 120);
      const token = store.issueDevice(ua);
      const cookie = `sb=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${180 * 86400}${isHttps(req) ? '; Secure' : ''}`;
      return send(res, 302, '', 'text/plain', { 'Set-Cookie': cookie, Location: '/' });
    }

    const dev = authed(req);

    if (p === '/' || p === '/index.html') {
      if (!dev) return send(res, 401, page(I18N.langOf(req), '연결이 필요합니다', '이 기기는 아직 연결되지 않았습니다. 서버에서 <code>node cli.js pair</code>로 받은 링크를 이 기기에서 열거나, 거기 나온 코드를 아래에 넣어 주세요. VS Code를 쓰면 Session Watchtower 확장의 휴대폰 단추로도 연결 링크·QR·코드를 만들 수 있습니다.', true), 'text/html; charset=utf-8', FORM_CSP);
      // 첫 글자(제목·불러오는 중)도 언어에 맞춘다. 나머지 글은 app.js가 고른다
      return fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8', (err, html) => {
        if (err) return send(res, 500, '화면 파일 없음');
        if (I18N.langOf(req) === 'en') html = html.replace('<html lang="ko">', '<html lang="en">').replace('<title>세션 보드</title>', '<title>Session Board</title>').replace('불러오는 중…', 'Loading…');
        return send(res, 200, html, 'text/html; charset=utf-8', { Vary: 'Accept-Language, Cookie' });
      });
    }

    if (!p.startsWith('/api/')) return send(res, 404, '없음');
    if (!dev) return json(res, 401, { error: 'unauthorized' });

    if (pushPost) return void handlePushPost(req, res, p, dev).catch((e) => { log.error(e); if (!res.headersSent) json(res, 500, { error: 'server error' }); });
    if (p === '/api/discover') {
      findBoards(url.searchParams.get('fresh') === '1').then((r) => json(res, 200, r)).catch((e) => json(res, 503, { error: I18N.tr(I18N.langOf(req), String((e && e.message) || e)) }));
      return;
    }
    if (remoteLinkPost) return void handleRemoteLink(req, res).catch((e) => { log.error(e); if (!res.headersSent) json(res, 500, { error: 'server error' }); });
    if (p === '/api/push/key') return json(res, 200, { key: push.publicKey(), enabled: cfg.pushDelayS > 0, delayS: cfg.pushDelayS });
    if (p === '/api/push/status') return json(res, 200, { subscribed: push.list().filter((s) => s.deviceId === dev).length });
    // sw.js가 알림 글자를 고를 때 본다: 방금 보낸 것이 시험인지 진짜 대기인지
    if (p === '/api/push/last') return json(res, 200, lastPush);

    const win = B.parseWin(url.searchParams.get('win'));
    if (p === '/api/state') {
      fullState(win, req.headers['x-board-peer'] === '1').then((st) => json(res, 200, st)).catch((e) => { log.error(e); if (!res.headersSent) json(res, 500, { error: 'server error' }); });
      return;
    }

    const sid = url.searchParams.get('sid') || '';
    // 다른 컴퓨터 세션(r1~…): 그 컴퓨터 보드에 그대로 넘겨 묻는다. 경로·커밋 확인은 그쪽 보드가 한다
    const far = splitSid(sid);
    if (far && ['/api/session', '/api/diff', '/api/commit'].includes(p)) {
      const q = new URLSearchParams({ sid: far.sid });
      for (const k of ['win', 'n', 'path', 'sha']) if (url.searchParams.has(k)) q.set(k, url.searchParams.get(k));
      remotes.proxy(far.id, p + '?' + q.toString()).then(({ status, body }) => {
        if (p === '/api/session' && status === 200) {
          try {
            const dt = JSON.parse(body);
            const r = remotes.list().find((x) => x.id === far.id);
            return json(res, 200, { ...dt, sid, host: r ? r.name : '' });
          } catch { return json(res, 502, { error: 'bad remote response' }); }
        }
        // 그 컴퓨터가 이 보드의 열쇠를 거절한 401은 그대로 넘기지 않는다: 휴대폰은 401을 "이 기기 연결 끊김"으로 알고 새로고침을 되풀이한다
        if (status === 401) return json(res, 502, { error: 'remote board refused this board (reconnect it)' });
        return send(res, status, body, 'application/json; charset=utf-8');
      }).catch((e) => { log.error(e); if (!res.headersSent) json(res, 502, { error: 'remote failed' }); });
      return;
    }
    const s = latest.sessions.find((x) => x.sid === sid);
    if (!s) return json(res, 404, { error: 'no such session' });

    // 대화는 최근 n개(말 기준)만: 기본 10, "이전 대화 더 보기"로 늘림(최대 200)
    const n = Math.min(200, Math.max(5, Number(url.searchParams.get('n')) || 10));
    if (p === '/api/session') return json(res, 200, B.sessionDetail(s, { ...ctx(), win, convLimit: n }));

    if (p === '/api/diff') {
      // 경로는 이 세션의 변경 목록에 있는 것만 받는다(아무 파일이나 읽지 않게)
      const fp = url.searchParams.get('path') || '';
      const since = Date.now() - win * 60000;
      const changes = (s.changes || []).filter((c) => c.path === fp && (c.ts || 0) >= since);
      if (!fp || !changes.length) return json(res, 404, { error: 'no such file in this session (in this period)' });
      return json(res, 200, { path: B.tilde(fp), ...T.diffFor(changes, scanner) });
    }

    if (p === '/api/commit') {
      // 커밋 번호는 이 세션이 만든 커밋(변경 기록) 안의 것만 받는다. 저장소 위치도 그 기록에서 가져온다
      const want = String(url.searchParams.get('sha') || '');
      if (!/^[0-9a-f]{7,40}$/.test(want)) return json(res, 400, { error: 'bad sha' });
      const c = (s.changes || []).find((x) => x.kind === 'commit' && x.sha && x.top && String(x.sha).startsWith(want));
      if (!c) return json(res, 404, { error: 'no such commit in this session' });
      try {
        return json(res, 200, { repo: B.tilde(c.top), ...C.commitDetail(c.top, String(c.sha)) });
      } catch {
        return json(res, 500, { error: 'git show failed' });
      }
    }

    return send(res, 404, '없음');
  }

  const server = http.createServer((req, res) => {
    try { handle(req, res); } catch (e) { log.error(e); if (!res.headersSent) json(res, 500, { error: 'server error' }); }
  });

  // 지금 떠 있는 이 보드의 포트·이름을 stateDir/run.json에 적는다(Watchtower가 포트를 훑지 않고 이 보드 하나만 찾게).
  // VS Code 원격 창이 다른 서버 보드를 같은 포트로 전달해 둔 컴퓨터에서도 "이 폴더의 보드"를 정확히 찾는다. 꺼지면 지운다
  const runFile = path.join(cfg.stateDir, 'run.json');
  function writeRun(port) {
    try {
      fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
      const tmp = runFile + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify({ port, label: cfg.label, pid: process.pid, at: Date.now() }), { mode: 0o600 });
      fs.renameSync(tmp, runFile);
    } catch (e) { log.error('run.json write failed', e); }
  }
  function removeRun() {
    try {
      const r = JSON.parse(fs.readFileSync(runFile, 'utf8'));
      if (r.pid === process.pid) fs.unlinkSync(runFile); // 다른 프로세스가 새로 쓴 것은 지우지 않는다
    } catch { /* 없음 */ }
  }

  return {
    store,
    push,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, () => {
          const addr = server.address();
          log.info(`session-board: http://${cfg.host}:${addr.port} (${cfg.label})`);
          writeRun(addr.port);
          resolve(addr);
        });
      });
    },
    // 확장을 끌 때도 쓰므로 열린 연결까지 닫고 읽기 스레드를 멈춘다
    close() {
      closing = true;
      if (worker) worker.terminate();
      removeRun();
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (server.closeAllConnections) server.closeAllConnections();
      });
    },
  };
}

module.exports = { createBoardServer };
