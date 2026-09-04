// Dealing a session's cases out of a city's pool.
//
// The pool is generated once and cached; what varies between sessions is which
// of them you get, and which you have already been given.

import type { Site } from "./geo";

const PLAYED_KEY = "patchamomma.played";

const played = (): Record<string, number> => {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(PLAYED_KEY) ?? "{}");
  } catch {
    return {};
  }
};

export const markPlayed = (sites: Site[]) => {
  if (typeof window === "undefined") return;
  const seen = played();
  const now = Date.now();
  sites.forEach((s) => { seen[s.id] = now; });
  try {
    // keep the most recent 200, so old cities come round again eventually
    const trimmed = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 200);
    window.localStorage.setItem(PLAYED_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch { /* not worth failing over */ }
};

/**
 * Deal `count` cases, preferring ones this player has not had before, and
 * shuffling within each group so repeat visits are not in the same order.
 */
export const dealCases = (pool: Site[], count: number): Site[] => {
  const seen = played();
  const shuffle = (list: Site[]) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  const fresh = shuffle(pool.filter((s) => !seen[s.id]));
  // fall back to the oldest-played once the pool is exhausted
  const stale = pool
    .filter((s) => seen[s.id])
    .sort((a, b) => (seen[a.id] ?? 0) - (seen[b.id] ?? 0));

  return spread([...fresh, ...stale], count);
};

/** Cases dealt together should not share a square: solving one must not solve the next. */
const MIN_APART_M = 260;

const spread = (ordered: Site[], count: number): Site[] => {
  for (const apart of [MIN_APART_M, 160, 80, 0]) {
    const chosen: Site[] = [];
    for (const site of ordered) {
      if (chosen.length >= count) break;
      if (!chosen.some((c) => Math.hypot(c.x - site.x, c.y - site.y) < apart)) chosen.push(site);
    }
    if (chosen.length >= count) return chosen;
  }
  return ordered.slice(0, count);
};
