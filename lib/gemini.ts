// One place to talk to Gemini.
//
// The free tier allows 20 requests per day *per model*, so a single busy model
// dies quickly. This rotates across models, remembers which ones are spent, and
// falls through to the caller's own fallback only when every model is out.

type Ask = {
  prompt: string;
  /** Ask for strict JSON back. */
  json?: boolean;
  temperature?: number;
  timeoutMs?: number;
  /** Cheap, high-volume calls should start on the smaller models. */
  tier?: "best" | "cheap";
  /**
   * Total wall-clock across the whole rotation. A player is waiting on the
   * other end; past this the caller's own fallback is the better answer.
   */
  budgetMs?: number;
};

/** Best first; the lite models are perfectly good for phrasing work. */
const BEST = [
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
];

const CHEAP = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3-flash-preview",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
];

/** model -> when it is worth trying again. */
const restingUntil = new Map<string, number>();

const QUOTA_REST_MS = 60 * 60 * 1000;   // out of daily quota: leave it alone
const BUSY_REST_MS = 60 * 1000;         // just overloaded: try again shortly

export type GeminiResult = { text: string; model: string } | null;

export async function askGemini({
  prompt, json = true, temperature, timeoutMs = 25_000, tier = "best", budgetMs,
}: Ask): Promise<GeminiResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const now = Date.now();
  const deadline = budgetMs ? now + budgetMs : Infinity;
  const models = (tier === "cheap" ? CHEAP : BEST)
    .filter((m) => (restingUntil.get(m) ?? 0) <= now);

  for (const model of models) {
    const left = deadline - Date.now();
    if (left < 1500) break;
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              ...(json ? { responseMimeType: "application/json" } : {}),
              ...(temperature === undefined ? {} : { temperature }),
            },
          }),
        },
      );

      if (response.status === 429) {
        // spent for the day — do not waste another round trip on it
        restingUntil.set(model, Date.now() + QUOTA_REST_MS);
        continue;
      }
      if (response.status === 503 || response.status === 500) {
        restingUntil.set(model, Date.now() + BUSY_REST_MS);
        continue;
      }
      if (response.status === 404) {
        // retired model: never try it again this process
        restingUntil.set(model, Date.now() + 24 * 60 * 60 * 1000);
        continue;
      }
      if (!response.ok) continue;

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text === "string" && text.trim()) return { text, model };
    } catch {
      // timeout or network: move on to the next model
      restingUntil.set(model, Date.now() + BUSY_REST_MS);
    }
  }

  return null;
}

/**
 * The same rotation, with an image attached. Used for looking at a photograph
 * before it is allowed onto the map.
 */
export async function askGeminiVision<T>({
  prompt, mime, base64, timeoutMs = 25_000, budgetMs,
}: { prompt: string; mime: string; base64: string; timeoutMs?: number; budgetMs?: number }): Promise<T | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const now = Date.now();
  const deadline = budgetMs ? now + budgetMs : Infinity;
  const models = CHEAP.filter((m) => (restingUntil.get(m) ?? 0) <= now);

  for (const model of models) {
    const left = deadline - Date.now();
    if (left < 1500) break;
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: base64 } }],
            }],
            generationConfig: { responseMimeType: "application/json" },
          }),
        },
      );

      if (response.status === 429) { restingUntil.set(model, Date.now() + QUOTA_REST_MS); continue; }
      if (response.status >= 500) { restingUntil.set(model, Date.now() + BUSY_REST_MS); continue; }
      if (!response.ok) continue;

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text === "string" && text.trim()) {
        try { return JSON.parse(text) as T; } catch { continue; }
      }
    } catch {
      restingUntil.set(model, Date.now() + BUSY_REST_MS);
    }
  }
  return null;
}

/** askGemini, plus JSON.parse, returning null on anything unexpected. */
export async function askGeminiJson<T>(ask: Ask): Promise<T | null> {
  const result = await askGemini({ ...ask, json: true });
  if (!result) return null;
  try {
    return JSON.parse(result.text) as T;
  } catch {
    return null;
  }
}
