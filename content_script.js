/**
 * Twitch VOD Chat Sync — content_script.js (整合済み版)
 *
 * 役割:
 *   - VOD ページで <video> の currentTime に同期してチャットを表示
 *   - 拡張機能アイコンクリック（popup or service worker からのメッセージ）で
 *     Document PiP ウィンドウ（動画ミラー + チャット）を開く
 *   - SPA ナビゲーション / context 無効化 / PiP ユーザークローズを正しく扱う
 *
 * 新モジュール統合:
 *   - 取得は src/api/twitch-gql.js（fetch リトライ + persisted-query フォールバック）
 *   - エモートは src/api/emote-providers.js（BTTV/FFZ/7TV）
 *   - バッジは src/api/badges.js
 *   - 行レンダリングは src/render/message-renderer.js（XSS 安全）
 *   - 設定は src/core/settings.js（sync + quota フォールバック）
 *   - 既知バグ修正（tick 同期化 / _fetchEpoch / try-catch-finally / 自動リカバリ）は保持
 */

'use strict';

(async () => {
  const url = (p) => chrome.runtime.getURL(p);

  // すべてのモジュールを並列ロード
  const [
    netMod, gqlMod, emotesMod, badgesMod, rendererMod,
    settingsMod, i18nMod, capsMod, lifecycleMod, errorsMod,
  ] = await Promise.all([
    import(url('src/api/net.js')),
    import(url('src/api/twitch-gql.js')),
    import(url('src/api/emote-providers.js')),
    import(url('src/api/badges.js')),
    import(url('src/render/message-renderer.js')),
    import(url('src/core/settings.js')),
    import(url('src/core/i18n.js')),
    import(url('src/core/feature-detect.js')),
    import(url('src/core/lifecycle.js')),
    import(url('src/core/errors.js')),
  ]);

  const { fetchVideoComments } = gqlMod;
  const { loadEmoteMap } = emotesMod;
  const { loadBadgeMap } = badgesMod;
  const { renderMessage, injectChatStyles } = rendererMod;
  const { getSettings, setSettings, subscribe: subscribeSettings } = settingsMod;
  const { t, applyI18n } = i18nMod;
  const { detectCapabilities } = capsMod;
  const {
    parseVodIdFromUrl, watchUrlChanges,
    onContextInvalidated, isContextValid, safeCall,
    openPipWindow,
  } = lifecycleMod;
  const { installGlobalErrorHandlers, logError } = errorsMod;

  installGlobalErrorHandlers('content');
  onContextInvalidated(() => {
    // 設定変更等は無効になるので、可能ならクリーンアップ
    try { session?.destroy?.(); } catch {}
    session = null;
  });

  const caps = detectCapabilities();

  // ============================================================
  // 定数
  // ============================================================
  const SYNC_INTERVAL = 200;     // ms
  const BUFFER_PREFETCH = 30;    // 何秒先までバッファするか（短めにして要求頻度を下げる）
  const MAX_MESSAGES = 150;      // 表示行の上限
  const SEEK_THRESHOLD = 3;      // 秒
  const MIN_LOAD_MORE_INTERVAL = 2500; // ms: 連続 pagination の最低間隔
  const MIN_RECOVERY_INTERVAL  = 5000; // ms: バッファ空時の自動 _loadAt の最低間隔
  const INTEGRITY_BACKOFF      = 15000; // ms: integrity / rate-limit 失敗時の冷却時間

  // ============================================================
  // セッション（VOD単位）
  // ============================================================
  /** @type {VodSession | null} */
  let session = null;

  class VodSession {
    /** @param {string} videoId */
    constructor(videoId) {
      this.videoId = videoId;
      this.destroyed = false;
      /** @type {HTMLVideoElement|null} */
      this.video = null;
      /** @type {Window|null} PiP window */
      this.pipWindow = null;
      this.pipDoc = null;
      /** @type {HTMLElement|null} */
      this.msgList = null;
      /** @type {HTMLElement|null} */
      this.statusEl = null;

      // バッファ
      /** @type {Array<{id:string, offsetSec:number, raw:any}>} */
      this.buffer = [];
      this.shownIds = new Set();
      /** @type {string|null} */
      this.cursor = null;
      this.hasNext = false;
      this.fetching = false;
      this.lastTime = -999;
      /** @type {ReturnType<typeof setTimeout>|null} */
      this.syncTimer = null;
      this._fetchEpoch = 0;
      this._lastLoadMoreAt = 0;
      this._lastRecoveryAt = 0;
      /** integrity 失敗時に冷却する時刻（ミリ秒）。Date.now() < この値の間は新規fetchを抑制 */
      this._coolUntil = 0;

      // UI 状態
      this.paused = false;
      this.userScrolled = false;

      // モジュール由来のキャッシュ
      this.emoteMap = new Map();
      this.badgeMap = {};
      this.channelId = null;

      this.settings = null;
      this._unsubSettings = null;
    }

    async init() {
      this.settings = await getSettings();
      this._unsubSettings = subscribeSettings((next) => this._onSettingsChange(next));

      await this._waitForVideo();
      if (this.destroyed) return;

      this._setupMessageListener();

      // バックグラウンドでバッファを温める（PiP 起動前から始める）
      this._startSync();
    }

    _waitForVideo() {
      return new Promise((resolve) => {
        const check = () => {
          if (this.destroyed) return resolve(null);
          const v = document.querySelector('video');
          if (v) { this.video = v; return resolve(v); }
          setTimeout(check, 600);
        };
        check();
      });
    }

    /**
     * 常に最新の <video> を返す（Twitch React の再マウントで参照が古くなる対策）
     */
    _freshVideo() {
      if (!this.video || !this.video.isConnected) {
        const v = document.querySelector('video');
        if (v) this.video = v;
      }
      return this.video;
    }

    /**
     * captureStream のミラー再確立（一時停止→再生で stream が止まることがある）
     */
    _refreshMirror() {
      if (!this.pipDoc || !caps.captureStream) return;
      const src = this._freshVideo();
      if (!src) return;
      const mirror = this.pipDoc.querySelector('video.pip-video');
      if (!mirror) return;
      try {
        // @ts-ignore
        const stream = (src.captureStream?.() ?? src.mozCaptureStream?.()) ?? null;
        if (!stream) return;
        const tracks = stream.getTracks();
        if (tracks.length === 0) return;
        // 既存 srcObject と同一なら何もしない
        const cur = /** @type {MediaStream|null} */ (mirror.srcObject);
        if (!cur || cur.getTracks().length === 0 || cur !== stream) {
          mirror.srcObject = stream;
          mirror.muted = true;
          mirror.play().catch(() => {});
        }
      } catch (err) {
        logError('session/refreshMirror', err);
      }
    }

    _setupMessageListener() {
      chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
        if (msg?.type !== 'command') return false;
        if (msg.command === 'toggle_pip') {
          this._togglePip().then(() => reply?.({ ok: true })).catch((e) => {
            logError('session/togglePip', e);
            reply?.({ ok: false, error: String(e?.message ?? e) });
          });
          return true; // async
        }
        return false;
      });
    }

    async _onSettingsChange(next) {
      const prev = this.settings;
      this.settings = next;
      if (!this.pipDoc) return;

      // 即時反映できるもの
      const chatPane = this.pipDoc.querySelector('.pip-chat-pane');
      if (chatPane) {
        chatPane.style.opacity = String(next.chatOpacity ?? 0.95);
        if (next.pipMode !== 'pip-chat') {
          chatPane.style.width = `${next.chatWidth ?? 320}px`;
        }
      }
      const header = this.pipDoc.querySelector('.pip-chat-header');
      if (header) header.style.display = next.hideHeader ? 'none' : 'flex';
      // ステータスバーは _setStatus 経由で再評価
      this._setStatus(this.statusEl?.textContent ?? '');

      // pipMode 切替: ウィンドウを開き直さず、CSS クラスとリサイズだけで対応
      if (prev?.pipMode !== next.pipMode && this.pipWindow) {
        this._applyModeInPlace(next.pipMode);
      }
    }

    _applyModeInPlace(mode) {
      const doc = this.pipDoc;
      if (!doc) return;
      const root = doc.querySelector('.pip-root');
      const chatPane = doc.querySelector('.pip-chat-pane');
      if (!root || !chatPane) return;

      if (mode === 'pip-chat') {
        root.classList.add('chat-only');
        chatPane.style.width = '';
        // ミラーを停止して負荷を下げる
        const mirror = doc.querySelector('video.pip-video');
        if (mirror) { try { mirror.pause(); } catch {} mirror.srcObject = null; }
      } else {
        root.classList.remove('chat-only');
        chatPane.style.width = `${this.settings?.chatWidth ?? 320}px`;
        // ミラーを再確立
        if (caps.captureStream && this.settings?.videoMirrorInPip) {
          this._refreshMirror();
        }
      }
      // 注: window.resizeTo() はモード変更時のような user gesture 不在の状況で
      //     Chrome に弾かれるため呼ばない。代わりに常に同じサイズで PiP を開く。
    }

    // ============================================================
    // 同期ループ（tick）
    //   - 既知バグ修正4点が全部生きる構成
    //   - tick は同期、_loadAt/_loadMore は fire-and-forget
    // ============================================================
    _startSync() {
      const tick = () => {
        if (this.destroyed) return;

        const v = this._freshVideo();
        const current = v?.currentTime ?? 0;
        const diff = Math.abs(current - this.lastTime);
        const now = Date.now();
        const cooling = now < this._coolUntil;

        // ---- シーク検出（lastTime は await の前に進めるバグ1対策） ----
        this.lastTime = current;
        if (diff > SEEK_THRESHOLD) {
          // 既に表示中のチャットを全クリア（残留防止）
          if (this.msgList) {
            while (this.msgList.firstChild) this.msgList.removeChild(this.msgList.firstChild);
          }
          this.shownIds.clear();
          this.buffer = [];
          this.cursor = null;
          this.hasNext = false;
          if (!cooling) {
            this._lastLoadMoreAt = 0; // シーク後は即ロード許可
            this._loadAt(current); // fire-and-forget
          }
        }

        if (!this.paused) {
          // バッファから今表示すべき行を取り出す
          const ready = [];
          const pending = [];
          for (const c of this.buffer) {
            if (c.offsetSec <= current) ready.push(c);
            else pending.push(c);
          }
          this.buffer = pending;
          for (const c of ready) this._renderRow(c);

          // 先読み（最低 MIN_LOAD_MORE_INTERVAL 間隔）
          const ahead = this.buffer.length > 0 ? this.buffer[0].offsetSec - current : 0;
          if (ahead < BUFFER_PREFETCH
              && !cooling
              && (now - this._lastLoadMoreAt) >= MIN_LOAD_MORE_INTERVAL) {
            this._loadMore();
          }
        }

        // ---- 自動リカバリ（バッファ空 + cursor 無 + 非 fetching） ----
        if (this.buffer.length === 0 && !this.cursor && !this.fetching
            && !cooling
            && (now - this._lastRecoveryAt) >= MIN_RECOVERY_INTERVAL) {
          this._lastRecoveryAt = now;
          this._loadAt(current); // fire-and-forget
        }

        this.syncTimer = setTimeout(tick, SYNC_INTERVAL);
      };
      tick();
    }

    async _loadAt(offsetSec) {
      const myEpoch = ++this._fetchEpoch;
      this.fetching = true;
      this._setStatus(t('status_loading'));
      try {
        const r = await fetchVideoComments({ videoId: this.videoId, offsetSeconds: offsetSec });
        if (this.destroyed) return;                // ★ 追加: 破棄済みなら即終了
        if (this._fetchEpoch !== myEpoch) return; // _loadAt が再度走った → 捨てる
        // _loadAt はバッファを置き換える（シーク先の表示）
        this.buffer = [];
        for (const c of r.comments) {
          if (this.shownIds.has(c.id)) continue;
          this.buffer.push({ id: c.id, offsetSec: c.offsetSec, raw: c });
        }
        this.cursor = r.nextCursor;
        this.hasNext = r.hasNextPage;
        this.channelId = r.channelId ?? this.channelId;
        this._coolUntil = 0; // 成功したので冷却解除
        this._setStatus('');
        // 初回 channelId が分かったらエモート/バッジをロード
        if (this.channelId && this.emoteMap.size === 0) {
          this._loadEmotesBadges(this.channelId);
        }
      } catch (err) {
        if (this._fetchEpoch !== myEpoch) return;
        logError('session/_loadAt', err);
        this._setStatusFromError(err);
        // integrity / rate-limit は冷却して以降の自動呼び出しを抑制
        if (err?.code === 'INTEGRITY' || err?.code === 'RATE_LIMITED') {
          this._coolUntil = Date.now() + INTEGRITY_BACKOFF;
        }
        // エラーでも cursor を null にしておけば自動リカバリで再試行される
        this.cursor = null;
        this.hasNext = false;
      } finally {
        if (this._fetchEpoch === myEpoch) this.fetching = false;
      }
    }

    async _loadMore() {
      // バグ2対策: epoch 不一致なら結果を捨てる
      if (this.fetching || !this.cursor || !this.hasNext) return;
      this._lastLoadMoreAt = Date.now();
      const myEpoch = this._fetchEpoch;
      this.fetching = true;
      try {
        const r = await fetchVideoComments({ videoId: this.videoId, cursor: this.cursor });
        if (this.destroyed) return;                // ★ 追加
        if (this._fetchEpoch !== myEpoch) return;
        for (const c of r.comments) {
          if (this.shownIds.has(c.id)) continue;
          this.buffer.push({ id: c.id, offsetSec: c.offsetSec, raw: c });
        }
        this.cursor = r.nextCursor;
        this.hasNext = r.hasNextPage;
        this._coolUntil = 0;
      } catch (err) {
        if (this._fetchEpoch !== myEpoch) return;
        logError('session/_loadMore', err);
        this._setStatusFromError(err);
        if (err?.code === 'INTEGRITY' || err?.code === 'RATE_LIMITED') {
          this._coolUntil = Date.now() + INTEGRITY_BACKOFF;
          // pagination を一度切断（次サイクルで _loadAt 再試行）
          this.cursor = null;
          this.hasNext = false;
        }
        // 通常のエラーはバッファを残す（既存表示は壊さない）
      } finally {
        // バグ4対策: finally で必ず解放
        if (this._fetchEpoch === myEpoch) this.fetching = false;
      }
    }

    async _loadEmotesBadges(channelId) {
      try {
        const [emoteMap, badgeMap] = await Promise.all([
          loadEmoteMap(channelId),
          loadBadgeMap(channelId),
        ]);
        if (this.destroyed) return; 
        this.emoteMap = emoteMap;
        this.badgeMap = badgeMap;
      } catch (err) {
        logError('session/emotes', err);
      }
    }

    _setStatusFromError(err) {
      const code = err?.code;
      if (code === 'VIDEO_NOT_FOUND') return this._setStatus(t('status_video_not_found'));
      if (code === 'FORBIDDEN')       return this._setStatus(t('status_forbidden'));
      if (code === 'RATE_LIMITED')    return this._setStatus(t('status_rate_limited'));
      if (code === 'INTEGRITY')       return this._setStatus(t('status_integrity'));
      if (code === 'NETWORK')         return this._setStatus(t('status_offline'));
      this._setStatus(t('fallback_generic'));
    }

    _setStatus(text) {
      if (!this.statusEl) return;
      this.statusEl.textContent = text ?? '';
      // 空の時は領域ごと隠す（ユーザ設定で常時非表示の場合はそれを優先）
      const forceHide = !!this.settings?.hideStatusBar;
      this.statusEl.style.display = forceHide || !text ? 'none' : 'flex';
    }

    // ============================================================
    // PiP の起動
    // ============================================================
    async _togglePip() {
      if (this.pipWindow && !this.pipWindow.closed) {
        try { this.pipWindow.focus?.(); } catch {}
        return;
      }
      if (!caps.documentPip) {
        logError('session/pip', new Error('documentPictureInPicture unsupported'));
        this._setStatus(t('fallback_no_document_pip'));
        return;
      }

      const chatOnly = this.settings?.pipMode === 'pip-chat';
      let pip = null;
      try {
        pip = await openPipWindow({
          width: 900,
          height: 520,
          onClose: () => this._onPipClose(),
        });
      } catch (err) {
        // ★ OpenPipError のコード別に処理
        const code = err?.code;
        if (code === 'GESTURE_REQUIRED') {
          // 最も一般的: popup/コマンドからの呼び出しで transient activation が
          // 喪失したパターン。ユーザに「Twitch ページをクリックしてから再試行」
          // を促す。
          this._setStatus(
            t('status_gesture_required') ||
            'PIP を開けません。このページを 1 回クリックしてから再度お試しください。'
          );
        } else if (code === 'ALREADY_OPEN') {
          // 既に別の PiP ウィンドウが開いている。状態を同期。
          // @ts-ignore
          const existing = window.documentPictureInPicture?.window;
          if (existing) {
            this.pipWindow = existing;
            this.pipDoc = existing.document;
          }
          return;
        } else if (code === 'NO_API') {
          this._setStatus(t('fallback_no_document_pip'));
        } else {
          logError('session/pip', err);
          this._setStatus(t('fallback_generic') || 'PIP を開けませんでした。');
        }
        return;
      }
      if (!pip) {
        this._setStatus(t('fallback_no_document_pip'));
        return;
      }
      this.pipWindow = pip;
      this.pipDoc = pip.document;
      this._buildPipDom({ chatOnly });
      injectChatStyles(this.pipDoc);

      // video mirror（chat-only でない場合のみ）
      if (!chatOnly && caps.captureStream && this.settings?.videoMirrorInPip && this._freshVideo()) {
        this._refreshMirror();
      } else if (!chatOnly && !caps.captureStream) {
        this._showFallbackNote(t('fallback_no_capture_stream'));
      }
    }

    _onPipClose() {
      this.pipWindow = null;
      this.pipDoc = null;
      this.msgList = null;
      this.statusEl = null;
    }

    _showFallbackNote(text) {
      if (!this.pipDoc) return;
      const note = this.pipDoc.querySelector('.pip-fallback-note');
      if (note) note.textContent = text;
    }

    _buildPipDom({ chatOnly = false } = {}) {
      const doc = this.pipDoc;
      if (!doc) return;
      doc.documentElement.lang = 'ja';
      doc.title = t('extension_name');

      // ===== スタイル =====
      const style = doc.createElement('style');
      style.textContent = `
        :root { color-scheme: dark; }
        html, body { margin: 0; height: 100%; background: #0e0e10; color: #efeff1;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Roobert", sans-serif; }
        .pip-root { display: flex; height: 100%; }
        /* chat-only: 動画ペインとリサイザを隠してチャットを全幅化 */
        .pip-root.chat-only .pip-video-pane,
        .pip-root.chat-only .pip-resizer { display: none; }
        .pip-root.chat-only .pip-chat-pane { width: 100% !important; flex: 1 1 auto; }
        /* ── 動画ペイン ── */
        .pip-video-pane { position: relative; flex: 1 1 auto; background: #000; overflow: hidden; min-width: 240px; }
        video.pip-video { position: absolute; inset: 0; width: 100%; height: 100%;
          object-fit: contain; background: #000; display: block; }
        .pip-fallback-note { position: absolute; left: 12px; bottom: 12px;
          background: rgba(0,0,0,.6); padding: 6px 10px; border-radius: 4px;
          font-size: 12px; color: #ffb74d; pointer-events: none; }
        /* ── コントロール（動画の上にオーバーレイ） ── */
        .pip-controls { position: absolute; left: 0; right: 0; bottom: 0;
          display: flex; align-items: center; gap: 6px; padding: 8px 12px; height: 56px;
          background: linear-gradient(to top, rgba(0,0,0,.85) 0%, rgba(0,0,0,.55) 60%, transparent 100%);
          backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
          z-index: 10; transition: opacity .25s ease; }
        .pip-controls.hidden { opacity: 0; pointer-events: none; }
        .pip-btn { background: rgba(255,255,255,.1); border: 0; color: #fff;
          width: 32px; height: 32px; border-radius: 4px; cursor: pointer; font-size: 14px;
          display: inline-flex; align-items: center; justify-content: center;
          transition: background .15s ease, transform .15s ease; }
        .pip-btn:hover { background: rgba(255,255,255,.2); transform: scale(1.05); }
        .pip-seek { flex: 1 1 auto; appearance: none; height: 4px; background: rgba(255,255,255,.25);
          border-radius: 2px; outline: none; }
        .pip-seek::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px;
          background: #fff; border-radius: 50%; cursor: pointer; }
        .pip-time { color: #fff; font-variant-numeric: tabular-nums; font-size: 12px;
          font-weight: 600; text-shadow: 0 1px 2px rgba(0,0,0,.6); padding: 0 4px; }
        .pip-vol { width: 60px; }
        /* ── リサイザ ── */
        .pip-resizer { width: 6px; flex-shrink: 0; background: #0e0e10; cursor: ew-resize;
          position: relative; transition: background .15s; }
        .pip-resizer:hover { background: #3a3a3d; }
        .pip-resizer::before { content: ''; position: absolute; top:0; bottom:0; left:2px;
          width:1px; background:#5a5a66; opacity:0; transition: opacity .15s; }
        .pip-resizer:hover::before { opacity: 1; }
        /* ── チャットペイン ── */
        .pip-chat-pane { display: flex; flex-direction: column; width: 320px;
          flex-shrink: 0; background: #18181b; overflow: hidden; transition: opacity .15s; }
        .pip-chat-header { display: flex; align-items: center; gap: 6px;
          padding: 8px 10px; background: #1f1f23; border-bottom: 1px solid #3a3a3d;
          font-size: 13px; font-weight: 600; }
        .pip-chat-title { flex: 1 1 auto; }
        .pip-chat-pane .pip-btn { background: transparent; width: 28px; height: 28px; font-size: 13px; }
        .pip-chat-pane .pip-btn:hover { background: rgba(255,255,255,.1); }
        .pip-messages { flex: 1 1 auto; overflow-y: auto; padding: 4px 0; }
        .pip-status { display: none; align-items: center; padding: 5px 10px;
          background: #1f1f23; border-top: 1px solid #3a3a3d; font-size: 11px;
          color: #adadb8; min-height: 24px; flex-shrink: 0; }
        /* ── チャット内設定パネル ── */
        .pip-settings { display: none; padding: 8px 10px; background: #1f1f23;
          border-bottom: 1px solid #3a3a3d; font-size: 12px; color: #efeff1; }
        .pip-settings.open { display: block; }
        .pip-settings label { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
        .pip-settings input[type=range] { flex: 1 1 auto; }
        .pip-settings .label-text { min-width: 80px; }
      `;
      doc.head.appendChild(style);

      // ===== マークアップ（両ペインを常に描画。chat-only クラスで動画ペインを隠す） =====
      const root = doc.createElement('div');
      root.className = 'pip-root' + (chatOnly ? ' chat-only' : '');
      root.innerHTML = `
        <div class="pip-video-pane">
          <video class="pip-video" playsinline></video>
          <div class="pip-fallback-note" style="display:none"></div>
          <div class="pip-controls">
            <button class="pip-btn pip-play" title="${t('chat_btn_pause')}">⏸</button>
            <span class="pip-time">0:00 / 0:00</span>
            <input class="pip-seek" type="range" min="0" max="0" step="0.1" value="0">
            <button class="pip-btn pip-mute" title="mute">🔊</button>
            <input class="pip-vol" type="range" min="0" max="1" step="0.05" value="1">
          </div>
        </div>
        <div class="pip-resizer" role="separator" aria-orientation="vertical"></div>
        <div class="pip-chat-pane">
          <div class="pip-chat-header">
            <span class="pip-chat-title">${t('chat_header_title')}</span>
            <button class="pip-btn pip-pause-chat" title="${t('chat_btn_pause')}">⏸</button>
            <button class="pip-btn pip-settings-toggle" title="${t('chat_btn_settings')}">⚙</button>
          </div>
          <div class="pip-settings" role="region" aria-label="${t('settings_title')}">
            <label>
              <span class="label-text">${t('settings_chat_opacity')}</span>
              <input class="set-opacity" type="range" min="0.2" max="1" step="0.05">
            </label>
            <label>
              <input class="set-hide-header" type="checkbox">
              <span>${t('settings_hide_header')}</span>
            </label>
            <label>
              <input class="set-hide-status" type="checkbox">
              <span>${t('settings_hide_status_bar')}</span>
            </label>
            <label>
              <input class="set-click-seek" type="checkbox">
              <span>${t('settings_click_to_seek')}</span>
            </label>
          </div>
          <div class="pip-messages" id="pip-messages"></div>
          <div class="pip-status" id="pip-status"></div>
        </div>
      `;
      doc.body.appendChild(root);

      this.msgList = doc.getElementById('pip-messages');
      this.statusEl = doc.getElementById('pip-status');

      this._wirePipEvents();

      // 設定の初期値を UI に反映
      this._reflectSettingsToPipUi();
    }

    _reflectSettingsToPipUi() {
      const doc = this.pipDoc;
      const s = this.settings;
      if (!doc || !s) return;
      const opacity = doc.querySelector('.set-opacity');
      const hideHeader = doc.querySelector('.set-hide-header');
      const hideStatus = doc.querySelector('.set-hide-status');
      const clickSeek = doc.querySelector('.set-click-seek');
      if (opacity)    opacity.value = String(s.chatOpacity ?? 0.95);
      if (hideHeader) hideHeader.checked = !!s.hideHeader;
      if (hideStatus) hideStatus.checked = !!s.hideStatusBar;
      if (clickSeek)  clickSeek.checked = !!s.clickToSeek;

      const chatPane = doc.querySelector('.pip-chat-pane');
      if (chatPane) {
        chatPane.style.opacity = String(s.chatOpacity ?? 0.95);
        // chat-only モードでは pip-root.chat-only の CSS が width:100% を強制
        if (!doc.querySelector('.pip-root.chat-only')) {
          chatPane.style.width = `${s.chatWidth ?? 320}px`;
        }
      }
      const header = doc.querySelector('.pip-chat-header');
      if (header) header.style.display = s.hideHeader ? 'none' : 'flex';
      // status は _setStatus 経由に統一
      this._setStatus(this.statusEl?.textContent ?? '');
    }

    _wirePipEvents() {
      const doc = this.pipDoc;
      if (!doc) return;

      // ===== 動画コントロール =====
      const controls = doc.querySelector('.pip-controls');
      const playBtn = doc.querySelector('.pip-play');
      const timeEl = doc.querySelector('.pip-time');
      const seekEl = doc.querySelector('.pip-seek');
      const muteBtn = doc.querySelector('.pip-mute');
      const volEl = doc.querySelector('.pip-vol');

      // 元動画の状態を反映
      const fmt = (s) => {
        s = Math.max(0, Math.floor(s));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const ss = s % 60;
        const p = (n) => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
      };
      const syncToOriginal = () => {
        const v = this._freshVideo();
        if (!v) return;
        if (timeEl) timeEl.textContent = `${fmt(v.currentTime)} / ${fmt(v.duration)}`;
        if (seekEl) {
          seekEl.max = String(v.duration || 0);
          if (!seekEl.matches(':active')) seekEl.value = String(v.currentTime || 0);
        }
        if (playBtn) playBtn.textContent = v.paused ? '▶' : '⏸';
      };
      const v0 = this._freshVideo();
      v0?.addEventListener('timeupdate', syncToOriginal);
      v0?.addEventListener('durationchange', syncToOriginal);
      v0?.addEventListener('play', () => { syncToOriginal(); this._refreshMirror(); });
      v0?.addEventListener('pause', syncToOriginal);
      syncToOriginal();

      // play/pause: 複数の手段でフォールバック
      // 1. Twitch 自身の再生ボタンをクリック (React の state machine 経由)
      // 2. 直接 video.play()
      // 3. シーク強制で HLS ストリームの再ロード (Twitch が長時間停止後にストリームを破棄するため)
      // 4. すべてダメなら PiP 上に通知を出す
      const findTwitchPlayBtn = () =>
        /** @type {HTMLElement|null} */ (
          document.querySelector('[data-a-target="player-play-pause-button"]')
        );
      const tryPlay = async () => {
        const v = this._freshVideo();
        if (!v) return;

        // ★ Step 1: 同期で v.play() を呼ぶ。
        //    PIP クリックの transient activation は Document PiP 仕様により
        //    opener (Twitch ドキュメント) に付与されているが、await/setTimeout/
        //    microtask が挟まると消費・期限切れする。よって await の前に
        //    必ず v.play() を呼んで Promise を得ておく。
        //    (この Promise を後で await することで autoplay policy を回避できる)
        let playPromise;
        try {
          playPromise = v.play();
        } catch (err) {
          // 古いブラウザでは同期 throw する可能性
          logError('pip/play-sync-throw', err);
          playPromise = Promise.reject(err);
        }

        // ★ Step 2: 同期で Twitch ボタンをクリックして React state を同期。
        //    これも await の前に同期で実行する必要がある。
        const btn = findTwitchPlayBtn();
        if (btn) {
          try { btn.click(); } catch {}
        }

        // ★ ここから先は async OK。gesture は既に v.play() に消費されている。
        try {
          await playPromise;
          this._refreshMirror();
          return;
        } catch (err) {
          logError('pip/play-direct', err);
          // NotAllowedError なら autoplay policy 起因。後段のリカバリへ。
        }

        // 3) シーク強制で HLS バッファ再要求 → 再生
        //    （HLS ストリームが古くなって最初の v.play() が失敗した場合の保険）
        try {
          const t = v.currentTime;
          v.currentTime = Math.max(0, t - 0.1);
          await new Promise((r) => setTimeout(r, 300));
          await v.play();
          this._refreshMirror();
          return;
        } catch (err) {
          logError('pip/play-reload', err);
        }

        // 4) すべて失敗 → ユーザに知らせる
        this._showFallbackNote(
          t('fallback_play_failed') ||
          '再生開始失敗。Twitch タブをアクティブにしてから再生してください'
        );
      };      const tryPause = () => {
        // ★ Twitch ボタンクリックのみに統一。
        //    v.pause() 直接呼び出しを併用すると、タブが背景化されたあとに
        //    Twitch React の内部状態と HTMLVideoElement の状態が二重操作で
        //    噛み合わなくなり、PIP から再生再開ができなくなる。
        //    Twitch ボタンが見つからない時のみフォールバックする。
        const btn = findTwitchPlayBtn();
        if (btn) {
          try { btn.click(); } catch {}
          return;
        }
        const v = this._freshVideo();
        if (v && !v.paused) v.pause();
      };
      playBtn?.addEventListener('click', () => {
        const v = this._freshVideo();
        if (!v) return;
        if (v.paused) tryPlay();
        else tryPause();
      });
      seekEl?.addEventListener('input', () => {
        const v = this._freshVideo();
        if (!v) return;
        v.currentTime = Number(seekEl.value);
      });
      muteBtn?.addEventListener('click', () => {
        const v = this._freshVideo();
        if (!v) return;
        v.muted = !v.muted;
        muteBtn.textContent = v.muted ? '🔇' : '🔊';
      });
      volEl?.addEventListener('input', () => {
        const v = this._freshVideo();
        if (!v) return;
        v.volume = Number(volEl.value);
      });

      // ===== コントロール自動非表示 =====
      const videoPane = doc.querySelector('.pip-video-pane');
      let hideT = null;
      const scheduleHide = (delay) => {
        clearTimeout(hideT);
        hideT = setTimeout(() => controls?.classList.add('hidden'), delay);
      };
      const showNow = () => {
        controls?.classList.remove('hidden');
        scheduleHide(2000);
      };
      videoPane?.addEventListener('mousemove', showNow);
      videoPane?.addEventListener('mouseleave', () => scheduleHide(500));
      showNow();

      // ===== リサイザ =====
      const resizer = doc.querySelector('.pip-resizer');
      const chatPane = doc.querySelector('.pip-chat-pane');
      let resizing = false;
      let startX = 0;
      let startW = 0;
      resizer?.addEventListener('mousedown', (e) => {
        resizing = true;
        startX = e.clientX;
        startW = chatPane.getBoundingClientRect().width;
        e.preventDefault();
      });
      doc.addEventListener('mousemove', (e) => {
        if (!resizing) return;
        const dx = startX - e.clientX;
        const next = Math.max(200, Math.min(600, startW + dx));
        chatPane.style.width = `${next}px`;
      });
      doc.addEventListener('mouseup', () => {
        if (!resizing) return;
        resizing = false;
        const w = Math.round(chatPane.getBoundingClientRect().width);
        setSettings({ chatWidth: w });
      });

      // ===== チャットヘッダー =====
      doc.querySelector('.pip-pause-chat')?.addEventListener('click', (ev) => {
        this.paused = !this.paused;
        /** @type {HTMLElement} */ (ev.currentTarget).textContent = this.paused ? '▶' : '⏸';
      });
      const settingsPanel = doc.querySelector('.pip-settings');
      doc.querySelector('.pip-settings-toggle')?.addEventListener('click', () => {
        settingsPanel?.classList.toggle('open');
      });

      // ===== 設定パネルの操作 =====
      doc.querySelector('.set-opacity')?.addEventListener('input', (e) => {
        const v = Number(/** @type {HTMLInputElement} */ (e.target).value);
        if (chatPane) chatPane.style.opacity = String(v);
        setSettings({ chatOpacity: v });
      });
      doc.querySelector('.set-hide-header')?.addEventListener('change', (e) => {
        const on = /** @type {HTMLInputElement} */ (e.target).checked;
        const header = doc.querySelector('.pip-chat-header');
        if (header) header.style.display = on ? 'none' : 'flex';
        setSettings({ hideHeader: on });
      });
      doc.querySelector('.set-hide-status')?.addEventListener('change', (e) => {
        const on = /** @type {HTMLInputElement} */ (e.target).checked;
        setSettings({ hideStatusBar: on });
        this._setStatus(this.statusEl?.textContent ?? '');
      });
      doc.querySelector('.set-click-seek')?.addEventListener('change', (e) => {
        setSettings({ clickToSeek: /** @type {HTMLInputElement} */ (e.target).checked });
      });

      // ===== チャットメッセージのスクロール追従 =====
      this.msgList?.addEventListener('scroll', () => {
        if (!this.msgList) return;
        const nearBottom =
          this.msgList.scrollHeight - this.msgList.scrollTop - this.msgList.clientHeight < 20;
        this.userScrolled = !nearBottom;
      });
    }

    _renderRow(c) {
      if (!this.msgList || !c?.raw) return;
      const comment = c.raw;
      const s = this.settings;

      let row;
      try {
        row = renderMessage(comment, {
          emoteMap: this.emoteMap,
          badgeMap: this.badgeMap,
          emoteSize: s?.emoteSize ?? 1,
          onSeek: s?.clickToSeek
            ? (sec) => { const v = this._freshVideo(); if (v) v.currentTime = sec; }
            : undefined,
        });
      } catch (err) {
        logError('session/renderMessage', err);
        return;
      }

      this.shownIds.add(c.id);
      this.msgList.appendChild(row);

      // 上限
      while (this.msgList.childElementCount > MAX_MESSAGES) {
        const removed = this.msgList.firstElementChild;
        const ofs = removed?.dataset.offset;
        // shownIds は残しても OK（再表示防止のため）
        removed?.remove();
        void ofs;
      }
      // 自動スクロール
      if (!this.userScrolled) {
        this.msgList.scrollTop = this.msgList.scrollHeight;
      }
    }

    destroy() {
      this.destroyed = true;
      if (this.syncTimer) clearTimeout(this.syncTimer);
      this._unsubSettings?.();
      try { if (this.pipWindow && !this.pipWindow.closed) this.pipWindow.close(); } catch {}
      this.pipWindow = null;
      this.pipDoc = null;
    }
  }

  // ============================================================
  // ブートストラップ + SPA ナビ対応
  // ============================================================
  async function bootstrap(videoId) {
    if (session?.videoId === videoId) return;
    session?.destroy();
    session = null;

    const settings = await getSettings();
    if (!settings.enabled) return;

    session = new VodSession(videoId);
    try {
      await session.init();
      // ★ autoStartOnVod は仕様上動作しないため削除済み。
      //   PiP は popup の「今すぐ PiP で開く」または Alt+Shift+C で開く。
    } catch (err) {
      logError('bootstrap', err);
    }
  }

  // 初回
  const initial = parseVodIdFromUrl();
  if (initial) bootstrap(initial);

  // SPA ナビ
  watchUrlChanges((newUrl) => {
    const vod = parseVodIdFromUrl(newUrl);
    if (vod) bootstrap(vod);
    else { session?.destroy(); session = null; }
  });

  // 設定で enabled が後から ON になった場合
  subscribeSettings((next) => {
    if (!next.enabled && session) { session.destroy(); session = null; return; }
    if (next.enabled && !session) {
      const v = parseVodIdFromUrl();
      if (v) bootstrap(v);
    }
  });

  // i18n は popup/options/PiP それぞれで applyI18n() を呼ぶ。
  // content script 本体は静的 DOM を持たないのでここでは不要。
  void applyI18n;
})();
