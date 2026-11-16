'use strict';
// 화면 색(밝게·어둡게)을 그리기 전에 정한다. <head>에서 바로 실행돼 어두운 화면이 번쩍이지 않는다.
// 고른 값은 이 기기에만 저장한다: auto(기기 설정 따름, 기본) / light / dark
(function () {
  const KEY = 'sb.theme';
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function pref() {
    try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'auto'; } catch { return 'auto'; }
  }
  function apply() {
    const p = pref();
    const t = p === 'auto' ? (mq && mq.matches ? 'light' : 'dark') : p;
    document.documentElement.dataset.theme = t;
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'light' ? '#ffffff' : '#111318');
  }
  function set(v) {
    try { if (v === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch { /* 무시 */ }
    apply();
  }
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  window.sbTheme = { pref, set };
  apply();
})();
