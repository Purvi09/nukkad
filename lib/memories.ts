// Memories: what a person remembers about a place, stored against the place.
//
// Falls back to the browser's own storage when Firestore is not configured, so
// the feature works before anyone has touched a console.

import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query, serverTimestamp, where,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadString } from "firebase/storage";
import { currentUid, db, firebaseReady, storage } from "./firebase";
import { toLatLon, toMetres, type LatLon } from "./geo";

export type Memory = {
  id: string;
  /** Slug of the city, so a place can be looked up without a geo query. */
  city: string;
  /** Metres from the city centre, matching everything else in the game. */
  x: number;
  y: number;
  lat: number;
  lon: number;
  /** The public place it was pinned to, never a raw address. */
  place: string;
  text: string;
  /**
   * Kept because the deployed Firestore rules validate it. Every memory is now
   * simply a memory; nothing reads this.
   */
  shareAsMystery: boolean;
  /** Anonymous uid of whoever left it, so only they can remove it. */
  author: string;
  /** The first name they gave, shown to whoever finds it. */
  by: string;
  /** A photograph, once it has passed moderation and been uploaded. */
  photo?: string;
  /** Seeded samples are labelled as such rather than passed off as real. */
  sample?: boolean;
  at: number;
};

export const citySlug = (label: string) =>
  label.split(",")[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");

const LOCAL_KEY = "patchamomma.memories";

const readLocal = (): Memory[] => {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(LOCAL_KEY) ?? "[]") as Memory[];
  } catch {
    return [];
  }
};

const writeLocal = (all: Memory[]) => {
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(all.slice(-300)));
  } catch { /* storage full or blocked: the memory is simply not kept */ }
};

export type NewMemory = {
  city: string;
  centre: LatLon;
  x: number;
  y: number;
  place: string;
  text: string;
  by: string;
  /** data: URL, already checked by the moderation route. */
  photo?: string;
};

/** Store a memory. Returns it as saved, wherever it ended up. */
export const saveMemory = async (input: NewMemory): Promise<Memory> => {
  const at = toLatLon(input.centre, input.x, input.y);
  const uid = (await currentUid()) ?? "local";

  // Upload the photo first: a memory with a broken image is worse than one
  // without a picture, so a failed upload simply drops the photo.
  let photo: string | undefined;
  if (input.photo && uid !== "local") {
    const bucket = firebaseReady ? storage() : null;
    if (bucket) {
      try {
        const name = `memories/${uid}/${Date.now()}`;
        const handle = ref(bucket, name);
        await uploadString(handle, input.photo, "data_url");
        photo = await getDownloadURL(handle);
      } catch { /* keep the words even if the picture will not go */ }
    }
  }

  const record: Omit<Memory, "id"> = {
    city: citySlug(input.city),
    x: Math.round(input.x),
    y: Math.round(input.y),
    lat: at.lat,
    lon: at.lon,
    place: input.place,
    text: input.text,
    by: input.by,
    shareAsMystery: false,
    ...(photo ? { photo } : {}),
    author: uid,
    at: Date.now(),
  };

  const store = firebaseReady ? db() : null;
  if (store) {
    try {
      const ref = await addDoc(collection(store, "memories"), { ...record, created: serverTimestamp() });
      return { ...record, id: ref.id };
    } catch {
      // Firestore not enabled or rules refused: keep it locally rather than lose it
    }
  }

  const local: Memory = { ...record, id: `local-${record.at}` };
  writeLocal([...readLocal(), local]);
  return local;
};

/** Every memory left in a city, newest first. */
export const listMemories = async (city: string): Promise<Memory[]> => {
  const slug = citySlug(city);
  const local = readLocal().filter((m) => m.city === slug);

  const store = firebaseReady ? db() : null;
  if (!store) return local.sort((a, b) => b.at - a.at);

  try {
    const snapshot = await getDocs(query(
      collection(store, "memories"),
      where("city", "==", slug),
      orderBy("at", "desc"),
      limit(200),
    ));
    const remote = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Memory, "id">) }));
    // local ones may not have synced; show both without duplicating
    const seen = new Set(remote.map((m) => `${m.at}-${m.author}`));
    return [...remote, ...local.filter((m) => !seen.has(`${m.at}-${m.author}`))]
      .sort((a, b) => b.at - a.at);
  } catch {
    return local.sort((a, b) => b.at - a.at);
  }
};

/** One memory by id, for a link someone was sent. */
export const getMemory = async (id: string): Promise<Memory | null> => {
  if (id.startsWith("local-")) return readLocal().find((m) => m.id === id) ?? null;
  const store = firebaseReady ? db() : null;
  if (!store) return null;
  try {
    const snap = await getDoc(doc(store, "memories", id));
    if (!snap.exists()) return null;
    return { id: snap.id, ...(snap.data() as Omit<Memory, "id">) };
  } catch {
    return null;
  }
};

/** Memories are stored in metres from the centre they were built against. A
 *  city built later, or geocoded a little differently, needs them re-projected
 *  from the latitude and longitude that never change. */
export const rehome = (list: Memory[], centre: LatLon): Memory[] =>
  list.map((m) => {
    if (typeof m.lat !== "number" || typeof m.lon !== "number") return m;
    const at = toMetres(centre, m.lat, m.lon);
    return { ...m, x: Math.round(at.x), y: Math.round(at.y) };
  });

/** Only the person who left it may take it down. */
export const removeMemory = async (memory: Memory): Promise<boolean> => {
  if (memory.id.startsWith("local-")) {
    writeLocal(readLocal().filter((m) => m.id !== memory.id));
    return true;
  }
  const store = firebaseReady ? db() : null;
  if (!store) return false;
  try {
    await deleteDoc(doc(store, "memories", memory.id));
    return true;
  } catch {
    return false;
  }
};
