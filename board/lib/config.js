'use strict';
// 설정은 환경 변수로 받는다(systemd 서비스 파일이나 셸에서 넘긴다). 값이 없으면 아래 기본값.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

// Session Watchtower 그룹 파일 폴더: 원격 서버(VS Code Server)·Windows·맥·리눅스 데스크톱 순서로 있는 곳을 쓴다
function watchtowerDir(env = process.env, platform = process.platform, exists = fs.existsSync) {
  const id = 'kms-labs.session-watchtower';
  const c = [path.join(HOME, '.vscode-server', 'data', 'User', 'globalStorage', id)];
  if (platform === 'win32' && env.APPDATA) c.unshift(path.join(env.APPDATA, 'Code', 'User', 'globalStorage', id));
  if (platform === 'darwin') c.push(path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', id));
  c.push(path.join(HOME, '.config', 'Code', 'User', 'globalStorage', id));
  return c.find((d) => exists(d)) || c[0];
}

// "85번 서버=https://a.b.ts.net,다른 이름=https://..." → [{ name, url }]  (https만 받는다)
function parsePeers(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.indexOf('=');
    if (i <= 0) return null;
    const name = x.slice(0, i).trim().slice(0, 30);
    const url = x.slice(i + 1).trim();
    return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(url) ? { name, url } : null;
  }).filter(Boolean);
}

function loadConfig(env = process.env) {
  const WT = watchtowerDir(env);
  return {
    host: env.BOARD_HOST || '127.0.0.1',
    port: Number(env.BOARD_PORT) || 5290,
    label: (env.BOARD_LABEL || os.hostname()).slice(0, 30),
    peers: parsePeers(env.BOARD_PEERS),
    stateDir: env.BOARD_STATE_DIR || path.join(HOME, '.config', 'session-board'),
    groupsFile: env.BOARD_GROUPS_FILE || path.join(WT, 'session-groups.json'),
    archiveFile: env.BOARD_ARCHIVE_FILE || path.join(WT, 'archived-sessions.json'),
    attentionDir: env.BOARD_ATTENTION_DIR || path.join(HOME, '.cache', 'claude-attention'),
    registryDir: env.BOARD_REGISTRY_DIR || path.join(HOME, '.claude', 'sessions'),
    lookbackHours: Number(env.BOARD_LOOKBACK_HOURS) || 24,
    closedHours: Number(env.BOARD_CLOSED_HOURS) || 6,
    // 24시간보다 오래 쉰 세션도 제목·마지막 시각만 가볍게 읽어 둔다(그룹 세션이 목록에서 빠지지 않게).
    // Claude Code가 세션을 자동 보관하는 기준과 같은 14일이 기본
    listDays: Math.max(0, Number(env.BOARD_LIST_DAYS ?? 14) || 0),
    scanMs: Math.max(3000, Number(env.BOARD_SCAN_MS) || 10000),
    // https 뒤(tailscale serve)에서만 쿠키에 Secure를 붙인다. 사내망 http로 시험할 때는 끈다
    secureCookie: env.BOARD_SECURE_COOKIE === '1',
    // 휴대폰 알림: 대기가 생기고 이 시간(초) 동안 답이 없으면 알린다. 0이면 알림을 아예 보내지 않는다
    pushDelayS: Math.max(0, Number(env.BOARD_PUSH_DELAY_S ?? 60) || 0),
    // 푸시 서버에 밝히는 연락처(VAPID sub). 개인 메일 주소를 넣지 않는 기본값
    pushSubject: /^(mailto:|https:\/\/)/.test(env.BOARD_PUSH_SUBJECT || '') ? env.BOARD_PUSH_SUBJECT : 'mailto:session-board@localhost',
  };
}

module.exports = { loadConfig, parsePeers, watchtowerDir };
