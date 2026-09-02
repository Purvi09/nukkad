#!/usr/bin/env node
//
// Turn baked places into playable cases and put them where the game looks.
//
//   node scripts/bake-city.mjs "Lisbon" | node scripts/write-cases.mjs
//
// Reads the JSON from bake-city, has Gemini write each clue, then writes the
// pool to Firestore at cases/{slug} — the exact document the app already checks
// before it spends any quota of its own.

import { readFileSync } from "node:fs";
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { doc, getFirestore, serverTimestamp, setDoc } from "firebase/firestore";

const VERSION = "v2";               // must match lib/caseCache.ts
const M_PER_DEG_LAT = 110574;

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const at = l.indexOf("=");
      return [l.slice(0, at).trim(), l.slice(at + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

// ---- Gemini, rotating models the same way the app does --------------------

const MODELS = [
  "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash",
  "gemini-3-flash-preview", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite",
];

const askGemini = async (prompt) => {
  for (const model of MODELS) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      const d = await r.json();
      if (d.error) { console.log(`   (${model}: ${d.error.code})`); continue; }
      const text = d?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return { text, model };
    } catch { /* next model */ }
  }
  return null;
};

// ---- read the baked places ------------------------------------------------

const input = JSON.parse(readFileSync(0, "utf8"));
const { city, centre, cases } = input;
if (!cases?.length) { console.error("nothing to write"); process.exit(1); }

const slug = city.split(",")[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
console.log(`\nWriting ${cases.length} cases for ${slug}\n`);

// ---- clue writing ---------------------------------------------------------

const manifest = cases.map((c, i) => ({ id: String(i), title: c.title, summary: c.summary }));

const written = await askGemini(
`You write clues for a game where a player must walk to a real location in a city from memory.

For each entry below, write a 2-3 sentence clue describing what happened there.

Hard rules:
- Use ONLY facts present in that entry's summary. Invent nothing.
- NEVER write the place's name, or any distinctive word from it. That is the answer.
- Describe what a person standing there would see, and what happened there.
- Write as though the player stands at one specific spot, never a whole district.
- Also return "era": the single year or century the summary gives, or "undated".

Return JSON: {"clues":[{"id":"<id>","clue":"<text>","era":"<year or century>"}]}

Entries: ${JSON.stringify(manifest)}`);

if (!written) {
  console.error("Gemini unavailable — every model refused. Try again later.");
  process.exit(1);
}
console.log(`   clues written by ${written.model}`);

const clues = new Map();
for (const c of (JSON.parse(written.text).clues ?? [])) {
  if (c?.id != null && typeof c.clue === "string") clues.set(String(c.id), c);
}

// ---- shape them the way the game expects ----------------------------------

const mPerDegLon = 111320 * Math.cos((centre.lat * Math.PI) / 180);

const sites = cases
  .map((c, i) => {
    const written = clues.get(String(i));
    if (!written) return null;
    // a clue that names its own answer is useless
    if (written.clue.toLowerCase().includes(c.title.toLowerCase())) return null;
    return {
      id: `osm-${c.osm_id}`,
      kind: "history",
      title: c.title,
      x: Math.round((Number(c.lon) - centre.lon) * mPerDegLon),
      y: Math.round((centre.lat - Number(c.lat)) * M_PER_DEG_LAT),
      summary: c.summary,
      clue: written.clue,
      era: String(written.era ?? "undated"),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(c.title.replace(/ /g, "_"))}`,
    };
  })
  .filter(Boolean);

console.log(`   ${sites.length} playable cases`);
sites.forEach((s) => console.log(`   · ${s.title} [${s.era}]`));

// ---- write where the game already looks -----------------------------------

const app = initializeApp({
  apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.NEXT_PUBLIC_FIREBASE_APP_ID,
});

await signInAnonymously(getAuth(app));
await setDoc(doc(getFirestore(app), "cases", slug), {
  version: VERSION,
  at: Date.now(),
  sites: sites.slice(0, 30),
  source: "bigquery-osm",
  written: serverTimestamp(),
});

console.log(`\n✔ cases/${slug} written. The game will pick these up with no Gemini call.\n`);
process.exit(0);
