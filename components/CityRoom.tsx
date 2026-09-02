"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  chatProblem, sendChat, watchChat, type ChatLine, type Explorer,
} from "../lib/presence";
import {
  answerQuestion, askLocal, askProblem, watchAnswers, watchQuestions,
  type Answer, type Question,
} from "../lib/askLocal";
import type { VoiceState } from "../lib/voice";

type Props = {
  city: string;
  citySlug: string;
  name: string;
  people: Explorer[];
  voice: VoiceState;
  onVoice: () => void;
  onClose: () => void;
};

type Tab = "here" | "ask";

const when = (at: number) => {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export default function CityRoom({ city, citySlug, name, people, voice, onVoice, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("here");
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => watchChat(citySlug, setLines), [citySlug]);
  useEffect(() => watchQuestions(citySlug, setQuestions), [citySlug]);
  useEffect(() => watchAnswers(setAnswers), []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines, tab]);

  // Escape closes it. Everything else falls through, so the city is still
  // walkable with the room open — it is a panel, not a modal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const byQuestion = useMemo(() => {
    const map = new Map<string, Answer[]>();
    answers.forEach((a) => {
      const list = map.get(a.questionId) ?? [];
      list.push(a);
      map.set(a.questionId, list);
    });
    return map;
  }, [answers]);

  const say = async () => {
    const bad = chatProblem(draft);
    if (bad) { setProblem(bad); return; }
    setProblem(null);
    const text = draft;
    setDraft("");
    try { await sendChat(citySlug, name, text); }
    catch (e) { setProblem(e instanceof Error ? e.message : "Could not send that."); }
  };

  const ask = async () => {
    const bad = askProblem(asking);
    if (bad) { setProblem(bad); return; }
    setProblem(null);
    const text = asking;
    setAsking("");
    try { await askLocal(citySlug, name, text); }
    catch (e) { setProblem(e instanceof Error ? e.message : "Could not ask that."); }
  };

  const answer = async (questionId: string) => {
    const bad = askProblem(reply);
    if (bad) { setProblem(bad); return; }
    setProblem(null);
    const text = reply;
    setReply("");
    setReplyTo(null);
    try { await answerQuestion(questionId, name, text); }
    catch (e) { setProblem(e instanceof Error ? e.message : "Could not post that."); }
  };

  return (
    <aside className="room panel" role="dialog" aria-label={`People in ${city}`}>
      <header className="room-head">
        <div className="room-tabs">
          <button
            className={tab === "here" ? "room-tab room-tab--on" : "room-tab"}
            onClick={() => setTab("here")}
          >
            In the city · {people.length + 1}
          </button>
          <button
            className={tab === "ask" ? "room-tab room-tab--on" : "room-tab"}
            onClick={() => setTab("ask")}
          >
            Ask a local
          </button>
        </div>
        <button className="chat-close" onClick={onClose}>Esc</button>
      </header>

      {tab === "here" && (
        <>
          <div className="room-voice">
            <button
              className={voice.live ? "hud-button hud-button--primary" : "hud-button hud-button--ghost"}
              onClick={onVoice}
            >
              {voice.live ? "🎙 Leave voice" : "🎙 Join voice"}
            </button>
            <span className="room-voice-note">
              {voice.live
                ? voice.talking.size > 0
                  ? `Connected to ${voice.talking.size}. You hear people as you get near them.`
                  : "Live. Walk up to someone to hear them."
                : "Voice carries by distance — walk closer to hear someone."}
            </span>
          </div>
          {voice.error && <p className="memory-problem">{voice.error}</p>}

          <ul className="room-people">
            <li>
              <span className="room-dot" style={{ background: "#d4708f" }} />
              <strong>{name || "You"}</strong><em>you</em>
            </li>
            {people.map((p) => (
              <li key={p.uid}>
                <span
                  className="room-dot"
                  style={{ background: `#${p.coat.toString(16).padStart(6, "0")}` }}
                />
                <strong>{p.name || "Someone"}</strong>
                {voice.talking.has(p.uid) && <span className="room-mic">🎙</span>}
                <em>{when(p.at)}</em>
              </li>
            ))}
            {people.length === 0 && (
              <li className="room-alone">
                Nobody else is walking here right now. Anything you say will be waiting for them.
              </li>
            )}
          </ul>

          <div className="room-log" ref={logRef}>
            {lines.length === 0 && <p className="room-empty">No one has said anything yet.</p>}
            {lines.map((l) => (
              <p key={l.id} className="room-line">
                <b>{l.name}</b>
                {l.text}
              </p>
            ))}
          </div>

          <form className="room-input" onSubmit={(e) => { e.preventDefault(); void say(); }}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={`Say something to ${city}…`}
              maxLength={240}
            />
            <button className="hud-button hud-button--primary" type="submit" disabled={!draft.trim()}>
              Send
            </button>
          </form>
        </>
      )}

      {tab === "ask" && (
        <>
          <p className="panel-note">
            Ask anything about {city}. Whoever knows will answer here — no meeting up, no numbers
            exchanged.
          </p>

          <form className="room-input" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
            <input
              value={asking}
              onChange={(e) => setAsking(e.target.value)}
              placeholder="Where do locals actually eat near the old town?"
              maxLength={220}
            />
            <button className="hud-button hud-button--primary" type="submit" disabled={asking.trim().length < 8}>
              Ask
            </button>
          </form>

          <div className="room-log room-log--tall">
            {questions.length === 0 && (
              <p className="room-empty">Nothing asked yet. Yours would be the first.</p>
            )}
            {questions.map((q) => {
              const replies = byQuestion.get(q.id) ?? [];
              return (
                <div key={q.id} className="room-q">
                  <p className="room-q-text">{q.text}</p>
                  <p className="room-q-by">{q.name} · {when(q.at)}</p>

                  {replies.map((a) => (
                    <p key={a.id} className="room-a">
                      <b>{a.name}</b>{a.text}
                    </p>
                  ))}

                  {replyTo === q.id ? (
                    <form
                      className="room-input room-input--inline"
                      onSubmit={(e) => { e.preventDefault(); void answer(q.id); }}
                    >
                      <input
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        placeholder="What you know…"
                        maxLength={220}
                        autoFocus
                      />
                      <button className="hud-button hud-button--ghost" type="submit">Post</button>
                    </form>
                  ) : (
                    <button className="room-answer" onClick={() => { setReplyTo(q.id); setReply(""); }}>
                      I know this →
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {problem && <p className="memory-problem">{problem}</p>}
    </aside>
  );
}
