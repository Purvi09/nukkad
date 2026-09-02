"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  /** The public place the memory will be pinned to. */
  place: string;
  city: string;
  onCancel: () => void;
  onPost: (text: string, photo?: string) => Promise<void>;
};

const MAX = 400;

export default function LeaveMemory({ place, city, onCancel, onPost }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  /** Shrink before upload: a phone photo is 4 MB and nobody needs that here. */
  const attach = (file: File) => {
    setProblem(null);
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const max = 1280;
        const scale = Math.min(1, max / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
        setPhoto(canvas.toDataURL("image/jpeg", 0.82));
      };
      image.onerror = () => setProblem("That file could not be read as an image.");
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => { areaRef.current?.focus(); }, []);

  // keep the walking controls from eating what is being typed
  useEffect(() => {
    const swallow = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onCancel(); return; }
      event.stopPropagation();
    };
    window.addEventListener("keydown", swallow, true);
    return () => window.removeEventListener("keydown", swallow, true);
  }, [onCancel]);

  const submit = async () => {
    if (busy || text.trim().length < 12) return;
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch("/api/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, place, city, photo }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setProblem(data.reason ?? "That could not be posted.");
        return;
      }
      await onPost(data.text as string, photo ?? undefined);
    } catch {
      setProblem("Could not reach the server. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="memory-shell panel" role="dialog" aria-label="Leave a memory">
      <p className="panel-title">Leave a memory · {place}</p>

      <p className="panel-note">
        Something that happened to you here. Someone standing in this spot may find it one day.
      </p>

      <textarea
        ref={areaRef}
        value={text}
        maxLength={MAX}
        onChange={(event) => setText(event.target.value)}
        placeholder="I met my friend Ananya here for the last time before she moved away…"
        disabled={busy}
      />

      {photo && (
        <div className="memory-photo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photo} alt="Attached to this memory" />
          <button className="memory-photo-drop" onClick={() => setPhoto(null)} disabled={busy}>
            Remove photo
          </button>
        </div>
      )}

      <div className="memory-meta">
        <span>{text.length}/{MAX}</span>
        <span className="memory-rule">
          First names only · no phone numbers, emails or handles
        </span>
      </div>

      {problem && <p className="memory-problem">{problem}</p>}

      <div className="memory-actions">
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) attach(file);
            event.target.value = "";
          }}
        />
        <button
          className="hud-button hud-button--ghost"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          {photo ? "Change photo" : "＋ Add a photo"}
        </button>
        <span style={{ flex: 1 }} />
        <button className="hud-button hud-button--ghost" onClick={onCancel} disabled={busy}>
          Not now
        </button>
        <button
          className="hud-button hud-button--primary"
          onClick={submit}
          disabled={busy || text.trim().length < 12}
        >
          {busy ? "Checking…" : "Leave it here"}
        </button>
      </div>
    </div>
  );
}
