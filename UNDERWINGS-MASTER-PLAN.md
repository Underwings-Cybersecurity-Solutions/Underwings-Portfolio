# Underwings Sales Automation — Master Plan (v2)

> **For Claude Code:** This document is the single source of truth for the
> Underwings sales automation build. Read it fully before doing anything.
> Ask clarifying questions if anything is ambiguous. Do not invent steps
> not in this plan without checking with the user first.

> **Document history**
> - v1 (2026-04-xx) — original 10-phase plan, engineering-led
> - v2 (2026-05-21) — re-sequenced for business impact: added KPIs, kill
>   criteria, budget gates, measurement layer, customer success, awareness
>   & referral phase, Monday reconciliation ritual, runbooks; pipeline
>   numbering corrected (P5 = Software Resale, P6 = Subscriptions)

---

## 1. Business context

**Company:** Underwings Cybersecurity Solutions (underwings.org)
**Location:** Abu Dhabi, UAE
**Launch year:** 2026
**Team (3 named principals):**
- **Manoj Prabhakaran** — ISO 27001 Lead Auditor, CPTS, Azure Security. Owns GRC, compliance, healthcare ADHICS.
- **Nelson Durairaj** — OSCP, CEH. Owns offensive security (pen testing, VAPT, phishing sims).
- **Vinoth Samiyappa** — CCNP, Fortinet NSE, Azure. Owns network/infrastructure security.

**Positioning:** Named senior practitioners (never juniors), transparent AED
pricing, UAE-focused, ISO/ADHICS/NESA/PDPL expertise.

**Primary 2026 vertical bet:** Healthcare + ADHICS v2 compliance.
**Secondary verticals:** Fintech, SaaS, government, oil & gas.

**Revenue model — three streams:**
1. **One-off projects** (pen tests, ISO implementations, awareness training) — AED 9k–150k
2. **Subscriptions** — PTaaS (AED 6k/mo) and Continuous Compliance (AED 4k/mo)
3. **Software resale** — Sophos, Fortinet, Securonix, Wazuh, Qualys, Rapid7, Tenable

---

## 2. North-star and funnel KPIs

> **Rule:** every phase delivers numbers, not just workflows. "Phase done"
> means the KPI is being measured and is moving in the right direction.

### North-star metric

**Booked discovery calls / week.** Lagging proxy for ARR but fast enough to
steer on. Other metrics support this one.

### Funnel KPIs (steady-state targets, by end of 2026 Q4)

| Stage | Target (weekly) | Floor (kill criterion) |
|---|---|---|
| New leads (any source) | ≥ 15 | < 5 by week 12 = inbound is dead |
| MQLs (score ≥ 70) | ≥ 5 | < 2 by week 12 = scoring or fit is wrong |
| Discovery calls booked | ≥ 3 | < 1 by week 12 = top-of-funnel wrong |
| Proposals sent | ≥ 1 | < 1 by month 3 = scoping bottleneck |
| Deals won (per quarter) | ≥ 4 | < 2 by quarter end = pricing or positioning wrong |

### Channel-level KPIs

| Channel | Lead-to-MQL | MQL-to-booked-call | Notes |
|---|---|---|---|
| Inbound (website, scope quiz) | ≥ 40% | ≥ 60% | Highest intent, lowest cost |
| Referral (audit firms, prev clients) | ≥ 60% | ≥ 75% | Highest conversion, deliberately invested in |
| LinkedIn outbound | ≥ 15% | ≥ 25% | Per-practitioner |
| Cold email | ≥ 5% | ≥ 15% | Lowest priority, gated on warmup |
| Apollo / list-based | ≥ 5% | ≥ 15% | Treated same as cold email |

### Operating-cost KPI

| Metric | Target |
|---|---|
| Stack cost / booked discovery call | ≤ AED 200 |
| Stack cost / closed deal | ≤ AED 2,000 |
| Monthly stack ceiling (Phase 7+) | AED 12,000 |

If unit economics break (stack-cost-per-deal > AED 5,000 sustained), pause
the next phase rollout and reassess.

---

## 3. Existing tech stack (self-hosted unless noted)

| Tool | Purpose | Status |
|---|---|---|
| n8n | Workflow orchestration | Self-hosted, running |
| Krayin CRM | Sales pipeline + lead management | Self-hosted, configured |
| Cal.com | Booking page (book.underwings.org) | Self-hosted, running |
| Plane | Project management for delivery | Running |
| Brevo | Email sending + sequences | Configured |
| Keila | Newsletter | Running |
| Stalwart + Roundcube | Inbound/outbound + webmail | Running |
| Slack | Team comms + alerts | Active (workspace to be created — Phase 4) |
| Uptime monitoring | Service health | Active |
| Website | underwings.org | Live |

**Claude products available:** Max subscription — Claude.ai chat, Cowork
(desktop), Claude Code, Claude API.

**To add when needed (gated on KPIs):**
- Apollo.io (Phase 7)
- PhantomBuster (Phase 7)
- Email warmup tool (Phase 7)
- E-signature provider (Phase 3b-ii — Documenso shortlisted, self-hosted)

---

## 4. Pipeline architecture

> ⚠️ **Authoritative source: Krayin DB.** This section is the canonical
> mapping; if `docs/krayin-ids-reference.md` ever diverges, update both.

### Pipeline 4 — UW Cybersecurity Sales (default, primary)

One-off engagements. Rotten days: 30.

| Order | Stage | Probability % |
|---|---|---|
| 1 | New | 10 |
| 2 | MQL | 20 |
| 3 | Contacted | 30 |
| 4 | Discovery Booked | 50 |
| 5 | Scoping | 60 |
| 6 | Proposal Sent | 70 |
| 7 | Negotiation | 85 |
| 8 | Won | 100 |
| 9 | Lost | 0 |

### Pipeline 5 — UW Software Resale  *(swap vs. v1)*

License sales + deployment. Rotten days: 21.

| Order | Stage | Probability % |
|---|---|---|
| 1 | New | 15 |
| 2 | Requirements Gathered | 30 |
| 3 | Vendor Shortlist | 45 |
| 4 | Quote Sent | 60 |
| 5 | PO Pending | 80 |
| 6 | Ordered | 90 |
| 7 | Deployed | 95 |
| 8 | Won | 100 |
| 9 | Lost | 0 |

### Pipeline 6 — UW Subscriptions  *(swap vs. v1)*

PTaaS + Continuous Compliance. Rotten days: 14. "Trial" = one paid month
with 30-day exit clause, not free work.

| Order | Stage | Probability % |
|---|---|---|
| 1 | New | 15 |
| 2 | Qualified | 30 |
| 3 | Demo Booked | 50 |
| 4 | Trial Offered | 65 |
| 5 | Trial Active | 80 |
| 6 | Contract Sent | 90 |
| 7 | Won | 100 |
| 8 | Lost | 0 |

---

## 5. Budget and spend governance

| Item | Trigger | Monthly cost (AED) | Hard cap |
|---|---|---|---|
| n8n / Krayin / Cal.com / Plane (VPS) | already running | 200 | — |
| Brevo + Keila | already running | 200 | — |
| Stalwart + Roundcube | already running | 0 | — |
| Claude API (scoring + drafting) | Phase 2 onward | est. 800 | 2,500 |
| Apollo.io | Phase 7 only | 1,200 | 1,800 |
| PhantomBuster | Phase 7 only | 600 | 900 |
| Email warmup tool | Phase 7 only | 200 | 400 |
| Documenso (e-sign) | Phase 3b-ii | 0 (self-hosted) | — |

**Hard rules:**
1. **No paid outbound tooling (Apollo / PhantomBuster / warmup) until** at
   least **1 paying client** has been signed via inbound + referral.
2. **Monthly stack spend ceiling: AED 12,000.** Exceeding for 2 months
   running = mandatory phase pause + review.
3. **Claude API daily cost alert at AED 100/day** via n8n cron + Slack ping.

---

## 6. Current state (the truth, not the wish)

✅ **Done** (committed)
- Phase 0 — Foundation (`docs/krayin-ids-reference.md`)
- Phase 1 — Inbound lead capture (`01-inbound-lead-capture.json`)
- Phase 2 — Enrichment + scoring (`02-lead-enrichment-scoring.json`)
- Phase 2.5 — Cron sweep + suppression (`03-enrichment-sweep.json`)
- Phase 3a — Cal.com booking handler (`04-calcom-booking-handler.json`)
- Phase 3b-i — Pre-call brief (`05-calcom-prebrief-cron.json`)
- Phase 3c — Plane card on booking
- Phase 9 — Weekly pipeline report (`06-weekly-report.json`)
- SPF, DKIM, DMARC on underwings.org
- Krayin webhook layer for all of the above
- Krayin token rotated
- **Phase B — Measurement layer** (metrics-db + Metabase + 4 dashboards
  + nightly ETL workflow 13). Live at metrics.underwings.org.
- **Phase C — Proposal generator** (Documenso + MinIO S3 + pandoc-render
  sidecar v2 + workflow 07 rewritten sidecar-first). Verified end-to-end:
  form → Claude draft → PDF → Documenso PENDING envelope → Krayin stage →
  cost log. ~0.04 AED/proposal. Live at sign.underwings.org.
- **Phase G — De-risk** (nightly encrypted DB backups + n8n workflow
  drift detection, systemd timers active).
- Cloudflare tunnel + Access (metrics + sign), DNS migrated to Cloudflare.
- Slack workspace + 5 channels + 5 webhooks, plumbed into n8n.

- **Phase C tail** — workflow 08 (signature → Won) rewritten sidecar-first
  + tested via simulated HMAC-signed webhook (valid → Won, bad → 401).
  Fixed latent stage-move bug (wrong webhook param). **Plane delivery-project
  automation now wired (2026-05-27):** /onboard auto-creates a Plane project
  named "{client} — Delivery" + seeds a 7-step engagement checklist + posts
  the link to #client-success. Kickoff email still personal/manual.
- **Phase A** — Monday reconciliation ritual (systemd timer → #ops checklist).
- **Phase E (core)** — daily touchpoint reminders (Won deals at day 7/30/90
  → #client-success for a personal note). Auto-email to clients deferred
  to Phase J.
- **Phase D (assets)** — go-to-market kit for a zero-client firm, all live:
  - Founding-client outreach kit + per-ICP templates (`docs/sales/`)
  - Founding-client one-pager → `underwings.org/underwings-founding-client.pdf`
  - Audit-firm partnership kit + one-pager → `underwings.org/underwings-partnership.pdf`
  - Krayin lead sources "Founding Outreach" (35) + "Referral Partner" (36)
    + Metabase "Founding Outreach Tracker" dashboard
  - 8 content pillars across all 3 principals (5 GRC: ISO cost / ISO 27005 /
    ISO impl / ADHICS / PDPL · 3 offensive+network: pen-test-vs-VA /
    phishing-vs-awareness / pen-test buyer guide / FortiGate hardening)
- **Phase F — PDPL compliance hardening** (2026-05-27) — our own PDPL posture,
  `docs/compliance/` (RoPA, retention policy, DSAR runbook, breach plan) +
  `scripts/pdpl-retention.sh` (weekly timer) + `scripts/pdpl-dsar-erase.sh`
  (right-to-erasure) + `dpo@`/`privacy@` mailboxes + privacy policy rewritten
  (sub-processors, cross-border transfers, DPO, 14-day SLA). See §7 Phase F.

🟡 **Partial / blocked**
- **Phase D execution** — assets are built; the human outreach (45 warm
  messages + partner coffees) is the unstarted, highest-value step. No
  asset substitutes for it.
- Phase D case studies — impossible until the first engagement is delivered;
  founding-client outreach exists precisely to manufacture the first ones.
- Phase E auto-email to clients — intentionally deferred (personal > templated
  for first clients).
- ~~Plane delivery-project automation — needs PLANE_API_TOKEN~~ ✅ DONE 2026-05-27
  (token generated; /onboard auto-creates the project + checklist).
- Documenso signature email only reaches real (non-.local) recipient addresses.

❌ **Not started** (all gated on first paying client per §5)
- Phase H — outbound prerequisites (Apollo, PhantomBuster, warmup, content assets)
- Phase I — outbound automation (harvest, scoring/drafting, reply detector)
- Phase J — cross-pipeline upsell + Trial-Active ops + Phase E client auto-email
- Phase K — continuous tuning (needs ≥3 months of dashboard data)

> Phase F (PDPL compliance hardening) was the only unblocked technical phase and
> is now ✅ DONE (2026-05-27) — see §7 Phase F. Every remaining phase (H–K) is
> gated on the first paying client.

**Human, not build (the actual gate on everything above):**
- The 45 warm founding-client messages — not sent yet.
- Partner / audit-firm conversations — not initiated yet.
- LinkedIn posting cadence — assets/voice ready, no posts published yet.
- First paying client — none yet. Unlocks Phases H–K + the first case study.

---

## 7. Phase plan (v2 — re-sequenced for business impact)

Each phase has: **goal · prerequisite · effort estimate · KPI · kill
criterion**. A phase ships only when the KPI is being measured *and*
moving in the right direction.

---

### Phase A — Reconciliation ritual (recurring, starts immediately)

**Goal:** keep this plan and reality from drifting.
**Effort:** 30 min / week (Monday 08:00 Asia/Dubai).
**Trigger:** weekly cron in n8n that posts a checklist to `#ops` Slack.

**Checklist:**
- Does `docs/krayin-ids-reference.md` match the live Krayin DB? (run the
  read-only audit query in `n8n/queries/audit-krayin-ids.sql`)
- Are all n8n workflows in `n8n/workflows/` matching what's deployed in
  the running n8n? (export-to-git nightly, see Phase G).
- Has any KPI in Section 2 crossed a kill-criterion this week?
- Has any phase's effort estimate drifted >2× over budget?

**Owner:** Manoj (or whoever is least travel-heavy that week).

**Why it's first:** v1 of this plan drifted from reality within weeks.
Without a habit, v2 will too.

---

### Phase B — Measurement layer (CURRENT NEXT — was old Phase 9)

**Goal:** stop tuning blind. Every later phase needs this.
**Prerequisite:** Phase 1 + 2 shipped (✅).
**Effort:** ~3 person-days.
**KPI:** dashboards live, all 5 funnel KPIs visible to all 3 principals.
**Kill criterion:** N/A (foundational).

**Deliverables:**
1. Nightly export: Krayin DB → DuckDB / read-only Postgres replica.
2. Metabase (self-hosted) connected, 4 dashboards:
   - Funnel (Section 2 KPIs)
   - Channel performance (lead-to-MQL by source)
   - Stage velocity (days in each stage, by pipeline)
   - Cost per booked call (Claude API spend + ad spend / discovery calls)
3. Weekly report (already shipped) now pulls from the same warehouse.
4. Slack `#ops` daily 08:00 micro-summary: "Yesterday — N leads, M MQLs,
   K calls booked. Top channel: X."

**Why it's now:** without it, Phase 8 (outbound) can't be tuned and
Phase D (kill criteria) can't be evaluated.

---

### Phase C — Proposal generator (HIGH LEVERAGE, currently the gap)

**Goal:** booked call → signed deal fully automated through "Proposal Sent".
**Prerequisite:** Phase 3a/3b-i ✅, Documenso deployed.
**Effort:** ~5 person-days.
**KPI:** ≥ 80% of proposals generated < 2h after scoping call ends.
**Kill criterion:** if template + Claude drafts need > 30 min of manual
edits/proposal for 3 weeks running, the template is wrong — pause and
rewrite.

**Deliverables:**
1. Documenso deployed at `sign.underwings.org` (self-hosted e-sign).
2. Proposal templates in `templates/proposals/`: pen-test, ISO, ADHICS,
   PTaaS, CC, software resale.
3. n8n workflow `07-proposal-generator`:
   - Trigger: n8n form (SKU + scope notes) filled post-discovery.
   - Claude API fills template (prompt cached on template).
   - Save markdown + PDF to Drive in client folder.
   - Upload PDF to Documenso, send signature request via Brevo.
   - Move Krayin deal to "Proposal Sent".
   - 3-day timer: if not opened, auto-follow-up.
   - 7-day timer: Slack ping to assigned principal.
   - Signature webhook: move to Won, create Plane project, kickoff email.
4. Pricing SKU file `templates/skus.yml` — single source of truth for
   prices; website + proposal both read from it.

**Why first after measurement:** every booked call needs one of these.
The system currently has a gaping hole between "Discovery Booked" and
"Won." This workflow closes the most expensive manual step in the entire
funnel.

---

### Phase D — Awareness & referral channel

**Goal:** generate 10+ inbound leads/week without paid outbound.
**Prerequisite:** Phase B (measurement) live.
**Effort:** ~30 person-days spread over 8 weeks (across all 3 principals).
**KPI:** ≥ 5 inbound leads/week by end of week 12; ≥ 2 referral leads/month.
**Kill criterion:** if < 3 inbound leads/week by week 12, the website /
positioning is the problem, not the funnel — review SEO + content + ICP.

**Deliverables (parallelisable):**
1. **3 case studies** (anonymised if needed). Format: situation → approach
   → result → quote. One per principal's specialty area.
2. **LinkedIn cadence**: each principal posts 2×/week. Editorial calendar
   in `docs/linkedin-calendar-2026-q3.md`. First 12 posts pre-written.
3. **Pillar SEO content**: 6 long-form posts targeting ADHICS / ISO /
   PDPL / VAPT / Azure security / Fortinet hardening searches.
4. **3 audit-firm partnership conversations**: target Big-4 local arms +
   2 boutiques. Pitch: "we deliver the remediation work you don't."
5. **GISEC 2026 submission** (speaker / booth — whichever fits budget).
6. **Webinar #1** scheduled — "ADHICS v2 in 30 minutes."
7. **Newsletter** (Keila) — biweekly UAE cybersec digest. Already wired
   in `b1f59ea`.

**Why before outbound:** B2B security in the UAE moves on trust and
referrals. A 6-month-old domain doing cold outbound to CISOs has a 0.5–2%
reply rate. Inbound + referral conversion is 5–10× higher per AED spent.
Exhaust this channel first.

---

### Phase E — Customer success & retention (NEW)

**Goal:** Won-deal is the start of revenue, not the end of the funnel.
**Prerequisite:** Phase C (proposal generator) — so we have actual Won
deals to onboard.
**Effort:** ~7 person-days.
**KPI:** ≥ 30% of clients become repeat customers within 12 months; NPS ≥ 8.
**Kill criterion:** if NPS < 6 across first 5 clients, pause new
acquisition phases and fix delivery.

**Deliverables:**
1. n8n workflow `08-onboarding-kickoff`: triggered on Krayin Won →
   onboarding email + Plane project from template + Drive folder
   provisioned + invoice queued in accounting.
2. n8n workflow `09-client-touchpoints`: day-7 check-in, day-30 NPS via
   Brevo, day-90 case-study harvest invite, day-330 renewal nudge.
3. Templates in `templates/cs/`: kickoff-email, day-7-checkin, day-30-nps,
   day-90-casestudy-invite, day-330-renewal.
4. Krayin custom field: `client_health_score` (0–100, updated weekly by
   delivery-team self-report).
5. Slack `#client-success` channel with weekly cadence: every active
   client appears once with one-line status.

**Why here:** before scaling acquisition, prove we can keep what we win.
Retention math beats acquisition math at every stage.

---

### Phase F — Compliance hardening ✅ DONE (2026-05-27)

**Goal:** be the cybersec firm that obviously does PDPL right.
**KPI:** zero PDPL-related complaints; full DSAR turnaround < 14 days.

**Delivered** (all in `docs/compliance/` + `scripts/` + `deploy/`):
1. ✅ **DPO + privacy contacts** — `dpo@underwings.org` (→ Manoj, the GRC/ISO
   Lead Auditor = named DPO) and `privacy@underwings.org` (→ Manoj + ops)
   live in Stalwart. Published on the privacy policy.
2. ✅ **Retention defaults, automated** — `scripts/pdpl-retention.sh`
   anonymises expired non-client records (24mo inbound / 12mo outbound;
   clients excluded → manual 7-yr rule), weekly via `pdpl-retention.timer`
   (Sun 03:17 Asia/Dubai, installed + enabled). Policy:
   `docs/compliance/data-retention-policy.md`.
3. ✅ **DSAR runbook + erasure capability** — `docs/compliance/dsar-runbook.md`
   (14-day SLA process) + `scripts/pdpl-dsar-erase.sh` (dry-run default;
   `--apply` erases across Krayin **and** warehouse, suppresses the email,
   writes a hashed audit row to `ops.pdpl_erasure_log`). *Note: implemented as
   a runbook + script rather than the planned n8n `10-dsar-handler` — sidecar/
   script pattern, consistent with the n8n-fragility lesson; Plane ticketing
   deferred until `PLANE_API_TOKEN` exists.*
4. ✅ **RoPA** — `docs/compliance/ropa.md` + `ropa.csv` (12 activities,
   owner-tagged, quarterly review). *(.md/.csv, not .xlsx — version-controllable.)*
5. ✅ **Cross-border transfer notice** — privacy policy now names Brevo (EU),
   Cloudflare (US), Anthropic (US), removes the defunct "Privacy Shield"
   reference, and states lawful bases + SCCs.
6. ✅ **Right-to-be-forgotten** — covered by `pdpl-dsar-erase.sh` (Krayin +
   warehouse; Keila/Brevo are documented manual follow-ups).
7. ✅ **Breach-response plan** — `docs/compliance/breach-response-plan.md`
   (Data Office notification process).

**Remaining human/legal follow-ups** (documented in `docs/compliance/README.md`):
confirm VPS region for the RoPA; download + file SCCs/DPAs for the 3 sub-processors.

---

### Phase G — De-risk infrastructure (NEW)

**Goal:** no single failure loses pipeline state.
**Prerequisite:** none.
**Effort:** ~2 person-days.
**KPI:** RTO < 4h, RPO < 24h for Krayin, n8n, Plane.

**Deliverables:**
1. Nightly export of all n8n workflow JSON to `n8n/workflows/` in git
   (cron job — verifies parity, alerts if drift).
2. Nightly encrypted backup of Krayin DB + Plane DB to S3 (Hetzner Object
   Storage or Backblaze).
3. Runbooks in `runbooks/`:
   - `n8n-is-down.md` — manual webhook receiver, rehydrate after recovery
   - `krayin-is-down.md` — read-only fallback page, queue inbound writes
   - `claude-api-down.md` — manual scoring fallback, drafted templates
   - `domain-blacklisted.md` — pause sending, investigate, rotate IP
4. Uptime monitor for: n8n webhook URL, Krayin login, Cal.com, frontend,
   crm.underwings.org. Alerts to `#ops`.
5. Quarterly fire-drill: deliberately stop one container, time the
   recovery.

---

### Phase H — Outbound prerequisites (was old Phase 4)

**Goal:** lay foundation for compliant, deliverable outbound for all 3
practitioners in parallel.
**Prerequisite:** Phase D (awareness & referral) showing < target — i.e.,
inbound saturated before opening outbound.
**Effort:** ~6 weeks calendar, ~15 person-days of work (warmup is mostly
calendar time, not labour).
**KPI:** open rate ≥ 40%, reply rate ≥ 3% on first send batch.
**Kill criterion:** if domain reputation flags (any blocklist hit, any
SpamAssassin > 5 score) — pause, investigate root cause.

**Deliverables (parallel for all 3 practitioners — start in week 1):**
1. **Separate sending subdomain** `mail.underwings.org` with its own SPF
   + DKIM + DMARC. Doesn't share reputation with marketing/transactional.
2. **Email warmup** running ≥ 3 weeks before first send. Tool: TBD
   (Mailwarm, Warmup Inbox, or Smartlead).
3. **Apollo.io account** + ICP-tuned saved searches:
   - Manoj: UAE healthcare CISO + UAE compliance director
   - Nelson: UAE SaaS CTO + UAE fintech security lead
   - Vinoth: UAE oil&gas IT director + UAE manufacturing IT manager
4. **PhantomBuster** + LinkedIn integration tested for each practitioner.
5. **Content assets** in Drive (`/content/`):
   - ADHICS readiness checklist (Manoj)
   - ISO 27001 one-pager (Manoj)
   - Web app pen-test sample report (Nelson)
   - OWASP Top 10 explainer (Nelson)
   - Fortinet hardening guide (Vinoth)
   - Zero-trust starter (Vinoth)
   - UAE cybersec budget benchmark (shared)
6. **Suppression list** in Krayin (already exists from Phase 2.5).
7. **Slack workspace + channels**: `#sales-pipeline`, `#new-leads`,
   `#hot-leads-manoj`, `#hot-leads-nelson`, `#hot-leads-vinoth`.

**Why this comes after Phase D:** if inbound + referral hits targets,
outbound may not be needed at all. If it doesn't hit targets, the
content assets built for outbound also feed back into the inbound /
referral motion (audit firms want to share useful artefacts).

---

### Phase I — Outbound automation (Manoj first, then Nelson + Vinoth)

**Goal:** 25 personalised emails + LinkedIn / day / practitioner.
**Prerequisite:** Phase H (warmup + ICP + content + Slack) complete; ≥ 1
paying client signed via Phase D/C.
**Effort:** ~5 person-days for Manoj's instance; ~2 each to clone for
Nelson and Vinoth.
**KPI:** reply rate ≥ 3%, interested replies ≥ 1%, MQL conversion ≥ 15%.
**Kill criterion:** if MQL conversion < 5% after 6 weeks, the ICP or the
copy is wrong — pause and reset, don't grind.

**Deliverables (n8n workflows):**
1. `apollo-daily-harvest` (07:00 cron) — 25 leads/day filtered against
   suppression list.
2. `claude-scoring-and-drafting` (07:05) — score ≥ 60 only; subject +
   body + LinkedIn DM drafted; output to `/outbound/<date>/`.
3. `cowork-decisions-watcher` — Manoj reviews drafts in Cowork; approved
   rows trigger send via Brevo + LinkedIn DM via PhantomBuster.
4. `outbound-reply-detector` — IMAP watch + LinkedIn webhook; Claude
   classifies (Interested / Not now / Never / OOO) and acts.

**Critical rules** (carried forward, non-negotiable):
- ≤ 25 sends/day/mailbox.
- Human-in-the-loop review of every first touch for first 90 days.
- Skip leads with Claude confidence < 60 (no fake personalisation).
- DPO contact + unsubscribe in every send.

---

### Phase J — Cross-pipeline upsell + Trial-Active operations

**Goal:** every Won deal generates the next opportunity automatically.
**Prerequisite:** Phase E (CS) live so onboarding is solid first.
**Effort:** ~5 person-days.
**KPI:** ≥ 20% of P4 Won deals → P6 (subscription) within 90 days; ≥ 30%
of P4+P6 Won → P5 (resale) within 180 days.

**Deliverables:**
1. n8n workflow `11-cross-pipeline-upsell`:
   - 30 days post-Won in P4 → auto-create P6 lead (subscription upsell).
   - 60 days post-Won in P4 or P6 → Claude scans project notes for tool
     gaps → if gap found, create P5 lead (software resale).
   - Renewal date = Won + 365d; surface 60 days before.
2. n8n workflow `12-trial-active-operations` (P6 only):
   - On move to "Trial Active": Plane project from template, Drive
     folder, Slack DM to practitioner, day-7 check-in, day-21 report-due
     ping, day-26 report-delivered email, day-28 renewal email drafted,
     day-30 renewal conversation triggered.

---

### Phase K — Continuous tuning

**Goal:** the system keeps getting smarter without manual rebuilds.
**Prerequisite:** Phase B (measurement) live; ≥ 3 months of data.
**Effort:** ongoing.

**Deliverables:**
1. Monthly: review Claude scoring threshold accuracy vs. actual
   conversion; adjust.
2. Monthly: A/B test 1 email template per pipeline (need ≥ 50 sends per
   variant for stat-sig; otherwise skip).
3. Monthly: review Apollo ICP filters vs. actual MQL conversion.
4. Quarterly: review rotten-day windows per pipeline; tighten if stage
   velocity has improved, loosen if not.
5. Quarterly: cost review — stack cost / closed deal vs. target.

---

## 8. Slack channel architecture

| Channel | Purpose | Volume / day | Phase live |
|---|---|---|---|
| `#ops` | Reconciliation, alerts, drift warnings, daily metric summary | 2–5 | A, B, G |
| `#sales-pipeline` | Daily harvests, drafts ready, weekly reports | 5–10 | I |
| `#new-leads` | Every new Krayin lead created | 10–20 | 1 (already exists in workflow, channel pending) |
| `#hot-leads-manoj` | **All** "interested" replies from cold outbound — Manoj triages and forwards | 1–3 | I |
| `#client-success` | Weekly active-client status | 5 / week | E |
| Founder DM | Morning + EOD summary only | 2 | always |

**Rule:** alerts only where action is required within 4 hours.
Notification fatigue is the silent killer.

---

## 9. Claude API usage patterns inside n8n

For every Claude API call from n8n:
- HTTP Request node, POST to `https://api.anthropic.com/v1/messages`.
- Headers: `x-api-key: <key>`, `anthropic-version: 2023-06-01`,
  `content-type: application/json`.
- Models:
  - `claude-haiku-4-5` — classification, scoring, short summaries.
  - `claude-sonnet-4-6` — drafting, briefs, multi-step reasoning.
  - `claude-opus-4-7` — long-form proposal generation, weekly report.
- Web search is **not built in** to the API. Wire it explicitly via a
  search tool (Brave / Serper / Tavily). Document the choice in the
  workflow's notes node.
- Always request JSON output (explicit prompt instruction). Parse
  `content[0].text`, strip ` ```json ` fences if present.
- Wrap every call in error handling — fall back to a default action
  (skip enrichment, mark as "needs manual review", Slack ping to `#ops`).
- For long-context tasks (proposal, weekly report): use prompt caching
  with `cache_control: {"type": "ephemeral"}` on the template/system
  prompt. Cuts cost ~90% on repeated runs.
- Daily Claude cost alert at AED 100 / day (cron in n8n queries the
  Anthropic usage endpoint, Slack `#ops`).

---

## 10. Conventions and standards

**File and folder structure:**
```
/UNDERWINGS-MASTER-PLAN.md     this file
/docs/                          ids reference, plans, runbooks
  /krayin-ids-reference.md      live IDs (Phase 0 deliverable)
/n8n/
  /workflows/                   exported workflow JSON (nightly auto-export)
  /docs/                        per-phase write-ups
  /queries/                     read-only SQL (audit, dashboards)
/prompts/                       Claude API prompts (versioned)
/templates/
  /proposals/                   per-SKU proposal templates
  /cs/                          customer-success email templates
  /skus.yml                     single source of truth for prices
/content/                       outbound + inbound content assets
/runbooks/                      incident response (Phase G)
/krayin/                        webhook PHPs + custom field defs
```

**Naming conventions:**
- n8n workflows: numbered + kebab-case (`07-proposal-generator`).
- Krayin custom fields: snake_case (`icp_segment`,
  `outbound_confidence_score`, `client_health_score`).
- Lead sources: include practitioner name for outbound
  (`LinkedIn Outbound - Manoj`).
- Slack channels: `#kebab-case`.

**Security:**
- All API keys/tokens in n8n credentials manager — never in workflow JSON
  or git. Anything ending in `.env` is git-ignored (`*.env` rule).
- Webhook URLs treated as secrets (Slack, Brevo, Krayin).
- Token redaction in any output file: show only first 6 chars + `…`.
- No real client data in test runs; use `[TEST]` prefix on lead names.

**Code quality:**
- Every n8n workflow has a "notes" node at the top: purpose, trigger,
  downstream effects, KPI it affects, kill criterion.
- Every Claude prompt is version-controlled in `prompts/`.
- Every breaking change to a pipeline structure requires updating
  `docs/krayin-ids-reference.md` AND notifying affected n8n workflows.

---

## 11. Critical rules — do not violate

1. **Never start outbound sending before warmup completes (≥ 3 weeks).**
   Domain reputation damage takes 30+ days to recover.
2. **Never send > 25 personalised emails/day per mailbox.** Hard cap in
   n8n, not a guideline.
3. **Never fake-personalise.** Claude confidence < 60 → skip the lead.
4. **Never delete real Krayin data in testing.** Prefix test lead names
   with `[TEST]`.
5. **Human-in-the-loop is mandatory for outbound first touches for the
   first 90 days minimum.** Cowork review is non-negotiable.
6. **PDPL compliance:** outbound only to business email; DPO contact +
   working unsubscribe in every send; honour opt-outs immediately;
   anonymise per Section 7 / Phase F retention defaults.
7. **Krayin is the single source of truth** for lead state. n8n does
   not maintain its own lead database.
8. **No paid outbound tooling (Apollo / PhantomBuster / warmup) until
   ≥ 1 paying client has been signed via inbound or referral.**
   (Budget rule, Section 5.)
9. **Monthly stack ceiling AED 12,000.** Two consecutive months over =
   mandatory phase pause.
10. **A phase ships only when its KPI is being measured and is moving
    in the right direction.** Workflow merged != phase done.

---

## 12. How to work with this plan

When the user asks Claude Code to "build phase X" or "continue from
where we left off":

1. Re-read this file fully.
2. Check `docs/krayin-ids-reference.md` for current Krayin state.
3. Check Section 6 — which phases are actually done, which are blocked.
4. Confirm prerequisite phases are complete; if not, surface that.
5. Confirm the KPI from Section 2 / phase-specific is currently being
   measured. If not, propose Phase B first.
6. Ask any clarifying questions BEFORE writing code.
7. Build incrementally — one workflow at a time, tested before moving on.
8. Document every workflow with a top-level notes node (see Section 10).

When uncertain about:
- Krayin DB shape → hit the DB directly via the read-only audit query,
  don't guess.
- Claude model availability → check docs.claude.com.
- UAE compliance edge cases → ask user to confirm before proceeding.
- Whether to add an unscoped feature → ask user first.

**Failure mode to avoid:** in v1, the plan said "Phase 0 todo" but Phases
0–3 were done. Reality drifted from the plan. Phase A (Section 7)
exists to prevent that recurring. Don't skip it.

---

## 13. Open questions / parked decisions

These need explicit user input before the relevant phase ships:

1. ~~**Slack workspace creation.**~~ ✅ Done 2026-05-21. Workspace `underwingsworkspace.slack.com`, 5 channels (`#ops`, `#sales-pipeline`, `#new-leads`, `#client-success`, `#hot-leads-manoj`), Underwings BOT app with 5 incoming webhooks. All tested HTTP 200; env vars in n8n.
2. **E-sign tool.** Documenso (self-hosted) shortlisted vs. DocuSign
   (managed). Self-hosted favoured for cost + data residency. *(Owner:
   Manoj, by start of Phase C.)*
3. **Email warmup tool.** Smartlead, Mailwarm, or Warmup Inbox — pick at
   start of Phase H. *(Owner: founder.)*
4. **Phone / WhatsApp capture.** Not in current funnel. UAE B2B is heavy
   on phone. Consider Phase X — WhatsApp Business API integration with
   Krayin. *(Owner: founder; decision needed before Phase D scales.)*
5. **GISEC 2026.** Booth (~AED 30k) vs. speaker submission (free).
   *(Owner: founder; decision Q3.)*
6. **Subscription billing rail.** Stripe? Tabby? Direct invoice? Needed
   before Phase J's Trial-Active workflow ships. *(Owner: founder.)*

---

End of master plan v2.

> **2026-09-24:** `scripts/pdpl-retention.sh`, `scripts/pdpl-dsar-erase.sh` and `scripts/monday-reconciliation.sh` were deleted. They targeted the Krayin MariaDB removed on 2026-06-25 and carried its password in a public repository. Retention and erasure now apply to Supabase and Zoho CRM (see docs/runbooks/zoho-crm-website.md).
