// src/core/i18n.js
// chrome.i18n.getMessage の薄いラッパ。
// 与えられた root の data-i18n / data-i18n-title / data-i18n-placeholder 属性を一括翻訳する。

/** メッセージ ID から翻訳テキストを取得 */
export function t(key, substitutions) {
  try {
    const v = chrome.i18n?.getMessage(key, substitutions);
    return v || key;
  } catch {
    return key;
  }
}

/** ロケール（"ja-JP" 形式） */
export function getLocale() {
  try {
    return chrome.i18n?.getUILanguage?.() || 'en';
  } catch {
    return 'en';
  }
}

/**
 * data-i18n="key" → textContent を置換
 * data-i18n-title="key" → title 属性
 * data-i18n-placeholder="key" → placeholder 属性
 * data-i18n-aria-label="key" → aria-label 属性
 */
export function applyI18n(root = document) {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.setAttribute('title', t(key));
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.setAttribute('placeholder', t(key));
  }
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    const key = el.getAttribute('data-i18n-aria-label');
    if (key) el.setAttribute('aria-label', t(key));
  }
}
