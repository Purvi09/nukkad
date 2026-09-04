// A built city, kept so nobody waits on Overpass twice.
//
// Two layers. The browser's own Cache API holds every city this device has
// walked, so coming back is instant and costs no network at all. Firestore
// holds a gzipped copy shared by everyone, so the second person to ask for a
// city gets it in a second rather than thirty. The server's in-memory cache
// still sits behind both, but it forgets on every restart.

import { Bytes, doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { currentUid, db, firebaseReady } from "./firebase";
import { tileKey, type CityData, type TileData } from "./geo";

/** Bump when the city route changes what it returns, so stale maps are not served. */
const VERSION = "v2";
const FRESH_FOR = 30 * 24 * 60 * 60 * 1000; // a month: streets do not move much
const LOCAL_STORE = "nukkad-cities";
/** Firestore documents cap at 1 MiB; a dense city gzips to well under this. */
const MAX_SHARED_BYTES = 900_000;

/** "Old Delhi" and "old delhi" are the same request. */
export const cityKey = (query: string) =>
  query.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);

type SharedDoc = { version: string; at: number; label: string; bytes: Bytes };

// ---- this device -----------------------------------------------------------

const localUrl = (key: string) => `/__city-cache/${VERSION}/${key}`;

const readLocal = async <T,>(key: string): Promise<T | null> => {
  if (typeof caches === "undefined") return null;
  try {
    const store = await caches.open(LOCAL_STORE);
    const hit = await store.match(localUrl(key));
    if (!hit) return null;
    const at = Number(hit.headers.get("x-built-at"));
    if (!at || Date.now() - at > FRESH_FOR) return null;
    return (await hit.json()) as T;
  } catch {
    return null;
  }
};

const writeLocal = async (key: string, value: unknown) => {
  if (typeof caches === "undefined") return;
  try {
    const store = await caches.open(LOCAL_STORE);
    await store.put(
      localUrl(key),
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json", "x-built-at": String(Date.now()) },
      }),
    );
  } catch { /* private mode or a full disk: the city simply builds again next time */ }
};

// ---- everyone --------------------------------------------------------------

const gzip = async (text: string): Promise<Uint8Array | null> => {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const gunzip = async (bytes: Uint8Array): Promise<string | null> => {
  if (typeof DecompressionStream === "undefined") return null;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
};

const readShared = async <T,>(key: string): Promise<T | null> => {
  const store = firebaseReady ? db() : null;
  if (!store) return null;
  try {
    const snap = await getDoc(doc(store, "cities", key));
    if (!snap.exists()) return null;
    const data = snap.data() as SharedDoc;
    if (data.version !== VERSION || typeof data.at !== "number" || Date.now() - data.at > FRESH_FOR) return null;
    const text = await gunzip(data.bytes.toUint8Array());
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
};

const writeShared = async (key: string, value: unknown, label: string) => {
  const store = firebaseReady ? db() : null;
  if (!store) return;
  try {
    const packed = await gzip(JSON.stringify(value));
    if (!packed || packed.byteLength > MAX_SHARED_BYTES) return;
    // the rules want a signed-in author, and nobody has signed in this early
    if (!(await currentUid())) return;
    await setDoc(doc(store, "cities", key), {
      version: VERSION,
      at: Date.now(),
      label,
      bytes: Bytes.fromUint8Array(packed),
      written: serverTimestamp(),
    });
  } catch { /* rules not deployed yet, or offline: the next player builds it themselves */ }
};

// ---- the two together ------------------------------------------------------

/** The city, if this device or anyone else has built it recently. */
export const cachedCity = async (query: string): Promise<CityData | null> => {
  const key = cityKey(query);
  if (!key) return null;
  const mine = await readLocal<CityData>(key);
  if (mine) return mine;
  const shared = await readShared<CityData>(key);
  if (shared) void writeLocal(key, shared);
  return shared;
};

/** Keep a freshly built city, here and for everyone. */
export const storeCity = async (query: string, city: CityData) => {
  const key = cityKey(query);
  if (!key) return;
  await Promise.all([writeLocal(key, city), writeShared(key, city, city.label)]);
};

/** One tile beyond the core, if anyone has walked out there before. */
export const cachedTile = async (query: string, cx: number, cy: number): Promise<TileData | null> => {
  const key = cityKey(query);
  if (!key) return null;
  const id = `${key}~${tileKey(cx, cy)}`;
  const mine = await readLocal<TileData>(id);
  if (mine) return mine;
  const shared = await readShared<TileData>(id);
  if (shared) void writeLocal(id, shared);
  return shared;
};

export const storeTile = async (query: string, cx: number, cy: number, tile: TileData) => {
  const key = cityKey(query);
  if (!key) return;
  const id = `${key}~${tileKey(cx, cy)}`;
  await Promise.all([writeLocal(id, tile), writeShared(id, tile, `${key} tile ${tileKey(cx, cy)}`)]);
};
