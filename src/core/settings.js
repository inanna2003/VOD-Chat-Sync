// src/core/settings.js
// 設定永続化。sync を優先し、quota 超過時は local にフォールバック。
// onChanged 経由でクロスタブ同期、subscribe で監視。

const KEY = 'settings:v2'; // スキーマを変えたのでバージョン番号を上げる
const SCHEMA_VERSION = 2;

// ★ 削除済み:
//   - autoStartOnVod, hideSubNotifications, highlightUser, mutedUsers, mutedWords
export const DEFAULT_SETTINGS = Object.freeze({
  version: SCHEMA_VERSION,
  enabled: true,
  pipMode: 'pip-video', // 'pip-video' | 'pip-chat'

  // 表示
  chatOpacity: 0.95,
  chatWidth: 320,
  emoteSize: 1, // 1=24px / 2=36px / 3=56px
  hideHeader: false,
  hideStatusBar: false,

  // 動作
  videoMirrorInPip: true,
  clickToSeek: true,
});

let cached = null;
const listeners = new Set();

function isQuotaError(err) {
  const m = String(err?.message ?? err ?? '');
  return /quota|QUOTA/i.test(m);
}

function rawGet(area) {
  return new Promise((resolve) => {
    try {
      chrome.storage[area].get(KEY, (data) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(data?.[KEY] ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

function rawSet(area, value) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage[area].set({ [KEY]: value }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    } catch (e) { reject(e); }
  });
}

function mergeWithDefaults(stored) {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_SETTINGS };
  // 旧スキーマからの移行（v1 のキーは捨てる。新規 default を採用）
  if (stored.version !== SCHEMA_VERSION) return { ...DEFAULT_SETTINGS };
  const merged = { ...DEFAULT_SETTINGS, ...stored, version: SCHEMA_VERSION };
  if (merged.pipMode !== 'pip-video' && merged.pipMode !== 'pip-chat') {
    merged.pipMode = 'pip-video';
  }
  return merged;
}

/** 設定を取得（キャッシュあり） */
export async function getSettings() {
  if (cached) return cached;
  let stored = await rawGet('sync');
  if (!stored) stored = await rawGet('local');
  cached = mergeWithDefaults(stored);
  return cached;
}

/** 部分更新。失敗した場合は local にフォールバック。 */
export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch, version: SCHEMA_VERSION };
  cached = next;
  try {
    await rawSet('sync', next);
  } catch (err) {
    if (isQuotaError(err)) {
      console.warn('[settings] sync quota exceeded, falling back to local');
      try { await rawSet('local', next); } catch (e2) {
        console.error('[settings] local write also failed:', e2);
      }
    } else {
      console.warn('[settings] write failed:', err);
    }
  }
  notify(next);
  return next;
}

/** 設定を初期値に戻す */
export async function resetSettings() {
  return setSettings({ ...DEFAULT_SETTINGS });
}

function notify(next) {
  for (const fn of listeners) {
    try { fn(next); } catch (err) { console.error('[settings] listener threw:', err); }
  }
}

/** 設定変更を購読。返り値の関数で解除。 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// クロスタブ同期
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!changes[KEY]) return;
    if (area !== 'sync' && area !== 'local') return;
    const next = mergeWithDefaults(changes[KEY].newValue);
    cached = next;
    notify(next);
  });
}