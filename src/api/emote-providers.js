// src/api/emote-providers.js
// BTTV / FFZ / 7TV のグローバル＆チャンネルエモートを取得して
// 統一フォーマットの Map（code → emote）を返す。
// どれか1つが落ちても他のプロバイダ結果は返す（個別 try/catch）。
// 結果は chrome.storage.local に 24時間キャッシュする。

import { fetchWithRetry, FatalFetchError } from './net.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'emoteCache:v1:';

function makeEmote({ provider, id, code, urls, animated = false }) {
  return { provider, id, code, urls, animated };
}

async function getCached(key) {
  try {
    const all = await chrome.storage.local.get(key);
    const entry = all?.[key];
    if (!entry) return null;
    if (Date.now() - entry.ts > TTL_MS) return null;
    return entry.data;
  } catch {
    return null;
  }
}

async function setCached(key, data) {
  try {
    await chrome.storage.local.set({ [key]: { ts: Date.now(), data } });
  } catch {
    /* quota 超過は黙ってスキップ */
  }
}

// ---------- BTTV ----------
async function fetchBttv(channelId) {
  const key = `${CACHE_PREFIX}bttv:${channelId ?? 'global'}`;
  const cached = await getCached(key);
  if (cached) return cached.map(makeEmote);

  try {
    /** @type {any[]} */
    let raw = [];
    if (!channelId) {
      const r = await fetchWithRetry('https://api.betterttv.net/3/cached/emotes/global');
      raw = await r.json();
    } else {
      const r = await fetchWithRetry(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`);
      const j = await r.json();
      raw = [...(j.channelEmotes ?? []), ...(j.sharedEmotes ?? [])];
    }
    const out = raw.map((e) => ({
      provider: 'bttv',
      id: e.id,
      code: e.code,
      urls: {
        '1x': `https://cdn.betterttv.net/emote/${e.id}/1x.webp`,
        '2x': `https://cdn.betterttv.net/emote/${e.id}/2x.webp`,
        '3x': `https://cdn.betterttv.net/emote/${e.id}/3x.webp`,
      },
      animated: e.imageType === 'gif' || e.animated === true,
    }));
    await setCached(key, out);
    return out.map(makeEmote);
  } catch (err) {
    if (err instanceof FatalFetchError && err.status === 404) return [];
    console.warn('[emotes] BTTV fetch failed:', err);
    return [];
  }
}

// ---------- FFZ ----------
async function fetchFfz(channelId) {
  const key = `${CACHE_PREFIX}ffz:${channelId ?? 'global'}`;
  const cached = await getCached(key);
  if (cached) return cached.map(makeEmote);

  try {
    const url = channelId
      ? `https://api.frankerfacez.com/v1/room/id/${channelId}`
      : 'https://api.frankerfacez.com/v1/set/global';
    const res = await fetchWithRetry(url);
    const j = await res.json();
    const sets = j?.sets ?? {};
    const raw = Object.values(sets).flatMap((s) => s?.emoticons ?? []);
    const fix = (s) => (typeof s === 'string' && s.startsWith('//') ? `https:${s}` : s);
    const out = raw.map((e) => {
      const u = e.urls ?? {};
      return {
        provider: 'ffz',
        id: String(e.id),
        code: e.name,
        urls: {
          '1x': fix(u['1']) ?? '',
          '2x': fix(u['2']) ?? fix(u['1']) ?? '',
          '4x': fix(u['4']) ?? fix(u['2']) ?? fix(u['1']) ?? '',
        },
        animated: false,
      };
    });
    await setCached(key, out);
    return out.map(makeEmote);
  } catch (err) {
    if (err instanceof FatalFetchError && err.status === 404) return [];
    console.warn('[emotes] FFZ fetch failed:', err);
    return [];
  }
}

// ---------- 7TV ----------
async function fetchSevenTv(channelId) {
  const key = `${CACHE_PREFIX}7tv:${channelId ?? 'global'}`;
  const cached = await getCached(key);
  if (cached) return cached.map(makeEmote);

  try {
    const url = channelId
      ? `https://7tv.io/v3/users/twitch/${channelId}`
      : 'https://7tv.io/v3/emote-sets/global';
    const res = await fetchWithRetry(url);
    const j = await res.json();
    /** @type {any[]} */
    let emoteSet;
    if (channelId) {
      emoteSet = j?.emote_set?.emotes ?? [];
    } else {
      emoteSet = j?.emotes ?? [];
    }
    const out = emoteSet
      .map((e) => {
        const host = e?.data?.host ?? null;
        if (!host) return null;
        const base = host.url?.startsWith('//') ? `https:${host.url}` : host.url ?? '';
        const files = host.files ?? [];
        const pick = (name) => files.find((f) => f.name === name)?.name;
        return {
          provider: '7tv',
          id: e.id,
          code: e.name,
          urls: {
            '1x': base && pick('1x.webp') ? `${base}/${pick('1x.webp')}` : '',
            '2x': base && pick('2x.webp') ? `${base}/${pick('2x.webp')}` : '',
            '3x': base && pick('3x.webp') ? `${base}/${pick('3x.webp')}` : '',
          },
          animated: !!e?.data?.animated,
        };
      })
      .filter(Boolean);
    await setCached(key, out);
    return out.map(makeEmote);
  } catch (err) {
    if (err instanceof FatalFetchError && err.status === 404) return [];
    console.warn('[emotes] 7TV fetch failed:', err);
    return [];
  }
}

/**
 * 全プロバイダのエモートをロードして code→emote の Map にする。
 * グローバル + チャンネルの両方が含まれる（後勝ち）。
 *
 * @param {string|null} channelId
 * @returns {Promise<Map<string, { provider: string, id: string, code: string, urls: Record<string,string>, animated: boolean }>>}
 */
export async function loadEmoteMap(channelId = null) {
  // グローバルとチャンネルを並列に
  const tasks = [
    fetchBttv(null), fetchFfz(null), fetchSevenTv(null),
  ];
  if (channelId) {
    tasks.push(fetchBttv(channelId), fetchFfz(channelId), fetchSevenTv(channelId));
  }
  const results = await Promise.allSettled(tasks);
  const map = new Map();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const e of r.value) {
      if (e?.code) map.set(e.code, e);
    }
  }
  return map;
}
