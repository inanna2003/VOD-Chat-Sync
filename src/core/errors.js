// src/core/errors.js
// グローバルエラーをキャッチして 50件のリングバッファに溜める。
// 診断レポート（Markdown）を生成してクリップボードへコピーする機能つき。
// PII（OAuth トークン等）はマスクする。

const MAX_ENTRIES = 50;
/** @type {Array<{ ts: number, where: string, message: string, stack?: string, extra?: any }>} */
const ringBuffer = [];

/** OAuth トークン等を伏字に */
function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\bOAuth\s+[A-Za-z0-9._-]+/g, 'OAuth ***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***')
    .replace(/access[_-]?token["']?\s*[:=]\s*["']?[A-Za-z0-9._-]+/gi, 'access_token=***');
}

export function logError(where, err, extra) {
  const entry = {
    ts: Date.now(),
    where,
    message: redact(err?.message ?? String(err ?? 'unknown')),
    stack: typeof err?.stack === 'string' ? redact(err.stack).split('\n').slice(0, 8).join('\n') : undefined,
    extra,
  };
  ringBuffer.push(entry);
  if (ringBuffer.length > MAX_ENTRIES) ringBuffer.shift();
  // 開発者コンソールにも出す
  console.warn(`[${where}]`, err, extra ?? '');
}

/** ページ全体のグローバルハンドラを設置 */
export function installGlobalErrorHandlers(tag = 'content') {
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (ev) => {
      logError(`${tag}/window.onerror`, ev.error ?? ev.message);
    });
    window.addEventListener('unhandledrejection', (ev) => {
      logError(`${tag}/unhandledrejection`, ev.reason);
    });
  }
}

/** 直近のログ一覧 */
export function getRecentLogs() {
  return ringBuffer.slice();
}

/** Markdown 形式の診断レポート */
export function buildDiagnosticReport() {
  const lines = [];
  lines.push(`# Diagnostic Report`);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- UA: ${navigator.userAgent}`);
  try {
    const m = chrome.runtime?.getManifest?.();
    if (m) {
      lines.push(`- Extension: ${m.name} v${m.version}`);
    }
  } catch {}
  lines.push(`- URL: ${location.href}`);
  lines.push('');
  lines.push(`## Recent errors (${ringBuffer.length})`);
  if (ringBuffer.length === 0) {
    lines.push('_(no errors recorded)_');
  } else {
    for (const e of ringBuffer) {
      lines.push(`### ${new Date(e.ts).toISOString()} — ${e.where}`);
      lines.push('```');
      lines.push(e.message);
      if (e.stack) { lines.push(''); lines.push(e.stack); }
      lines.push('```');
    }
  }
  return lines.join('\n');
}

/** クリップボードへコピー。Clipboard API が無ければ execCommand フォールバック */
export async function copyDiagnosticToClipboard() {
  const text = buildDiagnosticReport();
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
