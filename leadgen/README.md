# Underwings LeadGen (v2)

Continuous, multi-source, AI-scored lead generator that writes into
**`crm_prospects`**, where the **LeadGen view** at crm.underwings.org picks
it up. v2 (2026-08-02) replaced the Google Sheets writer; the sheet
(`Underwings_Outbound_Tracker_v2` / `OSINT_LEADS`) is now a frozen archive.

Zero npm dependencies — pure Node 20 (`fetch` + `crypto`). Runs as the
`underwings-leadgen` docker-compose service (`node run.js --loop`).

## Pipeline

```
gather (9 sources) → interleave → dedupe (vs crm_prospects + state/seen.json)
  → Claude scores vs the ICP → threshold + sort by score
  → website discovery → contact scrape → Apollo person search → email reveal
  → Claude drafts a hook-led cold email per lead
  → upsert crm_prospects (+ crm_prospect_contacts)
  → 30-day refresh / re-verify pass → draft backfill for draft-less rows
```

Apollo replaced Hunter on 2026-08-02: the search picks the best security/IT/
compliance title at the domain (server-side title filter + client-side rank),
the reveal unlocks that one person's work email with its verification status.
Search and reveal are budgeted separately so a search that finds no one never
burns an email credit.

Between cycles it polls `crm_leadgen_settings.run_requested_at`, which is how
the CRM's **Run now** button works — the browser can't reach this container
(CSP `connect-src 'self'`, and no route exists), so the request travels
through the database.

## Sources

| # | Source | Key | Status |
|---|--------|-----|--------|
| 1 | OpenStreetMap Overpass (UAE businesses by sector) | none | live, rotates 6 of 16 categories per cycle |
| 2 | Wikidata SPARQL (UAE-registered organisations) | none | live |
| 3 | Wikipedia categories (UAE companies with no Wikidata website) | none | live, 4 of 12 categories per cycle |
| 4 | GitHub orgs by UAE location | none | live, 2 of 8 locations per cycle |
| 5 | Google News RSS (breach + compliance triggers, `en-AE`) | none | live |
| 6 | Firecrawl web search (template × emirate matrix) | `FIRECRAWL_API_KEY` | live, capped |
| 7 | Trade-show exhibitor directories | `FIRECRAWL_API_KEY` | **disabled** — no verifiable UAE show directory, see `config.js` |
| 8 | Google Places (New) | `GOOGLE_PLACES_API_KEY` | live if the API is enabled in GCP |
| 9 | Certificate Transparency (crt.sh, `.ae` second levels) | none | live, 1 pattern per cycle (~60s each) |

### The passive OSINT tier (3, 4, 9)

These read **public archives** — Wikipedia, GitHub's public API, CT logs —
never a prospect's own infrastructure. Nothing we do is visible to the
company until a human decides to contact them. `lib/passive.js` serialises
requests per host with a floor interval and jitter, because these are free
services run for everyone and a burst is what earns an IP ban. The cycle
already takes ~10 minutes and nothing downstream is waiting, so being slow
costs nothing.

CT logs are the strongest free UAE filter available: `co.ae` / `net.ae` /
`org.ae` / `gov.ae` / `sch.ae` are UAE organisations by registry policy.
Live-verified limits are in `sources/ctlogs.js` — in particular, leading
wildcards (`%insurance%.ae`) 502 and must not be reintroduced.

A failing source never kills a cycle: `sources/index.js` contains both async
rejections and synchronous throws per source.

## Two tracks: customers and partners

Claude labels every kept lead `kind='customer'` or `kind='partner'`
(migration 014). Partners are firms Underwings collaborates with rather than
sells to — MSPs, system integrators, resellers, audit and accounting firms,
law firms doing data-protection work, insurers writing cyber cover. They used
to be **discarded** as "competitors, not buyers", which threw away the entire
referral and white-label channel.

Partners are a deliberately small trickle: `partners.perCycle` (5) × two
cycles a day ≈ 10/day, because a partner lead is worth something only if
someone actually has the conversation. Customers are unbounded above the
score threshold. The CRM shows them in a separate **Partners** tab, and their
drafted email proposes a collaboration instead of a sale.

## Contacts: all of them

The website scrape keeps **every** address and phone it finds, not just the
best one — `store-pg.toContactRows` writes one `crm_prospect_contacts` row
each, ranked by `confidence` so the primary contact still sorts first and the
extras (role addresses above generic ones) sit below it. Sales work a company
by trying several inboxes; discarding the rest was discarding the reason to
harvest them. The CRM row shows the best contact plus a `+N` badge; the
drawer lists them all.

Two supporting details:

- `parse.deobfuscateEmails` reads `info [at] acme [dot] ae` and friends. UAE
  company sites obfuscate constantly, and a page that writes every address
  that way used to yield nothing.
- Migration 015 makes `(prospect_id, email)` unique, so re-harvesting a
  company can't stack the same address again. The index is on plain columns
  (PostgREST's `on_conflict=` cannot name an expression), which is why
  store-pg lower-cases every address before writing it.

## Who we target

UAE small-to-mid-market organisations in regulated or data-sensitive sectors
carrying an ISO 27001 / NESA / ADHICS / PDPL obligation, without a mature
in-house security team. Everything is in `config.js` — ICP text, sectors,
service lines, query matrices, caps, cadence.

Claude maps each lead to one of the five Underwings service lines and returns
a 1–10 fit score plus a one-line rationale, and labels it customer or partner
(see "Two tracks" above).

Two guards live in `lib/enrich.js` and both matter:

- **The score anchors.** Without explicit anchors (10 = live trigger, 8-9 =
  standing obligation, 6-7 = default, 4-5 = weak, 1-3 = not UAE) scores
  compress onto 6-9 with a third of the list sitting exactly on the
  threshold, and the ranking stops meaning anything.
- **`isNamedCompany()`.** A breach story about "three major UAE
  organisations" scores 8-9 — a breach is the strongest buying signal there
  is — so it lands at the TOP of the sales list while naming nobody you can
  email. The guard is deterministic as well as prompted, because the prompt
  alone did not hold. It is tuned for precision: refusing a real prospect
  costs a customer, so only plural collectives, leading quantifiers,
  anonymity words and parenthetical incident labels are rejected.

## Cold-email drafts

`lib/outreach.js` writes one personalised draft per prospect
(`outreach_subject` / `outreach_body`), drafted AFTER contact harvest so the
greeting can address the named person. The non-negotiable is the **hook**:
the first line must be about the prospect (their breach, their compliance
driver, their industry's framework), never about Underwings. Sales edit the
draft in the CRM drawer, copy it, and send from their own mailbox.

Ownership follows status/notes: the pipeline writes the draft **once** —
at insert, or via the backfill pass, whose `setOutreachDraft` only fills
`outreach_subject IS NULL` — and from then on the columns are sales-owned
(migration 013 extends the column grant). A failed draft batch just leaves
those rows NULL for the next cycle's backfill (capped
`outreach.backfillPerCycle`/cycle).

## Who owns which column

This is the invariant to preserve:

| Columns | Owner | Enforced by |
|---|---|---|
| `status`, `notes`, `outreach_subject`, `outreach_body`, `touch_*` | the sales team, via the CRM | `GRANT UPDATE (…) … TO authenticated` (migrations 011 + 013 + 016 + 017) |
| everything else | this pipeline, as `service_role` | `REVOKE UPDATE … FROM authenticated` |

`lib/store-pg.js` carries the mirror-image allowlist (`SALES_FIELDS` /
`ENRICHMENT_FIELDS`), so the pipeline — which *could* write anything — never
overwrites a human's note. Don't collapse either half.

## Cost control

Paid APIs are capped per calendar month in `crm_leadgen_usage`, keyed on a
**hash of the API key**, not on this directory. That matters because these
keys are shared with the Al Khaznah project: the old per-directory counter
let each project spend its full cap and blow through the real plan at 2×.

Current caps (`config.js`) are a deliberate *split* of each shared plan:

- **Firecrawl** 300/month of the shared 3000 plan (shared with Al Khaznah).
- **Apollo** — Underwings' own key: `apollo-search` 600/mo (people searches,
  0 credits but rate-limited), `apollo-match` 300/mo (email reveals — the
  credit-consuming call), `apollo-org` 600/mo (firmographics). Replaced
  Hunter, whose shared key sat permanently at its plan limit.
  ⚠️ **Apollo is dark on both fronts (2026-08-03).** The key is on the FREE
  plan, so people search/match 403 (`API_INACCESSIBLE`); and the free credit
  balance is now spent, so even `organizations/enrich` 422s "insufficient
  credits". Contacts today come entirely from the free website scrape.
  There are TWO independent latches — `planBlocked()` for the people
  endpoints and `orgCreditsBlocked()` for enrichment — because they run out
  separately, and a credit top-up should revive firmographics even while the
  people endpoints stay paywalled. Each trips on its first failure and logs
  once. Without the org latch, every lead of every cycle burned a monthly
  budget slot (spend-before-call) on a call that could only fail: 123 of 600
  went that way before it was added. After a plan change or top-up,
  `docker compose restart leadgen` re-probes.
- **Places** 9000/month of the free 10k SKU.

Counters are spend-before-call, so a failed request still burns the counter —
over-counting is cheaper than over-spending. If the counters can't be read the
budget fails **closed**: paid sources are skipped, free ones still run.

## Running it

```bash
docker compose run --rm --no-deps leadgen-test        # 149 tests, no network
docker compose run --rm leadgen node run.js --dry     # NB: --dry still SPENDS paid budget
docker compose up -d leadgen                          # 12h loop
docker logs -f underwings-leadgen
```

## Env

`ANTHROPIC_API_KEY`, `SERVICE_ROLE_KEY`, `SUPABASE_URL` (default
`http://kong:8000`); optional `FIRECRAWL_API_KEY`, `APOLLO_API_KEY`,
`GOOGLE_PLACES_API_KEY`, `KUMA_PUSH_URL`. Compose prefers the `LEADGEN_*`
variants so this pipeline's keys can be swapped without touching the rest of
the stack.

## Gotchas

- **`seen.json` is never cleared.** The old pipeline wiped it monthly because
  the sheet was archived and cleared monthly. With a persistent store that
  would re-discover and re-score (re-bill) every company every month.
- **Only Claude-assessed candidates enter `seen.json`.** A batch lost to a
  transient API error is retried next cycle. The upstream Al Khaznah code adds
  candidates unconditionally, so one 500 blacklists 8 companies forever.
- **`load()` throws** on a transport error rather than returning an empty
  store — an empty store silently disables dedupe and re-bills Claude for
  companies we already have.
- **Exhibitor URLs are yearly-changing DATA.** Live-verify with a rendering
  scrape (not `curl`) before adding one: the UAE show sites are SPAs that
  return 200 with an identical shell for any path.
