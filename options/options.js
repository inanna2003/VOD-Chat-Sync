// options/options.js
import { applyI18n, t } from '../src/core/i18n.js';
import { getSettings, setSettings, resetSettings, DEFAULT_SETTINGS } from '../src/core/settings.js';
import { copyDiagnosticToClipboard } from '../src/core/errors.js';

// 公開時に書き換える Ko-fi ユーザー名
const KOFI_USERNAME = 'Inanna2003';

// ★ 削除済み:
//   - autoStartOnVod        (Document PiP のユーザージェスチャ要件で実質動作しないため)
//   - hideSubNotifications  (03 フィルタ削除に伴い)
//   - highlightUser         (03 フィルタ削除に伴い)
//   - mutedUsers            (03 フィルタ削除に伴い)
//   - mutedWords            (03 フィルタ削除に伴い)
const FIELDS = {
  chatOpacity:        { kind: 'range',    fmt: (v) => Number(v).toFixed(2) },
  chatWidth:          { kind: 'range',    fmt: (v) => `${v}px` },
  emoteSize:          { kind: 'select',   parse: Number },
  hideHeader:         { kind: 'checkbox' },
  hideStatusBar:      { kind: 'checkbox' },
  videoMirrorInPip:   { kind: 'checkbox' },
  clickToSeek:        { kind: 'checkbox' },
};

async function init() {
  applyI18n(document);

  const kofi = document.getElementById('kofi-link');
  if (kofi) {
    kofi.href = KOFI_USERNAME === 'your-kofi-username'
      ? 'https://ko-fi.com/'
      : `https://ko-fi.com/${encodeURIComponent(KOFI_USERNAME)}`;
  }

  const settings = await getSettings();
  for (const [name, def] of Object.entries(FIELDS)) {
    const el = document.getElementById(name);
    if (!el) continue;
    setControl(el, def, settings[name]);
    el.addEventListener(def.kind === 'text' || def.kind === 'lines' ? 'input' : 'change', async () => {
      const v = readControl(el, def);
      const next = await setSettings({ [name]: v });
      updateValueLabel(name, def, next[name]);
    });
    updateValueLabel(name, def, settings[name]);
  }

  document.getElementById('diag-btn')?.addEventListener('click', async () => {
    const ok = await copyDiagnosticToClipboard();
    const msg = document.getElementById('copied-msg');
    if (msg) {
      msg.hidden = false;
      msg.textContent = ok ? t('settings_diagnostic_copied') : 'copy failed';
      setTimeout(() => { msg.hidden = true; }, 2500);
    }
  });

  document.getElementById('reset-btn')?.addEventListener('click', async () => {
    if (!confirm(t('settings_reset_confirm'))) return;
    await resetSettings();
    const next = await getSettings();
    for (const [name, def] of Object.entries(FIELDS)) {
      const el = document.getElementById(name);
      if (!el) continue;
      setControl(el, def, next[name]);
      updateValueLabel(name, def, next[name]);
    }
  });
}

function setControl(el, def, value) {
  switch (def.kind) {
    case 'range': el.value = String(value ?? ''); break;
    case 'select': el.value = String(value ?? ''); break;
    case 'checkbox': el.checked = !!value; break;
    case 'text': el.value = String(value ?? ''); break;
    case 'lines':
      el.value = Array.isArray(value) ? value.join('\n') : String(value ?? '');
      break;
  }
}

function readControl(el, def) {
  switch (def.kind) {
    case 'range': return Number(el.value);
    case 'select': return def.parse ? def.parse(el.value) : el.value;
    case 'checkbox': return el.checked;
    case 'text': return el.value;
    case 'lines':
      return el.value.split('\n').map((s) => s.trim()).filter(Boolean);
  }
}

function updateValueLabel(name, def, value) {
  const label = document.getElementById(`${name}-value`);
  if (!label) return;
  if (def.fmt) label.textContent = def.fmt(value);
  else label.textContent = String(value);
}

init().catch((err) => console.error('[options] init failed:', err));
void DEFAULT_SETTINGS;