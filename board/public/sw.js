'use strict';
// 휴대폰 알림 받기. 푸시는 내용 없이 오고(깨우기 신호), 여기서 보드에 직접 물어 글자를 정한다.
// 화면 내용은 저장하지 않는다(오프라인 캐시 없음). 알림을 누르면 기다리는 세션을 바로 연다.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function getJson(u) {
  const r = await fetch(u, { credentials: 'same-origin', cache: 'no-store' });
  return r.ok ? r.json() : null;
}

// 화면에서 고른 알림 설정(세션 이름 보이기). 페이지가 Cache Storage에 적어 둔다
async function prefs() {
  try {
    const c = await caches.open('sb-prefs');
    const r = await c.match('/__sb_prefs');
    return r ? await r.json() : {};
  } catch {
    return {};
  }
}

async function show() {
  let title = '세션 보드';
  let body = '답을 기다리는 세션이 있습니다.';
  let tag = 'sb-wait';
  let url = '/';
  try {
    const [st, last, pf] = await Promise.all([getJson('/api/state'), getJson('/api/push/last'), prefs()]);
    if (st && st.label) title = '세션 보드 · ' + st.label;
    if (last && last.kind === 'test' && Date.now() - last.at < 120000) {
      body = '시험 알림입니다. 이 기기로 알림이 잘 옵니다.';
      tag = 'sb-test';
    } else if (st) {
      // 화면과 같게 12시간 넘은 대기는 빼고 센다(새로 생긴 대기가 아니므로). 전부 오래됐으면 그대로
      const all = (st.attention || []).slice().sort((a, b) => (b.since || 0) - (a.since || 0));
      const fresh = all.filter((a) => Date.now() - (a.since || 0) < 12 * 3600e3);
      const list = fresh.length ? fresh : all;
      const n = list.length;
      if (!n) body = '기다리던 세션은 그 사이에 끝났습니다.';
      else {
        // 가장 최근에 기다리기 시작한 세션을 연다
        url = '/#s=' + encodeURIComponent(list[0].sid);
        if (pf.names) {
          // 사용자가 켠 경우에만 세션 이름을 보인다(잠금 화면에도 보임)
          if (list[0].host) title = '세션 보드 · ' + list[0].host;
          body = String(list[0].title || '세션').slice(0, 80) + (n > 1 ? ` 외 ${n - 1}개` : '') + ' · 답을 기다림';
        } else {
          body = `답을 기다리는 세션 ${n}개`;
        }
      }
    }
  } catch { /* 보드에 못 닿으면 기본 글자 */ }
  return self.registration.showNotification(title, { body, tag, renotify: true, icon: '/icon-192.png', badge: '/badge-96.png', data: { url } });
}

self.addEventListener('push', (e) => e.waitUntil(show()));

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (new URL(c.url).origin !== self.location.origin) continue;
      // 열려 있는 보드 창을 앞으로 가져오고 그 세션을 열라고 알린다
      if ('focus' in c) await c.focus();
      c.postMessage({ type: 'open', url });
      return undefined;
    }
    return self.clients.openWindow(url);
  })());
});
