// src/core/lifecycle.js
// 拡張機能 context 無効化検知、SPA ナビゲーション監視、
// Document PiP の起動・最小サイズ強制・ユーザークローズ検知、
// 複数タブのリーダー選出。
//
// ★ 修正 (requestWindow が DOMException で失敗するエラーの可視化) ★
//   従来は `[object DOMException]` としか出力されず原因が分からなかった。
//   要因（NotAllowedError = transient activation 喪失、NotSupportedError =
//   非対応ブラウザ等）を分けて識別できるようにし、呼び出し側で
//   ユーザに適切な案内を出せるよう、エラーを再 throw する形に変更。

const LEADER_KEY = 'leader:vodchat';
const LEADER_TTL = 10_000;

/** URL から videoId を抽出 */
export function parseVodIdFromUrl(href = location.href) {
  try {
    const u = new URL(href);
    const m = u.pathname.match(/^\/videos\/(\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** 拡張機能 context が生きているか */
export function isContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

/** context 無効化を検知 */
export function onContextInvalidated(callback) {
  let dead = false;
  const tid = setInterval(() => {
    if (dead) return;
    if (!isContextValid()) {
      dead = true;
      clearInterval(tid);
      try { callback(); } catch (e) { console.error('[lifecycle] context cb threw:', e); }
    }
  }, 2000);
  return () => { dead = true; clearInterval(tid); };
}

/** API が context 死亡後に呼ばれても落ちないようにするラッパ */
export function safeCall(fn) {
  try { if (isContextValid()) return fn(); } catch (e) {
    if (!/Extension context invalidated/.test(String(e))) throw e;
  }
}

/**
 * Twitch SPA の URL 変化を捕捉する。
 * @param {(newUrl: string, prevUrl: string) => void} cb
 */
export function watchUrlChanges(cb) {
  let last = location.href;
  const fire = () => {
    const now = location.href;
    if (now !== last) { const prev = last; last = now; cb(now, prev); }
  };
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args) {
    const r = origPush.apply(this, args);
    queueMicrotask(fire);
    return r;
  };
  history.replaceState = function (...args) {
    const r = origReplace.apply(this, args);
    queueMicrotask(fire);
    return r;
  };
  window.addEventListener('popstate', fire);
  const tid = setInterval(fire, 5000);
  return () => {
    history.pushState = origPush;
    history.replaceState = origReplace;
    window.removeEventListener('popstate', fire);
    clearInterval(tid);
  };
}

/**
 * Document PiP を開けない理由を表すエラーコード
 *   - NO_API: ブラウザが対応していない (caps.documentPip === false)
 *   - GESTURE_REQUIRED: transient activation 喪失 (NotAllowedError)
 *   - ALREADY_OPEN: 既に PiP ウィンドウが開いている
 *   - INTERNAL: それ以外
 */
export class OpenPipError extends Error {
  constructor(message, code = 'INTERNAL', cause = null) {
    super(message);
    this.name = 'OpenPipError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Document PiP ウィンドウを開く。
 *
 * 失敗時は OpenPipError を throw する。呼び出し側 (content_script.js) が
 * エラー種別を見て、ユーザに適切な案内を出すこと。
 *
 * @param {object} opts
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {() => void} [opts.onClose]
 */
export async function openPipWindow(opts = {}) {
  const { width = 720, height = 480, onClose } = opts;
  // @ts-ignore - 実験的 API
  const dpip = (typeof window !== 'undefined') ? window.documentPictureInPicture : null;
  if (!dpip || typeof dpip.requestWindow !== 'function') {
    throw new OpenPipError('Document Picture-in-Picture is not supported', 'NO_API');
  }
  try {
    const pip = await dpip.requestWindow({
      width: Math.max(width, 360),
      height: Math.max(height, 240),
    });
    if (onClose) pip.addEventListener('pagehide', () => { try { onClose(); } catch {} });
    return pip;
  } catch (e) {
    // ★ DOMException の詳細をログに出す（旧版は [object DOMException] としか出なかった）
    const name = e?.name ?? 'Error';
    const msg = e?.message ?? String(e);
    console.warn(`[lifecycle] requestWindow failed: ${name}: ${msg}`);
    // 種別判定
    if (name === 'NotAllowedError') {
      // 原因のほとんどはこれ。詳細メッセージで識別:
      //   "Document Picture-in-Picture requires user activation" → ジェスチャ喪失
      //   "Opening a PiP window is only allowed from a top-level browsing context" → iframe等
      //   "Picture-in-Picture window already open" → 既に開いている
      if (/already open/i.test(msg)) {
        throw new OpenPipError(msg, 'ALREADY_OPEN', e);
      }
      throw new OpenPipError(msg, 'GESTURE_REQUIRED', e);
    }
    throw new OpenPipError(msg, 'INTERNAL', e);
  }
}

/** 同じ video.captureStream を複数タブで取り合わないように単純なリーダー選出 */
export async function acquireVideoLeadership(scope = 'global') {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return true;
  const key = `${LEADER_KEY}:${scope}`;
  const me = Math.random().toString(36).slice(2);
  const now = Date.now();
  const all = await chrome.storage.local.get(key);
  const cur = all?.[key];
  if (cur && now - (cur.ts ?? 0) < LEADER_TTL && cur.id !== me) return false;
  await chrome.storage.local.set({ [key]: { id: me, ts: now } });
  const tid = setInterval(() => {
    if (!isContextValid()) { clearInterval(tid); return; }
    chrome.storage.local.set({ [key]: { id: me, ts: Date.now() } });
  }, LEADER_TTL / 3);
  return () => {
    clearInterval(tid);
    safeCall(() => chrome.storage.local.remove(key));
  };
}