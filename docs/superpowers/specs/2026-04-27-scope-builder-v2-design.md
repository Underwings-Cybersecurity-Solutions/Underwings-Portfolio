# Scope Builder v2 — Cart-Style Multi-Category Lead Generation Tool

**Date:** 2026-04-27
**Owner:** Underwings Cybersecurity Solutions
**Status:** Design approved, awaiting plan

---

## 1. Goal

Replace the existing pen-test-only scope builder with a professional cart-style multi-category scoping tool that serves as Underwings' primary inbound lead-generation surface.

Buyers shop services like a cart, configure each with a short workflow, see a live indicative price range, get a downloadable PDF + tracked hosted link, and become a fully populated Lead in Krayin CRM with view-tracking telemetry.

---

## 2. Scope

### Phase 1 (this spec — ~3.5 days)
- Offensive Security workflow (refactor of existing scope builder)
- GRC workflow (new)
- Cloud Security workflow (new)
- Cart-style UX with localStorage persistence
- Per-service "Learn more" educational drawers (medium depth)
- Per-cart-item Comments textarea
- Universal Comments & Information block on enquiry page
- Founding Client opt-in checkbox
- PDF generation + hosted PDF link with view tracking
- Krayin CRM integration (new webhook + custom attributes + new pipeline)
- Slack notification (env-gated, deferred until workspace exists)
- WhatsApp click-to-chat for buyer-facing support
- Email to buyer with PDF + hosted link
- Email to team as audit trail

### Phase 2 (next iteration — out of scope here)
- Network Infrastructure workflow
- Training & Awareness workflow
- Plane project-management auto-creation on lead-won

### Out of scope (future phases)
- WhatsApp Business API automation
- Multi-language UI (English only Phase 1)
- Authenticated buyer accounts
- Self-serve quote acceptance / digital signature

---

## 3. User Experience

### 3.1 Entry points

| URL | Behaviour |
|---|---|
| `/scope-builder` | Empty cart, full catalogue view |
| `/scope-builder?seed=offensive` | Cart starts pre-loaded with empty Offensive item, configuration drawer auto-opens |
| `/scope-builder?seed=grc` | Same pattern for GRC |
| `/scope-builder?seed=cloud` | Same pattern for Cloud Security |
| `/services/offensive-security/scope-builder` | Existing URL preserved for SEO, server-side 301 → `/scope-builder?seed=offensive` |
| All service category pages | "Get a scope plan" CTA links to the appropriate seeded URL |

### 3.2 Page structure

```
┌──────────────────────────────────────────────────────────────────┐
│  /scope-builder                                                  │
│                                                                  │
│  Header: "Build your scope in 2 minutes"                         │
│  Subhead: "Pick services, configure, get a written quote in 48h" │
│                                                                  │
│  [Resume banner if cart in localStorage <7 days old]             │
│                                                                  │
│  ┌── Service Catalogue ──────────────┐ ┌── Cart sidebar ──┐      │
│  │ ┌─────────────┐ ┌─────────────┐   │ │ Your Cart        │      │
│  │ │ Offensive   │ │ Cloud Sec   │   │ │                  │      │
│  │ │ Security    │ │             │   │ │ — empty —        │      │
│  │ │ AED 3.5–48k │ │ AED 7–24k   │   │ │                  │      │
│  │ │ ⓘ Learn     │ │ ⓘ Learn     │   │ │ Bundle savings   │      │
│  │ │ + Add       │ │ + Add       │   │ │ shown after      │      │
│  │ └─────────────┘ └─────────────┘   │ │ 2nd item         │      │
│  │ ┌─────────────┐                   │ │                  │      │
│  │ │ GRC         │   Phase 2:        │ │ ★ Founding       │      │
│  │ │ AED 11–88k  │   - Network       │ │   Client offer   │      │
│  │ │ ⓘ Learn     │   - Training      │ │   shown always   │      │
│  │ │ + Add       │   (greyed out)    │ │                  │      │
│  │ └─────────────┘                   │ │ [Continue →]     │      │
│  └────────────────────────────────────┘ └──────────────────┘      │
└──────────────────────────────────────────────────────────────────┘
```

On mobile, the cart sidebar collapses into a sticky bottom bar with item count + total range + "View cart" trigger that opens it as a full-screen sheet.

### 3.3 "Learn more" drawer (medium depth — 7 sections, ~200 words each)

Each of the 3 categories has its own drawer content:

1. **In plain English** — what the service is, no jargon
2. **You probably need this if...** — 4–6 buyer signals as a checklist
3. **What you'll get** — concrete deliverables (report, evidence pack, presentation)
4. **Skip this if...** — honest dis-qualifiers
5. **Common mistakes we see** — 3 buyer pitfalls we've observed
6. **How long it takes** — calendar-time, not just delivery-time
7. **Pairs well with** — links to other categories with one-line rationale

End of drawer: indicative range, lead time, "Add this to my cart" button.

### 3.4 Configuration drawer (when "Add to cart" clicked)

Slides up on mobile, slides in from right on desktop. Contains:

- 4–6 category-specific questions (radio / checkbox / select / number)
- Live range update at the bottom of the drawer as answers change
- **"Anything specific to flag for this service?"** textarea (optional)
- Footer buttons: **Cancel** (discard) / **Save to cart** (commit)

### 3.5 Cross-sell prompts

After each "Save to cart", a soft banner appears above the cart sidebar:

> 💡 You added [Service A]. Most clients pair it with [Service B] because [reason]. **[Yes, add]** **[Skip]**

Rules table:

| Added | Suggest | Reason |
|---|---|---|
| Offensive Security | GRC ISO 27001 | "Pen test is required A.8.29 evidence" |
| Offensive Security | (Phase 2: Awareness Training) | — |
| GRC ISO 27001 | Offensive Security | "ISO requires evidence of penetration testing" |
| GRC PDPL | Offensive Security | "Mandatory under PDPL Article 21" |
| Cloud Security | GRC ISO 27001 | "Maps Azure/M365 findings to ISO 27017 evidence" |
| Cloud Security | Offensive Security | "External pen test validates the cloud config" |

Only one suggestion shown at a time; dismissible; not blocking.

### 3.6 Cart resume

- localStorage key: `uw_scope_cart_v1`
- Stores: cart items + answers + universal comments draft + timestamp
- TTL: 7 days
- On return visit to `/scope-builder`, slim banner above catalogue:
  > "Welcome back — we kept your draft scope from {date}. **[Continue]** **[Start fresh]**"
- "Start fresh" clears localStorage and reloads

### 3.7 Final enquiry page (`/scope-builder/enquiry`)

- Read-only summary of cart with edit-back link
- **Universal Comments & Information block:**
  - "Anything specific you're worried about?" textarea
  - "Compliance / audit deadline if any?" date or text
  - "Existing tools / vendors already in place?" textarea
  - "Anything else we should know?" textarea
  - All optional
- **Founding Client opt-in:**
  > ☐ I'd like to be considered for Founding Client pricing (10–30% off in exchange for a case study, first 10 clients only)
- **Lead capture:**
  - Name (required)
  - Work email (required)
  - Company (required)
  - Phone (optional, with "WhatsApp OK?" checkbox)
  - Best time to call (select: today / this week / no rush)
- **Consent:**
  - ☑ "I agree to receive the scope quote by email and a follow-up call" (pre-checked, required)
- **Submit button:** "Submit and get your scope plan in 48h"

### 3.8 Confirmation page (`/scope-builder/thanks/[ref]`)

- ✓ Headline: "Thanks, {name}! Here's your scope plan."
- Cart summary with ranges
- Bundle range total
- Founding Client status (if opted in: "We'll lead with this on our call")
- "PDF emailed to {email}"
- "Reference: SCB-2026-{nnnn}"
- Calendly embed (optional booking)
- WhatsApp button: "Got a question? Message us on WhatsApp"
- Hosted-link reminder: "You can also view this scope online: {hosted_link}"

---

## 4. Per-Category Workflows

### 4.1 Offensive Security (refactor of existing engine)

Existing `/api/scope-builder.ts` engine is reused with adjustments:
- Output formatted as `AED {low} – {high}` (no midpoint exposure)
- Per-cart-item comments field added
- Founding Client opt-in surfaced separately

Question flow (already implemented, no logic changes):
1. What needs testing? (multi-select: network ext/int, web, mobile, API, cloud, phishing, VA-only)
2. Per asset: how many / size (xs/s/m/l)
3. Authenticated test required?
4. Retest required?
5. NDA required?
6. Driver (audit, board, breach, exploring)
7. Comments textarea (NEW)

### 4.2 GRC (new workflow)

1. **Frameworks** (multi-select): ISO 27001, NESA / UAE IA V2, UAE PDPL, ADHICS, Dubai ISR v2, PCI DSS v4, Risk Register only
2. **Engagement type per framework**:
   - Gap assessment only
   - Full implementation
   - Surveillance audit support (existing certified clients)
3. **Organisation context**:
   - Headcount (xs <30 / s 30–100 / m 100–500 / l 500+)
   - Locations (1 / 2–3 / 4+)
   - Sector (banking / healthcare / government / SME / IT / retail / other)
   - Sensitive data volume (low / medium / high)
4. **Timeline pressure**:
   - Hard audit / cert deadline (date input)
   - 6-month flexibility
   - Exploratory / 12-month plan
   - Just need a roadmap
5. **What's already done?** (multi-select): risk register / SoA / policies drafted / internal audit / asset register / nothing
6. **Comments textarea**

**Pricing logic:**
- Single framework gap assessment: AED 14,000 – 35,000 (depends on size + sector)
- Single framework implementation: AED 36,000 – 88,000 (depends on size + sector + timeline)
- Multi-framework bundle: each framework priced independently then bundle discount signal

### 4.3 Cloud Security (new workflow)

1. **Scope** (multi-select): Azure tenant review, M365 review, Entra ID / Conditional Access review
2. **Tenant footprint**:
   - Number of Azure subscriptions (1 / 2–5 / 6+)
   - M365 user count (xs <50 / s 50–150 / m 150–500 / l 500+)
   - SharePoint sites / Teams count (rough text)
3. **Configuration maturity**:
   - Conditional Access in place? (yes / partial / no)
   - MFA enforced? (yes / partial / no)
   - Defender for Cloud / Defender for Office licensed? (yes / no / unsure)
4. **Compliance driver**: CIS Benchmark / ISO 27017 / Internal audit / Insurance / Cleanup
5. **Comments textarea**

**Pricing logic:**
- Azure-only or M365-only: AED 7,000 – 18,000
- Combined Azure + M365: AED 11,000 – 24,000
- Multipliers for tenant size: xs 0.85, s 1.0, m 1.15, l 1.3

---

## 5. Founding Client Mechanics

- Banner shown on every cart view + enquiry page:
  > ★ Founding Client offer — 10–30% off for first 10 clients who agree to a case study. Opt in below.
- Opt-in checkbox on enquiry form
- **No automatic discount applied to displayed range** — sales negotiates the actual % on the call
- Opt-in surfaces:
  - In team email (highlighted block)
  - In Slack notification (🌟 emoji prefix)
  - As a custom attribute on the Krayin Lead (`founding_optin = true`)
  - On the Krayin lead title prefix: "[FC] {original title}"

---

## 6. Bundle Logic

When cart has 2+ items:
- Subtotal range = sum of individual item ranges
- Bundle discount **signal** (not applied):
  - 2 items: "Bundle saves ~5% — discussed in scoping call"
  - 3 items: "Bundle saves ~10% — discussed in scoping call"
  - 4+ items (Phase 2 territory): "Bundle saves ~15% — discussed in scoping call"
- Adjusted range shown alongside subtotal range

---

## 7. Backend Architecture

### 7.1 Astro endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/scope-builder` | Submit cart + lead → save → generate PDF → email → Krayin → Slack |
| `GET /scope/{token}` | Hosted PDF view page (HTML render of scope plan + PDF link + view ping) |
| `POST /api/scope/view-ping` | Internal endpoint called from `/scope/{token}` page on load → log view + forward to Krayin |
| `POST /api/krayin/lead-status` | Receive Krayin won/lost callbacks → update local scope record status |

### 7.2 Supabase tables

```sql
CREATE TABLE scopes (
  id              BIGSERIAL PRIMARY KEY,
  token           VARCHAR(32) UNIQUE NOT NULL,        -- hosted-link token
  reference       VARCHAR(20) UNIQUE NOT NULL,        -- "SCB-2026-0001" buyer-facing
  cart            JSONB NOT NULL,                     -- array of cart items
  comments        JSONB NOT NULL,                     -- universal comments block
  founding_optin  BOOLEAN NOT NULL DEFAULT false,
  range_low       INTEGER NOT NULL,
  range_high      INTEGER NOT NULL,
  bundle_savings  TEXT,                               -- "~10%" or null
  lead_name       VARCHAR(200) NOT NULL,
  lead_email      VARCHAR(200) NOT NULL,
  lead_company    VARCHAR(200) NOT NULL,
  lead_phone      VARCHAR(50),
  whatsapp_ok     BOOLEAN DEFAULT false,
  best_time       VARCHAR(20),
  krayin_lead_id  BIGINT,                             -- back-reference
  status          VARCHAR(20) DEFAULT 'submitted',    -- submitted/viewed/quoted/won/lost
  pdf_path        TEXT,                               -- /data/scopes/{token}.pdf
  expires_at      TIMESTAMPTZ NOT NULL,               -- 30 days from creation
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX scopes_token_idx ON scopes(token);
CREATE INDEX scopes_email_idx ON scopes(lead_email);

CREATE TABLE scope_views (
  id          BIGSERIAL PRIMARY KEY,
  scope_id    BIGINT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  viewed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip          INET,
  user_agent  TEXT,
  city        VARCHAR(100),
  country     VARCHAR(2),
  referer     TEXT
);

CREATE INDEX scope_views_scope_id_idx ON scope_views(scope_id);
```

### 7.3 PDF storage

- Path: `/data/scopes/{token}.pdf`
- Mounted as Docker volume on the frontend container, NOT under web root
- Served via authenticated Astro endpoint that validates the token + 30-day expiry
- Same PDF used as email attachment AND for hosted link download

### 7.4 Token + reference generation

- `token`: 32 chars, cryptographically random (`crypto.randomBytes(24).toString('base64url')`), not sequential
- `reference`: human-friendly `SCB-{YYYY}-{NNNN}` where NNNN is daily-resetting incrementing counter (database sequence per day)

### 7.5 Hosted link page (`/scope/{token}`)

- Server-side rendered Astro page
- Validates token + expiry, returns 410 if expired
- Returns 404 if not found
- Renders: header, cart items + ranges, bundle savings, founding-client block (if opted), comments, lead time, "Download PDF" button, "Book a call" Calendly button, "Ask on WhatsApp" button
- Inline `<script>` calls `POST /api/scope/view-ping` on load with referer
- HTTP headers:
  - `X-Robots-Tag: noindex, nofollow, noarchive`
  - `Cache-Control: private, no-store`
  - `Strict-Transport-Security: max-age=31536000`
- **Rate limit:** 30 requests / 5 min / token; 60 requests / 5 min / IP. Excess returns 429.

### 7.6 robots.txt

Add `Disallow: /scope/` to existing robots.txt.

---

## 8. Krayin CRM Integration

### 8.1 New webhook endpoints (added to `krayin/` folder, mounted into container)

#### `webhook-scope.php`
- POST endpoint, token-authed via existing `WEBHOOK_TOKEN` env var
- Input JSON: `{ name, email, company, phone, scope_token, scope_reference, range_low, range_high, founding_optin, cart_summary, comments, whatsapp_ok }`
- Behaviour:
  1. Upsert Webkul `Person` (by email) + `Organization` (by company name)
  2. Determine `Scope Builder` pipeline + first stage
  3. Create `Lead` with:
     - Title: `[FC]? {company} — {N} services — AED {low}–{high}` (FC prefix only if founding_optin)
     - Description: short summary of cart + comments
     - Lead source: `scope_builder`
     - Custom attributes: `scope_token`, `scope_reference`, `scope_range_low`, `scope_range_high`, `founding_optin`, `scope_view_count = 0`, `cart_summary` (JSON)
  4. Add Activity to lead: `Scope Submitted — {N} services — AED {low}–{high} · {comments_summary}`
  5. Optionally attach the PDF to the lead (resolve path from `pdf_path` shared via Docker volume)
  6. Return JSON: `{ success: true, lead_id: {id}, person_id: {id} }`

#### `webhook-scope-view.php`
- POST endpoint, token-authed
- Input JSON: `{ scope_token, ip, user_agent, city, country, referer }`
- Behaviour:
  1. Find Lead by `scope_token` custom attribute
  2. Increment `scope_view_count`
  3. Update `scope_last_viewed_at` to now
  4. Add Activity: `Scope viewed by {ip} ({city}, {country}) at {time} · UA: {ua_summary}`
  5. Return `{ success: true, view_count: {n} }`

### 8.2 New Krayin pipeline (one-time DB migration)

```
Pipeline name: "Scope Builder"
Stages:
  1. Submitted          (auto-set on webhook receipt)
  2. Reviewed
  3. Quoted
  4. Negotiating
  5. Won
  6. Lost
```

Provided as a Laravel migration in `krayin/migrations/2026_04_27_create_scope_builder_pipeline.php`, applied on container start via existing entrypoint hook.

### 8.3 Custom attributes

Created via Webkul Attribute system migration:

| Attribute code | Type | Visible on |
|---|---|---|
| `scope_token` | text (unique-indexed) | Lead |
| `scope_reference` | text | Lead |
| `scope_range_low` | decimal | Lead |
| `scope_range_high` | decimal | Lead |
| `founding_optin` | boolean | Lead |
| `scope_view_count` | integer (default 0) | Lead |
| `scope_last_viewed_at` | datetime | Lead |
| `cart_summary` | textarea (JSON) | Lead |

### 8.4 Reverse webhook (Krayin → Astro)

When sales moves a lead to "Won" or "Lost" stage in Krayin, Webkul fires a configured webhook to:

`POST https://underwings.org/api/krayin/lead-status`

Body: `{ scope_token, status }` where status ∈ `won` | `lost`.

Astro endpoint validates a shared signing secret (`KRAYIN_REVERSE_SECRET` env var) and updates `scopes.status` accordingly. The hosted scope page reflects this with a banner ("This quote has been confirmed" / "This quote expired"). No new Krayin code — uses Webkul's built-in webhook trigger configuration in admin.

---

## 9. Notifications

### 9.1 Email to buyer

- From: `quotes@underwings.org` (via Stalwart)
- To: lead email
- Subject: `Your scope plan: SCB-2026-{nnnn} · AED {low}–{high}`
- HTML body:
  - Greeting + reference number
  - Cart summary table
  - Bundle range
  - Founding Client status (if opted)
  - Hosted link button: `View online → /scope/{token}`
  - WhatsApp button: `wa.me/971547078203?text=Question about scope SCB-2026-{nnnn}`
  - Calendly link
- Attachment: `SCB-2026-{nnnn}.pdf`

### 9.2 Email to team

- From: `noreply@underwings.org`
- To: `itdept1@gcee.ae`
- Subject: `[NEW SCOPE] {company} — AED {low}–{high} · {N} services{founding_optin? ' · ★ FOUNDING CLIENT' : ''}`
- HTML body:
  - All cart items + answers
  - All comments (per-item + universal)
  - Founding-client opt-in highlighted block if true
  - Direct deep-link to Krayin lead: `https://crm.underwings.org/admin/leads/view/{krayin_lead_id}`
  - Hosted link
  - Buyer contact details

### 9.3 Slack (env-gated, deferred)

- Triggered only if `SLACK_SCOPE_WEBHOOK` env var is set (else silent no-op)
- Channel: `#scope-builder`
- Format:
  ```
  🌟 New scope · AED {low}–{high} · {N} services
  Company: {company}
  Founding-Client: {yes|no}
  → Krayin: {deep-link}
  → Hosted: {hosted-link}
  ```
- Second message type: `📊 Scope viewed · SCB-2026-{nnnn} · {city}, {country} · view #{n}`
- Implementation: simple incoming-webhook POST, no Slack SDK needed

### 9.4 WhatsApp

- Click-to-chat URL pattern: `https://wa.me/971547078203?text={url-encoded-message}`
- Used in:
  - Buyer confirmation email button
  - Hosted scope page CTA
  - Confirmation page CTA
- No outbound automation in Phase 1

---

## 10. Security

| Concern | Mitigation |
|---|---|
| Hosted link guessable | 32-char crypto-random tokens, not sequential |
| Search engine indexing | `noindex, nofollow, noarchive` HTTP header + `Disallow: /scope/` in robots.txt |
| Token enumeration | Rate limit per token + per IP, 429 on excess |
| Token leakage | 30-day expiry, renewable via sales request |
| PDF leakage from disk | Stored outside web root, served via authenticated endpoint |
| Krayin webhook abuse | Existing `WEBHOOK_TOKEN` shared secret, rotated on schedule |
| Reverse Krayin webhook spoofing | `KRAYIN_REVERSE_SECRET` HMAC validation |
| Buyer email tampering | Stalwart DKIM + SPF already configured |
| XSS in comments fields | Server-side HTML-escaping before storage + on render |
| SQL injection | Parameterised queries via Supabase client |
| Cart localStorage tampering | Server re-validates pricing on submit; localStorage is hint only |

---

## 11. Frontend Structure

### 11.1 New files

```
frontend/src/pages/scope-builder/
  index.astro                    -- catalogue + cart sidebar
  enquiry.astro                  -- final review + lead form
  thanks/[ref].astro             -- confirmation page

frontend/src/pages/scope/
  [token].astro                  -- hosted link page

frontend/src/components/scope-builder/
  ServiceCard.astro              -- catalogue card with Learn More
  LearnMoreDrawer.astro          -- 7-section educational drawer
  ConfigDrawer.astro             -- per-category config form
  CartSidebar.astro              -- live cart sidebar (mobile + desktop variants)
  CrossSellPrompt.astro          -- soft cross-sell banner
  FoundingBanner.astro           -- founding-client offer block

frontend/src/lib/scope-builder/
  cart.ts                        -- localStorage cart state + types
  pricing/
    offensive.ts                 -- existing engine wrapped + range output
    grc.ts                       -- new GRC engine
    cloud.ts                     -- new cloud engine
  bundle.ts                      -- bundle savings calculator
  copy/
    offensive-learnmore.md       -- 7-section content (markdown)
    grc-learnmore.md
    cloud-learnmore.md

frontend/src/pages/api/
  scope-builder.ts               -- main submit endpoint (refactored from existing)
  scope/
    view-ping.ts                 -- internal view tracker
  krayin/
    lead-status.ts               -- reverse webhook from Krayin

krayin/
  webhook-scope.php              -- new lead-creation webhook
  webhook-scope-view.php         -- view event webhook
  migrations/
    2026_04_27_create_scope_builder_pipeline.php
    2026_04_27_create_scope_attributes.php
```

### 11.2 Files modified

```
frontend/src/pages/services/offensive-security/scope-builder.astro
  → server-side 301 redirect to /scope-builder?seed=offensive

frontend/src/pages/services/{offensive-security,grc,cloud-security}/index.astro
  → "Get a scope plan" CTA links to /scope-builder?seed={category}

frontend/public/robots.txt
  → add `Disallow: /scope/`

docker-compose.yml
  → add /data/scopes volume mount on frontend container
  → add SLACK_SCOPE_WEBHOOK env var (initially unset)
  → add KRAYIN_REVERSE_SECRET env var
  → mount krayin/webhook-scope.php and webhook-scope-view.php into Krayin container
  → mount krayin/migrations into Krayin container
```

---

## 12. Testing Strategy

| Layer | Approach |
|---|---|
| Pricing engine (per category) | Pure TS unit tests with snapshot fixtures |
| Cart state machine | Vitest unit tests covering add/remove/edit/clear/resume |
| Submit API | Integration test hitting Supabase test schema + mocked Krayin webhook |
| Hosted link expiry | Manual + integration test for 30-day boundary |
| View tracking → Krayin | Integration test asserting Krayin Activity created |
| Email delivery | Manual smoke test with `it@gcee.ae` |
| PDF generation | Manual visual review per category combination |
| Mobile responsive | Manual testing on iOS Safari + Android Chrome |
| Cross-sell rules | Unit tests for each rule firing correctly |
| Founding-client display logic | Unit tests asserting opt-in surfaces in email/Krayin/Slack |

---

## 13. Migration & Rollout

### Day 0 (pre-launch)
- Krayin migrations run in staging container
- Test webhook with synthetic payload
- Verify pipeline + custom attributes appear in Krayin admin

### Day 1 (deploy)
- Deploy Astro frontend with feature
- Deploy updated Krayin container
- Update nginx (no changes needed — same host)
- Update robots.txt
- Smoke test full flow: submit → email → Krayin lead → hosted link → view → Krayin activity

### Day 1 — switchover
- Existing pen-test scope builder URL serves a 301 to seeded cart
- Existing `/api/scope-builder` endpoint kept intact for backwards compat with old URL clients (server-side detects v1 vs v2 payload shape)

### Day 2–7 — observation
- Monitor `scopes` table for daily volume + completion rate
- Monitor Krayin pipeline for lead quality
- Watch for view-tracking activity entries
- Tune cross-sell rules based on real submissions

### Phase 2 trigger
- When Phase 1 has produced ≥5 real submissions, add Network + Training workflows

---

## 14. Success Criteria

- Buyer can submit a 2-category scope from cold start in under 90 seconds
- Krayin lead appears within 5 seconds of submit
- View-tracking activity in Krayin within 5 seconds of hosted-link open
- PDF generates and emails within 30 seconds (acceptable for buyer expectations)
- Founding-client opt-in surfaces visibly in all 4 channels (email-team, Slack, Krayin title, Krayin custom attribute)
- Cart resume banner appears on return visit within 7 days
- All hosted links return `X-Robots-Tag: noindex` header
- No exact midpoint price exposed anywhere in UI / PDF / email — only ranges

---

## 15. Open Questions / Future

- Plane integration — once Plane is deployed, "Won" stage in Krayin should auto-create a Plane project with cart items as initial issues. Phase 3.
- WhatsApp Business API — for outbound automated nudges (e.g., 48h post-submit follow-up). Phase 3+. Currently click-to-chat only.
- Multi-language UI — Arabic UI for the cart + drawers when client demand justifies. Phase 4.
- Scope renewal flow — when a hosted link expires, "Request renewal" CTA that bumps the expiry by 30 days and re-emails. Phase 2.
