import { NextResponse } from "next/server";
import { bboxAround, toMetres, type CityData, type Dot, type LatLon, type Way } from "../../../lib/geo";

export const runtime = "nodejs";

const RADIUS_M = 1200;
const UA = "how-well-do-you-know-your-city/0.1 (educational project)";
const MAX_BUILDINGS = 1600;
const MAX_ROADS = 1400;
const MAX_TREES = 2500;

// Building a city costs three upstream round trips, so hold onto it.
const cache = new Map<string, { at: number; data: CityData }>();
const CACHE_MS = 60 * 60 * 1000;

const ROAD_KINDS = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|pedestrian|living_street|footway";

type OverpassWay = {
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
    pts: simplify(pts, tol),
    // amenity/religion refine the palette: a temple should not look like a warehouse
    kind: tags.highway || tags.amenity || tags.shop || tags.building || tags.natural || tags.leisure || "other",
    name: tags.name,
    levels: Number.isFinite(levels) ? levels : undefined,
    height: Number.isFinite(height) ? height : undefined,
  };
};

const geocode = async (query: string) => {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Could not reach the geocoder.");
  const results = await response.json();
  if (!Array.isArray(results) || results.length === 0) return null;

  return {
    centre: { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) } as LatLon,
    label: String(results[0].display_name ?? query),
  };
};

const fetchOsm = async (centre: LatLon) => {
  const b = bboxAround(centre, RADIUS_M);
  const box = `${b.south},${b.west},${b.north},${b.east}`;
  const query = `[out:json][timeout:60];(` +
    `way["highway"~"^(${ROAD_KINDS})$"](${box});` +
    `way["building"](${box});` +
    `way["natural"="water"](${box});way["waterway"="riverbank"](${box});` +
    `way["leisure"="park"](${box});way["landuse"="grass"](${box});way["landuse"="forest"](${box});` +
    `node["natural"="tree"](${box});` +
    `);out geom;`;

  // Overpass is friendlier to GET, and 504s under load — one retry is worth it.
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(75_000),
    });
    if (response.ok) return (await response.json()).elements as OverpassWay[];
  }
  throw new Error("The map service is busy. Try again in a moment.");
};

export async function POST(request: Request) {
  let query = "";
  try {
    const body = await request.json();
    query = String(body?.city ?? "").trim();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
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
    const place = await geocode(query);
    if (!place) {
      return NextResponse.json({ error: `No city called "${query}" was found.` }, { status: 404 });
    }

    const elements = await fetchOsm(place.centre);

    const roads: Way[] = [];
    const buildings: Way[] = [];
    const water: Way[] = [];
    const parks: Way[] = [];
    const trees: Dot[] = [];

    for (const element of elements) {
      const tags = element.tags ?? {};
      if (element.type === "node" && tags.natural === "tree") {
        if (typeof element.lat !== "number" || typeof element.lon !== "number") continue;
        const m = toMetres(place.centre, element.lat, element.lon);
        trees.push({ x: Math.round(m.x), y: Math.round(m.y) });
      } else if (tags.highway) {
        const way = project(place.centre, element, 4);
        if (way) roads.push(way);
      } else if (tags.building) {
        const way = project(place.centre, element, 2);
        if (way) buildings.push(way);
      } else if (tags.natural === "water" || tags.waterway === "riverbank") {
        const way = project(place.centre, element, 8);
        if (way) water.push(way);
      } else if (tags.leisure === "park" || tags.landuse === "grass" || tags.landuse === "forest") {
        const way = project(place.centre, element, 8);
        if (way) parks.push(way);
      }
    }

    if (roads.length === 0) {
      return NextResponse.json(
        { error: `OpenStreetMap has no street data around "${place.label}".` },
        { status: 422 },
      );
    }

    const data: CityData = {
      query,
      label: place.label,
      centre: place.centre,
      radius: RADIUS_M,
      // named roads first, so if we clip we keep the ones worth navigating by
      roads: roads.sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0)).slice(0, MAX_ROADS),
      buildings: buildings.slice(0, MAX_BUILDINGS),
      water,
      parks,
      trees: trees.slice(0, MAX_TREES),
    };

    cache.set(key, { at: Date.now(), data });
    return NextResponse.json(data);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not build that city.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
