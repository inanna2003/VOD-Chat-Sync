// src/api/badges.js
// Twitch のバッジを解決する。
//
// ★ 重要な変更（バッジ非表示の修正）★
// badges.twitch.tv/v1/badges/global/display 系の endpoint は 2023-06-08 に
// Twitch によって正式に廃止された。
// 参考: https://discuss.dev.twitch.com/t/legacy-badges-endpoint-shutdown-details-and-timeline-june-2023/44621
//
// 代替手段:
//   1) gql.twitch.tv で inline GraphQL を投げる（Android Client-ID 使用、未認証で OK）
//   2) GraphQL が失敗した場合、ハードコードした共通バッジで最低限の表示を保証
//
// ハードコードでカバーするのは: broadcaster / moderator / vip / staff / partner /
// premium (Prime) / founder / verified / subscriber(default) / bits の代表的階級。
// チャンネル固有のサブスクリプションバッジ（〇〇ヶ月などのカスタム画像）は
// チャンネル GraphQL が通れば表示、通らなければ default subscriber 画像で代用する。

import { fetchWithRetry, FatalFetchError } from './net.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const TTL_FAIL_MS = 60 * 60 * 1000;
const CACHE_PREFIX = 'badgeCache:v2:'; // v1 とキャッシュキーを分ける

const GQL_ENDPOINT = 'https://gql.twitch.tv/gql';
const ANDROID_CLIENT_ID = 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp';

// ============================================================
// ハードコード共通バッジ
// （Twitch の static-cdn は今後も配信される画像 URL）
// ============================================================
const HARDCODED_BADGES = {
  broadcaster: { '1': mk('5527c58c-fb7d-422d-b71b-f309dcb85cc1', 'Broadcaster') },
  moderator:   { '1': mk('3267646d-33f0-4b17-b3df-f923a41db1d0', 'Moderator') },
  vip:         { '1': mk('b817aba4-fad8-49e2-b88a-7cc744dfa6ec', 'VIP') },
  staff:       { '1': mk('d97c37bd-a6f5-4c38-8f57-4e4bef88af34', 'Staff') },
  admin:       { '1': mk('9ef7e029-4cdf-4d4d-a0d5-e2b3fb2583fe', 'Admin') },
  global_mod:  { '1': mk('9384c43e-4ce7-4e94-b2a1-b93656896eba', 'Global Moderator') },
  partner:     { '1': mk('d12a2e27-16f6-41d0-ab77-b780518f00a3', 'Partner') },
  premium:     { '1': mk('bbbe0db0-a598-423e-86d0-f9fb98ca1933', 'Prime Gaming') },
  turbo:       { '1': mk('bd444ec6-8f34-4bf9-91f4-af1e3428d80f', 'Turbo') },
  verified:    { '1': mk('d12a2e27-16f6-41d0-ab77-b780518f00a3', 'Verified') },
  founder:     { '0': mk('511b78a9-ab37-472f-9569-457753bbe7d3', 'Founder') },
  'artist-badge': { '1': mk('4300a897-03dc-4e83-8c0e-c332fee7057f', 'Artist') },
  no_audio:    { '1': mk('aef2cd08-f29b-45a1-8c12-d44d7fd5e6f0', 'No Audio') },
  no_video:    { '1': mk('199a0dba-58f3-494e-a7fc-1fa0a1001fb8', 'No Video') },
  // サブスクライバ (デフォルト)。バージョン番号は実際は月数だが、
  // チャンネル固有画像が取れない時の汎用 fallback として default を返す。
  subscriber: { '0': mk('5d9f2208-5dd8-11e7-8513-2ff4adfae661', 'Subscriber') },
  // ビッツ階級（代表的なもの）
  bits: {
    '1':    mk('73b5c3fb-24f9-4a82-a852-2f475b59411c', 'cheer 1'),
    '100':  mk('5056c366-7299-4b3c-a15a-a18573650bfb', 'cheer 100'),
    '1000': mk('b8c76744-c7e9-44be-90d0-08840a8f6e39', 'cheer 1000'),
    '5000': mk('5ec2ee3e-5633-4c2a-8e77-77473fe25a69', 'cheer 5000'),
    '10000': mk('68af213b-a771-4124-b6e3-9bb6d98269d3', 'cheer 10000'),
  },
};

function mk(uuid, title) {
  return {
    imageUrl: `https://static-cdn.jtvnw.net/badges/v1/${uuid}/2`,
    title,
  };
}

// ============================================================
// キャッシュ
// ============================================================
async function getCached(key) {
  try {
    const all = await chrome.storage.local.get(key);
    const entry = all?.[key];
    if (!entry) return null;
    const ttl = entry.failed ? TTL_FAIL_MS : TTL_MS;
    if (Date.now() - entry.ts > ttl) return null;
    return entry.data;
  } catch {
    return null;
  }
}

async function setCached(key, data, failed = false) {
  try {
    await chrome.storage.local.set({ [key]: { ts: Date.now(), data, failed } });
  } catch {
    /* quota */
  }
}

// ============================================================
// GraphQL での取得（チャンネル固有のサブスクリプションバッジを含む）
// ============================================================

// Twitch の内部 GraphQL schema には User.broadcastBadges と (root).badges がある。
// schema は変動するため inline query で投げて、エラーになれば fallback。
const BADGES_QUERY = `
  query VodChatSyncBadges($channelId: ID!) {
    badges {
      setID
      version
      title
      imageURL(size: NORMAL)
    }
    user(id: $channelId) {
      broadcastBadges {
        setID
        version
        title
        imageURL(size: NORMAL)
      }
    }
  }
`;

async function fetchBadgesViaGraphQL(channelId) {
  const res = await fetchWithRetry(GQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Client-ID': ANDROID_CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      operationName: 'VodChatSyncBadges',
      query: BADGES_QUERY,
      variables: { channelId: String(channelId ?? '0') },
    }),
    retry: { maxRetries: 1 },
  });
  const j = await res.json();
  if (Array.isArray(j?.errors) && j.errors.length) {
    throw new Error('GraphQL errors: ' + j.errors.map((e) => e?.message ?? '').join(' / '));
  }

  /** @type {Record<string, Record<string, { imageUrl: string, title: string }>>} */
  const out = {};
  const collect = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const b of arr) {
      const setId = b?.setID;
      const ver = b?.version;
      const img = b?.imageURL;
      if (!setId || !ver || !img) continue;
      if (!out[setId]) out[setId] = {};
      out[setId][ver] = {
        imageUrl: img,
        title: b.title ?? `${setId}/${ver}`,
      };
    }
  };
  collect(j?.data?.badges);
  collect(j?.data?.user?.broadcastBadges);
  return out;
}

// ============================================================
// 公開 API
// ============================================================

/**
 * チャンネル ID を渡すと、グローバル + チャンネル固有のバッジを統合した
 * setID -> version -> {imageUrl, title} の Map を返す。
 *
 * 動作:
 *   1) キャッシュにあればそれを返す
 *   2) GraphQL を試行 → 成功すればキャッシュして返す
 *   3) 失敗時はハードコードバッジで fallback（キャッシュも更新）
 *
 * いずれにしても resolveBadge() で見つからなければ単に「バッジ画像を表示しない」
 * だけで、チャット行は壊れない。
 *
 * @param {string|null} channelId
 */
export async function loadBadgeMap(channelId = null) {
  const cacheKey = `${CACHE_PREFIX}${channelId ?? 'global'}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  // 1) GraphQL を試す
  try {
    const fromGql = await fetchBadgesViaGraphQL(channelId);
    if (Object.keys(fromGql).length > 0) {
      // GraphQL の結果にハードコードを「補完」として上書きせずに足す
      const merged = mergeBadges(HARDCODED_BADGES, fromGql);
      await setCached(cacheKey, merged);
      return merged;
    }
  } catch (err) {
    // ignore — fall through to hardcoded
    if (!(err instanceof FatalFetchError)) {
      console.warn('[badges] graphql fetch failed, falling back to hardcoded:', err?.message ?? err);
    }
  }

  // 2) Fallback: ハードコードのみ
  const merged = { ...HARDCODED_BADGES };
  // 短い失敗 TTL でキャッシュ（次のセッションで GraphQL を再試行できるように）
  await setCached(cacheKey, merged, true);
  return merged;
}

/** GraphQL 結果でハードコード結果を上書きしつつマージ */
function mergeBadges(base, override) {
  /** @type {typeof base} */
  const out = {};
  for (const [setId, versions] of Object.entries(base)) {
    out[setId] = { ...versions };
  }
  for (const [setId, versions] of Object.entries(override)) {
    out[setId] = { ...(out[setId] ?? {}), ...versions };
  }
  return out;
}

/**
 * バッジ参照 {setID, version} を解決
 *
 * @param {{ setID: string, version: string } | null} ref
 * @param {Record<string,Record<string,{imageUrl:string,title:string}>>|null} badgeMap
 */
export function resolveBadge(ref, badgeMap) {
  if (!ref || !badgeMap) return null;
  const set = badgeMap[ref.setID];
  if (!set) return null;
  // 完全一致を試す
  if (set[ref.version]) return set[ref.version];
  // 一致しなければ default としてそのセットの最初のバージョンを返す
  // （特にサブスクライバ階級でチャンネル GraphQL が取れていない時の fallback）
  if (ref.setID === 'subscriber' && set['0']) return set['0'];
  // bits は最も近い tier を選ぶよりも素直に未表示
  return null;
}