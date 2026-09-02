// Generated content is expensive and identical for everyone.
//
// The five cases for a city, and the four witnesses for a case, are worked out
// from fixed data — the same geosearch, the same ranking, the same geometry —
// so the only thing that varies is the writing. Cache that once and every
// player after the first costs nothing.

import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { db, firebaseReady } from "./firebase";
import type { Site } from "./geo";
import type { Witness } from "./witnesses";

/** Bump when the shape or the prompts change, so stale writing is not served. */
const VERSION = "v2";

/** How many cases to write for a city, so each session can deal a fresh hand. */
export const POOL_SIZE = 14;

const FRESH_FOR = 30 * 24 * 60 * 60 * 1000; // a month

type CasesDoc = { version: string; at: number; sites: Site[] };
type CastDoc = { version: string; at: number; witnesses: Witness[] };

const usable = (at: number | undefined, version: string | undefined) =>
  version === VERSION && typeof at === "number" && Date.now() - at < FRESH_FOR;

/** The cases for a city, if somebody has already paid for them. */
export const cachedCases = async (citySlug: string): Promise<Site[] | null> => {
  const store = firebaseReady ? db() : null;
  if (!store) return null;
  try {
    const snap = await getDoc(doc(store, "cases", citySlug));
    if (!snap.exists()) return null;
    const data = snap.data() as CasesDoc;
    return usable(data.at, data.version) && Array.isArray(data.sites) ? data.sites : null;
  } catch {
    return null;
  }
};

export const storeCases = async (citySlug: string, sites: Site[]) => {
  const store = firebaseReady ? db() : null;
  if (!store || sites.length === 0) return;
  try {
    await setDoc(doc(store, "cases", citySlug), {
      version: VERSION,
      at: Date.now(),
      // only historical cases are shared; memory cases belong to their city feed
      sites: sites.filter((s) => s.kind !== "memory"),
      written: serverTimestamp(),
    });
  } catch { /* cache miss for the next player is not worth failing a round over */ }
};

/** The cast for one case. Witness spots are deterministic, so this is reusable. */
export const cachedCast = async (siteId: string): Promise<Witness[] | null> => {
  const store = firebaseReady ? db() : null;
  if (!store) return null;
  try {
    const snap = await getDoc(doc(store, "casts", siteId.replace(/\//g, "_")));
    if (!snap.exists()) return null;
    const data = snap.data() as CastDoc;
    return usable(data.at, data.version) && Array.isArray(data.witnesses) ? data.witnesses : null;
  } catch {
    return null;
  }
};

export const storeCast = async (siteId: string, witnesses: Witness[]) => {
  const store = firebaseReady ? db() : null;
  if (!store || witnesses.length === 0) return;
  try {
    await setDoc(doc(store, "casts", siteId.replace(/\//g, "_")), {
      version: VERSION,
      at: Date.now(),
      witnesses,
      written: serverTimestamp(),
    });
  } catch { /* as above */ }
};
