'use strict';
// 휴대폰 세션 보드 화면. 서버가 준 글은 모두 textContent로만 넣는다(HTML로 해석하지 않는다).

(function () {
  // ---------- 언어 ----------
  // 브라우저 언어가 한국어면 한국어, 그 밖이면 영어. 설정에서 고르면(자동·한국어·English) 쿠키 sb_lang에 적는다.
  // 쿠키 하나만 쓰는 까닭: 서버 안내 글(연결 화면·오류)도 같은 언어로 나오게 서버가 함께 읽는다.
  // 화면 글은 한국어 원문을 열쇠로 맨 아래 enTable()에서 찾는다. 없으면 한국어 그대로
  let LANG_PREF = 'auto';
  { const m = /(?:^|;\s*)sb_lang=(ko|en)(?:;|$)/.exec(document.cookie || ''); if (m) LANG_PREF = m[1]; }
  const LANG = LANG_PREF !== 'auto' ? LANG_PREF : /^ko\b/i.test((navigator.languages && navigator.languages[0]) || navigator.language || '') ? 'ko' : 'en';
  const DICT = LANG === 'en' ? enTable() : null;
  // t('대기 {0}', 3): {0}·{1} 자리에 값을 넣는다. '전체 보기#back'처럼 # 뒤는 같은 한국어를 다른 뜻으로 쓸 때 가르는 꼬리표(화면에는 안 나옴)
  function t(ko, ...args) {
    let s = DICT && DICT[ko] != null ? DICT[ko] : ko.split('#')[0];
    if (args.length) s = s.replace(/\{(\d)\}/g, (m, i) => (args[i] != null ? String(args[i]) : m));
    return s;
  }
  // 서버가 만든 글 가운데 정해진 것(묶음 이름·안내 문장·가림 표시·사진 표시)만 바꾼다. 세션 제목·대화 내용은 그대로
  const DATA_EN = {
    '새 파일': 'new file',
    '명령으로 바뀐 파일이라 줄 기록이 없습니다.': 'Changed by a command, so no line changes were recorded.',
    '바뀐 줄 기록이 없습니다.': 'No line changes recorded.',
    '토큰이 거절됨(그 컴퓨터에서 기기 연결이 끊김)': 'token refused (that computer disconnected this board)',
    '모양이 다른 응답': 'unexpected response',
  };
  function tr(s) {
    if (!DICT || typeof s !== 'string' || !s) return s;
    if (DATA_EN[s]) return DATA_EN[s];
    return s.replace(/닫힌 세션 \((\d+)시간 안\)/g, 'Closed sessions (last $1 h)')
      .replace(/\(폴더 없음\)/g, '(no folder)')
      .replace(/\(임시 작업 폴더\)/g, '(temp work folder)')
      .replace(/●●●●●● \(가림\)/g, '●●●●●● (hidden)')
      .replace(/\[사진 (\d+)장\]/g, (m, n) => '[' + n + (n === '1' ? ' photo]' : ' photos]'));
  }
  function syncLangCookie() {
    const sec = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = LANG_PREF === 'auto' ? 'sb_lang=; Path=/; Max-Age=0; SameSite=Lax' + sec : 'sb_lang=' + LANG_PREF + '; Path=/; Max-Age=31536000; SameSite=Lax' + sec;
  }

  const S = {
    data: null, sel: null, tab: 'conv', detail: null, open: null, diffs: new Map(), more: new Set(), scrolled: null, win: 1440,
    failed: false, lastOk: 0, stateText: '', detailText: '',
    holdUntil: 0, pending: false, seenWait: null, newWait: 0, listY: null, stateKey: '', convN: 10, loadingMore: false,
  };
  const WIN_LABEL = { 30: t('30분'), 60: t('1시간'), 180: t('3시간'), 720: t('12시간'), 1440: t('24시간') };
  const NARROW = window.matchMedia('(max-width: 699px)');
  // 바뀐 파일을 보는 기간은 이 기기에만 기억한다(저장이 막힌 브라우저면 24시간)
  try { const w = Number(localStorage.getItem('sb.win')); if (WIN_LABEL[w]) S.win = w; } catch { /* 무시 */ }
  // 접어 둔 묶음(세션 목록·방금 끝남). 처음에는 닫힌 세션만 접는다. 이 기기에만 기억한다
  S.fold = new Set(['closed']);
  try { const f = JSON.parse(localStorage.getItem('sb.fold') || 'null'); if (Array.isArray(f)) S.fold = new Set(f.map(String).slice(0, 200)); } catch { /* 무시 */ }
  // '닫힌 채 남은 질문'·'오래된 대기'는 처음엔 접어 둔다(목록을 밀어내지 않게). 한 번 펼치면 그대로 기억
  for (const id of ['closedask', 'oldwait']) if (!S.fold.has(id + ':init')) { S.fold.add(id); S.fold.add(id + ':init'); }
  try { localStorage.setItem('sb.fold', JSON.stringify([...S.fold])); } catch { /* 무시 */ }
  S.rcHintOff = false;
  try { S.rcHintOff = localStorage.getItem('sb.rchint') === 'off'; } catch { /* 무시 */ }

  // 숨긴 대기 카드: "세션:기다리기 시작한 시각" 단위로 이 기기에만 기억한다.
  // 같은 세션이 다시 일하고 새로 물으면 시각이 바뀌어 카드가 다시 나온다
  S.dismissed = new Set();
  try { const x = JSON.parse(localStorage.getItem('sb.dismiss') || 'null'); if (Array.isArray(x)) S.dismissed = new Set(x.map(String).slice(0, 200)); } catch { /* 무시 */ }
  const waitKey = (a) => a.sid + ':' + a.since;
  function saveDismissed() {
    try { localStorage.setItem('sb.dismiss', JSON.stringify([...S.dismissed])); } catch { /* 무시 */ }
  }
  // 읽음 표시: 세션마다 "마지막으로 이 보드에서 본 때의 마지막 대화 시각"을 이 기기에만 적어 둔다.
  // 처음 쓰는 기기는 지금 보이는 세션을 모두 읽음으로 치고 시작한다(첫 화면이 점투성이가 되지 않게)
  S.seen = null;
  try { const x = JSON.parse(localStorage.getItem('sb.seen') || 'null'); if (x && typeof x === 'object' && !Array.isArray(x)) S.seen = x; } catch { /* 무시 */ }
  function saveSeen() {
    try { localStorage.setItem('sb.seen', JSON.stringify(S.seen)); } catch { /* 무시 */ }
  }
  const allSessions = (d) => d.sections.flatMap((x) => x.sessions);
  function markSeen(sid, list) {
    const x = list.find((y) => y.sid === sid);
    if (!x || (S.seen[sid] || 0) >= (x.lastActivity || 0)) return false;
    S.seen[sid] = x.lastActivity || 0;
    return true;
  }
  function syncSeen(d) {
    const list = allSessions(d);
    if (!S.seen) {
      S.seen = {};
      for (const x of list) S.seen[x.sid] = x.lastActivity || 0;
      saveSeen();
      return;
    }
    let changed = S.sel ? markSeen(S.sel, list) : false;
    // 지금 목록에 없고 보름 넘은 기록만 지운다(그룹 세션은 오래돼도 목록에 남으므로 지우면 안 됨)
    const cut = d.now - 15 * 864e5;
    const live = new Set(list.map((x) => x.sid));
    for (const [k, v] of Object.entries(S.seen)) if (!live.has(k) && !(v >= cut)) { delete S.seen[k]; changed = true; }
    if (changed) saveSeen();
  }
  // 작업 중인 세션은 계속 바뀌므로 점을 찍지 않는다. 끝나고(쉼·대기·닫힘) 새 말이 있으면 찍는다
  function unread(x) {
    if (!S.seen || x.sid === S.sel || x.status === 'work') return false;
    return (x.lastActivity || 0) > (S.seen[x.sid] || 0);
  }
  function seenAll(d) {
    for (const x of allSessions(d)) if (x.status !== 'work') S.seen[x.sid] = Math.max(S.seen[x.sid] || 0, x.lastActivity || 0);
    saveSeen();
    render();
  }
  function unreadDot() {
    const n = el('span', 'nd');
    n.setAttribute('role', 'img');
    n.setAttribute('aria-label', t('새 내용'));
    return n;
  }
  // 12시간 넘게 기다린 카드는 맨 위가 아니라 '오래된 대기'로 모은다(숫자·배지에도 넣지 않음)
  const OLD_WAIT_MS = 12 * 3600e3;
  function freshWaits(d) {
    return visibleWaits(d).filter((a) => (d.now || Date.now()) - a.since < OLD_WAIT_MS);
  }
  function visibleWaits(d) {
    return (d.attention || []).filter((a) => !S.dismissed.has(waitKey(a)));
  }
  // 지금 대기 목록에 없는 숨김 기록은 지운다(답했거나 세션이 닫힘)
  function pruneDismissed(d) {
    const live = new Set([...(d.attention || []), ...(d.closedAsks || [])].map(waitKey));
    let changed = false;
    for (const k of [...S.dismissed]) if (!live.has(k)) { S.dismissed.delete(k); changed = true; }
    if (changed) saveDismissed();
  }

  // 숨긴 직후 6초 동안만 "숨겼습니다 · 되돌리기" 알림을 띄운다(화면 아래, 다시 그리기와 상관없이 유지)
  const $toast = document.createElement('div');
  $toast.id = 'toast';
  $toast.setAttribute('role', 'status');
  document.body.appendChild($toast);
  let toastTimer = 0;
  function showToast(text, undo) {
    clearTimeout(toastTimer);
    $toast.textContent = '';
    add($toast, el('span', '', text));
    if (undo) {
      const b = el('button', 'lnk', t('되돌리기'));
      b.type = 'button';
      b.addEventListener('click', () => { clearTimeout(toastTimer); $toast.className = ''; undo(); });
      add($toast, b);
    }
    $toast.className = 'show';
    toastTimer = setTimeout(() => { $toast.className = ''; }, 6000);
  }
  function hideWaits(list, d) {
    const keys = list.map(waitKey);
    for (const k of keys) S.dismissed.add(k);
    saveDismissed();
    S.seenWait = new Set(visibleWaits(d).map((v) => v.sid));
    render();
    showToast(list.length > 1 ? t('대기 카드 {0}개를 숨겼습니다', list.length) : t('대기 카드를 숨겼습니다'), () => {
      for (const k of keys) S.dismissed.delete(k);
      saveDismissed();
      S.seenWait = new Set((S.data.attention || []).map((v) => v.sid));
      render();
    });
  }
  function unhideAll(d) {
    for (const a of [...d.attention, ...(d.closedAsks || [])]) S.dismissed.delete(waitKey(a));
    saveDismissed();
    S.seenWait = new Set(d.attention.map((v) => v.sid));
    render();
  }

  const $top = document.getElementById('top');
  const $app = document.getElementById('app');
  const $banner = document.createElement('div');
  $banner.id = 'banner';
  $top.after($banner);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function add(parent, ...kids) { for (const k of kids) if (k) parent.appendChild(k); return parent; }

  // 그린 아이콘(한 가지 선 굵기). 글자 기호·이모지를 아이콘 대신 쓰지 않는다
  const ICONS = {
    right: 'M9 6l6 6-6 6',
    down: 'M6 9l6 6 6-6',
    back: 'M15 5l-7 7 7 7',
    out: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    term: 'M4 7l5 5-5 5M12 17h8',
    pen: 'M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4',
    file: 'M6 3h8l4 4v14H6zM14 3v4h4',
    dot: 'M12 12h.01',
    chat: 'M4 5h16v11H9l-5 4z',
    diff: 'M8 4v16M4 8h8M14 16h6',
    up: 'M6 15l6-6 6 6',
    close: 'M6 6l12 12M18 6L6 18',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    team: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.5a3 3 0 0 1 0 5.5M18 14.5c1.8.7 3 2.8 3 5.5',
    folder: 'M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
    archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
    commit: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 12h6M15 12h6',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  };
  function icon(name, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', ICONS[name] || ICONS.dot);
    s.appendChild(p);
    return s;
  }

  function toggleFold(id) {
    if (S.fold.has(id)) S.fold.delete(id); else S.fold.add(id);
    try { localStorage.setItem('sb.fold', JSON.stringify([...S.fold])); } catch { /* 무시 */ }
    render();
  }
  function foldHead(cls, id, name, extra, kind, host) {
    const open = !S.fold.has(id);
    const h = el('button', cls + ' fold' + (kind ? ' k-' + kind : ''));
    h.type = 'button';
    h.setAttribute('aria-expanded', String(open));
    add(h, icon(open ? 'down' : 'right', 'ar'), kind ? icon({ group: 'team', project: 'folder', closed: 'archive' }[kind], 'kind') : null, host ? el('span', 'hostchip', host) : null, el('span', 'nm', name), el('span', 'n', extra || ''));
    h.addEventListener('click', () => toggleFold(id));
    return h;
  }

  // 지난 시간을 [수, 단위]로. 1분이 안 되면 null(= 방금)
  function span(ms, now) {
    const m = Math.floor(Math.max(0, (now || Date.now()) - ms) / 60000);
    if (m < 1) return null;
    if (m < 60) return [m, 'm'];
    const h = Math.floor(m / 60);
    return h < 48 ? [h, 'h'] : [Math.floor(h / 24), 'd'];
  }
  const UNIT_KO = { s: '초', m: '분', h: '시간', d: '일' };
  const unit = (n, u) => (LANG === 'en' ? n + u : n + UNIT_KO[u]);
  // "5분째"(계속 중) / "5분 전"(끝남). 1분이 안 되면 둘 다 "방금". 영어는 "5m" / "5m ago"
  const during = (ms, now) => { const p = span(ms, now); return !p ? t('방금') : LANG === 'en' ? unit(p[0], p[1]) : unit(p[0], p[1]) + '째'; };
  const before = (ms, now) => { const p = span(ms, now); return !p ? t('방금') : t('{0} 전', unit(p[0], p[1])); };
  function agoShort(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return unit(s, 's');
    const m = Math.round(s / 60);
    return m < 60 ? unit(m, 'm') : unit(Math.round(m / 60), 'h');
  }
  // 오늘이면 9:27, 어제면 "어제 17:48", 그보다 앞이면 "11/11 17:48"
  function clock(ms) {
    const d = new Date(ms);
    const hm = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
    const today = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(today) - day(d)) / 86400000);
    if (diff <= 0) return hm;
    if (diff === 1) return t('어제 ') + hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  // 상태 이름: 기다림을 승인·답·결정으로 나누고, 할 일 없다고 한 쉼은 따로 적는다
  function statusText(x) {
    if (x.status === 'wait') return x.waitingFor === 'permission prompt' ? t('승인 기다림') : t('답 기다림');
    if (x.status === 'idle' && x.turn === 'ask') return t('결정 기다림');
    if (x.status === 'idle' && x.turn === 'none') return t('쉼 · 할 일 없음');
    if (x.status === 'closed' && x.turn === 'ask') return t('닫힘 · 질문 남음');
    return { work: t('작업 중'), idle: t('쉼'), closed: t('닫힘') }[x.status] || '';
  }
  function dotClass(x) {
    return 'dot d-' + (x.status === 'idle' && x.turn === 'ask' ? 'ask' : x.status);
  }

  const RC_RE = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/;
  function rcLink(url, text, cls) {
    if (!url || !RC_RE.test(url)) return el('span', 'btn off', t('RC 꺼짐'));
    const a = el('a', cls || 'btn');
    add(a, document.createTextNode(text), icon('out'));
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  // 글 복사: 클립보드 API가 막히면 숨긴 글상자로 한 번 더 시도한다
  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      showToast(t('복사했습니다.'));
      return;
    } catch { /* 아래로 */ }
    const ta = el('textarea', 'cpyhide');
    ta.value = t;
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    showToast(ok ? t('복사했습니다.') : t('복사하지 못했습니다. 글을 길게 눌러 골라 주세요.'));
  }

  function bar(addN, delN) {
    const b = el('span', 'bar');
    b.setAttribute('aria-hidden', 'true');
    const tot = addN + delN;
    const g = tot ? Math.round((addN / tot) * 5) : 0;
    for (let i = 0; i < 5; i++) b.appendChild(el('span', tot ? (i < g ? 'g' : 'r') : ''));
    return b;
  }

  function extBadge(name) {
    const n = name.toLowerCase();
    const e = n.includes('.') ? n.split('.').pop() : '';
    let t = e.slice(0, 4).toUpperCase() || '·';
    let c = '';
    if (/\.test\.|\.spec\.|tests?\.cs$/.test(n)) { t = 'TEST'; c = 'x-test'; }
    else if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'].includes(e)) { t = e === 'ts' || e === 'tsx' ? 'TS' : 'JS'; c = 'x-js'; }
    else if (e === 'json' || e === 'jsonl') { t = '{ }'; c = 'x-json'; }
    else if (e === 'md') { t = 'MD'; c = 'x-md'; }
    else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(e)) { t = 'IMG'; c = 'x-img'; }
    else if (e === 'cs' || e === 'razor') { t = e === 'cs' ? 'C#' : 'RZR'; c = 'x-cs'; }
    return el('span', 'ext ' + c, t);
  }

  // ---------- 주소(#s=세션&t=탭) ----------
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    S.sel = h.get('s') || null;
    S.tab = h.get('t') === 'files' ? 'files' : h.get('t') === 'commits' ? 'commits' : 'conv';
  }
  function go(sid, tab) {
    const h = new URLSearchParams();
    if (sid) h.set('s', sid);
    if (sid && tab) h.set('t', tab);
    location.hash = h.toString();
  }
  window.addEventListener('hashchange', () => {
    const prev = S.sel;
    readHash();
    if (S.sel !== prev) { S.detail = null; S.detailText = ''; S.open = null; S.diffs.clear(); S.more.clear(); S.scrolled = null; S.convN = 10; if (S.sel) loadDetail(); }
    render();
  });

  // ---------- 서버에서 받기 ----------
  // 받은 글이 지난번과 같으면 다시 그리지 않는다(읽던 자리·고른 글·옆으로 넘긴 표를 지키려고)
  async function getText(url) {
    const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { location.reload(); throw new Error('unauthorized'); }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }
  async function loadState(force) {
    try {
      const t = await getText('/api/state?win=' + S.win);
      S.failed = false;
      S.lastOk = Date.now();
      // 시각 값(now·scannedAt)은 매번 바뀌므로 빼고 비교한다. 내용이 같으면 시각만 고치고 다시 그리지 않는다
      const d = JSON.parse(t);
      const key = JSON.stringify({ ...d, now: 0, scannedAt: 0 });
      if (key !== S.stateKey || force || !S.data) {
        S.stateKey = key;
        const first = !S.data;
        S.data = d;
        noteNewWaits();
        if (force || first) render(); else softRender();
      } else {
        S.data.now = d.now;
        S.data.scannedAt = d.scannedAt;
      }
    } catch {
      S.failed = true;
    }
    tick();
  }
  async function loadDetail() {
    if (!S.sel) return;
    const sid = S.sel;
    try {
      const t = await getText('/api/session?sid=' + encodeURIComponent(sid) + '&win=' + S.win + '&n=' + S.convN);
      if (S.sel !== sid) return;
      const was = S.loadingMore;
      // 세션을 막 열었을 때(아직 내용 없음)는 누른 손가락 때문에 미루지 않고 바로 그린다
      const first = !S.detail || S.detail.error;
      S.loadingMore = false;
      if (t === S.detailText) { if (was) render(); return; }
      S.detailText = t;
      S.detail = JSON.parse(t);
      if (was || first) { render(); return; }
    } catch {
      if (S.sel !== sid) return;
      S.loadingMore = false;
      if (S.detail && !S.detail.error) return;
      // 서버가 막 다시 떠서 아직 세션을 다 못 읽었을 수 있다: 10초를 기다리지 않고 2초 뒤 다시
      S.detail = { error: true };
      setTimeout(() => { if (S.sel === sid && S.detail && S.detail.error) loadDetail(); }, 2000);
    }
    softRender();
  }
  async function loadDiff(p) {
    if (!S.sel) return;
    S.diffs.set(p, { loading: true });
    render();
    try {
      S.diffs.set(p, JSON.parse(await getText('/api/diff?sid=' + encodeURIComponent(S.sel) + '&path=' + encodeURIComponent(p) + '&win=' + S.win)));
    } catch { S.diffs.set(p, { error: true }); }
    render();
  }

  // 새로 나를 기다리는 세션이 생겼는데 아래를 보고 있으면, 화면을 밀지 않고 알림 띠로 알린다
  function noteNewWaits() {
    pruneDismissed(S.data);
    const now = new Set(visibleWaits(S.data).map((a) => a.sid));
    if (S.seenWait) {
      let n = 0;
      for (const sid of now) if (!S.seenWait.has(sid)) n++;
      if (n && window.scrollY > 150) S.newWait += n;
    }
    S.seenWait = now;
  }

  // ---------- 손대는 중에는 다시 그리기를 미룬다 ----------
  function held() {
    const sel = window.getSelection ? String(window.getSelection()) : '';
    // 코드 입력칸에 치는 중에는 다시 그리지 않는다(휴대폰 자판이 닫히고 글자가 지워지지 않게)
    const typing = document.activeElement && document.activeElement.matches && document.activeElement.matches('.findbox input');
    return Date.now() < S.holdUntil || sel.length > 0 || typing;
  }
  function softRender() {
    if (held()) { S.pending = true; return; }
    render();
  }
  window.addEventListener('pointerdown', () => { S.holdUntil = Date.now() + 2500; }, { passive: true });
  window.addEventListener('scroll', () => {
    S.holdUntil = Math.max(S.holdUntil, Date.now() + 1200);
    if (window.scrollY < 100 && S.newWait) { S.newWait = 0; tick(); }
  }, { passive: true });

  // ---------- 머리 · 최신 여부 ----------
  // 초록: 10초마다 잘 받는 중 / 노랑: 서버는 답하지만 세션 읽기가 30초 넘게 멈춤 / 빨강: 서버에 못 닿음
  function freshness() {
    const d = S.data;
    if (S.failed) return { cls: 'bad', text: S.lastOk ? t('연결 끊김 · {0} 전 정보', agoShort(Date.now() - S.lastOk)) : t('연결 끊김 · 정보 없음'), stale: true };
    if (!d) return { cls: '', text: t('읽는 중'), stale: false };
    const age = (d.now - (d.scannedAt || d.now)) + (Date.now() - S.lastOk);
    if (!d.scannedAt || age > 30000) return { cls: 'warn', text: t('읽기 멈춤 · {0} 전 정보', agoShort(age)), stale: age > 60000 };
    return { cls: '', text: t('{0} 전 갱신', agoShort(age)), stale: false };
  }
  function renderTop() {
    const d = S.data;
    $top.textContent = '';
    // 제목을 누르면 첫 화면(전체 상황)으로 간다
    const home = el('a', 'homelink');
    home.href = '#';
    home.setAttribute('aria-label', t('첫 화면으로'));
    add(home, el('h1', '', t('세션 보드')));
    home.addEventListener('click', (e) => { e.preventDefault(); S.drawer = false; go(null); });
    add($top, home);
    const hosts = hostList(d);
    $top.classList.toggle('withtabs', hosts.length > 0);
    if (hosts.length) {
      const tabs = el('span', 'hosts');
      tabs.setAttribute('role', 'group');
      tabs.setAttribute('aria-label', t('볼 컴퓨터'));
      for (const h of hosts) {
        const b = el('button', 'host tab' + (h.name === S.host ? ' on' : '') + (h.off ? ' off' : ''));
        b.type = 'button';
        b.setAttribute('aria-pressed', String(h.name === S.host));
        if (h.remote) add(b, el('i', 'rdot'));
        add(b, document.createTextNode(h.name));
        // 다른 컴퓨터에 나를 기다리는 세션이 있으면 단추에 수를 보인다
        if (h.wait && h.name !== S.host) { const w = el('b', 'hw', String(h.wait)); w.setAttribute('aria-label', t('대기 {0}', h.wait)); add(b, w); }
        if (h.off) b.title = t('연결 안 됨');
        b.addEventListener('click', () => setHost(h.name));
        add(tabs, b);
      }
      add($top, tabs);
    } else add($top, el('span', 'host on', d ? d.label : ''));
    for (const p of (d && d.peers) || []) {
      const a = el('a', 'host', p.name);
      a.href = p.url;
      add($top, a);
    }
    add($top, el('span', 'sp'));
    const gear = el('button', 'gearbtn' + (S.drawer ? ' on' : ''));
    gear.type = 'button';
    gear.setAttribute('aria-label', t('설정'));
    gear.setAttribute('aria-expanded', String(!!S.drawer));
    add(gear, icon('gear'), el('span', '', t('설정')));
    gear.addEventListener('click', () => { S.drawer = !S.drawer; render(); });
    const live = el('span', 'live');
    live.id = 'live';
    live.setAttribute('role', 'status');
    add(live, el('i'), el('span', 'lt'));
    add($top, live, gear);
    tick();
  }
  // 1초마다 머리의 "n초 전"과 오래됨 띠만 고친다(화면 전체는 다시 그리지 않음)
  function tick() {
    const f = freshness();
    const live = document.getElementById('live');
    if (live) {
      live.className = 'live ' + f.cls;
      live.querySelector('.lt').textContent = f.text;
    }
    document.body.classList.toggle('stale', f.stale);
    // 띠는 종류가 바뀔 때만 새로 만들고, 같은 종류면 글자만 고친다(누르는 중인 단추가 사라지지 않게)
    const mode = f.stale ? 'stale' : S.newWait ? 'new' : '';
    const msg = f.stale
      ? (S.failed ? (S.lastOk ? t('서버에 연결하지 못했습니다. 아래 내용은 {0} 전 것입니다.', agoShort(Date.now() - S.lastOk)) : t('서버에 연결하지 못했습니다. 아래 내용은 예전 것입니다.')) : t('세션 읽기가 멈췄습니다. 아래 내용은 최신이 아닐 수 있습니다.'))
      : t('새로 기다리는 세션 {0}개', S.newWait);
    if ($banner.dataset.mode !== mode) {
      $banner.dataset.mode = mode;
      $banner.textContent = '';
      $banner.className = mode ? 'show ' + mode : '';
      if (mode === 'stale') {
        const retry = el('button', 'btn ghost', t('다시 시도'));
        retry.type = 'button';
        retry.addEventListener('click', () => { loadState(true); if (S.sel) loadDetail(); });
        add($banner, el('span', 'bm'), retry);
      } else if (mode === 'new') {
        const b = el('button', 'newwait');
        b.type = 'button';
        add(b, icon('up'), el('span', 'bm'));
        b.addEventListener('click', () => { S.newWait = 0; window.scrollTo({ top: 0, behavior: 'smooth' }); tick(); });
        add($banner, b);
      }
    }
    const bm = $banner.querySelector('.bm');
    if (bm) bm.textContent = msg;
    if (S.pending && !held()) { S.pending = false; render(); }
  }
  // ---------- Claude 글(마크다운) → 화면 ----------
  // 정해진 꾸밈(제목·굵게·기울임·코드·표·목록·인용·가로줄)만 직접 만든다. 글은 모두 textContent로 넣어 HTML로 해석하지 않는다
  const SAFE_URL = /^https:\/\/[^\s<>"']+$/;
  function inline(text) {
    const frag = document.createDocumentFragment();
    const re = /(`+)([^`]+?)\1|\*\*(.+?)\*\*|(?<![\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[2] != null) frag.appendChild(el('code', 'mc', m[2]));
      else if (m[3] != null) { const b = el('b'); b.appendChild(inline(m[3])); frag.appendChild(b); }
      else if (m[4] != null) { const it = el('i'); it.appendChild(inline(m[4])); frag.appendChild(it); }
      else if (m[5] != null) {
        if (SAFE_URL.test(m[6])) { const a = el('a', 'ml', m[5]); a.href = m[6]; a.target = '_blank'; a.rel = 'noopener noreferrer'; frag.appendChild(a); }
        else frag.appendChild(el('span', 'ml', m[5])); // 파일 경로 같은 링크는 글만
      }
      last = re.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  function cells(l) {
    const s = l.trim().replace(/^\|/, '').replace(/\|$/, '');
    const out = [];
    let cur = '';
    let code = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
      if (ch === '`') code = !code;
      if (ch === '|' && !code) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  function markdown(text) {
    const root = document.createDocumentFragment();
    const lines = String(text).replace(/\r/g, '').split('\n');
    let i = 0;
    const tableAt = (k) => isRow(lines[k]) && k + 1 < lines.length && isSep(lines[k + 1]);
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*(```|~~~)/.exec(line);
      if (fence) {
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
        i++;
        const pre = el('pre', 'mpre');
        pre.appendChild(el('code', '', buf.join('\n')));
        const box = el('div', 'mprewrap');
        const cp = el('button', 'cpy', t('복사'));
        cp.type = 'button';
        cp.setAttribute('aria-label', t('코드 복사'));
        const text = buf.join('\n');
        cp.addEventListener('click', (e) => { e.stopPropagation(); copyText(text); });
        add(box, pre, cp);
        root.appendChild(box);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      if (tableAt(i)) {
        const wrap = el('div', 'mtable');
        const t = el('table');
        const thead = el('thead');
        const hr = el('tr');
        for (const c of cells(line)) { const th = el('th'); th.appendChild(inline(c)); hr.appendChild(th); }
        thead.appendChild(hr);
        t.appendChild(thead);
        const tb = el('tbody');
        i += 2;
        while (i < lines.length && isRow(lines[i])) {
          const r = el('tr');
          for (const c of cells(lines[i])) { const td = el('td'); td.appendChild(inline(c)); r.appendChild(td); }
          tb.appendChild(r);
          i++;
        }
        t.appendChild(tb);
        wrap.appendChild(t);
        root.appendChild(wrap);
        continue;
      }
      const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        const d = el('div', 'mh mh' + Math.min(h[1].length, 3));
        d.appendChild(inline(h[2].replace(/\s+#+\s*$/, '')));
        root.appendChild(d);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { root.appendChild(el('hr', 'mhr')); i++; continue; }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        const q = el('blockquote', 'mq');
        q.appendChild(markdown(buf.join('\n')));
        root.appendChild(q);
        continue;
      }
      const lm = LIST_RE.exec(line);
      if (lm) {
        const ordered = /\d/.test(lm[2]);
        const list = el(ordered ? 'ol' : 'ul', 'mlist');
        if (ordered && parseInt(lm[2], 10) > 1) list.start = parseInt(lm[2], 10);
        const base = lm[1].length;
        while (i < lines.length) {
          const m = LIST_RE.exec(lines[i]);
          if (m && (m[1].length > base || /\d/.test(m[2]) === ordered)) {
            const li = el('li', m[1].length > base + 1 ? 'sub' : '');
            li.appendChild(inline(m[3]));
            list.appendChild(li);
            i++;
          } else if (!m && lines[i].trim() && /^\s{2,}/.test(lines[i]) && list.lastChild) {
            list.lastChild.appendChild(document.createTextNode(' '));
            list.lastChild.appendChild(inline(lines[i].trim()));
            i++;
          } else break;
        }
        root.appendChild(list);
        continue;
      }
      const p = el('p', 'mp');
      let n = 0;
      while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i]) && !LIST_RE.test(lines[i]) && !tableAt(i)) {
        if (n++) p.appendChild(el('br'));
        p.appendChild(inline(lines[i]));
        i++;
      }
      if (!n) { p.appendChild(inline(lines[i])); i++; } // 어느 규칙에도 안 걸린 줄은 그대로
      root.appendChild(p);
    }
    return root;
  }

  // 긴 글은 줄 경계에서 자른다(표·코드 블록 한가운데를 덜 자르게)
  function cutLong(text, max) {
    if (text.length <= max) return text;
    let at = text.lastIndexOf('\n', max);
    if (at < max * 0.4) at = max;
    return text.slice(0, at).replace(/\s+$/, '') + '\n…';
  }

  // ---------- 목록 ----------
  function sessionRow(x, now) {
    const isNew = unread(x);
    const b = el('button', 's' + (x.sid === S.sel ? ' sel' : '') + (x.status === 'closed' ? ' closed' : '') + (x.turn === 'none' ? ' quiet' : '') + (isNew ? ' unread' : ''));
    b.type = 'button';
    if (x.sid === S.sel) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', () => { S.listY = window.scrollY; go(x.sid, S.tab === 'files' ? 'files' : null); });
    const body = el('span', 'body');
    add(body, el('span', 'tt', x.title));
    const meta = el('span', 'meta');
    if (x.agent === 'codex') add(meta, el('span', 'role', 'Codex'));
    if (x.role) for (const r of x.role.split(/[,·]/).map((s) => s.trim()).filter(Boolean)) add(meta, el('span', 'role', r));
    if (x.status === 'work' && x.activity) add(meta, el('span', 'act', (x.activity.tool || '') + (x.activity.arg ? ' · ' + x.activity.arg : '')));
    else if (x.status !== 'work') add(meta, el('span', 'act', statusText(x)));
    if (S.hiddenSids && S.hiddenSids.has(x.sid)) add(meta, el('span', 'hid', t('카드 숨김')));
    if (x.files) add(meta, el('span', '', t('파일 {0}', x.files)), el('span', 'add', '+' + x.add), el('span', 'del', '−' + x.del), bar(x.add, x.del));
    add(body, meta);
    const tail = x.status === 'closed' ? before(x.lastActivity, now) : during(x.since, now);
    const dot = el('span', dotClass(x));
    dot.setAttribute('aria-hidden', 'true');
    const right = el('span', 'el', tail);
    if (isNew) add(right, unreadDot());
    add(b, dot, body, right);
    return b;
  }

  function renderList(d) {
    const list = el('section', 'list');
    list.setAttribute('aria-label', t('세션 목록'));
    const total = d.sections.reduce((n, s) => n + s.sessions.length, 0);
    const newN = allSessions(d).filter(unread).length;
    const lh = el('div', 'listhrow');
    add(lh, el('h2', 'listh', t('전체 세션 {0}', total)));
    if (newN) {
      add(lh, add(el('span', 'newn'), unreadDot(), document.createTextNode(t('새 내용 {0}', newN))));
      const b = el('button', 'lnk', t('모두 읽음'));
      b.type = 'button';
      b.addEventListener('click', () => seenAll(d));
      add(lh, b);
    }
    add(list, lh);
    for (const r of d.remotes || []) {
      if (r.ok) continue;
      const old = r.okAt && d.now - r.okAt <= 5 * 60000;
      add(list, el('p', 'remoteoff', t('{0}: 연결 안 됨', r.name) + (old ? t(' · {0} 정보로 보여 줍니다', before(r.okAt, d.now)) : t(' · 그 컴퓨터 세션은 지금 안 보입니다')) + (r.error ? ` (${tr(r.error)})` : '')));
    }
    if (!d.sections.length) add(list, el('p', 'empty', t('최근 세션이 없습니다.')));
    for (const sec of d.sections) {
      const c = { wait: 0, work: 0, idle: 0, closed: 0 };
      for (const x of sec.sessions) {
        // 대기 카드를 숨긴 세션은 묶음의 대기 수에도 넣지 않는다(맨 위 칩과 같게)
        if (S.hiddenSids && S.hiddenSids.has(x.sid)) continue;
        if (x.status === 'wait' || (x.status === 'idle' && x.turn === 'ask')) c.wait++;
        else if (c[x.status] != null) c[x.status]++;
      }
      const n = sec.kind === 'closed' ? String(sec.sessions.length) : [c.wait && t('대기 {0}', c.wait), c.work && t('작업 {0}', c.work), c.idle && t('쉼 {0}', c.idle), c.closed && t('닫힘 {0}', c.closed)].filter(Boolean).join(' · ');
      add(list, foldHead('gh', sec.id, tr(sec.name), n ? '· ' + n : '', sec.kind, d.hostView ? null : sec.host));
      // 접은 묶음도 지금 보고 있는 세션 한 줄은 남긴다(어디 있는지 잃지 않게)
      const rows = S.fold.has(sec.id) ? sec.sessions.filter((x) => x.sid === S.sel) : sec.sessions;
      for (const x of rows) add(list, sessionRow(x, d.now));
    }
    return list;
  }

  const WAIT_LABEL = { permission: t('승인을 기다림'), question: t('답을 기다림'), turn: t('결정을 기다림') };
  function renderAttention(d) {
    const out = [];
    const shown = freshWaits(d);
    const hidden = d.attention.length - visibleWaits(d).length;
    for (const a of shown) {
      const w = el('div', 'wait');
      const x = el('button', 'wx');
      x.type = 'button';
      x.setAttribute('aria-label', t('{0} 카드 숨기기', a.title));
      add(x, icon('close'));
      x.addEventListener('click', () => { hideWaits([a], d); });
      // 카드 본문(제목·질문)을 누르면 보드에서 그 세션이 열린다. 단추는 답하러 가는 것 하나만
      const open = el('button', 'wbody');
      open.type = 'button';
      open.setAttribute('aria-label', t('{0} 세션 열기', a.title));
      const k = el('span', 'k');
      add(k, el('span', 'dot d-wait'), document.createTextNode(WAIT_LABEL[a.kind] || t('기다림')), el('span', 'since', '· ' + during(a.since, d.now)), a.host && !d.hostView ? el('span', 'hostchip', a.host) : null);
      add(open, k, el('span', 't', a.title));
      if (a.text) add(open, el('span', 'q', tr(a.text)));
      open.addEventListener('click', () => { S.listY = window.scrollY; go(a.sid, 'conv'); });
      const row = el('div', 'row');
      add(row, rcLink(a.rc, t('앱에서 답하기')), el('span', 'hint', t('눌러서 보기')));
      add(w, x, open, row);
      out.push(w);
    }
    // 숨긴 카드는 위쪽에 아무 흔적도 남기지 않는다. 되살리기는 맨 아래 작은 줄과 목록의 "숨김" 표시로
    void hidden;
    if (shown.length >= 2) {
      const bar2 = el('div', 'waitbar');
      const all = el('button', 'lnk', t('모두 숨기기'));
      all.type = 'button';
      all.addEventListener('click', () => hideWaits(shown, d));
      add(bar2, el('span', 'sp'), all);
      out.push(bar2);
    }
    // 12시간 넘은 대기: 접어 둔 흐린 상자로
    const oldW = visibleWaits(d).filter((a) => d.now - a.since >= OLD_WAIT_MS);
    if (oldW.length) {
      const box = el('div', 'closedask oldwait');
      add(box, foldHead('k', 'oldwait', t('오래된 대기 (12시간 넘음)'), '· ' + oldW.length));
      if (!S.fold.has('oldwait')) {
        for (const a of oldW) {
          const row = el('div', 'ci');
          const open = el('button', 'cbody');
          open.type = 'button';
          add(open, el('span', 't', a.title + ' · ' + during(a.since, d.now) + (a.host && !d.hostView ? ' · ' + a.host : '')), a.text ? el('span', 'q', tr(a.text)) : null);
          open.addEventListener('click', () => { S.listY = window.scrollY; go(a.sid, 'conv'); });
          const x = el('button', 'wx');
          x.type = 'button';
          x.setAttribute('aria-label', t('{0} 숨기기', a.title));
          add(x, icon('close'));
          x.addEventListener('click', () => hideWaits([a], d));
          add(row, open, x);
          add(box, row);
        }
      }
      out.push(box);
    }
    // 질문으로 끝난 채 닫힌 세션: 흐리게 따로 모으고, 답하려면 VS Code에서 다시 열라고 알린다
    const cl = (d.closedAsks || []).filter((a) => !S.dismissed.has(waitKey(a)));
    if (cl.length) {
      const box = el('div', 'closedask');
      add(box, foldHead('k', 'closedask', t('닫힌 채 남은 질문'), '· ' + cl.length));
      if (!S.fold.has('closedask')) {
        add(box, el('p', 'cnote', t('VS Code가 다시 시작되는 등으로 꺼진 세션입니다. 답하려면 VS Code에서 그 세션을 다시 여세요.')));
        for (const a of cl) {
          const row = el('div', 'ci');
          const open = el('button', 'cbody');
          open.type = 'button';
          add(open, el('span', 't', a.title + ' · ' + before(a.since, d.now)), a.text ? el('span', 'q', tr(a.text)) : null);
          open.addEventListener('click', () => { S.listY = window.scrollY; go(a.sid, 'conv'); });
          const x = el('button', 'wx');
          x.type = 'button';
          x.setAttribute('aria-label', t('{0} 숨기기', a.title));
          add(x, icon('close'));
          x.addEventListener('click', () => hideWaits([a], d));
          add(row, open, x);
          add(box, row);
        }
      }
      out.push(box);
    }
    if (d.recent.length) {
      const r = el('div', 'recent');
      add(r, foldHead('k', 'recent', t('방금 끝남 (30분 안)'), '· ' + d.recent.length));
      if (!S.fold.has('recent')) {
        // 묶음별로(세션 목록과 같은 이름), 가장 최근에 끝난 묶음이 위
        const buckets = new Map();
        for (const x of d.recent) { if (!buckets.has(x.bucket)) buckets.set(x.bucket, []); buckets.get(x.bucket).push(x); }
        for (const [name, items] of buckets) {
          const id = 'r:' + name;
          add(r, foldHead('gk', id, tr(name), '· ' + items.length));
          if (S.fold.has(id)) continue;
          for (const x of items) {
            const sx = allSessions(d).find((y) => y.sid === x.sid);
            const it = el('a', 'it' + (x.turn === 'none' ? ' quiet' : '') + (sx && unread(sx) ? ' unread' : ''));
            it.href = '#s=' + encodeURIComponent(x.sid);
            it.addEventListener('click', () => { S.listY = window.scrollY; });
            const txt = el('span', 'tx');
            add(txt, el('span', 't', x.title + ' · ' + before(x.since, d.now) + (x.turn === 'none' ? t(' · 할 일 없음') : '')));
            if (x.text) add(txt, el('span', 'q', tr(x.text)));
            add(it, icon('check', 'ok'), txt);
            if (sx && unread(sx)) add(it, unreadDot());
            add(r, it);
          }
        }
      }
      out.push(r);
    }
    return out;
  }

  // ---------- 세션 하나 ----------
  const TOOL_ICON = { Bash: 'term', Edit: 'pen', Write: 'pen', MultiEdit: 'pen', NotebookEdit: 'pen', Read: 'file' };
  function renderConv(dt) {
    const box = el('div', 'conv');
    if (!dt.conversation.length) add(box, el('p', 'note', t('최근 대화가 없습니다.')));
    else add(box, el('div', 'note', t('최근 것이 위에 있습니다')));
    // 최근 것부터: 휴대폰에서 열자마자 마지막 말이 보이게(스크롤을 맨 아래로 옮기지 않는다)
    const list = dt.conversation.map((m, i) => [m, i]).reverse();
    const toolLine = (m) => {
      const line = el('div', 'tool mono');
      add(line, icon(TOOL_ICON[m.name] || 'dot'), el('span', '', m.name + (m.text ? ' · ' + tr(m.text) : '')));
      return line;
    };
    // 이어진 도구 줄은 한 덩어리로: 최근 2줄만 보이고 나머지는 눌러서 펼친다
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const key = 't' + run[0][1];
      const open = S.more.has(key);
      for (const [m] of open ? run : run.slice(0, 2)) add(box, toolLine(m));
      if (run.length > 2) {
        const b = el('button', 'more-tools', open ? t('도구 줄 접기') : t('도구 {0}개 더 보기', run.length - 2));
        b.type = 'button';
        b.setAttribute('aria-expanded', String(open));
        b.addEventListener('click', () => { if (open) S.more.delete(key); else S.more.add(key); render(); });
        add(box, b);
      }
      run = [];
    };
    list.forEach(([m, i]) => {
      if (m.role === 'tool') { run.push([m, i]); return; }
      flush();
      const msg = el('div', 'msg ' + m.role);
      add(msg, el('div', 'tm', (m.role === 'user' ? t('나') : 'Claude') + ' · ' + clock(m.ts)));
      const long = m.text.length > 700 && !S.more.has(i);
      const body = tr(long ? cutLong(m.text, 700) : m.text);
      // 내 말은 친 그대로, Claude 글은 마크다운으로
      if (m.role === 'user') add(msg, el('div', 'ut', body));
      else add(msg, markdown(body));
      // 옆으로 넘긴 표·코드 위치를 다시 그린 뒤에도 지키려고 이름을 붙인다
      msg.querySelectorAll('.mtable,.mpre').forEach((n, j) => { n.dataset.k = 'm' + i + '-' + j; });
      if (long) {
        const more = el('button', 'more', t('전체 보기'));
        more.type = 'button';
        more.addEventListener('click', () => { S.more.add(i); render(); });
        add(msg, more);
      }
      add(box, msg);
    });
    flush();
    // 처음에는 최근 10개만. 더 앞의 대화는 눌러서 10개씩 더 불러온다
    if (dt.convMore) {
      const more = el('button', 'loadmore', S.loadingMore ? t('불러오는 중…') : t('이전 대화 10개 더 보기'));
      more.type = 'button';
      more.disabled = S.loadingMore;
      more.addEventListener('click', () => { S.convN = Math.min(200, S.convN + 10); S.loadingMore = true; render(); loadDetail(); });
      add(box, more);
    }
    add(box, el('div', 'note', t('명령 실행 결과와 생각 과정은 숨김 · 키·비밀번호 같은 값은 자동으로 가림')));
    return box;
  }

  // ---------- 바뀐 줄 ----------
  // 연달아 지운 줄(-)과 넣은 줄(+)을 순서대로 짝지어, 줄 안에서 실제로 바뀐 부분만 진하게 칠한다
  function wordSpans(a, b) {
    const n = Math.min(a.length, b.length);
    let p = 0;
    while (p < n && a[p] === b[p]) p++;
    if (p > 0 && /[\uD800-\uDBFF]/.test(a[p - 1])) p--; // 이모지 같은 글자를 반으로 자르지 않는다
    let q = 0;
    while (q < n - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
    if (q > 0 && /[\uDC00-\uDFFF]/.test(a[a.length - q])) q--;
    // 같은 부분이 30%도 안 되면 거의 다른 줄이므로 줄 전체가 바뀐 것으로 본다
    if (p + q < Math.max(a.length, b.length) * 0.3) return null;
    return [[p, a.length - q], [p, b.length - q]];
  }
  function diffLine(t, s, range) {
    const ln = el('span', 'ln ' + (t === '+' ? 'a' : t === '-' ? 'x' : 'c'));
    if (!range || range[0] >= range[1]) { ln.textContent = t + ' ' + s; return ln; }
    add(ln, document.createTextNode(t + ' ' + s.slice(0, range[0])), el('span', 'w', s.slice(range[0], range[1])), document.createTextNode(s.slice(range[1])));
    return ln;
  }
  function renderLines(box, lines) {
    for (let i = 0; i < lines.length;) {
      if (lines[i][0] !== '-') { add(box, diffLine(lines[i][0], lines[i][1])); i++; continue; }
      let j = i;
      while (j < lines.length && lines[j][0] === '-') j++;
      let k = j;
      while (k < lines.length && lines[k][0] === '+') k++;
      const dels = lines.slice(i, j);
      const adds = lines.slice(j, k);
      const ranges = dels.map((d, x) => (x < adds.length ? wordSpans(d[1], adds[x][1]) : null));
      dels.forEach((d, x) => add(box, diffLine('-', d[1], ranges[x] && ranges[x][0])));
      adds.forEach((a, x) => add(box, diffLine('+', a[1], ranges[x] && ranges[x][1])));
      i = k;
    }
  }
  function lineCount(hunks) {
    let a = 0;
    let x = 0;
    for (const h of hunks) for (const [t] of h.lines) { if (t === '+') a++; else if (t === '-') x++; }
    return a || x ? ` · +${a} −${x}` : '';
  }

  function renderDiff(p) {
    const st = S.diffs.get(p);
    const box = el('div', 'diff mono');
    box.dataset.k = 'd:' + p;
    if (!st || st.loading) { add(box, el('div', 'nt', t('불러오는 중…'))); return box; }
    if (st.error) { add(box, el('div', 'nt', t('바뀐 내용을 읽지 못했습니다.'))); return box; }
    if (!st.parts.length) add(box, el('div', 'nt', t('바뀐 줄 기록이 없습니다.')));
    const parts = st.parts;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const kind = part.kind === 'commit' ? t('커밋#kind') + ' ' + (part.sha || '') + (part.msg ? ' ' + part.msg : '') : part.kind === 'shell' ? t('명령') : t('편집');
      // 줄 기록 없는 같은 종류 기록이 이어지면 한 줄로 묶는다(최근 것부터라 j쪽이 더 이른 시각)
      if (!part.hunks.length) {
        let j = i;
        while (j + 1 < parts.length && !parts[j + 1].hunks.length && parts[j + 1].kind === part.kind && parts[j + 1].note === part.note) j++;
        const when = j > i ? clock(parts[j].ts) + ' ~ ' + clock(part.ts) : clock(part.ts);
        add(box, el('div', 'hd', when + ' · ' + kind + (j > i ? t(' {0}번', j - i + 1) : '')));
        if (part.note) add(box, el('div', 'nt', tr(part.note)));
        i = j;
        continue;
      }
      add(box, el('div', 'hd', clock(part.ts) + ' · ' + kind + lineCount(part.hunks)));
      if (part.note) add(box, el('div', 'nt', tr(part.note)));
      for (const h of part.hunks) {
        add(box, el('div', 'hk', tr(h.head)));
        renderLines(box, h.lines);
      }
    }
    if (st.truncated) add(box, el('div', 'nt', t('길어서 앞 400줄까지만 보여 줍니다.')));
    return box;
  }

  function setWin(w) {
    if (!WIN_LABEL[w] || w === S.win) return;
    S.win = w;
    try { localStorage.setItem('sb.win', String(w)); } catch { /* 무시 */ }
    S.open = null;
    S.diffs.clear();
    loadState(true);
    loadDetail();
    render();
  }

  function winPicker() {
    const row = el('div', 'wins');
    row.dataset.k = 'wins';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', t('바뀐 파일 기간'));
    add(row, el('span', 'wl', t('최근')));
    for (const w of [30, 60, 180, 720, 1440]) {
      const b = el('button', w === S.win ? 'on' : '', WIN_LABEL[w]);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(w === S.win));
      b.addEventListener('click', () => setWin(w));
      add(row, b);
    }
    return row;
  }

  function renderFiles(dt) {
    const box = el('div', 'files');
    add(box, winPicker());
    if (dt.win && dt.win !== S.win) { add(box, el('p', 'note', t('불러오는 중…'))); return box; }
    if (!dt.fileGroups.length) add(box, el('p', 'note', t('최근 {0} 동안 바뀐 파일이 없습니다.', WIN_LABEL[S.win])));
    // 임시 파일(scratchpad, tmp·temp 폴더)은 묶음마다 맨 아래 한 줄로 접어 두고, 눌러야 펼친다
    const isTemp = (f) => f.scratch || /(^|[\\/])(tmp|temp)([\\/]|$)/i.test(f.sub || '');
    // 전부 임시 파일인 묶음은 맨 뒤로 보낸다
    const tempGroup = (g) => /^\(임시 작업 폴더\)/.test(g.dir) || g.files.every(isTemp);
    const groups = [...dt.fileGroups].sort((a, b) => Number(tempGroup(a)) - Number(tempGroup(b)));
    for (const g of groups) {
      const allTemp = /^\(임시 작업 폴더\)/.test(g.dir);
      const main = allTemp ? [] : g.files.filter((f) => !isTemp(f));
      const temp = allTemp ? g.files : g.files.filter(isTemp);
      const part = temp.length && main.length ? t(' (임시 {0})', temp.length) : '';
      add(box, el('div', 'fh', tr(g.dir) + ' · ' + g.files.length + part));
      const tkey = 'tmp:' + g.dir;
      const tempOpen = S.more.has(tkey);
      const rows = tempOpen ? [...main, ...temp] : main;
      for (const f of rows) {
        const open = S.open === f.path;
        const row = el('button', 'f' + (open ? ' open' : ''));
        row.type = 'button';
        row.setAttribute('aria-expanded', String(open));
        row.addEventListener('click', () => {
          if (S.open === f.path) { S.open = null; render(); return; }
          S.open = f.path;
          loadDiff(f.path);
        });
        const nm = el('span', 'nm');
        add(nm, el('b', '', f.name), el('span', '', [f.sub, clock(f.ts), f.dirty ? t('커밋 안 함') : ''].filter(Boolean).join(' · ')));
        const cnt = el('span', 'cnt');
        if (f.add || f.del) add(cnt, el('span', 'add', '+' + f.add), document.createTextNode(' '), el('span', 'del', '−' + f.del));
        const chip = f.deleted ? el('span', 'st d', t('삭제')) : f.created ? el('span', 'st n', t('새')) : f.guessed ? el('span', 'st g', t('추정')) : f.committed && !f.dirty ? el('span', 'st c', t('커밋#chip')) : el('span', 'st m', t('수정'));
        add(row, extBadge(f.name), nm, cnt, chip);
        add(box, row);
        if (open) add(box, renderDiff(f.path));
      }
      if (temp.length) {
        const tb = el('button', 'tmprow');
        tb.type = 'button';
        tb.setAttribute('aria-expanded', String(tempOpen));
        add(tb, icon(tempOpen ? 'down' : 'right'), el('span', '', tempOpen ? t('임시 파일 접기') : t('임시 파일 {0}개 보기 (scratchpad·tmp)', temp.length)));
        tb.addEventListener('click', () => { if (tempOpen) S.more.delete(tkey); else S.more.add(tkey); render(); });
        add(box, tb);
      }
    }
    return box;
  }

  // 커밋 탭: 이 세션이 만든 커밋. 누르면 그 커밋의 파일, 파일을 누르면 바뀐 줄
  function renderCommits(dt) {
    const box = el('div', 'commits');
    add(box, winPicker());
    if (dt.win && dt.win !== S.win) { add(box, el('p', 'note', t('불러오는 중…'))); return box; }
    const list = dt.commitList || [];
    if (!list.length) { add(box, el('p', 'note', t('최근 {0} 동안 이 세션이 만든 커밋이 없습니다.', WIN_LABEL[S.win]))); return box; }
    for (const c of list) {
      const key = 'c:' + c.sha;
      const open = S.more.has(key);
      const row = el('button', 'cm' + (open ? ' open' : ''));
      row.type = 'button';
      row.setAttribute('aria-expanded', String(open));
      row.addEventListener('click', () => { if (open) S.more.delete(key); else S.more.add(key); render(); });
      const body = el('span', 'cb');
      add(body, el('b', '', c.msg || t('(메시지 없음)')), el('span', 'cs', [clock(c.ts), c.sha, c.files.length ? t('파일 {0}', c.files.length) : '', c.repo].filter(Boolean).join(' · ')));
      const cnt = el('span', 'cnt');
      if (c.add || c.del) add(cnt, el('span', 'add', '+' + c.add), document.createTextNode(' '), el('span', 'del', '−' + c.del));
      add(row, icon('commit', 'ci2'), body, cnt);
      add(box, row);
      if (!open) continue;
      add(box, commitBody(c));
    }
    return box;
  }

  // 커밋 자세히: 전체 메시지, 만든 사람·시각·번호, 파일마다 이 커밋에서 바뀐 줄(누르면 펼침)
  S.commits = new Map();
  async function loadCommit(sha) {
    S.commits.set(sha, { loading: true });
    try {
      S.commits.set(sha, JSON.parse(await getText('/api/commit?sid=' + encodeURIComponent(S.sel) + '&sha=' + encodeURIComponent(sha))));
    } catch { S.commits.set(sha, { error: true }); }
    render();
  }
  function commitBody(c) {
    const wrap = el('div', 'cdet');
    const cd = S.commits.get(c.sha);
    if (!cd) { loadCommit(c.sha); add(wrap, el('p', 'note left', t('불러오는 중…'))); return wrap; }
    if (cd.loading) { add(wrap, el('p', 'note left', t('불러오는 중…'))); return wrap; }
    if (cd.error) { add(wrap, el('p', 'note left', c.unresolved ? t('이 커밋을 저장소에서 찾지 못했습니다.') : t('커밋 내용을 읽지 못했습니다.'))); return wrap; }
    add(wrap, el('div', 'cmsg', cd.message || t('(메시지 없음)')));
    const when = cd.date ? new Date(cd.date) : null;
    add(wrap, el('div', 'cmeta', [cd.author, when ? when.toLocaleString(LANG === 'en' ? 'en-US' : 'ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '', cd.sha, cd.repo].filter(Boolean).join(' · ')));
    for (const f of cd.files) {
      const key = 'cf:' + c.sha + ':' + f.path;
      const fopen = S.more.has(key);
      const fr = el('button', 'f sub' + (fopen ? ' open' : ''));
      fr.type = 'button';
      fr.setAttribute('aria-expanded', String(fopen));
      fr.addEventListener('click', () => { if (fopen) S.more.delete(key); else S.more.add(key); render(); });
      const name = f.path.split('/').pop();
      const nm = el('span', 'nm');
      add(nm, el('b', '', name), el('span', '', f.path));
      const fc = el('span', 'cnt');
      if (f.add || f.del) add(fc, el('span', 'add', '+' + f.add), document.createTextNode(' '), el('span', 'del', '−' + f.del));
      const chip = f.deleted ? el('span', 'st d', t('삭제')) : f.created ? el('span', 'st n', t('새')) : el('span', 'st m', t('수정'));
      add(fr, extBadge(name), nm, fc, chip);
      add(wrap, fr);
      if (!fopen) continue;
      const dbox = el('div', 'diff mono');
      dbox.dataset.k = key;
      if (f.binary) add(dbox, el('div', 'nt', t('그림 같은 이진 파일이라 줄 비교가 없습니다.')));
      else if (!f.hunks.length) add(dbox, el('div', 'nt', t('바뀐 줄이 없습니다(이름만 바뀜 등).')));
      for (const h of f.hunks) {
        add(dbox, el('div', 'hk', tr(h.head)));
        renderLines(dbox, h.lines);
      }
      if (f.truncated) add(dbox, el('div', 'nt', t('길어서 일부만 보여 줍니다.')));
      add(wrap, dbox);
    }
    return wrap;
  }

  function findSummary(d) {
    return d.sections.flatMap((x) => x.sessions).find((x) => x.sid === S.sel) || null;
  }

  function renderDetail(d) {
    const sec = el('section', 'detail');
    sec.setAttribute('aria-label', t('세션 내용'));
    if (!S.sel) { add(sec, el('p', 'empty', t('세션을 누르면 대화와 바뀐 파일이 여기에 나옵니다.'))); return sec; }
    const dt = S.detail;
    const sum = findSummary(d);
    if (!dt && !sum) { add(sec, el('p', 'empty', t('이 세션은 지금 목록에 없습니다.'))); return sec; }
    // 상태·내 차례 판정은 목록 쪽(10초마다 새로 옴)을 따른다
    const info = { ...(dt && !dt.error ? dt : {}), ...(sum || {}) };
    const dh = el('div', 'dh');
    const back = el('button', 'back');
    back.type = 'button';
    back.setAttribute('aria-label', t('목록으로'));
    add(back, icon('back'), el('span', 'backt', t('전체 보기#back')));
    back.addEventListener('click', () => go(null));
    const head = el('div', 'hd2');
    const line = el('div', 'muted small sl');
    const dot = el('span', dotClass(info));
    dot.setAttribute('aria-hidden', 'true');
    add(line, dot, document.createTextNode(' ' + statusText(info) + ' · ' + (info.status === 'closed' ? before(info.lastActivity, d.now) : during(info.since, d.now)) + (info.host && d.remotes && !d.hostView ? ' · ' + info.host : '') + (info.cwd ? ' · ' + info.cwd : '')));
    add(head, el('h2', 't', info.title), line);
    add(dh, back, head, rcLink(info.rc, t('앱에서 열기'), 'btn ghost'));
    add(sec, dh);
    if (info.agent === 'codex') {
      // Codex 세션은 Remote Control이 없어 휴대폰에서 답할 수 없다(보기만)
      add(sec, el('p', 'rchint', t('Codex 세션입니다. 휴대폰에서는 보기만 되고, 답하려면 VS Code에서 이어 가세요.')));
    } else if (!info.rc && info.status === 'closed') {
      // 닫힌 세션은 /rc로 열 수 없다. 질문으로 끝난 경우에만 다시 여는 법을 알린다
      if (info.turn === 'ask') add(sec, el('p', 'rchint', t('닫힌 세션입니다. 답하려면 VS Code에서 이 세션을 다시 여세요.')));
    } else if (!info.rc && !S.rcHintOff) {
      const p = el('p', 'rchint');
      const off = el('button', 'lnk', t('다시 보지 않기'));
      off.type = 'button';
      off.addEventListener('click', () => { S.rcHintOff = true; try { localStorage.setItem('sb.rchint', 'off'); } catch { /* 무시 */ } render(); });
      add(p, document.createTextNode(t('휴대폰에서 답하려면 VS Code의 이 세션에서 /rc 를 입력하세요. ')), off);
      add(sec, p);
    }
    if (!dt) { add(sec, el('p', 'empty', t('불러오는 중…'))); return sec; }
    if (dt.error) { add(sec, el('p', 'empty', t('이 세션을 읽지 못했습니다. 잠시 뒤 다시 시도합니다.'))); return sec; }
    const stats = el('div', 'stats');
    const stat = (v, l, kids) => { const s = el('div', 'stat'); const vv = el('div', 'v'); if (kids) add(vv, ...kids); else vv.textContent = v; add(s, vv, el('div', 'l', l)); return s; };
    const lines = stat('', t('줄'), [el('span', 'add', '+' + dt.add), document.createTextNode(' '), el('span', 'del', '−' + dt.del)]);
    lines.classList.add('lines');
    add(stats, stat(dt.files, t('바뀐 파일')), stat(dt.uncommitted, t('커밋 안 함')), stat(dt.commits, t('커밋')), lines);
    add(sec, stats);
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'tablist');
    const tab = (id, label) => {
      const b = el('button', S.tab === id ? 'on' : '', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(S.tab === id));
      b.addEventListener('click', () => switchTab(id));
      return b;
    };
    add(seg, tab('conv', t('대화')), tab('files', t('바뀐 파일 {0}', dt.files)), tab('commits', t('커밋 {0}', (dt.commitList || []).length)));
    add(sec, seg, S.tab === 'conv' ? renderConv(dt) : S.tab === 'commits' ? renderCommits(dt) : renderFiles(dt));
    return sec;
  }

  // 탭 바꾸기는 방문 기록에 쌓지 않는다(뒤로 가기가 탭부터 되돌리지 않게)
  function switchTab(id) {
    const h = new URLSearchParams();
    h.set('s', S.sel);
    if (id !== 'conv') h.set('t', id);
    history.replaceState(null, '', '#' + h.toString());
    S.tab = id;
    render();
  }

  // 접은 화면에서 세션을 열었을 때: 엄지가 닿는 아래쪽 막대 [목록] [대화] [파일] [앱]
  function bottomBar(d) {
    const nav = el('nav', 'bbar');
    nav.setAttribute('aria-label', t('세션 바로가기'));
    const btn = (label, ic, on, fn) => {
      const b = el('button', on ? 'on' : '');
      b.type = 'button';
      add(b, icon(ic), el('span', '', label));
      if (on) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', fn);
      return b;
    };
    const dt = S.detail && !S.detail.error ? S.detail : null;
    const sum = findSummary(d);
    const rc = (sum && sum.rc) || (dt && dt.rc) || null;
    add(nav,
      btn(t('목록'), 'back', false, () => go(null)),
      btn(t('대화#nav'), 'chat', S.tab === 'conv', () => switchTab('conv')),
      btn(t('파일') + (dt ? ' ' + dt.files : ''), 'diff', S.tab === 'files', () => switchTab('files')),
      btn(t('커밋') + (dt ? ' ' + (dt.commitList || []).length : ''), 'commit', S.tab === 'commits', () => switchTab('commits')));
    if (rc && RC_RE.test(rc)) {
      const a = el('a', 'app');
      add(a, icon('out'), el('span', '', t('앱에서 답하기#nav')));
      a.href = rc;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      add(nav, a);
    } else {
      const off = el('span', 'app off');
      add(off, icon('out'), el('span', '', t('RC 꺼짐')));
      add(nav, off);
    }
    return nav;
  }

  // 넓은 화면의 오른쪽 첫 화면: 대기 카드를 여러 칸으로, 아래에 방금 끝남
  // 넓은 화면(웹)의 첫 화면: 위에 숫자 칸, 대기 카드, 그 아래 "지금 작업 중"과 "방금 끝남"을 나란히
  function renderDash(d) {
    const sec = el('section', 'detail dash');
    sec.setAttribute('aria-label', t('전체 상황'));
    const live = d.sections.flatMap((s) => s.sessions);
    const working = live.filter((x) => x.status === 'work');
    const stats = el('div', 'dstats');
    const stat = (n, label, cls) => { const b = el('div', 'dstat' + (cls ? ' ' + cls : '')); add(b, el('b', '', String(n)), el('span', '', label)); return b; };
    add(stats, stat(freshWaits(d).length, t('나를 기다림'), 'wait'), stat(working.length, t('작업 중'), 'work'), stat(d.count.idle, t('쉼')), stat(d.recentFiles, t('최근 {0} 바뀐 파일', WIN_LABEL[d.win] || t('24시간'))));
    add(sec, stats);
    const parts = renderAttention(d);
    const cards = parts.filter((n) => n.classList.contains('wait'));
    const bar = parts.filter((n) => n.classList.contains('waitbar'));
    const recent = parts.filter((n) => n.classList.contains('recent'));
    const boxes = parts.filter((n) => n.classList.contains('closedask'));
    const head = el('div', 'dhead');
    add(head, el('h2', 'dh2', cards.length ? t('나를 기다리는 세션 {0}개', cards.length) : t('지금 나를 기다리는 세션이 없습니다')), ...bar);
    add(sec, head);
    if (cards.length) { const grid = el('div', 'cards'); add(grid, ...cards); add(sec, grid); }
    // 지금 작업 중: 무엇을 하고 있는지 한 줄씩(누르면 그 세션)
    const wk = el('div', 'dpanel');
    add(wk, el('h3', '', t('지금 작업 중 · {0}', working.length)));
    if (!working.length) add(wk, el('p', 'dempty', t('작업 중인 세션이 없습니다.')));
    for (const x of working.slice(0, 12)) {
      const r = el('button', 'wrow');
      r.type = 'button';
      const t = el('span', 'wt');
      add(t, el('b', '', x.title), el('span', '', x.activity ? (x.activity.tool || '') + (x.activity.arg ? ' · ' + x.activity.arg : '') : statusText(x)));
      add(r, el('span', 'dot d-work'), t, el('span', 'el', during(x.since, d.now)));
      r.addEventListener('click', () => go(x.sid, 'conv'));
      add(wk, r);
    }
    const rc = el('div', 'dpanel');
    if (recent.length) add(rc, ...recent);
    else { add(rc, el('h3', '', t('방금 끝남 (30분 안)'))); add(rc, el('p', 'dempty', t('30분 안에 끝난 세션이 없습니다.'))); }
    const row = el('div', 'drow');
    add(row, wk, rc);
    add(sec, row);
    if (boxes.length) { const b = el('div', 'drow'); add(b, ...boxes); add(sec, b); }
    add(sec, el('p', 'note left', t('왼쪽 목록에서 세션을 누르면 대화와 바뀐 파일이 여기에 나옵니다. 단축키: j / k 세션 이동, Esc 닫기')));
    return sec;
  }

  // 넓은 화면 설정(다른 서버·알림·화면): 머리의 톱니 단추로 여는 오른쪽 서랍
  S.drawer = false;
  function settingsDrawer(d) {
    const box = el('aside', 'drawer');
    box.setAttribute('aria-label', t('설정'));
    const h = el('div', 'drh');
    add(h, el('h2', '', t('설정')));
    const x = el('button', 'wx');
    x.type = 'button';
    x.setAttribute('aria-label', t('설정 닫기'));
    add(x, icon('close'));
    x.addEventListener('click', () => { S.drawer = false; render(); });
    add(h, x);
    add(box, h, findBox(), pushRow(), themeSwitch(), langSwitch());
    if (S.hiddenSids.size) {
      const b = el('button', 'lnk', t('숨긴 대기 카드 {0}개 다시 보이기', S.hiddenSids.size));
      b.type = 'button';
      b.addEventListener('click', () => unhideAll(d));
      add(box, b);
    }
    add(box, el('p', 'pnote', t('읽기 전용 · 10초마다 갱신')));
    return box;
  }

  // 세션을 연 동안 왼쪽 위에 남겨 두는 대기 목록(제목 한 줄씩)
  function miniWaits(d) {
    const ws = freshWaits(d);
    if (!ws.length) return null;
    const box = el('div', 'mini');
    add(box, el('div', 'mh', t('나를 기다리는 세션 {0}개', ws.length)));
    for (const a of ws) {
      const b = el('button', 'mi' + (a.sid === S.sel ? ' sel' : ''));
      b.type = 'button';
      add(b, el('span', 'dot d-wait'), el('span', 'nm', a.title), el('span', 'el', during(a.since, d.now)));
      b.addEventListener('click', () => go(a.sid, 'conv'));
      add(box, b);
    }
    return box;
  }

  // 넓은 화면 단축키: j/k로 목록의 다음·앞 세션, Esc로 닫기
  window.addEventListener('keydown', (e) => {
    if (NARROW.matches || e.altKey || e.ctrlKey || e.metaKey || !S.data) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'Escape' && S.drawer) { S.drawer = false; render(); return; }
    if (e.key === 'Escape' && S.sel) { go(null); return; }
    if (e.key !== 'j' && e.key !== 'k') return;
    const order = view(S.data).sections.filter((s) => !S.fold.has(s.id)).flatMap((s) => s.sessions).map((x) => x.sid);
    if (!order.length) return;
    const i = order.indexOf(S.sel);
    const next = e.key === 'j' ? (i < 0 ? 0 : Math.min(order.length - 1, i + 1)) : (i < 0 ? 0 : Math.max(0, i - 1));
    go(order[next], S.tab === 'files' ? 'files' : null);
  });
  // 폭이 접은 화면 ↔ 펼친 화면을 넘나들면 배치를 다시 그린다
  NARROW.addEventListener('change', () => render());

  // ---------- 전체 그리기 ----------
  // ---------- 휴대폰 알림(맨 아래) ----------
  // 켜면 이 기기를 푸시 서버에 등록한다. 서버는 내용 없는 깨우기 신호만 보내고, sw.js가 보드에 물어 "대기 n개"를 띄운다
  const PUSH_OK = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
  S.push = { state: PUSH_OK ? 'unknown' : 'unsupported', busy: false, delayS: 60, names: false };
  try { S.push.names = localStorage.getItem('sb.pushNames') === '1'; } catch { /* 무시 */ }
  // 알림 설정을 sw.js가 읽을 수 있게 Cache Storage에도 적는다(sw.js는 localStorage를 못 읽음)
  async function savePushPrefs() {
    try { localStorage.setItem('sb.pushNames', S.push.names ? '1' : '0'); } catch { /* 무시 */ }
    try {
      const c = await caches.open('sb-prefs');
      await c.put('/__sb_prefs', new Response(JSON.stringify({ names: S.push.names, lang: LANG }), { headers: { 'Content-Type': 'application/json' } }));
    } catch { /* 무시 */ }
  }
  // 알림을 눌렀을 때 이미 열린 보드 창이면 sw.js가 보낸 세션을 연다
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (!e.data || e.data.type !== 'open') return;
      const m = /#s=([^&]+)/.exec(String(e.data.url || ''));
      if (m) go(decodeURIComponent(m[1]), 'conv');
    });
  }
  async function postJson(u, body) {
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  function b64uBytes(s) {
    const t = s.replace(/-/g, '+').replace(/_/g, '/');
    const b = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  }
  async function pushInit() {
    if (!PUSH_OK) return;
    try {
      const info = await (await fetch('/api/push/key', { credentials: 'same-origin' })).json();
      S.push.delayS = info.delayS;
      if (!info.enabled) { S.push.state = 'disabled'; return; }
      if (Notification.permission === 'denied') { S.push.state = 'denied'; return; }
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub && Notification.permission === 'granted') {
        // 서버가 구독을 잃었을 수 있으므로(설정 폴더 삭제 등) 열 때마다 다시 알려 둔다
        await postJson('/api/push/subscribe', { endpoint: sub.endpoint });
        S.push.state = 'on';
        savePushPrefs();
      } else S.push.state = 'off';
    } catch {
      S.push.state = 'off';
    }
    render();
  }
  async function pushOn() {
    S.push.busy = true;
    render();
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { S.push.state = perm === 'denied' ? 'denied' : 'off'; return; }
      const info = await (await fetch('/api/push/key', { credentials: 'same-origin' })).json();
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      // 예전 서버 키로 만든 구독이 남아 있으면 새로 만든다
      const old = await reg.pushManager.getSubscription();
      if (old) await old.unsubscribe();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(info.key) });
      await postJson('/api/push/subscribe', { endpoint: sub.endpoint });
      S.push.state = 'on';
      showToast(t('이 기기로 알림을 받습니다. "시험"으로 확인해 보세요.'));
    } catch (e) {
      showToast(t('알림을 켜지 못했습니다: {0}', (e && e.message) || e));
    } finally {
      S.push.busy = false;
      render();
    }
  }
  async function pushOff() {
    S.push.busy = true;
    render();
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = reg && (await reg.pushManager.getSubscription());
      await postJson('/api/push/unsubscribe', sub ? { endpoint: sub.endpoint } : {});
      if (sub) await sub.unsubscribe();
      S.push.state = 'off';
      showToast(t('이 기기 알림을 껐습니다.'));
    } catch (e) {
      showToast(t('알림을 끄지 못했습니다: {0}', (e && e.message) || e));
    } finally {
      S.push.busy = false;
      render();
    }
  }
  async function pushTest() {
    try {
      const r = await postJson('/api/push/test', {});
      const ok = (r.statuses || []).some((x) => x >= 200 && x < 300);
      showToast(ok ? t('시험 알림을 보냈습니다. 몇 초 안에 와야 합니다.') : t('푸시 서버가 받지 않았습니다({0}).', (r.statuses || []).join(', ')));
    } catch (e) {
      showToast(t('시험 알림을 보내지 못했습니다: {0}', (e && e.message) || e));
    }
  }
  function pushRow() {
    const box = el('div', 'themes pushrow');
    add(box, el('span', 'wl', t('알림')));
    const st = S.push.state;
    const btn = (text, fn, cls) => { const b = el('button', cls || '', text); b.type = 'button'; b.disabled = S.push.busy; b.addEventListener('click', fn); return b; };
    if (st === 'unsupported') add(box, el('span', 'pnote', t('이 브라우저는 알림을 받을 수 없습니다')));
    else if (st === 'disabled') add(box, el('span', 'pnote', t('서버에서 알림을 껐습니다')));
    else if (st === 'denied') add(box, el('span', 'pnote', t('브라우저 설정에서 이 사이트 알림이 막혀 있습니다')));
    else if (st === 'on') add(box, el('span', 'pon', t('켜짐')), btn(t('시험'), pushTest), btn(t('끄기'), pushOff));
    else if (st === 'off') add(box, btn(t('이 기기로 받기'), pushOn));
    else return null;
    if (st === 'on' || st === 'off') add(box, el('span', 'pnote', t('대기가 생기고 {0} 안에 답이 없으면 울립니다. 누르면 그 세션이 열립니다', S.push.delayS < 60 ? t('{0}초', S.push.delayS) : t('{0}분', Math.round(S.push.delayS / 60)))));
    if (st === 'on') {
      // 알림에 세션 이름 보이기(기본 끔): 잠금 화면에도 보이므로 사용자가 고른다
      const nm = el('button', 'nmtog' + (S.push.names ? ' on' : ''), S.push.names ? t('알림에 세션 이름: 보임') : t('알림에 세션 이름: 숨김'));
      nm.type = 'button';
      nm.setAttribute('aria-pressed', String(S.push.names));
      nm.addEventListener('click', () => { S.push.names = !S.push.names; savePushPrefs(); render(); showToast(S.push.names ? t('다음 알림부터 세션 이름이 보입니다(잠금 화면에도 보임).') : t('다음 알림부터 개수만 보입니다.')); });
      add(box, nm);
    }
    return box;
  }

  // ---------- 다른 서버 찾기·붙이기(맨 아래) ----------
  // 내 사설망에서 보드가 켜진 컴퓨터를 찾아 보여 주고, 그 컴퓨터에서 받은 연결 코드를 넣으면 이 보드에 합친다
  S.find = { open: false, loading: false, data: null, error: '', codes: {}, busy: '' };
  async function findLoad(fresh) {
    S.find.loading = true;
    S.find.error = '';
    render();
    try {
      const r = await fetch('/api/discover' + (fresh ? '?fresh=1' : ''), { credentials: 'same-origin' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      S.find.data = j;
    } catch (e) {
      S.find.error = t('찾지 못했습니다: {0}', (e && e.message) || e);
    } finally {
      S.find.loading = false;
      render();
    }
  }
  async function findLink(x) {
    const code = String(S.find.codes[x.url] || '').trim();
    if (!code) { showToast(t('그 컴퓨터에서 받은 연결 코드를 넣어 주세요.')); return; }
    S.find.busy = x.url;
    render();
    try {
      const r = await fetch('/api/remote-link', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: x.url, code }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      delete S.find.codes[x.url];
      showToast(j.replaced ? t('다시 연결했습니다: {0}. 위쪽 단추로 볼 수 있습니다.', j.name) : t('합쳤습니다: {0}. 위쪽 단추로 볼 수 있습니다.', j.name));
      loadState(true);
      findLoad(true);
    } catch (e) {
      showToast(t('붙이지 못했습니다: {0}', (e && e.message) || e));
    } finally {
      S.find.busy = '';
      render();
    }
  }
  function findBox() {
    const box = el('div', 'findbox');
    const head = el('div', 'fbh');
    add(head, el('span', 'wl', t('다른 서버')));
    const b = el('button', 'fbtn', S.find.loading ? t('찾는 중…') : S.find.data ? t('다시 찾기') : t('내 사설망에서 찾기'));
    b.type = 'button';
    b.disabled = S.find.loading;
    b.addEventListener('click', () => findLoad(!!S.find.data));
    add(head, b);
    add(box, head);
    if (S.find.error) add(box, el('p', 'pnote', S.find.error));
    const d = S.find.data;
    if (!d) { add(box, el('p', 'pnote', t('같은 Tailscale 사설망에서 보드가 켜진 컴퓨터를 찾아 이 화면에 합칩니다.'))); return box; }
    const boards = d.devices.filter((x) => x.board);
    if (!boards.length) add(box, el('p', 'pnote', t('보드가 켜진 다른 컴퓨터가 없습니다.')));
    for (const x of boards) {
      const row = el('div', 'frow');
      const nm = el('div', 'fnm');
      add(nm, el('b', '', x.label || x.host), el('span', '', x.label ? x.host : x.os));
      add(row, nm);
      if (x.linked) add(row, el('span', 'pon', t('합쳐 보는 중')));
      else {
        const f = el('div', 'fcode');
        const inp = el('input');
        inp.placeholder = t('그 컴퓨터의 연결 코드');
        inp.setAttribute('autocapitalize', 'characters');
        inp.setAttribute('autocomplete', 'one-time-code');
        inp.setAttribute('aria-label', t('{0} 연결 코드', x.label || x.host));
        inp.value = S.find.codes[x.url] || '';
        inp.addEventListener('input', () => { S.find.codes[x.url] = inp.value; });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') findLink(x); });
        const go = el('button', 'go', S.find.busy === x.url ? t('붙이는 중…') : t('붙이기'));
        go.type = 'button';
        go.disabled = !!S.find.busy;
        go.addEventListener('click', () => findLink(x));
        add(f, inp, go);
        add(row, f);
      }
      add(box, row);
    }
    const others = d.devices.filter((x) => !x.board).length;
    const notes = [others && t('보드 없는 기기 {0}대', others), d.offline.length && t('꺼진 기기 {0}대', d.offline.length)].filter(Boolean).join(' · ');
    if (notes) add(box, el('p', 'pnote', notes));
    if (boards.some((x) => !x.linked)) add(box, el('p', 'pnote', t('코드는 붙일 컴퓨터에서 node cli.js pair 를 실행하면 나옵니다(10분·한 번만).')));
    return box;
  }

  // 화면 색 고르기(맨 아래): 자동(기기 설정) / 밝게 / 어둡게. 실제 적용은 theme.js
  function themeSwitch() {
    const box = el('div', 'themes');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', t('화면 색'));
    add(box, el('span', 'wl', t('화면')));
    const cur = window.sbTheme ? window.sbTheme.pref() : 'auto';
    for (const [v, lab] of [['auto', t('자동')], ['light', t('밝게')], ['dark', t('어둡게')]]) {
      const b = el('button', v === cur ? 'on' : '', lab);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(v === cur));
      b.addEventListener('click', () => { if (window.sbTheme) window.sbTheme.set(v); render(); });
      add(box, b);
    }
    return box;
  }
  // 언어 고르기(맨 아래·설정): 자동(브라우저 언어) / 한국어 / English. 고르면 다시 불러온다(모든 글을 새 언어로)
  function langSwitch() {
    const box = el('div', 'themes');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', t('언어'));
    add(box, el('span', 'wl', t('언어')));
    for (const [v, lab] of [['auto', t('자동')], ['ko', '한국어'], ['en', 'English']]) {
      const b = el('button', v === LANG_PREF ? 'on' : '', lab);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(v === LANG_PREF));
      if (v !== 'auto') b.lang = v;
      b.addEventListener('click', () => {
        if (v === LANG_PREF) return;
        LANG_PREF = v;
        syncLangCookie();
        location.reload();
      });
      add(box, b);
    }
    return box;
  }
  // ---------- 컴퓨터별로 따로 보기 ----------
  // 다른 컴퓨터 보드를 합쳤을 때(d.remotes) 머리의 컴퓨터 단추로 한 대씩 골라 본다. 고른 것은 이 기기에만 기억
  S.host = null;
  try { S.host = localStorage.getItem('sb.host') || null; } catch { /* 무시 */ }
  function hostList(d) {
    if (!d || !d.remotes || !d.remotes.length) return [];
    const waits = freshWaits(d);
    return [{ name: d.label, remote: false, off: false }, ...d.remotes.map((r) => ({ name: r.name, remote: true, off: !r.ok }))]
      .map((h) => ({ ...h, wait: waits.filter((a) => a.host === h.name).length }));
  }
  function view(d) {
    if (!d || !d.remotes || !d.remotes.length) return d;
    const names = hostList(d).map((h) => h.name);
    // 보고 있는 세션이 다른 컴퓨터 것이면(알림·주소로 바로 연 경우) 그 컴퓨터로 옮긴다
    const selSec = S.sel && d.sections.find((s) => s.sessions.some((x) => x.sid === S.sel));
    if (selSec && selSec.host !== S.host) S.host = selSec.host;
    if (!names.includes(S.host)) S.host = d.label;
    const h = S.host;
    const sections = d.sections.filter((s) => s.host === h);
    const live = sections.flatMap((s) => s.sessions);
    const attention = d.attention.filter((a) => a.host === h);
    const count = { wait: attention.length, work: 0, idle: 0, closed: 0 };
    for (const x of live) {
      if (x.status === 'work') count.work++;
      else if (x.status === 'idle' && x.turn !== 'ask') count.idle++;
      else if (x.status === 'closed') count.closed++;
    }
    return {
      ...d, sections, attention, count,
      closedAsks: (d.closedAsks || []).filter((a) => a.host === h),
      recent: (d.recent || []).filter((x) => x.host === h).map((x) => ({ ...x, bucket: String(x.bucket).replace(h + ' · ', '') })),
      recentFiles: d.recentFilesBy && d.recentFilesBy[h] != null ? d.recentFilesBy[h] : d.recentFiles,
      remotes: d.remotes.filter((r) => r.name === h),
      hostView: h,
    };
  }
  function setHost(name) {
    if (S.host === name) return;
    S.host = name;
    try { localStorage.setItem('sb.host', name); } catch { /* 무시 */ }
    // 다른 컴퓨터 세션을 열어 둔 채였으면 닫는다
    const full = S.data;
    const selSec = S.sel && full && full.sections.find((s) => s.sessions.some((x) => x.sid === S.sel));
    if (selSec && selSec.host !== name) { go(null); return; }
    window.scrollTo(0, 0);
    render();
  }

  function render() {
    S.pending = false;
    const full = S.data;
    if (full) syncSeen(full);
    const d = view(full);
    renderTop();
    document.body.classList.toggle('picked', !!S.sel);
    // 다시 그리기 전 자리: 세로 위치와 옆으로 넘긴 표·코드·diff 위치
    const y = window.scrollY;
    const xs = new Map();
    $app.querySelectorAll('[data-k]').forEach((n) => { if (n.scrollLeft) xs.set(n.dataset.k, n.scrollLeft); });
    $app.textContent = '';
    if (!d) { add($app, el('p', 'loading', S.failed ? t('서버에 연결하지 못했습니다. 10초마다 다시 시도합니다.') : t('불러오는 중…'))); return; }
    const side = el('div', 'side');
    const sum = el('div', 'sum');
    add(sum,
      add(el('span', 'chip'), el('span', 'dot d-wait'), document.createTextNode(t('대기 ')), el('b', '', freshWaits(d).length)),
      add(el('span', 'chip'), el('span', 'dot d-work'), document.createTextNode(t('작업 중 ')), el('b', '', d.count.work)),
      add(el('span', 'chip'), el('span', 'dot d-idle'), document.createTextNode(t('쉼 ')), el('b', '', d.count.idle)),
      add(el('span', 'chip'), document.createTextNode(t('최근 {0} 바뀐 파일', WIN_LABEL[d.win] || t('24시간')) + ' '), el('b', '', d.recentFiles)));
    const wide = !NARROW.matches;
    S.hiddenSids = new Set([...d.attention, ...(d.closedAsks || [])].filter((a) => S.dismissed.has(waitKey(a))).map((a) => a.sid));
    const wrap = el('div', 'wrap');
    if (wide && !S.sel) {
      // 넓은 화면에서 아무 세션도 안 골랐을 때: 왼쪽은 목록만, 오른쪽 넓은 자리에 대기 카드·방금 끝남
      add(side, renderList(d));
      add(wrap, side, renderDash(d));
    } else if (wide) {
      // 세션을 골랐을 때: 왼쪽 위에 대기 세션을 짧은 줄로만, 오른쪽은 세션 내용
      add(side, sum, miniWaits(d), renderList(d));
      add(wrap, side, renderDetail(d));
    } else {
      add(side, sum, ...renderAttention(d), renderList(d));
      add(wrap, side, renderDetail(d));
    }
    if (wide) {
      add($app, wrap);
      if (S.drawer) add($app, settingsDrawer(d));
    } else add($app, wrap, el('div', 'foot', t('읽기 전용 · {0} · 10초마다 갱신', d.hostView || d.label)));
    if (!S.sel && !wide) add($app, findBox(), pushRow(), themeSwitch(), langSwitch());
    if (S.hiddenSids.size && !S.sel && !wide) {
      const f = el('div', 'foot');
      const b = el('button', 'lnk', t('숨긴 대기 카드 {0}개 다시 보이기', S.hiddenSids.size));
      b.type = 'button';
      b.addEventListener('click', () => unhideAll(d));
      add(f, b);
      add($app, f);
    }
    if (d.error) add($app, el('div', 'foot', t('읽기 오류: {0}', d.error)));
    if (S.sel) add($app, bottomBar(d));
    $app.querySelectorAll('[data-k]').forEach((n) => { if (xs.has(n.dataset.k)) n.scrollLeft = xs.get(n.dataset.k); });
    // 세션을 새로 열면 맨 위로, 접은 화면에서 목록으로 돌아오면 보던 자리로, 같은 화면을 다시 그릴 때는 그대로
    const key = S.sel + ':' + S.tab;
    if (S.scrolled !== key) {
      const backToList = !S.sel && S.listY != null && NARROW.matches;
      S.scrolled = key;
      window.scrollTo(0, backToList ? S.listY : 0);
    } else window.scrollTo(0, y);
  }

  // ---------- 영어 글 ----------
  // 열쇠는 화면의 한국어 원문 그대로다. 새 글을 t('…')로 넣으면 여기에도 넣는다(시험이 빠진 것을 잡는다)
  function enTable() {
    return {
      '30분': '30 min', '1시간': '1 hour', '3시간': '3 hours', '12시간': '12 hours', '24시간': '24 hours',
      '{0}초': '{0} s', '{0}분': '{0} min',
      '방금': 'just now', '{0} 전': '{0} ago', '어제 ': 'Yesterday ',
      '새 내용': 'New', '새 내용 {0}': 'New {0}', '되돌리기': 'Undo', '모두 읽음': 'Mark all read',
      '대기 카드 {0}개를 숨겼습니다': 'Hid waiting cards ({0})', '대기 카드를 숨겼습니다': 'Hid the waiting card',
      '승인 기다림': 'Waiting for approval', '답 기다림': 'Waiting for answer', '결정 기다림': 'Waiting for decision',
      '쉼 · 할 일 없음': 'Idle · nothing to do', '닫힘 · 질문 남음': 'Closed · question left',
      '작업 중': 'Working', '쉼': 'Idle', '닫힘': 'Closed',
      'RC 꺼짐': 'RC off',
      '복사했습니다.': 'Copied.', '복사하지 못했습니다. 글을 길게 눌러 골라 주세요.': 'Could not copy. Press and hold the text to select it.',
      '복사': 'Copy', '코드 복사': 'Copy code',
      '연결 끊김 · {0} 전 정보': 'Disconnected · data from {0} ago', '연결 끊김 · 정보 없음': 'Disconnected · no data',
      '읽는 중': 'Loading', '읽기 멈춤 · {0} 전 정보': 'Reading stopped · data from {0} ago', '{0} 전 갱신': 'Updated {0} ago',
      '첫 화면으로': 'Go to the start screen', '세션 보드': 'Session Board', '볼 컴퓨터': 'Computer to view',
      '대기 {0}': 'waiting {0}', '작업 {0}': 'working {0}', '쉼 {0}': 'idle {0}', '닫힘 {0}': 'closed {0}',
      '연결 안 됨': 'Not connected', '설정': 'Settings', '설정 닫기': 'Close settings',
      '서버에 연결하지 못했습니다. 아래 내용은 {0} 전 것입니다.': 'Cannot reach the server. What you see is from {0} ago.',
      '서버에 연결하지 못했습니다. 아래 내용은 예전 것입니다.': 'Cannot reach the server. What you see is old.',
      '세션 읽기가 멈췄습니다. 아래 내용은 최신이 아닐 수 있습니다.': 'Session reading has stopped. What you see may be out of date.',
      '새로 기다리는 세션 {0}개': 'New waiting sessions: {0}', '다시 시도': 'Retry',
      '카드 숨김': 'Card hidden', '파일 {0}': 'Files {0}',
      '세션 목록': 'Session list', '전체 세션 {0}': 'All sessions {0}',
      '{0}: 연결 안 됨': '{0}: not connected', ' · {0} 정보로 보여 줍니다': ' · showing data from {0}', ' · 그 컴퓨터 세션은 지금 안 보입니다': ' · its sessions are hidden for now',
      '최근 세션이 없습니다.': 'No recent sessions.',
      '승인을 기다림': 'Waiting for your approval', '답을 기다림': 'Waiting for your answer', '결정을 기다림': 'Waiting for your decision', '기다림': 'Waiting',
      '{0} 카드 숨기기': 'Hide card: {0}', '{0} 세션 열기': 'Open session: {0}', '{0} 숨기기': 'Hide: {0}',
      '앱에서 답하기': 'Answer in the app', '앱에서 답하기#nav': 'Answer', '눌러서 보기': 'Tap to view', '모두 숨기기': 'Hide all',
      '오래된 대기 (12시간 넘음)': 'Old waits (over 12 hours)', '닫힌 채 남은 질문': 'Questions left in closed sessions',
      'VS Code가 다시 시작되는 등으로 꺼진 세션입니다. 답하려면 VS Code에서 그 세션을 다시 여세요.': 'These sessions ended, for example when VS Code restarted. To answer, reopen the session in VS Code.',
      '방금 끝남 (30분 안)': 'Just finished (last 30 min)', ' · 할 일 없음': ' · nothing to do',
      '최근 대화가 없습니다.': 'No recent conversation.', '최근 것이 위에 있습니다': 'Newest first',
      '도구 줄 접기': 'Fold tool lines', '도구 {0}개 더 보기': 'Show more tool lines ({0})', '나': 'Me',
      '전체 보기': 'Show all', '전체 보기#back': 'Overview',
      '불러오는 중…': 'Loading…', '이전 대화 10개 더 보기': 'Show 10 earlier messages',
      '명령 실행 결과와 생각 과정은 숨김 · 키·비밀번호 같은 값은 자동으로 가림': 'Command output and thinking are hidden · keys and passwords are masked automatically',
      '바뀐 내용을 읽지 못했습니다.': 'Could not read the changes.', '바뀐 줄 기록이 없습니다.': 'No line changes recorded.',
      '커밋#kind': 'Commit', '명령': 'Command', '편집': 'Edit', ' {0}번': ' ×{0}',
      '길어서 앞 400줄까지만 보여 줍니다.': 'Long change: showing the first 400 lines only.',
      '바뀐 파일 기간': 'Period for changed files', '최근': 'Last',
      '최근 {0} 동안 바뀐 파일이 없습니다.': 'No files changed in the last {0}.', ' (임시 {0})': ' (temp {0})',
      '커밋 안 함': 'Not committed', '삭제': 'Deleted', '새': 'New', '추정': 'Guessed', '커밋#chip': 'Committed', '수정': 'Modified',
      '임시 파일 접기': 'Fold temp files', '임시 파일 {0}개 보기 (scratchpad·tmp)': 'Show temp files ({0}, scratchpad, tmp)',
      '최근 {0} 동안 이 세션이 만든 커밋이 없습니다.': 'This session made no commits in the last {0}.', '(메시지 없음)': '(no message)',
      '이 커밋을 저장소에서 찾지 못했습니다.': 'This commit was not found in the repository.', '커밋 내용을 읽지 못했습니다.': 'Could not read the commit.',
      '그림 같은 이진 파일이라 줄 비교가 없습니다.': 'Binary file (such as an image): no line comparison.',
      '바뀐 줄이 없습니다(이름만 바뀜 등).': 'No changed lines (renamed only, etc.).', '길어서 일부만 보여 줍니다.': 'Long change: showing part of it.',
      '세션 내용': 'Session details', '세션을 누르면 대화와 바뀐 파일이 여기에 나옵니다.': 'Tap a session to see its conversation and changed files here.',
      '이 세션은 지금 목록에 없습니다.': 'This session is not in the list now.', '목록으로': 'Back to the list', '앱에서 열기': 'Open in the app',
      'Codex 세션입니다. 휴대폰에서는 보기만 되고, 답하려면 VS Code에서 이어 가세요.': 'This is a Codex session. You can only view it here; to answer, continue in VS Code.',
      '닫힌 세션입니다. 답하려면 VS Code에서 이 세션을 다시 여세요.': 'This session is closed. To answer, reopen it in VS Code.',
      '다시 보지 않기': "Don't show again", '휴대폰에서 답하려면 VS Code의 이 세션에서 /rc 를 입력하세요. ': 'To answer from your phone, type /rc in this session in VS Code. ',
      '이 세션을 읽지 못했습니다. 잠시 뒤 다시 시도합니다.': 'Could not read this session. Trying again shortly.',
      '줄': 'Lines', '바뀐 파일': 'Changed files', '커밋': 'Commits', '대화': 'Conversation', '대화#nav': 'Chat',
      '바뀐 파일 {0}': 'Changed files {0}', '커밋 {0}': 'Commits {0}',
      '세션 바로가기': 'Session shortcuts', '목록': 'List', '파일': 'Files',
      '전체 상황': 'Overview', '나를 기다림': 'Waiting for you', '최근 {0} 바뀐 파일': 'Files changed in the last {0}',
      '나를 기다리는 세션 {0}개': 'Sessions waiting for you: {0}', '지금 나를 기다리는 세션이 없습니다': 'No session is waiting for you',
      '지금 작업 중 · {0}': 'Working now · {0}', '작업 중인 세션이 없습니다.': 'No session is working.',
      '30분 안에 끝난 세션이 없습니다.': 'No session finished in the last 30 min.',
      '왼쪽 목록에서 세션을 누르면 대화와 바뀐 파일이 여기에 나옵니다. 단축키: j / k 세션 이동, Esc 닫기': 'Click a session on the left to see its conversation and changed files here. Shortcuts: j / k to move between sessions, Esc to close.',
      '숨긴 대기 카드 {0}개 다시 보이기': 'Show hidden waiting cards again ({0})', '읽기 전용 · 10초마다 갱신': 'Read-only · updates every 10 seconds',
      '이 기기로 알림을 받습니다. "시험"으로 확인해 보세요.': 'This device will get notifications. Press "Test" to check.',
      '알림을 켜지 못했습니다: {0}': 'Could not turn on notifications: {0}', '이 기기 알림을 껐습니다.': 'Notifications are off for this device.',
      '알림을 끄지 못했습니다: {0}': 'Could not turn off notifications: {0}',
      '시험 알림을 보냈습니다. 몇 초 안에 와야 합니다.': 'Test notification sent. It should arrive within a few seconds.',
      '푸시 서버가 받지 않았습니다({0}).': 'The push server did not accept it ({0}).', '시험 알림을 보내지 못했습니다: {0}': 'Could not send a test notification: {0}',
      '알림': 'Notifications', '이 브라우저는 알림을 받을 수 없습니다': 'This browser cannot receive notifications',
      '서버에서 알림을 껐습니다': 'Notifications are turned off on the server', '브라우저 설정에서 이 사이트 알림이 막혀 있습니다': 'Notifications for this site are blocked in browser settings',
      '켜짐': 'On', '시험': 'Test', '끄기': 'Turn off', '이 기기로 받기': 'Get them on this device',
      '대기가 생기고 {0} 안에 답이 없으면 울립니다. 누르면 그 세션이 열립니다': 'Rings when a session waits and gets no answer within {0}. Tap it to open that session.',
      '알림에 세션 이름: 보임': 'Session names in notifications: shown', '알림에 세션 이름: 숨김': 'Session names in notifications: hidden',
      '다음 알림부터 세션 이름이 보입니다(잠금 화면에도 보임).': 'From the next notification, session names are shown (also on the lock screen).',
      '다음 알림부터 개수만 보입니다.': 'From the next notification, only the count is shown.',
      '찾지 못했습니다: {0}': 'Could not search: {0}', '그 컴퓨터에서 받은 연결 코드를 넣어 주세요.': 'Enter the connection code from that computer.',
      '다시 연결했습니다: {0}. 위쪽 단추로 볼 수 있습니다.': 'Reconnected: {0}. Use the button at the top to view it.',
      '합쳤습니다: {0}. 위쪽 단추로 볼 수 있습니다.': 'Added: {0}. Use the button at the top to view it.',
      '붙이지 못했습니다: {0}': 'Could not add: {0}', '다른 서버': 'Other servers',
      '찾는 중…': 'Searching…', '다시 찾기': 'Search again', '내 사설망에서 찾기': 'Search my private network',
      '같은 Tailscale 사설망에서 보드가 켜진 컴퓨터를 찾아 이 화면에 합칩니다.': 'Finds computers running a board on the same Tailscale network and adds them to this screen.',
      '보드가 켜진 다른 컴퓨터가 없습니다.': 'No other computer is running a board.', '합쳐 보는 중': 'Added',
      '그 컴퓨터의 연결 코드': 'Connection code from that computer', '{0} 연결 코드': 'Connection code for {0}',
      '붙이는 중…': 'Adding…', '붙이기': 'Add', '보드 없는 기기 {0}대': 'Devices without a board: {0}', '꺼진 기기 {0}대': 'Offline devices: {0}',
      '코드는 붙일 컴퓨터에서 node cli.js pair 를 실행하면 나옵니다(10분·한 번만).': 'To get a code, run node cli.js pair on the computer you want to add (works once, for 10 minutes).',
      '화면 색': 'Theme', '화면': 'Theme', '자동': 'Auto', '밝게': 'Light', '어둡게': 'Dark', '언어': 'Language',
      '서버에 연결하지 못했습니다. 10초마다 다시 시도합니다.': 'Cannot reach the server. Retrying every 10 seconds.',
      '대기 ': 'Waiting ', '작업 중 ': 'Working ', '쉼 ': 'Idle ',
      '읽기 전용 · {0} · 10초마다 갱신': 'Read-only · {0} · updates every 10 seconds', '읽기 오류: {0}': 'Read error: {0}',
    };
  }

  // ---------- 시작 ----------
  document.documentElement.lang = LANG;
  document.title = t('세션 보드');
  syncLangCookie();
  readHash();
  render();
  loadState(true);
  if (S.sel) loadDetail();
  pushInit();
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    loadState();
    if (S.sel) loadDetail();
  }, 10000);
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { loadState(); if (S.sel) loadDetail(); } });
})();
