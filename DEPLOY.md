# Getting the Google Cloud pieces live

Everything here needs your Google account, so these are the steps I could not
run for you. In order — each unblocks the next.

## 1. Billing (unblocks everything)

Your Gemini key is on the free tier: **20 requests per day, per model**. That is
why clues fall back to templates after a few rounds. Cloud credits do not change
this on their own — the *project that owns the API key* has to be billed.

1. https://console.cloud.google.com/freetrial — activate the $300 trial.
2. **Convert the trial to a full account.** Paid tiers are not available while a
   billing account is in trial state; this is the step that is actually blocking
   you.
3. In AI Studio, check which project your Gemini key belongs to. It is often an
   auto-created `Generative Language Client` project with no billing — link the
   billing account to *that* project, not just to the one holding credits.
4. Enable these APIs on it:
   - Generative Language API (Gemini)
   - Places API (New)          — better landmarks for clue stages 3 and 4
   - Street View Static API    — already used on the reveal
   - Cloud Text-to-Speech API  — currently returns 403; not yet enabled

## 2. Firestore (memories stop living in localStorage)

```bash
npm i -g firebase-tools
firebase login
firebase use --add            # pick the project from .env.local
firebase deploy --only firestore:rules,firestore:indexes
```

Then in the console: **Authentication → Sign-in method → Anonymous → Enable**.

Rules are in `firestore.rules`: memories are world-readable, creatable only
against your own uid, never editable, deletable only by their author.

## 3. Cloud Run (a URL to demo)

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud run deploy patchamomma \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-env-vars "GEMINI_API_KEY=...,GOOGLE_MAPS_API_KEY=..." \
  --set-build-env-vars "$(grep '^NEXT_PUBLIC_' .env.local | tr '\n' ',' | sed 's/,$//')"
```

`next.config.ts` is set to `output: "standalone"` and there is a `Dockerfile`,
so `--source .` builds without further setup. Google AI Studio also grants two
free Cloud Run deployments.

Keep `GEMINI_API_KEY` and `GOOGLE_MAPS_API_KEY` **without** the `NEXT_PUBLIC_`
prefix — they are used server-side only and must not reach the browser.

## 4. BigQuery (the "data driven" requirement)

Not built yet. The intent:

- `bigquery-public-data.geo_openstreetmap` — replaces the live Overpass calls,
  which are rate-limited and occasionally 504.
- `bigquery-public-data.wikipedia` pageviews — rank a site's significance by
  actual public attention instead of the keyword heuristics in
  `app/api/history/route.ts`.
- Gameplay events (which site, how far off, how many witnesses) → BigQuery via
  Pub/Sub, then a Looker Studio page over the result.

```bash
bq query --use_legacy_sql=false \
'SELECT feature_type, COUNT(*) c
 FROM `bigquery-public-data.geo_openstreetmap.planet_features`
 WHERE ST_DWithin(geometry, ST_GeogPoint(-9.1393, 38.7223), 1200)
 GROUP BY 1 ORDER BY c DESC LIMIT 20'
```

Run that once billing is on and we will know the shape of the data before
wiring it in.
