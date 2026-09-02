"use client";

import { useEffect, useState } from "react";

type Props = { lat: number; lon: number; title: string };

/**
 * The real photograph of the place you just found. Plenty of locations have no
 * Street View coverage, so this renders nothing at all rather than a broken
 * frame or Google's grey placeholder.
 */
export default function StreetPhoto({ lat, lon, title }: Props) {
  const [state, setState] = useState<"loading" | "ready" | "none">("loading");
  const src = `/api/streetview?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`;

  useEffect(() => { setState("loading"); }, [src]);

  if (state === "none") return null;

  return (
    <figure className={state === "ready" ? "streetphoto streetphoto--ready" : "streetphoto"}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={`Street View of ${title}`}
        onLoad={() => setState("ready")}
        onError={() => setState("none")}
      />
      <figcaption>The place as it stands today · Google Street View</figcaption>
    </figure>
  );
}
