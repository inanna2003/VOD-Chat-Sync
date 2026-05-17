// keep-active.js
//
// Twitch のタブが非アクティブになった時の自動 pause / HLS 停止を抑止する。
//
// ★ 必須要件 ★
//   - MAIN world で実行されること (Manifest V3 の `"world": "MAIN"`)
//   - document_start で実行されること
//
// ★ 何をするか ★
//   1. document.hidden / visibilityState / webkitVisibilityState を常に
//      「可視」状態に固定
//   2. document.hasFocus() を常に true を返すように変更
//   3. visibilitychange / blur イベントの addEventListener を遮断し、
//      Twitch React にイベントが届かないようにする
//   4. unload は Chrome の Permissions Policy で禁止されつつあるイベントで、
//      Twitch がこれを登録しようとすると警告が出る。
//      登録試行自体を弾いて警告を抑止する。

(function() {
  'use strict';

  if (window.__vodChatSyncKeepActive) return;
  window.__vodChatSyncKeepActive = true;

  // タブ可視性偽装のために遮断するイベント
  const BLOCKED_EVENT_TYPES = new Set([
    'visibilitychange',
    'webkitvisibilitychange',
    'mozvisibilitychange',
    'msvisibilitychange',
    'blur',
  ]);

  // Chrome の Permissions Policy で禁止されつつあり、登録しようとすると
  // "Permissions policy violation: <event> is not allowed in this document"
  // という警告がコンソールに出るイベント。登録試行を弾いて警告を抑止する。
  // 参考: https://chromestatus.com/feature/5579556305502208
  const SILENCED_EVENT_TYPES = new Set([
    'unload',
  ]);

  // ============================================================
  // 1. visibilityState / hidden を常に「可視」へ固定
  // ============================================================
  try {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    Object.defineProperty(document, 'webkitVisibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(document, 'webkitHidden', {
      configurable: true,
      get: () => false,
    });
  } catch (e) {
    console.warn('[keep-active] failed to override visibility:', e);
  }

  // ============================================================
  // 2. hasFocus() を常に true へ
  // ============================================================
  try {
    document.hasFocus = function() { return true; };
  } catch (e) {
    console.warn('[keep-active] failed to override hasFocus:', e);
  }

  // ============================================================
  // 3. addEventListener / removeEventListener / dispatchEvent をパッチ
  // ============================================================
  const ETProto = EventTarget.prototype;
  const origAdd = ETProto.addEventListener;
  const origRemove = ETProto.removeEventListener;
  const origDispatch = ETProto.dispatchEvent;

  ETProto.addEventListener = function(type, listener, options) {
    if (typeof type === 'string') {
      // 可視性偽装のため遮断
      if (BLOCKED_EVENT_TYPES.has(type)) return undefined;
      // Permissions Policy 警告抑止のため silent スキップ
      if (SILENCED_EVENT_TYPES.has(type)) return undefined;
    }
    return origAdd.call(this, type, listener, options);
  };
  ETProto.removeEventListener = function(type, listener, options) {
    if (typeof type === 'string'
        && (BLOCKED_EVENT_TYPES.has(type) || SILENCED_EVENT_TYPES.has(type))) {
      return undefined;
    }
    return origRemove.call(this, type, listener, options);
  };
  ETProto.dispatchEvent = function(event) {
    if (event && (BLOCKED_EVENT_TYPES.has(event.type) || SILENCED_EVENT_TYPES.has(event.type))) {
      return true;
    }
    return origDispatch.call(this, event);
  };

  // ============================================================
  // 4. onvisibilitychange プロパティ代入経路も無効化
  // ============================================================
  try {
    Object.defineProperty(document, 'onvisibilitychange', {
      configurable: true,
      get: () => null,
      set: () => {},
    });
    Object.defineProperty(document, 'onwebkitvisibilitychange', {
      configurable: true,
      get: () => null,
      set: () => {},
    });
  } catch (e) { /* 旧ブラウザ等で defineProperty が失敗してもクリティカルではない */ }

  // ============================================================
  // 5. window.onunload プロパティ代入経路も無効化
  // ============================================================
  try {
    Object.defineProperty(window, 'onunload', {
      configurable: true,
      get: () => null,
      set: () => {}, // Twitch が代入しても無視
    });
  } catch (e) { /* noop */ }
})();