// src/api/twitch-gql.js
// Twitch の内部 GraphQL を叩く。
//
// ★ 重要な変更（PIP起動5秒後にコメントが止まる問題の修正）★
// Web の Client-ID (kimne78kx3ncx6brgo4mv6wki5h1ko) を使うと、
// Twitch は数回のリクエスト後に "failed integrity check" を返すようになる。
// このエラーは "rate-limit" として誤検知され 60 秒のクールダウンに入る。
// Android の Client-ID は VideoCommentsByOffsetOrCursor の読み取りに対しては
// integrity check が要求されないため、これを使うことで根本的に回避できる。
// 参考:
//   - https://www.jordanmryyan.com/posts/Training-a-Language-Model-to-Mimic-Twitch-Chat-Part-1-vv
//   - https://github.com/lay295/TwitchDownloader (TwitchDownloaderCore で同 ID を使用)
//   - https://qiita.com/unotame/items/9a98f118392eed8469d9 (2024-08 動作確認)

import { fetchWithRetry, FatalFetchError } from './net.js';

const ENDPOINT = 'https://gql.twitch.tv/gql';
// Android アプリ用の公開 Client-ID。
// VOD コメントなどの読み取り操作で integrity check を回避できる。
const ANDROID_CLIENT_ID = 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp';

const PERSISTED_HASH_VOD_COMMENTS =
  'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a';

const INLINE_VOD_COMMENTS_QUERY = `
  query VideoCommentsByOffsetOrCursor(
    $videoID: ID!
    $contentOffsetSeconds: Int
    $cursor: Cursor
  ) {
    video(id: $videoID) {
      id
      creator { id channel { id } }
      comments(contentOffsetSeconds: $contentOffsetSeconds, after: $cursor) {
        edges {
          cursor
          node {
            id
            contentOffsetSeconds
            commenter { id displayName login }
            message {
              fragments { text emote { emoteID } }
              userBadges { setID version }
              userColor
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }
`;

export class GqlError extends Error {
  constructor(message, code = 'SCHEMA') {
    super(message);
    this.name = 'GqlError';
    this.code = code; // VIDEO_NOT_FOUND | FORBIDDEN | RATE_LIMITED | NETWORK | INTEGRITY | SCHEMA
  }
}

// Android Client-ID は固定。スクレイピングフォールバックは
// content script が isolated world で動くため window 直接アクセスが
// 不可能（page world とは別ヒープ）なので削除した。
const currentClientId = ANDROID_CLIENT_ID;

function buildHeaders() {
  // Android Client-ID では Authorization ヘッダを送らない。
  // (Web 用トークンを別 Client-ID で送ると 401 になり得るため、未認証でリクエストする。
  //  VOD のコメント読み取りは未認証で完全に動作する)
  return {
    'Client-ID': currentClientId,
    'Content-Type': 'application/json',
  };
}

async function postGql(body) {
  const res = await fetchWithRetry(ENDPOINT, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * VOD コメントを取得する。
 * @param {{ videoId: string, offsetSeconds?: number, cursor?: string|null }} params
 */
export async function fetchVideoComments({ videoId, offsetSeconds = 0, cursor = null }) {
  const variables = cursor
    ? { videoID: videoId, cursor }
    : { videoID: videoId, contentOffsetSeconds: Math.floor(offsetSeconds) };

  /** @param {'persisted'|'inline'} mode */
  async function attempt(mode) {
    const body = mode === 'persisted'
      ? {
          operationName: 'VideoCommentsByOffsetOrCursor',
          variables,
          extensions: {
            persistedQuery: { version: 1, sha256Hash: PERSISTED_HASH_VOD_COMMENTS },
          },
        }
      : {
          operationName: 'VideoCommentsByOffsetOrCursor',
          query: INLINE_VOD_COMMENTS_QUERY,
          variables,
        };
    return postGql(body);
  }

  // 1) persisted を試す
  let json = null;
  try {
    json = await attempt('persisted');
  } catch (err) {
    if (err instanceof FatalFetchError && err.status === 403) {
      throw new GqlError('Forbidden', 'FORBIDDEN');
    }
    throw new GqlError(err?.message ?? 'network error', 'NETWORK');
  }

  // 2) persisted がダメな場合 → inline で再試行
  const errMsgs0 = Array.isArray(json?.errors)
    ? json.errors.map((e) => e?.message ?? '').join(' / ')
    : '';
  const pqMissing = /PersistedQueryNotFound|persisted/i.test(errMsgs0);
  const videoNullNoError = !errMsgs0 && json?.data?.video === null;
  if (pqMissing || videoNullNoError) {
    try {
      json = await attempt('inline');
    } catch (err) {
      throw new GqlError(err?.message ?? 'inline query failed', 'NETWORK');
    }
  }

  // 3) エラー分類
  if (Array.isArray(json?.errors) && json.errors.length) {
    const msgs = json.errors.map((e) => e?.message ?? '').join(' / ');
    if (/integrity/i.test(msgs)) {
      // ★ Android Client-ID 使用後は通常ここには来ない。
      // 来た場合は Twitch 側仕様が変わった可能性があり、ユーザに知らせる必要がある。
      throw new GqlError(msgs, 'INTEGRITY');
    }
    if (/not authorized|forbidden|subscriber/i.test(msgs)) {
      throw new GqlError(msgs, 'FORBIDDEN');
    }
    if (/rate.?limit|throttled/i.test(msgs)) {
      throw new GqlError(msgs, 'RATE_LIMITED');
    }
    if (/not.?found|does not exist/i.test(msgs)) {
      throw new GqlError(msgs, 'VIDEO_NOT_FOUND');
    }
    throw new GqlError(msgs, 'SCHEMA');
  }

  const video = json?.data?.video ?? null;
  if (!video) throw new GqlError('video field missing', 'VIDEO_NOT_FOUND');

  // 4) スキーマ揺れに強いパース
  const commentsConn = video.comments ?? null;
  const edges = Array.isArray(commentsConn?.edges) ? commentsConn.edges : [];
  const comments = edges
    .map((e) => {
      const n = e?.node;
      if (!n?.id) return null;
      return {
        id: n.id,
        offsetSec: Number(n.contentOffsetSeconds ?? 0),
        commenter: {
          id: n.commenter?.id ?? null,
          displayName: n.commenter?.displayName ?? n.commenter?.login ?? '???',
          login: n.commenter?.login ?? null,
        },
        message: {
          fragments: Array.isArray(n.message?.fragments) ? n.message.fragments : [],
          userBadges: Array.isArray(n.message?.userBadges) ? n.message.userBadges : [],
          userColor: n.message?.userColor ?? null,
        },
      };
    })
    .filter(Boolean);

  const hasNextPage = !!commentsConn?.pageInfo?.hasNextPage;
  const lastCursor = edges.length ? edges[edges.length - 1]?.cursor ?? null : null;
  const channelId = video?.creator?.channel?.id ?? null;

  return {
    comments,
    hasNextPage,
    nextCursor: hasNextPage ? lastCursor : null,
    channelId,
  };
}

/** Twitch 公式エモート URL ビルダ */
export function buildTwitchEmoteUrl(emoteId, size = '1.0') {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/${size}`;
}