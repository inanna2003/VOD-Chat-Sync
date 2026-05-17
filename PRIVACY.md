# Privacy Policy — VOD Chat Sync

_Last updated: 2026_

This extension is designed to be a self-contained client that runs entirely in
your browser. It does not collect, transmit, sell, share, or otherwise process
personal information.

## 1. What data this extension stores

The extension keeps the following data **on your device only**, via the
browser's standard `chrome.storage` API:

- Your preferences (chat opacity, chat width, emote size, hide-header /
  hide-status-bar / click-to-seek toggles, master enable/disable, PiP mode).
- A short-lived cache of public emote and badge metadata fetched from
  third-party APIs (see §3). The cache is keyed by channel ID and has a TTL
  of 24 hours (1 hour for failed fetches). It contains image URLs and emote
  codes only — no personal information.
- An internal ring buffer of the most recent 50 error log entries, used by the
  "Copy diagnostic info" feature. This buffer is in memory only; nothing is
  uploaded automatically. If you choose to use "Copy diagnostic info", the
  contents are placed on your clipboard and nowhere else; OAuth/Bearer tokens
  and `access_token=` query strings are redacted before they enter the buffer.

When the browser's sync is enabled and the data fits within the `storage.sync`
quota, your preferences may also be synced across your own devices by the
browser vendor (Google / Microsoft / Brave). That sync is provided by your
browser, not by this extension; this extension only writes to the same storage
slot the browser exposes.

The extension never writes to your filesystem outside the browser's own
storage sandbox, never uses cookies, never uses IndexedDB, and never reads any
data outside of the active Twitch tab's URL and `<video>` element.

## 2. What data this extension does **not** collect

- No name, email address, or any account identifier.
- No Twitch credentials (the extension is never logged in to Twitch).
- No browsing history.
- No analytics, telemetry, crash reports, or "usage statistics" of any kind.
- No A/B-testing, advertising, or fingerprinting.
- No keystrokes, mouse positions, or page content outside the VOD chat replay
  data described below.

## 3. Third-party services this extension contacts

The extension makes **unauthenticated**, **anonymous** HTTP GET / POST requests
to the following hosts solely to render the chat replay and its emotes / badges:

| Host                          | Purpose                                          | Authenticated? |
| ----------------------------- | ------------------------------------------------ | -------------- |
| `gql.twitch.tv`               | Fetch VOD chat-replay messages (GraphQL)         | No             |
| `static-cdn.jtvnw.net`        | Load Twitch official emote / badge images        | No             |
| `api.betterttv.net`           | Fetch BetterTTV emote metadata                   | No             |
| `cdn.betterttv.net`           | Load BetterTTV emote images                      | No             |
| `api.frankerfacez.com`        | Fetch FrankerFaceZ emote metadata                | No             |
| `7tv.io`                      | Fetch 7TV emote metadata and images              | No             |

These requests carry standard browser headers (User-Agent, Accept, etc.) and
the channel or video ID you are currently viewing. They do **not** include any
account credentials. Each of those services' own privacy policies governs how
they log incoming requests; we have no special relationship with any of them
and have no access to their logs.

The extension does not contact any server we operate. There is no first-party
backend.

## 4. Permissions and why they exist

| Permission                       | Why we ask for it                                                           |
| -------------------------------- | --------------------------------------------------------------------------- |
| `storage`                        | Save your preferences as described in §1.                                   |
| `tabs`                           | Send the "Open PiP now" command from the toolbar popup to the active Twitch tab. |
| `https://www.twitch.tv/*`        | Detect VOD pages and attach the chat-replay UI.                             |
| `https://gql.twitch.tv/*`        | Fetch the VOD chat-replay messages (unauthenticated GraphQL).               |
| `https://static-cdn.jtvnw.net/*` | Load Twitch official emote / badge images referenced inside chat messages.  |
| `https://api.betterttv.net/*` and `https://cdn.betterttv.net/*` | Load BetterTTV emotes referenced inside chat messages.  |
| `https://api.frankerfacez.com/*` | Load FrankerFaceZ emotes referenced inside chat messages.                   |
| `https://7tv.io/*`               | Load 7TV emotes referenced inside chat messages.                            |

The extension does **not** request, and does not need, `webRequest`,
`<all_urls>`, `cookies`, `history`, `bookmarks`, or any other broad permission.

## 5. Children

This extension is not directed to children and we do not knowingly collect any
information from anyone, including children, since we collect nothing in the
first place.

## 6. Changes

If meaningful changes are made to this policy, they will be reflected in this
file with an updated "Last updated" date. Material changes will additionally
be noted in the extension's release notes / `CHANGELOG.md`.

## 7. Contact

For questions about this policy, please open an issue on the GitHub
repository: <https://github.com/inanna2003/vod-chat-sync/issues>
