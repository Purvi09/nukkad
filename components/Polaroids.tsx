"use client";

import { useEffect, useRef } from "react";

/**
 * The scattered photographs behind the title.
 *
 * Each "photograph" is a small painted scene in SVG — soft gradients, a light
 * source, silhouettes — rather than flat colour bands, which read as swatches.
 * Nothing here is an image file, so there is nothing to load or lose.
 */

const Bench = () => (
  <svg viewBox="0 0 100 78" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="b-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#f6d9b0" /><stop offset="0.55" stopColor="#e9c8a8" />
        <stop offset="1" stopColor="#cdd6a6" />
      </linearGradient>
      <radialGradient id="b-sun" cx="0.72" cy="0.24" r="0.4">
        <stop offset="0" stopColor="#fff3d0" stopOpacity="0.95" />
        <stop offset="1" stopColor="#fff3d0" stopOpacity="0" />
      </radialGradient>
    </defs>
    <rect width="100" height="78" fill="url(#b-sky)" />
    <rect width="100" height="78" fill="url(#b-sun)" />
    <ellipse cx="72" cy="19" rx="9" ry="9" fill="#fff6dd" opacity="0.9" />
    <path d="M0 52 Q28 44 52 50 T100 46 V78 H0Z" fill="#8fae74" />
    <path d="M0 60 Q34 54 62 60 T100 57 V78 H0Z" fill="#77995f" opacity="0.9" />
    <g opacity="0.85">
      <rect x="18" y="16" width="3" height="34" fill="#5c4a37" />
      <ellipse cx="19" cy="16" rx="15" ry="12" fill="#6f8f57" />
      <ellipse cx="12" cy="21" rx="10" ry="8" fill="#7ea063" />
    </g>
    <g fill="#4d4033" opacity="0.92">
      <rect x="36" y="52" width="30" height="3" rx="1" />
      <rect x="36" y="57" width="30" height="3" rx="1" />
      <rect x="38" y="55" width="2.5" height="10" /><rect x="62" y="55" width="2.5" height="10" />
    </g>
  </svg>
);

const Window = () => (
  <svg viewBox="0 0 100 78" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="w-wall" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#c9a98c" /><stop offset="1" stopColor="#a98a6d" />
      </linearGradient>
      <linearGradient id="w-glow" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffe0a8" /><stop offset="1" stopColor="#e8a86a" />
      </linearGradient>
      <radialGradient id="w-spill" cx="0.5" cy="0.5" r="0.6">
        <stop offset="0" stopColor="#ffdca0" stopOpacity="0.7" />
        <stop offset="1" stopColor="#ffdca0" stopOpacity="0" />
      </radialGradient>
    </defs>
    <rect width="100" height="78" fill="url(#w-wall)" />
    <rect x="10" y="8" width="80" height="4" fill="#8f7157" opacity="0.5" />
    <rect x="10" y="66" width="80" height="4" fill="#8f7157" opacity="0.4" />
    <rect x="24" y="18" width="52" height="44" rx="2" fill="url(#w-spill)" />
    <rect x="30" y="22" width="40" height="34" rx="1.5" fill="#6d5741" />
    <rect x="32.5" y="24.5" width="16" height="14" fill="url(#w-glow)" />
    <rect x="51.5" y="24.5" width="16" height="14" fill="url(#w-glow)" opacity="0.85" />
    <rect x="32.5" y="41" width="16" height="12.5" fill="url(#w-glow)" opacity="0.7" />
    <rect x="51.5" y="41" width="16" height="12.5" fill="url(#w-glow)" opacity="0.9" />
    <rect x="49" y="22" width="2" height="34" fill="#6d5741" />
  </svg>
);

const Street = () => (
  <svg viewBox="0 0 100 78" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="s-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#bcd0dd" /><stop offset="1" stopColor="#efdcc4" />
      </linearGradient>
      <linearGradient id="s-road" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#b3aa9d" /><stop offset="1" stopColor="#8d8478" />
      </linearGradient>
    </defs>
    <rect width="100" height="78" fill="url(#s-sky)" />
    <path d="M36 78 L46 34 H54 L64 78 Z" fill="url(#s-road)" />
    <path d="M0 34 H36 V78 H0 Z" fill="#9c8b78" />
    <path d="M64 34 H100 V78 H0 Z" fill="#8a7a68" opacity="0.9" />
    <g fill="#7d6a58">
      <rect x="4" y="12" width="24" height="46" /><rect x="72" y="6" width="26" height="52" />
    </g>
    <g fill="#f3e2c8" opacity="0.55">
      <rect x="8" y="18" width="5" height="7" /><rect x="17" y="18" width="5" height="7" />
      <rect x="8" y="31" width="5" height="7" /><rect x="17" y="31" width="5" height="7" />
      <rect x="78" y="14" width="5" height="7" /><rect x="88" y="14" width="5" height="7" />
      <rect x="78" y="27" width="5" height="7" /><rect x="88" y="27" width="5" height="7" />
    </g>
    <g stroke="#f6efe0" strokeWidth="1.4" opacity="0.75">
      <line x1="50" y1="46" x2="50" y2="52" /><line x1="50" y1="58" x2="50" y2="66" />
      <line x1="50" y1="72" x2="50" y2="78" />
    </g>
    <ellipse cx="50" cy="36" rx="30" ry="7" fill="#fff2d8" opacity="0.35" />
  </svg>
);

const Shop = () => (
  <svg viewBox="0 0 100 78" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="p-front" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#e3d0b3" /><stop offset="1" stopColor="#c9b291" />
      </linearGradient>
      <linearGradient id="p-glass" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#6d5a48" /><stop offset="1" stopColor="#3f3428" />
      </linearGradient>
    </defs>
    <rect width="100" height="78" fill="url(#p-front)" />
    <path d="M6 26 H94 L88 40 H12 Z" fill="#c05a4c" />
    <g fill="#e8e0d2" opacity="0.55">
      <path d="M18 26 H30 L26 40 H15 Z" /><path d="M42 26 H54 L50 40 H39 Z" />
      <path d="M66 26 H78 L74 40 H63 Z" />
    </g>
    <rect x="14" y="42" width="34" height="28" rx="1.5" fill="url(#p-glass)" />
    <rect x="56" y="42" width="30" height="28" rx="1.5" fill="url(#p-glass)" />
    <g fill="#d8a86a" opacity="0.8">
      <rect x="18" y="52" width="4" height="12" /><rect x="24" y="49" width="4" height="15" />
      <rect x="30" y="53" width="4" height="11" /><rect x="60" y="50" width="4" height="14" />
      <rect x="66" y="54" width="4" height="10" />
    </g>
    <rect x="0" y="70" width="100" height="8" fill="#a08f79" />
    <rect x="10" y="14" width="80" height="8" rx="2" fill="#7a5c46" opacity="0.9" />
  </svg>
);

type Shot = {
  id: string;
  scene: React.ReactNode;
  caption: string;
  /** where it sits; rotation and scale are applied on the inner card */
  style: React.CSSProperties;
  rot: number;
  scale: number;
  /** how near the front it sits, 0..1 */
  depth: number;
};

const SHOTS: Shot[] = [
  { id: "bench",  scene: <Bench />,  caption: "we sat here every Sunday",
    style: { top: "13%", left: "4%" } as React.CSSProperties,  rot: -6.5, scale: 1,    depth: 1 },
  { id: "window", scene: <Window />, caption: "her window, third floor",
    style: { top: "54%", left: "8%" } as React.CSSProperties,  rot: 5,    scale: 0.94, depth: 0.72 },
  { id: "street", scene: <Street />, caption: "the last time I saw him",
    style: { top: "15%", right: "5%" } as React.CSSProperties, rot: 5.5,  scale: 1.02, depth: 0.95 },
  { id: "shop",   scene: <Shop />,   caption: "my first bookshop, 1987",
    style: { top: "56%", right: "6%" } as React.CSSProperties, rot: -5,   scale: 0.96, depth: 0.8 },
];

export default function Polaroids() {
  const wrap = useRef<HTMLDivElement | null>(null);

  // A little parallax: nearer photographs move further than distant ones.
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = wrap.current;
    if (!el) return;

    // Eased toward the pointer each frame rather than transitioned on every
    // event — a CSS transition on a stream of pointer moves rubber-bands.
    let frame = 0;
    let wantX = 0, wantY = 0, atX = 0, atY = 0;

    const onMove = (event: PointerEvent) => {
      wantX = (event.clientX / window.innerWidth - 0.5) * 2;
      wantY = (event.clientY / window.innerHeight - 0.5) * 2;
    };

    const tick = () => {
      atX += (wantX - atX) * 0.07;
      atY += (wantY - atY) * 0.07;
      el.style.setProperty("--px", atX.toFixed(4));
      el.style.setProperty("--py", atY.toFixed(4));
      frame = requestAnimationFrame(tick);
    };
    tick();

    window.addEventListener("pointermove", onMove);
    return () => { window.removeEventListener("pointermove", onMove); cancelAnimationFrame(frame); };
  }, []);

  return (
    <div className="polaroids" ref={wrap} aria-hidden="true">
      {SHOTS.map((shot, i) => (
        <figure
          key={shot.id}
          className="polaroid"
          style={{ ...shot.style, "--depth": shot.depth } as React.CSSProperties}
        >
          <span
            className="polaroid-card"
            style={{
              "--rot": `${shot.rot}deg`,
              "--scale": shot.scale,
              "--in": `${0.2 + i * 0.11}s`,
            } as React.CSSProperties}
          >
            <span className="polaroid-shot">{shot.scene}</span>
            <figcaption>{shot.caption}</figcaption>
          </span>
        </figure>
      ))}
    </div>
  );
}
