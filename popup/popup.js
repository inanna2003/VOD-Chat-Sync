// popup/popup.js
import { applyI18n, t } from '../src/core/i18n.js';
import { getSettings, setSettings, DEFAULT_SETTINGS } from '../src/core/settings.js';

const KOFI_USERNAME = 'Inanna2003';

const MODES = ['pip-video', 'pip-chat'];

/** @type {{ master: HTMLInputElement, status: HTMLElement, segs: NodeListOf<HTMLButtonElement>, openNow: HTMLButtonElement, notVod: HTMLElement, openSettings: HTMLButtonElement, kofi: HTMLAnchorElement }} */
let els;

/** content script 未到達エラーか判定 */
function isExpectedDisconnectError(err) {
  const msg = String(err?.message ?? err ?? '');
  return /Could not establish connection|Receiving end does not exist|message port closed/i.test(msg);
}

async function init() {
  applyI18n(document);

  els = {
    master: document.getElementById('master-toggle'),
    status: document.getElementById('status-label'),
    segs: document.querySelectorAll('.seg'),
    openNow: document.getElementById('open-now-btn'),
    notVod: document.getElementById('not-vod-msg'),
    openSettings: document.getElementById('open-settings-btn'),
    kofi: document.getElementById('kofi-link'),
  };

  els.kofi.href = KOFI_USERNAME === 'your-kofi-username'
    ? 'https://ko-fi.com/'
    : `https://ko-fi.com/${encodeURIComponent(KOFI_USERNAME)}`;

  const settings = await getSettings();
  reflect(settings);
  wire();

  const vodId = await getCurrentTabVodId();
  if (!vodId) {
    els.openNow.disabled = true;
    els.notVod.hidden = false;
  }
}

function reflect(settings) {
  els.master.checked = !!settings.enabled;
  els.status.textContent = t(settings.enabled ? 'popup_status_on' : 'popup_status_off');
  els.segs.forEach((btn) => {
    const active = btn.dataset.mode === settings.pipMode;
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}

function wire() {
  els.master.addEventListener('change', async () => {
    const next = await setSettings({ enabled: els.master.checked });
    reflect(next);
  });

  els.segs.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode;
      if (!MODES.includes(mode)) return;
      const next = await setSettings({ pipMode: mode });
      reflect(next);
    });
  });

  els.openNow.addEventListener('click', async () => {
    if (els.openNow.disabled) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'command', command: 'toggle_pip' });
      window.close();
    } catch (err) {
      // content script 未到達は想定範囲内エラー。コンソールには出さず、
      // UI 上でユーザに「リロードしてください」と案内するに留める。
      if (!isExpectedDisconnectError(err)) {
        console.warn('content script not reachable:', err);
      }
      els.openNow.disabled = true;
      els.notVod.hidden = false;
      els.notVod.textContent =
        t('popup_content_not_ready') || 'Twitch ページをリロードしてからもう一度お試しください。';
    }
  });

  els.openSettings.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

async function getCurrentTabVodId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    const m = /^https:\/\/(?:www\.)?twitch\.tv\/videos\/(\d+)/.exec(tab.url);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

init().catch((err) => {
  console.error('[popup] init failed:', err);
  if (els?.status) els.status.textContent = 'error';
});

void DEFAULT_SETTINGS;