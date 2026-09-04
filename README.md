# Nukkad

*Nukkad* — the street corner. The tea stall, the bench, the place a
neighbourhood gathers and stories go round.

Walk a real city, drawn street for street from open map data. Find the memories
people have left at the places they happened, and leave your own. When you want
more, the city has its own history to find.

> Google Maps shows you where places are. Wikipedia tells you what happened
> there. This shows you what people remember there.

## What it does

**Any city, built on demand.** Type a name and the place assembles in a few
seconds — streets, buildings, parks, street trees — pulled from OpenStreetMap,
projected to metres and drawn isometrically. Lisbon comes back with 1,400 roads,
1,600 buildings and 1,581 trees.

**Memories pinned to real ground.** Leave one anywhere, with a photograph if you
like. Anyone walking that street later can find the heart, stand by it and read
what happened to you there. Every memory carries a first name, so a stranger
finds a person rather than an anonymous note.

**A city you share.** Everyone exploring the same city sees each other walking
it, with names above their heads. There is a text channel per city, questions
you can leave for whoever knows the place, and proximity voice — people fade up
as you walk toward them and fade out as you leave.

**And a game, if you want one.** Real events with real coordinates, drawn from
Wikipedia and written into riddles. Four witnesses stand on real corners, each
one narrowing the search — what happened, which part of the city, what stands
around it, which landmark it sits beside — and each locked until the last one
sends you. One of them is honestly mistaken. Guess the spot and the reveal shows
you the actual Street View photograph of the place.

## Running it

```bash
npm install
npm run dev
```

`.env` (or `.env.local`) needs:

```
GEMINI_API_KEY=…                        # Google AI Studio
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=…       # Street View Static + Geocoding
NEXT_PUBLIC_FIREBASE_API_KEY=…          # and the rest of the Firebase config
```

Everything degrades rather than breaking. Without Gemini the clues fall back to
redacted source text; without Firebase, memories live in browser storage;
without a Maps key, cities are geocoded with Nominatim instead of Google, and
a town Wikipedia has not written up is still walkable, just with no cases to
play.

A city starts as the 2.4 km square around its centre and streams outward in
400 m tiles as you walk, out to about 2.7 km from the centre. Tiles are capped
per tile rather than per city, so a dense city is dense everywhere. Overpass
rations queries per address, so the server asks for tiles two-by-two, one
request at a time, and warms the ring around a fresh city slowly in the
background. Cases and witnesses stay inside the initial square. For a big city,
name the part you mean: "Indiranagar, Bangalore".

## How it is put together

| | |
|---|---|
| Rendering | Pixi.js, isometric, one canvas |
| Map data | OpenStreetMap via Overpass, geocoded with Google (Nominatim as fallback) |
| History | Wikipedia geosearch, filtered so a district can never be an answer |
| Writing | Gemini, rotated across seven models to survive the free tier |
| Storage | Firestore and Firebase Storage, anonymous auth |
| Photographs | Google Street View Static, proxied so the key stays server-side |
| Voice | WebRTC peer to peer, Firestore carrying only the handshake |
| Sound | WebAudio, NES-style pulse waves, no audio files |

`scripts/` holds a BigQuery pipeline that bakes a city's cases from
OpenStreetMap's `historic=*` tags. `DEPLOY.md` covers Firestore, Cloud Run and
the Google Cloud setup.

## Safety

Memories are moderated before they are stored: first names only, no contact
details, nothing aimed at a private address, and photographs are checked by
Gemini vision before they are uploaded anywhere. Firestore rules make every
memory append-only and deletable only by whoever left it.
