// Placing witnesses and deciding what each of them truthfully knows.
//
// The geometry is computed here, from data the browser already holds, and only
// the *phrasing* is handed to a model. A witness can therefore be wrong on
// purpose, but never accidentally.

import { distance, type CityData, type Site, type Way } from "./geo";

/**
 * The four stages of an investigation. Each one narrows the search: what
 * happened, which part of the city, what stands around it, and finally which
 * landmark it sits beside. Alone none of them find the spot; together they do.
 */
export type WitnessFact =
  | { kind: "context"; era: string; detail: string }
  | { kind: "quadrant"; bearing: string; band: string }
  | { kind: "surroundings"; street: string | null; terrain: string }
  | { kind: "landmark"; landmark: string; bearing: string; band: string };

export const STAGE_LABEL: Record<WitnessFact["kind"], string> = {
  context: "What happened",
  quadrant: "Which part of the city",
  surroundings: "What stands around it",
  landmark: "Which landmark it sits by",
};

export type WitnessSpot = {
  id: string;
  x: number;
  y: number;
  /** Where they are standing, for grounding the persona. */
  street: string | null;
  setting: string;
  fact: WitnessFact;
  /** One witness per case is honestly mistaken. */
  reliable: boolean;
  /** Position in the chain. Witness n only talks once n-1 has. */
  stage: number;
  /** The id of the witness who will send the player here. */
  unlockedBy: string | null;
};

export type Witness = WitnessSpot & {
  name: string;
  role: string;
  look: string;
  opener: string;
  /** What they say when they finally give up what they know. */
  testimony: string;
  /** Where they send you next, appended verbatim so it is always true. */
  pointer: string | null;
};

const COMPASS = [
  "north", "north-east", "east", "south-east",
  "south", "south-west", "west", "north-west",
];

/** Words for the direction of (dx, dy), where x is east and y is south. */
export const bearingOf = (dx: number, dy: number) => {
  const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return COMPASS[Math.round(((angle + 360) % 360) / 45) % 8];
};

export const rotateBearing = (bearing: string, steps: number) => {
  const at = COMPASS.indexOf(bearing);
  if (at < 0) return bearing;
  return COMPASS[(at + steps + COMPASS.length) % COMPASS.length];
};

const bandOf = (metres: number) => {
  if (metres < 150) return "a couple of minutes' walk";
  if (metres < 350) return "a few streets away";
  if (metres < 700) return "the better part of a kilometre";
  return "right across the other side";
};

const centroid = (pts: number[]) => {
  let sx = 0;
  let sy = 0;
  const n = pts.length / 2;
  for (let i = 0; i < pts.length; i += 2) { sx += pts[i]; sy += pts[i + 1]; }
  return { x: sx / n, y: sy / n };
};

/** Significant words of a title, for spotting when a "clue" is the answer. */
const keyWords = (title: string) =>
  title
    .split(/[\s,'’\-—()]+/)
    .filter((w) => w.length >= 4)
    .map((w) => w.toLowerCase());

/** Would naming this give the game away? */
const givesItAway = (name: string, site: Site) => {
  const lower = name.toLowerCase();
  const title = site.title.toLowerCase();
  if (lower.includes(title) || title.includes(lower)) return true;
  return keyWords(site.title).some((w) => lower.includes(w));
};

/** Strip the answer, and any bracketed pronunciation noise, out of a sentence. */
const redactTitle = (text: string, site: Site) => {
  let out = text.replace(/\([^)]*\)/g, " ");
  for (const term of [site.title, ...keyWords(site.title)].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "▁▁▁▁");
  }
  return out.replace(/(▁▁▁▁[\s,]*){2,}/g, "▁▁▁▁ ").replace(/\s+/g, " ").trim();
};

/** The nearest named thing to a point, for describing where something is. */
const nearestNamed = (
  ways: Way[],
  x: number,
  y: number,
  within: number,
  reject?: (name: string, d: number) => boolean,
) => {
  let best: { name: string; d: number } | null = null;
  for (const way of ways) {
    if (!way.name) continue;
    const c = centroid(way.pts);
    const d = distance(c.x, c.y, x, y);
    if (d >= within) continue;
    if (reject?.(way.name, d)) continue;
    if (!best || d < best.d) best = { name: way.name, d };
  }
  return best?.name ?? null;
};

/** The name of the street a point sits on, if it has one. */
const streetAt = (roads: Way[], x: number, y: number) => {
  let best: { name: string; d: number } | null = null;
  for (const road of roads) {
    if (!road.name) continue;
    for (let i = 0; i < road.pts.length - 2; i += 2) {
      const ax = road.pts[i];
      const ay = road.pts[i + 1];
      const bx = road.pts[i + 2];
      const by = road.pts[i + 3];
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq));
      const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
      if (d < 30 && (!best || d < best.d)) best = { name: road.name, d };
    }
  }
  return best?.name ?? null;
};

const describeSetting = (city: CityData, x: number, y: number) => {
  const park = nearestNamed(city.parks, x, y, 90);
  if (park) return `beside ${park}`;
  const water = nearestNamed(city.water, x, y, 120);
  if (water) return `near the water at ${water}`;
  const building = nearestNamed(city.buildings, x, y, 70);
  if (building) return `outside ${building}`;
  const shop = city.buildings.find((b) => {
    const c = centroid(b.pts);
    return distance(c.x, c.y, x, y) < 60 && ["retail", "shop", "cafe", "restaurant"].includes(b.kind);
  });
  if (shop) return "outside a row of shops";
  return "on a quiet stretch of street";
};

/**
 * Pick spots that are on real streets, spread around the target, and not all
 * clustered on the same side of it.
 */
export const placeWitnesses = (city: CityData, site: Site, count = 4): WitnessSpot[] => {
  type Candidate = { x: number; y: number; street: string | null; d: number; bearing: string };
  const candidates: Candidate[] = [];

  for (const road of city.roads) {
    if (road.pts.length < 4) continue;
    // one candidate per road, at its midpoint
    const i = Math.floor(road.pts.length / 4) * 2;
    const x = road.pts[i];
    const y = road.pts[i + 1];
    const d = distance(x, y, site.x, site.y);
    if (d < 120 || d > 850) continue;
    if (Math.hypot(x, y) > city.radius * 0.9) continue;
    candidates.push({ x, y, street: road.name ?? null, d, bearing: bearingOf(x - site.x, y - site.y) });
  }

  if (candidates.length === 0) return [];

  // One witness near, one far, and the rest between — so the case sends you
  // across the city rather than round one block. Different compass points too.
  const BANDS = [180, 340, 520, 720];
  const chosen: Candidate[] = [];
  const usedBearings = new Set<string>();

  const take = (pool: Candidate[], wantBearingSpread: boolean) => {
    for (let b = 0; b < count && chosen.length < count; b++) {
      const want = BANDS[b % BANDS.length];
      let best: Candidate | null = null;
      let bestScore = Infinity;
      for (const candidate of pool) {
        if (chosen.includes(candidate)) continue;
        if (wantBearingSpread && usedBearings.has(candidate.bearing)) continue;
        if (chosen.some((c) => distance(c.x, c.y, candidate.x, candidate.y) < 170)) continue;
        const score = Math.abs(candidate.d - want) + (candidate.street ? 0 : 120);
        if (score < bestScore) { bestScore = score; best = candidate; }
      }
      if (best) {
        usedBearings.add(best.bearing);
        chosen.push(best);
      }
    }
  };

  take(candidates, true);
  if (chosen.length < count) take(candidates, false);

  // The chain should walk you outward, so start with whoever is easiest to
  // stumble across and let each one send you further out.
  chosen.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));

  // Facts that only make sense together.
  const notTheAnswer = (name: string, d: number) => givesItAway(name, site) || d < 45;
  const forgettable = new Set(["retail", "shop", "supermarket", "cafe", "restaurant", "fast_food", "convenience", "garage", "garages", "kiosk"]);
  const substantial = city.buildings.filter((b) => !forgettable.has(b.kind));

  const streetName = streetAt(city.roads, site.x, site.y);
  const nearStreet = streetName && !givesItAway(streetName, site) ? streetName : null;

  const nearWater = nearestNamed(city.water, site.x, site.y, 320, notTheAnswer);
  const nearPark = nearestNamed(city.parks, site.x, site.y, 220, notTheAnswer);
  const nearLandmark = nearestNamed(substantial, site.x, site.y, 260, notTheAnswer)
    ?? nearestNamed(city.parks, site.x, site.y, 300, notTheAnswer)
    ?? nearestNamed(city.water, site.x, site.y, 380, notTheAnswer);

  const terrain = nearWater ? `close enough to the water at ${nearWater} to smell it`
    : nearPark ? `where the ground opens out at ${nearPark}`
    : "in among the built-up streets, hemmed in on every side";

  // Where it sits relative to the whole city, which is what "north of the old
  // town" actually means to someone giving directions.
  const fromCentre = bearingOf(site.x, site.y);
  const outFromCentre = Math.hypot(site.x, site.y);
  const centreBand = outFromCentre < 250 ? "right in the middle of everything"
    : outFromCentre < 600 ? "a short way out from the centre"
    : "well out from the centre";

  // Build the strongest chain this city's data can support.
  // The opening fact must say what happened without ever naming it.
  const opening = site.summary.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  const facts: WitnessFact[] = [
    { kind: "context", era: site.era, detail: redactTitle(opening, site).slice(0, 200) },
    { kind: "quadrant", bearing: fromCentre, band: centreBand },
  ];
  if (nearStreet || nearPark || nearWater) {
    facts.push({ kind: "surroundings", street: nearStreet, terrain });
  }
  if (nearLandmark) {
    facts.push({
      kind: "landmark",
      landmark: nearLandmark,
      bearing: bearingOf(site.x - 0, site.y - 0),
      band: "a minute's walk at most",
    });
  }

  const chain = chosen.slice(0, Math.min(chosen.length, facts.length));

  // Exactly one link is honestly mistaken, and never the first — a chain that
  // lies at the very first step is just unfair.
  const seed = site.id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const liar = chain.length > 2 ? 1 + (seed % (chain.length - 1)) : -1;

  return chain.map((c, index) => {
    const reliable = index !== liar;
    let fact = facts[index];

    if (!reliable) {
      // bend the geography, never the history — a wrong date is not a red herring
      if (fact.kind === "quadrant") {
        fact = { ...fact, bearing: rotateBearing(fact.bearing, index % 2 === 0 ? 2 : -2) };
      } else if (fact.kind === "landmark") {
        fact = { ...fact, bearing: rotateBearing(fact.bearing, 3) };
      } else if (fact.kind === "surroundings") {
        fact = { ...fact, terrain: "in among the built-up streets, hemmed in on every side" };
      }
    }

    return {
      id: `w${index}`,
      x: c.x,
      y: c.y,
      street: c.street,
      setting: describeSetting(city, c.x, c.y),
      fact,
      reliable,
      stage: index + 1,
      unlockedBy: index === 0 ? null : `w${index - 1}`,
    } satisfies WitnessSpot;
  });
};

/** Plain-language version of a fact, used as the fallback testimony. */
export const factToWords = (fact: WitnessFact) => {
  switch (fact.kind) {
    case "context":
      return fact.era === "undated"
        ? `${fact.detail}`
        : `That was ${fact.era}. ${fact.detail}`;
    case "quadrant":
      return `It happened in the ${fact.bearing} of the city — ${fact.band}.`;
    case "surroundings":
      return fact.street
        ? `The place sits just off ${fact.street}, ${fact.terrain}.`
        : `The place sits ${fact.terrain}.`;
    case "landmark":
      return `You'll find it beside ${fact.landmark} — ${fact.band}.`;
  }
};
