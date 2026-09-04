"use client";

import { useEffect, useRef, useState } from "react";
import type { TouchInput } from "./CityScene";

/**
 * A thumb-stick and a few big buttons, for anyone holding a phone. The scene
 * reads the stick every frame through the same ref the keyboard feeds, so a
 * finger and the WASD keys are one input as far as walking is concerned.
 */
export type TouchAction = {
  id: string;
  label: string;
  onPress: () => void;
  /** Draw it as the one thing to do right now. */
  hot?: boolean;
  primary?: boolean;
};

type Props = {
  inputRef: { current: TouchInput };
  actions: TouchAction[];
  onZoom: (factor: number) => void;
};

const RADIUS = 46;      // how far the knob travels, in px
const DEAD = 0.18;      // fraction of the radius that counts as "not moving"
const RUN_AT = 0.9;     // push to the rim to run

/** Is this a device where a stick makes sense at all? */
export const useCoarsePointer = () => {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return coarse;
};

export default function TouchControls({ inputRef, actions, onZoom }: Props) {
  const padRef = useRef<HTMLDivElement | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0, active: false });
  const pointerIdRef = useRef<number | null>(null);

  const release = () => {
    pointerIdRef.current = null;
    inputRef.current = { sx: 0, sy: 0, run: false };
    setKnob({ x: 0, y: 0, active: false });
  };

  // The page unmounts the stick when a dialog opens. If that happens mid-drag,
  // never leave the player walking into the distance behind it.
  useEffect(() => () => { inputRef.current = { sx: 0, sy: 0, run: false }; }, [inputRef]);

  const track = (event: React.PointerEvent) => {
    const pad = padRef.current;
    if (!pad) return;
    const rect = pad.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = event.clientX - cx;
    let dy = event.clientY - cy;
    const len = Math.hypot(dx, dy);
    const clamped = Math.min(1, len / RADIUS);
    if (len > RADIUS) { dx *= RADIUS / len; dy *= RADIUS / len; }
    setKnob({ x: dx, y: dy, active: true });

    if (clamped < DEAD) { inputRef.current = { sx: 0, sy: 0, run: false }; return; }
    // Screen axes, the same ones the arrow keys use: up on the stick is up on screen.
    inputRef.current = { sx: dx / (len || 1), sy: dy / (len || 1), run: clamped > RUN_AT };
  };

  return (
    <div className="touch">
      <div
        ref={padRef}
        className={knob.active ? "stick stick--active" : "stick"}
        role="application"
        aria-label="Walk"
        onPointerDown={(e) => {
          if (pointerIdRef.current !== null) return;
          pointerIdRef.current = e.pointerId;
          e.currentTarget.setPointerCapture(e.pointerId);
          track(e);
        }}
        onPointerMove={(e) => { if (e.pointerId === pointerIdRef.current) track(e); }}
        onPointerUp={(e) => { if (e.pointerId === pointerIdRef.current) release(); }}
        onPointerCancel={(e) => { if (e.pointerId === pointerIdRef.current) release(); }}
        onLostPointerCapture={release}
      >
        <span className="stick-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
        <span className="stick-hint">walk</span>
      </div>

      <div className="touch-actions">
        {actions.map((a) => (
          <button
            key={a.id}
            className={
              a.primary ? "touch-button touch-button--primary"
              : a.hot ? "touch-button touch-button--hot"
              : "touch-button"
            }
            onPointerDown={(e) => e.stopPropagation()}
            onClick={a.onPress}
          >
            {a.label}
          </button>
        ))}
      </div>

      <div className="touch-zoom">
        <button className="touch-button" aria-label="Zoom in" onClick={() => onZoom(1.25)}>+</button>
        <button className="touch-button" aria-label="Zoom out" onClick={() => onZoom(0.8)}>−</button>
      </div>
    </div>
  );
}
