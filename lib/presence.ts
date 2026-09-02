// Who else is walking this city, and what they are saying.
//
// Presence is deliberately cheap. A heartbeat every few seconds per player
// would burn the free Firestore quota in an afternoon, so a position is only
// written when it has actually changed, and never while the tab is hidden.

import {
  collection, deleteDoc, doc, limit, onSnapshot, orderBy, query,
  serverTimestamp, setDoc, where, addDoc,
} from "firebase/firestore";
import { currentUid, db, firebaseReady } from "./firebase";

export type Explorer = {
  uid: string;
  city: string;
  /** Their first name, or empty if they are walking unnamed. */
  name: string;
  coat: number;
  x: number;
  y: number;
  at: number;
};

export type ChatLine = {
  id: string;
  city: string;
  uid: string;
  name: string;
  text: string;
  at: number;
};

/** Someone counts as here if they have moved or checked in this recently. */
const STALE_AFTER = 90_000;
/** Do not write more often than this, however much they run about. */
const MIN_GAP = 6_000;
/** Or unless they have gone at least this far since the last write. */
const MIN_MOVE = 40;
/** A keepalive, so standing still does not look like leaving. */
const KEEPALIVE = 45_000;

let lastWrite = 0;
let lastX = Number.NaN;
let lastY = Number.NaN;
let myUid: string | null = null;
let myKey: string | null = null;

const presenceKey = (city: string, uid: string) => `${city}__${uid}`;

/**
 * Announce that you are here, and keep saying so as you move.
 * Returns a function that stops and removes you.
 */
export const joinCity = async (
  city: string,
  who: { name: string; coat: number },
  position: () => { x: number; y: number },
) => {
  const store = firebaseReady ? db() : null;
  const uid = await currentUid();
  if (!store || !uid) return () => {};

  myUid = uid;
  myKey = presenceKey(city, uid);

  const write = async (force = false) => {
    if (document.hidden && !force) return;
    const { x, y } = position();
    const now = Date.now();
    const moved = Math.hypot(x - lastX, y - lastY);

    if (!force && now - lastWrite < MIN_GAP) return;
    if (!force && moved < MIN_MOVE && now - lastWrite < KEEPALIVE) return;

    lastWrite = now;
    lastX = x;
    lastY = y;
    try {
      await setDoc(doc(store, "presence", myKey as string), {
        uid, city, name: who.name, coat: who.coat,
        x: Math.round(x), y: Math.round(y),
        at: now, touched: serverTimestamp(),
      });
    } catch { /* presence is a nicety; never break the game over it */ }
  };

  await write(true);
  const timer = window.setInterval(() => void write(), 3_000);

  const leave = () => {
    window.clearInterval(timer);
    if (myKey) void deleteDoc(doc(store, "presence", myKey)).catch(() => {});
    myKey = null;
  };

  window.addEventListener("pagehide", leave);
  return () => { window.removeEventListener("pagehide", leave); leave(); };
};

/** Everyone currently in this city, yourself excluded. */
export const watchCity = (city: string, onChange: (people: Explorer[]) => void) => {
  const store = firebaseReady ? db() : null;
  if (!store) return () => {};

  const q = query(collection(store, "presence"), where("city", "==", city), limit(60));
  return onSnapshot(q, (snap) => {
    const cutoff = Date.now() - STALE_AFTER;
    const people = snap.docs
      .map((d) => d.data() as Explorer)
      .filter((p) => p.uid !== myUid && typeof p.at === "number" && p.at > cutoff);
    onChange(people);
  }, () => onChange([]));
};

// ------------------------------------------------------------------- chat

/** Things a message must never carry, checked before it leaves the browser. */
const CONTACT = /(\+?\d[\d\s\-()]{7,}\d)|([\w.+-]+@[\w-]+\.[\w.]{2,})|(https?:\/\/\S+)|(@[A-Za-z0-9_]{4,})/;

export const chatProblem = (text: string): string | null => {
  const t = text.trim();
  if (t.length < 1) return "Say something first.";
  if (t.length > 240) return "Keep it under 240 characters.";
  if (CONTACT.test(t)) return "No phone numbers, emails, links or handles in the city chat.";
  return null;
};

export const sendChat = async (city: string, name: string, text: string) => {
  const store = firebaseReady ? db() : null;
  const uid = await currentUid();
  if (!store || !uid) throw new Error("Chat is not available right now.");

  const problem = chatProblem(text);
  if (problem) throw new Error(problem);

  await addDoc(collection(store, "chat"), {
    city, uid, name: name || "someone",
    text: text.trim().replace(/\s+/g, " ").slice(0, 240),
    at: Date.now(),
    sent: serverTimestamp(),
  });
};

/** The last stretch of conversation in this city. */
export const watchChat = (city: string, onChange: (lines: ChatLine[]) => void) => {
  const store = firebaseReady ? db() : null;
  if (!store) return () => {};

  const q = query(
    collection(store, "chat"),
    where("city", "==", city),
    orderBy("at", "desc"),
    limit(40),
  );
  return onSnapshot(q, (snap) => {
    const lines = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<ChatLine, "id">) }))
      .reverse();
    onChange(lines);
  }, () => onChange([]));
};
