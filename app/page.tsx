"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CityScene, { type SceneApi, type TouchInput } from "../components/CityScene";
import TouchControls, { useCoarsePointer, type TouchAction } from "../components/TouchControls";
import WitnessChat, { type ChatWitness } from "../components/WitnessChat";
import BootFlow from "../components/BootFlow";
import StreetPhoto from "../components/StreetPhoto";
import LeaveMemory from "../components/LeaveMemory";
import { getMemory, listMemories, rehome, saveMemory, type Memory } from "../lib/memories";
import { cachedCases, cachedCast, storeCases, storeCast, POOL_SIZE } from "../lib/caseCache";
import { cachedCity, cachedTile, storeCity, storeTile } from "../lib/cityCache";
import { dealCases, markPlayed } from "../lib/dealCases";
import { citySlug } from "../lib/memories";
import CityRoom from "../components/CityRoom";
import { joinCity, watchCity, type Explorer } from "../lib/presence";
import { callPeers, joinVoice, leaveVoice, setDistances, type VoiceState } from "../lib/voice";
import { rememberName, savedName } from "../lib/player";
import {
  initSound, leaveSound, markSound,
  memorySound, revealSound, soundMuted, talkSound, toggleMuted,
} from "../lib/sound";
import { LOOKS, type Look } from "../lib/avatars";

type WitnessMarker = {
  id: string; x: number; y: number; name: string; look: string;
  spoken: boolean; locked: boolean;
};
import { distance, toLatLon, type CityData, type Pose, type Site, type TileData } from "../lib/geo";
import { placeWitnesses, STAGE_LABEL, type Witness } from "../lib/witnesses";

/**
 * You are in the city first, and a case is something you choose to take. The
 * historical game is one thing to do while you are here, not the reason to be.
 */
type Phase = "boot" | "briefed" | "exploring" | "playing" | "result" | "over";

type Result = {
  site: Site;
  metres: number;
  points: number;
  gaveUp: boolean;
  timedOut: boolean;
  base: number;
  timeBonus: number;
  streakBonus: number;
  hintCost: number;
};

const ROUND_SECONDS = 300;
const HINT_COST = 120;
/** Land inside this and the round counts toward your streak. */
const STREAK_METRES = 300;


// A guess 250m out is still a good guess; 2km out is not.
const scoreFor = (metres: number) => Math.max(0, Math.round(1000 * Math.exp(-metres / 250)));

const verdictFor = (metres: number) => {
  if (metres < 40) return "You were standing on it.";
  if (metres < 120) return "Close enough to see it.";
  if (metres < 300) return "Same few streets.";
  if (metres < 700) return "The right quarter, wrong corner.";
  if (metres < 1500) return "You knew the area, not the place.";
  return "Nowhere near.";
};

const formatDistance = (metres: number) =>
  metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(2)} km`;

const formatClock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.max(0, seconds % 60)).padStart(2, "0")}`;

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** Which way the site lies from you, in words. */
const bearingWord = (dx: number, dy: number) => {
  // x is east, y is south
  const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return COMPASS[Math.round(((angle + 360) % 360) / 45) % 8];
};

export default function Home() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [look, setLook] = useState<Look>(LOOKS[0]);
  const [name, setName] = useState("");
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which step of the build is running: 0 idle, 1 city, 2 history, 3 memories. */
  const [stage, setStage] = useState(0);
  /** null while the scene is still drawing, false if the browser could not. */
  const [sceneReady, setSceneReady] = useState<boolean | null>(null);

  const [city, setCity] = useState<CityData | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [round, setRound] = useState(0);
  const [results, setResults] = useState<Result[]>([]);
  const [guess, setGuess] = useState<{ x: number; y: number } | null>(null);
  const [where, setWhere] = useState<{ street: string | null; place: string | null }>({ street: null, place: null });
  const [secondsLeft, setSecondsLeft] = useState(ROUND_SECONDS);
  const [streak, setStreak] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  /** The free warmer/colder nudge, kept apart so it never overwrites a paid hint. */
  const [warmth, setWarmth] = useState<string | null>(null);
  const [hintsUsed, setHintsUsed] = useState(0);
  const warmthRef = useRef<number | null>(null);
  const talkingToRef = useRef<string | null>(null);
  /** Witnesses whose testimony is already in the field notes. */
  const filedRef = useRef<Set<string>>(new Set());

  useEffect(() => { setName(savedName()); }, []);

  /** A memory somebody was sent a link to: the city to build, and where to stand. */
  const [arrival, setArrival] = useState<{ memory: Memory; place: string; city: string; query: string; by: string } | null>(null);

  // ?m=<id>: somebody sent a memory. Build its city, and stand them beside it.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("m");
    if (!id) return;
    void getMemory(id).then((m) => {
      if (!m) return;
      const cityName = m.city.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      // build the city around the memory itself, so it is never out at the edge
      const query = typeof m.lat === "number" && typeof m.lon === "number"
        ? `${cityName} @${m.lat.toFixed(5)},${m.lon.toFixed(5)}`
        : cityName;
      setArrival({ memory: m, place: m.place, city: cityName, query, by: m.by || "Someone" });
    });
  }, []);



  const [witnesses, setWitnesses] = useState<Witness[]>([]);
  const [castLoading, setCastLoading] = useState(false);
  const [talkingTo, setTalkingTo] = useState<string | null>(null);
  const [nearby, setNearby] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Record<string, Array<{ from: "player" | "witness"; text: string }>>>({});
  const [told, setTold] = useState<Record<string, boolean>>({});
  type Beat = { id: string; name: string; text: string; next: string | null };
  const [beats, setBeats] = useState<Beat[]>([]);
  const [flash, setFlash] = useState<Beat | null>(null);
  const [caseOpen, setCaseOpen] = useState(true);
  const [rebuff, setRebuff] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  /** Where the writer stood when the composer opened, for the street photograph. */
  const [composeAt, setComposeAt] = useState<{ lat: number; lon: number } | null>(null);
  const [justLeft, setJustLeft] = useState<Memory | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [reading, setReading] = useState<Memory | null>(null);
  /** The one-time "what happened to you here?" card. */
  const [firstNudge, setFirstNudge] = useState(false);
  const [keysFaded, setKeysFaded] = useState(false);
  const [yearFilter, setYearFilter] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /** The named place you just arrived outside, offered once each. */
  const [placeHint, setPlaceHint] = useState<string | null>(null);
  const offeredRef = useRef<Set<string>>(new Set());

  // Both views read and write the same position, so switching never moves you.
  const poseRef = useRef<Pose>({ x: 0, y: 0, heading: 0 });
  const standAt = useCallback((x: number, y: number) => {
    poseRef.current.x = x;
    poseRef.current.y = y;
  }, []);

  /** A link to a memory, ready to paste. */
  const copyLink = useCallback((id: string) => {
    const url = `${window.location.origin}/?m=${encodeURIComponent(id)}`;
    const done = () => {
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 2500);
    };
    navigator.clipboard?.writeText(url).then(done).catch(() => { /* clipboard blocked */ });
  }, []);
  const [muted, setMuted] = useState(false);
  const [nearest, setNearest] = useState<{ metres: number; heading: string } | null>(null);
  const [others, setOthers] = useState<Explorer[]>([]);
  const [roomOpen, setRoomOpen] = useState(false);
  const [voice, setVoice] = useState<VoiceState>({ live: false, talking: new Set(), error: null });
  const [nearMemory, setNearMemory] = useState<string | null>(null);
  // On a phone there are no keys to walk with, so a stick stands in for them.
  const coarse = useCoarsePointer();
  const touchInput = useRef<TouchInput>({ sx: 0, sy: 0, run: false });
  const sceneApi = useRef<SceneApi | null>(null);
  // Panels cover most of a phone screen, so until the player says otherwise
  // they start closed there and open everywhere else.
  const [logChoice, setLogOpen] = useState<boolean | null>(null);
  const [exploreChoice, setExploreOpen] = useState<boolean | null>(null);
  const logOpen = logChoice ?? !coarse;
  // The explore panel starts folded everywhere: the map is the page, and the
  // bar and the street chips say what there is to do.
  const exploreOpen = exploreChoice ?? false;

  const roundSeconds = ROUND_SECONDS;
  const hintCost = HINT_COST;

  const heard = witnesses.filter((w) => told[w.id]);
  /** A witness only talks once the one before them has sent you. */
  const isUnlocked = useCallback(
    (w: Witness) => !w.unlockedBy || !!told[w.unlockedBy],
    [told],
  );
  // Each stage of the chain narrows the search by roughly the same amount.
  const confidence = witnesses.length === 0
    ? 0
    : Math.round((heard.length / witnesses.length) * 100);
  const activeWitness = witnesses.find((w) => w.id === talkingTo) ?? null;

  /** What the testimony so far adds up to, in one line. */
  const soFar = heard
    .map((w) => {
      const f = w.fact;
      switch (f.kind) {
        case "context": return f.era === "undated" ? null : `it dates from ${f.era}`;
        case "quadrant": return `${f.bearing} of the centre, ${f.band}`;
        case "surroundings": return f.street ? `just off ${f.street}` : f.terrain;
        case "landmark": return `beside ${f.landmark}`;
      }
    })
    .filter((line): line is string => !!line);

  // If the cast changes under us, do not leave input swallowed by a ghost panel.
  useEffect(() => {
    if (talkingTo && !activeWitness) setTalkingTo(null);
  }, [talkingTo, activeWitness]);
  useEffect(() => { talkingToRef.current = talkingTo; }, [talkingTo]);
  /** Anything that takes your hands off the keys also stops the clock. */
  const pausedRef = useRef(false);
  useEffect(() => {
    pausedRef.current = !!talkingTo || composing || !!reading || castLoading;
  }, [talkingTo, composing, reading, castLoading]);

  // Walking up to a named place is the moment to ask what happened there.
  useEffect(() => {
    if (phase !== "exploring" || !where.place) return;
    if (offeredRef.current.has(where.place)) return;
    offeredRef.current.add(where.place);
    setPlaceHint(where.place);
    const id = window.setTimeout(() => setPlaceHint((h) => (h === where.place ? null : h)), 7_000);
    return () => window.clearTimeout(id);
  }, [phase, where.place]);

  // After a minute the key legend has done its job.
  useEffect(() => {
    if (!city) return;
    const id = window.setTimeout(() => setKeysFaded(true), 60_000);
    return () => window.clearTimeout(id);
  }, [city]);

  // A city with none of your memories in it is not yet yours: ask once.
  useEffect(() => {
    if (phase !== "exploring" || !city || arrival) return;
    const flag = `nukkad.nudged.${citySlug(city.label)}`;
    try { if (window.localStorage.getItem(flag)) return; } catch { /* fine */ }
    const id = window.setTimeout(() => setFirstNudge(true), 9_000);
    return () => window.clearTimeout(id);
  }, [phase, city, arrival]);
  const closeNudge = (andCompose: boolean) => {
    setFirstNudge(false);
    if (city) { try { window.localStorage.setItem(`nukkad.nudged.${citySlug(city.label)}`, "1"); } catch { /* fine */ } }
    if (andCompose) openComposer();
  };

  // The tab should say where you are.
  useEffect(() => {
    document.title = city ? `${city.label.split(",")[0]} · Nukkad` : "Nukkad";
  }, [city]);

  // Esc puts a memory back where you found it.
  useEffect(() => {
    if (!reading) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setReading(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reading]);

  /** Years with memories in them, for the year filter. */
  const years = useMemo(() => {
    const set = new Set(memories.map((m) => new Date(m.at).getFullYear()));
    return [...set].sort((a, b) => a - b);
  }, [memories]);
  const visibleMemories = useMemo(
    () => (yearFilter === null ? memories : memories.filter((m) => new Date(m.at).getFullYear() === yearFilter)),
    [memories, yearFilter],
  );
  const memoryPins = useMemo(
    () => visibleMemories.map((m) => ({ id: m.id, x: m.x, y: m.y, photo: !!m.photo })),
    [visibleMemories],
  );

  // Announce yourself to the city, and watch for anyone else in it.
  useEffect(() => {
    if (!city || (phase !== "exploring" && phase !== "playing" && phase !== "result")) return;
    const slug = citySlug(city.label);

    let stop: (() => void) | undefined;
    void joinCity(slug, { name, coat: look.coat }, () => poseRef.current)
      .then((leave) => { stop = leave; });

    const unwatch = watchCity(slug, setOthers);
    return () => { stop?.(); unwatch(); setOthers([]); };
  }, [city, phase, name, look.coat]);

  // Voice follows the crowd: call anyone here, and let distance set the volume.
  useEffect(() => {
    if (!voice.live) return;
    void callPeers(others.map((p) => p.uid));
  }, [voice.live, others]);

  useEffect(() => {
    if (!voice.live) return;
    const id = window.setInterval(() => {
      const metres: Record<string, number> = {};
      for (const p of others) {
        metres[p.uid] = Math.hypot(p.x - poseRef.current.x, p.y - poseRef.current.y);
      }
      setDistances(metres);
    }, 400);
    return () => window.clearInterval(id);
  }, [voice.live, others]);

  useEffect(() => () => leaveVoice(), []);

  const toggleVoice = useCallback(async () => {
    if (voice.live) { leaveVoice(); return; }
    if (!city) return;
    await joinVoice(citySlug(city.label), setVoice);
  }, [voice.live, city]);

  // Point the player at the closest memory while they are exploring, or a city
  // with four hearts in twelve square kilometres is a city with none.
  useEffect(() => {
    if (phase !== "exploring" || visibleMemories.length === 0) { setNearest(null); return; }
    const id = window.setInterval(() => {
      let best: { metres: number; heading: string } | null = null;
      for (const m of visibleMemories) {
        const dx = m.x - poseRef.current.x;
        const dy = m.y - poseRef.current.y;
        const metres = Math.hypot(dx, dy);
        if (!best || metres < best.metres) best = { metres, heading: bearingWord(dx, dy) };
      }
      setNearest(best);
    }, 500);
    return () => window.clearInterval(id);
  }, [phase, visibleMemories]);

  // Browsers will not make a sound until the player has touched something.
  useEffect(() => {
    const wake = () => { initSound(); setMuted(soundMuted()); };
    window.addEventListener("pointerdown", wake, { once: true });
    window.addEventListener("keydown", wake, { once: true });
    return () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);
  useEffect(() => { if (name.trim().length >= 2) rememberName(name); }, [name]);

  // ---- the case: who is standing where, and what you have got out of them ----
  const markers: WitnessMarker[] = useMemo(
    () => witnesses.map((w) => ({
      id: w.id,
      x: w.x,
      y: w.y,
      name: isUnlocked(w) ? w.name : "Someone",
      look: isUnlocked(w) ? w.look : "will not talk to a stranger",
      spoken: !!told[w.id],
      locked: !isUnlocked(w),
    })),
    [witnesses, told, isUnlocked],
  );


  const site = sites[round] ?? null;
  const lastResult = results[round] ?? null;
  const total = useMemo(() => results.reduce((sum, r) => sum + r.points, 0), [results]);

  const startCity = async (name: string) => {
    const wanted = name.trim();
    if (wanted.length < 2) return;

    setBuilding(true);
    setError(null);
    setResults([]);
    setGuess(null);
    setRound(0);
    setStage(1);

    try {
      // Somebody may already have built it: this device, or anyone at all.
      let cityData = await cachedCity(wanted);
      if (!cityData) {
        const cityResponse = await fetch("/api/city", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ city: wanted }),
        });
        const built = await cityResponse.json();
        if (!cityResponse.ok) throw new Error(built?.error ?? "Could not build that city.");
        cityData = built as CityData;
        void storeCity(wanted, cityData);
      }

      setStage(2);

      // A city's pool is written once. Somebody may already have paid for it.
      const slug = citySlug(cityData.label);
      let pool = await cachedCases(slug);

      if (!pool) {
        // A town Wikipedia has not written up is still a town people remember,
        // so a missing history means no game to offer, not no city to walk.
        try {
          const historyResponse = await fetch("/api/history", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              centre: cityData.centre,
              radius: cityData.radius,
              rounds: POOL_SIZE,
            }),
          });
          const historyData = await historyResponse.json();
          if (!historyResponse.ok) throw new Error(historyData?.error ?? "No history found there.");
          pool = historyData.sites as typeof pool;
          void storeCases(slug, pool ?? []);
        } catch {
          pool = [];
        }
      }

      // Deal this session's hand, favouring cases this player has not had.
      const sites = dealCases(pool ?? [], 5);
      markPlayed(sites);

      setStage(3);

      let left: Memory[] = [];
      try {
        left = await listMemories(cityData.label);
      } catch { /* no memory store yet: the city is simply quiet */ }

      setSceneReady(null);
      setCity(cityData);
      setMemories(rehome(left, cityData.centre));
      setSites(sites);
      setPhase("briefed");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBuilding(false);
      setStage(0);
    }
  };

  /**
   * One tile beyond the initial map, as the scene asks for it: this device's
   * cache, then everyone's, then Overpass.
   */
  const loadTile = useCallback(async (cx: number, cy: number): Promise<TileData | null> => {
    if (!city) return null;
    const hit = await cachedTile(city.query, cx, cy);
    if (hit) return hit;
    try {
      const response = await fetch("/api/city", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ city: city.query, centre: city.centre, tile: { cx, cy } }),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as TileData;
      void storeTile(city.query, cx, cy, data);
      return data;
    } catch {
      return null;
    }
  }, [city]);

  /** Back to the front door: another city, or the same one again. */
  const leaveCity = () => {
    leaveVoice();
    setPhase("boot");
    setCity(null);
    setSites([]);
    setResults([]);
    setStreak(0);
    setWitnesses([]);
    setTalkingTo(null);
    setReading(null);
    setComposing(false);
    setRoomOpen(false);
  };

  /** Read the memory you are standing at. */
  const readMemory = useCallback((id: string) => {
    const found = memories.find((m) => m.id === id);
    if (found) { setReading(found); memorySound(); }
  }, [memories]);

  /** Start talking to a witness, if they will have you. */
  const talkTo = useCallback((id: string) => {
    const who = witnesses.find((w) => w.id === id);
    if (!who) return;
    if (!isUnlocked(who)) {
      const sender = witnesses.find((w) => w.id === who.unlockedBy);
      setRebuff(sender && isUnlocked(sender)
        ? `They look you over and turn away. ${sender.name} has to send you first.`
        : "They look you over and turn away. Follow the trail: someone has to vouch for you first.");
      window.setTimeout(() => setRebuff(null), 3800);
      return;
    }
    talkSound();
    setTalkingTo(id);
  }, [witnesses, isUnlocked]);

  const settle = useCallback((
    metres: number,
    where: { x: number; y: number } | null,
    reason: { gaveUp: boolean; timedOut: boolean },
  ) => {
    if (!site) return;

    revealSound(reason.gaveUp || reason.timedOut ? Infinity : metres);
    const scored = Number.isFinite(metres) && !reason.gaveUp && !reason.timedOut;
    const base = scored ? scoreFor(metres) : 0;
    const timeBonus = scored ? Math.round(200 * (secondsLeft / roundSeconds)) : 0;
    const keepsStreak = scored && metres < STREAK_METRES;
    const streakBonus = keepsStreak ? Math.round(base * 0.1 * Math.min(4, streak)) : 0;
    const spentOnHints = hintsUsed * hintCost;
    const points = Math.max(0, base + timeBonus + streakBonus - spentOnHints);

    setStreak(keepsStreak ? streak + 1 : 0);
    setGuess(where);
    setResults((current) => {
      const next = [...current];
      next[round] = {
        site, metres, points, base, timeBonus, streakBonus, hintCost: spentOnHints,
        gaveUp: reason.gaveUp, timedOut: reason.timedOut,
      };
      return next;
    });
    setPhase("result");
  }, [site, round, secondsLeft, streak, hintsUsed, roundSeconds, hintCost]);

  const commit = useCallback((x: number, y: number) => {
    if (!site) return;
    markSound();
    settle(distance(x, y, site.x, site.y), { x, y }, { gaveUp: false, timedOut: false });
  }, [site, settle]);

  const giveUp = () => settle(Infinity, null, { gaveUp: true, timedOut: false });

  /** Where you stand is your answer. */
  const markHere = useCallback(() => commit(poseRef.current.x, poseRef.current.y), [commit]);

  /** Costed nudge: which way, and roughly how far. */
  const askLocal = () => {
    if (!site) return;
    const dx = site.x - poseRef.current.x;
    const dy = site.y - poseRef.current.y;
    const away = Math.hypot(dx, dy);
    const band = away < 200 ? "very close" : away < 600 ? `about ${Math.round(away / 100) * 100} m` : `over ${Math.floor(away / 500) * 500} m`;
    setHintsUsed((n) => n + 1);
    setHint(`Someone points: it lies to the ${bearingWord(dx, dy)}, ${band} from here. (−${hintCost} pts)`);
  };

  // Cast the witnesses for each new round: real spots, real facts, invented people.
  useEffect(() => {
    if (phase !== "playing" || !city || !site) return;

    let cancelled = false;
    setWitnesses([]);
    setTranscripts({});
    setTold({});
    setBeats([]);
    setFlash(null);
    filedRef.current = new Set();
    setTalkingTo(null);
    setNearby(null);
    setCastLoading(true);

    const spots = placeWitnesses(city, site, 4);
    if (spots.length === 0) { setCastLoading(false); return; }

    (async () => {
      try {
        // The spots are computed from fixed geometry, so a cast written for
        // this case is just as true for the next player.
        const already = await cachedCast(site.id);
        if (already) {
          if (!cancelled) { setWitnesses(already); setCastLoading(false); }
          return;
        }

        const response = await fetch("/api/witnesses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            city: city.label.split(",")[0],
            site: { era: site.era, summary: site.summary },
            spots,
          }),
        });
        const data = await response.json();
        if (cancelled) return;
        if (Array.isArray(data?.witnesses)) {
          setWitnesses(data.witnesses);
          if (data.source === "gemini") void storeCast(site.id, data.witnesses);
        }
      } catch {
        if (!cancelled) setWitnesses([]);
      } finally {
        if (!cancelled) setCastLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [phase, city, site]);

  const handleSay = useCallback((id: string, turns: Array<{ from: "player" | "witness"; text: string }>, revealed: boolean) => {
    setTranscripts((current) => ({ ...current, [id]: turns }));
    if (!revealed) return;

    // A ref, not the `told` state: React may run a state updater twice, and
    // filing the same testimony twice would duplicate it in the field notes.
    if (!filedRef.current.has(id)) {
      filedRef.current.add(id);
      const who = witnesses.find((w) => w.id === id);
      if (who) {
        const beat = { id, name: who.name, text: who.testimony, next: who.pointer };
        setBeats((list) => [...list, beat]);
        setFlash(beat);
        window.setTimeout(() => setFlash((f) => (f?.id === id ? null : f)), 6500);
      }
    }

    setTold((current) => (current[id] ? current : { ...current, [id]: true }));
  }, [witnesses]);

  // The round clock. Also nudges you warmer or colder if you have been wandering.
  useEffect(() => {
    if (phase !== "playing" || !site) return;

    setSecondsLeft(roundSeconds);
    setHint(null);
    setWarmth(null);
    setHintsUsed(0);
    warmthRef.current = null;

    let elapsed = 0;
    const id = window.setInterval(() => {
      // the clock holds while you are mid-conversation, or writing something down
      if (pausedRef.current) return;
      elapsed += 1;
      setSecondsLeft((s) => Math.max(0, s - 1));

      if (elapsed >= 45 && elapsed % 15 === 0) {
        const away = distance(poseRef.current.x, poseRef.current.y, site.x, site.y);
        const before = warmthRef.current;
        warmthRef.current = away;
        if (before !== null && Math.abs(before - away) > 25) {
          setWarmth(away < before ? "You are getting warmer." : "You are getting colder.");
        }
      }
    }, 1000);

    return () => window.clearInterval(id);
  }, [phase, site, round, roundSeconds]);

  useEffect(() => {
    if (phase === "playing" && secondsLeft === 0) {
      settle(Infinity, null, { gaveUp: false, timedOut: true });
    }
  }, [phase, secondsLeft, settle]);

  /** Open the composer where you stand, with the real street in view. */
  const openComposer = useCallback(() => {
    setComposeAt(city ? toLatLon(city.centre, poseRef.current.x, poseRef.current.y) : null);
    setComposing(true);
  }, [city]);

  /** Where a memory would be pinned: the nearest public place, never a raw point. */
  const pinPlace = where.place ?? where.street ?? "this spot";

  const leaveMemory = useCallback(async (text: string, photo?: string) => {
    if (!city) return;
    const saved = await saveMemory({
      city: city.label,
      centre: city.centre,
      x: poseRef.current.x,
      y: poseRef.current.y,
      place: pinPlace,
      text,
      by: name || "someone",
      photo,
    });
    leaveSound();
    setJustLeft(saved);
    setMemories((current) => [saved, ...current]);
    setComposing(false);
    window.setTimeout(() => setJustLeft(null), 7000);
  }, [city, pinPlace]);

  /**
   * A fresh start for every case. You do not begin the next one standing on
   * the answer to the last, and the first witness is a short walk away.
   */
  const relocateFor = (next: Site | undefined) => {
    if (!city || !next) return;
    const first = placeWitnesses(city, next, 4)[0];
    const candidates: Array<{ x: number; y: number }> = [];
    for (const road of city.roads) {
      if (road.pts.length < 4) continue;
      const i = Math.floor(road.pts.length / 4) * 2;
      const x = road.pts[i];
      const y = road.pts[i + 1];
      if (Math.hypot(x, y) > city.radius * 0.8) continue;
      if (distance(x, y, next.x, next.y) < 350) continue;
      if (first) {
        const toFirst = distance(x, y, first.x, first.y);
        if (toFirst < 200 || toFirst > 550) continue;
      }
      candidates.push({ x, y });
    }
    const pick = candidates.length > 0
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : { x: 0, y: 0 };
    standAt(pick.x, pick.y);
  };

  const nextRound = () => {
    setGuess(null);
    if (round + 1 >= sites.length) { setPhase("over"); return; }
    relocateFor(sites[round + 1]);
    setRound(round + 1);
    setPhase("playing");
  };

  const beginCases = () => {
    setResults([]);
    setRound(0);
    setStreak(0);
    setGuess(null);
    relocateFor(sites[0]);
    setPhase("playing");
  };

  const leaveCases = () => {
    setWitnesses([]);
    setTalkingTo(null);
    setGuess(null);
    setPhase("exploring");
  };

  // ---- boot: title, detective, jurisdiction, briefing ----------------------
  if (phase === "boot" || phase === "briefed") {
    return (
      <BootFlow
        look={look}
        onLook={setLook}
        stage={stage}
        error={error}
        building={building}
        cityLabel={phase === "briefed" ? (city?.label.split(",").slice(0, 2).join(", ") ?? null) : null}
        name={name}
        onName={setName}
        onBuild={startCity}
        arrival={arrival ? { place: arrival.place, city: arrival.city, query: arrival.query, by: arrival.by } : null}
        onBegin={() => {
          if (arrival && city) {
            const [m] = rehome([arrival.memory], city.centre);
            standAt(m.x, m.y);
            setMemories((current) => (current.some((c) => c.id === m.id) ? current : [m, ...current]));
            setReading(m);
            memorySound();
          }
          setPhase("exploring");
        }}
      />
    );
  }

  // ---- final score ---------------------------------------------------------
  if (phase === "over") {
    return (
      <main className="boot">
        <div className="boot-inner boot-centre panel">
          <p className="boot-brand">Case division · closing report</p>
          <h1>{total} / {sites.length * 1000}</h1>
          {(() => {
            const solved = results.filter((r) => !r.gaveUp && !r.timedOut && r.metres < 120);
            const guessed = results.filter((r) => !r.gaveUp && !r.timedOut && Number.isFinite(r.metres));
            const best = [...guessed].sort((a, b) => a.metres - b.metres)[0];
            const cityName = city?.label.split(",")[0] ?? "this city";
            const line = solved.length === results.length
              ? `You know ${cityName}. Every one of them, found.`
              : solved.length === 0
                ? `You walked ${cityName}. Next time you will know it.`
                : `You found ${solved.length} of ${results.length}${best ? `; closest was ${best.site.title}, ${formatDistance(best.metres)} out` : ""}.`;
            return <p className="score-verdict">{line}</p>;
          })()}
          <ul className="score-list">
            {results.map((result, index) => (
              <li key={result.site.id}>
                <span className="score-rank">{index + 1}</span>
                <span className="score-title">
                  <a href={result.site.url} target="_blank" rel="noreferrer">{result.site.title}</a>
                  <em>
                    {result.timedOut ? "ran out of time"
                      : result.gaveUp ? "gave up"
                      : `${formatDistance(result.metres)} away`}
                  </em>
                </span>
                <span className="score-points">{result.points}</span>
              </li>
            ))}
          </ul>
          <div className="boot-actions">
            <button className="hud-button hud-button--primary" onClick={() => setPhase("exploring")}>
              Back to the city
            </button>
            <button className="hud-button hud-button--ghost" onClick={leaveCity}>
              Another city
            </button>
          </div>
        </div>
      </main>
    );
  }

  // ---- playing / result ----------------------------------------------------
  const showing = phase === "result";
  const exploring = phase === "exploring";
  const openMemories = memories.length;

  return (
    <main className="stage">
      {city && (
        <div className="stage-canvas">
          <CityScene
            city={city}
            pose={poseRef}
            witnesses={exploring ? [] : markers}
            kit={{
              coat: look.coat, trousers: look.trousers, hat: look.hat, skin: look.skin,
              speed: 1, talkRange: 34,
            }}
            memories={memoryPins}
            others={others.map((p) => ({ uid: p.uid, x: p.x, y: p.y, name: p.name, coat: p.coat }))}
            onNearMemory={setNearMemory}
            onReadMemory={readMemory}
            onNear={setNearby}
            onTalk={talkTo}
            reveal={showing && site ? { x: site.x, y: site.y } : null}
            revealTitle={site?.kind === "memory" ? "The place they remembered" : site?.title}
            guess={guess}
            frozen={showing}
            onCommit={commit}
            onStreet={setWhere}
            onInit={setSceneReady}
            touch={touchInput}
            api={sceneApi}
            loadTile={loadTile}
          />
        </div>
      )}

      {/* the city takes a moment to draw; say so rather than show a blank page */}
      {city && sceneReady !== true && (
        <div className="drawing panel" role="status">
          {sceneReady === false ? (
            <>
              <p className="panel-title">The city would not draw</p>
              <p className="panel-note">
                Your browser could not start the renderer. Try a current Chrome, Firefox or
                Safari with hardware acceleration on.
              </p>
              <div className="action-panel">
                <button className="hud-button hud-button--ghost" onClick={leaveCity}>Back</button>
              </div>
            </>
          ) : (
            <>
              <span className="drawing-spinner" />
              <p className="drawing-text">Drawing the streets of {city.label.split(",")[0]}…</p>
            </>
          )}
        </div>
      )}

      {/* one bar across the top: who and where, the offer, the numbers, the switches */}
      <header className="topbar">
        <div className="topbar-group topbar-left">
          <p className="hud-city">{city?.label?.split(",").slice(0, 2).join(", ")}</p>
          <p className="hud-who">{exploring ? (name || "Walking") : `Case ${round + 1} of ${sites.length}`}</p>
          {exploring && (
            <button className="hud-leave" onClick={leaveCity} title="Pick a different city">
              Change city
            </button>
          )}
        </div>

        {exploring && sites.length > 0 && (
          <button
            className="topbar-group invite"
            onClick={beginCases}
            title={`${sites.length} things happened in ${city?.label?.split(",")[0]}. See if you can find where.`}
          >
            <span className="invite-mark">✦</span>
            <span className="invite-copy">
              <strong>Play a case</strong>
              <em>{sites.length} things happened here</em>
            </span>
          </button>
        )}

        {!exploring && (
          <div className="topbar-group topbar-stats">
            <div className="hud-stat">
              <label>Time</label>
              <strong
                className={castLoading && !showing ? "clock clock--held"
                  : secondsLeft <= 30 && !showing ? "clock clock--low"
                  : "clock"}
                title={castLoading ? "Held until the witnesses arrive" : undefined}
              >
                {formatClock(secondsLeft)}
              </strong>
            </div>
            <div className="hud-stat">
              <label>Streak</label>
              <strong>{streak > 0 ? "●".repeat(Math.min(4, streak)) : "—"}</strong>
            </div>
            <div className="hud-stat">
              <label>Score</label>
              <strong>{total}</strong>
            </div>
          </div>
        )}

        <div className="topbar-group topbar-right">
          {exploring && (
            <div className="hud-stat">
              <label>Memories</label>
              <strong>{openMemories}</strong>
            </div>
          )}
          {city && (
            <button className="room-toggle" onClick={() => setRoomOpen((v) => !v)}>
              <span className="room-toggle-dot" />
              {others.length + 1} here
            </button>
          )}
          <button
            className="sound-toggle"
            onClick={() => { initSound(); setMuted(toggleMuted()); }}
            aria-pressed={!muted}
            title={muted ? "Turn sound on" : "Turn sound off"}
          >
            {muted ? "♪̸" : "♪"}
          </button>
        </div>
      </header>

      {roomOpen && city && (
        <CityRoom
          city={city.label.split(",")[0]}
          citySlug={citySlug(city.label)}
          name={name}
          people={others}
          voice={voice}
          onVoice={toggleVoice}
          onClose={() => setRoomOpen(false)}
        />
      )}

      {/* the controls strip */}
      <div className={keysFaded ? "hud hud-keys hud-keys--faded" : "hud hud-keys"}>
        <span><kbd>WASD</kbd> walk</span>
        <span><kbd>Shift</kbd> run</span>
        <span><kbd>T</kbd> talk</span>
        {!exploring && <span><kbd>E</kbd> mark the spot</span>}
        {nearMemory && (
          <button className="keys-hot keys-action" onClick={() => readMemory(nearMemory)}>
            <kbd>R</kbd> read the memory
          </button>
        )}
        <button className="keys-memory" onClick={() => openComposer()}>♥ leave a memory</button>
      </div>

      {/* case file, collapsible */}
      {exploring ? (
        <aside className={exploreOpen ? "casefile casefile--open panel" : "casefile panel"}>
          <button className="casefile-tab" onClick={() => setExploreOpen((v) => !v)}>
            {exploreOpen ? "✕  Hide" : `▸  ${openMemories} ${openMemories === 1 ? "memory" : "memories"} here`}
          </button>
          {exploreOpen && (<>
          <div className="casefile-body">
          <p className="explore-title">{city?.label?.split(",")[0]}</p>
          <p className="panel-note">
            {openMemories === 0
              ? "Nobody has left anything here yet. You could be the first."
              : openMemories === 1
                ? "One memory is pinned somewhere in these streets."
                : `${openMemories} memories are pinned somewhere in these streets.`}
            {" "}Walk until you find a heart, then press <kbd>R</kbd>.
          </p>
          {years.length > 1 && (
            <div className="years" role="group" aria-label="Memories by year">
              <button className={yearFilter === null ? "year year--on" : "year"} onClick={() => setYearFilter(null)}>All</button>
              {years.map((y) => (
                <button key={y} className={yearFilter === y ? "year year--on" : "year"} onClick={() => setYearFilter(y)}>{y}</button>
              ))}
            </div>
          )}
          {nearest && (
            <p className="nearest">
              <span className="nearest-dot" />
              {nearest.metres < 45
                ? <>You are standing at one. Press <kbd>R</kbd> to read it.</>
                : <>Nearest memory: <strong>{formatDistance(nearest.metres)}</strong> to the {nearest.heading}.</>}
            </p>
          )}

          </div>
          <div className="action-panel">
            {nearMemory && (
              <button className="hud-button hud-button--primary" onClick={() => readMemory(nearMemory)}>
                Read this memory
              </button>
            )}
            <button
              className={nearMemory ? "hud-button hud-button--ghost" : "hud-button hud-button--primary"}
              onClick={() => openComposer()}
            >
              ♥ Leave a memory here
            </button>
          </div>
          </>)}
        </aside>
      ) : (
      <aside className={caseOpen ? "casefile casefile--open panel" : "casefile panel"}>
        <button className="casefile-tab" onClick={() => setCaseOpen((v) => !v)}>
          {caseOpen ? "✕  Hide case file" : `▸  Case ${round + 1} of ${sites.length}`}
        </button>

        {caseOpen && !showing && site && (
          <>
            <div className="casefile-body">
            <p className="panel-title">Case {round + 1} of {sites.length} · {site.era}</p>
            <p className="clue-text">{site.clue}</p>

            <div className="confidence">
              <div className="confidence-head">
                <span>Trail</span>
                <strong>{heard.length} of {witnesses.length || "…"}</strong>
              </div>
              <div className="confidence-bar"><i style={{ width: `${confidence}%` }} /></div>
            </div>

            <p className="panel-title" style={{ marginTop: 20 }}>The trail</p>
            {castLoading && <p className="panel-note">Finding people who were here…</p>}
            <ol className="trail">
              {witnesses.map((w) => {
                const spoken = !!told[w.id];
                const open = isUnlocked(w);
                return (
                  <li
                    key={w.id}
                    className={spoken ? "trail-step trail-step--done"
                      : open ? "trail-step trail-step--now"
                      : "trail-step"}
                  >
                    <span className="trail-mark">{spoken ? "✓" : open ? "▸" : "·"}</span>
                    <span className="trail-body">
                      <strong>{STAGE_LABEL[w.fact.kind]}</strong>
                      <em>{open ? (w.street ? `${w.name} · ${w.street}` : w.name) : "not yet"}</em>
                    </span>
                  </li>
                );
              })}
            </ol>

            {hint && <p className="nudge">{hint}</p>}
            {warmth && <p className="nudge nudge--soft">{warmth}</p>}
            </div>

            <div className="action-panel">
              <button
                className="hud-button hud-button--primary"
                onClick={markHere}
              >
                This is the spot <kbd>E</kbd>
              </button>
              <button className="hud-button hud-button--ghost" onClick={askLocal}>
                Ask for directions (−{hintCost})
              </button>
              <button className="hud-button hud-button--ghost" onClick={giveUp}>
                Close unsolved
              </button>
              <button className="hud-button hud-button--ghost" onClick={leaveCases}>
                Back to exploring
              </button>
            </div>
          </>
        )}

        {caseOpen && showing && lastResult && (
          <>
            <div className="casefile-body">
            <p className="panel-title">
              {lastResult.timedOut ? "Out of time"
                : lastResult.gaveUp ? "The answer"
                : verdictFor(lastResult.metres)}
            </p>
            <h2>{lastResult.site.title}</h2>
            {lastResult.site.kind === "memory" && (
              <p className="memory-found">
                You found the place {lastResult.site.by ?? "someone"} remembers.
                This is what they left here.
              </p>
            )}
            {city && (() => {
              const at = toLatLon(city.centre, lastResult.site.x, lastResult.site.y);
              return <StreetPhoto lat={at.lat} lon={at.lon} title={lastResult.site.title} />;
            })()}
            <div className="meta-row">
              {lastResult.site.era !== "undated" && <span>{lastResult.site.era}</span>}
              <span>
                {lastResult.gaveUp || lastResult.timedOut ? "no guess" : formatDistance(lastResult.metres)}
              </span>
            </div>
            <div className="memory-summary"><p>{lastResult.site.summary}</p></div>

            <ul className="breakdown">
              <li><span>Accuracy</span><strong>{lastResult.base}</strong></li>
              {lastResult.timeBonus > 0 && (
                <li><span>Time bonus</span><strong>+{lastResult.timeBonus}</strong></li>
              )}
              {lastResult.streakBonus > 0 && (
                <li><span>Streak</span><strong>+{lastResult.streakBonus}</strong></li>
              )}
              {lastResult.hintCost > 0 && (
                <li><span>Hints</span><strong className="minus">−{lastResult.hintCost}</strong></li>
              )}
              <li className="breakdown-total"><span>Case</span><strong>{lastResult.points}</strong></li>
            </ul>

            {witnesses.some((w) => !w.reliable && told[w.id]) && (
              <p className="nudge nudge--warn">
                {witnesses.find((w) => !w.reliable)?.name} had it wrong. One always does.
              </p>
            )}

            {lastResult.site.kind === "memory" ? (
              <p className="memory-stamp">
                — {lastResult.site.by ?? "someone"},
                {" "}{lastResult.site.leftAt
                  ? new Date(lastResult.site.leftAt).toLocaleDateString()
                  : "recently"}
              </p>
            ) : (
              <a className="source-link" href={lastResult.site.url} target="_blank" rel="noreferrer">
                Read the full history →
              </a>
            )}

            </div>
            <div className="action-panel">
              <button className="hud-button hud-button--primary" onClick={nextRound}>
                {round + 1 >= sites.length ? "Closing report" : "Next case"}
              </button>
              <button className="hud-button hud-button--ghost" onClick={() => openComposer()}>
                Leave a memory here
              </button>
            </div>
          </>
        )}
      </aside>
      )}

      {/* what people told you, as it comes in */}
      {beats.length > 0 && (
        <div className={logOpen ? "fieldlog fieldlog--open panel" : "fieldlog panel"}>
          <button className="fieldlog-tab" onClick={() => setLogOpen((v) => !v)}>
            {logOpen ? "▾" : "▴"} Field notes · {beats.length}
          </button>
          {logOpen && soFar.length > 0 && (
            <p className="fieldlog-sofar"><b>So far:</b> {soFar.join(" · ")}.</p>
          )}
          {logOpen && (
            <ol className="fieldlog-list">
              {beats.map((beat, index) => (
                <li key={`${beat.id}-${index}`}>
                  <span className="fieldlog-index">{String(index + 1).padStart(2, "0")}</span>
                  <span>
                    <strong>{beat.name}</strong>
                    <em>“{beat.text}”</em>
                    {beat.next && <span className="fieldlog-next">{beat.next}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {/* a beat lands */}
      {flash && !talkingTo && (
        <div className="beat">
          <p className="beat-who">{flash.name} told you</p>
          <p className="beat-text">“{flash.text}”</p>
          {flash.next && <p className="beat-next">{flash.next}</p>}
        </div>
      )}

      <div className="you-are-here">
        <span className="you-are-here-pin" />
        <span className="you-are-here-body">
          <strong>{where.street ?? "An unnamed street"}</strong>
          {where.place && <em>outside {where.place}</em>}
        </span>
      </div>

      {rebuff && <div className="talk-prompt talk-prompt--cold">{rebuff}</div>}

      {placeHint && exploring && !nearMemory && !composing && !reading && !firstNudge && (
        <button className="talk-prompt place-chip" onClick={() => { setPlaceHint(null); openComposer(); }}>
          <span className="place-chip-name">{placeHint}</span>
          <span className="place-chip-ask">♥ what happened to you here?</span>
        </button>
      )}

      {nearby && !talkingTo && !showing && !rebuff && (() => {
        const who = witnesses.find((w) => w.id === nearby);
        const locked = who ? !isUnlocked(who) : false;
        return (
          <button
            className={locked ? "talk-prompt talk-prompt--locked" : "talk-prompt"}
            onClick={() => talkTo(nearby)}
          >
            <kbd>T</kbd> {locked ? "a stranger" : `talk to ${who?.name ?? "them"}`}
          </button>
        );
      })()}

      {composing && city && (
        <LeaveMemory
          place={pinPlace}
          city={city.label.split(",")[0]}
          at={composeAt}
          onCancel={() => setComposing(false)}
          onPost={leaveMemory}
        />
      )}

      {justLeft && (
        <div className="beat beat--memory">
          <p className="beat-who">{name || "You"} left this at {justLeft.place}</p>
          <p className="beat-text">“{justLeft.text}”</p>
          <p className="beat-next">
            It will sit here now, for whoever passes.
            {!justLeft.id.startsWith("local-") && (
              <button className="link-button" onClick={() => copyLink(justLeft.id)}>
                {copied === justLeft.id ? "Link copied" : "Copy a link to send someone"}
              </button>
            )}
          </p>
        </div>
      )}

      {firstNudge && exploring && !composing && !reading && !justLeft && (
        <div className="beat beat--memory first-memory" role="dialog" aria-label="Leave the first memory">
          <p className="beat-who">This street is waiting</p>
          <p className="beat-text">
            What happened to you {where.street ? `on ${where.street}` : "here"}? A first day, a last
            goodbye, the shop that closed. Leave the first memory and the city starts to be yours.
          </p>
          <div className="memory-actions">
            <button className="hud-button hud-button--ghost" onClick={() => closeNudge(false)}>Not now</button>
            <button className="hud-button hud-button--primary" onClick={() => closeNudge(true)}>♥ Leave a memory</button>
          </div>
        </div>
      )}

      {reading && (
        <div className="memory-read panel" role="dialog" aria-label="A memory left here">
          <p className="panel-title">
            {reading.by ? `${reading.by}'s memory` : "A memory"} · {reading.place}
          </p>
          {reading.photo && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img className="memory-read-photo" src={reading.photo} alt="Left with this memory" />
          )}
          {typeof reading.lat === "number" && typeof reading.lon === "number" && (
            <StreetPhoto lat={reading.lat} lon={reading.lon} title={reading.place} />
          )}
          <p className="memory-read-text">“{reading.text}”</p>
          <p className="memory-stamp">
            — {reading.by || "someone"}, {new Date(reading.at).toLocaleDateString()}
            {reading.sample ? " · sample" : ""}
          </p>
          <div className="memory-actions">
            {!reading.id.startsWith("local-") && (
              <button className="hud-button hud-button--ghost" onClick={() => copyLink(reading.id)}>
                {copied === reading.id ? "Link copied" : "Copy link"}
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button className="hud-button hud-button--ghost" onClick={() => setReading(null)}>
              Close
            </button>
          </div>
        </div>
      )}

      {/* on a phone an open panel has its own buttons, so the stick steps aside */}
      {coarse && city && sceneReady && !talkingTo && !composing && !reading && !roomOpen
        && !(exploring ? exploreOpen : caseOpen) && (
        <TouchControls
          inputRef={touchInput}
          actions={[
            ...(nearMemory ? [{ id: "read", label: "Read", hot: true, onPress: () => readMemory(nearMemory) }] : []),
            ...(nearby && !showing ? [{ id: "talk", label: "Talk", hot: true, onPress: () => talkTo(nearby) }] : []),
            ...(!exploring && !showing ? [{ id: "mark", label: "This is it", primary: true, onPress: markHere }] : []),
            { id: "leave", label: "♥ Memory", onPress: () => openComposer() },
          ] satisfies TouchAction[]}
          onZoom={(f) => sceneApi.current?.zoomBy(f)}
        />
      )}

      {activeWitness && (
        <WitnessChat
          witness={activeWitness as ChatWitness}
          sentBy={
            activeWitness.unlockedBy
              ? witnesses.find((w) => w.id === activeWitness.unlockedBy)?.name ?? null
              : null
          }
          history={transcripts[activeWitness.id] ?? []}
          told={!!told[activeWitness.id]}
          onSay={(turns, revealed) => handleSay(activeWitness.id, turns, revealed)}
          onClose={() => setTalkingTo(null)}
        />
      )}
    </main>
  );
}
