import { NextResponse } from "next/server";
import {
  bboxAround, toLatLon, toMetres, tileIndex, tileKey, CORE_SPAN, MAX_TILE_INDEX, TILE_M,
  type CityData, type Dot, type LatLon, type TileData, type Way,
} from "../../../lib/geo";

export const runtime = "nodejs";

/** Gameplay happens inside this; the map itself streams further out. */
const RADIUS_M = CORE_SPAN * TILE_M;
const UA = "how-well-do-you-know-your-city/0.1 (educational project)";
/**
 * Caps are per tile, so a dense city is dense everywhere rather than solid in
 * the middle and bare at the edge. The renderer only keeps nearby tiles, so
 * these bound what is drawn at once, not what a city may contain.
 */
const MAX_TILE_BUILDINGS = 300;
const MAX_TILE_ROADS = 200;
const MAX_TILE_TREES = 250;

// Building a city costs three upstream round trips, so hold onto it for as
// long as this process lives. Clients keep their own copies beyond that.
const cache = new Map<string, { at: number; data: CityData }>();
const tileCache = new Map<string, { at: number; data: TileData }>();
const CACHE_MS = 24 * 60 * 60 * 1000;

const ROAD_KINDS = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|pedestrian|living_street|footway";

type OverpassWay = {
  id?: number;
  type?: string;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
};

/** Drop points that are within `tol` metres of the previous kept point. */
const simplify = (pts: number[], tol: number) => {
  if (pts.length <= 4) return pts;
  const out = [pts[0], pts[1]];
  for (let i = 2; i < pts.length - 2; i += 2) {
    const dx = pts[i] - out[out.length - 2];
    const dy = pts[i + 1] - out[out.length - 1];
    if (Math.hypot(dx, dy) >= tol) out.push(pts[i], pts[i + 1]);
  }
  out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out;
};

/** How far a way's first point is from the centre, for nearest-first clipping. */
const nearness = (way: Way) => Math.hypot(way.pts[0], way.pts[1]);

/** Polygon area in square metres (shoelace), for dropping clutter. */
const footprintArea = (pts: number[]) => {
  let a = 0;
  for (let i = 0; i < pts.length - 2; i += 2) a += pts[i] * pts[i + 3] - pts[i + 2] * pts[i + 1];
  return Math.abs(a / 2);
};

const wayLength = (pts: number[]) => {
  let l = 0;
  for (let i = 2; i < pts.length; i += 2) l += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return l;
};

/**
 * Clutter, not city: a garage or a bus shelter drawn as a three-storey block
 * makes a street look crowded without making it look more like itself.
 */
const CLUTTER_BUILDING = new Set([
  "roof", "shed", "garage", "garages", "hut", "carport", "kiosk", "toilets", "shelter",
  "greenhouse", "container", "tent", "guardhouse", "transformer_tower", "service",
]);
const MIN_BUILDING_M2 = 25;
/** Footway fragments — steps, crossings, paths across a car park — under this are noise. */
const MIN_FOOTWAY_M = 40;

/** Streets first, then lanes, then paths: what to keep when a city is too big to draw whole. */
const ROAD_RANK: Record<string, number> = {
  motorway: 0, trunk: 0, primary: 0, secondary: 1, tertiary: 1, unclassified: 2,
  residential: 2, living_street: 3, pedestrian: 3, footway: 4,
};
const roadRank = (way: Way) => ROAD_RANK[way.kind] ?? 3;

const project = (centre: LatLon, way: OverpassWay, tol: number): Way | null => {
  const geometry = way.geometry;
  if (!geometry || geometry.length < 2) return null;
  const pts: number[] = [];
  for (const p of geometry) {
    const m = toMetres(centre, p.lat, p.lon);
    pts.push(Math.round(m.x * 10) / 10, Math.round(m.y * 10) / 10);
  }
  const tags = way.tags ?? {};
  const levels = tags["building:levels"] ? parseInt(tags["building:levels"], 10) : undefined;
  const height = tags.height ? parseFloat(tags.height) : undefined;
  return {
    id: typeof way.id === "number" ? way.id : undefined,
    pts: simplify(pts, tol),
    // amenity/religion refine the palette: a temple should not look like a warehouse
    kind: tags.highway || tags.amenity || tags.shop || tags.building || tags.natural || tags.leisure || "other",
    name: tags.name,
    levels: Number.isFinite(levels) ? levels : undefined,
    height: Number.isFinite(height) ? height : undefined,
  };
};

type Place = { centre: LatLon; label: string };

const MAPS_KEY = () => process.env.GOOGLE_MAPS_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

/**
 * Google's geocoder, when a key is configured. It resolves "Bhilwara" to the
 * town rather than the district, and copes with misspellings and local names.
 */
const geocodeGoogle = async (query: string): Promise<Place | null> => {
  const key = MAPS_KEY();
  if (!key) return null;
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", query);
  url.searchParams.set("key", key);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const data = await response.json();
    const result = Array.isArray(data?.results) ? data.results[0] : null;
    const loc = result?.geometry?.location;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return null;
    return { centre: { lat: loc.lat, lon: loc.lng }, label: String(result.formatted_address ?? query) };
  } catch {
    return null; // fall through to Nominatim
  }
};

/**
 * Nominatim ranks the *district* called Bhilwara above the *town* called
 * Bhilwara, and the district's coordinate is the centroid of hundreds of square
 * kilometres of farmland. Ask for several results and take the settlement.
 */
const SETTLEMENT = new Set(["city", "town", "village", "suburb", "neighbourhood", "quarter", "hamlet", "borough", "city_district"]);

const geocodeNominatim = async (query: string): Promise<Place | null> => {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "5");

  const response = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Could not reach the geocoder.");
  const results = await response.json();
  if (!Array.isArray(results) || results.length === 0) return null;

  const rank = (r: { class?: string; type?: string }) =>
    r.class === "place" && SETTLEMENT.has(r.type ?? "") ? 0
    : r.class === "place" ? 1
    : r.class === "boundary" ? 3
    : 2;
  const best = [...results].sort((a, b) => rank(a) - rank(b))[0];

  return {
    centre: { lat: parseFloat(best.lat), lon: parseFloat(best.lon) } as LatLon,
    label: String(best.display_name ?? query),
  };
};

const geocode = async (query: string): Promise<Place | null> =>
  (await geocodeGoogle(query)) ?? geocodeNominatim(query);

type Bbox = { south: number; west: number; north: number; east: number };

/**
 * Public Overpass servers. The main one allows a couple of requests at a time
 * per address and answers 429 to anything more, so requests from this process
 * go out one at a time, and a refusal moves on to the next mirror.
 */
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  // the two machines behind that name, so one being down does not take the other with it
  "https://z.overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const RATIONED = (base: string) => base.includes("overpass-api.de");

/**
 * One Overpass request at a time from this process. Somebody walking toward
 * a tile edge goes first; warming the ring around a fresh city waits its turn.
 */
type Job = { run: () => Promise<void>; urgent: boolean };
const waiting: Job[] = [];
let busy = false;
const pump = () => {
  if (busy) return;
  const next = waiting.find((j) => j.urgent) ?? waiting[0];
  if (!next) return;
  waiting.splice(waiting.indexOf(next), 1);
  busy = true;
  void next.run().finally(() => { busy = false; pump(); });
};
const queued = <T,>(job: () => Promise<T>, urgent = true): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    waiting.push({ urgent, run: () => job().then(resolve, reject) });
    pump();
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A mirror that just failed is not asked again for a while. */
const mirrorDownUntil = new Map<string, number>();
const MIRROR_REST_MS = 5 * 60 * 1000;

/**
 * The main server rations queries per address and says, on its status page,
 * when the next slot opens. Waiting exactly that long beats guessing.
 */
const slotWait = async (): Promise<number> => {
  try {
    const response = await fetch("https://overpass-api.de/api/status", {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(8_000),
    });
    const text = await response.text();
    if (/slots? available now/.test(text)) return 0;
    const waits = [...text.matchAll(/in (\d+) seconds/g)].map((m) => Number(m[1]));
    if (waits.length > 0) return Math.min(25_000, (Math.min(...waits) + 1) * 1000);
  } catch { /* fall through */ }
  return 5_000;
};

const fetchOsm = (b: Bbox, urgent = true) => queued(async () => {
  const box = `${b.south},${b.west},${b.north},${b.east}`;
  const query = `[out:json][timeout:60];(` +
    `way["highway"~"^(${ROAD_KINDS})$"](${box});` +
    `way["building"](${box});` +
    `way["natural"="water"](${box});way["waterway"="riverbank"](${box});` +
    `way["leisure"="park"](${box});way["landuse"="grass"](${box});way["landuse"="forest"](${box});` +
    `node["natural"="tree"](${box});` +
    `);out geom;`;

  const ask = async (base: string, timeoutMs: number) => {
    const host = base.split("/")[2];
    const started = Date.now();
    try {
      const response = await fetch(`${base}?data=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return (await response.json()).elements as OverpassWay[];
      console.warn(`overpass ${host} answered ${response.status} after ${Date.now() - started}ms`);
      return response.status;
    } catch (caught) {
      console.warn(`overpass ${host} failed after ${Date.now() - started}ms: ${caught instanceof Error ? caught.name : "error"}`);
      return 0;
    }
  };

  // Round the servers, skipping any that just failed to connect. A 429 from
  // the main service means "not yet": its status page says when, so wait
  // that long once per round rather than hammering it.
  for (let round = 0; round < 3; round++) {
    let waited = false;
    for (const base of OVERPASS) {
      if ((mirrorDownUntil.get(base) ?? 0) > Date.now()) continue;
      const result = await ask(base, RATIONED(base) ? 45_000 : 20_000);
      if (Array.isArray(result)) return result;
      if (result === 0) {
        // could not connect at all: leave it alone for a minute
        mirrorDownUntil.set(base, Date.now() + (RATIONED(base) ? 60_000 : MIRROR_REST_MS));
        continue;
      }
      if (result === 429 && RATIONED(base) && !waited) {
        waited = true;
        const wait = await slotWait();
        if (wait > 0) await sleep(wait);
      }
    }
  }
  throw new Error("The map service is busy. Try again in a moment.");
}, urgent);

export async function POST(request: Request) {
  let query = "";
  let tile: { cx: number; cy: number } | null = null;
  let centre: LatLon | null = null;
  try {
    const body = await request.json();
    query = String(body?.city ?? "").trim();
    if (body?.tile) {
      tile = { cx: Number(body.tile.cx), cy: Number(body.tile.cy) };
      centre = { lat: Number(body?.centre?.lat), lon: Number(body?.centre?.lon) };
    }
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (tile && centre) {
    const sane = Number.isInteger(tile.cx) && Number.isInteger(tile.cy)
      && Math.abs(tile.cx) <= MAX_TILE_INDEX && Math.abs(tile.cy) <= MAX_TILE_INDEX
      && Number.isFinite(centre.lat) && Number.isFinite(centre.lon);
    if (!sane) return NextResponse.json({ error: "bad tile" }, { status: 400 });
    try {
      return NextResponse.json(await buildTile(centre, tile.cx, tile.cy));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not fetch that tile.";
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  if (query.length < 2) {
    return NextResponse.json({ error: "Name a city." }, { status: 400 });
  }

  const key = query.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json(hit.data);
  }

  try {
    // "Lisbon @38.71,-9.14": a city built around a given point, for a link to
    // a memory. The name is only a label; the point is the centre.
    const pinned = query.match(/^(.*?)\s*@\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    const place = pinned
      ? { centre: { lat: Number(pinned[2]), lon: Number(pinned[3]) }, label: pinned[1].trim() || "Somewhere" }
      : await geocode(query);
    if (!place || !Number.isFinite(place.centre.lat) || !Number.isFinite(place.centre.lon)) {
      return NextResponse.json({ error: `No city called "${query}" was found.` }, { status: 404 });
    }

    const found = collect(place.centre, await fetchOsm(bboxAround(place.centre, RADIUS_M)));

    if (found.roads.length === 0) {
      return NextResponse.json(
        { error: `OpenStreetMap has no street data around "${place.label}".` },
        { status: 422 },
      );
    }

    // Cap tile by tile, so the payload is uniformly dense rather than solid
    // in the middle and empty at the rim.
    const merged: Features = { roads: [], buildings: [], water: [], parks: [], trees: [] };
    for (const tile of splitIntoTiles(found, CORE_SPAN).values()) {
      const capped = capTile(tile);
      merged.roads.push(...capped.roads);
      merged.buildings.push(...capped.buildings);
      merged.water.push(...capped.water);
      merged.parks.push(...capped.parks);
      merged.trees.push(...capped.trees);
    }

    const data: CityData = {
      query,
      label: place.label,
      centre: place.centre,
      radius: RADIUS_M,
      ...merged,
    };

    cache.set(key, { at: Date.now(), data });
    warmRing(place.centre);
    return NextResponse.json(data);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not build that city.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

type Features = { roads: Way[]; buildings: Way[]; water: Way[]; parks: Way[]; trees: Dot[] };

/**
 * Fetch the ring of blocks just outside a freshly built city, nearest first,
 * behind anything a player is actually waiting on. By the time someone walks
 * to the edge, the next tile is usually already here.
 */
const warming = new Set<string>();
const warmRing = (centre: LatLon) => {
  const id = `${centre.lat.toFixed(5)},${centre.lon.toFixed(5)}`;
  if (warming.has(id)) return;
  warming.add(id);
  const blocks: Array<{ x: number; y: number }> = [];
  // the core is tiles -CORE_SPAN..CORE_SPAN-1; blocks are BLOCK tiles wide
  const inner = Math.floor(-CORE_SPAN / BLOCK) * BLOCK;
  const outer = Math.floor((CORE_SPAN - 1) / BLOCK) * BLOCK;
  // only the blocks that straddle the core's edge: one tile further out in
  // every direction, twelve requests, not the whole neighbourhood
  const fullyInside = (i: number) => i >= -CORE_SPAN && i + BLOCK - 1 <= CORE_SPAN - 1;
  for (let x = inner; x <= outer; x += BLOCK) {
    for (let y = inner; y <= outer; y += BLOCK) {
      if (fullyInside(x) && fullyInside(y)) continue;
      blocks.push({ x, y });
    }
  }
  blocks.sort((a, b) => Math.hypot(a.x + 1, a.y + 1) - Math.hypot(b.x + 1, b.y + 1));
  void (async () => {
    // the server rations queries per address: start late, go slowly, and
    // always let a player's own request go first
    await sleep(45_000);
    for (const b of blocks) {
      try { await buildTile(centre, b.x, b.y, false); } catch { /* the player's own request will retry */ }
      await sleep(45_000);
    }
  })();
};

/** Everything worth drawing from a batch of Overpass elements, clutter removed. */
const collect = (centre: LatLon, elements: OverpassWay[]): Features => {
  const out: Features = { roads: [], buildings: [], water: [], parks: [], trees: [] };
  for (const element of elements) {
    const tags = element.tags ?? {};
    if (element.type === "node" && tags.natural === "tree") {
      if (typeof element.lat !== "number" || typeof element.lon !== "number") continue;
      const m = toMetres(centre, element.lat, element.lon);
      out.trees.push({ x: Math.round(m.x), y: Math.round(m.y) });
    } else if (tags.highway) {
      const way = project(centre, element, 4);
      if (!way) continue;
      if (way.kind === "footway" && wayLength(way.pts) < MIN_FOOTWAY_M) continue;
      out.roads.push(way);
    } else if (tags.building) {
      const way = project(centre, element, 2);
      if (!way) continue;
      // keep anything with a name: a named kiosk is a landmark to somebody
      if (!way.name && (CLUTTER_BUILDING.has(tags.building) || footprintArea(way.pts) < MIN_BUILDING_M2)) continue;
      out.buildings.push(way);
    } else if (tags.natural === "water" || tags.waterway === "riverbank") {
      const way = project(centre, element, 8);
      if (way) out.water.push(way);
    } else if (tags.leisure === "park" || tags.landuse === "grass" || tags.landuse === "forest") {
      const way = project(centre, element, 8);
      if (way) out.parks.push(way);
    }
  }
  return out;
};

/** Bucket features by the tile their first point falls in, clamped to the core. */
const splitIntoTiles = (found: Features, span: number) => {
  const tiles = new Map<string, TileData>();
  const clamp = (i: number) => Math.max(-span, Math.min(span - 1, i));
  const at = (x: number, y: number) => {
    const cx = clamp(tileIndex(x));
    const cy = clamp(tileIndex(y));
    const key = tileKey(cx, cy);
    let tile = tiles.get(key);
    if (!tile) { tile = { cx, cy, roads: [], buildings: [], water: [], parks: [], trees: [] }; tiles.set(key, tile); }
    return tile;
  };
  found.roads.forEach((w) => at(w.pts[0], w.pts[1]).roads.push(w));
  found.buildings.forEach((w) => at(w.pts[0], w.pts[1]).buildings.push(w));
  found.water.forEach((w) => at(w.pts[0], w.pts[1]).water.push(w));
  found.parks.forEach((w) => at(w.pts[0], w.pts[1]).parks.push(w));
  found.trees.forEach((t) => at(t.x, t.y).trees.push(t));
  return tiles;
};

/** What one tile may hold: the biggest buildings, the streets before the paths. */
const capTile = (tile: TileData): TileData => ({
  ...tile,
  roads: [...tile.roads]
    .sort((a, b) =>
      (roadRank(a) - roadRank(b))
      || ((b.name ? 1 : 0) - (a.name ? 1 : 0))
      || (nearness(a) - nearness(b)))
    .slice(0, MAX_TILE_ROADS),
  // biggest first: dropping a shed leaves a gap nobody notices, dropping a
  // block leaves a hole in the street
  buildings: [...tile.buildings]
    .sort((a, b) => footprintArea(b.pts) - footprintArea(a.pts))
    .slice(0, MAX_TILE_BUILDINGS),
  trees: tile.trees.slice(0, MAX_TILE_TREES),
});

/**
 * One tile beyond the core, asked for as the player approaches it. The client
 * sends the centre it already knows, so this never geocodes.
 *
 * Overpass is fetched two tiles by two: a player walking in a straight line
 * asks for tiles in pairs and rows anyway, and the rate limit is per request,
 * not per square metre.
 */
const BLOCK = 2;
const pendingBlocks = new Map<string, Promise<void>>();

const buildTile = async (centre: LatLon, cx: number, cy: number, urgent = true): Promise<TileData> => {
  const tileId = (x: number, y: number) => `${centre.lat.toFixed(5)},${centre.lon.toFixed(5)}:${tileKey(x, y)}`;
  const hit = tileCache.get(tileId(cx, cy));
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const bx = Math.floor(cx / BLOCK) * BLOCK;
  const by = Math.floor(cy / BLOCK) * BLOCK;
  const blockId = tileId(bx, by) + ":block";
  let pending = pendingBlocks.get(blockId);
  if (!pending) {
    pending = (async () => {
      const a = toLatLon(centre, bx * TILE_M, by * TILE_M);
      const b = toLatLon(centre, (bx + BLOCK) * TILE_M, (by + BLOCK) * TILE_M);
      const box: Bbox = {
        south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat),
        west: Math.min(a.lon, b.lon), east: Math.max(a.lon, b.lon),
      };
      const found = collect(centre, await fetchOsm(box, urgent));
      // bucket by first point, clamped into the block; the client drops
      // anything a neighbouring tile has already drawn, by id
      const tiles = new Map<string, TileData>();
      for (let x = bx; x < bx + BLOCK; x++) {
        for (let y = by; y < by + BLOCK; y++) tiles.set(tileKey(x, y), { cx: x, cy: y, roads: [], buildings: [], water: [], parks: [], trees: [] });
      }
      const at = (x: number, y: number) => {
        const tx = Math.max(bx, Math.min(bx + BLOCK - 1, tileIndex(x)));
        const ty = Math.max(by, Math.min(by + BLOCK - 1, tileIndex(y)));
        return tiles.get(tileKey(tx, ty))!;
      };
      found.roads.forEach((w) => at(w.pts[0], w.pts[1]).roads.push(w));
      found.buildings.forEach((w) => at(w.pts[0], w.pts[1]).buildings.push(w));
      found.water.forEach((w) => at(w.pts[0], w.pts[1]).water.push(w));
      found.parks.forEach((w) => at(w.pts[0], w.pts[1]).parks.push(w));
      found.trees.forEach((t) => at(t.x, t.y).trees.push(t));
      for (const tile of tiles.values()) {
        tileCache.set(tileId(tile.cx, tile.cy), { at: Date.now(), data: capTile(tile) });
      }
    })().finally(() => pendingBlocks.delete(blockId));
    pendingBlocks.set(blockId, pending);
  }
  await pending;
  return tileCache.get(tileId(cx, cy))!.data;
};
