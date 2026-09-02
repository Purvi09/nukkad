// Sound, synthesised.
//
// Every noise here is generated with WebAudio — there are no audio files to
// load, host, or get wrong. Browsers refuse to make sound until the player has
// interacted, so the context is created lazily on the first gesture.

type Ctx = AudioContext | null;

let ctx: Ctx = null;
let master: GainNode | null = null;
let muted = false;

const KEY = "patchamomma.muted";

export const soundMuted = () => muted;

export const initSound = () => {
  if (ctx) return ctx;
  if (typeof window === "undefined") return null;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.62;
    master.connect(ctx.destination);
    try { muted = window.localStorage.getItem(KEY) === "1"; } catch { /* fine */ }
  } catch {
    ctx = null;
  }
  return ctx;
};

export const toggleMuted = () => {
  muted = !muted;
  try { window.localStorage.setItem(KEY, muted ? "1" : "0"); } catch { /* fine */ }
  return muted;
};

const ready = () => {
  const c = ctx ?? initSound();
  if (!c || muted || !master) return null;
  if (c.state === "suspended") void c.resume();
  return c;
};

/**
 * A pulse wave, the way the NES made them.
 *
 * A plain `square` oscillator is a 50% duty cycle, which is why it sounds flat
 * and organ-ish. The chiptune timbre everyone recognises comes from narrower
 * duties — 12.5% and 25% — which are thinner and much brighter. Built here as a
 * Fourier series: harmonic n has amplitude (2/nπ)·sin(nπd).
 */
const pulseCache = new Map<number, PeriodicWave>();

const pulse = (c: AudioContext, duty: number) => {
  const cached = pulseCache.get(duty);
  if (cached) return cached;

  const harmonics = 28;
  const real = new Float32Array(harmonics);
  const imag = new Float32Array(harmonics);
  for (let n = 1; n < harmonics; n++) {
    imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
  }
  const wave = c.createPeriodicWave(real, imag, { disableNormalization: false });
  pulseCache.set(duty, wave);
  return wave;
};

type ToneOptions = {
  type?: OscillatorType;
  /** 0.125 or 0.25 for a chiptune pulse; overrides `type`. */
  duty?: number;
  gain?: number;
  /** Slide to this frequency over the note, for a chirp. */
  slideTo?: number;
  delay?: number;
  /** Roll the top off the pulse. Raw pulse harmonics are fizzy and tiring. */
  cutoff?: number;
  /** Fraction of the note spent at full level before it decays. */
  hold?: number;
};

const tone = (freq: number, dur: number, o: ToneOptions = {}) => {
  const c = ready();
  if (!c || !master) return;
  const at = c.currentTime + (o.delay ?? 0);

  const osc = c.createOscillator();
  const gain = c.createGain();
  if (o.duty) osc.setPeriodicWave(pulse(c, o.duty));
  else osc.type = o.type ?? "square";
  osc.frequency.setValueAtTime(freq, at);
  if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, at + dur);

  // attack, a moment held, then decay. Without the hold every note is a click.
  const peak = o.gain ?? 0.06;
  const held = at + dur * (o.hold ?? 0.25);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.006);
  gain.gain.setValueAtTime(peak, held);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);

  // The top harmonics of a narrow pulse are what make chiptune tiring at
  // volume. Rolling them off keeps the character and loses the fizz.
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(o.cutoff ?? 3200, at);
  lp.Q.value = 0.7;

  osc.connect(gain).connect(lp).connect(master);
  osc.start(at);
  osc.stop(at + dur + 0.02);
};

// ---------------------------------------------------------------- the cues

let stepFoot = 0;

/**
 * One footfall, in the language of a platformer.
 *
 * Two things make this read as Mario rather than as a thud: a narrow pulse wave
 * instead of a square, and a pitch that jumps *up* on the attack before falling
 * away — the little "bip" of a sprite hitting the ground. The two feet are a
 * perfect fourth apart, so walking has a tune to it.
 */
export const stepSound = (running: boolean) => {
  stepFoot = 1 - stepFoot;

  // A fifth apart, low enough to sit under everything else. Alternating feet
  // give walking a two-note lilt instead of a repeated tick.
  const note = stepFoot ? 329.63 : 220;

  tone(note, running ? 0.09 : 0.12, {
    duty: 0.25,
    gain: running ? 0.05 : 0.042,
    hold: 0.3,
    cutoff: running ? 1800 : 1500,
    slideTo: note * 0.86,
  });
};

/** Something worth looking at just came into range. */
export const nearSound = () => {
  tone(880, 0.1, { duty: 0.25, gain: 0.03, cutoff: 2600, hold: 0.3 });
  tone(1318.51, 0.13, { duty: 0.25, gain: 0.026, delay: 0.07, cutoff: 2600, hold: 0.3 });
};

/** Reading someone's memory: warm, soft, not a game noise. */
export const memorySound = () => {
  // triangle, not pulse: reading someone's memory should not sound like a coin
  [523.25, 659.25, 783.99].forEach((f, i) =>
    tone(f, 0.6, { type: "triangle", gain: 0.05, delay: i * 0.1, hold: 0.35 }));
};

/** Finding a piece of the city's history. The little two-note coin. */
export const discoverSound = () => {
  tone(987.77, 0.1, { duty: 0.25, gain: 0.055, cutoff: 3000, hold: 0.5 });
  tone(1318.51, 0.42, { duty: 0.25, gain: 0.055, delay: 0.1, cutoff: 3000, hold: 0.35 });
};

/** Committing a guess. */
export const markSound = () => {
  tone(659.25, 0.13, { duty: 0.25, gain: 0.052, slideTo: 392, cutoff: 2400, hold: 0.3 });
};

/** How the reveal lands, by how close you were. */
export const revealSound = (metres: number) => {
  if (!Number.isFinite(metres) || metres > 700) {
    tone(196, 0.26, { duty: 0.25, gain: 0.045, cutoff: 1200, hold: 0.4 });
    tone(146.83, 0.5, { duty: 0.25, gain: 0.045, delay: 0.18, cutoff: 1000, hold: 0.4 });
    return;
  }
  const notes = metres < 120
    ? [523.25, 659.25, 783.99, 1046.5]
    : [523.25, 659.25, 783.99];
  notes.forEach((f, i) =>
    tone(f, 0.34, { duty: 0.25, gain: 0.05, delay: i * 0.1, cutoff: 2800, hold: 0.4 }));
};

/** A memory pinned to the world. */
export const leaveSound = () => {
  tone(392, 0.2, { type: "triangle", gain: 0.055, hold: 0.35 });
  tone(587.33, 0.5, { type: "triangle", gain: 0.055, delay: 0.14, hold: 0.35 });
};

/** Any button. */
export const clickSound = () => {
  tone(660, 0.07, { duty: 0.25, gain: 0.035, slideTo: 880, cutoff: 2600, hold: 0.3 });
};

/** Talking to someone. */
export const talkSound = () => {
  tone(440, 0.1, { duty: 0.25, gain: 0.038, cutoff: 2200, hold: 0.3 });
  tone(587.33, 0.14, { duty: 0.25, gain: 0.034, delay: 0.07, cutoff: 2200, hold: 0.3 });
};
