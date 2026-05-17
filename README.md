# VOD Chat Sync

A browser extension that brings synchronized chat replay to Twitch VOD playback,
shown in an always-on-top Picture-in-Picture window so you can keep an eye on
chat while doing something else.

<p align="center">
  <img src="icons/preview.png" alt="VOD Chat Sync icons" width="420">
</p>

> Not affiliated with, endorsed by, or sponsored by Twitch Interactive, Inc.,
> BetterTTV, FrankerFaceZ, or 7TV. Twitch is a trademark of its respective owner.

[日本語版はこちら](./README.ja.md)

---

## Features

- **Document Picture-in-Picture** — A real always-on-top window (Chrome / Edge
  101+). Stays visible across virtual desktops and full-screen apps.
- **Two modes** — *Video + Chat* (mirrors the VOD into the PiP window via
  `captureStream`) or *Chat only* (lightest CPU usage).
- **Third-party emotes** — BetterTTV, FrankerFaceZ, and 7TV global and per-channel
  emotes, fetched directly from each provider's public API and cached locally.
- **Click-to-seek** — Click any chat line to jump the video to that timestamp.
- **Resizable, adjustable** — Drag the divider to resize the chat panel;
  opacity, emote size, header/status visibility, and click-to-seek are all
  user-configurable.
- **Localized** — English and Japanese UI included.

## Installation

### From the Chrome Web Store

*(Coming soon — link will be added once published.)*

### Manual install (for development)

1. Clone or download this repository.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Toggle on **Developer mode**.
4. Click **Load unpacked** and select the project folder.

## Usage

1. Open any Twitch VOD page (`https://www.twitch.tv/videos/<id>`).
2. Click the extension icon and press **Open PiP now**.
3. A floating window opens. The chat panel will start populating as the video
   plays; seek the video and chat re-syncs.

### Settings

The settings page (extension icon → *Settings*) lets you adjust:

- **Display** — chat opacity, default chat width, emote size, hide chat header,
  hide status bar.
- **Behavior** — mirror video into PiP, click chat to seek.

You can also copy a diagnostic report (no PII; OAuth tokens auto-redacted)
from the same page to attach to bug reports.

## Permissions

| Permission                       | Why it's needed                                                                |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `storage`                        | Persist your settings across sessions / devices.                               |
| `tabs`                           | Route the keyboard shortcut to the active Twitch tab.                          |
| `https://www.twitch.tv/*`        | Detect VOD pages and attach the chat replay UI.                                |
| `https://gql.twitch.tv/*`        | Fetch the public VOD-comments GraphQL endpoint (unauthenticated).              |
| `https://static-cdn.jtvnw.net/*` | Load Twitch's official emote and badge images.                                 |
| `https://api.betterttv.net/*`, `https://cdn.betterttv.net/*` | Load BetterTTV emotes (anonymous, GET only). |
| `https://api.frankerfacez.com/*` | Load FrankerFaceZ emotes (anonymous, GET only).                                |
| `https://7tv.io/*`               | Load 7TV emotes (anonymous, GET only).                                         |

## Privacy

VOD Chat Sync does **not** collect, transmit, or sell any personal data.
All settings are kept locally via `chrome.storage`. The only outbound network
requests are to the public APIs listed above, and none of them carry any
account credentials, user identifiers, or analytics payloads.

The full policy is in [PRIVACY.md](./PRIVACY.md).

## How it works (brief)

The extension queries Twitch's internal but publicly accessible
`VideoCommentsByOffsetOrCursor` GraphQL operation — the same one Twitch's own
web player uses for replaying chat — with the Android client ID. Comments are
buffered for a few seconds ahead of `<video>.currentTime` and rendered into a
Document PiP window. Seeks flush the buffer and re-request from the new offset.

For the curious, the noteworthy implementation choices are documented inline:

- `keep-active.js` — overrides `visibilityState` so Twitch's player doesn't
  pause when the tab is backgrounded
- `src/api/twitch-gql.js` — uses the Android client ID to avoid the
  integrity-check rate-limit that the web client ID triggers
- `src/api/badges.js` — falls back to hard-coded global badges because the
  legacy `badges.twitch.tv/v1` endpoint was shut down in June 2023
- `src/core/lifecycle.js` — surfaces `NotAllowedError` from
  `documentPictureInPicture.requestWindow` as a user-actionable message

## Browser support

| Browser              | Status                                            |
| -------------------- | ------------------------------------------------- |
| Chrome 116+          | ✅ Full support (Document PiP + `captureStream`)  |
| Edge 116+            | ✅ Full support                                   |
| Brave / Opera 116+   | ✅ Should work, not extensively tested            |
| Firefox              | ❌ No Document Picture-in-Picture API yet         |

## Development

```text
project/
├── manifest.json
├── background.js          # service worker — keyboard-shortcut routing
├── content_script.js      # main page logic, PiP DOM, chat rendering
├── keep-active.js         # tab-visibility shim (MAIN world)
├── _locales/{en,ja}/messages.json
├── icons/
├── options/               # settings page
├── popup/                 # toolbar popup
└── src/
    ├── api/               # GraphQL / emote / badge fetching
    ├── core/              # i18n, settings, lifecycle, errors, feature-detect
    └── render/            # message renderer
```

Pure ES modules, no build step. To iterate: edit, reload the unpacked
extension at `chrome://extensions`, then reload the Twitch tab.

## Contributing

Bug reports and pull requests are welcome. For larger changes, please open an
issue first to discuss what you'd like to change. Please run the extension
against a real Twitch VOD before submitting — automated tests are not yet
provided.

## License

[MIT](./LICENSE) © the contributors.

## Support the project

If this extension makes your stream-archive binges more pleasant, you can leave
a tip on Ko-fi. Completely optional and very appreciated.

[☕ ko-fi.com/Inanna2003](https://ko-fi.com/Inanna2003)
