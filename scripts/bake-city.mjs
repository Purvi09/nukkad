#!/usr/bin/env node
//
// Bake a city's cases from Google's OpenStreetMap dataset.
//
//   node scripts/bake-city.mjs "Lisbon"
//
// What it does, in order:
//   1. Geocode the city.
//   2. Ask BigQuery for objects OSM has explicitly tagged as historical.
//   3. Throw out anything you could not stand on — regions, unnamed things,
//      anything sprawling across more than a couple of hundred metres.
//   4. Follow each object's wikidata/wikipedia tag to its article, which is
//      where the story lives. OSM says *where*; Wikipedia says *what*.
//   5. Have Gemini write each into a clue.
//   6. Write the finished pool to Firestore, where the game already looks.
//
// The last step matters: the app reads `cases/{city}` before calling Gemini, so
// a baked city simply arrives pre-cached. No app changes needed.

import { readFileSync } from "node:fs";
import { query } from "./bigquery.mjs";

// ---- config ---------------------------------------------------------------

const RADIUS_M = 1200;              // must match the game's playable radius
const MAX_SPAN_M = 220;             // anything wider is a district, not a spot
const POOL = 14;
const UA = "patchamomma-bake/0.1 (hackathon project)";

/** OSM tags that mean "something happened here". */
const HISTORIC = [
  "castle", "monument", "memorial", "ruins", "archaeological_site",
  "battlefield", "fort", "city_gate", "tower", "manor", "palace",
  "church", "temple", "tomb", "aqueduct", "milestone", "building",
];

// ---- env ------------------------------------------------------------------

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const at = l.indexOf("=");
      return [l.slice(0, at).trim(), l.slice(at + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

// ---- 1. geocode -----------------------------------------------------------

const geocode = async (city) => {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", city);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  const [hit] = await r.json();
  if (!hit) throw new Error(`No city called "${city}".`);
  return { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), label: hit.display_name };
};

// ---- 2. BigQuery: what OSM calls historical -------------------------------

const SQL = `
WITH box AS (
  SELECT ST_GEOGPOINT(@lon, @lat) AS centre
),
tagged AS (
  SELECT
    f.osm_id,
    f.feature_type,
    ST_CENTROID(f.geometry) AS centre_point,
    ST_MAXDISTANCE(f.geometry, ST_CENTROID(f.geometry)) * 2 AS span_m,
    (SELECT value FROM UNNEST(f.all_tags) WHERE key = 'name') AS name,
    (SELECT value FROM UNNEST(f.all_tags) WHERE key = 'historic') AS historic,
    (SELECT value FROM UNNEST(f.all_tags) WHERE key = 'tourism') AS tourism,
    (SELECT value FROM UNNEST(f.all_tags) WHERE key = 'wikidata') AS wikidata,
    (SELECT value FROM UNNEST(f.all_tags) WHERE key = 'wikipedia') AS wikipedia
  FROM \`bigquery-public-data.geo_openstreetmap.planet_features\` f, box
  WHERE ST_DWITHIN(f.geometry, box.centre, @radius)
    AND EXISTS (
      SELECT 1 FROM UNNEST(f.all_tags) t
      WHERE (t.key = 'historic' AND t.value IN UNNEST(@historic))
         OR (t.key = 'tourism'  AND t.value IN ('museum', 'artwork'))
    )
)
SELECT
  osm_id, feature_type, name, historic, tourism, wikidata, wikipedia,
  ST_X(centre_point) AS lon,
  ST_Y(centre_point) AS lat,
  span_m
FROM tagged, box
WHERE name IS NOT NULL
  AND span_m < @maxSpan
ORDER BY (wikidata IS NOT NULL) DESC, span_m ASC
LIMIT 120
`;

// ---- 4. the story behind each place ---------------------------------------

const summaryFor = async (place) => {
  // Prefer the article OSM points at; fall back to searching by name.
  let title = null;
  if (place.wikipedia?.includes(":")) title = place.wikipedia.split(":").slice(1).join(":");

  if (!title && place.wikidata) {
    const r = await fetch(
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${place.wikidata}` +
      `&props=sitelinks&sitefilter=enwiki&format=json`,
      { headers: { "User-Agent": UA } },
    );
    const d = await r.json();
    title = d?.entities?.[place.wikidata]?.sitelinks?.enwiki?.title ?? null;
  }
  if (!title) title = place.name;

  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("titles", title);
  url.searchParams.set("prop", "extracts");
  url.searchParams.set("exintro", "1");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("exsentences", "4");
  url.searchParams.set("redirects", "1");

  const r = await fetch(url, { headers: { "User-Agent": UA } });
  const pages = Object.values((await r.json())?.query?.pages ?? {});
  const extract = pages[0]?.extract?.replace(/\s+/g, " ").trim();
  return extract && extract.length > 90 ? { title: pages[0].title, extract } : null;
};

// ---- run ------------------------------------------------------------------

const cityName = process.argv.slice(2).join(" ").trim();
if (!cityName) {
  console.error("usage: node scripts/bake-city.mjs \"Lisbon\"");
  process.exit(1);
}

console.log(`\nBaking ${cityName}\n`);

const centre = await geocode(cityName);
console.log(`1. ${centre.label.split(",").slice(0, 2).join(", ")}  (${centre.lat.toFixed(4)}, ${centre.lon.toFixed(4)})`);

console.log("2. asking BigQuery what OpenStreetMap calls historical…");
const places = await query(SQL, {
  params: { lat: centre.lat, lon: centre.lon, radius: RADIUS_M, maxSpan: MAX_SPAN_M, historic: HISTORIC },
  maxGb: 60,
  label: "historic features",
});
console.log(`   found ${places.length} tagged places`);
if (places.length === 0) {
  console.log("\n   Nothing tagged historical here. The game will fall back to Overpass.\n");
  process.exit(0);
}

const withArticle = places.filter((p) => p.wikidata || p.wikipedia);
console.log(`   ${withArticle.length} of them link to an article`);

console.log("3. reading the stories…");
const cases = [];
for (const place of [...withArticle, ...places.filter((p) => !p.wikidata && !p.wikipedia)]) {
  if (cases.length >= POOL) break;
  const story = await summaryFor(place);
  if (!story) continue;
  cases.push({ ...place, title: story.title, summary: story.extract });
  console.log(`   · ${story.title}`);
}

console.log(`\n4. ${cases.length} cases ready.`);
console.log("   Next: clue-writing and the Firestore write (scripts/write-cases.mjs)\n");

// hand off as JSON so the writing step is separate and re-runnable
process.stdout.write(JSON.stringify({ city: cityName, centre, cases }, null, 2));
