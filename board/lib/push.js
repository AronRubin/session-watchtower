'use strict';
// 휴대폰 알림(Web Push). "내용 없는 알림"만 보낸다.
// - 푸시 서버(안드로이드 크롬이면 구글 FCM)에는 "이 기기를 깨워라"는 신호만 가고 세션 이름·대화는 나가지 않는다.
// - 깨어난 휴대폰의 sw.js가 이 보드에 직접(쿠키로) 물어 "답을 기다리는 세션 n개"를 띄운다.
// - 서버 신원은 VAPID(ES256) 키로 밝힌다. 키와 구독 목록은 stateDir에 0600으로 둔다.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 알려진 푸시 서버만 받는다(연결된 기기라도 임의 주소로 서버가 요청을 보내게 하지 않음)
const ALLOWED_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
const MAX_SUBS = 20;

function validEndpoint(e) {
  if (typeof e !== 'string' || e.length > 1000) return false;
  try {
    const u = new URL(e);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password && ALLOWED_HOSTS.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}

function createPush(stateDir, opts = {}) {
  const keyFile = path.join(stateDir, 'vapid.json');
  const subFile = path.join(stateDir, 'push.json');
  const subject = opts.subject || 'mailto:session-board@localhost';
  const fetchFn = opts.fetch || ((...a) => globalThis.fetch(...a));

  function writeJson(file, data) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  let keyMemo = null;
  function keys() {
    if (keyMemo) return keyMemo;
    let k = readJson(keyFile, null);
    if (!k || typeof k.publicKey !== 'string' || typeof k.privatePem !== 'string') {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = publicKey.export({ format: 'jwk' });
      const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
      k = { publicKey: raw.toString('base64url'), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
      writeJson(keyFile, k);
    }
    keyMemo = { publicKey: k.publicKey, privateKey: crypto.createPrivateKey(k.privatePem) };
    return keyMemo;
  }

  // 푸시 서버마다(aud) 12시간짜리 서명을 만들어 1시간 동안 다시 쓴다
  const jwtCache = new Map();
  function authHeader(endpoint, now = Date.now()) {
    const aud = new URL(endpoint).origin;
    const hit = jwtCache.get(aud);
    if (hit && now - hit.at < 3600e3) return hit.value;
    const k = keys();
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject });
    const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: k.privateKey, dsaEncoding: 'ieee-p1363' });
    const value = `vapid t=${unsigned}.${sig.toString('base64url')}, k=${k.publicKey}`;
    jwtCache.set(aud, { at: now, value });
    return value;
  }

  function list() {
    const d = readJson(subFile, { subs: [] });
    return Array.isArray(d.subs) ? d.subs.filter((s) => s && validEndpoint(s.endpoint) && typeof s.deviceId === 'string') : [];
  }

  function subscribe(deviceId, endpoint, now = Date.now()) {
    if (!validEndpoint(endpoint) || !deviceId) return false;
    const subs = list().filter((s) => s.endpoint !== endpoint);
    subs.push({ deviceId, endpoint, created: now });
    writeJson(subFile, { subs: subs.slice(-MAX_SUBS) });
    return true;
  }

  // 이 기기의 구독만 지운다(다른 기기 구독은 못 지움). endpoint를 안 주면 이 기기 것 전부
  function unsubscribe(deviceId, endpoint) {
    const subs = list();
    const keep = subs.filter((s) => !(s.deviceId === deviceId && (!endpoint || s.endpoint === endpoint)));
    if (keep.length !== subs.length) writeJson(subFile, { subs: keep });
    return subs.length - keep.length;
  }

  async function sendOne(endpoint) {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { TTL: '600', Urgency: 'high', Authorization: authHeader(endpoint) },
      body: '',
      signal: AbortSignal.timeout(10000),
    });
    return res.status;
  }

  // liveDevices: 지금 연결돼 있는 기기 id 모음(연결을 끊은 기기 구독은 보내지 않고 지운다)
  // only: 이 기기에만 보낼 때(시험 알림)
  async function sendAll(liveDevices, only) {
    const subs = list();
    const drop = new Set();
    const out = [];
    for (const s of subs) {
      if (!liveDevices.has(s.deviceId)) { drop.add(s.endpoint); continue; }
      if (only && s.deviceId !== only) continue;
      let status = 0;
      try { status = await sendOne(s.endpoint); } catch { status = -1; }
      // 404·410: 휴대폰이 구독을 버림(앱 삭제·권한 해제 등) → 지운다
      if (status === 404 || status === 410) drop.add(s.endpoint);
      out.push({ deviceId: s.deviceId, host: new URL(s.endpoint).hostname, status });
    }
    if (drop.size) writeJson(subFile, { subs: list().filter((s) => !drop.has(s.endpoint)) });
    return { results: out, removed: drop.size };
  }

  return { publicKey: () => keys().publicKey, subscribe, unsubscribe, list, sendAll, authHeader };
}

// 새 대기를 알릴지 정한다. 대기가 생기고 delayMs 동안 그대로면 알린다(PC 앞에서 바로 답하면 휴대폰이 울리지 않게).
// 같은 대기(세션:시작 시각)는 한 번만 알리고, 알림끼리는 gapMs 이상 띄운다(몰리면 하나로 합침).
function createNotifier({ delayMs = 60000, gapMs = 30000 } = {}) {
  let first = true;
  const pending = new Map(); // key -> 처음 본 시각
  const notified = new Map(); // key -> 알린 시각
  let lastFire = 0;
  let owed = false;
  // keys: 지금 대기 목록의 키 모음. 알릴 때가 되면 true
  function step(keys, now = Date.now()) {
    if (first) { first = false; for (const k of keys) notified.set(k, now); return false; }
    for (const k of keys) if (!notified.has(k) && !pending.has(k)) pending.set(k, now);
    let due = false;
    for (const [k, t] of pending) {
      if (!keys.has(k)) { pending.delete(k); continue; } // 그 사이에 답함
      if (now - t >= delayMs) { pending.delete(k); notified.set(k, now); due = true; }
    }
    for (const [k, t] of notified) if (!keys.has(k) && now - t > 24 * 3600e3) notified.delete(k);
    if (due) owed = true;
    if (owed && now - lastFire >= gapMs) { owed = false; lastFire = now; return true; }
    return false;
  }
  return { step };
}

module.exports = { createPush, createNotifier, validEndpoint, ALLOWED_HOSTS };
