"use client";

import { useEffect, useRef, useState } from "react";

export type ChatWitness = {
  id: string;
  name: string;
  role: string;
  look: string;
  street: string | null;
  setting: string;
  opener: string;
  testimony: string;
  pointer: string | null;
};

type Turn = { from: "player" | "witness"; text: string };

type Props = {
  witness: ChatWitness;
  /** Who vouched for the player, if anyone. */
  sentBy: string | null;
  /** Everything said to this person so far, kept across visits. */
  history: Turn[];
  told: boolean;
  onSay: (turns: Turn[], revealed: boolean) => void;
  onClose: () => void;
};

const SUGGESTIONS = [
  "Where did it happen?",
  "Which part of the city?",
  "What was around it?",
  "Who else would know?",
];

export default function WitnessChat({ witness, sentBy, history, told, onSay, onClose }: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [history, busy]);

  // Esc closes, and keystrokes must not reach the walking controls underneath.
  useEffect(() => {
    const swallow = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onClose(); return; }
      event.stopPropagation();
    };
    window.addEventListener("keydown", swallow, true);
    return () => window.removeEventListener("keydown", swallow, true);
  }, [onClose]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;

    setDraft("");
    setBusy(true);
    setError(null);
    const asked: Turn[] = [...history, { from: "player", text: question }];
    onSay(asked, false);

    try {
      const response = await fetch("/api/witness-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          witness: {
            name: witness.name,
            role: witness.role,
            standing: witness.street ? `on ${witness.street}, ${witness.setting}` : witness.setting,
            testimony: witness.testimony,
            opener: witness.opener,
            sentBy,
            pointer: witness.pointer,
          },
          history,
          question,
          told,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "They turned away.");
      onSay([...asked, { from: "witness", text: data.reply }], !!data.revealed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "They turned away.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-shell" role="dialog" aria-label={`Talking to ${witness.name}`}>
      <header className="chat-head">
        <div>
          <strong>{witness.name}</strong>
          <span>{witness.role}</span>
        </div>
        <button className="chat-close" onClick={onClose}>Esc · leave</button>
      </header>

      <div className="chat-log" ref={logRef}>
        <p className="chat-place">
          {witness.street
            ? `On ${witness.street}${witness.setting ? `, ${witness.setting}` : ""}.`
            : witness.setting
              ? `${witness.setting[0].toUpperCase()}${witness.setting.slice(1)}.`
              : "Somewhere on the street."}
        </p>
        <p className="chat-line chat-line--witness">{witness.opener}</p>
        {history.map((turn, index) => (
          <p
            key={`${turn.from}-${index}`}
            className={turn.from === "player" ? "chat-line chat-line--player" : "chat-line chat-line--witness"}
          >
            {turn.text}
          </p>
        ))}
        {busy && <p className="chat-line chat-line--witness chat-thinking">…</p>}
        {error && <p className="chat-error">{error}</p>}
      </div>

      <div className="chat-suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chip" disabled={busy} onClick={() => send(s)}>{s}</button>
        ))}
      </div>

      <form
        className="chat-input"
        onSubmit={(event) => { event.preventDefault(); send(draft); }}
      >
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`Say anything to ${witness.name}…`}
          disabled={busy}
        />
        <button className="primary-button" type="submit" disabled={busy || !draft.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}
