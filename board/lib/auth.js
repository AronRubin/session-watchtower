'use strict';
// 휴대폰 연결(짝짓기)과 기기 토큰.
// - 짝짓기 코드: 서버에서 `node cli.js pair`로 만든다. 10분 동안 한 번만 쓸 수 있다.
// - 기기 토큰: 짝짓기에 성공한 브라우저에 쿠키로 준다. 파일에는 sha256만 남긴다.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAIR_TTL_MS = 10 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자(0·O·1·I·L) 뺌

function sha(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function safeEqual(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createStore(stateDir) {
  const pairFile = path.join(stateDir, 'pair.json');
  const devFile = path.join(stateDir, 'devices.json');

  function ensureDir() {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(stateDir, 0o700); } catch { /* 무시 */ }
  }

  function writeJson(file, data) {
    ensureDir();
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  function createPairCode(now = Date.now()) {
    const bytes = crypto.randomBytes(10);
    let code = '';
    for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
    writeJson(pairFile, { hash: sha(code).toString('hex'), exp: now + PAIR_TTL_MS });
    return { code, exp: now + PAIR_TTL_MS };
  }

  // 맞으면 코드를 지우고 true. 틀리거나 만료되면 false(만료된 코드는 지운다)
  function consumePairCode(code, now = Date.now()) {
    const p = readJson(pairFile, null);
    if (!p || typeof p.hash !== 'string' || !(p.exp > 0)) return false;
    if (now > p.exp) { try { fs.unlinkSync(pairFile); } catch { /* 무시 */ } return false; }
    const want = Buffer.from(p.hash, 'hex');
    const got = sha(String(code || '').trim().toUpperCase());
    if (!safeEqual(want, got)) return false;
    try { fs.unlinkSync(pairFile); } catch { /* 무시 */ }
    return true;
  }

  function devices() {
    const d = readJson(devFile, { devices: [] });
    return Array.isArray(d.devices) ? d.devices : [];
  }

  function issueDevice(label, now = Date.now()) {
    const token = crypto.randomBytes(32).toString('base64url');
    const list = devices();
    list.push({ id: crypto.randomBytes(4).toString('hex'), hash: sha(token).toString('hex'), label: String(label || '').slice(0, 120), created: now, lastSeen: now });
    writeJson(devFile, { devices: list });
    return token;
  }

  const lastSeenSave = new Map(); // 기기 id → 마지막으로 적은 시각(자주 묻는 기기가 다른 기기 기록을 막지 않게 기기별로)
  // 토큰이 맞으면 기기 id, 아니면 null
  function checkToken(token, now = Date.now()) {
    if (!token || typeof token !== 'string' || token.length > 200) return null;
    const got = sha(token);
    const list = devices();
    let hit = null;
    for (const d of list) {
      if (typeof d.hash !== 'string' || d.hash.length !== 64) continue;
      if (safeEqual(Buffer.from(d.hash, 'hex'), got)) hit = d;
    }
    if (!hit) return null;
    if (now - (lastSeenSave.get(hit.id) || 0) > 5 * 60 * 1000) {
      hit.lastSeen = now;
      try { writeJson(devFile, { devices: list }); lastSeenSave.set(hit.id, now); } catch { /* 무시 */ }
    }
    return hit.id;
  }

  function revoke(id) {
    const list = devices();
    const keep = id === 'all' ? [] : list.filter((d) => d.id !== id);
    writeJson(devFile, { devices: keep });
    return list.length - keep.length;
  }

  return { createPairCode, consumePairCode, issueDevice, checkToken, devices, revoke, PAIR_TTL_MS };
}

module.exports = { createStore };
