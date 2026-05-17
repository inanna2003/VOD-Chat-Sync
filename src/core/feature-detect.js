// src/core/feature-detect.js
// ブラウザ機能を検出して、推奨モードを決める。
// 3段階フォールバック: pip-with-video → pip-chat-only → inline-overlay

let detectedCache = null;

export function detectCapabilities() {
  if (detectedCache) return detectedCache;

  const documentPip =
    typeof window !== 'undefined' && 'documentPictureInPicture' in window;

  let captureStream = false;
  try {
    // HTMLMediaElement.captureStream は型上は MediaElementCaptureStream を返す
    const proto = HTMLVideoElement.prototype;
    captureStream =
      typeof proto.captureStream === 'function' ||
      // @ts-ignore - moz prefix
      typeof proto.mozCaptureStream === 'function';
  } catch { /* noop */ }

  const i18n = typeof chrome !== 'undefined' && !!chrome.i18n;
  const storageSync = typeof chrome !== 'undefined' && !!chrome.storage?.sync;
  const commands = typeof chrome !== 'undefined' && !!chrome.commands;

  /** @type {'pip-with-video'|'pip-chat-only'|'inline-overlay'} */
  let recommendedMode = 'inline-overlay';
  if (documentPip && captureStream) recommendedMode = 'pip-with-video';
  else if (documentPip) recommendedMode = 'pip-chat-only';

  detectedCache = Object.freeze({
    documentPip,
    captureStream,
    i18n,
    storageSync,
    commands,
    recommendedMode,
  });
  return detectedCache;
}
