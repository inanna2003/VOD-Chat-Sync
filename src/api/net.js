// src/api/net.js
// fetch を fetchWithRetry に統一すれば、レートリミットや一時障害で
// 永久にハングしない。Retry-After ヘッダ尊重、指数バックオフ、
// オフライン復帰待機、タイムアウトを一元化する。

const DEFAULTS = {
  maxRetries: 4,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  timeoutMs: 15000,
};

/** リトライしても無理だった、もしくは即諦めるエラー */
export class FatalFetchError extends Error {
  constructor(message, { status = 0, code = 'FATAL' } = {}) {
    super(message);
    this.name = 'FatalFetchError';
    this.status = status;
    this.code = code;
  }
}

/** リトライ対象のエラー（指数バックオフされる） */
export class RetryableFetchError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = 'RetryableFetchError';
    this.status = status;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfter(value) {
  if (!value) return null;
  const sec = Number(value);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const dt = Date.parse(value);
  if (Number.isFinite(dt)) return Math.max(0, dt - Date.now());
  return null;
}

/** オフライン中なら online に戻るまで待つ */
async function waitForOnline() {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) return;
  await new Promise((resolve) => {
    const fn = () => {
      window.removeEventListener('online', fn);
      resolve();
    };
    window.addEventListener('online', fn);
  });
}

/**
 * リトライ付き fetch。
 * - 429 → Retry-After 優先、無ければ指数バックオフ
 * - 5xx, ネットワーク TypeError → 指数バックオフ
 * - 4xx (429 以外) → 即 throw（FatalFetchError）
 *
 * @param {string|URL|Request} input
 * @param {RequestInit & { retry?: Partial<typeof DEFAULTS> }} [init]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(input, init = {}) {
  const cfg = { ...DEFAULTS, ...(init.retry || {}) };
  let attempt = 0;
  let lastErr = null;

  while (attempt <= cfg.maxRetries) {
    await waitForOnline();
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(new Error('timeout')), cfg.timeoutMs);
    try {
      const res = await fetch(input, { ...init, signal: init.signal ?? ctrl.signal });
      clearTimeout(tid);
      if (res.ok) return res;

      if (res.status === 429) {
        const ra = parseRetryAfter(res.headers.get('Retry-After'));
        const delay = ra ?? Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** attempt);
        await sleep(delay);
        attempt++;
        continue;
      }
      if (res.status >= 500 && res.status < 600) {
        const delay = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** attempt);
        await sleep(delay);
        attempt++;
        continue;
      }
      // 4xx は即諦める
      throw new FatalFetchError(`HTTP ${res.status}`, { status: res.status });
    } catch (err) {
      clearTimeout(tid);
      if (err instanceof FatalFetchError) throw err;
      // AbortError / TypeError(Failed to fetch) / DNS 等 → リトライ
      lastErr = err;
      const delay = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** attempt);
      await sleep(delay);
      attempt++;
    }
  }
  throw new RetryableFetchError(
    `fetch failed after ${cfg.maxRetries} retries: ${lastErr?.message ?? 'unknown'}`,
    { status: 0 },
  );
}
