import { NextResponse } from "next/server";
import { distance, toMetres, type LatLon, type Site } from "../../../lib/geo";
import { askGeminiJson } from "../../../lib/gemini";

export const runtime = "nodejs";

const UA = "how-well-do-you-know-your-city/0.1 (educational project)";
const MIN_SEPARATION_M = 220; // stops two rounds sharing a street corner

type WikiPage = {
  pageid: number;
  title: string;
  extract?: string;
  coordinates?: Array<{ lat: number; lon: number }>;
};

const cache = new Map<string, { at: number; sites: Site[] }>();
const CACHE_MS = 60 * 60 * 1000;

/** Pull geolocated articles around a point, with their opening paragraphs. */
const fetchNearbyArticles = async (centre: LatLon, radius: number) => {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  const params: Record<string, string> = {
    action: "query",
    format: "json",
    generator: "geosearch",
    ggscoord: `${centre.lat}|${centre.lon}`,
    ggsradius: String(Math.min(10000, Math.round(radius))),
    ggslimit: "50",
    prop: "extracts|coordinates",
    exintro: "1",
    explaintext: "1",
    exsentences: "4",
  };
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const response = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error("Could not reach Wikipedia.");
  const data = await response.json();
  return Object.values((data?.query?.pages ?? {}) as Record<string, WikiPage>);
};

// A bare year, not the "1530" inside "1530.00 km2" or a road number.
// A bare year. Rejects the "1530" in "1530.00 km2" without rejecting a year
// that simply ends a sentence.
const YEAR = /(?<![\d.,])(1[0-9]{3}|20[0-2][0-9])(?!\.\d)(?!\d)/;
// Better still: a year in an actual date-like context.
const DATED = /\b(?:in|since|of|by|from|until|during|built|founded|opened|completed|established|constructed)\s+(1[0-9]{3}|20[0-2][0-9])(?!\.\d)(?!\d)/i;

// Something has to have *happened* for a clue to be worth walking to.
const EVENTFUL = /\b(was built|were built|was founded|was constructed|took place|was fought|battle|siege|massacre|riot|fire|bombing|executed|beheaded|assassinat|was killed|died here|uprising|revolt|treaty|was signed|proclaimed|coronat|was opened|destroyed|demolished|rebuilt|buried|tomb of|birthplace)\b/i;

// Infrastructure and administrative stubs make dull rounds.
const DULL_TITLE = /\b(metro station|railway station|bus (stand|terminal|depot)|assembly constituency|Lok Sabha constituency|list of|flyover|police station|clinic|nursing home|emergency care|multispeciality)\b/i;
const DULL_OPENING = /\bis a (neighbourhood|neighborhood|locality|residential|suburb|census town|ward)\b/i;

/**
 * A region is not a place you can stand on. Its coordinate is the centroid of
 * hundreds of square kilometres, so "walk to it" has no answer.
 */
const IS_REGION = /\b(district|tehsil|taluk|taluka|subdivision|province|prefecture|county|municipality|metropolitan area|state of|union territory|census division|administrative division|administrative headquarters|is one of the \d+)\b/i;
const HAS_AREA = /\b(?:area of|covers|spanning|comprising)\s+[\d,.]+\s*(?:km2|km²|square kilometres|square kilometers|sq mi|hectares)\b/i;
/** A population figure means you are reading about a territory, not a place. */
const HAS_POPULATION = /\b(population of|had a population|census[^.]{0,40}\b[\d,]{5,}|inhabitants)\b/i;

/** Things worth walking to: you can stand in front of them. */
const LANDMARK = /\b(temple|mosque|church|cathedral|gurdwara|synagogue|shrine|fort|palace|castle|tomb|mausoleum|memorial|monument|museum|theatre|theater|opera|library|bridge|gate|tower|square|market|bazaar|garden|park|stadium|cemetery|lighthouse|observatory|university|college|school|hotel|prison|jail)\b/i;

/** How good a round this site would make. Higher is better. */
const interest = (title: string, summary: string) => {
  let score = 0;
  if (DATED.test(summary)) score += 4;
  else if (YEAR.test(summary)) score += 2;
  if (CENTURY.test(summary)) score += 2;
  if (EVENTFUL.test(summary)) score += 5;
  if (LANDMARK.test(title)) score += 6;
  else if (LANDMARK.test(summary.slice(0, 220))) score += 3;
  if (summary.length > 400) score += 1;
  if (DULL_TITLE.test(title)) score -= 8;
  if (DULL_OPENING.test(summary.slice(0, 160))) score -= 3;
  return score;
};

/** Would this make an answerable round at all? */
const isFindable = (title: string, summary: string) => {
  const opening = summary.slice(0, 300);
  if (IS_REGION.test(title) || IS_REGION.test(opening)) return false;
  if (HAS_AREA.test(summary)) return false;
  // a place with a population is a town or a region, not a spot on a street
  if (HAS_POPULATION.test(opening) && !LANDMARK.test(title)) return false;
  return true;
};
const CENTURY = /\b(\d{1,2})(?:st|nd|rd|th)[- ]century\b/i;

const eraOf = (text: string) => {
  const dated = text.match(DATED);
  if (dated) return dated[1];
  const year = text.match(YEAR);
  if (year) return year[1];
  const century = text.match(CENTURY);
  if (century) return `${century[1]}th century`;
  return "undated";
};

const KIND = /\b(battle|siege|massacre|riot|fire|bombing|uprising|revolt|temple|mosque|church|cathedral|gurdwara|shrine|fort|palace|castle|tomb|mausoleum|memorial|monument|museum|theatre|theater|opera house|library|bridge|gate|tower|square|market|bazaar|garden|park|stadium|cemetery|lighthouse|university|college|school|hotel|prison|station|clinic|hospital)\b/i;

/**
 * Fallback clue, used when the model is unavailable. Rather than blanking the
 * name and leaving a row of gaps, it says what *kind* of thing you are looking
 * for and keeps only the sentences that survive the redaction intact.
 */
const redact = (title: string, extract: string) => {
  const clean = extract
    .replace(/\([^)]*\)/g, "") // native-script names, pronunciations, alt spellings
    .replace(/\s+/g, " ")
    .trim();

  // "the fort", "the battle" — a category, not a name
  const kindWord = (title.match(KIND) ?? clean.match(KIND))?.[0]?.toLowerCase();
  const generic = kindWord ? `the ${kindWord}` : "this place";

  // Only redact what actually gives the answer away: the distinctive proper
  // nouns. Blanking ordinary words that happen to sit in the title produces
  // nonsense like "medical the hospital".
  const COMMON = new Set([
    "the", "and", "for", "with", "from", "national", "international", "emergency",
    "care", "centre", "center", "house", "hall", "great", "royal", "grand", "new",
    "old", "north", "south", "east", "west", "upper", "lower", "first", "second",
    "third", "city", "town", "village", "state", "public", "general", "central",
  ]);

  const giveaways = new Set<string>([title]);
  title.split(/[\s,'’\-—]+/).forEach((word) => {
    const lower = word.toLowerCase();
    if (word.length < 4) return;
    if (COMMON.has(lower) || KIND.test(word)) return;
    // a distinctive name is capitalised in the title
    if (word[0] !== word[0].toUpperCase()) return;
    giveaways.add(word);
  });
  const terms = [...giveaways].sort((a, b) => b.length - a.length);

  const hide = (text: string) => {
    let out = text;
    for (const term of terms) {
      out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "◆");
    }
    return out;
  };

  // Keep the sentences that actually say something, and drop any that turn
  // into mostly holes once the name is taken out.
  const scored = clean
    .split(/(?<=[.!?])\s+/)
    .slice(0, 5)
    .map((sentence, index) => {
      const hidden = hide(sentence);
      const holes = (hidden.match(/◆/g) ?? []).length;
      const words = sentence.split(/\s+/).length;
      let score = 0;
      if (YEAR.test(sentence)) score += 3;
      if (EVENTFUL.test(sentence)) score += 3;
      if (words > 8) score += 1;
      score -= holes * 1.5;
      if (holes / Math.max(1, words) > 0.22) score -= 6; // more hole than sentence
      // first mention names the kind of thing, later ones become "it"
      let seen = false;
      const text = hidden.replace(/◆/g, () => {
        if (seen) return "it";
        seen = true;
        return generic;
      });
      return { index, score, text };
    })
    .filter((s) => s.score > -3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);

  const clue = scored.map((s) => s.text).join(" ")
    // "The the battle" — the article survived the swap
    .replace(/\b(the|a|an)\s+the\b/gi, "the")
    .replace(/^the\b/, "The")
    // "the fort ... the fort" reads badly twice in a row
    .replace(new RegExp(`(${generic}) (.{0,40}?) \\1`, "i"), "$1 $2 it")
    .replace(/\s+/g, " ")
    .trim();

  return clue.length > 40 ? clue : hide(clean).replace(/◆/g, generic).slice(0, 320);
};

/** Ask Gemini to phrase each clue. It is given the facts; it may not add any. */
const writeClues = async (sites: Site[]) => {
  const manifest = sites.map((s) => ({ id: s.id, title: s.title, summary: s.summary }));

  const parsed = await askGeminiJson<{ clues?: Array<{ id?: string; clue?: string; era?: string }> }>({
    prompt:
`You write clues for a game where a player must walk to a real location in a city from memory.

For each entry below, write a 2-3 sentence clue describing what happened there.

Hard rules:
- Use ONLY facts present in that entry's summary. Invent nothing — no dates, names, or events that are not in the text.
- NEVER write the place's name, or any distinctive word from it. That is the answer.
- Do not name the square, street, park or district it stands in either. Where it is, is what the player has to work out; say what it is and what happened.
- Do describe what a person standing there would see, and what happened there.
- Write as though the player is standing at one specific spot — a building, a monument, a corner — never a whole district or region.
- Also return "era": the single year or century the summary gives, or "undated".

Return JSON: {"clues":[{"id":"<id>","clue":"<text>","era":"<year or century>"}]}

Entries: ${JSON.stringify(manifest)}`,
  });

  if (!Array.isArray(parsed?.clues)) return null;

  const byId = new Map<string, { clue: string; era: string }>();
  for (const entry of parsed.clues) {
    if (!entry?.id || typeof entry.clue !== "string") continue;
    const site = sites.find((s) => s.id === entry.id);
    // A clue naming its own answer is useless — drop it and let the fallback stand.
    if (!site || entry.clue.toLowerCase().includes(site.title.toLowerCase())) continue;
    byId.set(entry.id, { clue: entry.clue, era: String(entry.era ?? "undated") });
  }
  return byId.size > 0 ? byId : null;
};

export async function POST(request: Request) {
  let centre: LatLon;
  let radius = 1200;
  let rounds = 5;

  try {
    const body = await request.json();
    centre = { lat: Number(body?.centre?.lat), lon: Number(body?.centre?.lon) };
    radius = Number(body?.radius) || 1200;
    rounds = Math.min(24, Math.max(1, Number(body?.rounds) || 5));
    if (!Number.isFinite(centre.lat) || !Number.isFinite(centre.lon)) throw new Error();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const key = `${centre.lat.toFixed(3)},${centre.lon.toFixed(3)},${rounds}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json({ sites: hit.sites, source: "cache" });
  }

  try {
    const pages = await fetchNearbyArticles(centre, radius);

    const candidates = pages
      .filter((page) => page.extract && page.extract.length > 140 && page.coordinates?.[0])
      .map((page) => {
        const coord = page.coordinates![0];
        const metres = toMetres(centre, coord.lat, coord.lon);
        const summary = page.extract!.replace(/\s+/g, " ").trim();
        return {
          id: String(page.pageid),
          title: page.title,
          x: Math.round(metres.x),
          y: Math.round(metres.y),
          summary,
          clue: "",
          era: eraOf(summary),
          url: `https://en.wikipedia.org/?curid=${page.pageid}`,
        } satisfies Site;
      })
      // inside the playable area only — you cannot walk to what is not rendered
      .filter((site) => Math.hypot(site.x, site.y) < radius * 0.92)

      // things that happened, before things that merely exist
      .sort((a, b) => interest(b.title, b.summary) - interest(a.title, a.summary));

    /**
     * Only places you can physically stand on. A district has no answer — its
     * coordinate is the centroid of hundreds of square kilometres — so serving
     * one as a case is worse than admitting the city is too thinly documented.
     */
    const pool = candidates.filter((site) => isFindable(site.title, site.summary));

    // Spread the rounds across the map, but a thinly documented city should still
    // get a full game — relax the spacing rather than hand back one round.
    let chosen: Site[] = [];
    const spacing = rounds > 8 ? [140, 90, 50, 0] : [MIN_SEPARATION_M, 120, 60, 0];
    for (const separation of spacing) {
      chosen = [];
      for (const site of pool) {
        if (chosen.length >= rounds) break;
        const clash = chosen.some((c) => distance(c.x, c.y, site.x, site.y) < separation);
        if (!clash) chosen.push(site);
      }
      if (chosen.length >= rounds) break;
    }

    if (chosen.length === 0) {
      return NextResponse.json(
        {
          error: candidates.length > 0
            ? "Only districts and townships are recorded here — nothing you could walk to. Try a larger or older city."
            : "Wikipedia has no geolocated history for that area.",
        },
        { status: 422 },
      );
    }

    chosen.forEach((site) => { site.clue = redact(site.title, site.summary); });

    const written = await writeClues(chosen);
    if (written) {
      chosen.forEach((site) => {
        const better = written.get(site.id);
        if (better) {
          site.clue = better.clue;
          if (better.era !== "undated") site.era = better.era;
        }
      });
    }

    cache.set(key, { at: Date.now(), sites: chosen });
    return NextResponse.json({ sites: chosen, source: written ? "gemini" : "redacted" });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not gather the city's history.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
