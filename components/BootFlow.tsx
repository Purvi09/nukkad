"use client";

import { useEffect, useRef, useState } from "react";
import { LOOKS, lookSvg, type Look } from "../lib/avatars";
import { cleanName } from "../lib/player";
import Polaroids from "./Polaroids";

type Step = "title" | "recruit" | "jurisdiction" | "briefing";

type Props = {
  look: Look;
  onLook: (l: Look) => void;
  name: string;
  onName: (n: string) => void;
  /** Which step of the build is running: 0 idle, 1 city, 2 history, 3 memories. */
  stage: number;
  error: string | null;
  building: boolean;
  cityLabel: string | null;
  onBuild: (city: string) => void;
  onBegin: () => void;
  /** Someone sent a link to a memory: where it is, and the city to build. */
  arrival?: { place: string; city: string; query: string; by: string } | null;
};

const SUGGESTED = ["San Francisco", "Lisbon", "Kyoto", "Edinburgh", "Old Delhi", "Havana"];

/** What building a city involves, in the order it happens. */
const BUILD_STEPS = [
  "Finding it and fetching its streets",
  "Reading what happened here",
  "Asking who else has been here",
];

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "recruit", label: "You" },
  { id: "jurisdiction", label: "Your city" },
  { id: "briefing", label: "Ready" },
];

export default function BootFlow({
  look, onLook, name, onName, stage, error, building, cityLabel, onBuild, onBegin, arrival,
}: Props) {
  const [step, setStep] = useState<Step>("title");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The city keeps building in the background; move on when it lands.
  useEffect(() => {
    if (cityLabel && step === "jurisdiction") setStep("briefing");
  }, [cityLabel, step]);

  useEffect(() => {
    if (step === "jurisdiction") inputRef.current?.focus();
  }, [step]);

  // A link already says which city: build it the moment the name is in.
  const autoBuild = useRef(false);
  useEffect(() => {
    if (step === "jurisdiction" && arrival && !autoBuild.current && !building && !cityLabel) {
      autoBuild.current = true;
      setQuery(arrival.city);
      onBuild(arrival.query);
    }
  }, [step, arrival, building, cityLabel, onBuild]);

  const progress = (
    <div className="boot-steps">
      {STEPS.map((s) => {
        const order = STEPS.findIndex((x) => x.id === s.id);
        const at = STEPS.findIndex((x) => x.id === step);
        const cls = s.id === step ? "boot-step boot-step--on"
          : order < at ? "boot-step boot-step--done"
          : "boot-step";
        return <span key={s.id} className={cls}>{s.label}</span>;
      })}
    </div>
  );

  if (step === "title") {
    return (
      <main className="boot boot--hero">
        <Polaroids />

        <div className="boot-inner boot-centre boot-hero-copy">
          <p className="boot-brand">Nukkad · a map of what people remember</p>
          <h1 className="boot-title">
            <span>Every place</span>
            <span>remembers <em>something</em>.</span>
          </h1>
          {arrival ? (
            <p className="boot-lede boot-lede--arrival">
              <strong>{arrival.by}</strong> left a memory for you at <strong>{arrival.place}</strong>,
              in {arrival.city}. Give a name, and you will be standing there.
            </p>
          ) : (
            <p className="boot-lede">
              Walk the street you grew up on, drawn from open map data. Find the memories
              people have left at the places they happened — a corner, a bench, a doorway — and
              leave your own. When you want more, the city has its own history to find.
            </p>
          )}
          <div className="boot-actions">
            <button className="hud-button hud-button--primary" onClick={() => setStep("recruit")}>
              {arrival ? "Go there" : "Start exploring"}
            </button>
          </div>
          <p className="boot-foot">
            Google Maps shows you where places are. Wikipedia tells you what happened there.
            This shows you what people remember there.
          </p>
        </div>
      </main>
    );
  }

  if (step === "recruit") {
    return (
      <main className="boot">
        <div className="boot-inner">
          {progress}
          <div className="panel">
            <p className="panel-title">What should people call you</p>
            <p className="panel-note" style={{ marginBottom: 12 }}>
              A first name. It is shown on any memory you leave, so whoever finds it knows
              a person stood there — nothing else about you is stored.
            </p>
            <div className="jurisdiction">
              <input
                value={name}
                onChange={(event) => onName(cleanName(event.target.value))}
                placeholder="Yash"
                maxLength={20}
              />
            </div>

            <p className="panel-title" style={{ marginTop: 24 }}>And how you look</p>
            <div className="looks">
              {LOOKS.map((l) => (
                <button
                  key={l.id}
                  className={l.id === look.id ? "look look--on" : "look"}
                  onClick={() => onLook(l)}
                  title={l.name}
                >
                  <span dangerouslySetInnerHTML={{ __html: lookSvg(l) }} />
                </button>
              ))}
            </div>
          </div>
          <div className="boot-actions">
            <button className="hud-button hud-button--ghost" onClick={() => setStep("title")}>
              Back
            </button>
            <button
              className="hud-button hud-button--primary"
              onClick={() => setStep("jurisdiction")}
              disabled={name.trim().length < 2}
            >
              {name.trim().length < 2 ? "Tell us your name" : `Continue as ${name}`}
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (step === "jurisdiction") {
    return (
      <main className="boot">
        <div className="boot-inner">
          {progress}
          <div className="panel">
            <p className="panel-title">Where did you grow up?</p>
            <p className="panel-note" style={{ marginBottom: 16 }}>
              A street, a neighbourhood, or a whole city, anywhere on earth. You start standing
              right there, and the streets keep loading as you walk. The map comes from
              OpenStreetMap, the history from the record, and the memories from whoever has
              walked it before you.
            </p>
            <form
              className="jurisdiction"
              onSubmit={(event) => { event.preventDefault(); onBuild(query); }}
            >
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Indiranagar, Bangalore · Rua Augusta, Lisbon · Kyoto…"
                disabled={building}
              />
              <button className="hud-button hud-button--primary" type="submit" disabled={building}>
                {building ? "Building it…" : "Take me there"}
              </button>
            </form>

            <div className="suggested">
              {SUGGESTED.map((name) => (
                <button
                  key={name}
                  disabled={building}
                  onClick={() => { setQuery(name); onBuild(name); }}
                >
                  {name}
                </button>
              ))}
            </div>

            {building && (
              <ol className="build-steps" aria-live="polite">
                {BUILD_STEPS.map((label, index) => {
                  const n = index + 1;
                  const cls = n < stage ? "build-step build-step--done"
                    : n === stage ? "build-step build-step--on"
                    : "build-step";
                  return (
                    <li key={label} className={cls}>
                      <span className="build-mark">{n < stage ? "✓" : n === stage ? "" : "·"}</span>
                      {label}
                    </li>
                  );
                })}
                <li className="build-note">A big city takes twenty or thirty seconds the first time.</li>
              </ol>
            )}
            {error && (
              <p className="boot-error">
                ✕ {error}
                {/streets|street data/i.test(error) && (
                  <> Try the nearest larger town, or a named neighbourhood.</>
                )}
              </p>
            )}
          </div>
          <div className="boot-actions">
            <button
              className="hud-button hud-button--ghost"
              onClick={() => setStep("recruit")}
              disabled={building}
            >
              Back
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="boot">
      <div className="boot-inner">
        {progress}
        <div className="panel">
          <p className="panel-title">{cityLabel}</p>
          {arrival && (
            <p className="panel-note" style={{ marginBottom: 12, color: "var(--accent)" }}>
              {arrival.by}&rsquo;s memory is waiting at {arrival.place}. You will arrive beside it.
            </p>
          )}
          <p className="panel-note" style={{ marginBottom: 18 }}>
            Walk it however you like. Pink hearts are memories people have left at real places —
            walk up to one and read it. Leave your own wherever something happened to you.
            And whenever you feel like it, see how well you really know this city.
          </p>

          <div className="rules">
            <div className="rule">
              <span className="rule-key">WASD</span>
              <p>Walk. Hold <strong>Shift</strong> to run, scroll to see further.</p>
            </div>
            <div className="rule">
              <span className="rule-key">R</span>
              <p>Read a memory when you are standing by its heart. Leave your own anywhere.</p>
            </div>
            <div className="rule">
              <span className="rule-key">✦</span>
              <p>Pink hearts are memories. They pulse where somebody stopped and wrote something down.</p>
            </div>
            <div className="rule">
              <span className="rule-key">♥</span>
              <p>Whenever you like, take a case: find where something happened from what people tell you.</p>
            </div>
          </div>
        </div>

        <div className="boot-actions">
          <button className="hud-button hud-button--primary" onClick={onBegin}>
            Walk into {cityLabel?.split(",")[0]}
          </button>
        </div>
      </div>
    </main>
  );
}
