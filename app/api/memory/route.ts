import { NextResponse } from "next/server";
import { askGeminiJson, askGeminiVision } from "../../../lib/gemini";

export const runtime = "nodejs";

/**
 * Checks a memory before it is allowed anywhere near the map.
 *
 * A memory is a stranger's words pinned to a real place, and it may name a real
 * person. That combination is the whole appeal and the whole risk, so the rules
 * are deliberately narrow: first names only, no way to identify or contact
 * anyone, nothing aimed at a private address.
 */

const CONTACT = /(\+?\d[\d\s\-()]{7,}\d)|([\w.+-]+@[\w-]+\.[\w.]{2,})|(\b(?:instagram|whatsapp|telegram|snapchat|facebook|twitter|linkedin)\b)|(@[A-Za-z0-9_]{3,})|(https?:\/\/\S+)/i;

type Body = {
  text?: string;
  place?: string;
  city?: string;
  shareAsMystery?: boolean;
  /** data: URL of a photo the player attached. */
  photo?: string;
};

/** Looks at an attached photo and says whether it may be pinned in public. */
const askGeminiPhoto = async (mime: string, base64: string, caption: string) => {
  const result = await askGeminiVision<{ allow?: boolean; reason?: string }>({
    mime,
    base64,
    prompt:
`Someone wants to pin this photograph to a public place on a map, with this caption:
"""${caption}"""

Allow it only if ALL of these hold:
- It is an ordinary personal or place photograph — a street, a building, a view, a group of people, an object, a document.
- It contains no nudity, sexual content, gore, or violence.
- It is not hateful, harassing, or a threat.
- It shows no readable personal information: no ID cards, addresses, number plates in close-up, phone screens with messages, bank details.
- It is not an advertisement or spam.

A photo with recognisable faces is fine — people photograph their friends. Reject only if it looks intended to expose or shame someone.

Return JSON: {"allow":true|false,"reason":"<one short sentence, addressed to the person posting>"}`,
  });
  return result;
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const text = (body.text ?? "").trim().replace(/\s+/g, " ");

  if (text.length < 12) {
    return NextResponse.json({ ok: false, reason: "Say a little more than that." }, { status: 400 });
  }
  if (text.length > 400) {
    return NextResponse.json({ ok: false, reason: "Keep it under 400 characters." }, { status: 400 });
  }
  if (CONTACT.test(text)) {
    return NextResponse.json({
      ok: false,
      reason: "Leave out phone numbers, emails and handles. If someone finds this, they can reply to you through here.",
    }, { status: 400 });
  }

  // A photograph pinned to a real place needs looking at, not just the words
  // beside it. Checked before it is ever uploaded anywhere.
  if (body.photo) {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(body.photo);
    if (!match) {
      return NextResponse.json({ ok: false, reason: "Photos must be JPEG, PNG or WebP." }, { status: 400 });
    }
    if (match[2].length > 3_500_000) {
      return NextResponse.json({ ok: false, reason: "That photo is too large — under 2 MB please." }, { status: 400 });
    }

    const photoVerdict = await askGeminiPhoto(match[1], match[2], text);
    if (photoVerdict === null) {
      return NextResponse.json({
        ok: false,
        reason: "Could not check the photo right now. Try again in a moment, or post without it.",
      }, { status: 503 });
    }
    if (!photoVerdict.allow) {
      return NextResponse.json({
        ok: false,
        reason: photoVerdict.reason ?? "That photo cannot be posted.",
      }, { status: 422 });
    }
  }

  // Without a model we still enforce the mechanical rules above, but we will
  // not pretend the content has been read.
  const verdict = await askGeminiJson<{
    allow?: boolean;
    reason?: string;
    cleaned?: string;
  }>({
    tier: "cheap",
    timeoutMs: 15_000,
    prompt:
`You are checking a short memory that someone wants to pin to a public place in ${body.city ?? "a city"}${body.place ? `, near ${body.place}` : ""}. Other people will find it there.

The memory:
"""${text}"""

Allow it only if ALL of these hold:
- It reads as a genuine personal memory or message about a place.
- Any people mentioned are referred to by FIRST NAME ONLY — no surnames, no workplace, no school, no anything that would let a stranger identify them.
- It does not contain contact details, links or social handles.
- It is not abuse, harassment, a threat, sexual content, or an accusation against a named person.
- It does not point at a private home or reveal where someone lives.
- It is not advertising or spam.

A message hoping someone sees it and gets in touch is fine — that is the point — as long as it names no more than a first name.

If it is allowable but has a surname or an identifying detail, set "cleaned" to the same text with only that detail removed. Change nothing else. Never rewrite their voice.

Return JSON: {"allow":true|false,"reason":"<one short sentence, addressed to the writer>","cleaned":"<text or empty>"}`,
  });

  if (!verdict) {
    return NextResponse.json({
      ok: false,
      reason: "Could not check this right now. Please try again in a moment.",
    }, { status: 503 });
  }

  if (!verdict.allow) {
    return NextResponse.json({
      ok: false,
      reason: verdict.reason ?? "This one cannot be posted.",
    }, { status: 422 });
  }

  const cleaned = (verdict.cleaned ?? "").trim();
  return NextResponse.json({
    ok: true,
    // the model may have removed an identifying detail; never let it rewrite the rest
    text: cleaned && cleaned.length >= 12 && cleaned.length <= 400 ? cleaned : text,
    edited: Boolean(cleaned) && cleaned !== text,
  });
}
