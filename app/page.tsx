"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CityScene from "../components/CityScene";
import WitnessChat, { type ChatWitness } from "../components/WitnessChat";
import BootFlow from "../components/BootFlow";
import StreetPhoto from "../components/StreetPhoto";
import LeaveMemory from "../components/LeaveMemory";
import { listMemories, saveMemory, type Memory } from "../lib/memories";
import { cachedCases, cachedCast, storeCases, storeCast, POOL_SIZE } from "../lib/caseCache";
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
import { distance, toLatLon, type CityData, type Pose, type Site } from "../lib/geo";
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
  const [status, setStatus] = useState("");

  const [city, setCity] = useState<CityData | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [round, setRound] = useState(0);
  const [results, setResults] = useState<Result[]>([]);
  const [guess, setGuess] = useState<{ x: number; y: number } | null>(null);
  const [where, setWhere] = useState<{ street: string | null; place: string | null }>({ street: null, place: null });
  const [secondsLeft, setSecondsLeft] = useState(ROUND_SECONDS);
  const [streak, setStreak] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const [hintsUsed, setHintsUsed] = useState(0);
  const warmthRef = useRef<number | null>(null);
  const talkingToRef = useRef<string | null>(null);
  /** Witnesses whose testimony is already in the field notes. */
  const filedRef = useRef<Set<string>>(new Set());

  useEffect(() => { setName(savedName()); }, []);


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
  const [justLeft, setJustLeft] = useState<Memory | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [reading, setReading] = useState<Memory | null>(null);
  const [muted, setMuted] = useState(false);
  const [nearest, setNearest] = useState<{ metres: number; heading: string } | null>(null);
  const [others, setOthers] = useState<Explorer[]>([]);
  const [roomOpen, setRoomOpen] = useState(false);
  const [voice, setVoice] = useState<VoiceState>({ live: false, talking: new Set(), error: null });
  const [nearMemory, setNearMemory] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(true);

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

  // If the cast changes under us, do not leave input swallowed by a ghost panel.
  useEffect(() => {
    if (talkingTo && !activeWitness) setTalkingTo(null);
  }, [talkingTo, activeWitness]);
  useEffect(() => { talkingToRef.current = talkingTo; }, [talkingTo]);

  const memoryPins = useMemo(
    () => memories.map((m) => ({ id: m.id, x: m.x, y: m.y })),
    [memories],
  );

  // Announce yourself to the city, and watch for anyone else in it.
  useEffect(() => {
    if (!city || (phase !== "exploring" && phase !== "playing" && phase !== "result")) return;
    const slug = citySlug(city.label);

    let stop: (() => void) | undefined;
    void joinCity(slug, { name, coat: look.coat }, () => pose.current)
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
        metres[p.uid] = Math.hypot(p.x - pose.current.x, p.y - pose.current.y);
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
    if (phase !== "exploring" || memories.length === 0) { setNearest(null); return; }
    const id = window.setInterval(() => {
      let best: { metres: number; heading: string } | null = null;
      for (const m of memories) {
        const dx = m.x - pose.current.x;
        const dy = m.y - pose.current.y;
        const metres = Math.hypot(dx, dy);
        if (!best || metres < best.metres) best = { metres, heading: bearingWord(dx, dy) };
      }
      setNearest(best);
    }, 500);
    return () => window.clearInterval(id);
  }, [phase, memories]);

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

  // Both views read and write the same position, so switching never moves you.
  const pose = useRef<Pose>({ x: 0, y: 0, heading: 0 });

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
    setStatus(`Finding ${wanted}…`);

    try {
      const cityResponse = await fetch("/api/city", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ city: wanted }),
      });
      const cityData = await cityResponse.json();
      if (!cityResponse.ok) throw new Error(cityData?.error ?? "Could not build that city.");

      setStatus("Reading the city's history…");

      // A city's pool is written once. Somebody may already have paid for it.
      const slug = citySlug(cityData.label);
      let pool = await cachedCases(slug);

      if (!pool) {
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
      }

      // Deal this session's hand, favouring cases this player has not had.
      const sites = dealCases(pool ?? [], 5);
      markPlayed(sites);

      setStatus("Asking who else has been here…");

      let left: Memory[] = [];
      try {
        left = await listMemories(cityData.label);
      } catch { /* no memory store yet: the city is simply quiet */ }

      setCity(cityData);
      setMemories(left);
      setSites(sites);
      setPhase("briefed");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBuilding(false);
    }
  };

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

  /** Costed nudge: which way, and roughly how far. */
  const askLocal = () => {
    if (!site) return;
    const dx = site.x - pose.current.x;
    const dy = site.y - pose.current.y;
    const away = Math.hypot(dx, dy);
    const band = away < 200 ? "very close" : away < 600 ? `about ${Math.round(away / 100) * 100} m` : `over ${Math.floor(away / 500) * 500} m`;
    setHintsUsed((n) => n + 1);
    setHint(`It lies to the ${bearingWord(dx, dy)}, ${band} from here. (−${hintCost} pts)`);
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
    setHintsUsed(0);
    warmthRef.current = null;

    let elapsed = 0;
    const id = window.setInterval(() => {
      // the clock holds while you are mid-conversation
      if (talkingToRef.current) return;
      elapsed += 1;
      setSecondsLeft((s) => Math.max(0, s - 1));

      if (elapsed >= 45 && elapsed % 15 === 0) {
        const away = distance(pose.current.x, pose.current.y, site.x, site.y);
        const before = warmthRef.current;
        warmthRef.current = away;
        if (before !== null && Math.abs(before - away) > 25) {
          setHint(away < before ? "You are getting warmer." : "You are getting colder.");
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

  /** Where a memory would be pinned: the nearest public place, never a raw point. */
  const pinPlace = where.place ?? where.street ?? "this spot";

  const leaveMemory = useCallback(async (text: string, photo?: string) => {
    if (!city) return;
    const saved = await saveMemory({
      city: city.label,
      centre: city.centre,
      x: pose.current.x,
      y: pose.current.y,
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

  const nextRound = () => {
    setGuess(null);
    if (round + 1 >= sites.length) { setPhase("over"); return; }
    setRound(round + 1);
    setPhase("playing");
  };

  const beginCases = () => {
    setResults([]);
    setRound(0);
    setStreak(0);
    setGuess(null);
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
        status={status}
        error={error}
        building={building}
        cityLabel={phase === "briefed" ? (city?.label.split(",").slice(0, 2).join(", ") ?? null) : null}
        name={name}
        onName={setName}
        onBuild={startCity}
        onBegin={() => setPhase("exploring")}
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
            <button
              className="hud-button hud-button--ghost"
              onClick={() => { setPhase("boot"); setCity(null); setStreak(0); setSites([]); }}
            >
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
            pose={pose}
            witnesses={exploring ? [] : markers}
            kit={{
              coat: look.coat, trousers: look.trousers, hat: look.hat, skin: look.skin,
              speed: 1, talkRange: 26,
            }}
            memories={memoryPins}
            others={others.map((p) => ({ uid: p.uid, x: p.x, y: p.y, name: p.name, coat: p.coat }))}
            onNearMemory={setNearMemory}
            onReadMemory={(id) => {
              const found = memories.find((m) => m.id === id);
              if (found) { setReading(found); memorySound(); }
            }}
            onNear={setNearby}
            onTalk={(id) => {
              const who = witnesses.find((w) => w.id === id);
              if (!who) return;
              if (!isUnlocked(who)) {
                setRebuff("They look you over and turn away. Someone will have to vouch for you first.");
                window.setTimeout(() => setRebuff(null), 3800);
                return;
              }
              talkSound();
              setTalkingTo(id);
            }}
            reveal={showing && site ? { x: site.x, y: site.y } : null}
            revealTitle={site?.kind === "memory" ? "The place they remembered" : site?.title}
            guess={guess}
            frozen={showing}
            onCommit={commit}
            onStreet={setWhere}
          />
        </div>
      )}

      {/* top left: who and where */}
      <div className="hud hud-tl">
        <p className="hud-city">{city?.label?.split(",").slice(0, 2).join(", ")}</p>
        <p className="hud-who">{exploring ? (name || "Walking") : `Case ${round + 1} of ${sites.length}`}</p>
      </div>

      {/* top right: the numbers, only once a case is running */}
      {exploring ? (
        <div className="hud hud-tr">
          <div className="hud-stat">
            <label>Memories</label>
            <strong>{openMemories}</strong>
          </div>
        </div>
      ) : (
        <div className="hud hud-tr">
          <div className="hud-stat">
            <label>Time</label>
            <strong className={secondsLeft <= 30 && !showing ? "clock clock--low" : "clock"}>
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

      {/* the invitation: the game is an offer, not the reason you are here */}
      {exploring && sites.length > 0 && (
        <div className="invite">
          <span className="invite-mark">✦</span>
          <span className="invite-copy">
            <strong>How well do you know {city?.label?.split(",")[0]}?</strong>
            <em>{sites.length} things happened here. See if you can find where.</em>
          </span>
          <button className="hud-button hud-button--primary invite-go" onClick={beginCases}>
            Play
          </button>
        </div>
      )}

      {city && (
        <button className="hud room-toggle" onClick={() => setRoomOpen((v) => !v)}>
          <span className="room-toggle-dot" />
          {others.length + 1} here
        </button>
      )}

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

      <button
        className="hud sound-toggle"
        onClick={() => { initSound(); setMuted(toggleMuted()); }}
        aria-pressed={!muted}
        title={muted ? "Turn sound on" : "Turn sound off"}
      >
        {muted ? "♪̸" : "♪"}
      </button>

      {/* the controls strip */}
      <div className="hud hud-keys">
        <span><kbd>WASD</kbd> walk</span>
        <span><kbd>Shift</kbd> run</span>
        <span><kbd>T</kbd> talk</span>
        {!exploring && <span><kbd>E</kbd> mark the spot</span>}
        {nearMemory && <span className="keys-hot"><kbd>R</kbd> read the memory</span>}
        <button className="keys-memory" onClick={() => setComposing(true)}>♥ leave a memory</button>
      </div>

      {/* case file, collapsible */}
      {exploring ? (
        <aside className="casefile casefile--open panel">
          <p className="explore-title">{city?.label?.split(",")[0]}</p>
          <p className="panel-note">
            {openMemories === 0
              ? "Nobody has left anything here yet. You could be the first."
              : openMemories === 1
                ? "One memory is pinned somewhere in these streets."
                : `${openMemories} memories are pinned somewhere in these streets.`}
            {" "}Walk until you find a heart, then press <kbd>R</kbd>.
          </p>
          {nearest && (
            <p className="nearest">
              <span className="nearest-dot" />
              {nearest.metres < 45
                ? <>You are standing at one. Press <kbd>R</kbd> to read it.</>
                : <>Nearest memory: <strong>{formatDistance(nearest.metres)}</strong> to the {nearest.heading}.</>}
            </p>
          )}

          <div className="action-panel">
            <button className="hud-button hud-button--primary" onClick={() => setComposing(true)}>
              ♥ Leave a memory here
            </button>
          </div>
        </aside>
      ) : (
      <aside className={caseOpen ? "casefile casefile--open panel" : "casefile panel"}>
        <button className="casefile-tab" onClick={() => setCaseOpen((v) => !v)}>
          {caseOpen ? "✕  Hide case file" : `▸  Case ${round + 1} of ${sites.length}`}
        </button>

        {caseOpen && !showing && site && (
          <>
            <p className="panel-title">Case {round + 1} of {sites.length} · {site.era}</p>
            <p className="clue-text">{site.clue}</p>

            <div className="confidence">
              <div className="confidence-head">
                <span>Confidence</span>
                <strong>{confidence}%</strong>
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

            <div className="action-panel">
              <button className="hud-button hud-button--ghost" onClick={askLocal}>
                Ask a local (−{hintCost})
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
              <span>{lastResult.site.era}</span>
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

            <div className="action-panel">
              <button className="hud-button hud-button--primary" onClick={nextRound}>
                {round + 1 >= sites.length ? "Closing report" : "Next case"}
              </button>
              <button className="hud-button hud-button--ghost" onClick={() => setComposing(true)}>
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

      {nearby && !talkingTo && !showing && !rebuff && (() => {
        const who = witnesses.find((w) => w.id === nearby);
        const locked = who ? !isUnlocked(who) : false;
        return (
          <div className={locked ? "talk-prompt talk-prompt--locked" : "talk-prompt"}>
            <kbd>T</kbd> {locked ? "a stranger" : `talk to ${who?.name ?? "them"}`}
          </div>
        );
      })()}

      {composing && city && (
        <LeaveMemory
          place={pinPlace}
          city={city.label.split(",")[0]}
          onCancel={() => setComposing(false)}
          onPost={leaveMemory}
        />
      )}

      {justLeft && (
        <div className="beat beat--memory">
          <p className="beat-who">{name || "You"} left this at {justLeft.place}</p>
          <p className="beat-text">“{justLeft.text}”</p>
          <p className="beat-next">It will sit here now, for whoever passes.</p>
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
          <p className="memory-read-text">“{reading.text}”</p>
          <p className="memory-stamp">
            — {reading.by || "someone"}, {new Date(reading.at).toLocaleDateString()}
            {reading.sample ? " · sample" : ""}
          </p>
          <div className="memory-actions">
            <button className="hud-button hud-button--ghost" onClick={() => setReading(null)}>
              Close
            </button>
          </div>
        </div>
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
