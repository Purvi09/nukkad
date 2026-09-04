"use client";

import { useEffect, useRef } from "react";
import {
  PX_PER_M, iso, tileIndex, tileKey, MAX_TILE_INDEX, TILE_M, WORLD_LIMIT_M,
  type CityData, type Dot, type Pose, type TileData, type Way,
} from "../lib/geo";
import { nearSound, stepSound } from "../lib/sound";

type Props = {
  city: CityData;
  /** Shared with the street view, so switching keeps you where you were. */
  pose: { current: Pose };
  witnesses: Array<{ id: string; x: number; y: number; name: string; look: string; spoken: boolean; locked: boolean }>;
  /** Who the player chose, and what that changes. */
  kit: { coat: number; trousers: number; hat: number; skin: number; speed: number; talkRange: number };
  onNear: (id: string | null) => void;
  onTalk: (id: string) => void;
  /** Memories people left here, as pins you can walk up to. */
  memories: Array<{ id: string; x: number; y: number; photo?: boolean }>;
  /** Other people walking this city right now. */
  others: Array<{ uid: string; x: number; y: number; name: string; coat: number }>;
  onNearMemory: (id: string | null) => void;
  onReadMemory: (id: string) => void;
  /** The true site, drawn only once the round is over. */
  reveal: { x: number; y: number } | null;
  /** Its name, shown on the pin. */
  revealTitle?: string;
  guess: { x: number; y: number } | null;
  frozen: boolean;
  onCommit: (x: number, y: number) => void;
  onStreet: (where: { street: string | null; place: string | null }) => void;
  onInit?: (ok: boolean) => void;
  /** Movement from an on-screen stick, merged with the keyboard each frame. */
  touch?: { current: TouchInput };
  /** Handles the page can call: zoom in and out without a wheel. */
  api?: { current: SceneApi | null };
  /** Fetch one tile beyond the initial payload. Null means "not now". */
  loadTile?: (cx: number, cy: number) => Promise<TileData | null>;
};

/** Tiles this close to the player (nearest edge) are fetched and drawn. */
const LOAD_RANGE = 600;
/** Tiles this far behind the player are dropped again. */
const UNLOAD_RANGE = 900;
/** How many tile fetches may be in the air at once. */
const MAX_IN_FLIGHT = 2;

export type TouchInput = { sx: number; sy: number; run: boolean };
export type SceneApi = { zoomBy: (factor: number) => void };


const RUN_SPEED = 105;     // metres per second
const SPRINT_MULT = 2.4;   // hold Shift
const DEFAULT_ZOOM = 2.0; // close enough that a block fills the view and a building is a building
const MIN_ZOOM = 0.22;
const MAX_ZOOM = 3.0;
const MINIMAP_SIZE = 190;
const COLLIDE_CELL = 60;
const WALK_CELL = 45;
/** How far from a road's centreline you may still stand, in metres. */
const WALK_WIDTH: Record<string, number> = {
  motorway: 10, trunk: 9.5, primary: 9, secondary: 8, tertiary: 7,
  unclassified: 6, residential: 6, living_street: 5.5, pedestrian: 5.5, footway: 4,
};
const DEFAULT_WALK_WIDTH = 6;
/** Witnesses pace their own corner: slow, and on a short leash. */
const WITNESS_SPEED = 5;
const WITNESS_LEASH = 34;
/** A little slack, so following a street is not knife-edge precise. */
const WALK_SLACK = 3.5;

/**
 * The scene renders into a canvas at this fraction of its CSS size and is then
 * stretched back up with nearest-neighbour. That is the whole pixel-art trick:
 * chunky pixels, and far fewer fragments to shade.
 */
const PIXEL = 0.45;
/** Type sizes are pre-multiplied so they survive the downscale. */
const FS = 1 / PIXEL;

const LAND = 0xd8d2c2;
const ROAD_FILL = 0x9aa1a8;
const ROAD_EDGE = 0x6f767d;
const WATER = 0x4d9fd6;
const PARK = 0x8dbb70;
const SHADOW = 0x4a5560;
/** Walls stay pale; the roof carries the colour. That is the whole look. */
const WALL = 0xf4efe4;
/**
 * Isometric cities read better when they are taller than life, but only for
 * the buildings that are tall in life. Boosting every house turns a street of
 * two-storey flats into a canyon.
 */
const HEIGHT_BOOST = 2.1;
const HOUSE_BOOST = 1.7;
const TALL_KINDS = new Set([
  "office", "commercial", "hotel", "hospital", "university", "college", "school", "industrial",
  "warehouse", "place_of_worship", "temple", "mosque", "church", "cathedral", "theatre", "mall",
  "retail", "supermarket", "public", "civic", "government", "train_station", "apartments",
]);
const boostFor = (kind: string) => (TALL_KINDS.has(kind) ? HEIGHT_BOOST : HOUSE_BOOST);

/** Buildings this close to the player are in full colour; beyond FOCUS_FAR they haze. */
const FOCUS_NEAR = 120;
const FOCUS_FAR = 400;
const HAZE_TINT = { r: 0xa6, g: 0xb4, b: 0xc4 };

/** Roof colour, from whatever OSM knows about the building. */
const PALETTE: Record<string, number> = {
  house: 0x5e8bc4,
  residential: 0x5583be,
  apartments: 0x4a76b4,
  detached: 0x6d9ad0,
  commercial: 0x3f6fa8,
  retail: 0xe08a45,
  shop: 0xe08a45,
  supermarket: 0xe08a45,
  office: 0x35608f,
  industrial: 0x8a7f76,
  warehouse: 0x7d746c,
  place_of_worship: 0xc9553f,
  temple: 0xc9553f,
  mosque: 0xd3a03c,
  church: 0xd3a03c,
  school: 0x4fa383,
  university: 0x4fa383,
  college: 0x4fa383,
  hospital: 0xd8534f,
  hotel: 0x8d63b5,
  restaurant: 0xe08a45,
  cafe: 0xe08a45,
  garage: 0x9aa1a8,
  garages: 0x9aa1a8,
  hut: 0xa8886a,
  roof: 0x6a86a8,
  construction: 0xb0a68f,
};
const DEFAULT_BUILDING = 0x6288b8;
/**
 * Most buildings are tagged only "yes". A street of them in one colour is a
 * carpet; in a handful of muted tones, chosen per building, it is a street.
 */
const ROOF_TONES = [0x6288b8, 0x6288b8, 0xb8705a, 0x8d939b, 0xc2a565, 0x7f9c72, 0x9c7f92, 0x6f93b9, 0xa88a6e];
const PLAIN_KINDS = new Set(["yes", "house", "residential", "apartments", "detached", "terrace", "semidetached_house", "bungalow"]);
const roofFor = (kind: string, seed: number) =>
  PLAIN_KINDS.has(kind) ? ROOF_TONES[seed % ROOF_TONES.length] : (PALETTE[kind] ?? DEFAULT_BUILDING);

/** Signs only show within this many metres of the player. */
/** Labels are dropped entirely past this, to keep the working set small. */
const SIGN_KEEP_RANGE = 900;
/** Ceiling on labels drawn at once — enough to feel mapped, not papered. */
const MAX_VISIBLE_SIGNS = 14;
/** Side-street names only appear this close to the player. */
const MINOR_SIGN_RANGE = 150;
const MAJOR_ROADS = new Set(["motorway", "trunk", "primary", "secondary", "tertiary"]);
const PAVEMENT = 0xe3ddd0;
/** Buildings you would otherwise be hidden behind fade to this. */
const OCCLUDED_ALPHA = 0.3;
const FADE_RADIUS = 90; // metres of buildings to test against the player
/** Coats and car paint, so the street is not one colour. */
const COAT_TONES = [0xd8564e, 0x3f7fc4, 0x5aa36a, 0xd39a3c, 0x8d63b5, 0xcf6fa0];
const CAR_TONES = [0xe8e4dc, 0x3a4a5e, 0xc2453c, 0x4a6fa5, 0x2f3a44, 0xd8a63c];

const SHOPFRONTS = new Set(["retail", "shop", "supermarket", "commercial", "restaurant", "cafe", "hotel"]);

const ROAD_STYLE: Record<string, { width: number }> = {
  motorway: { width: 11 },
  trunk: { width: 10 },
  primary: { width: 9 },
  secondary: { width: 8 },
  tertiary: { width: 6.5 },
  unclassified: { width: 5 },
  residential: { width: 5 },
  living_street: { width: 4 },
  pedestrian: { width: 3.5 },
  footway: { width: 2 },
};

const shade = (color: number, factor: number) => {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.round((color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
};

/** Deterministic noise, so a city looks the same every time you load it. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const insidePoly = (pts: number[], x: number, y: number) => {
  let hit = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i];
    const yi = pts[i + 1];
    const xj = pts[j];
    const yj = pts[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

export default function CityScene({
  city, pose, witnesses, kit, onNear, onTalk,
  memories, others, onNearMemory, onReadMemory,
  reveal, revealTitle, guess, frozen, onCommit, onStreet, onInit, touch, api, loadTile,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = pose;
  const touchRef = useRef(touch);
  const apiRef = useRef(api);
  const loadTileRef = useRef(loadTile);

  const frozenRef = useRef(frozen);
  const revealRef = useRef(reveal);
  const guessRef = useRef(guess);
  const onCommitRef = useRef(onCommit);
  const onStreetRef = useRef(onStreet);
  const onInitRef = useRef(onInit);

  const markerDrawRef = useRef<(() => void) | null>(null);
  const revealTitleRef = useRef(revealTitle);

  // Keep the render loop reading fresh props without re-running init.
  useEffect(() => {
    frozenRef.current = frozen;
    revealRef.current = reveal;
    revealTitleRef.current = revealTitle;
    guessRef.current = guess;
    onCommitRef.current = onCommit;
    onStreetRef.current = onStreet;
    onInitRef.current = onInit;
    kitRef.current = kit;
    onNearMemoryRef.current = onNearMemory;
    onReadMemoryRef.current = onReadMemory;
    onNearRef.current = onNear;
    onTalkRef.current = onTalk;
    touchRef.current = touch;
    apiRef.current = api;
    loadTileRef.current = loadTile;
  });

  useEffect(() => { markerDrawRef.current?.(); }, [reveal, guess, revealTitle]);

  const kitRef = useRef(kit);
  const witnessesRef = useRef(witnesses);
  const onNearRef = useRef(onNear);
  const onTalkRef = useRef(onTalk);

  const memoriesRef = useRef(memories);
  const onNearMemoryRef = useRef(onNearMemory);
  const onReadMemoryRef = useRef(onReadMemory);

  const othersRef = useRef(others);
  const othersDrawRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    othersRef.current = others;
    othersDrawRef.current?.();
  }, [others]);

  const pinsDrawRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    memoriesRef.current = memories;
    pinsDrawRef.current?.();
  }, [memories]);

  const castDrawRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    witnessesRef.current = witnesses;
    castDrawRef.current?.();
  }, [witnesses]);

  useEffect(() => {
    let mounted = true;
    let app: any = null;
    let teardown: (() => void) | null = null;

    const init = async () => {
      let PIXI: any;
      try {
        PIXI = await import("pixi.js");
      } catch (err) {
        console.warn("Pixi failed to load:", err);
        onInitRef.current?.(false);
        return;
      }

      const host = hostRef.current;
      if (!mounted || !host) return;

      const { Application, Container, Graphics, Text, Culler } = PIXI;

      try {
        app = new Application();
        await app.init({
          width: host.clientWidth || 900,
          height: host.clientHeight || 620,
          backgroundAlpha: 0,
          resolution: Math.min(2, window.devicePixelRatio || 1),
          autoDensity: true,
          antialias: false,
          roundPixels: true,
        });
      } catch (err) {
        console.warn("Failed to start the renderer", err);
        onInitRef.current?.(false);
        return;
      }

      if (!mounted) {
        try { app.destroy(true, { children: true }); } catch { /* noop */ }
        return;
      }

      const canvas = app.canvas as HTMLCanvasElement;
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      host.appendChild(canvas);

      const world = new Container();
      app.stage.addChild(world);

      const polyToIso = (pts: number[]) => {
        const out: number[] = [];
        for (let i = 0; i < pts.length; i += 2) {
          const p = iso(pts[i], pts[i + 1]);
          out.push(p.x, p.y);
        }
        return out;
      };

      // ---- land ------------------------------------------------------------
      // The ground goes as far as you can walk. Tiles paint parks and water on it.
      const r = WORLD_LIMIT_M;
      const corners = [iso(-r, -r), iso(r, -r), iso(r, r), iso(-r, r)];
      world.addChild(new Graphics().poly(corners.flatMap((c) => [c.x, c.y])).fill({ color: LAND }));

      // ---- layers ----------------------------------------------------------
      // The city arrives in tiles, added as you approach and dropped once they
      // are far behind. Each tile draws into these shared layers, so the paint
      // order never depends on which tile got here first: every kerb under
      // every building, every road fill over every road edge.
      const groundLayer = new Container();
      const casingLayer = new Container();
      const fillLayer = new Container();
      const pavementLayer = new Container();
      const shadowLayer = new Container();
      const blockLayer = new Container();
      blockLayer.sortableChildren = true; // buildings sort by depth, whichever tile they came from
      const foliageLayer = new Container();
      const lampLayer = new Container();
      const traffic = new Graphics();
      world.addChild(
        groundLayer, casingLayer, fillLayer, pavementLayer, shadowLayer,
        blockLayer, foliageLayer, lampLayer, traffic,
      );

      // The time of day where the city is, from its longitude: a lamp-lit
      // evening looks softer than noon, and hides density the way dusk does.
      const dusk = new Graphics();
      dusk.eventMode = "none";
      app.stage.addChild(dusk);
      const paintDusk = () => {
        const hour = (((Date.now() / 3_600_000 + city.centre.lon / 15) % 24) + 24) % 24;
        // 0 at midday, 1 deep night, with a warm hour either side
        const night = hour < 5 ? 1 : hour < 7 ? (7 - hour) / 2 : hour < 18 ? 0 : hour < 21 ? (hour - 18) / 3 : 1;
        const golden = (hour >= 6 && hour < 8) || (hour >= 17.5 && hour < 19.5) ? 1 : 0;
        dusk.clear();
        if (night > 0) dusk.rect(0, 0, app.screen.width, app.screen.height).fill({ color: 0x1b2a48, alpha: 0.42 * night });
        if (golden > 0) dusk.rect(0, 0, app.screen.width, app.screen.height).fill({ color: 0xd08a4a, alpha: 0.12 });
      };
      paintDusk();

      // Screen-space labels, above the world and below the minimap.
      const labelLayer = new Container();
      app.stage.addChild(labelLayer);

      type Block = {
        gfx: any;
        /** world metres, for the focus haze */
        wx: number;
        wy: number;
        depth: number;
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
        faded: boolean;
        /** 1 up close, fading toward the ground far off */
        haze: number;
        tile: string;
      };
      const blockHash = new Map<string, Block[]>();

      type NamedSeg = { x1: number; y1: number; x2: number; y2: number; name: string };
      const segmentsByTile = new Map<string, NamedSeg[]>();
      const placesByTile = new Map<string, Array<{ name: string; x: number; y: number }>>();
      const roadsByTile = new Map<string, Way[]>();

      type Mover = { pts: number[]; seg: number; t: number; speed: number; dir: number; car: boolean; tone: number; tile: string };
      const movers: Mover[] = [];

      type SignSpec = {
        wx: number;
        wy: number;
        text: string;
        ink: number;
        board: number;
        lift: number;
        leader: boolean;
        /** A side street: named only when you are standing on it. */
        minor: boolean;
        tile: string;
      };
      /**
       * Signs are described up front but only built when you come near them.
       * A city has hundreds of names; making every text texture at load would
       * stall for seconds and hold memory for signs you never walk past.
       */
      const signSpecs = new Map<number, SignSpec>();
      const signNodes = new Map<number, any>();
      let nextSign = 0;
      // street names, one per name per ~260m, across tiles
      const placedNames = new Map<string, Array<{ x: number; y: number; tile: string }>>();

      /**
       * Map type, not signage: dark ink with a soft light halo so it stays
       * readable over grass, tarmac or a roof, the way a paper map reads.
       */
      const mapLabel = (text: string, street: boolean) => {
        const label = new Text({
          text,
          style: {
            fill: street ? 0x39434f : 0x4a4034,
            fontSize: street ? 12 : 11,
            fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
            fontWeight: street ? "600" : "500",
            letterSpacing: street ? 0.4 : 0.2,
            stroke: { color: 0xf7f6ee, width: 3.5, join: "round" },
          },
        });
        label.anchor.set(0.5);
        label.resolution = 2;
        return label;
      };

      // ---- collision and footing, bucketed by cell -------------------------
      const cellKey = (x: number, y: number) =>
        `${Math.floor(x / COLLIDE_CELL)},${Math.floor(y / COLLIDE_CELL)}`;
      const solids = new Map<string, Array<{ tile: string; pts: number[] }>>();
      type WalkSeg = { x1: number; y1: number; x2: number; y2: number; r: number; tile: string };
      const walkHash = new Map<string, WalkSeg[]>();
      const parkHash = new Map<string, Array<{ tile: string; pts: number[] }>>();

      /** A way that straddles two tiles is drawn by whichever tile got here first. */
      const owned = new Map<number, string>();

      type LoadedTile = {
        key: string;
        cx: number;
        cy: number;
        gfx: any[];
        blocks: Block[];
        signs: number[];
        ids: number[];
        cells: { block: Set<string>; solid: Set<string>; walk: Set<string>; park: Set<string> };
      };
      const loaded = new Map<string, LoadedTile>();
      /** Everything ever fetched, so walking back never fetches twice. */
      const tileStore = new Map<string, TileData>();

      const bucket = <T,>(hash: Map<string, T[]>, key: string, value: T, cells: Set<string>) => {
        const list = hash.get(key) ?? [];
        list.push(value);
        hash.set(key, list);
        cells.add(key);
      };
      const footprint = (pts: number[]) => {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < pts.length; i += 2) {
          minX = Math.min(minX, pts[i]);
          maxX = Math.max(maxX, pts[i]);
          minY = Math.min(minY, pts[i + 1]);
          maxY = Math.max(maxY, pts[i + 1]);
        }
        return { minX, minY, maxX, maxY, area: (maxX - minX) * (maxY - minY) };
      };
      const centroid = (pts: number[]) => {
        let sx = 0;
        let sy = 0;
        const n = pts.length / 2;
        for (let i = 0; i < pts.length; i += 2) { sx += pts[i]; sy += pts[i + 1]; }
        return { x: sx / n, y: sy / n };
      };

      /**
       * Full colour up close, a pale haze far off, so the eye finds "here".
       * Tint can only darken, so the paleness comes from letting the ground
       * show through; a touch of cool tint keeps it from looking merely faint.
       */
      const hazeAmount = (d: number) => Math.max(0, Math.min(1, (d - FOCUS_NEAR) / (FOCUS_FAR - FOCUS_NEAR)));
      const hazeTint = (t: number) => {
        const r = Math.round(255 + (HAZE_TINT.r - 255) * t);
        const g = Math.round(255 + (HAZE_TINT.g - 255) * t);
        const b = Math.round(255 + (HAZE_TINT.b - 255) * t);
        return (r << 16) | (g << 8) | b;
      };
      const applyHaze = (block: Block, d: number) => {
        const t = hazeAmount(d);
        block.haze = 1 - 0.55 * t;
        block.gfx.tint = hazeTint(t * 0.5);
        if (!block.faded) block.gfx.alpha = block.haze;
      };
      let sinceFocus = 999;
      const updateFocus = (dt: number) => {
        sinceFocus += dt;
        if (sinceFocus < 0.12) return;
        sinceFocus = 0;
        const { x, y } = playerRef.current;
        for (const tile of loaded.values()) {
          for (const block of tile.blocks) applyHaze(block, Math.hypot(block.wx - x, block.wy - y));
        }
      };

      const addTile = (data: TileData) => {
        const key = tileKey(data.cx, data.cy);
        if (loaded.has(key)) return;
        const tile: LoadedTile = {
          key, cx: data.cx, cy: data.cy, gfx: [], blocks: [], signs: [], ids: [],
          cells: { block: new Set(), solid: new Set(), walk: new Set(), park: new Set() },
        };
        const random = rng(data.cx * 7919 + data.cy * 104729 + 17);
        const claim = (way: Way) => {
          if (way.id === undefined) return true;
          const by = owned.get(way.id);
          if (by && by !== key && loaded.has(by)) return false;
          owned.set(way.id, key);
          tile.ids.push(way.id);
          return true;
        };
        const roads = data.roads.filter(claim);
        const buildings = data.buildings.filter(claim);
        const parks = data.parks.filter(claim);
        const water = data.water.filter(claim);
        const keep = (g: any, layer: any) => {
          g.cullable = true;
          layer.addChild(g);
          tile.gfx.push(g);
          return g;
        };

        // ---- ground --------------------------------------------------------
        if (parks.length + water.length > 0) {
          const ground = new Graphics();
          parks.forEach((way) => {
            const poly = polyToIso(way.pts);
            if (poly.length >= 6) {
              ground.poly(poly).fill({ color: PARK }).stroke({ width: 1.5, color: shade(PARK, 0.78), alpha: 0.8 });
            }
          });
          water.forEach((way) => {
            const poly = polyToIso(way.pts);
            if (poly.length >= 6) {
              ground.poly(poly).fill({ color: WATER }).stroke({ width: 2.5, color: shade(WATER, 0.75) });
            }
          });
          keep(ground, groundLayer);
        }

        // ---- streets -------------------------------------------------------
        const roadCasing = new Graphics();
        const roadFill = new Graphics();
        const segments: NamedSeg[] = [];
        roads.forEach((way) => {
          const style = ROAD_STYLE[way.kind] ?? ROAD_STYLE.residential;
          const path = polyToIso(way.pts);
          if (path.length < 4) return;

          for (let i = 2; i < way.pts.length; i += 2) {
            if (!way.name) break;
            segments.push({
              x1: way.pts[i - 2], y1: way.pts[i - 1],
              x2: way.pts[i], y2: way.pts[i + 1],
              name: way.name,
            });
          }

          for (const [g, extra, color] of [
            [roadCasing, 3, ROAD_EDGE],
            [roadFill, 0, ROAD_FILL],
          ] as const) {
            g.moveTo(path[0], path[1]);
            for (let i = 2; i < path.length; i += 2) g.lineTo(path[i], path[i + 1]);
            g.stroke({ width: style.width + extra, color, cap: "round", join: "round" });
          }

          // dashed centre line down anything you would drive on
          if (MAJOR_ROADS.has(way.kind)) {
            for (let i = 0; i < path.length - 2; i += 2) {
              const ax = path[i];
              const ay = path[i + 1];
              const bx = path[i + 2];
              const by = path[i + 3];
              const len = Math.hypot(bx - ax, by - ay);
              const dashes = Math.floor(len / 14);
              for (let d = 0; d < dashes; d++) {
                const t0 = (d + 0.25) / dashes;
                const t1 = (d + 0.7) / dashes;
                roadFill
                  .moveTo(ax + (bx - ax) * t0, ay + (by - ay) * t0)
                  .lineTo(ax + (bx - ax) * t1, ay + (by - ay) * t1)
                  .stroke({ width: 1, color: 0xe8e0cd, alpha: 0.5 });
              }
            }
          }
        });
        keep(roadCasing, casingLayer);
        keep(roadFill, fillLayer);
        segmentsByTile.set(key, segments);
        roadsByTile.set(key, roads);

        // ---- pavements -----------------------------------------------------
        // A kerb around every block is what turns "gaps between shapes" into streets.
        const pavement = new Graphics();
        buildings.forEach((way) => {
          const poly = polyToIso(way.pts);
          if (poly.length >= 6) pavement.poly(poly).stroke({ width: 7, color: PAVEMENT, join: "round" });
        });
        keep(pavement, pavementLayer);

        // ---- buildings, with their shadows ---------------------------------
        // Sun sits high to the north-west, so every shadow falls down and right.
        const shadows = new Graphics();
        const ordered = buildings
          .map((way) => { const c = centroid(way.pts); return { way, depth: c.x + c.y, wx: c.x, wy: c.y }; })
          .sort((a, b) => a.depth - b.depth);

        ordered.forEach(({ way, depth, wx, wy }, index) => {
          // Most cities barely tag height, so guess a believable skyline instead of
          // a flat carpet: what a building is FOR predicts how tall it stands.
          const TALL = { office: 7, commercial: 5, hotel: 6, apartments: 4, retail: 2, hospital: 5, university: 4 } as Record<string, number>;
          const salt = (way.id ?? index) % 5;
          const guessedLevels = 2 + (TALL[way.kind] ?? 0) + salt;
          const metres = way.height ?? (way.levels ?? guessedLevels) * 3.3;
          const h = Math.max(9, metres) * PX_PER_M * boostFor(way.kind);
          const levels = Math.max(1, Math.min(12, way.levels ?? Math.round(metres / 3.2)));
          const base = polyToIso(way.pts);
          if (base.length < 6) return;

          // its own object, so it can fade when it stands between you and the camera
          const blocks = new Graphics();

          const points: Array<{ x: number; y: number }> = [];
          for (let i = 0; i < base.length; i += 2) points.push({ x: base[i], y: base[i + 1] });

          // ground shadow: the footprint, pushed away from the sun
          const offX = h * 0.5;
          const offY = h * 0.26;
          shadows
            .poly(base.map((v, i) => (i % 2 === 0 ? v + offX : v + offY)))
            .fill({ color: SHADOW, alpha: 0.3 });

          const tint = 0.92 + (((way.id ?? index) % 9) * 0.022);
          const roofColour = shade(roofFor(way.kind, (way.id ?? index) % 97), tint);
          const body = shade(WALL, tint);

          // walls, far ones first so near ones paint over them
          const walls: Array<{ a: { x: number; y: number }; b: { x: number; y: number }; depth: number }> = [];
          for (let i = 0; i < points.length; i++) {
            const a = points[i];
            const b = points[(i + 1) % points.length];
            walls.push({ a, b, depth: a.y + b.y });
          }
          walls.sort((p, q) => p.depth - q.depth);

          walls.forEach(({ a, b }) => {
            // faces turned toward the lower right catch the light
            const lit = b.x - a.x > 0;
            const face = shade(body, lit ? 1.0 : 0.8);
            blocks.poly([a.x, a.y, b.x, b.y, b.x, b.y - h, a.x, a.y - h]).fill({ color: face });

            const span = Math.hypot(b.x - a.x, b.y - a.y);

            // A grid of storey lines and bay lines reads as windows at this size,
            // for a fraction of the cost of drawing every pane.
            if (h > 12 && span > 10) {
              const mullion = shade(roofColour, 0.85);
              const storey = h / Math.max(1, levels);
              for (let f = 1; f < levels; f++) {
                const dy = storey * f;
                blocks
                  .moveTo(a.x, a.y - dy)
                  .lineTo(b.x, b.y - dy)
                  .stroke({ width: 1, color: mullion, alpha: 0.8 });
              }
              const bays = Math.min(9, Math.max(1, Math.round(span / 13)));
              for (let v = 1; v < bays; v++) {
                const t = v / bays;
                const px = a.x + (b.x - a.x) * t;
                const py = a.y + (b.y - a.y) * t;
                blocks
                  .moveTo(px, py)
                  .lineTo(px, py - h)
                  .stroke({ width: 1, color: mullion, alpha: 0.55 });
              }
            }

            // ambient shade where the wall meets the ground, then a crisp outline
            blocks
              .poly([a.x, a.y, b.x, b.y, b.x, b.y - 5, a.x, a.y - 5])
              .fill({ color: SHADOW, alpha: 0.16 });
            blocks.moveTo(a.x, a.y).lineTo(b.x, b.y)
              .stroke({ width: 1, color: 0x5b6570, alpha: 0.5 });
          });

          // lit ground floor for anything that trades at street level
          if (SHOPFRONTS.has(way.kind) && h > 12) {
            const bandTop = Math.min(h, 9);
            walls.forEach(({ a, b }) => {
              if (b.x - a.x <= 0) return; // only the faces you can see into
              blocks
                .poly([a.x, a.y, b.x, b.y, b.x, b.y - bandTop, a.x, a.y - bandTop])
                .fill({ color: 0x4a3a2c, alpha: 0.85 });
              const steps = Math.max(1, Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / 12));
              for (let w = 0; w < steps; w++) {
                const t0 = (w + 0.25) / steps;
                const t1 = (w + 0.75) / steps;
                const p0 = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 };
                const p1 = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
                blocks
                  .poly([p0.x, p0.y - 2, p1.x, p1.y - 2, p1.x, p1.y - bandTop + 2, p0.x, p0.y - bandTop + 2])
                  .fill({ color: 0xffd99a, alpha: 0.75 });
              }
            });
          }

          // roof, with a parapet edge
          const roof = base.map((v, i) => (i % 2 === 0 ? v : v - h));
          // the roof is the only saturated surface, which is what makes it pop
          blocks
            .poly(roof)
            .fill({ color: roofColour })
            .stroke({ width: 1.5, color: shade(roofColour, 0.62), alpha: 1 });

          blocks.zIndex = depth;
          keep(blocks, blockLayer);

          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          points.forEach((pt) => {
            minX = Math.min(minX, pt.x);
            maxX = Math.max(maxX, pt.x);
            minY = Math.min(minY, pt.y - h);
            maxY = Math.max(maxY, pt.y);
          });

          const block: Block = { gfx: blocks, wx, wy, depth, minX, maxX, minY, maxY, faded: false, haze: 1, tile: key };
          applyHaze(block, Math.hypot(wx - playerRef.current.x, wy - playerRef.current.y));
          tile.blocks.push(block);

          // bucket it in world metres so the fade test only looks at what is close
          const fp = footprint(way.pts);
          for (let cx = Math.floor(fp.minX / FADE_RADIUS); cx <= Math.floor(fp.maxX / FADE_RADIUS); cx++) {
            for (let cy = Math.floor(fp.minY / FADE_RADIUS); cy <= Math.floor(fp.maxY / FADE_RADIUS); cy++) {
              bucket(blockHash, `${cx},${cy}`, block, tile.cells.block);
            }
          }
          // and for collision
          for (let cx = Math.floor(fp.minX / COLLIDE_CELL); cx <= Math.floor(fp.maxX / COLLIDE_CELL); cx++) {
            for (let cy = Math.floor(fp.minY / COLLIDE_CELL); cy <= Math.floor(fp.maxY / COLLIDE_CELL); cy++) {
              bucket(solids, `${cx},${cy}`, { tile: key, pts: way.pts }, tile.cells.solid);
            }
          }
        });
        keep(shadows, shadowLayer);

        // ---- trees ---------------------------------------------------------
        // OSM's own trees, plus a deterministic scatter to fill out parks.
        const foliage = new Graphics();
        const spots: Array<{ x: number; y: number; size: number }> = [];
        data.trees.forEach((t: Dot) => spots.push({ x: t.x, y: t.y, size: 1 + random() * 0.4 }));
        parks.forEach((park) => {
          const fp = footprint(park.pts);
          const wanted = Math.min(90, Math.floor(Math.max(0, fp.area) / 900));
          for (let n = 0, tries = 0; n < wanted && tries < wanted * 6; tries++) {
            const x = fp.minX + random() * (fp.maxX - fp.minX);
            const y = fp.minY + random() * (fp.maxY - fp.minY);
            if (!insidePoly(park.pts, x, y)) continue;
            spots.push({ x, y, size: 0.9 + random() * 0.5 });
            n++;
          }
        });
        spots
          .sort((a, b) => a.x + a.y - (b.x + b.y))
          .slice(0, 600)
          .forEach((spot) => {
            const p = iso(spot.x, spot.y);
            const sz = spot.size;
            foliage.ellipse(p.x + 3, p.y + 1, 6 * sz, 3 * sz).fill({ color: SHADOW, alpha: 0.22 });
            foliage.rect(p.x - 1, p.y - 7 * sz, 2, 7 * sz).fill({ color: 0x6b5335 });
            foliage.circle(p.x, p.y - 10 * sz, 6 * sz).fill({ color: 0x4f7f3c });
            foliage.circle(p.x - 3 * sz, p.y - 8 * sz, 4.5 * sz).fill({ color: 0x5f9247 });
            foliage.circle(p.x + 2 * sz, p.y - 12 * sz, 4 * sz).fill({ color: 0x74a856 });
          });
        keep(foliage, foliageLayer);

        // ---- street lamps --------------------------------------------------
        // Verticals along the kerb give the street a rhythm and a sense of height.
        const lamps = new Graphics();
        roads.forEach((way, wayIndex) => {
          if (!MAJOR_ROADS.has(way.kind) || wayIndex % 2 === 1) return;
          for (let i = 0; i < way.pts.length - 2; i += 2) {
            const ax = way.pts[i];
            const ay = way.pts[i + 1];
            const bx = way.pts[i + 2];
            const by = way.pts[i + 3];
            const len = Math.hypot(bx - ax, by - ay);
            const count = Math.floor(len / 55);
            for (let n = 0; n < count; n++) {
              const t = (n + 0.5) / count;
              // step off the carriageway onto the kerb
              const nx = -(by - ay) / (len || 1);
              const ny = (bx - ax) / (len || 1);
              const p = iso(ax + (bx - ax) * t + nx * 7, ay + (by - ay) * t + ny * 7);
              lamps.ellipse(p.x + 2, p.y + 1, 4, 2).fill({ color: SHADOW, alpha: 0.2 });
              lamps.rect(p.x - 1, p.y - 22, 2, 22).fill({ color: 0x4c4740 });
              lamps.rect(p.x - 1, p.y - 24, 7, 2).fill({ color: 0x4c4740 });
              lamps.circle(p.x + 6, p.y - 22, 2.5).fill({ color: 0xffe9b0 });
            }
          }
        });
        keep(lamps, lampLayer);

        // ---- traffic and pedestrians ----------------------------------------
        // Nothing makes a city feel dead like an empty one.
        const driveable = roads.filter((w) => MAJOR_ROADS.has(w.kind) && w.pts.length >= 6);
        const strollable = roads.filter((w) => w.pts.length >= 6);
        for (let i = 0; i < Math.min(2, driveable.length); i++) {
          const way = driveable[Math.floor(random() * driveable.length)];
          movers.push({
            pts: way.pts,
            seg: Math.floor(random() * (way.pts.length / 2 - 1)),
            t: random(),
            speed: 9 + random() * 7,
            dir: random() > 0.5 ? 1 : -1,
            car: true,
            tone: Math.floor(random() * 6),
            tile: key,
          });
        }
        for (let i = 0; i < Math.min(4, strollable.length); i++) {
          const way = strollable[Math.floor(random() * strollable.length)];
          movers.push({
            pts: way.pts,
            seg: Math.floor(random() * (way.pts.length / 2 - 1)),
            t: random(),
            speed: 1.3 + random() * 1.1,
            dir: random() > 0.5 ? 1 : -1,
            car: false,
            tone: Math.floor(random() * 6),
            tile: key,
          });
        }

        // ---- names, for the "where am I" readout -----------------------------
        const places: Array<{ name: string; x: number; y: number }> = [];
        const noteName = (way: Way) => { if (way.name) places.push({ name: way.name, ...centroid(way.pts) }); };
        buildings.forEach(noteName);
        parks.forEach(noteName);
        water.forEach(noteName);
        placesByTile.set(key, places);

        // ---- signage ---------------------------------------------------------
        const sign = (spec: Omit<SignSpec, "tile">) => {
          const id = nextSign++;
          signSpecs.set(id, { ...spec, tile: key });
          tile.signs.push(id);
        };
        roads.forEach((way) => {
          if (!way.name || way.pts.length < 4) return;
          let best = { i: 0, len: 0 };
          for (let i = 0; i < way.pts.length - 2; i += 2) {
            const len = Math.hypot(way.pts[i + 2] - way.pts[i], way.pts[i + 3] - way.pts[i + 1]);
            if (len > best.len) best = { i, len };
          }
          if (best.len < 22) return;
          const mid = {
            x: (way.pts[best.i] + way.pts[best.i + 2]) / 2,
            y: (way.pts[best.i + 1] + way.pts[best.i + 3]) / 2,
          };
          const placed = placedNames.get(way.name) ?? [];
          if (placed.some((p) => Math.hypot(p.x - mid.x, p.y - mid.y) < 260)) return;
          placed.push({ ...mid, tile: key });
          placedNames.set(way.name, placed);
          sign({
            wx: mid.x, wy: mid.y, text: way.name.toUpperCase(), ink: 0xf3e6d2, board: 0x39424c,
            lift: 10, leader: false, minor: !MAJOR_ROADS.has(way.kind),
          });
        });
        const landmark = (pts: number[], name: string, board: number) => {
          const c = centroid(pts);
          sign({
            wx: c.x, wy: c.y,
            text: (name.length > 30 ? `${name.slice(0, 28)}…` : name).toUpperCase(),
            ink: 0xfff3df, board, lift: 40, leader: true, minor: false,
          });
        };
        water.forEach((w) => { if (w.name) landmark(w.pts, w.name, 0x2f5a7a); });
        parks.forEach((w) => { if (w.name) landmark(w.pts, w.name, 0x3a5c30); });
        // biggest named buildings only — a city has hundreds, a skyline has a few
        buildings
          .filter((w) => w.name)
          .sort((a, b) => footprint(b.pts).area - footprint(a.pts).area)
          .slice(0, 24)
          .forEach((w) => landmark(w.pts, w.name as string, 0x6b3f2a));

        // ---- where you may stand: roads, footways, and the inside of parks ---
        roads.forEach((way) => {
          const rw = WALK_WIDTH[way.kind] ?? DEFAULT_WALK_WIDTH;
          for (let i = 0; i < way.pts.length - 2; i += 2) {
            const seg: WalkSeg = { x1: way.pts[i], y1: way.pts[i + 1], x2: way.pts[i + 2], y2: way.pts[i + 3], r: rw, tile: key };
            const minX = Math.min(seg.x1, seg.x2) - rw;
            const maxX = Math.max(seg.x1, seg.x2) + rw;
            const minY = Math.min(seg.y1, seg.y2) - rw;
            const maxY = Math.max(seg.y1, seg.y2) + rw;
            for (let cx = Math.floor(minX / WALK_CELL); cx <= Math.floor(maxX / WALK_CELL); cx++) {
              for (let cy = Math.floor(minY / WALK_CELL); cy <= Math.floor(maxY / WALK_CELL); cy++) {
                bucket(walkHash, `${cx},${cy}`, seg, tile.cells.walk);
              }
            }
          }
        });
        parks.forEach((park) => {
          const fp = footprint(park.pts);
          for (let cx = Math.floor(fp.minX / WALK_CELL); cx <= Math.floor(fp.maxX / WALK_CELL); cx++) {
            for (let cy = Math.floor(fp.minY / WALK_CELL); cy <= Math.floor(fp.maxY / WALK_CELL); cy++) {
              bucket(parkHash, `${cx},${cy}`, { tile: key, pts: park.pts }, tile.cells.park);
            }
          }
        });

        loaded.set(key, tile);
      };

      const unbucket = <T extends { tile: string }>(hash: Map<string, T[]>, cells: Set<string>, key: string) => {
        for (const cell of cells) {
          const list = hash.get(cell);
          if (!list) continue;
          const kept = list.filter((entry) => entry.tile !== key);
          if (kept.length > 0) hash.set(cell, kept); else hash.delete(cell);
        }
      };

      const removeTile = (key: string) => {
        const tile = loaded.get(key);
        if (!tile) return;
        loaded.delete(key);
        for (const g of tile.gfx) {
          g.parent?.removeChild(g);
          g.destroy({ children: true });
        }
        unbucket(blockHash, tile.cells.block, key);
        unbucket(solids, tile.cells.solid, key);
        unbucket(walkHash, tile.cells.walk, key);
        unbucket(parkHash, tile.cells.park, key);
        segmentsByTile.delete(key);
        placesByTile.delete(key);
        roadsByTile.delete(key);
        for (let i = movers.length - 1; i >= 0; i--) if (movers[i].tile === key) movers.splice(i, 1);
        for (const id of tile.signs) {
          signSpecs.delete(id);
          const node = signNodes.get(id);
          if (node) { labelLayer.removeChild(node); node.destroy({ children: true }); signNodes.delete(id); }
        }
        placedNames.forEach((list, name) => {
          const kept = list.filter((p) => p.tile !== key);
          if (kept.length > 0) placedNames.set(name, kept); else placedNames.delete(name);
        });
        for (const id of tile.ids) if (owned.get(id) === key) owned.delete(id);
        for (let i = fadedNow.length - 1; i >= 0; i--) if (fadedNow[i].tile === key) fadedNow.splice(i, 1);
      };
      /** Blocks currently ghosted, so they can be restored next frame. */
      const fadedNow: Block[] = [];

      const stepMovers = (dt: number) => {
        traffic.clear();
        for (const m of movers) {
          const i = m.seg * 2;
          const ax = m.pts[i];
          const ay = m.pts[i + 1];
          const bx = m.pts[i + 2];
          const by = m.pts[i + 3];
          const len = Math.hypot(bx - ax, by - ay) || 1;

          m.t += (m.dir * m.speed * dt) / len;
          if (m.t > 1 || m.t < 0) {
            m.seg += m.dir;
            const last = m.pts.length / 2 - 2;
            if (m.seg > last || m.seg < 0) {
              m.dir *= -1;
              m.seg = Math.max(0, Math.min(last, m.seg));
            }
            m.t = m.dir > 0 ? 0 : 1;
            continue;
          }

          const wx = ax + (bx - ax) * m.t;
          const wy = ay + (by - ay) * m.t;
          // walk on the kerb side, drive down the middle
          const offset = m.car ? 0 : 6 * m.dir;
          const nx = -(by - ay) / len;
          const ny = (bx - ax) / len;
          const p = iso(wx + nx * offset, wy + ny * offset);

          // Drawn at something like human scale next to the houses: a person is
          // not as tall as a building, and a city of giants is not a city.
          if (m.car) {
            const c = 0.7;
            traffic.ellipse(p.x + 2 * c, p.y + 1, 7 * c, 3.5 * c).fill({ color: SHADOW, alpha: 0.3 });
            traffic.rect(p.x - 6 * c, p.y - 8 * c, 12 * c, 8 * c).fill({ color: CAR_TONES[m.tone] });
            traffic.rect(p.x - 6 * c, p.y - 11 * c, 12 * c, 3 * c).fill({ color: 0xd8e6f2 });
            traffic.rect(p.x - 6 * c, p.y - 8 * c, 12 * c, 1).fill({ color: 0x2b3440, alpha: 0.4 });
          } else {
            const w = 0.55;
            const coat = COAT_TONES[m.tone];
            traffic.ellipse(p.x + 1, p.y, 4 * w, 2 * w).fill({ color: SHADOW, alpha: 0.3 });
            traffic.rect(p.x - 2 * w, p.y - 5 * w, 4 * w, 5 * w).fill({ color: 0x3c4450 });
            traffic.rect(p.x - 3 * w, p.y - 12 * w, 6 * w, 7 * w).fill({ color: coat });
            traffic.circle(p.x, p.y - 14.5 * w, 3 * w).fill({ color: 0xf1cfa8 });
            traffic.rect(p.x - 3 * w, p.y - 16.5 * w, 6 * w, 2 * w).fill({ color: shade(coat, 0.7) });
          }
        }
      };

      // ---- streaming -------------------------------------------------------
      // The first payload is already split by tile; everything beyond it is
      // asked for as the player gets close, and dropped again once far away.
      const clampCore = (i: number) => Math.max(-3, Math.min(2, i));
      (() => {
        const at = (x: number, y: number) => {
          const cx = clampCore(tileIndex(x));
          const cy = clampCore(tileIndex(y));
          const k = tileKey(cx, cy);
          let t = tileStore.get(k);
          if (!t) { t = { cx, cy, roads: [], buildings: [], water: [], parks: [], trees: [] }; tileStore.set(k, t); }
          return t;
        };
        city.roads.forEach((w) => at(w.pts[0], w.pts[1]).roads.push(w));
        city.buildings.forEach((w) => at(w.pts[0], w.pts[1]).buildings.push(w));
        city.water.forEach((w) => at(w.pts[0], w.pts[1]).water.push(w));
        city.parks.forEach((w) => at(w.pts[0], w.pts[1]).parks.push(w));
        city.trees.forEach((t) => at(t.x, t.y).trees.push(t));
        // the core covers these tiles even where they turned out empty
        for (let cx = -3; cx <= 2; cx++) {
          for (let cy = -3; cy <= 2; cy++) at(cx * TILE_M + 1, cy * TILE_M + 1);
        }
      })();

      const inFlight = new Set<string>();
      const retryAt = new Map<string, number>();
      const edgeDistance = (cx: number, cy: number, x: number, y: number) => {
        const x0 = cx * TILE_M;
        const y0 = cy * TILE_M;
        const dx = Math.max(x0 - x, 0, x - (x0 + TILE_M));
        const dy = Math.max(y0 - y, 0, y - (y0 + TILE_M));
        return Math.hypot(dx, dy);
      };

      const stream = () => {
        const { x, y } = playerRef.current;
        for (const [key, tile] of loaded) {
          if (edgeDistance(tile.cx, tile.cy, x, y) > UNLOAD_RANGE) removeTile(key);
        }
        const span = Math.ceil(LOAD_RANGE / TILE_M) + 1;
        const c = tileIndex(x);
        const d = tileIndex(y);
        const want: Array<{ cx: number; cy: number; dist: number }> = [];
        for (let cx = c - span; cx <= c + span; cx++) {
          for (let cy = d - span; cy <= d + span; cy++) {
            if (Math.abs(cx) > MAX_TILE_INDEX || Math.abs(cy) > MAX_TILE_INDEX) continue;
            const dist = edgeDistance(cx, cy, x, y);
            if (dist <= LOAD_RANGE) want.push({ cx, cy, dist });
          }
        }
        want.sort((a, b) => a.dist - b.dist);
        for (const w of want) {
          const key = tileKey(w.cx, w.cy);
          if (loaded.has(key) || inFlight.has(key)) continue;
          const known = tileStore.get(key);
          if (known) { addTile(known); continue; }
          if ((retryAt.get(key) ?? 0) > Date.now()) continue;
          const fetchTile = loadTileRef.current;
          if (!fetchTile || inFlight.size >= MAX_IN_FLIGHT) break;
          inFlight.add(key);
          fetchTile(w.cx, w.cy)
            .then((data) => {
              if (!data) { retryAt.set(key, Date.now() + 20_000); return; }
              tileStore.set(key, data);
              if (mounted && edgeDistance(w.cx, w.cy, playerRef.current.x, playerRef.current.y) <= UNLOAD_RANGE) addTile(data);
            })
            .catch(() => retryAt.set(key, Date.now() + 20_000))
            .finally(() => inFlight.delete(key));
        }
      };

      // ---- witnesses -------------------------------------------------------
      const castLayer = new Container();
      world.addChild(castLayer);

      type Stroller = {
        x: number; y: number; homeX: number; homeY: number;
        dx: number; dy: number; phase: number; node: any;
      };
      const strollers = new Map<string, Stroller>();

      const drawCast = () => {
        castLayer.removeChildren().forEach((child: any) => child.destroy?.({ children: true }));
        strollers.clear();
        witnessesRef.current.forEach((w, index) => {
          const p = iso(w.x, w.y);
          const node = new Container();
          const coat = COAT_TONES[index % COAT_TONES.length];

          node.addChild(
            new Graphics()
              .ellipse(0, 3, 17, 8)
              .stroke({
                width: w.locked ? 2 : 3,
                color: w.spoken ? 0x6fbf8b : w.locked ? 0x8fabc4 : 0xffc65c,
                alpha: w.locked ? 0.45 : 0.95,
              }),
          );
          node.addChild(new Graphics().ellipse(2, 2, 9, 4).fill({ color: SHADOW, alpha: 0.35 }));
          node.addChild(
            new Graphics()
              .rect(-4, -9, 8, 9).fill({ color: 0x3c4450 })
              .rect(-6, -23, 12, 14).fill({ color: coat })
              .rect(-6, -23, 12, 1.5).fill({ color: 0x000000, alpha: 0.2 })
              .circle(0, -27.5, 5.5).fill({ color: 0xf1cfa8 }),
          );

          const tag = new Text({
            text: w.name.toUpperCase(),
            style: {
              fill: w.spoken ? 0x9fe0b6 : w.locked ? 0x9fb4c8 : 0xffe3a8,
              fontSize: 11,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontWeight: "700",
              stroke: { color: 0x1b222b, width: 4, join: "round" },
            },
          });
          tag.anchor.set(0.5, 1);
          tag.y = -36;
          node.addChild(tag);

          node.alpha = w.locked ? 0.6 : 1;
          node.scale.set(0.7);
          node.x = p.x;
          node.y = p.y;
          node.zIndex = p.y;
          castLayer.addChild(node);

          const angle = (index / Math.max(1, witnessesRef.current.length)) * Math.PI * 2;
          strollers.set(w.id, {
            x: w.x, y: w.y, homeX: w.x, homeY: w.y,
            dx: Math.cos(angle), dy: Math.sin(angle),
            phase: index, node,
          });
        });
      };
      castDrawRef.current = drawCast;
      drawCast();

      // ---- memories left here ----------------------------------------------
      // A soft heart on a post. Deliberately unlike the witness rings: these
      // are not part of the case, they are what other people left behind.
      const pinLayer = new Container();
      world.addChild(pinLayer);

      const drawPins = () => {
        pinLayer.removeChildren().forEach((child: any) => child.destroy?.({ children: true }));
        memoriesRef.current.forEach((m) => {
          const p = iso(m.x, m.y);
          const node = new Container();

          // A ring on the ground so it can be spotted from down the street.
          node.addChild(
            new Graphics()
              .ellipse(0, 2, 14, 6.5)
              .stroke({ width: 2, color: 0xe98bb4, alpha: 0.7 }),
          );
          node.addChild(new Graphics().ellipse(2, 2, 7, 3).fill({ color: SHADOW, alpha: 0.3 }));

          // Tall enough to clear the player's head — a memory is usually left
          // exactly where you are standing, so a short post is invisible.
          node.addChild(new Graphics().rect(-1.5, -48, 3, 48).fill({ color: 0x8a6476 }));

          const heart = new Graphics();
          if (m.photo) {
            // a polaroid on the post: white card, a pale picture, a small heart
            heart
              .roundRect(-13, -72, 26, 31, 1.5).fill({ color: 0xfffdf8 })
              .rect(-11, -70, 22, 20).fill({ color: 0xb9c8d6 })
              .rect(-11, -62, 22, 12).fill({ color: 0x8fb08a })
              .circle(-2.6, -46.5, 2.4).fill({ color: 0xe98bb4 })
              .circle(2.6, -46.5, 2.4).fill({ color: 0xe98bb4 })
              .poly([-5, -45.8, 5, -45.8, 0, -41.5]).fill({ color: 0xe98bb4 });
            heart.stroke({ width: 1, color: 0x8a6476, alpha: 0.5 });
            heart.rotation = -0.06;
          } else {
            heart
              .circle(-4.4, -56, 5).fill({ color: 0xe98bb4 })
              .circle(4.4, -56, 5).fill({ color: 0xe98bb4 })
              .poly([-9, -54.5, 9, -54.5, 0, -42]).fill({ color: 0xe98bb4 })
              .circle(-5.6, -57.8, 1.7).fill({ color: 0xffd4e6 });
            heart.stroke({ width: 1.5, color: 0x7d3f5c, alpha: 0.6 });
          }
          node.addChild(heart);

          node.x = p.x;
          node.y = p.y;
          node.zIndex = p.y;
          pinLayer.addChild(node);
        });
      };

      pinsDrawRef.current = drawPins;
      drawPins();

      // ---- other people ----------------------------------------------------
      // Drawn a little softer than you are, so the city reads as shared without
      // anyone being mistaken for a witness.
      const crowd = new Container();
      world.addChild(crowd);

      /**
       * Where each person is being drawn, as opposed to where they last told us
       * they were. Positions arrive every few seconds; without easing between
       * them everyone teleports.
       */
      const shown = new Map<string, { x: number; y: number; node: any }>();

      const drawOthers = () => {
        const seen = new Set(othersRef.current.map((p) => p.uid));
        shown.forEach((entry, uid) => {
          if (seen.has(uid)) return;
          crowd.removeChild(entry.node);
          entry.node.destroy?.({ children: true });
          shown.delete(uid);
        });

        othersRef.current.forEach((p) => {
          const existing = shown.get(p.uid);
          if (existing) return; // its position is eased in the loop

          const at = iso(p.x, p.y);
          const node = new Container();

          node.addChild(new Graphics().ellipse(2, 2, 9, 4).fill({ color: SHADOW, alpha: 0.28 }));
          node.addChild(
            new Graphics()
              .rect(-4, -9, 8, 9).fill({ color: 0x3c4450 })
              .rect(-6, -23, 12, 14).fill({ color: p.coat })
              .rect(-6, -23, 12, 1.5).fill({ color: 0x000000, alpha: 0.2 })
              .circle(0, -27.5, 5.5).fill({ color: 0xf1cfa8 }),
          );

          const tag = new Text({
            text: (p.name || "someone").toUpperCase(),
            style: {
              fill: 0x4a3f52,
              fontSize: 10,
              fontFamily: "ui-sans-serif, system-ui, sans-serif",
              fontWeight: "600",
              stroke: { color: 0xfdf8ee, width: 4, join: "round" },
            },
          });
          tag.anchor.set(0.5, 1);
          tag.y = -34;
          node.addChild(tag);

          node.alpha = 0.9;
          node.scale.set(0.7);
          node.x = at.x;
          node.y = at.y;
          node.zIndex = at.y;
          crowd.addChild(node);
          shown.set(p.uid, { x: p.x, y: p.y, node });
        });
      };
      othersDrawRef.current = drawOthers;
      drawOthers();

      // ---- round markers ---------------------------------------------------
      const markers = new Graphics();
      world.addChild(markers);

      const revealTag = new Container();
      world.addChild(revealTag);

      const drawMarkers = () => {
        markers.clear();
        revealTag.removeChildren().forEach((c: any) => c.destroy?.({ children: true }));
        const g = guessRef.current;
        if (g) {
          const p = iso(g.x, g.y);
          markers.circle(p.x, p.y, 7).stroke({ width: 3, color: 0x2f6fd0, alpha: 0.9 });
          markers.moveTo(p.x, p.y).lineTo(p.x, p.y - 34).stroke({ width: 2, color: 0x2f6fd0, alpha: 0.8 });
        }
        const rv = revealRef.current;
        if (rv) {
          const p = iso(rv.x, rv.y);
          markers.circle(p.x, p.y, 14).stroke({ width: 3, color: 0xe8a33d });
          markers.circle(p.x, p.y, 26).stroke({ width: 2, color: 0xe8a33d, alpha: 0.4 });
          markers.moveTo(p.x, p.y).lineTo(p.x, p.y - 96).stroke({ width: 3, color: 0xe8a33d });
          markers.poly([p.x, p.y - 96, p.x + 11, p.y - 87, p.x, p.y - 78]).fill({ color: 0xe8a33d });
          if (g) {
            const q = iso(g.x, g.y);
            markers.moveTo(q.x, q.y).lineTo(p.x, p.y)
              .stroke({ width: 2, color: 0x1f2a36, alpha: 0.5 });

            // how far out you were, written on the line itself
            const metres = Math.hypot(rv.x - g.x, rv.y - g.y);
            const gap = new Text({
              text: metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(2)} km`,
              style: {
                fill: 0x1f2a36,
                fontSize: 13,
                fontFamily: "ui-sans-serif, system-ui, sans-serif",
                fontWeight: "700",
                stroke: { color: 0xf7f6ee, width: 4, join: "round" },
              },
            });
            gap.anchor.set(0.5);
            gap.x = (p.x + q.x) / 2;
            gap.y = (p.y + q.y) / 2 - 10;
            revealTag.addChild(gap);
          }

          // the answer, named
          const label = new Text({
            text: (revealTitleRef.current ?? "It happened here").toUpperCase(),
            style: {
              fill: 0x3a2a12,
              fontSize: 13,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontWeight: "700",
              letterSpacing: 0.6,
              stroke: { color: 0xffd88a, width: 5, join: "round" },
            },
          });
          label.anchor.set(0.5, 1);
          label.x = p.x;
          label.y = p.y - 104;
          revealTag.addChild(label);
        }
      };

      // ---- footing ---------------------------------------------------------
      const blocked = (x: number, y: number) => {
        const list = solids.get(cellKey(x, y));
        if (!list) return false;
        return list.some((entry) => insidePoly(entry.pts, x, y));
      };

      const onPavedGround = (x: number, y: number) => {
        const key = `${Math.floor(x / WALK_CELL)},${Math.floor(y / WALK_CELL)}`;
        const segs = walkHash.get(key);
        if (segs) {
          for (const seg of segs) {
            const dx = seg.x2 - seg.x1;
            const dy = seg.y2 - seg.y1;
            const lenSq = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, ((x - seg.x1) * dx + (y - seg.y1) * dy) / lenSq));
            if (Math.hypot(x - (seg.x1 + t * dx), y - (seg.y1 + t * dy)) <= seg.r + WALK_SLACK) return true;
          }
        }
        const areas = parkHash.get(key);
        if (areas) {
          for (const entry of areas) if (insidePoly(entry.pts, x, y)) return true;
        }
        return false;
      };

      /**
       * You may stand here if it is paved or planted, not built on, and inside
       * the mapped area. The edge has to be part of the test: clamping a move
       * *after* accepting it drops you onto ground that was never walkable, and
       * then you fight the clamp forever.
       */
      const walkable = (x: number, y: number) =>
        Math.hypot(x, y) <= WORLD_LIMIT_M && onPavedGround(x, y) && !blocked(x, y);

      /**
       * Nearest piece of open ground among the tiles drawn so far. `minAway`
       * lets a trapped player ask for somewhere that is not simply where they
       * are already standing.
       */
      const snapToGround = (x: number, y: number, minAway = 0) => {
        if (minAway === 0 && walkable(x, y)) return { x, y };
        let best = { x, y };
        let bestDist = Infinity;
        for (const roads of roadsByTile.values()) {
          for (const road of roads) {
            for (let i = 0; i < road.pts.length; i += 2) {
              const d = Math.hypot(road.pts[i] - x, road.pts[i + 1] - y);
              if (d < minAway || d >= bestDist) continue;
              if (walkable(road.pts[i], road.pts[i + 1])) {
                bestDist = d;
                best = { x: road.pts[i], y: road.pts[i + 1] };
              }
            }
          }
        }
        return best;
      };

      // ---- minimap ---------------------------------------------------------
      const MM_PAD = 12;
      const MM_R = MINIMAP_SIZE / 2 - MM_PAD;
      const mmScale = MM_R / city.radius;
      const toMini = (x: number, y: number) => ({
        x: MINIMAP_SIZE / 2 + x * mmScale,
        y: MINIMAP_SIZE / 2 + y * mmScale,
      });

      const minimap = new Container();
      minimap.addChild(
        new Graphics()
          .roundRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE, 6)
          .fill({ color: 0x22303f, alpha: 0.95 })
          .stroke({ width: 2, color: 0x8fb4cf, alpha: 0.7 }),
      );

      const mmRoads = new Graphics();
      city.roads.forEach((way) => {
        if (way.pts.length < 4 || !MAJOR_ROADS.has(way.kind)) return;
        const first = toMini(way.pts[0], way.pts[1]);
        mmRoads.moveTo(first.x, first.y);
        for (let i = 2; i < way.pts.length; i += 2) {
          const p = toMini(way.pts[i], way.pts[i + 1]);
          mmRoads.lineTo(p.x, p.y);
        }
      });
      mmRoads.stroke({ width: 1.4, color: 0xcfe0ec, alpha: 0.75 });
      minimap.addChild(mmRoads);

      const mmNorth = new Text({
        text: "N",
        style: {
          fill: 0xffd88a,
          fontSize: 9 * FS,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontWeight: "700",
        },
      });
      mmNorth.anchor.set(0.5, 0);
      mmNorth.scale.set(1 / FS);
      mmNorth.x = MINIMAP_SIZE / 2;
      mmNorth.y = 3;
      minimap.addChild(mmNorth);

      const mmPins = new Graphics();
      minimap.addChild(mmPins);
      app.stage.addChild(minimap);

      const drawMinimap = () => {
        mmPins.clear();
        const rv = revealRef.current;
        if (rv) {
          const p = toMini(rv.x, rv.y);
          mmPins.circle(p.x, p.y, 4).fill({ color: 0xe8a33d });
        }
        const g = guessRef.current;
        if (g) {
          const p = toMini(g.x, g.y);
          mmPins.circle(p.x, p.y, 3).stroke({ width: 1.5, color: 0x6ea8dc });
        }
        for (const p2 of othersRef.current) {
          const p = toMini(p2.x, p2.y);
          mmPins.circle(p.x, p.y, 2.5).fill({ color: 0xbcd2e2 });
        }
        for (const w of witnessesRef.current) {
          const at = strollers.get(w.id);
          const p = toMini(at?.x ?? w.x, at?.y ?? w.y);
          mmPins.circle(p.x, p.y, w.locked ? 2 : 3)
            .fill({ color: w.spoken ? 0x6fbf8b : w.locked ? 0x7d93a8 : 0xffc65c });
        }
        for (const m of memoriesRef.current) {
          const p = toMini(m.x, m.y);
          mmPins.circle(p.x, p.y, 2).fill({ color: 0xe98bb4 });
        }
        const me = toMini(playerRef.current.x, playerRef.current.y);
        mmPins.circle(me.x, me.y, 3.5).fill({ color: 0xffffff });
        mmPins.circle(me.x, me.y, 7).stroke({ width: 1, color: 0xffffff, alpha: 0.5 });
      };

      markerDrawRef.current = () => { drawMarkers(); drawMinimap(); };
      drawMarkers();

      // ---- compass ---------------------------------------------------------
      const compass = new Container();
      compass.addChild(
        new Graphics()
          .circle(0, 0, 26)
          .fill({ color: 0x22303f, alpha: 0.92 })
          .stroke({ width: 2, color: 0x8fb4cf, alpha: 0.7 }),
      );
      const northIso = iso(0, -1);
      const northLen = Math.hypot(northIso.x, northIso.y) || 1;
      const nx = (northIso.x / northLen) * 16;
      const ny = (northIso.y / northLen) * 16;
      compass.addChild(
        new Graphics().moveTo(-nx * 0.6, -ny * 0.6).lineTo(nx, ny)
          .stroke({ width: 3, color: 0xffd88a }),
      );
      const compassN = new Text({
        text: "N",
        style: {
          fill: 0xffd88a,
          fontSize: 10 * FS,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontWeight: "700",
        },
      });
      compassN.anchor.set(0.5);
      compassN.scale.set(1 / FS);
      compassN.x = nx * 1.5;
      compassN.y = ny * 1.5;
      compass.addChild(compassN);
      app.stage.addChild(compass);

      const layoutOverlays = () => {
        minimap.x = app.screen.width - MINIMAP_SIZE - 16;
        minimap.y = app.screen.height - MINIMAP_SIZE - 16;
        compass.x = 46;
        compass.y = 46;
      };
      layoutOverlays();

      // ---- player ----------------------------------------------------------
      // ---- the runner ------------------------------------------------------
      // Built from separate limbs so they can actually swing. The whole figure
      // lives in `rig`, which is mirrored to face the way you are going.
      const player = new Container();
      const playerRing = new Graphics()
        .ellipse(0, 2, 19, 9).stroke({ width: 3, color: 0xd4708f, alpha: 0.9 })
        .ellipse(0, 2, 13, 6).stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
      const playerShadow = new Graphics().ellipse(2, 2, 10, 4.5).fill({ color: SHADOW, alpha: 0.35 });
      player.addChild(playerRing, playerShadow);

      const rig = new Container();
      player.addChild(rig);

      const limb = (w: number, h: number, colour: number) => {
        const g = new Graphics().roundRect(-w / 2, 0, w, h, w / 2.5).fill({ color: colour });
        g.pivot.set(0, 0); // hinge at the top, like a hip or a shoulder
        return g;
      };

      const legBack = limb(5, 11, shade(kit.trousers, 0.85));
      const legFront = limb(5, 11, kit.trousers);
      legBack.position.set(0, -11);
      legFront.position.set(0, -11);

      const armBack = limb(4, 9, shade(kit.coat, 0.8));
      const armFront = limb(4, 9, kit.coat);
      armBack.position.set(0, -23);
      armFront.position.set(0, -23);

      const torso = new Graphics()
        .roundRect(-7, -25, 14, 15, 3).fill({ color: kit.coat })
        .rect(-7, -19, 14, 2).fill({ color: 0x000000, alpha: 0.18 })
        .roundRect(-7, -25, 14, 4, 2).fill({ color: 0xf2ede4, alpha: 0.35 });

      const head = new Graphics()
        .circle(0, -31, 6).fill({ color: kit.skin })
        .circle(2.5, -32, 1).fill({ color: 0x2b2119 })
        .rect(-7, -35, 14, 3).fill({ color: kit.hat })
        .roundRect(-5, -39, 10, 4, 1.5).fill({ color: shade(kit.hat, 1.2) });

      rig.addChild(legBack, armBack, torso, legFront, armFront, head);
      world.addChild(player);

      let runPhase = 0;
      let facing = 1;

      /** Swing the limbs. `drive` is 0 when standing, 1 running, ~2 sprinting. */
      const animate = (dt: number, drive: number) => {
        if (drive > 0) {
          runPhase += dt * (9 + drive * 5);
        } else {
          // settle back to standing rather than freezing mid-stride
          runPhase += dt * 4;
        }
        const swing = drive > 0 ? Math.sin(runPhase) : Math.sin(runPhase) * 0.06;
        const reach = drive > 0 ? 0.85 + drive * 0.15 : 1;

        legFront.rotation = swing * 0.75 * reach;
        legBack.rotation = -swing * 0.75 * reach;
        armFront.rotation = -swing * 0.6 * reach;
        armBack.rotation = swing * 0.6 * reach;

        // bounce on each stride, and lean into the run
        const bounce = drive > 0 ? Math.abs(Math.cos(runPhase)) * (1.6 + drive) : 0;
        rig.y = -bounce;
        rig.rotation = drive > 0 ? 0.06 * drive * facing : 0;
        playerShadow.scale.set(1 - bounce * 0.03, 1 - bounce * 0.05);
        rig.scale.x = facing;
      };
      animate(0, 0);

      world.scale.set(DEFAULT_ZOOM);

      stream();
      const footing = snapToGround(pose.current.x, pose.current.y);
      pose.current.x = footing.x;
      pose.current.y = footing.y;

      // The camera trails the player slightly instead of being welded to them.
      const cam = iso(pose.current.x, pose.current.y);

      const applyCamera = () => {
        world.x = app.screen.width / 2 - cam.x * world.scale.x;
        world.y = app.screen.height / 2 - cam.y * world.scale.y;
      };

      /**
       * Choose which signs to draw. Nearest first, streets before shopfronts,
       * and never one on top of another — a name you cannot read is worse than
       * no name at all.
       */
      let sinceSigns = 999;
      let shownSigns: Array<{ index: number; wx: number; wy: number; lift: number }> = [];

      /**
       * Pick labels for what is actually on screen, nearest first, streets
       * before shopfronts, and never overlapping. Labels live in screen space
       * so they stay the same size however far you zoom.
       */
      const updateSigns = (dt = 1) => {
        sinceSigns += dt;
        if (sinceSigns < 0.15) return;
        sinceSigns = 0;

        const { x, y } = playerRef.current;
        const scale = world.scale.x;
        const W = app.screen.width;
        const H = app.screen.height;

        type Candidate = { spec: SignSpec; index: number; d: number; sx: number; sy: number };
        const candidates: Candidate[] = [];

        signSpecs.forEach((spec, index) => {
          const d = Math.hypot(spec.wx - x, spec.wy - y);
          if (d > SIGN_KEEP_RANGE || (spec.minor && d > MINOR_SIGN_RANGE)) {
            const node = signNodes.get(index);
            if (node) {
              labelLayer.removeChild(node);
              node.destroy({ children: true });
              signNodes.delete(index);
            }
            return;
          }
          const p = iso(spec.wx, spec.wy);
          const sx = p.x * scale + world.x;
          const sy = (p.y - spec.lift) * scale + world.y;
          // only what is on screen, with a little margin
          if (sx < -80 || sx > W + 80 || sy < -30 || sy > H + 30) return;
          candidates.push({ spec, index, d, sx, sy });
        });

        candidates.sort((a, b) =>
          (a.spec.leader ? 1 : 0) - (b.spec.leader ? 1 : 0) || a.d - b.d);

        const taken: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
        const keep = new Set<number>();
        shownSigns = [];

        for (const { spec, index, sx, sy } of candidates) {
          if (keep.size >= MAX_VISIBLE_SIGNS) break;

          // screen-space box, so decluttering matches what the eye sees
          const w = spec.text.length * (spec.leader ? 6.2 : 6.8) + 10;
          const box = { x0: sx - w / 2, y0: sy - 9, x1: sx + w / 2, y1: sy + 9 };
          if (taken.some((t) => box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0)) {
            continue;
          }

          taken.push(box);
          keep.add(index);
          shownSigns.push({ index, wx: spec.wx, wy: spec.wy, lift: spec.lift });

          let node = signNodes.get(index);
          if (!node) {
            node = mapLabel(spec.text, !spec.leader);
            labelLayer.addChild(node);
            signNodes.set(index, node);
          }
          node.visible = true;
        }

        signNodes.forEach((node, index) => {
          if (!keep.has(index)) node.visible = false;
        });
      };

      /** Keep the chosen labels pinned to their place as the camera moves. */
      const positionSigns = () => {
        const scale = world.scale.x;
        for (const sign of shownSigns) {
          const node = signNodes.get(sign.index);
          if (!node) continue;
          const p = iso(sign.wx, sign.wy);
          node.x = p.x * scale + world.x;
          node.y = (p.y - sign.lift) * scale + world.y;
        }
      };

      const place = (snap = false) => {
        const p = iso(playerRef.current.x, playerRef.current.y);
        player.x = p.x;
        player.y = p.y;
        player.scale.set(Math.min(2.6, 0.85 / world.scale.x));
        if (snap) {
          cam.x = p.x;
          cam.y = p.y;
          applyCamera();
        }
        drawMinimap();
      };
      place(true);
      updateSigns();
      positionSigns();

      /**
       * Anything standing between the player and the camera is dropped to a
       * ghost. This is what makes a top-down-ish view feel like being *in* the
       * street rather than looking down on a model of one.
       */
      const updateOcclusion = () => {
        const { x, y } = playerRef.current;
        const here = iso(x, y);
        const depth = x + y;

        for (const block of fadedNow) {
          block.gfx.alpha = block.haze;
          block.faded = false;
        }
        fadedNow.length = 0;

        const cx = Math.floor(x / FADE_RADIUS);
        const cy = Math.floor(y / FADE_RADIUS);
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const bucket = blockHash.get(`${cx + ox},${cy + oy}`);
            if (!bucket) continue;
            for (const block of bucket) {
              if (block.faded || block.depth <= depth) continue;
              if (here.x < block.minX - 6 || here.x > block.maxX + 6) continue;
              if (here.y < block.minY || here.y > block.maxY + 10) continue;
              block.gfx.alpha = OCCLUDED_ALPHA;
              block.faded = true;
              fadedNow.push(block);
            }
          }
        }
      };
      updateOcclusion();

      // ---- input -----------------------------------------------------------
      const keys: Record<string, boolean> = {};
      const MOVE = ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "shift"];

      /** Keys typed into a form field are not movement. */
      const typing = (e: KeyboardEvent) => {
        const el = e.target as HTMLElement | null;
        if (!el) return false;
        const tag = el.tagName;
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
      };

      const kd = (e: KeyboardEvent) => {
        if (typing(e)) return;
        const k = e.key.toLowerCase();
        if (MOVE.includes(k)) { e.preventDefault(); keys[k] = true; return; }
        if (k === "r" && nearMemoryId) {
          e.preventDefault();
          onReadMemoryRef.current(nearMemoryId);
          return;
        }
        if (k === "t") {
          // They are walking, so they may have drifted since the prompt showed.
          // Be generous: take the nearest within half again the talk range.
          let target = nearId;
          if (!target) {
            const { x, y } = playerRef.current;
            let best = kitRef.current.talkRange * 1.6;
            for (const w of witnessesRef.current) {
              const at = strollers.get(w.id);
              const d = Math.hypot((at?.x ?? w.x) - x, (at?.y ?? w.y) - y);
              if (d < best) { best = d; target = w.id; }
            }
          }
          if (target) {
            e.preventDefault();
            // drop any held keys, or you keep running while the chat is open
            for (const held of Object.keys(keys)) keys[held] = false;
            onTalkRef.current(target);
          }
          return;
        }
        if (k === "e" && !frozenRef.current) {
          e.preventDefault();
          onCommitRef.current(playerRef.current.x, playerRef.current.y);
        }
      };
      const ku = (e: KeyboardEvent) => {
        if (typing(e)) return;
        const k = e.key.toLowerCase();
        if (MOVE.includes(k)) keys[k] = false;
      };
      const zoomBy = (factor: number) => {
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, world.scale.x * factor));
        world.scale.set(next);
        place(true);
        updateSigns();
        positionSigns();
      };
      const wheel = (e: WheelEvent) => {
        e.preventDefault();
        zoomBy(e.deltaY > 0 ? 0.88 : 1.12);
      };
      if (apiRef.current) apiRef.current.current = { zoomBy };
      window.addEventListener("keydown", kd);
      window.addEventListener("keyup", ku);
      host.addEventListener("wheel", wheel, { passive: false });

      // ---- loop ------------------------------------------------------------
      let sinceStreetCheck = 0;
      let lastStreet: string | null = null;
      let lastPlace: string | null = null;
      let sinceNear = 0;
      let nearId: string | null = null;
      let nearMemoryId: string | null = null;
      let sxNow = 0;
      let syNow = 0;
      let clock = 0;
      /**
       * Seconds since the last footfall. Paced by time, not distance: the
       * player crosses ground far faster than a person could, so stepping per
       * metre fires a dozen times a second and sounds like a rattle.
       */
      let sinceStep = 0;

      let sinceStream = 0;
      let sinceDusk = 0;
      app.ticker.add((ticker: any) => {
        const dt = Math.min(0.06, ticker.deltaMS / 1000);
        clock += dt * 2;
        sinceStream += ticker.deltaMS;
        if (sinceStream > 500) { sinceStream = 0; stream(); }
        sinceDusk += ticker.deltaMS;
        if (sinceDusk > 60_000) { sinceDusk = 0; paintDusk(); }
        updateFocus(dt);
        stepMovers(dt);
        if (sxNow === 0 && syNow === 0) animate(dt, 0);

        let sx = 0;
        let sy = 0;
        if (keys["a"] || keys["arrowleft"]) sx -= 1;
        if (keys["d"] || keys["arrowright"]) sx += 1;
        if (keys["w"] || keys["arrowup"]) sy -= 1;
        if (keys["s"] || keys["arrowdown"]) sy += 1;
        const stick = touchRef.current?.current;
        if (stick && (stick.sx !== 0 || stick.sy !== 0)) {
          sx += stick.sx;
          sy += stick.sy;
        }
        sxNow = sx;
        syNow = sy;

        if (sx !== 0 || sy !== 0) {
          let mx = sx + sy;
          let my = -sx + sy;
          const len = Math.hypot(mx, my) || 1;
          mx /= len;
          my /= len;

          const running = !!keys["shift"] || !!stick?.run;
          const step = RUN_SPEED * kitRef.current.speed * (running ? SPRINT_MULT : 1) * dt;
          const here = playerRef.current;

          // Free roam: streets, grass, rooftops, all of it. The only limit is
          // the edge of the area we actually have map data for.
          here.x += mx * step;
          here.y += my * step;

          const out = Math.hypot(here.x, here.y);
          if (out > WORLD_LIMIT_M) {
            here.x *= WORLD_LIMIT_M / out;
            here.y *= WORLD_LIMIT_M / out;
          }

          // A step every few metres, so the pace follows the legs rather than
          // the frame rate — and shortens when running.
          sinceStep += dt;
          if (sinceStep >= (running ? 0.19 : 0.29)) {
            sinceStep = 0;
            stepSound(running);
          }

          // face the way you are travelling, in screen terms
          if (sx !== 0) facing = sx > 0 ? 1 : -1;
          animate(dt, keys["shift"] ? 2 : 1);
          place();
          updateOcclusion();
        }

        // Normally the camera follows you. Once a round is revealed it pulls
        // back to hold your guess and the true place in the same shot.
        const rv = revealRef.current;
        const gs = guessRef.current;
        let target = iso(playerRef.current.x, playerRef.current.y);
        let wantScale = world.scale.x;

        if (rv) {
          const a = iso(rv.x, rv.y);
          const b = gs ? iso(gs.x, gs.y) : a;
          target = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

          const spanX = Math.abs(a.x - b.x) + 260;
          const spanY = Math.abs(a.y - b.y) + 260;
          wantScale = Math.max(MIN_ZOOM, Math.min(
            DEFAULT_ZOOM,
            Math.min(app.screen.width / spanX, app.screen.height / spanY),
          ));
        }

        const ease = Math.min(1, dt * (rv ? 3 : 7));
        cam.x += (target.x - cam.x) * ease;
        cam.y += (target.y - cam.y) * ease;
        if (Math.abs(wantScale - world.scale.x) > 0.002) {
          world.scale.set(world.scale.x + (wantScale - world.scale.x) * ease);
        }
        applyCamera();

        // The camera keeps easing after you stop, so labels have to be re-pinned
        // every frame or they slide out of place while the map moves under them.
        updateSigns(dt);
        positionSigns();
        // Only what is on screen gets drawn; a dense city has far more loaded.
        Culler.shared.cull(world, app.screen, false);

        // Witnesses pace their own corner rather than standing like statues.
        // The leash keeps them near the street the case file names.
        strollers.forEach((st) => {
          st.phase += dt;
          const nx3 = st.x + st.dx * WITNESS_SPEED * dt;
          const ny3 = st.y + st.dy * WITNESS_SPEED * dt;

          if (Math.hypot(nx3 - st.homeX, ny3 - st.homeY) > WITNESS_LEASH) {
            const backX = st.homeX - st.x;
            const backY = st.homeY - st.y;
            const len = Math.hypot(backX, backY) || 1;
            const jitter = (st.phase % 1) - 0.5;
            st.dx = backX / len + jitter * 0.6;
            st.dy = backY / len - jitter * 0.6;
            const dl = Math.hypot(st.dx, st.dy) || 1;
            st.dx /= dl;
            st.dy /= dl;
          } else {
            st.x = nx3;
            st.y = ny3;
          }

          const p = iso(st.x, st.y);
          st.node.x = p.x;
          st.node.y = p.y - Math.abs(Math.sin(st.phase * 5)) * 1.6;
          st.node.zIndex = p.y;
        });

        // whoever is close enough to speak to
        sinceNear += ticker.deltaMS;
        if (sinceNear > 90) {
          sinceNear = 0;
          const { x, y } = playerRef.current;
          let found: string | null = null;
          let best = kitRef.current.talkRange;
          for (const w of witnessesRef.current) {
            const at = strollers.get(w.id);
            const d = Math.hypot((at?.x ?? w.x) - x, (at?.y ?? w.y) - y);
            if (d < best) { best = d; found = w.id; }
          }
          if (found !== nearId) {
            nearId = found;
            if (found) nearSound();
            onNearRef.current(found);
          }

          // Walk everyone toward wherever they last said they were.
        othersRef.current.forEach((p, i) => {
          const entry = shown.get(p.uid);
          if (!entry) return;

          const dx = p.x - entry.x;
          const dy = p.y - entry.y;
          const gap = Math.hypot(dx, dy);

          if (gap > 260) {
            // too far to have walked: they jumped, so put them there
            entry.x = p.x;
            entry.y = p.y;
          } else if (gap > 0.4) {
            // a steady walking pace rather than a snap
            const stride = Math.min(gap, 26 * dt);
            entry.x += (dx / gap) * stride;
            entry.y += (dy / gap) * stride;
          }

          const at = iso(entry.x, entry.y);
          entry.node.x = at.x;
          entry.node.y = at.y - (gap > 0.6 ? Math.abs(Math.sin(clock * 5 + i)) * 2 : 0);
          entry.node.zIndex = at.y;
        });

        // Hearts breathe: the ring swells and fades, the pin bobs, and the heart
        // itself beats. A memory you cannot see is a memory nobody reads.
        pinLayer.children.forEach((node: any, i: number) => {
          const beat = Math.sin(clock * 1.6 + i * 0.7);
          node.y = (node.zIndex as number) - Math.abs(beat) * 3;

          const ring = node.children[0];
          if (ring) {
            const swell = (Math.sin(clock * 1.6 + i * 0.7) + 1) / 2;
            ring.scale.set(1 + swell * 0.45);
            ring.alpha = 0.85 - swell * 0.55;
          }
          const heart = node.children[3];
          if (heart) heart.scale.set(1 + Math.max(0, beat) * 0.12);
        });

        // whichever memory is close enough to read
          // Generous: at a run you cross 22 metres in a fifth of a second, and
          // sailing past a memory without noticing is the worst outcome here.
          let pin: string | null = null;
          let pinDist = 45;
          for (const m of memoriesRef.current) {
            const d = Math.hypot(m.x - x, m.y - y);
            if (d < pinDist) { pinDist = d; pin = m.id; }
          }
          if (pin !== nearMemoryId) {
            nearMemoryId = pin;
            if (pin) nearSound();
            onNearMemoryRef.current(pin);
          }
        }

        sinceStreetCheck += ticker.deltaMS;
        if (sinceStreetCheck > 250) {
          sinceStreetCheck = 0;
          const { x, y } = playerRef.current;
          let best: string | null = null;
          let bestDist = 30;
          for (const segments of segmentsByTile.values()) {
            for (const s of segments) {
              const dx = s.x2 - s.x1;
              const dy = s.y2 - s.y1;
              const lenSq = dx * dx + dy * dy || 1;
              const t = Math.max(0, Math.min(1, ((x - s.x1) * dx + (y - s.y1) * dy) / lenSq));
              const d = Math.hypot(x - (s.x1 + t * dx), y - (s.y1 + t * dy));
              if (d < bestDist) { bestDist = d; best = s.name; }
            }
          }
          let place: string | null = null;
          let placeDist = 95;
          for (const places of placesByTile.values()) {
            for (const named of places) {
              const d = Math.hypot(named.x - x, named.y - y);
              if (d < placeDist) { placeDist = d; place = named.name; }
            }
          }

          if (best !== lastStreet || place !== lastPlace) {
            lastStreet = best;
            lastPlace = place;
            onStreetRef.current({ street: best, place });
          }
        }
      });

      const ro = new ResizeObserver(() => {
        if (!hostRef.current) return;
        app.renderer.resize(hostRef.current.clientWidth, hostRef.current.clientHeight);
        layoutOverlays();
        paintDusk();
        place(true);
      updateSigns();
      positionSigns();
      });
      ro.observe(host);

      teardown = () => {
        if (apiRef.current) apiRef.current.current = null;
        window.removeEventListener("keydown", kd);
        window.removeEventListener("keyup", ku);
        host.removeEventListener("wheel", wheel);
        ro.disconnect();
        markerDrawRef.current = null;
      };

      onInitRef.current?.(true);
    };

    init();

    return () => {
      mounted = false;
      teardown?.();
      try { app?.destroy(true, { children: true }); } catch { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city]);

  return <div ref={hostRef} style={{ width: "100%", height: "100%" }} />;
}
