// Who the player is, as far as other players are concerned.
//
// A first name only, kept locally. It is attached to memories so a stranger
// reading one sees a person rather than "anonymous" — which is most of what
// makes a memory land.

const KEY = "patchamomma.name";

/** Only a first name, and only what is safe to show a stranger. */
export const cleanName = (raw: string) =>
  raw
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")[0]                       // first name only
    .replace(/[^\p{L}\p{M}'’-]/gu, "")   // letters, marks and the joiners in real names
    .slice(0, 20);

export const savedName = (): string => {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
};

export const rememberName = (name: string) => {
  try {
    window.localStorage.setItem(KEY, cleanName(name));
  } catch { /* private browsing: they will be asked again next time */ }
};
