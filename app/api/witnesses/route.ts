import { NextResponse } from "next/server";
import { factToWords, STAGE_LABEL, type WitnessSpot } from "../../../lib/witnesses";
import { askGeminiJson } from "../../../lib/gemini";

export const runtime = "nodejs";

type Body = {
  city?: string;
  site?: { era?: string; summary?: string };
  spots?: WitnessSpot[];
};

/**
 * Roles that make sense almost anywhere, used when there is no model available.
 * Deliberately unnamed — inventing culturally specific names for a real city we
 * know nothing about is worse than an honest "the tea-seller".
 */
const FALLBACK_ROLES = [
  { name: "The tea-seller", role: "runs a stall on this corner", look: "an apron, a kettle always on", opener: "Sit, sit. You look lost." },
  { name: "The caretaker", role: "sweeps these steps every morning", look: "a broom, and no hurry at all", opener: "You're not from this street." },
  { name: "The shopkeeper", role: "has traded here for thirty years", look: "leaning in the doorway, watching", opener: "Buying, or asking?" },
  { name: "The old resident", role: "has lived on this street since childhood", look: "a folding chair set out on the pavement", opener: "Whatever it is, it happened before your time." },
  { name: "The delivery rider", role: "knows every shortcut in the district", look: "engine still running", opener: "Make it quick, I'm on a drop." },
];

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const spots = Array.isArray(body.spots) ? body.spots : [];
  if (spots.length === 0) {
    return NextResponse.json({ error: "No witnesses could be placed." }, { status: 422 });
  }

  /** "Go and find X, they're on Y" — written by us, so it is never wrong. */
  const pointerTo = (next: { name: string; street: string | null; setting: string } | undefined) => {
    if (!next) return null;
    const where = next.street ? `on ${next.street}` : next.setting;
    return `If you want more than that, find ${next.name} — ${where}. Tell them I sent you.`;
  };

  const fallback = () => {
    const named = spots.map((spot, index) => ({
      ...spot,
      ...FALLBACK_ROLES[index % FALLBACK_ROLES.length],
      testimony: factToWords(spot.fact),
    }));
    return named.map((w, index) => ({ ...w, pointer: pointerTo(named[index + 1]) }));
  };

  const manifest = spots.map((spot) => ({
    id: spot.id,
    stage: `${spot.stage}. ${STAGE_LABEL[spot.fact.kind]}`,
    standing: spot.street ? `on ${spot.street}, ${spot.setting}` : spot.setting,
    knows: factToWords(spot.fact),
  }));

  const parsed = await askGeminiJson<{ witnesses?: Array<Record<string, string>> }>({
    // The round clock is held while this runs, but the player is still staring
    // at an empty street. Past twenty seconds the unnamed locals will do.
    timeoutMs: 12_000,
    budgetMs: 20_000,
    prompt:
`You are casting minor characters for a game set in the real streets of ${body.city ?? "this city"}.

For each person below, invent someone who plausibly stands exactly where they stand. Use the location to decide who they are — someone outside a temple is not the same person as someone outside a metro station.

These four are a chain. The player meets them in order, and each one narrows the search a little further: first what happened, then which part of the city, then what stands around the place, and finally which landmark it sits beside. Nobody knows the whole answer.

For each, return:
- "name": how the player sees them. A short, ordinary name or an epithet ("Old Farid", "The tea-seller"). Do not use famous people.
- "role": five to eight words on what they do here.
- "look": a short physical detail, for the label above their head.
- "opener": the first thing they say when approached, under 15 words, in their own voice. Wary or busy, not eager.
- "testimony": rewrite the "knows" line in their voice, 1-2 sentences. You MUST preserve every direction, distance, street name and date exactly as given. Do not add facts. Do not name the place being searched for.

Respect the real city: do not caricature, do not write accents phonetically, and keep everyone ordinary.

Return JSON: {"witnesses":[{"id":"...","name":"...","role":"...","look":"...","opener":"...","testimony":"..."}]}

People: ${JSON.stringify(manifest)}`,
  });

  const written = new Map<string, Record<string, string>>();
  if (Array.isArray(parsed?.witnesses)) {
    for (const w of parsed.witnesses) {
      if (w?.id && typeof w.testimony === "string") written.set(w.id, w);
    }
  }

  if (written.size === 0) {
    return NextResponse.json({ witnesses: fallback(), source: "local" });
  }

  const merged = spots.map((spot, index) => {
    const w = written.get(spot.id);
    const role = FALLBACK_ROLES[index % FALLBACK_ROLES.length];
    return {
      ...spot,
      name: w?.name ?? role.name,
      role: w?.role ?? role.role,
      look: w?.look ?? role.look,
      opener: w?.opener ?? role.opener,
      // if the model dropped the detail, fall back to the plain true sentence;
      // and never let a redaction mark reach a speech bubble
      testimony: (w?.testimony ?? factToWords(spot.fact)).replace(/▁+/g, "the place"),
    };
  });

  // The hand-off is written here, not by the model, so the name and street it
  // gives you are always the ones actually standing there.
  const chained = merged.map((w, index) => ({ ...w, pointer: pointerTo(merged[index + 1]) }));

  return NextResponse.json({ witnesses: chained, source: "gemini" });
}
