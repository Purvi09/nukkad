// Shared geometry for the city game.
// Everything the client draws is in *metres relative to the city centre*, so the
// server projects once and the browser never touches lat/lon.

export type LatLon = { lat: number; lon: number };

/** A polyline or polygon, already projected to local metres. */
export type Way = {
  /** flat [x0,y0,x1,y1,...] in metres, x east, y south */
  pts: number[];
  kind: string;
  name?: string;
  /** storeys, where OSM knows them */
  levels?: number;
  /** metres, from the OSM height tag, where present */
  height?: number;
};

/** A point feature — currently just street trees. */
export type Dot = { x: number; y: number };

export type CityData = {
  query: string;
  label: string;
  centre: LatLon;
  radius: number;
  roads: Way[];
  buildings: Way[];
  water: Way[];
  parks: Way[];
  trees: Dot[];
};

/** Shared between the top view and the street view so you keep your place. */
export type Pose = { x: number; y: number; heading: number };

export type Site = {
  id: string;
  /** Where the case came from: the record, or a person. */
  kind?: "history" | "memory";
  title: string;
  /** metres from centre */
  x: number;
  y: number;
  summary: string;
  clue: string;
  era: string;
  url: string;
  /** Set on memory cases: who left it, when, and where it was pinned. */
  leftAt?: number;
  place?: string;
  by?: string;
};

const M_PER_DEG_LAT = 110574;

export const mPerDegLon = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

/** lat/lon -> metres east/south of a centre point. */
export const toMetres = (centre: LatLon, lat: number, lon: number) => ({
  x: (lon - centre.lon) * mPerDegLon(centre.lat),
  y: (centre.lat - lat) * M_PER_DEG_LAT,
});

/** metres east/south of a centre -> lat/lon, the inverse of toMetres. */
export const toLatLon = (centre: LatLon, x: number, y: number): LatLon => ({
  lat: centre.lat - y / M_PER_DEG_LAT,
  lon: centre.lon + x / mPerDegLon(centre.lat),
});

/** Bounding box of a radius in metres around a centre, as Overpass wants it. */
export const bboxAround = (centre: LatLon, radius: number) => {
  const dLat = radius / M_PER_DEG_LAT;
  const dLon = radius / mPerDegLon(centre.lat);
  return {
    south: centre.lat - dLat,
    west: centre.lon - dLon,
    north: centre.lat + dLat,
    east: centre.lon + dLon,
  };
};

/** Metres -> isometric screen pixels. */
export const PX_PER_M = 0.85;
export const iso = (x: number, y: number) => ({
  x: (x - y) * PX_PER_M,
  y: (x + y) * PX_PER_M * 0.5,
});

export const distance = (ax: number, ay: number, bx: number, by: number) =>
  Math.hypot(ax - bx, ay - by);
