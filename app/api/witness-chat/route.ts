import { NextResponse } from "next/server";
import { askGeminiJson } from "../../../lib/gemini";

export const runtime = "nodejs";

type Turn = { from: "player" | "witness"; text: string };

type Body = {
  witness?: {
    name?: string; role?: string; standing?: string; testimony?: string; opener?: string;
    sentBy?: string | null; pointer?: string | null;
  };
  history?: Turn[];
  question?: string;
  /** Set once they have already given up what they know. */
  told?: boolean;
};

/** Do they seem to be asking about the thing this person knows? */
const ASKING_ABOUT_IT = /\b(where|which way|direction|how far|near|close|street|road|place|happen|happened|know|remember|tell|heard|saw|when|year|what year)\b/i;
const GREETING = /^\s*(hi|hey|hello|namaste|ola|olá|excuse me|good (morning|evening|afternoon))\b/i;

const DEFLECTIONS = [
  "I've work to do. Ask me something useful.",
  "Plenty happens here. You'll have to be clearer than that.",
  "Mm. And what is it you actually want to know?",
  "I mind my own business, mostly.",
];

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const question = (body.question ?? "").trim();
  const witness = body.witness ?? {};
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];

  if (!question) return NextResponse.json({ error: "Say something." }, { status: 400 });

  // Without a model, answer on keywords. The player still gets the real fact,
  // just without the character work.
  const localReply = () => {
    if (GREETING.test(question) && !ASKING_ABOUT_IT.test(question)) {
      return { reply: witness.opener ?? "Yes? What is it?", revealed: false };
    }
    if (ASKING_ABOUT_IT.test(question)) {
      return { reply: witness.testimony ?? "I couldn't say.", revealed: true };
    }
    const pick = DEFLECTIONS[question.length % DEFLECTIONS.length];
    return { reply: pick, revealed: false };
  };

  const transcript = history
    .map((turn) => `${turn.from === "player" ? "Stranger" : witness.name ?? "You"}: ${turn.text}`)
    .join("\n");

  const parsed = await askGeminiJson<{ reply?: string; revealed?: boolean }>({
    tier: "cheap",
    temperature: 0.9,
    timeoutMs: 20_000,
    prompt:
`You are ${witness.name ?? "a local"}, who ${witness.role ?? "lives around here"}. You are standing ${witness.standing ?? "on the street"}. A stranger has stopped you.

THE ONE THING YOU KNOW:
"${witness.testimony ?? "nothing much"}"
${witness.sentBy ? `${witness.sentBy} sent this stranger to you. You trust ${witness.sentBy}. If they mention that name, warm up a little.` : ""}
${witness.pointer ? `Once you have told them, you also point them onward: "${witness.pointer}"` : ""}

HOW TO SPEAK IT:
- Never quote that line word for word. Say it the way THIS person would say it, in their own rhythm.
- But every concrete detail inside it — compass directions, distances, street names, dates, years — must survive EXACTLY as written. Change "south-east" and you have lied to them.
- Two or three sentences at most. No stage directions, no asterisks, no accents written phonetically.

WHEN TO SPEAK IT — only if they are actually asking about it:
- Asking where it happened, which way, how far, what happened here, what this place was, or when: TELL THEM.
- Anything vaguer than that — "do you know this street?", "been here long?", questions about you: answer in character, in one line, and do NOT tell them. Let them ask properly.
- You know nothing beyond that one line. If they push for more, say plainly that you do not know.
- Never invent another place, date, direction or name. Not even a small one.
${body.told ? "- You have ALREADY told them. Do not say it again in full. One short line referring back to it, and only the specific part they asked about." : ""}

Set "revealed" true only if your reply actually contains the detail.

Conversation so far:
${transcript || "(nothing yet)"}
Stranger: ${question}

Return JSON: {"reply":"...","revealed":true|false}`,
  });

  if (!parsed || typeof parsed.reply !== "string") {
    return NextResponse.json({ ...localReply(), source: "local" });
  }

  return NextResponse.json({
    reply: parsed.reply.slice(0, 400),
    revealed: !!parsed.revealed,
    source: "gemini",
  });
}
