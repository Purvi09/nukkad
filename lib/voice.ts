// Proximity voice.
//
// Peer-to-peer WebRTC, with Firestore carrying the handshake. Volume falls off
// with distance in the city, so a conversation happens where the people are —
// walk away and it fades, which is the whole point of voice in a place rather
// than voice in a channel.
//
// Peer-to-peer keeps this free: audio never touches a server. The cost is that
// a symmetric NAT with no TURN relay will fail to connect. That is an accepted
// limit here, not an oversight.

import {
  addDoc, collection, deleteDoc, doc, onSnapshot, query, serverTimestamp, where,
} from "firebase/firestore";
import { currentUid, db, firebaseReady } from "./firebase";

const ICE: RTCConfiguration = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
};

/** Full volume within this, silent past the far edge. */
const NEAR_M = 90;
const FAR_M = 420;

type Peer = {
  uid: string;
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  gain: GainNode | null;
  source: MediaStreamAudioSourceNode | null;
};

export type VoiceState = {
  live: boolean;
  talking: Set<string>;
  error: string | null;
};

let mic: MediaStream | null = null;
let actx: AudioContext | null = null;
const peers = new Map<string, Peer>();
let stopSignals: (() => void) | null = null;
let myUid = "";
let myCity = "";
let onChange: ((s: VoiceState) => void) | null = null;
let live = false;

const announce = (error: string | null = null) => {
  onChange?.({
    live,
    talking: new Set(peers.keys()),
    error,
  });
};

const signal = async (to: string, kind: string, payload: unknown) => {
  const store = db();
  if (!store) return;
  await addDoc(collection(store, "signals"), {
    city: myCity, from: myUid, to, kind,
    payload: JSON.stringify(payload),
    at: Date.now(),
    sent: serverTimestamp(),
  });
};

const makePeer = (uid: string): Peer => {
  const pc = new RTCPeerConnection(ICE);
  mic?.getTracks().forEach((track) => pc.addTrack(track, mic as MediaStream));

  const audio = new Audio();
  audio.autoplay = true;
  // routed through WebAudio so distance can control the gain
  audio.muted = true;

  const peer: Peer = { uid, pc, audio, gain: null, source: null };

  pc.onicecandidate = (event) => {
    if (event.candidate) void signal(uid, "ice", event.candidate.toJSON());
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    audio.srcObject = stream;
    void audio.play().catch(() => {});

    if (!actx) actx = new AudioContext();
    if (actx.state === "suspended") void actx.resume();
    peer.source = actx.createMediaStreamSource(stream);
    peer.gain = actx.createGain();
    peer.gain.gain.value = 0;
    peer.source.connect(peer.gain).connect(actx.destination);
    announce();
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) dropPeer(uid);
  };

  peers.set(uid, peer);
  return peer;
};

const dropPeer = (uid: string) => {
  const peer = peers.get(uid);
  if (!peer) return;
  try { peer.pc.close(); } catch { /* already gone */ }
  try { peer.source?.disconnect(); peer.gain?.disconnect(); } catch { /* fine */ }
  peer.audio.srcObject = null;
  peers.delete(uid);
  announce();
};

/**
 * Open the microphone and start listening for anyone else who has.
 * The lower uid always makes the offer, so two people never call each other
 * at the same moment.
 */
export const joinVoice = async (
  city: string,
  report: (s: VoiceState) => void,
): Promise<boolean> => {
  onChange = report;
  const store = firebaseReady ? db() : null;
  const uid = await currentUid();
  if (!store || !uid) { announce("Voice needs a signed-in session."); return false; }

  myUid = uid;
  myCity = city;

  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    announce("Microphone permission was refused.");
    return false;
  }

  live = true;
  announce();

  // anything addressed to me
  const inbox = query(collection(store, "signals"), where("to", "==", myUid));
  stopSignals = onSnapshot(inbox, async (snap) => {
    for (const change of snap.docChanges()) {
      if (change.type !== "added") continue;
      const data = change.doc.data() as { from: string; kind: string; payload: string; city: string };
      void deleteDoc(doc(store, "signals", change.doc.id)).catch(() => {});
      if (data.city !== myCity) continue;

      const payload = JSON.parse(data.payload);
      let peer = peers.get(data.from);

      try {
        if (data.kind === "offer") {
          peer = peer ?? makePeer(data.from);
          await peer.pc.setRemoteDescription(payload);
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          await signal(data.from, "answer", answer);
        } else if (data.kind === "answer" && peer) {
          await peer.pc.setRemoteDescription(payload);
        } else if (data.kind === "ice" && peer) {
          await peer.pc.addIceCandidate(payload);
        } else if (data.kind === "bye") {
          dropPeer(data.from);
        }
      } catch { /* a failed handshake drops that peer, not the session */ }
    }
  });

  return true;
};

/** Call anyone in the city who is also on voice. */
export const callPeers = async (uids: string[]) => {
  if (!live) return;
  for (const uid of uids) {
    if (uid === myUid || peers.has(uid)) continue;
    // deterministic caller, so both sides do not offer at once
    if (myUid > uid) continue;
    const peer = makePeer(uid);
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      await signal(uid, "offer", offer);
    } catch { dropPeer(uid); }
  }
  // anyone who has walked out of the city entirely
  peers.forEach((_, uid) => { if (!uids.includes(uid)) dropPeer(uid); });
};

/** How loud each peer should be, given how far away they are standing. */
export const setDistances = (metres: Record<string, number>) => {
  peers.forEach((peer, uid) => {
    if (!peer.gain) return;
    const d = metres[uid];
    const level = d === undefined ? 0
      : d <= NEAR_M ? 1
      : d >= FAR_M ? 0
      : 1 - (d - NEAR_M) / (FAR_M - NEAR_M);
    // a curve rather than a straight line: closer feels closer
    peer.gain.gain.value = level * level;
  });
};

export const leaveVoice = () => {
  peers.forEach((_, uid) => { void signal(uid, "bye", {}); dropPeer(uid); });
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
  stopSignals?.();
  stopSignals = null;
  live = false;
  announce();
};

export const voiceLive = () => live;
