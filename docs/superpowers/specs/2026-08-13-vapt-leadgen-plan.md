# VAPT LeadGen — dedicated pipeline for UAE pen-testing buyers

**Date:** 2026-08-13 · **Status:** plan, awaiting approval
**Owner systems:** `leadgen/` (harvest), `supabase/migrations/` (schema),
`crm/` (VAPT Leads tab)

## Why a separate track

The shared pipeline maps almost everything to GRC: **327 GRC prospects vs 4
pen-testing** as of today. The ICP narrative is written in compliance
vocabulary, so a regulated UAE company scores as an ISO buyer every time.
Pen-test buyers are a different animal — they *operate software*, and their
trigger is an app estate, a PCI mandate, or a breach, not a certification
project. Mixing the two in one queue buries the VAPT motion.

Contact quality is the second gap: only **655 of 11,140 contacts (5.9%) carry
a phone number**, and most scraped emails are `info@` with no named person.
UAE B2B closes on the phone; a VAPT queue without phones is half a queue.

## Deliverable

A **VAPT Leads tab** in crm.underwings.org fed by its own harvest track, where
every prospect targets a UAE organisation that plausibly buys penetration
testing, and arrives with the most reliable contact data we can get without
paid enrichment: a verified-deliverable email AND a phone number wherever one
exists publicly.

### KPI (definition of working)

- ≥ 50 `vapt` prospects with a non-invalid email within the first week of the
  track running.
- ≥ 40% of `vapt` prospects carry at least one phone number (Places-backed;
  the general queue sits at 5.9% today).
- Zero regression in the existing customer/partner/blead tracks.

---

## Phase V1 — schema + VAPT Leads tab

**Migration 022** (pattern: migration 020 `blead`):
- Extend `crm_prospects_kind_check` to `('customer','partner','blead','vapt')`.
- `v_crm_leadgen_stats` already GROUPs BY kind — a `vapt` row appears with no
  view change (verified when blead shipped).

**CRM (all established patterns from the BLead tab + today's Leads dropdown):**
- `LG_VIEW_KIND.vapt = 'vapt'`; new item in the Leads dropdown (icon ⌖,
  label "VAPT", live count picked up automatically by `crmLoadNavCounts` —
  it reads the stats view with no kind filter).
- `crmApplyLeadgenCopy` variant: eyebrow "VAPT pipeline", title "UAE
  pen-testing buyers", sub-line naming the motion.
- ⌘K entry "Go to VAPT Leads".
- Panel attribute becomes `data-crm-view-panel="leadgen partners blead vapt"`.

**Deliberately not done:** no per-row UI changes — ticks, notes, drawer,
follow-up queue, and CSV export all work by kind already.

## Phase V2 — VAPT harvest track

A second ICP config namespace (`cfg.vapt`) run by the same container in the
same loop — no new service, no new container. Rows write `kind='vapt'`,
`service='PTaaS / Pen Testing'` (fixed; the scorer classifies fit, not
service).

**VAPT ICP (scored by a dedicated prompt variant in `lib/enrich.js`):**
UAE organisations, 30–250 staff (enterprise exclusion unchanged), that
**operate customer-facing software**: fintech and payments (CBUAE/DFSA/FSRA
licensed — annual pen-test mandates), e-commerce and retail platforms, SaaS
and app companies, online booking/hospitality, healthcare portals (ADHICS
requires VAPT), logistics tracking platforms. Score anchors:
- 10 — named breach victim, or a live tender with pen-test scope.
- 8–9 — regulated fintech/payments licence, or a customer-facing app estate
  plus a compliance mandate (PCI, ADHICS).
- 6–7 — ships software, no visible mandate. Default; do not inflate.
- ≤5 — brochure-site company; no software estate (that's the GRC track's
  prospect, not ours).

**Source mix for this track** (same source modules, VAPT parameters):
- `github.js` — UAE orgs ARE dev shops; signal prefixed
  `"ships software — UAE GitHub organisation"` so the scorer always sees it
  (today the signal is the org bio, usually empty).
- `websearch.js` — VAPT template set: fintech / payment gateway / e-commerce
  platform / SaaS company / mobile app company × emirate.
- `news.js` — named breach/incident victims route to the VAPT track (a
  breach buys a pen test, not an ISO project).
- `ctlogs.js` — domains whose certificates include `app.`/`api.`/`portal.`
  names get a "operates web applications" signal hint.
- `places.js` — runs for the VAPT queries too; it is the phone source.

**Dedupe:** the existing domain-level dedupe stands — a company already in
the GRC track does not re-enter as vapt. One company, one row, one owner of
the relationship.

## Phase V3 — contact reliability tier

Goal: **email you can send to + phone you can dial**, per prospect.

1. **Phone backfill via Places details** — for vapt rows with no phone,
   look up `displayName + region` on the cheap-SKU field mask
   (`nationalPhoneNumber` is already in it); write to
   `crm_prospect_contacts.phone` with `source='places'`, high confidence.
   Existing tel:-link website scrape continues to run first (free).
   Monthly cap honoured via the existing `lib/budget.js` ledger.
2. **Email ladder (all existing plumbing, sequenced):** website mailto scrape
   → MX deliverability pass (kills dead domains) → Brevo bounce webhook
   flags hard bounces → Apollo person reveal *when the plan converts to paid*
   (the latch in `lib/apollo.js` already no-ops on trial).
   **Rejected:** SMTP RCPT probing — burns this box's sending reputation.
3. **"Has phone" reachability filter in the CRM** — sibling of "Has email":
   inner-join embed on `crm_prospect_contacts.phone not null`. The drawer
   already renders phones as tel: links (crm.js:1596); no drawer work.
4. **Confidence discipline:** `places` phone = high; scraped `info@` = low;
   Apollo-verified = high. Already an int column; the pipeline sets it.

**⚠️ User-owned prerequisites (called out, not blocking V1–V2):**
- Convert Apollo Basic trial → paid to unlock person-level verified emails
  and titles (the single biggest email-quality lever).
- Confirm the Brevo bounce webhook is registered in the Brevo dashboard
  (pipeline-side code shipped 2026-08-07).

## Phase V4 — VAPT outreach voice

The fixed outreach skeleton (`composeEmail`) stays; the VAPT track gets its
own AI-slot guidance: the hook references the prospect's *software estate*
("your customer portal / payment flow"), the service list is pen-test-first
(PTaaS retainer, web/mobile/app VAPT, cloud config review), and the CTA keeps
the 15-minute honesty framing. Bleads' fallback template behaviour is the
model — VAPT rows must never inherit the generic compliance voice.

## Verification

- Unit: prompt-content tests in `test/enrich.test.js` style (VAPT anchors,
  signal hints present); config matrix tests; store test for `kind='vapt'`.
- Migration: constraint round-trip + stats view returns a vapt row.
- Integration: one supervised cycle; assert new rows are `kind='vapt'`,
  service fixed, email/phone coverage counts reported.
- CRM: headless screenshot of the VAPT tab + Leads dropdown with counts.

## Order and independence

V1 → V2 ship together (a tab with no feed is noise; a feed with no tab is
invisible). V3 phone backfill can land the same day; the email ladder is
already live except the Apollo unlock. V4 last — outreach copy matters only
once rows exist.
