// src/render/message-renderer.js
// チャットメッセージ1行を DOM Element として生成する。
// XSS 防止のため innerHTML は使わず、createElement/textContent のみ。
//
// ★ 修正（タイムスタンプが表示されない問題）★
// .chat-row に text-indent: -44px が設定されており、これが inherited
// プロパティであるため display:inline-block の .chat-ts にも継承され、
// 内部テキスト "0:01" が -44px 位置にシフトして pip-messages の
// overflow-x クリップ（overflow-y: auto による暗黙の overflow-x: hidden）
// で見えなくなっていた。.chat-ts に text-indent: 0 を明示することで解消。

import { buildTwitchEmoteUrl } from '../api/twitch-gql.js';
import { resolveBadge } from '../api/badges.js';

const URL_REGEX = /\bhttps?:\/\/[^\s<>'"]+/gi;
const MENTION_REGEX = /^@([A-Za-z0-9_]{2,32})$/;

function sizeStr(n) {
  return n >= 3 ? '3.0' : n === 2 ? '2.0' : '1.0';
}
function emoteUrlForSize(emote, size) {
  if (!emote?.urls) return '';
  if (size >= 3) return emote.urls['3x'] || emote.urls['2x'] || emote.urls['1x'] || '';
  if (size === 2) return emote.urls['2x'] || emote.urls['1x'] || '';
  return emote.urls['1x'] || emote.urls['2x'] || '';
}

function buildEmoteImg({ url, code, size }) {
  const img = document.createElement('img');
  img.className = 'chat-emote';
  img.src = url;
  img.alt = code;
  img.title = code;
  const px = size >= 3 ? 56 : size === 2 ? 36 : 24;
  img.style.height = `${px}px`;
  img.style.verticalAlign = 'middle';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    const text = document.createTextNode(code);
    img.replaceWith(text);
  }, { once: true });
  return img;
}

function appendTextWithTokens(parent, text, { emoteMap, emoteSize }) {
  if (!text) return;
  const tokens = text.split(/(\s+)/);
  for (const tok of tokens) {
    if (!tok) continue;
    if (/^\s+$/.test(tok)) {
      parent.appendChild(document.createTextNode(tok));
      continue;
    }
    if (URL_REGEX.test(tok)) {
      URL_REGEX.lastIndex = 0;
      const a = document.createElement('a');
      a.className = 'chat-link';
      a.href = tok;
      a.textContent = tok;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      parent.appendChild(a);
      continue;
    }
    const mm = MENTION_REGEX.exec(tok);
    if (mm) {
      const s = document.createElement('span');
      s.className = 'chat-mention';
      s.textContent = tok;
      parent.appendChild(s);
      continue;
    }
    const emote = emoteMap?.get(tok);
    if (emote) {
      parent.appendChild(buildEmoteImg({
        url: emoteUrlForSize(emote, emoteSize),
        code: emote.code,
        size: emoteSize,
      }));
      continue;
    }
    parent.appendChild(document.createTextNode(tok));
  }
}

function formatOffset(sec) {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

/**
 * 暗すぎる色を Twitch 公式チャットと同様に補正する。
 */
function ensureReadableColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum > 70) return `#${m[1]}`;
  const boost = 90 / Math.max(lum, 1);
  const c = (x) => Math.min(255, Math.round(x * boost));
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

/**
 * 1メッセージを表す <div class="chat-row"> を生成。
 */
export function renderMessage(comment, ctx) {
  const { emoteMap = new Map(), badgeMap = {}, emoteSize = 1, onSeek } = ctx ?? {};

  const row = document.createElement('div');
  row.className = 'chat-row';
  row.dataset.offset = String(comment.offsetSec);
  row.style.cursor = onSeek ? 'pointer' : 'default';

  // タイムスタンプ
  const ts = document.createElement('span');
  ts.className = 'chat-ts';
  ts.textContent = formatOffset(comment.offsetSec);
  ts.title = `${comment.offsetSec.toFixed(0)}s`;
  row.appendChild(ts);

  // バッジ
  for (const b of comment.message.userBadges ?? []) {
    const meta = resolveBadge(b, badgeMap);
    if (!meta) continue;
    const img = document.createElement('img');
    img.className = 'chat-badge';
    img.src = meta.imageUrl;
    img.alt = meta.title;
    img.title = meta.title;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => img.remove(), { once: true });
    row.appendChild(img);
  }

  // ユーザー名
  const name = document.createElement('span');
  name.className = 'chat-name';
  name.textContent = comment.commenter?.displayName ?? '???';
  if (comment.message.userColor) {
    name.style.color = ensureReadableColor(comment.message.userColor);
  }
  row.appendChild(name);
  row.appendChild(document.createTextNode(': '));

  // 本文
  const msg = document.createElement('span');
  msg.className = 'chat-msg';
  for (const frag of comment.message.fragments ?? []) {
    if (frag?.emote?.emoteID) {
      msg.appendChild(buildEmoteImg({
        url: buildTwitchEmoteUrl(frag.emote.emoteID, sizeStr(emoteSize)),
        code: frag.text ?? '',
        size: emoteSize,
      }));
      continue;
    }
    appendTextWithTokens(msg, frag?.text ?? '', { emoteMap, emoteSize });
  }
  row.appendChild(msg);

  // クリックでシーク
  if (onSeek) {
    row.addEventListener('click', (ev) => {
      if (ev.target && /** @type {Element} */ (ev.target).tagName === 'A') return;
      onSeek(comment.offsetSec);
    });
  }

  return row;
}

/**
 * チャット行用の基本 CSS を Document に1回だけ注入する。
 */
export function injectChatStyles(doc = document) {
  if (doc.getElementById('chat-row-styles')) return;
  const style = doc.createElement('style');
  style.id = 'chat-row-styles';
  style.textContent = `
    .chat-row {
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Roobert", sans-serif;
      /* hanging indent: 1行目はタイムスタンプから始まり、2行目以降は名前位置にインデント */
      padding: 3px 8px 3px 52px;
      text-indent: -44px;
      word-wrap: break-word;
      overflow-wrap: anywhere;
    }
    .chat-row:hover { background: rgba(255,255,255,.06); }
    .chat-ts {
      display: inline-block;
      min-width: 38px;
      color: #9aa0a6;
      font-variant-numeric: tabular-nums;
      margin-right: 6px;
      font-size: 11px;
      /* ★ 親 .chat-row の text-indent:-44px が継承されると、
         この inline-block の内部テキスト "0:01" が -44px に押し出されて
         pip-messages の overflow-x クリップで見えなくなる。明示的に 0 に。 */
      text-indent: 0;
    }
    .chat-badge { height: 18px; width: 18px; vertical-align: middle; margin-right: 3px;
                  /* バッジ内部も念のため 0 にしておく */
                  text-indent: 0; }
    .chat-name { font-weight: 700; }
    .chat-emote { margin: -2px 0; }
    .chat-link { color: #4fc3f7; text-decoration: none; }
    .chat-link:hover { text-decoration: underline; }
    .chat-mention { color: #ffb74d; font-weight: 600; }
  `;
  doc.head.appendChild(style);
}