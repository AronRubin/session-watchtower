'use strict';
// 대화 기록(jsonl)에서 휴대폰 보드에 보여 줄 것만 뽑는다.
// - 내가 쓴 말, Claude가 쓴 글, 실행한 도구 한 줄 요약만 돌려준다.
// - 도구 실행 결과와 Claude의 생각 과정은 돌려주지 않는다.
// - 돌려주는 모든 글은 maskSecrets()를 거친다.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MASK = '●●●●●● (가림)';

// 키·비밀번호처럼 보이는 값을 가린다. 앞의 이름(password= 등)은 남기고 값만 가린다.
const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => MASK],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, () => MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, () => MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, () => MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, () => MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, () => MASK],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, () => MASK],
  [/(authorization\s*[:=]\s*)(?:(bearer|basic|token)\s+)?["']?[^\s"']{4,}/gi, (m, a, b) => a + (b ? b + ' ' : '') + MASK],
  [/(--(?:pat|token|password|passwd|api-key|apikey|secret|client-secret)(?:=|\s+))(["']?)[^\s"']+\2/gi, (m, a) => a + MASK],
  [/((?:password|passwd|pwd|secret|client_secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[=:]\s*)(["']?)[^\s"';,&]{4,}\2/gi, (m, a) => a + MASK],
];

function maskSecrets(text) {
  let t = String(text == null ? '' : text);
  for (const [re, fn] of SECRET_RULES) t = t.replace(re, fn);
  return t;
}

// 파일의 offset 위치에서 length 바이트를 읽어 JSON 한 줄로 푼다(Watchtower의 readRecord와 같은 일)
function readRecord(file, offset, length) {
  if (!file || !(offset >= 0) || !(length > 0) || length > 64 * 1024 * 1024) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, offset);
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 무시 */ }
  }
}

// 파일 끝에서 maxBytes만 읽어 완전한 줄만 돌려준다
function tailLines(file, maxBytes) {
  return tailLinesInfo(file, maxBytes).lines;
}

// 끝에서 maxBytes만 읽은 줄과, 파일 처음까지 닿았는지
function tailLinesInfo(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // 잘린 첫 줄
    return { lines: lines.filter(Boolean), fromStart: start === 0 };
  } catch {
    return { lines: [], fromStart: true };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 무시 */ }
  }
}

// Claude Code가 끼워 넣은 덩어리를 걷어 낸 "내가 친 말" (Watchtower scanner의 cleanPrompt와 같은 규칙, 줄바꿈은 살린다)
const INJECTED_RE = /<(system-reminder|ide_opened_file|ide_selection|local-command-stdout|local-command-stderr|local-command-caveat|command-message|command-args|task-notification|browser_instruction)[^>]*>[\s\S]*?<\/\1>/g;
const NOT_TYPED_RE = /^(\[Request interrupted by user|This session is being continued from a previous conversation|Caveat: The messages below were generated)/;

function cleanUserText(text) {
  // 붙여 넣은 글 표시(<pasted_content …>)는 꼬리표만 걷고 안의 글은 남긴다
  let t = String(text || '').replace(INJECTED_RE, ' ').replace(/<\/?pasted_content[^>]*>/g, '');
  t = t.replace(/<command-name>([^<]*)<\/command-name>/g, '$1 ');
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!t || NOT_TYPED_RE.test(t)) return '';
  return t;
}

function oneLine(s, n) {
  const t = String(s || '').split('\n')[0].replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// 도구 호출 한 줄 요약(Watchtower scanner의 summarizeInput을 바탕으로, 질문 도구를 더함)
function toolSummary(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Bash': return oneLine(i.description || i.command, 120);
    case 'Edit': case 'Write': case 'MultiEdit': case 'Read': return base(i.file_path);
    case 'NotebookEdit': return base(i.notebook_path || i.file_path);
    case 'Grep': case 'Glob': return oneLine(i.pattern, 80);
    case 'Agent': case 'Task': return oneLine(i.description || i.subagent_type, 80);
    case 'WebSearch': return oneLine(i.query, 80);
    case 'WebFetch': try { return new URL(String(i.url)).host; } catch { return ''; }
    case 'Skill': return oneLine(i.skill, 60);
    case 'AskUserQuestion': return oneLine(firstQuestion(i), 120);
    default: return '';
  }
}

function firstQuestion(input) {
  const qs = input && Array.isArray(input.questions) ? input.questions : [];
  return qs.length && qs[0] && typeof qs[0].question === 'string' ? qs[0].question : '';
}

// ---------- Codex 기록(rollout-*.jsonl) ----------
// Codex가 사용자 말 앞에 끼워 넣는 글(작업 환경·AGENTS.md·플러그인 안내 등)은 사용자가 친 말이 아니므로 뺀다
const CODEX_INJECTED_RE = /^\s*(<(environment_context|user_instructions|recommended_plugins|permissions|turn_aborted|user_shell_command|external_codex_apps_[a-z0-9_]+)\b|# AGENTS\.md instructions|# Files mentioned by the user|# Context from my IDE setup)/;
// Codex 도구 이름을 Claude 쪽 이름으로 맞춰 같은 그림·같은 판정(질문 도구)을 쓴다
const CODEX_TOOL = { exec: 'Bash', shell: 'Bash', local_shell: 'Bash', exec_command: 'Bash', apply_patch: 'Edit', request_user_input_async: 'AskUserQuestion', request_user_input: 'AskUserQuestion' };
function codexToolSummary(name, input) {
  const raw = typeof input === 'string' ? input : input != null ? JSON.stringify(input) : '';
  if (name === 'exec' || name === 'exec_command') {
    // 입력은 `await exec({cmd:"…"})` 같은 짧은 코드다. 첫 cmd 글만 보여 준다
    const m = /\bcmd\s*:\s*"((?:\\.|[^"\\])*)"/.exec(raw) || /"cmd"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(raw);
    if (m) { try { return oneLine(JSON.parse('"' + m[1] + '"'), 120); } catch { return oneLine(m[1], 120); } }
    return oneLine(raw, 120);
  }
  if (name === 'shell' || name === 'local_shell') {
    try { const j = typeof input === 'string' ? JSON.parse(input) : input; const c = j && (j.command || (j.exec && j.exec.command)); return oneLine(Array.isArray(c) ? c.join(' ') : c, 120); } catch { return oneLine(raw, 120); }
  }
  if (name === 'apply_patch') {
    const files = [...raw.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n]+)/g)].map((m) => path.basename(m[1].trim()));
    return oneLine(files.join(', ') || raw, 120);
  }
  if (CODEX_TOOL[name] === 'AskUserQuestion') {
    try { const j = typeof input === 'string' ? JSON.parse(input) : input; return oneLine(firstQuestion(j), 120); } catch { return ''; }
  }
  return oneLine(raw, 80);
}
function codexItem(o, ts) {
  const p = o.payload;
  if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant') && Array.isArray(p.content)) {
    const texts = p.content.filter((x) => x && typeof x.text === 'string' && /^(input_text|output_text|text)$/.test(x.type)).map((x) => x.text);
    let text = (p.role === 'user' ? texts.filter((t) => !CODEX_INJECTED_RE.test(t)) : texts).join('\n').trim();
    if (p.role === 'user') {
      text = cleanUserText(text);
      const images = p.content.filter((x) => x && x.type === 'input_image').length;
      if (images) text = (text ? text + '\n' : '') + `[사진 ${images}장]`;
    }
    return text ? { role: p.role, ts, text: maskSecrets(text).slice(0, TEXT_MAX) } : null;
  }
  if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
    const name = String(p.name || (p.type === 'local_shell_call' ? 'local_shell' : 'tool'));
    return { role: 'tool', ts, name: CODEX_TOOL[name] || name, text: maskSecrets(codexToolSummary(name, p.input != null ? p.input : p.arguments != null ? p.arguments : p.action)) };
  }
  return null; // 생각·도구 결과·토큰 수·개발자 지시는 보여 주지 않는다
}

const TEXT_MAX = 8000;

// 기록 끝부분 → [{ role: 'user'|'assistant'|'tool', ts, text, name? }]
const TAIL_STEPS = [3, 12, 32].map((m) => m * 1024 * 1024);

// withMeta면 { items, more }: more는 이보다 앞선 대화가 더 있는지(화면의 "이전 대화 더 보기")
function conversationTail(file, limit, withMeta) {
  const max = Math.max(1, limit || 40);
  const items = [];
  const parse = (ls) => {
    items.length = 0;
    for (const line of ls) {
      if (line.length > 4 * 1024 * 1024) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o || o.isSidechain || o.isMeta) continue;
      const ts = Date.parse(o.timestamp) || 0;
      if (o.type === 'user' && o.message) {
        const c = o.message.content;
        let text = '';
        let images = 0;
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) {
          if (c.some((x) => x && x.type === 'tool_result')) continue; // 도구 결과는 보여 주지 않는다
          text = c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n');
          images = c.filter((x) => x && x.type === 'image').length;
        }
        text = cleanUserText(text);
        if (images) text = (text ? text + '\n' : '') + `[사진 ${images}장]`;
        if (!text) continue;
        items.push({ role: 'user', ts, text: maskSecrets(text).slice(0, TEXT_MAX) });
      } else if (o.type === 'response_item' && o.payload && typeof o.payload === 'object') {
        const it = codexItem(o, ts);
        if (it) items.push(it);
      } else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
        const mid = o.message.id || null;
        for (const x of o.message.content) {
          if (!x) continue;
          if (x.type === 'text' && typeof x.text === 'string' && x.text.trim()) {
            const prev = items[items.length - 1];
            if (prev && prev.role === 'assistant' && mid && prev.mid === mid) prev.text = (prev.text + '\n\n' + maskSecrets(x.text)).slice(0, TEXT_MAX);
            else items.push({ role: 'assistant', ts, mid, text: maskSecrets(x.text).slice(0, TEXT_MAX) });
          } else if (x.type === 'tool_use' && typeof x.name === 'string') {
            items.push({ role: 'tool', ts, name: x.name, text: maskSecrets(toolSummary(x.name, x.input)) });
          }
        }
      }
    }
  };
  // 끝부분이 큰 도구 결과로 차 있거나 더 앞의 대화를 달라고 하면, 읽는 범위를 단계적으로 넓힌다(최대 32MB)
  let reached = false;
  let step = 0;
  for (; step < TAIL_STEPS.length; step++) {
    const r = tailLinesInfo(file, TAIL_STEPS[step]);
    parse(r.lines);
    reached = r.fromStart;
    if (reached || items.filter((x) => x.role !== 'tool').length > max) break;
  }
  // 끝에서부터 말(내 말·Claude 글) max개까지. 그 사이의 도구 줄은 함께 두되 전체는 300줄로 자른다
  let talk = 0;
  let start = items.length;
  while (start > 0 && items.length - start < 300) {
    const it = items[start - 1];
    if (it.role !== 'tool') { if (talk >= max) break; talk++; }
    start--;
  }
  const out = items.slice(start).map(({ mid, ...rest }) => rest);
  if (!withMeta) return out;
  // 읽은 범위 안에 더 앞선 말이 있거나, 파일 처음에 못 닿았고 아직 더 넓게 읽을 수 있으면 "더 있음"
  return { items: out, more: start > 0 || (!reached && step < TAIL_STEPS.length - 1) };
}

// 쉬고 있는 세션의 마지막 Claude 글이 사용자에게 무엇을 남겼는지
//  'none': 할 일이 없다고 말함(흐리게)   'ask': 질문·요청·결정 기다림(내 차례)   null: 알 수 없음
// 마지막 두 줄만 본다. 세션들은 끝에 "다음: …"이나 질문을 쓴다
const NONE_RE = /(하실\s*일[은이]?\s*없|할\s*일[은이]?\s*없|하실\s*것[은이]?\s*없)/;
const ASK_END_RE = /([?？]|(까요|할까|될까|나요|습니까|겠어요|을지요|인가요|맞나요|건가요|을래요)[.!…]?)\s*$/;
// 문장 중간의 물음표(뒤에 설명이 더 붙은 질문). 주소의 ?는 뒤에 빈칸이 없어 걸리지 않는다
const ASK_MID_RE = /[가-힣A-Za-z0-9)\]"'’”]\?(\s|$)/;
const ASK_REQ_RE = /(주세요|주십시오|주시겠어요|바랍니다|부탁드립니다|정해\s*주|골라\s*주|알려\s*주|답해\s*주|말씀해\s*주|확인해\s*주|눌러\s*주|넣어\s*주|입력해\s*주|켜\s*주|실행해\s*주|승인해\s*주|셔야\s*(합니다|해요)|답을\s*기다리|결정을\s*기다리|여쭐\s*것)/;
const ASK_OFFER_RE = /(하시면|주시면|라고만?\s*(하시면|보내|답해)).{0,60}(하겠습니다|드리겠습니다|시작합니다|진행합니다|하겠어요|드릴게요|할게요)/;
// 특정한 결정 없이 "더 시킬 일 있으면 말해 달라"는 인사말은 내 차례로 보지 않는다
const GENERIC_RE = /(맡길\s*일이?\s*있으면|원하시면|필요하시면|진행할\s*작업을|다른\s*작업이?\s*있으면|새\s*작업을\s*맡기)/;

function tidyLine(s) {
  return String(s || '').replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
}

function lineAsks(l) {
  const asks = ASK_END_RE.test(l) || ASK_MID_RE.test(l) || ASK_REQ_RE.test(l) || ASK_OFFER_RE.test(l);
  if (!asks) return false;
  // 인사말만 있는 줄은 빼되, 같은 줄에 구체적인 제안("~라고 하시면 ~하겠습니다")이 있으면 묻는 줄로 본다
  return !GENERIC_RE.test(l) || ASK_OFFER_RE.test(l.replace(GENERIC_RE, ''));
}

function classifyTurn(text) {
  const lines = String(text || '').split('\n').map(tidyLine).filter((l) => l && !/^\|?[-:| ]+\|?$/.test(l));
  if (!lines.length) return null;
  const tail = lines.slice(-2);
  if (NONE_RE.test(tail.join(' ')) && !ASK_REQ_RE.test(tail[tail.length - 1])) return 'none';
  return tail.some(lineAsks) ? 'ask' : null;
}

// 기다리는 세션이 무엇을 묻는지 / 방금 끝난 세션의 마지막 말
function lastWords(file) {
  const items = conversationTail(file, 30);
  let question = '';
  let tool = null;
  let lastText = '';
  let endsWithText = false;
  for (const it of items) {
    if (it.role === 'tool') { tool = it; endsWithText = false; }
    if (it.role === 'assistant') { lastText = it.text; endsWithText = true; }
    if (it.role === 'user') { lastText = ''; tool = null; endsWithText = false; }
  }
  if (tool && tool.name === 'AskUserQuestion') question = tool.text;
  // 글로 끝난 차례만 판정한다(도구 호출로 끝났으면 아직 일하는 중이거나 끊긴 것)
  const turn = endsWithText ? classifyTurn(lastText) : null;
  return { question, tool: tool ? { name: tool.name, text: tool.text } : null, lastLine: lastLineOf(lastText), turn };
}

// 글의 마지막 줄(마크다운 꾸밈은 걷는다). 사용자 세션들은 끝에 "다음 할 일"을 쓴다
function lastLineOf(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].replace(/^\s*(#{1,6}\s+|[-*]\s+|>\s*|\d+\.\s+)/, '').replace(/\[([^\]\n]+)\]\([^)\s]*\)/g, '$1').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
    if (t) return t.length > 200 ? t.slice(0, 200) + '…' : t;
  }
  return '';
}

// ---------- 바뀐 내용(diff) ----------

const DIFF_LINES_MAX = 400;

function hunksFromStructured(list) {
  const out = [];
  for (const h of Array.isArray(list) ? list : []) {
    if (!h || !Array.isArray(h.lines)) continue;
    out.push({
      head: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      lines: h.lines.filter((l) => typeof l === 'string').map((l) => [l[0] === '+' || l[0] === '-' ? l[0] : ' ', l.slice(1)]),
    });
  }
  return out;
}

function hunksFromUnified(text) {
  const out = [];
  let cur = null;
  for (const l of String(text || '').split('\n')) {
    if (l.startsWith('@@')) { cur = { head: l.replace(/^(@@[^@]*@@).*$/, '$1'), lines: [] }; out.push(cur); continue; }
    if (!cur || l.startsWith('\\')) continue;
    const p = l[0];
    if (p === '+' || p === '-' || p === ' ') cur.lines.push([p, l.slice(1)]);
  }
  return out;
}

function hunksForChange(c, scanner) {
  if (c.kind === 'edit') {
    const o = readRecord(c.file, c.offset, c.length);
    const r = (o && o.toolUseResult) || {};
    const hunks = hunksFromStructured(r.structuredPatch);
    if (!hunks.length && r.type === 'create' && typeof r.content === 'string') {
      return [{ head: '새 파일', lines: r.content.split('\n').map((s) => ['+', s]) }];
    }
    return hunks;
  }
  if (c.kind === 'bash') {
    const o = readRecord(c.file, c.offset, c.length);
    const bd = (o && o.toolUseResult && o.toolUseResult.bashEditDiff) || {};
    const files = Array.isArray(bd.files) ? bd.files : [];
    const fx = files.find((x) => x && x.filePath === c.path) || (c.idx >= 0 ? files[c.idx] : null);
    return fx ? hunksFromStructured(fx.hunks) : [];
  }
  if (c.kind === 'cxedit' && scanner && c.offset >= 0) {
    const o = readRecord(c.file, c.offset, c.length);
    const text = scanner.codexPatchText((o && o.payload) || null) || '';
    const part = scanner.parsePatch(text, '')[c.idx];
    if (!part) return [];
    const out = [];
    let cur = null;
    for (const l of part.lines) {
      if (l.startsWith('@@') || !cur) { cur = { head: l.startsWith('@@') ? l : '@@', lines: [] }; out.push(cur); if (l.startsWith('@@')) continue; }
      cur.lines.push([l[0] === '+' || l[0] === '-' ? l[0] : ' ', l.slice(1)]);
    }
    return out;
  }
  if (c.kind === 'commit' && c.sha && c.top && c.rel) {
    try {
      const txt = execFileSync('git', ['-C', c.top, 'show', '--format=', '--unified=3', '--no-color', c.sha, '--', c.rel], { encoding: 'utf8', timeout: 4000, maxBuffer: 4 * 1024 * 1024 });
      return hunksFromUnified(txt);
    } catch {
      return [];
    }
  }
  return [];
}

// 한 파일의 바뀐 내용: 이 세션이 그 파일을 바꾼 기록들을 최근 것부터
function diffFor(changes, scanner) {
  const parts = [];
  let total = 0;
  let truncated = false;
  const seenSha = new Set();
  for (const c of [...changes].sort((a, b) => b.ts - a.ts)) {
    if (c.kind === 'commit') { if (seenSha.has(c.sha)) continue; seenSha.add(c.sha); }
    let hunks = hunksForChange(c, scanner);
    if (!hunks.length) {
      parts.push({ ts: c.ts, kind: c.kind, note: c.kind === 'shell' ? '명령으로 바뀐 파일이라 줄 기록이 없습니다.' : '바뀐 줄 기록이 없습니다.', hunks: [] });
      continue;
    }
    const kept = [];
    for (const h of hunks) {
      if (total >= DIFF_LINES_MAX) { truncated = true; break; }
      const room = DIFF_LINES_MAX - total;
      const lines = h.lines.slice(0, room).map(([t, s]) => [t, maskSecrets(s).slice(0, 2000)]);
      if (lines.length < h.lines.length) truncated = true;
      total += lines.length;
      kept.push({ head: h.head, lines });
    }
    parts.push({ ts: c.ts, kind: c.kind, sha: c.sha ? String(c.sha).slice(0, 8) : undefined, msg: c.msg ? maskSecrets(oneLine(c.msg, 120)) : undefined, hunks: kept });
    if (total >= DIFF_LINES_MAX) { truncated = true; break; }
  }
  return { parts, truncated };
}

module.exports = {
  codexItem, maskSecrets, readRecord, tailLines, cleanUserText, toolSummary, conversationTail, lastWords, lastLineOf, classifyTurn, diffFor, hunksFromUnified, MASK };
