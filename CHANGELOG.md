# Changelog

All notable changes to **VOD Chat Sync** are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.2.1] — 2026

### Initial public release

- Document Picture-in-Picture chat replay window for Twitch VOD pages.
- Two PiP modes:
  - **Video + Chat** — mirrors the VOD video into the floating window via
    `HTMLMediaElement.captureStream`.
  - **Chat only** — chat replay only, no video mirror (lower CPU usage).
- VOD chat is fetched from Twitch's public GraphQL `VideoCommentsByOffsetOrCursor`
  operation, using the Android client ID to avoid the integrity-check
  rate-limit that affects the web client ID.
- Third-party emote support: BetterTTV, FrankerFaceZ, and 7TV (global and
  per-channel sets, including animated emotes).
- Hard-coded fallback for global Twitch chat badges (broadcaster, moderator,
  VIP, Prime, founder, etc.) since the legacy `badges.twitch.tv/v1` endpoint
  was shut down in June 2023.
- Click-to-seek: clicking any chat line moves the video playback head to that
  timestamp.
- Resizable chat panel (drag the divider); resize state is persisted.
- Settings page with: chat opacity, chat width, emote size, hide chat header,
  hide status bar, mirror video into PiP, click-to-seek.
- Diagnostic-info copy with automatic redaction of OAuth/Bearer tokens.
- Tab visibility shim — the Twitch player no longer auto-pauses while the tab
  is backgrounded.
- Surfaces `NotAllowedError` from `documentPictureInPicture.requestWindow` as
  an actionable "click the page first, then retry" message.
- English and Japanese localization.

### Known limitations

- Auto-start when entering a VOD is intentionally not provided — Document PiP
  requires a fresh user gesture and cannot be triggered on navigation.
- Firefox is unsupported (no Document Picture-in-Picture API).
