'use strict';
// 서버가 보내는 안내 글(연결 화면·오류 문장)의 영어판.
// 언어는 사용자가 화면에서 고른 것(쿠키 sb_lang) → 브라우저 언어(Accept-Language) 순서로 정한다.
// 브라우저 언어가 한국어면 한국어, 다른 언어면 영어. 언어 정보가 없으면(명령줄 도구 등) 지금처럼 한국어

const EN = {
  // 연결 화면
  '잠시 뒤에 다시': 'Try again later',
  '시도가 너무 많습니다. 10분 뒤에 새 코드로 다시 해 주세요.': 'Too many tries. Wait 10 minutes and try again with a new code.',
  'Chrome에서 열어 주세요': 'Open this in Chrome',
  '앱 안의 브라우저에서는 연결이 Chrome에 저장되지 않습니다. 이 주소를 복사해 Chrome 주소창에 붙여 넣어 열어 주세요. 코드는 아직 쓰지 않았으니 같은 링크를 그대로 쓰면 됩니다.':
    'A browser inside an app does not save the connection to Chrome. Copy this address, paste it into the Chrome address bar and open it. The code has not been used yet, so the same link still works.',
  '연결 코드가 맞지 않습니다': 'The connection code does not match',
  '코드가 틀렸거나 10분이 지났거나 이미 쓴 코드입니다. 서버에서 <code>node cli.js pair</code>로 새 코드를 받아 아래에 넣어 주세요.':
    'The code is wrong, more than 10 minutes old, or already used. Get a new code with <code>node cli.js pair</code> on the server and enter it below.',
  '연결이 필요합니다': 'Connection needed',
  '이 기기는 아직 연결되지 않았습니다. 서버에서 <code>node cli.js pair</code>로 받은 링크를 이 기기에서 열거나, 거기 나온 코드를 아래에 넣어 주세요. VS Code를 쓰면 Session Watchtower 확장의 휴대폰 단추로도 연결 링크·QR·코드를 만들 수 있습니다.':
    'This device is not connected yet. Open the link from <code>node cli.js pair</code> on the server on this device, or enter the code it shows below. If you use VS Code, the phone button of the Session Watchtower extension also makes the link, QR code and code.',
  '연결 코드 (링크를 통째로 붙여 넣어도 됩니다)': 'Connection code (you can paste the whole link)',
  '예: K7Q2XPMB4D': 'e.g. K7Q2XPMB4D',
  '연결': 'Connect',
  // 화면에 보이는 오류 문장
  '찾은 목록에 없는 주소입니다. 다시 찾기를 눌러 주세요': 'That address is not in the list that was found. Press "Search again".',
  '코드 모양이 아닙니다': 'That does not look like a code',
  '연결 링크 모양이 아닙니다(https://…/pair?c=코드)': 'That does not look like a connection link (https://…/pair?c=CODE)',
  '코드가 틀렸거나 10분이 지났거나 이미 쓴 코드입니다. 그 서버에서 새 링크를 만드세요': 'The code is wrong, more than 10 minutes old, or already used. Make a new link on that server.',
  'tailscale 상태를 읽지 못했습니다(설치·로그인 확인)': 'Could not read the Tailscale status (check that it is installed and signed in)',
  'tailscale 상태 모양이 다릅니다': 'The Tailscale status looks different than expected',
};

// 앞뒤에 바뀌는 값이 붙는 문장
const EN_RE = [
  [/^그 서버 보드에 닿지 못했습니다\((.*)\)\. 그 서버에서 보드와 tailscale serve가 켜져 있는지 확인하세요$/s, 'Could not reach the board on that server ($1). Check that the board and tailscale serve are running there.'],
  [/^합치기 실패\(HTTP (\d+)\)$/, 'Adding failed (HTTP $1)'],
];

function langOf(req) {
  const h = (req && req.headers) || {};
  const c = /(?:^|;\s*)sb_lang=(ko|en)(?:;|$)/.exec(String(h.cookie || ''));
  if (c) return c[1];
  // 가장 앞의 실제 언어 하나만 본다('*'은 건너뜀). 브라우저는 좋아하는 순서대로 보낸다
  for (const part of String(h['accept-language'] || '').split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase();
    if (!tag || tag === '*') continue;
    return tag === 'ko' || tag.startsWith('ko-') ? 'ko' : 'en';
  }
  return 'ko';
}

function tr(lang, ko) {
  if (lang !== 'en' || typeof ko !== 'string') return ko;
  if (EN[ko]) return EN[ko];
  for (const [re, out] of EN_RE) if (re.test(ko)) return ko.replace(re, out);
  return ko;
}

module.exports = { langOf, tr, EN };
