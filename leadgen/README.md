# Underwings LeadGen

Continuous, multi-source, AI-scored lead generator that writes into the
**`Leads`** tab of the `Underwings_Outbound_Tracker_v2` Google Sheet.

Zero npm dependencies — pure Node 20 (`fetch` + `crypto`). Runs as the
`underwings-leadgen` docker-compose service (`node run.js --loop`).

## Pipeline
```
gather (6 source types) → dedupe (vs sheet + state/seen.json)
  → website-email enrichment → Claude scores vs ICP → write rows
```

## Sources
| # | Source | Key | Status |
|---|--------|-----|--------|
| 1 | OpenStreetMap Overpass (UAE businesses by sector) | none | live |
| 2 | Wikidata SPARQL (UAE companies) | none | live |
| 3 | Google News RSS (intent/trigger events) | none | live |
| 4 | Google Places API | `GOOGLE_PLACES_API_KEY` | gated |
| 5 | Firecrawl web search | `FIRECRAWL_API_KEY` | gated |
| 6 | Firecrawl directory (DMCC/DIFC/etc.) | `FIRECRAWL_API_KEY` | gated |

Enable 4–6 by adding the keys to `underwings/.env` and `docker compose up -d leadgen`.

## Tuning
Everything is in `config.js`: ICP text, target sectors, Overpass categories,
news queries, `maxCandidatesPerRun`, `intervalMinutes`, Claude model/batch size.

## Sheet layout (16 cols A–P, headers row 1, data row 2)
`# | Company | Title | Industry | Service | Email | Status | Notes | Website |
Phone | Emirate/Location | AI Score | Source | Date Added | All Emails | Contact Source`
- A `Dashboard` tab shows Total / with-Email / with-Phone / Avg Score + breakdowns
  by Status, Service, and Source (pure formulas, ranges to row 1000).
- We never fabricate contact names or emails — emails come only from the
  source, website scrape, or Hunter.io.
- ⚠️ Don't manually delete/move columns — the writer is hard-mapped to A–P
  (`run.js` `toRow()`); change layout in code + sheet together.

## Contact enrichment (emails + phones)
Runs after Claude scoring, per kept lead:
1. **Website scrape** (free) — `lib/contacts.js` fetches the homepage + discovered
   contact/about/team pages, grabs every email + `tel:` phone, picks the best
   role-based address. Fills `Email`, `Phone`, `All Emails`, `Contact Source`.
2. **Hunter.io** (gated on `HUNTER_API_KEY`, Phase 3) — fallback when scraping found
   no email; capped at `config.hunter.monthlyCap` (default 40/mo).

## Cost caps (lib/budget.js)
Paid APIs are hard-capped per calendar month, persisted in `state/usage.json`:
- **Places**: `config.places.monthlyCap` = 9000 (free SKU is 10k/mo; real use ≈480/mo).
- **Hunter**: `config.hunter.monthlyCap` = 40.
Once a cap is hit the source stops making calls until the month rolls over.

## Enabling Google Places (more phones + websites → more emails)
1. Key already in `.env` (`GOOGLE_PLACES_API_KEY`). It lives in GCP project `1038941374552`.
2. Enable **Places API (New)** in *that* project + confirm billing:
   https://console.developers.google.com/apis/api/places.googleapis.com/overview?project=1038941374552
3. No redeploy needed — `places()` returns data on the next 6h cycle automatically.

## Uptime monitoring (Uptime Kuma)
After each successful cycle `run.js` pings `KUMA_PUSH_URL` (if set). To enable:
1. In Uptime Kuma create a **Push** monitor (heartbeat interval ~25200s / 7h to cover
   the 6h cycle + grace).
2. Copy its push URL, add `KUMA_PUSH_URL=...` to `underwings/.env`, then
   `docker compose up -d leadgen`. Kuma goes red if a cycle is missed.

## Run manually (one-shot)
```bash
cd /home/deployer/underwings/leadgen
export ANTHROPIC_API_KEY=$(grep ^ANTHROPIC_API_KEY= ../.env | cut -d= -f2-)
docker run --rm --user 1000:1000 \
  -v "$PWD":/app \
  -v /home/deployer/.claude/underwings-analytics-4d74c6459289.json:/app/sa.json:ro \
  -e ANTHROPIC_API_KEY -w /app node:20-alpine node run.js
```

## Logs
```bash
docker logs -f underwings-leadgen
```

## Credentials
- Google service account: `leadgen@underwings-analytics.iam.gserviceaccount.com`
  (Sheets + Drive APIs enabled in project `underwings-analytics`; sheet shared as Editor).
- Key file mounted read-only at `/app/sa.json` from `~/.claude/underwings-analytics-*.json`.
- Anthropic key from `underwings/.env`.

## Compliance (PDPL)
Business-contact data only; no fabricated personal data; respects source
rate limits. Keep sources lawful and honor any suppression list.
