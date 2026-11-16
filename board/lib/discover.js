'use strict';
// 내 Tailscale 사설망에서 보드가 켜진 컴퓨터를 찾는다(블루투스 "주변 기기 찾기"처럼).
// 찾기만 한다. 붙이는 허락(연결 코드)은 그 컴퓨터에서 따로 받아야 한다.

const { execFile } = require('child_process');

// tailscale status --json → { self: { dns, host, os }, peers: [{ dns, host, os, online }] }
function tailnetDevices() {
  return new Promise((resolve, reject) => {
    execFile('tailscale', ['status', '--json'], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(new Error('tailscale 상태를 읽지 못했습니다(설치·로그인 확인)'));
      try {
        const st = JSON.parse(out);
        const one = (n) => ({ dns: String(n.DNSName || '').replace(/\.$/, ''), host: String(n.HostName || ''), os: String(n.OS || ''), online: !!n.Online });
        resolve({ self: one(st.Self || {}), peers: Object.values(st.Peer || {}).map(one).filter((p) => p.dns) });
      } catch {
        reject(new Error('tailscale 상태 모양이 다릅니다'));
      }
    });
  });
}

// 보드인지: /healthz가 X-Session-Board: 1 머리를 주면 보드다. 이름은 X-Session-Board-Label
async function probe(dns, fetchFn) {
  if (!/^[A-Za-z0-9.-]+$/.test(dns)) return null;
  try {
    const r = await fetchFn('https://' + dns + '/healthz', { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    if (r.headers.get('x-session-board') !== '1') return null;
    let label = '';
    try { label = decodeURIComponent(r.headers.get('x-session-board-label') || ''); } catch { label = ''; }
    return { label: label.slice(0, 30) };
  } catch {
    return null;
  }
}

// linked: 이미 합친 보드([{ id, url }]). devices·fetch는 시험에서 바꿔 넣는다
async function discover({ linked = [], devices, fetch: fetchFn } = {}) {
  const f = fetchFn || ((...a) => globalThis.fetch(...a));
  const d = devices || (await tailnetDevices());
  const found = await Promise.all(d.peers.filter((p) => p.online).map(async (p) => {
    const url = 'https://' + p.dns;
    const b = await probe(p.dns, f);
    const r = linked.find((x) => String(x.url).replace(/\/$/, '') === url);
    return { host: p.host, os: p.os, url, board: !!b, label: b ? b.label : '', linked: r ? r.id : null };
  }));
  // 보드가 있는 것 먼저, 그다음 이름순
  found.sort((a, b) => Number(b.board) - Number(a.board) || a.host.localeCompare(b.host));
  return { self: { host: d.self.host, url: d.self.dns ? 'https://' + d.self.dns : '' }, devices: found, offline: d.peers.filter((p) => !p.online).map((p) => ({ host: p.host, os: p.os })) };
}

module.exports = { discover, tailnetDevices, probe };
