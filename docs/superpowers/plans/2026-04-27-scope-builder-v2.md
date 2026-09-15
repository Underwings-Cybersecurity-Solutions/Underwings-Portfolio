# Scope Builder v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pen-test-only scope builder with a cart-style multi-category lead-gen tool covering Offensive Security + GRC + Cloud Security, with Krayin CRM integration, tracked hosted PDF links, Slack/email/WhatsApp notifications, and Founding Client opt-in.

**Architecture:** Astro 4 SSR pages + lightweight TS cart state in localStorage; per-category pricing engines server-side; Supabase Postgres for scope + view records; Krayin webhooks for CRM sync; Stalwart SMTP for email; new Node sidecar `pdf-render` mirroring the existing `mjml` sidecar pattern; nginx already in place.

**Tech Stack:** Astro 4 (Node adapter) · TypeScript · Supabase JS client · Node 20 · Puppeteer (in PDF sidecar) · PHP/Laravel (Krayin) · MariaDB (Krayin) · Postgres (Supabase) · Stalwart SMTP · Docker Compose.

**Spec reference:** `docs/superpowers/specs/2026-04-27-scope-builder-v2-design.md`

---

## File Structure

### New files (frontend)

```
frontend/src/pages/scope-builder/
  index.astro                          catalogue + cart sidebar
  enquiry.astro                        review + lead capture form
  thanks/[ref].astro                   confirmation page

frontend/src/pages/scope/
  [token].astro                        hosted PDF view page

frontend/src/components/scope-builder/
  ServiceCard.astro                    catalogue card
  LearnMoreDrawer.astro                7-section educational drawer
  ConfigDrawer.astro                   per-category config form
  CartSidebar.astro                    sticky live cart
  CrossSellPrompt.astro                soft cross-sell banner
  FoundingBanner.astro                 founding-client offer block

frontend/src/lib/scope-builder/
  cart.ts                              cart types + localStorage state
  bundle.ts                            bundle savings calculator
  format.ts                            range / currency formatters
  reference.ts                         reference + token generation
  pricing/
    types.ts                           shared pricing engine interface
    offensive.ts                       offensive engine (range output)
    grc.ts                             GRC engine
    cloud.ts                           Cloud Security engine
  copy/
    offensive.ts                       7-section learn-more content
    grc.ts                             same
    cloud.ts                           same
    crosssell.ts                       cross-sell rules table

frontend/src/pages/api/
  scope-builder-v2.ts                  new submit endpoint (kept side-by-side with legacy)
  scope/
    view-ping.ts                       internal view tracker
  krayin/
    lead-status.ts                     reverse webhook from Krayin

frontend/src/lib/scope-builder/server/
  supabase.ts                          server-only Supabase admin client wrapper
  pdf.ts                               PDF render via sidecar HTTP call
  email.ts                             buyer + team email composer (nodemailer)
  slack.ts                             env-gated Slack incoming-webhook poster
  krayin.ts                            Krayin webhook poster (lead create + view ping)
```

### New files (Krayin)

```
krayin/
  webhook-scope.php                    inbound: create scope lead
  webhook-scope-view.php               inbound: log view as activity
  migrations/
    2026_04_27_000001_create_scope_pipeline.php
    2026_04_27_000002_create_scope_attributes.php
```

### New files (PDF sidecar)

```
pdf-render/
  Dockerfile
  package.json
  server.js                            POST /render { html } → PDF bytes
```

### New files (database)

```
supabase/migrations/
  20260427_scopes_tables.sql           creates scopes + scope_views tables
```

### Files modified

```
frontend/src/pages/services/offensive-security/scope-builder.astro
  → 301 redirect to /scope-builder?seed=offensive

frontend/src/pages/services/offensive-security/index.astro
frontend/src/pages/services/grc/index.astro
frontend/src/pages/services/cloud-security/index.astro
  → "Get a scope plan" CTA pointing to seeded URL

frontend/public/robots.txt
  → Disallow: /scope/

frontend/package.json
  → no new deps (PDF rendered in sidecar)

docker-compose.yml
  → add pdf-render service
  → mount krayin/webhook-scope.php + webhook-scope-view.php into Krayin
  → mount krayin/migrations into Krayin
  → add SLACK_SCOPE_WEBHOOK, KRAYIN_REVERSE_SECRET, PDF_RENDER_URL env vars
  → /data/scopes volume on frontend
```

---

## Task 1: Database — Supabase scopes tables

**Files:**
- Create: `supabase/migrations/20260427_scopes_tables.sql`

- [ ] **Step 1: Write migration SQL**

```sql
CREATE TABLE IF NOT EXISTS scopes (
  id              BIGSERIAL PRIMARY KEY,
  token           VARCHAR(32) UNIQUE NOT NULL,
  reference       VARCHAR(20) UNIQUE NOT NULL,
  cart            JSONB NOT NULL,
  comments        JSONB NOT NULL DEFAULT '{}'::jsonb,
  founding_optin  BOOLEAN NOT NULL DEFAULT false,
  range_low       INTEGER NOT NULL,
  range_high      INTEGER NOT NULL,
  bundle_savings  TEXT,
  lead_name       VARCHAR(200) NOT NULL,
  lead_email      VARCHAR(200) NOT NULL,
  lead_company    VARCHAR(200) NOT NULL,
  lead_phone      VARCHAR(50),
  whatsapp_ok     BOOLEAN NOT NULL DEFAULT false,
  best_time       VARCHAR(20),
  krayin_lead_id  BIGINT,
  status          VARCHAR(20) NOT NULL DEFAULT 'submitted',
  pdf_path        TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scopes_token_idx ON scopes(token);
CREATE INDEX IF NOT EXISTS scopes_email_idx ON scopes(lead_email);
CREATE INDEX IF NOT EXISTS scopes_status_idx ON scopes(status);

CREATE TABLE IF NOT EXISTS scope_views (
  id          BIGSERIAL PRIMARY KEY,
  scope_id    BIGINT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  viewed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip          INET,
  user_agent  TEXT,
  city        VARCHAR(100),
  country     VARCHAR(2),
  referer     TEXT
);

CREATE INDEX IF NOT EXISTS scope_views_scope_id_idx ON scope_views(scope_id);

-- daily reference counter sequence reset trigger
CREATE TABLE IF NOT EXISTS scope_reference_counter (
  day   DATE PRIMARY KEY,
  next  INTEGER NOT NULL DEFAULT 1
);

CREATE OR REPLACE FUNCTION next_scope_reference() RETURNS TEXT AS $$
DECLARE
  today DATE := CURRENT_DATE;
  n INTEGER;
BEGIN
  INSERT INTO scope_reference_counter(day, next) VALUES (today, 2)
    ON CONFLICT (day) DO UPDATE SET next = scope_reference_counter.next + 1
    RETURNING next - 1 INTO n;
  RETURN 'SCB-' || TO_CHAR(today, 'YYYY') || '-' || LPAD(n::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;
```

- [ ] **Step 2: Apply via Supabase Studio or psql**

```bash
docker compose exec db psql -U postgres -d postgres -f /docker-entrypoint-initdb.d/migrations/20260427_scopes_tables.sql
```

Or copy/paste into Supabase Studio SQL editor at `https://supabase.underwings.org`.

- [ ] **Step 3: Verify tables exist**

```bash
docker compose exec db psql -U postgres -d postgres -c "\dt scopes scope_views scope_reference_counter"
```

Expected: 3 rows listing all three tables.

- [ ] **Step 4: Verify reference function**

```bash
docker compose exec db psql -U postgres -d postgres -c "SELECT next_scope_reference(), next_scope_reference();"
```

Expected: `SCB-2026-0001`, `SCB-2026-0002`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260427_scopes_tables.sql
git commit -m "feat(scope-builder): add scopes + scope_views tables"
```

---

## Task 2: Cart types + localStorage manager

**Files:**
- Create: `frontend/src/lib/scope-builder/cart.ts`

- [ ] **Step 1: Write cart types and state manager**

```ts
// frontend/src/lib/scope-builder/cart.ts
export type CategoryId = 'offensive' | 'grc' | 'cloud';

export interface CartItem {
  id: string;                    // crypto.randomUUID()
  category: CategoryId;
  answers: Record<string, unknown>;
  comments?: string;
  range: { low: number; high: number };
  summary: string;               // human-readable one-line
}

export interface UniversalComments {
  worry?: string;
  deadline?: string;
  existing?: string;
  other?: string;
}

export interface CartState {
  items: CartItem[];
  universal: UniversalComments;
  founding_optin: boolean;
  updated_at: number;            // Date.now()
  version: 1;
}

const STORAGE_KEY = 'uw_scope_cart_v1';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function loadCart(): CartState | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw) as CartState;
    if (state.version !== 1) return null;
    if (Date.now() - state.updated_at > TTL_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

export function saveCart(state: CartState): void {
  if (typeof localStorage === 'undefined') return;
  state.updated_at = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function emptyCart(): CartState {
  return { items: [], universal: {}, founding_optin: false, updated_at: Date.now(), version: 1 };
}

export function clearCart(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

export function addItem(state: CartState, item: Omit<CartItem, 'id'>): CartState {
  return { ...state, items: [...state.items, { ...item, id: crypto.randomUUID() }] };
}

export function removeItem(state: CartState, id: string): CartState {
  return { ...state, items: state.items.filter((i) => i.id !== id) };
}

export function updateItem(state: CartState, id: string, patch: Partial<CartItem>): CartState {
  return { ...state, items: state.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) };
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/scope-builder/cart.ts
git commit -m "feat(scope-builder): cart types and localStorage manager"
```

---

## Task 3: Format helpers + token/reference utilities

**Files:**
- Create: `frontend/src/lib/scope-builder/format.ts`
- Create: `frontend/src/lib/scope-builder/reference.ts`

- [ ] **Step 1: Write format helpers**

```ts
// frontend/src/lib/scope-builder/format.ts
export function fmtAED(n: number): string {
  return 'AED ' + n.toLocaleString('en-AE');
}

export function fmtRange(low: number, high: number): string {
  return `AED ${low.toLocaleString('en-AE')} – ${high.toLocaleString('en-AE')}`;
}

export function fmtRangeShort(low: number, high: number): string {
  const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `${n}`;
  return `AED ${k(low)} – ${k(high)}`;
}
```

- [ ] **Step 2: Write reference + token generator (server-only)**

```ts
// frontend/src/lib/scope-builder/reference.ts
import { randomBytes } from 'node:crypto';

export function generateToken(): string {
  // 24 bytes → 32-char base64url, URL-safe, ~144 bits entropy
  return randomBytes(24).toString('base64url');
}

export function expiryDate(days = 30): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/scope-builder/format.ts frontend/src/lib/scope-builder/reference.ts
git commit -m "feat(scope-builder): format + reference helpers"
```

---

## Task 4: Pricing engine interface + Offensive engine wrapper

**Files:**
- Create: `frontend/src/lib/scope-builder/pricing/types.ts`
- Create: `frontend/src/lib/scope-builder/pricing/offensive.ts`

- [ ] **Step 1: Write shared interface**

```ts
// frontend/src/lib/scope-builder/pricing/types.ts
export interface PricingResult {
  low: number;
  high: number;
  leadTimeWeeks: { min: number; max: number };
  summary: string;     // human-readable one-line for cart
}

export interface PricingEngine<A> {
  category: 'offensive' | 'grc' | 'cloud';
  score(answers: A): PricingResult;
}
```

- [ ] **Step 2: Write Offensive engine wrapper**

```ts
// frontend/src/lib/scope-builder/pricing/offensive.ts
import type { PricingEngine, PricingResult } from './types';

export interface OffensiveAnswers {
  services: Array<'network_ext' | 'network_int' | 'web' | 'mobile_one' | 'mobile_both' | 'api' | 'cloud' | 'phishing' | 'va_only'>;
  size: 'xs' | 's' | 'm' | 'l';
  authenticated: boolean;
  retest: boolean;
  phishing_count?: number;
  driver: 'audit' | 'board' | 'breach' | 'exploring';
}

const PRICES = {
  network_ext:   { low: 15000, high: 36000 },
  network_int:   { low: 26000, high: 52000 },
  web:           { low: 12000, high: 32000 },
  mobile_one:    { low: 14000, high: 28000 },
  mobile_both:   { low: 22000, high: 44000 },
  api:           { low: 12000, high: 28000 },
  cloud:         { low:  9000, high: 20000 },
  phishing:      { low:  3500, high: 12000 },
  va_only:       { low:  3500, high: 10000 },
} as const;
const SIZE_MULT = { xs: 0.85, s: 1.0, m: 1.15, l: 1.3 } as const;

export const offensiveEngine: PricingEngine<OffensiveAnswers> = {
  category: 'offensive',
  score(a) {
    const m = SIZE_MULT[a.size];
    let low = 0, high = 0;
    for (const s of a.services) {
      const p = PRICES[s as keyof typeof PRICES];
      if (!p) continue;
      low  += Math.round(p.low  * m);
      high += Math.round(p.high * m);
    }
    if (a.authenticated) { low *= 1.05; high *= 1.10; }
    if (a.retest)        { low *= 1.05; high *= 1.05; }
    low = Math.round(low / 500) * 500;
    high = Math.round(high / 500) * 500;
    const summary = `Offensive · ${a.services.length} service(s) · ${a.size.toUpperCase()}${a.authenticated ? ' · authenticated' : ''}`;
    return { low, high, leadTimeWeeks: { min: 2, max: 4 }, summary };
  },
};
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/scope-builder/pricing/
git commit -m "feat(scope-builder): pricing engine interface + offensive wrapper"
```

---

## Task 5: GRC pricing engine

**Files:**
- Create: `frontend/src/lib/scope-builder/pricing/grc.ts`

- [ ] **Step 1: Write GRC engine**

```ts
// frontend/src/lib/scope-builder/pricing/grc.ts
import type { PricingEngine, PricingResult } from './types';

export type GRCFramework = 'iso27001' | 'nesa' | 'pdpl' | 'adhics' | 'dubai_isr' | 'pci' | 'risk_register';
export type GRCEngagement = 'gap' | 'implementation' | 'surveillance';

export interface GRCAnswers {
  frameworks: GRCFramework[];
  engagement: Record<GRCFramework, GRCEngagement>;
  size: 'xs' | 's' | 'm' | 'l';
  locations: 1 | 2 | 3;          // 1, 2-3, 4+
  sector: 'banking' | 'healthcare' | 'government' | 'sme' | 'it' | 'retail' | 'other';
  data_volume: 'low' | 'med' | 'high';
  timeline: 'hard_deadline' | 'six_months' | 'twelve_months' | 'roadmap';
  done: Array<'risk_register' | 'soa' | 'policies' | 'internal_audit' | 'asset_register'>;
}

const BASE: Record<GRCFramework, { gap: [number, number]; implementation: [number, number] }> = {
  iso27001:      { gap: [14000, 28000], implementation: [36000, 88000] },
  nesa:          { gap: [14000, 35000], implementation: [40000, 95000] },
  pdpl:          { gap: [11000, 24000], implementation: [22000, 55000] },
  adhics:        { gap: [18000, 38000], implementation: [45000, 100000] },
  dubai_isr:     { gap: [16000, 32000], implementation: [38000, 80000] },
  pci:           { gap: [18000, 36000], implementation: [45000, 95000] },
  risk_register: { gap: [14000, 30000], implementation: [14000, 30000] },
};
const SIZE_MULT = { xs: 0.85, s: 1.0, m: 1.2, l: 1.45 } as const;
const SECTOR_MULT = { banking: 1.2, healthcare: 1.15, government: 1.15, it: 1.0, retail: 1.0, sme: 0.9, other: 1.0 } as const;
const TIMELINE_MULT = { hard_deadline: 1.15, six_months: 1.0, twelve_months: 0.95, roadmap: 0.9 } as const;

export const grcEngine: PricingEngine<GRCAnswers> = {
  category: 'grc',
  score(a) {
    const m = SIZE_MULT[a.size] * SECTOR_MULT[a.sector] * TIMELINE_MULT[a.timeline];
    let low = 0, high = 0;
    for (const fw of a.frameworks) {
      const eng = a.engagement[fw] === 'implementation' ? 'implementation' : 'gap';
      const [bLow, bHigh] = BASE[fw][eng];
      low  += bLow  * m;
      high += bHigh * m;
    }
    // small discount per "done" credit
    const credits = Math.min(0.15, a.done.length * 0.03);
    low  *= (1 - credits);
    high *= (1 - credits);
    low  = Math.round(low  / 500) * 500;
    high = Math.round(high / 500) * 500;
    const fwLabel = a.frameworks.map((f) => f.replace('_', ' ')).join(', ');
    const summary = `GRC · ${fwLabel} · ${a.size.toUpperCase()}${a.timeline === 'hard_deadline' ? ' · deadline' : ''}`;
    const leadMax = a.frameworks.some((f) => a.engagement[f] === 'implementation') ? 24 : 8;
    return { low, high, leadTimeWeeks: { min: 4, max: leadMax }, summary };
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/scope-builder/pricing/grc.ts
git commit -m "feat(scope-builder): GRC pricing engine"
```

---

## Task 6: Cloud Security pricing engine

**Files:**
- Create: `frontend/src/lib/scope-builder/pricing/cloud.ts`

- [ ] **Step 1: Write Cloud engine**

```ts
// frontend/src/lib/scope-builder/pricing/cloud.ts
import type { PricingEngine, PricingResult } from './types';

export type CloudScope = 'azure' | 'm365' | 'entra';

export interface CloudAnswers {
  scope: CloudScope[];
  azure_subs: 1 | 2 | 3;            // 1 / 2-5 / 6+
  m365_users: 'xs' | 's' | 'm' | 'l';
  conditional_access: 'yes' | 'partial' | 'no';
  mfa: 'yes' | 'partial' | 'no';
  defender: 'yes' | 'no' | 'unsure';
  driver: 'cis' | 'iso17' | 'audit' | 'insurance' | 'cleanup';
}

const SCOPE_BASE: Record<CloudScope, [number, number]> = {
  azure: [9000, 20000],
  m365:  [7000, 18000],
  entra: [6000, 14000],
};
const M365_USER_MULT = { xs: 0.85, s: 1.0, m: 1.2, l: 1.45 } as const;
const AZURE_SUB_MULT = { 1: 1.0, 2: 1.15, 3: 1.35 } as const;

export const cloudEngine: PricingEngine<CloudAnswers> = {
  category: 'cloud',
  score(a) {
    let low = 0, high = 0;
    for (const s of a.scope) {
      const [bLow, bHigh] = SCOPE_BASE[s];
      let m = 1.0;
      if (s === 'azure') m *= AZURE_SUB_MULT[a.azure_subs];
      if (s === 'm365' || s === 'entra') m *= M365_USER_MULT[a.m365_users];
      low  += bLow  * m;
      high += bHigh * m;
    }
    // immature config = more remediation effort hint
    const maturityPenalty = (a.conditional_access === 'no' ? 0.05 : 0) + (a.mfa === 'no' ? 0.05 : 0);
    low  *= (1 + maturityPenalty);
    high *= (1 + maturityPenalty);
    low  = Math.round(low  / 500) * 500;
    high = Math.round(high / 500) * 500;
    const summary = `Cloud Security · ${a.scope.join(' + ').toUpperCase()} · ${a.m365_users.toUpperCase()}`;
    return { low, high, leadTimeWeeks: { min: 2, max: 4 }, summary };
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/scope-builder/pricing/cloud.ts
git commit -m "feat(scope-builder): Cloud Security pricing engine"
```

---

## Task 7: Bundle calculator + cross-sell rules

**Files:**
- Create: `frontend/src/lib/scope-builder/bundle.ts`
- Create: `frontend/src/lib/scope-builder/copy/crosssell.ts`

- [ ] **Step 1: Write bundle calculator**

```ts
// frontend/src/lib/scope-builder/bundle.ts
import type { CartItem } from './cart';

export interface BundleResult {
  subtotal: { low: number; high: number };
  adjusted: { low: number; high: number };
  savings_pct: number;        // 0, 5, 10, 15
  signal: string;             // "Bundle saves ~10% — discussed in scoping call"
}

export function bundle(items: CartItem[]): BundleResult {
  const subLow  = items.reduce((s, i) => s + i.range.low,  0);
  const subHigh = items.reduce((s, i) => s + i.range.high, 0);
  const n = items.length;
  let pct = 0;
  if (n === 2) pct = 5;
  else if (n === 3) pct = 10;
  else if (n >= 4) pct = 15;
  const adjLow  = Math.round((subLow  * (1 - pct / 100)) / 500) * 500;
  const adjHigh = Math.round((subHigh * (1 - pct / 100)) / 500) * 500;
  const signal = pct === 0
    ? ''
    : `Bundle saves ~${pct}% — discussed in scoping call`;
  return { subtotal: { low: subLow, high: subHigh }, adjusted: { low: adjLow, high: adjHigh }, savings_pct: pct, signal };
}
```

- [ ] **Step 2: Write cross-sell rules**

```ts
// frontend/src/lib/scope-builder/copy/crosssell.ts
import type { CategoryId } from '../cart';

export interface CrossSellRule {
  if_added: CategoryId;
  unless_in_cart: CategoryId[];
  suggest: CategoryId;
  reason: string;
}

export const CROSS_SELL: CrossSellRule[] = [
  { if_added: 'offensive', unless_in_cart: ['grc'], suggest: 'grc',
    reason: 'ISO 27001 requires evidence of penetration testing under control A.8.29.' },
  { if_added: 'grc',       unless_in_cart: ['offensive'], suggest: 'offensive',
    reason: 'ISO and NESA both require evidence of pen testing — pair them now.' },
  { if_added: 'cloud',     unless_in_cart: ['grc'], suggest: 'grc',
    reason: 'Cloud findings map cleanly to ISO 27017 evidence — saves you the manual mapping later.' },
  { if_added: 'cloud',     unless_in_cart: ['offensive'], suggest: 'offensive',
    reason: 'External pen test validates the cloud config from an attacker perspective.' },
];

export function pickCrossSell(addedCategory: CategoryId, currentCategories: CategoryId[]): CrossSellRule | null {
  for (const rule of CROSS_SELL) {
    if (rule.if_added !== addedCategory) continue;
    if (rule.unless_in_cart.some((c) => currentCategories.includes(c))) continue;
    return rule;
  }
  return null;
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/scope-builder/bundle.ts frontend/src/lib/scope-builder/copy/crosssell.ts
git commit -m "feat(scope-builder): bundle calculator + cross-sell rules"
```

---

## Task 8: Learn-more content (3 categories)

**Files:**
- Create: `frontend/src/lib/scope-builder/copy/offensive.ts`
- Create: `frontend/src/lib/scope-builder/copy/grc.ts`
- Create: `frontend/src/lib/scope-builder/copy/cloud.ts`

- [ ] **Step 1: Define content type once**

Add this at the top of each `copy/<cat>.ts` file:

```ts
export interface LearnMoreContent {
  title: string;
  range: string;                 // "AED 3,500 – 48,000"
  leadTime: string;              // "2 – 4 weeks per engagement"
  plain_english: string;
  need_this_if: string[];
  what_you_get: string[];
  skip_this_if: string[];
  common_mistakes: string[];
  how_long: string;
  pairs_with: Array<{ category: string; reason: string }>;
}
```

- [ ] **Step 2: Write offensive content**

```ts
// frontend/src/lib/scope-builder/copy/offensive.ts
export interface LearnMoreContent { /* (as above — copy the type) */ }

export const offensiveContent: LearnMoreContent = {
  title: 'Offensive Security — Penetration Testing & VAPT',
  range: 'AED 3,500 – 48,000',
  leadTime: '2 – 4 weeks per engagement',
  plain_english: 'We try to break your systems the same way an attacker would. Manual exploitation, not automated scanning. Networks, web apps, mobile apps, cloud, phishing — pick what matters and we’ll test it like an adversary.',
  need_this_if: [
    'You’re launching a new product and have never had a pen test',
    'Your auditor / regulator / client asked for a pen-test report',
    'You suspect drift since your last test was 6+ months ago',
    'You want a real-world test, not a CVE list from a scanner',
  ],
  what_you_get: [
    'Risk-rated findings report with CVSS scoring (PDF)',
    'Step-by-step reproduction notes per finding',
    'Remediation guidance per finding, not just headlines',
    'Free retest within 60 days of the original report',
    'Optional executive 1-pager for the board',
  ],
  skip_this_if: [
    'You had a pen test in the last 6 months and nothing has changed',
    'Your application isn’t deployed anywhere yet — start with a code review instead',
  ],
  common_mistakes: [
    'Ordering only an automated scan because it’s cheap — auditors increasingly reject scan-only reports',
    'Picking external testing only when most breaches start internally — internal tests find lateral movement that external never sees',
    'Skipping the retest — without it you have a finding list, not proof of fix',
  ],
  how_long: 'Calendar time is 2 – 4 weeks: 1 week scoping + paperwork, 1–2 weeks active testing, 3 – 5 days reporting and walkthrough.',
  pairs_with: [
    { category: 'GRC', reason: 'ISO 27001 / NESA / PDPL all require evidence of pen testing — bundle to avoid duplicate scoping.' },
    { category: 'Training & Awareness', reason: 'Pen test findings turn into a phishing simulation that proves the fixes stick.' },
  ],
};
```

- [ ] **Step 3: Write GRC content**

```ts
// frontend/src/lib/scope-builder/copy/grc.ts
export interface LearnMoreContent { /* (copy of the type) */ }

export const grcContent: LearnMoreContent = {
  title: 'GRC — Governance, Risk & Compliance',
  range: 'AED 11,000 – 88,000',
  leadTime: '4 – 24 weeks depending on framework + engagement',
  plain_english: 'We help you actually achieve a security framework — ISO 27001, NESA, UAE PDPL, ADHICS, Dubai ISR, PCI DSS — instead of producing more advice. Gap assessment to find where you are, implementation to get you there, audit support to keep you there.',
  need_this_if: [
    'A client, regulator, or auditor has requested ISO / NESA / PDPL evidence',
    'You’ve started an ISMS and stalled before audit',
    'You hold UAE personal data and aren’t sure what PDPL requires',
    'Your insurer is asking for a controls maturity score',
    'You’re bidding for government work that needs ADHICS / NESA / Dubai ISR',
  ],
  what_you_get: [
    'Gap report against the chosen framework with controls scored 0 – 4',
    'Prioritised 90-day / 6-month / 12-month remediation roadmap',
    'For implementation: full policies, SoA, risk register, internal audit',
    'Audit-ready evidence pack indexed to the framework controls',
    'Free certification-body interview support during external audit',
  ],
  skip_this_if: [
    'You only need one policy template — that’s a 1-day engagement, not a GRC project',
    'You’re not sure which framework yet — start with our 30-min scoping call instead',
  ],
  common_mistakes: [
    'Skipping the gap assessment and jumping straight to implementation — you don’t know what to remediate',
    'Treating the risk register as a one-time deliverable instead of a living artefact',
    'Outsourcing the entire ISMS — auditors expect to see your team owning it',
  ],
  how_long: 'Gap assessments run 3 – 6 weeks. Full ISO 27001 implementations run 4 – 6 months end-to-end including external audit prep. Surveillance audits run 2 – 4 weeks.',
  pairs_with: [
    { category: 'Offensive Security', reason: 'ISO 27001 control A.8.29 requires evidence of pen testing — get it scoped together.' },
    { category: 'Cloud Security', reason: 'M365/Azure findings map directly to ISO 27017 evidence — saves duplicate scoping.' },
  ],
};
```

- [ ] **Step 4: Write Cloud Security content**

```ts
// frontend/src/lib/scope-builder/copy/cloud.ts
export interface LearnMoreContent { /* (copy of the type) */ }

export const cloudContent: LearnMoreContent = {
  title: 'Cloud Security — Azure, Microsoft 365, Entra ID',
  range: 'AED 7,000 – 24,000',
  leadTime: '2 – 4 weeks',
  plain_english: 'We review your Azure tenant and Microsoft 365 setup against the CIS Benchmark and Microsoft’s own best practices, then give you a prioritised list of what to fix. Conditional Access, MFA, Defender, Storage, NSGs, Entra roles — all of it.',
  need_this_if: [
    'You moved to Microsoft 365 / Azure in the last 2 years and never reviewed config',
    'You enabled Conditional Access partially and aren’t sure what’s enforced',
    'A breach in your industry made the board ask “are we configured properly?”',
    'You’re working towards ISO 27017 / 27018 cloud-specific evidence',
    'Defender for Cloud / Office is licensed but not actually configured',
  ],
  what_you_get: [
    'CIS Benchmark scored report (Azure or M365) — pass / fail per control',
    'Conditional Access + MFA enforcement gap analysis',
    'Entra ID role hygiene review (privileged role exposure)',
    'Defender for Cloud / Office configuration review with quick wins',
    'Prioritised remediation list with effort estimates',
  ],
  skip_this_if: [
    'You haven’t adopted M365 or Azure yet — wait until at least the basic tenant is built',
    'You already had this done in the last 6 months and Conditional Access hasn’t changed',
  ],
  common_mistakes: [
    'Trusting the default M365 setup — Microsoft ships “open by default” for most controls',
    'Enabling MFA but leaving legacy auth enabled, which silently bypasses MFA',
    'Buying Defender licences but never enabling Defender for Cloud workload protection',
  ],
  how_long: 'Single-cloud review runs 2 – 3 weeks. Combined Azure + M365 + Entra runs 3 – 4 weeks including walkthrough.',
  pairs_with: [
    { category: 'GRC', reason: 'Maps directly to ISO 27017 control evidence — saves duplicate effort.' },
    { category: 'Offensive Security', reason: 'External pen test validates the cloud config from an attacker’s view.' },
  ],
};
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/scope-builder/copy/
git commit -m "feat(scope-builder): learn-more content for 3 categories"
```

---

## Task 9: Server-side Supabase admin client wrapper

**Files:**
- Create: `frontend/src/lib/scope-builder/server/supabase.ts`

- [ ] **Step 1: Write wrapper**

```ts
// frontend/src/lib/scope-builder/server/supabase.ts
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.SUPABASE_URL || process.env.SUPABASE_URL;
const key = import.meta.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
}

export const supa = createClient(url, key, { auth: { persistSession: false } });

export async function nextReference(): Promise<string> {
  const { data, error } = await supa.rpc('next_scope_reference');
  if (error) throw new Error('Failed to allocate reference: ' + error.message);
  return data as string;
}
```

- [ ] **Step 2: Verify env vars exist in docker-compose.yml**

```bash
grep -E "SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY" /home/deployer/underwings/docker-compose.yml
```

If absent on the `frontend` service, add them. They may already exist elsewhere — check first.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/scope-builder/server/supabase.ts
git commit -m "feat(scope-builder): server-side Supabase admin wrapper"
```

---

## Task 10: PDF render sidecar

**Files:**
- Create: `pdf-render/Dockerfile`
- Create: `pdf-render/package.json`
- Create: `pdf-render/server.js`

- [ ] **Step 1: Write Dockerfile**

```Dockerfile
# pdf-render/Dockerfile
FROM ghcr.io/puppeteer/puppeteer:23.6.0

USER root
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
USER pptruser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]
```

- [ ] **Step 2: Write package.json**

```json
{
  "name": "pdf-render",
  "version": "1.0.0",
  "type": "module",
  "main": "server.js",
  "dependencies": {
    "puppeteer": "23.6.0"
  }
}
```

- [ ] **Step 3: Write server.js**

```js
// pdf-render/server.js
import http from 'node:http';
import puppeteer from 'puppeteer';

const PORT = 3000;
const SHARED = process.env.SHARED_TOKEN || '';

const browserPromise = puppeteer.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  headless: 'new',
});

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method !== 'POST' || req.url !== '/render') {
    res.writeHead(404); return res.end('Not found');
  }
  if (SHARED && req.headers['x-shared-token'] !== SHARED) {
    res.writeHead(401); return res.end('Unauthorized');
  }
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 5_000_000) { req.destroy(); }});
  req.on('end', async () => {
    try {
      const { html, format = 'A4' } = JSON.parse(raw);
      if (!html) { res.writeHead(400); return res.end('html required'); }
      const browser = await browserPromise;
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 });
      const pdf = await page.pdf({ format, printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' }});
      await page.close();
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length });
      res.end(pdf);
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e) }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`pdf-render listening on ${PORT}`));
```

- [ ] **Step 4: Add to docker-compose.yml**

Insert under `services:` (after `mjml`):

```yaml
  pdf-render:
    build: ./pdf-render
    container_name: underwings-pdf-render
    restart: unless-stopped
    environment:
      - SHARED_TOKEN=${PDF_RENDER_TOKEN}
    networks:
      - underwings
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

Add to `frontend` service `depends_on`:
```yaml
      pdf-render:
        condition: service_healthy
```

Add to `frontend` env:
```yaml
      - PDF_RENDER_URL=http://pdf-render:3000
      - PDF_RENDER_TOKEN=${PDF_RENDER_TOKEN}
```

Add a `PDF_RENDER_TOKEN` to `.env` (random 40-char hex).

- [ ] **Step 5: Build and start the sidecar**

```bash
docker compose build pdf-render && docker compose up -d pdf-render
sleep 8
docker compose ps pdf-render
docker compose exec pdf-render wget -q -O - http://127.0.0.1:3000/health
```

Expected last line: `{"ok":true}`.

- [ ] **Step 6: Commit**

```bash
git add pdf-render/ docker-compose.yml
git commit -m "feat(scope-builder): pdf-render sidecar (puppeteer)"
```

---

## Task 11: PDF wrapper + HTML template

**Files:**
- Create: `frontend/src/lib/scope-builder/server/pdf.ts`

- [ ] **Step 1: Write the PDF wrapper**

```ts
// frontend/src/lib/scope-builder/server/pdf.ts
import { fmtRange } from '../format';
import type { CartItem, UniversalComments } from '../cart';
import type { BundleResult } from '../bundle';

interface PdfInput {
  reference: string;
  token: string;
  cart: CartItem[];
  bundle: BundleResult;
  comments: UniversalComments;
  founding_optin: boolean;
  lead: { name: string; email: string; company: string };
  expires_at: Date;
}

export function buildScopePdfHtml(d: PdfInput): string {
  const itemsHtml = d.cart.map((i) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #e5e7eb">
        <div style="font-weight:600">${escape(i.summary)}</div>
        ${i.comments ? `<div style="color:#666;font-size:12px;margin-top:4px">Note: ${escape(i.comments)}</div>` : ''}
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums">
        ${fmtRange(i.range.low, i.range.high)}
      </td>
    </tr>`).join('');

  const commentsHtml = [
    d.comments.worry    && `<p><strong>Specific concern:</strong> ${escape(d.comments.worry)}</p>`,
    d.comments.deadline && `<p><strong>Deadline:</strong> ${escape(d.comments.deadline)}</p>`,
    d.comments.existing && `<p><strong>Existing tools:</strong> ${escape(d.comments.existing)}</p>`,
    d.comments.other    && `<p><strong>Other notes:</strong> ${escape(d.comments.other)}</p>`,
  ].filter(Boolean).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; max-width: 720px; margin: 32px auto; padding: 0 24px; font-size: 14px; line-height: 1.5; }
  h1 { font-size: 22px; margin: 0 0 4px; color: #0a3a1f; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .08em; color: #0a3a1f; margin: 28px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  .meta { color: #666; font-size: 12px; }
  .total { font-size: 18px; font-weight: 700; color: #0a3a1f; }
  .founding { background: #fff7d6; border: 1px solid #f0c14b; border-radius: 6px; padding: 12px 16px; margin: 16px 0; }
</style></head><body>
  <h1>Scope Plan — ${escape(d.reference)}</h1>
  <div class="meta">${escape(d.lead.company)} · ${escape(d.lead.name)} · ${escape(d.lead.email)} · Generated ${new Date().toLocaleDateString('en-AE')}</div>

  <h2>Recommended Plan</h2>
  <table>${itemsHtml}</table>

  <table style="margin-top:16px">
    <tr><td>Subtotal range</td><td style="text-align:right">${fmtRange(d.bundle.subtotal.low, d.bundle.subtotal.high)}</td></tr>
    ${d.bundle.savings_pct > 0 ? `<tr><td>${escape(d.bundle.signal)}</td><td style="text-align:right">−${d.bundle.savings_pct}%</td></tr>` : ''}
    <tr><td class="total">Adjusted range</td><td class="total" style="text-align:right">${fmtRange(d.bundle.adjusted.low, d.bundle.adjusted.high)}</td></tr>
  </table>

  ${d.founding_optin ? `<div class="founding"><strong>★ Founding Client opt-in noted.</strong> We will lead with our 10–30% discount on the scoping call in exchange for a published case study.</div>` : ''}

  ${commentsHtml ? `<h2>Your Notes</h2>${commentsHtml}` : ''}

  <h2>Next Steps</h2>
  <p>1. We review your scope and prepare a written fixed-price quote within 48 hours.<br>
  2. We schedule a 30-min scoping call to confirm assumptions.<br>
  3. We send a signed engagement letter and start work the following week.</p>

  <h2>Quote Reference</h2>
  <p>Reference: <strong>${escape(d.reference)}</strong> · Valid until ${d.expires_at.toLocaleDateString('en-AE')} · View online at <code>https://underwings.org/scope/${escape(d.token)}</code></p>

  <div class="meta" style="margin-top:32px">Underwings Cybersecurity Solutions · United Arab Emirates · underwings.org</div>
</body></html>`;
}

function escape(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export async function renderPdf(html: string): Promise<Buffer> {
  const url   = process.env.PDF_RENDER_URL   || 'http://pdf-render:3000';
  const token = process.env.PDF_RENDER_TOKEN || '';
  const res = await fetch(url + '/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shared-Token': token },
    body: JSON.stringify({ html }),
  });
  if (!res.ok) throw new Error(`pdf-render returned ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/scope-builder/server/pdf.ts
git commit -m "feat(scope-builder): PDF HTML template + sidecar wrapper"
```

---

## Task 12: Email composer (buyer + team)

**Files:**
- Create: `frontend/src/lib/scope-builder/server/email.ts`

- [ ] **Step 1: Write email composer**

```ts
// frontend/src/lib/scope-builder/server/email.ts
import nodemailer from 'nodemailer';
import { fmtRange } from '../format';
import type { CartItem, UniversalComments } from '../cart';
import type { BundleResult } from '../bundle';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'stalwart',
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.SMTP_USER || 'newsletter@underwings.org',
    pass: process.env.SMTP_PASS || '',
  },
});

const WA = '971547078203';
const TEAM = process.env.TEAM_EMAIL || 'itdept1@gcee.ae';
const KRAYIN_BASE = 'https://crm.underwings.org/admin/leads/view';

interface SendInput {
  reference: string;
  token: string;
  cart: CartItem[];
  bundle: BundleResult;
  comments: UniversalComments;
  founding_optin: boolean;
  lead: { name: string; email: string; company: string; phone?: string; whatsapp_ok: boolean; best_time?: string };
  pdfBytes: Buffer;
  krayin_lead_id?: number;
  origin: string;                // e.g. https://underwings.org
}

export async function sendBuyerEmail(d: SendInput): Promise<void> {
  const itemRows = d.cart.map((i) => `<tr><td>${esc(i.summary)}</td><td style="text-align:right">${fmtRange(i.range.low, i.range.high)}</td></tr>`).join('');
  const subject = `Your scope plan: ${d.reference} · ${fmtRange(d.bundle.adjusted.low, d.bundle.adjusted.high)}`;
  const hosted = `${d.origin}/scope/${d.token}`;
  const wa = `https://wa.me/${WA}?text=${encodeURIComponent(`Question about scope ${d.reference}`)}`;
  const html = `<div style="font-family:-apple-system,sans-serif;max-width:640px;margin:0 auto;padding:24px">
    <h2 style="color:#0a3a1f">Hi ${esc(d.lead.name)} — your scope plan is ready</h2>
    <p>Reference: <strong>${esc(d.reference)}</strong></p>
    <table style="width:100%;border-collapse:collapse">${itemRows}</table>
    <p style="font-size:18px;font-weight:700;color:#0a3a1f">Estimated range: ${fmtRange(d.bundle.adjusted.low, d.bundle.adjusted.high)}</p>
    ${d.founding_optin ? `<div style="background:#fff7d6;padding:12px;border-radius:6px;border:1px solid #f0c14b">★ <strong>Founding Client offer noted</strong> — we will lead with this on the scoping call.</div>` : ''}
    <p>The full PDF is attached. You can also <a href="${hosted}">view it online</a> any time.</p>
    <p>
      <a href="${hosted}" style="background:#24d758;color:#0a0a0a;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">View online</a>
      &nbsp;
      <a href="${wa}" style="background:#25d366;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">Ask on WhatsApp</a>
    </p>
    <p style="color:#666;font-size:12px">We will email you within 48 hours with a written fixed-price quote.</p>
  </div>`;
  await transporter.sendMail({
    from: `"Underwings Quotes" <quotes@underwings.org>`,
    to: d.lead.email,
    subject,
    html,
    attachments: [{ filename: `${d.reference}.pdf`, content: d.pdfBytes, contentType: 'application/pdf' }],
  });
}

export async function sendTeamEmail(d: SendInput): Promise<void> {
  const subject = `[NEW SCOPE] ${d.lead.company} — ${fmtRange(d.bundle.adjusted.low, d.bundle.adjusted.high)} · ${d.cart.length} services${d.founding_optin ? ' · ★ FOUNDING CLIENT' : ''}`;
  const itemRows = d.cart.map((i) => `<tr><td>${esc(i.category)}</td><td>${esc(i.summary)}</td><td>${fmtRange(i.range.low, i.range.high)}</td><td>${esc(i.comments || '')}</td></tr>`).join('');
  const universal = [
    d.comments.worry    && `<p><strong>Worry:</strong> ${esc(d.comments.worry)}</p>`,
    d.comments.deadline && `<p><strong>Deadline:</strong> ${esc(d.comments.deadline)}</p>`,
    d.comments.existing && `<p><strong>Existing tools:</strong> ${esc(d.comments.existing)}</p>`,
    d.comments.other    && `<p><strong>Other:</strong> ${esc(d.comments.other)}</p>`,
  ].filter(Boolean).join('');
  const krayin = d.krayin_lead_id ? `${KRAYIN_BASE}/${d.krayin_lead_id}` : null;
  const hosted = `${d.origin}/scope/${d.token}`;
  const html = `<div style="font-family:-apple-system,sans-serif;max-width:780px">
    <h2>New scope: ${esc(d.reference)}</h2>
    ${d.founding_optin ? `<div style="background:#fff7d6;padding:8px 12px;border:1px solid #f0c14b;border-radius:4px;font-weight:700">★ FOUNDING CLIENT OPT-IN — lead with discount on call</div>` : ''}
    <p><strong>${esc(d.lead.name)}</strong> · ${esc(d.lead.company)} · <a href="mailto:${esc(d.lead.email)}">${esc(d.lead.email)}</a>${d.lead.phone ? ' · ' + esc(d.lead.phone) : ''}${d.lead.whatsapp_ok ? ' (WhatsApp OK)' : ''}${d.lead.best_time ? ' · best time: ' + esc(d.lead.best_time) : ''}</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">
      <thead><tr><th>Category</th><th>Summary</th><th>Range</th><th>Note</th></tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    <p style="margin-top:12px"><strong>Bundle:</strong> ${fmtRange(d.bundle.adjusted.low, d.bundle.adjusted.high)} (${d.bundle.signal || 'no bundle savings'})</p>
    ${universal ? `<h3>Universal comments</h3>${universal}` : ''}
    <h3>Links</h3>
    <p>Hosted scope: <a href="${hosted}">${hosted}</a><br>${krayin ? `Krayin lead: <a href="${krayin}">${krayin}</a>` : 'Krayin lead: (creation pending or failed)'}</p>
  </div>`;
  await transporter.sendMail({
    from: `"Underwings Scope" <noreply@underwings.org>`,
    to: TEAM,
    subject,
    html,
    attachments: [{ filename: `${d.reference}.pdf`, content: d.pdfBytes, contentType: 'application/pdf' }],
  });
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/scope-builder/server/email.ts
git commit -m "feat(scope-builder): buyer + team email composer"
```

---

## Task 13: Slack notifier (env-gated)

**Files:**
- Create: `frontend/src/lib/scope-builder/server/slack.ts`

- [ ] **Step 1: Write Slack poster**

```ts
// frontend/src/lib/scope-builder/server/slack.ts
import { fmtRange } from '../format';

export async function notifyNewScope(d: {
  reference: string; range_low: number; range_high: number; n_services: number;
  company: string; founding_optin: boolean;
  krayin_url: string | null; hosted_url: string;
}): Promise<void> {
  const url = process.env.SLACK_SCOPE_WEBHOOK;
  if (!url) return;             // graceful no-op
  const text = `🌟 *New scope* · ${fmtRange(d.range_low, d.range_high)} · ${d.n_services} services\n` +
    `Company: ${d.company}\n` +
    `Founding-Client: ${d.founding_optin ? 'YES ★' : 'no'}\n` +
    (d.krayin_url ? `<${d.krayin_url}|Open in Krayin>` : '') +
    `\n<${d.hosted_url}|Hosted scope>`;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  } catch (e) {
    console.error('Slack notify failed:', e);
  }
}

export async function notifyView(d: {
  reference: string; city?: string; country?: string; view_count: number;
}): Promise<void> {
  const url = process.env.SLACK_SCOPE_WEBHOOK;
  if (!url) return;
  const text = `📊 *Scope viewed* · ${d.reference} · ${d.city || '?'}, ${d.country || '?'} · view #${d.view_count}`;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  } catch (e) {
    console.error('Slack notify failed:', e);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/scope-builder/server/slack.ts
git commit -m "feat(scope-builder): env-gated Slack notifier"
```

---

## Task 14: Krayin webhook poster (Astro side)

**Files:**
- Create: `frontend/src/lib/scope-builder/server/krayin.ts`

- [ ] **Step 1: Write Krayin client**

```ts
// frontend/src/lib/scope-builder/server/krayin.ts
import type { CartItem, UniversalComments } from '../cart';
import { fmtRange } from '../format';

const KRAYIN_BASE = process.env.KRAYIN_URL || 'https://crm.underwings.org';
const TOKEN = process.env.WEBHOOK_TOKEN || '';

export async function createScopeLead(d: {
  reference: string; token: string;
  name: string; email: string; company: string; phone?: string;
  range_low: number; range_high: number;
  founding_optin: boolean;
  cart: CartItem[]; comments: UniversalComments;
  whatsapp_ok: boolean;
}): Promise<{ lead_id: number | null; person_id: number | null; error?: string }> {
  if (!TOKEN) return { lead_id: null, person_id: null, error: 'no token' };
  try {
    const res = await fetch(`${KRAYIN_BASE}/webhook-scope.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Token': TOKEN },
      body: JSON.stringify({
        scope_token: d.token,
        scope_reference: d.reference,
        name: d.name, email: d.email, company: d.company, phone: d.phone || '',
        range_low: d.range_low, range_high: d.range_high,
        founding_optin: d.founding_optin,
        whatsapp_ok: d.whatsapp_ok,
        cart_summary: JSON.stringify(d.cart.map((i) => ({ category: i.category, summary: i.summary, range: i.range, comments: i.comments }))),
        title: `${d.founding_optin ? '[FC] ' : ''}${d.company} — ${d.cart.length} services — ${fmtRange(d.range_low, d.range_high)}`,
        description: d.cart.map((i) => `• ${i.summary} ${fmtRange(i.range.low, i.range.high)}${i.comments ? ' — ' + i.comments : ''}`).join('\n')
          + (d.comments.worry || d.comments.deadline || d.comments.existing || d.comments.other
              ? '\n\nNotes:\n' + [
                  d.comments.worry    && `- Worry: ${d.comments.worry}`,
                  d.comments.deadline && `- Deadline: ${d.comments.deadline}`,
                  d.comments.existing && `- Existing: ${d.comments.existing}`,
                  d.comments.other    && `- Other: ${d.comments.other}`,
                ].filter(Boolean).join('\n')
              : ''),
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { lead_id: null, person_id: null, error: json.error || `HTTP ${res.status}` };
    return { lead_id: json.lead_id ?? null, person_id: json.person_id ?? null };
  } catch (e) {
    return { lead_id: null, person_id: null, error: String(e) };
  }
}

export async function logScopeView(d: {
  scope_token: string; ip?: string; user_agent?: string; city?: string; country?: string; referer?: string;
}): Promise<void> {
  if (!TOKEN) return;
  try {
    await fetch(`${KRAYIN_BASE}/webhook-scope-view.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Token': TOKEN },
      body: JSON.stringify(d),
    });
  } catch (e) {
    console.error('Krayin view ping failed:', e);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/scope-builder/server/krayin.ts
git commit -m "feat(scope-builder): Krayin webhook client"
```

---

## Task 15: Submit endpoint /api/scope-builder-v2

**Files:**
- Create: `frontend/src/pages/api/scope-builder-v2.ts`

- [ ] **Step 1: Write the endpoint**

```ts
// frontend/src/pages/api/scope-builder-v2.ts
import type { APIRoute } from 'astro';
import DOMPurify from 'isomorphic-dompurify';
import { supa, nextReference } from '../../lib/scope-builder/server/supabase';
import { generateToken, expiryDate } from '../../lib/scope-builder/reference';
import { bundle } from '../../lib/scope-builder/bundle';
import { buildScopePdfHtml, renderPdf } from '../../lib/scope-builder/server/pdf';
import { sendBuyerEmail, sendTeamEmail } from '../../lib/scope-builder/server/email';
import { createScopeLead } from '../../lib/scope-builder/server/krayin';
import { notifyNewScope } from '../../lib/scope-builder/server/slack';
import type { CartItem } from '../../lib/scope-builder/cart';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const prerender = false;

export const POST: APIRoute = async ({ request, url }) => {
  let body: any;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid_json' }, 400); }

  // Validate
  const cart = Array.isArray(body.cart) ? body.cart as CartItem[] : null;
  const lead = body.lead;
  if (!cart || cart.length === 0) return json({ error: 'cart_empty' }, 400);
  if (!lead?.name || !lead?.email || !lead?.company) return json({ error: 'lead_required' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(lead.email))) return json({ error: 'email_invalid' }, 400);

  // Sanitize free-text fields
  const cleanCart = cart.map((i) => ({ ...i, comments: i.comments ? sanitize(i.comments) : undefined, summary: sanitize(i.summary) }));
  const comments = {
    worry:    body.comments?.worry    ? sanitize(String(body.comments.worry))    : undefined,
    deadline: body.comments?.deadline ? sanitize(String(body.comments.deadline)) : undefined,
    existing: body.comments?.existing ? sanitize(String(body.comments.existing)) : undefined,
    other:    body.comments?.other    ? sanitize(String(body.comments.other))    : undefined,
  };
  const cleanLead = {
    name:        sanitize(String(lead.name)).slice(0, 200),
    email:       sanitize(String(lead.email)).slice(0, 200).toLowerCase(),
    company:     sanitize(String(lead.company)).slice(0, 200),
    phone:       lead.phone ? sanitize(String(lead.phone)).slice(0, 50) : undefined,
    whatsapp_ok: !!lead.whatsapp_ok,
    best_time:   lead.best_time ? sanitize(String(lead.best_time)).slice(0, 20) : undefined,
  };

  const founding_optin = !!body.founding_optin;
  const b = bundle(cleanCart);
  const token = generateToken();
  const reference = await nextReference();
  const expires = expiryDate(30);
  const origin = url.origin;

  // 1. Insert into Supabase
  const { data: scopeRow, error: dbErr } = await supa.from('scopes').insert({
    token,
    reference,
    cart: cleanCart,
    comments,
    founding_optin,
    range_low: b.adjusted.low,
    range_high: b.adjusted.high,
    bundle_savings: b.signal || null,
    lead_name: cleanLead.name,
    lead_email: cleanLead.email,
    lead_company: cleanLead.company,
    lead_phone: cleanLead.phone || null,
    whatsapp_ok: cleanLead.whatsapp_ok,
    best_time: cleanLead.best_time || null,
    expires_at: expires.toISOString(),
  }).select('id').single();
  if (dbErr || !scopeRow) return json({ error: 'db_failed', detail: dbErr?.message }, 500);

  // 2. Render PDF
  const html = buildScopePdfHtml({
    reference, token, cart: cleanCart, bundle: b, comments, founding_optin,
    lead: cleanLead, expires_at: expires,
  });
  let pdfBytes: Buffer;
  try { pdfBytes = await renderPdf(html); }
  catch (e) { return json({ error: 'pdf_failed', detail: String(e) }, 500); }

  // 3. Save PDF to disk
  const pdfDir = '/data/scopes';
  await mkdir(pdfDir, { recursive: true });
  const pdfPath = join(pdfDir, `${token}.pdf`);
  await writeFile(pdfPath, pdfBytes);
  await supa.from('scopes').update({ pdf_path: pdfPath }).eq('id', scopeRow.id);

  // 4. Krayin lead
  const krayin = await createScopeLead({
    reference, token,
    name: cleanLead.name, email: cleanLead.email, company: cleanLead.company, phone: cleanLead.phone,
    range_low: b.adjusted.low, range_high: b.adjusted.high,
    founding_optin,
    cart: cleanCart, comments,
    whatsapp_ok: cleanLead.whatsapp_ok,
  });
  if (krayin.lead_id) await supa.from('scopes').update({ krayin_lead_id: krayin.lead_id }).eq('id', scopeRow.id);

  // 5. Emails (parallel)
  const sendInput = {
    reference, token, cart: cleanCart, bundle: b, comments, founding_optin,
    lead: { ...cleanLead, whatsapp_ok: cleanLead.whatsapp_ok },
    pdfBytes, krayin_lead_id: krayin.lead_id ?? undefined, origin,
  };
  await Promise.allSettled([
    sendBuyerEmail(sendInput),
    sendTeamEmail(sendInput),
    notifyNewScope({
      reference,
      range_low: b.adjusted.low, range_high: b.adjusted.high,
      n_services: cleanCart.length, company: cleanLead.company,
      founding_optin,
      krayin_url: krayin.lead_id ? `https://crm.underwings.org/admin/leads/view/${krayin.lead_id}` : null,
      hosted_url: `${origin}/scope/${token}`,
    }),
  ]);

  return json({
    success: true,
    reference,
    token,
    range: { low: b.adjusted.low, high: b.adjusted.high },
    redirect: `/scope-builder/thanks/${reference}`,
  });
};

function sanitize(s: string): string { return DOMPurify.sanitize(s, { ALLOWED_TAGS: [] }); }
function json(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 2: Verify env vars** present in `.env`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WEBHOOK_TOKEN`, `PDF_RENDER_URL`, `PDF_RENDER_TOKEN`, `SMTP_USER`, `SMTP_PASS`. Add any missing to `frontend` service env.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/api/scope-builder-v2.ts
git commit -m "feat(scope-builder): submit endpoint with full pipeline"
```

---

## Task 16: View ping endpoint

**Files:**
- Create: `frontend/src/pages/api/scope/view-ping.ts`

- [ ] **Step 1: Write endpoint**

```ts
// frontend/src/pages/api/scope/view-ping.ts
import type { APIRoute } from 'astro';
import { supa } from '../../../lib/scope-builder/server/supabase';
import { logScopeView } from '../../../lib/scope-builder/server/krayin';
import { notifyView } from '../../../lib/scope-builder/server/slack';

export const prerender = false;

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let body: any;
  try { body = await request.json(); } catch { return new Response('bad', { status: 400 }); }
  const token = String(body.token || '');
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return new Response('bad', { status: 400 });

  const { data: scope } = await supa.from('scopes').select('id, reference, expires_at').eq('token', token).maybeSingle();
  if (!scope) return new Response('not found', { status: 404 });
  if (new Date(scope.expires_at) < new Date()) return new Response('expired', { status: 410 });

  const ua = request.headers.get('user-agent') || '';
  const referer = request.headers.get('referer') || '';
  const ip = clientAddress || '';

  await supa.from('scope_views').insert({
    scope_id: scope.id,
    ip: ip || null,
    user_agent: ua || null,
    referer: referer || null,
  });

  // Count views for Slack message
  const { count } = await supa.from('scope_views').select('*', { count: 'exact', head: true }).eq('scope_id', scope.id);

  await Promise.allSettled([
    logScopeView({ scope_token: token, ip, user_agent: ua, referer }),
    notifyView({ reference: scope.reference, view_count: count ?? 0 }),
  ]);

  return new Response('ok', { status: 200 });
};
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/api/scope/view-ping.ts
git commit -m "feat(scope-builder): view-ping endpoint"
```

---

## Task 17: Reverse Krayin webhook /api/krayin/lead-status

**Files:**
- Create: `frontend/src/pages/api/krayin/lead-status.ts`

- [ ] **Step 1: Write endpoint**

```ts
// frontend/src/pages/api/krayin/lead-status.ts
import type { APIRoute } from 'astro';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { supa } from '../../../lib/scope-builder/server/supabase';

export const prerender = false;

const SECRET = process.env.KRAYIN_REVERSE_SECRET || '';

export const POST: APIRoute = async ({ request }) => {
  if (!SECRET) return new Response('disabled', { status: 503 });
  const raw = await request.text();
  const sig = request.headers.get('x-krayin-signature') || '';
  const expected = createHmac('sha256', SECRET).update(raw).digest('hex');
  let valid = false;
  try { valid = sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch {}
  if (!valid) return new Response('forbidden', { status: 403 });

  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response('bad', { status: 400 }); }
  const token = String(body.scope_token || '');
  const status = String(body.status || '');
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return new Response('bad', { status: 400 });
  if (!['won', 'lost', 'quoted', 'negotiating'].includes(status)) return new Response('bad', { status: 400 });

  const { error } = await supa.from('scopes').update({ status, updated_at: new Date().toISOString() }).eq('token', token);
  if (error) return new Response('db', { status: 500 });

  return new Response('ok', { status: 200 });
};
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/api/krayin/lead-status.ts
git commit -m "feat(scope-builder): reverse Krayin webhook for lead status"
```

---

## Task 18: Krayin migrations — pipeline + custom attributes

**Files:**
- Create: `krayin/migrations/2026_04_27_000001_create_scope_pipeline.php`
- Create: `krayin/migrations/2026_04_27_000002_create_scope_attributes.php`

> The Krayin container runs Laravel. These migrations are mounted into `/var/www/laravel-crm/database/migrations/` and run via `php artisan migrate`. Webkul packages register their own attribute migrations through Eloquent observers. We use raw seeds for the pipeline and Webkul's `Attribute` model for the custom attributes.

- [ ] **Step 1: Write pipeline migration**

```php
<?php
// krayin/migrations/2026_04_27_000001_create_scope_pipeline.php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration {
  public function up(): void {
    if (DB::table('lead_pipelines')->where('name', 'Scope Builder')->exists()) return;

    $pipelineId = DB::table('lead_pipelines')->insertGetId([
      'name'        => 'Scope Builder',
      'description' => 'Inbound leads from /scope-builder',
      'is_default'  => 0,
      'created_at'  => now(),
      'updated_at'  => now(),
    ]);

    $stages = [
      ['name' => 'Submitted',    'sort_order' => 1, 'probability' => 10],
      ['name' => 'Reviewed',     'sort_order' => 2, 'probability' => 20],
      ['name' => 'Quoted',       'sort_order' => 3, 'probability' => 40],
      ['name' => 'Negotiating',  'sort_order' => 4, 'probability' => 60],
      ['name' => 'Won',          'sort_order' => 5, 'probability' => 100],
      ['name' => 'Lost',         'sort_order' => 6, 'probability' => 0],
    ];
    foreach ($stages as $s) {
      DB::table('lead_pipeline_stages')->insert(array_merge($s, [
        'lead_pipeline_id' => $pipelineId,
        'created_at' => now(),
        'updated_at' => now(),
      ]));
    }
  }
  public function down(): void {
    $id = DB::table('lead_pipelines')->where('name', 'Scope Builder')->value('id');
    if ($id) {
      DB::table('lead_pipeline_stages')->where('lead_pipeline_id', $id)->delete();
      DB::table('lead_pipelines')->where('id', $id)->delete();
    }
  }
};
```

- [ ] **Step 2: Write attributes migration**

```php
<?php
// krayin/migrations/2026_04_27_000002_create_scope_attributes.php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration {
  public function up(): void {
    $entityType = 'leads';
    $attributes = [
      ['code' => 'scope_token',           'name' => 'Scope Token',     'type' => 'text'],
      ['code' => 'scope_reference',       'name' => 'Scope Reference', 'type' => 'text'],
      ['code' => 'scope_range_low',       'name' => 'Range Low (AED)', 'type' => 'integer'],
      ['code' => 'scope_range_high',      'name' => 'Range High (AED)','type' => 'integer'],
      ['code' => 'founding_optin',        'name' => 'Founding Client', 'type' => 'boolean'],
      ['code' => 'scope_view_count',      'name' => 'View Count',      'type' => 'integer'],
      ['code' => 'scope_last_viewed_at',  'name' => 'Last Viewed At',  'type' => 'datetime'],
      ['code' => 'cart_summary',          'name' => 'Cart Summary',    'type' => 'textarea'],
    ];
    foreach ($attributes as $a) {
      if (DB::table('attributes')->where('code', $a['code'])->where('entity_type', $entityType)->exists()) continue;
      DB::table('attributes')->insert([
        'code'         => $a['code'],
        'admin_name'   => $a['name'],
        'type'         => $a['type'],
        'entity_type'  => $entityType,
        'is_required'  => 0,
        'is_unique'    => $a['code'] === 'scope_token' ? 1 : 0,
        'value_per_locale'  => 0,
        'value_per_channel' => 0,
        'is_user_defined'   => 1,
        'sort_order'   => 100,
        'created_at'   => now(),
        'updated_at'   => now(),
      ]);
    }
  }
  public function down(): void {
    DB::table('attributes')->where('entity_type', 'leads')->whereIn('code', [
      'scope_token','scope_reference','scope_range_low','scope_range_high',
      'founding_optin','scope_view_count','scope_last_viewed_at','cart_summary',
    ])->delete();
  }
};
```

- [ ] **Step 3: Mount migrations into Krayin in docker-compose.yml**

Add to the `krayin` service `volumes:` (alongside the existing webhook mount):
```yaml
      - ./krayin/migrations:/var/www/laravel-crm/database/migrations/scope:ro
```

- [ ] **Step 4: Apply migrations**

Krayin auto-runs migrations on container start. After mounting, restart Krayin and check:

```bash
docker compose restart krayin && sleep 6
docker compose exec krayin php artisan migrate --path=database/migrations/scope
```

Expected output: 2 migrations ran successfully (or "Nothing to migrate" if rerun).

- [ ] **Step 5: Verify in Krayin UI**

Visit `https://crm.underwings.org/admin/leads/pipelines` — confirm "Scope Builder" pipeline with 6 stages appears.

Visit `https://crm.underwings.org/admin/configuration/attributes` — confirm 8 new attributes are listed under entity type `leads`.

- [ ] **Step 6: Commit**

```bash
git add krayin/migrations/ docker-compose.yml
git commit -m "feat(scope-builder): Krayin pipeline + custom attributes migrations"
```

---

## Task 19: Krayin webhook PHP — webhook-scope.php

**Files:**
- Create: `krayin/webhook-scope.php`

- [ ] **Step 1: Write the webhook**

```php
<?php
// krayin/webhook-scope.php
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  http_response_code(405); die(json_encode(['error' => 'method']));
}
$envFile = __DIR__ . '/../.env';
$token = '';
foreach (file($envFile) as $line) {
  if (str_starts_with(trim($line), 'WEBHOOK_TOKEN=')) {
    $token = trim(substr(trim($line), 14));
    break;
  }
}
if (!$token || ($_SERVER['HTTP_X_WEBHOOK_TOKEN'] ?? '') !== $token) {
  http_response_code(401); die(json_encode(['error' => 'unauthorized']));
}
$in = json_decode(file_get_contents('php://input'), true);
foreach (['scope_token','scope_reference','name','email','company','range_low','range_high'] as $k) {
  if (empty($in[$k]) && $in[$k] !== 0) { http_response_code(400); die(json_encode(['error' => "missing $k"])); }
}

require __DIR__ . '/../vendor/autoload.php';
$app = require __DIR__ . '/../bootstrap/app.php';
$app->make(\Illuminate\Contracts\Console\Kernel::class)->bootstrap();

try {
  // Person
  $person = \Webkul\Contact\Models\Person::create([
    'name'            => $in['name'],
    'emails'          => [['value' => strtolower(trim($in['email'])), 'label' => 'work']],
    'contact_numbers' => !empty($in['phone']) ? [['value' => $in['phone'], 'label' => 'work']] : [],
  ]);
  $org = \Webkul\Contact\Models\Organization::firstOrCreate(['name' => $in['company']]);
  $person->organization_id = $org->id; $person->save();

  // Scope Builder pipeline
  $pipeline = \Webkul\Lead\Models\Pipeline::where('name','Scope Builder')->first()
            ?? \Webkul\Lead\Models\Pipeline::orderBy('id')->first();
  $stage = \Webkul\Lead\Models\Stage::where('lead_pipeline_id', $pipeline->id)->orderBy('sort_order')->first();

  $title = $in['title'] ?? (($in['founding_optin'] ? '[FC] ' : '') . $in['company'] . ' — scope ' . $in['scope_reference']);
  $lead = \Webkul\Lead\Models\Lead::create([
    'title'                   => $title,
    'description'             => $in['description'] ?? '',
    'lead_source_id'          => \Webkul\Lead\Models\Source::firstOrCreate(['name' => 'Scope Builder'])->id,
    'lead_type_id'            => \Webkul\Lead\Models\Type::first()?->id,
    'person_id'               => $person->id,
    'user_id'                 => 1,
    'lead_pipeline_id'        => $pipeline->id,
    'lead_pipeline_stage_id'  => $stage->id,
    'status'                  => 1,
    // custom attributes (Webkul stores these as Eloquent JSON column)
    'scope_token'             => $in['scope_token'],
    'scope_reference'         => $in['scope_reference'],
    'scope_range_low'         => (int) $in['range_low'],
    'scope_range_high'        => (int) $in['range_high'],
    'founding_optin'          => !empty($in['founding_optin']),
    'scope_view_count'        => 0,
    'cart_summary'            => $in['cart_summary'] ?? '',
  ]);

  // Activity
  \Webkul\Activity\Models\Activity::create([
    'title'        => 'Scope Submitted',
    'comment'      => 'Submitted via /scope-builder · ' . $title,
    'type'         => 'note',
    'is_done'      => 1,
    'schedule_from'=> now(),
    'schedule_to'  => now(),
    'user_id'      => 1,
  ])->leads()->attach($lead->id);

  echo json_encode(['success' => true, 'lead_id' => $lead->id, 'person_id' => $person->id]);
} catch (\Throwable $e) {
  http_response_code(500);
  echo json_encode(['error' => $e->getMessage()]);
}
```

- [ ] **Step 2: Mount and reload Krayin**

In `docker-compose.yml`, the krayin volumes already mount existing webhook PHP files. Add:
```yaml
      - ./krayin/webhook-scope.php:/var/www/laravel-crm/public/webhook-scope.php:ro
```

```bash
docker compose up -d krayin && sleep 4
docker compose exec krayin ls -l /var/www/laravel-crm/public/webhook-scope.php
```

- [ ] **Step 3: Smoke test**

```bash
TOKEN=$(grep -E "^WEBHOOK_TOKEN=" /home/deployer/underwings/.env | cut -d= -f2)
curl -sS -X POST "https://crm.underwings.org/webhook-scope.php" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: $TOKEN" \
  -d '{
    "scope_token":"abcdef0123456789abcdef0123456789",
    "scope_reference":"SCB-TEST-0001",
    "name":"Test User","email":"test@example.com","company":"Test Co",
    "range_low":12000,"range_high":24000,"founding_optin":true,
    "cart_summary":"[]","title":"[FC] Test Co — test","description":"smoke test"
  }'
```

Expected: `{"success":true,"lead_id":N,"person_id":N}`. Verify in Krayin UI that lead appears under Scope Builder pipeline.

- [ ] **Step 4: Commit**

```bash
git add krayin/webhook-scope.php docker-compose.yml
git commit -m "feat(scope-builder): Krayin webhook-scope.php"
```

---

## Task 20: Krayin webhook PHP — webhook-scope-view.php

**Files:**
- Create: `krayin/webhook-scope-view.php`

- [ ] **Step 1: Write the webhook**

```php
<?php
// krayin/webhook-scope-view.php
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); die(json_encode(['error'=>'method'])); }
$envFile = __DIR__ . '/../.env';
$token = '';
foreach (file($envFile) as $line) {
  if (str_starts_with(trim($line), 'WEBHOOK_TOKEN=')) { $token = trim(substr(trim($line), 14)); break; }
}
if (!$token || ($_SERVER['HTTP_X_WEBHOOK_TOKEN'] ?? '') !== $token) { http_response_code(401); die(json_encode(['error'=>'unauthorized'])); }
$in = json_decode(file_get_contents('php://input'), true);
$scopeToken = $in['scope_token'] ?? '';
if (!$scopeToken) { http_response_code(400); die(json_encode(['error'=>'scope_token required'])); }

require __DIR__ . '/../vendor/autoload.php';
$app = require __DIR__ . '/../bootstrap/app.php';
$app->make(\Illuminate\Contracts\Console\Kernel::class)->bootstrap();

try {
  $lead = \Webkul\Lead\Models\Lead::where('scope_token', $scopeToken)->first();
  if (!$lead) { http_response_code(404); die(json_encode(['error'=>'not found'])); }

  $count = (int) ($lead->scope_view_count ?? 0) + 1;
  $lead->scope_view_count = $count;
  $lead->scope_last_viewed_at = now();
  $lead->save();

  $where = trim(($in['city'] ?? '') . ', ' . ($in['country'] ?? ''), ', ');
  $ua = substr($in['user_agent'] ?? '', 0, 200);
  \Webkul\Activity\Models\Activity::create([
    'title'        => 'Scope viewed (#' . $count . ')',
    'comment'      => 'IP ' . ($in['ip'] ?? '?') . ($where ? ' · ' . $where : '') . ' · UA: ' . $ua,
    'type'         => 'note',
    'is_done'      => 1,
    'schedule_from'=> now(),
    'schedule_to'  => now(),
    'user_id'      => 1,
  ])->leads()->attach($lead->id);

  echo json_encode(['success'=>true, 'view_count'=>$count]);
} catch (\Throwable $e) {
  http_response_code(500);
  echo json_encode(['error'=>$e->getMessage()]);
}
```

- [ ] **Step 2: Mount in docker-compose.yml**

Add to krayin volumes:
```yaml
      - ./krayin/webhook-scope-view.php:/var/www/laravel-crm/public/webhook-scope-view.php:ro
```

```bash
docker compose up -d krayin
```

- [ ] **Step 3: Commit**

```bash
git add krayin/webhook-scope-view.php docker-compose.yml
git commit -m "feat(scope-builder): Krayin webhook-scope-view.php for view tracking"
```

---

## Task 21: ServiceCard component

**Files:**
- Create: `frontend/src/components/scope-builder/ServiceCard.astro`

- [ ] **Step 1: Write component**

```astro
---
// frontend/src/components/scope-builder/ServiceCard.astro
export interface Props {
  category: 'offensive' | 'grc' | 'cloud';
  title: string;
  tagline: string;
  range: string;
  comingSoon?: boolean;
}
const { category, title, tagline, range, comingSoon = false } = Astro.props;
---
<div class={`sb-card${comingSoon ? ' is-coming' : ''}`} data-category={category}>
  <div class="sb-card-head">
    <h3 class="sb-card-title">{title}</h3>
    {comingSoon && <span class="sb-card-soon">Coming soon</span>}
  </div>
  <p class="sb-card-tag">{tagline}</p>
  <div class="sb-card-range">{range}</div>
  <div class="sb-card-actions">
    <button type="button" class="sb-btn sb-btn-ghost" data-learn={category} disabled={comingSoon}>ⓘ Learn more</button>
    <button type="button" class="sb-btn sb-btn-primary" data-add={category} disabled={comingSoon}>+ Add to cart</button>
  </div>
</div>

<style>
  .sb-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.10); border-radius: 12px; padding: 1.25rem; display: flex; flex-direction: column; gap: 0.75rem; transition: border-color .18s, transform .12s; }
  .sb-card:hover { border-color: rgba(36,215,88,0.35); transform: translateY(-2px); }
  .sb-card.is-coming { opacity: 0.55; }
  .sb-card-head { display: flex; align-items: center; justify-content: space-between; }
  .sb-card-title { font-size: 1.05rem; margin: 0; color: #fff; }
  .sb-card-soon { font-size: 0.65rem; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.7); }
  .sb-card-tag { font-size: 0.85rem; color: rgba(255,255,255,0.7); margin: 0; line-height: 1.45; }
  .sb-card-range { font-family: ui-monospace, monospace; font-size: 0.85rem; color: #24d758; }
  .sb-card-actions { display: flex; gap: 0.5rem; margin-top: auto; }
  .sb-btn { flex: 1; padding: 0.55rem 0.85rem; border-radius: 7px; font-size: 0.82rem; cursor: pointer; border: 1px solid transparent; }
  .sb-btn:disabled { cursor: not-allowed; opacity: 0.4; }
  .sb-btn-ghost { background: transparent; color: #d1d5db; border-color: rgba(255,255,255,0.18); }
  .sb-btn-ghost:hover { background: rgba(255,255,255,0.06); }
  .sb-btn-primary { background: linear-gradient(135deg, #24d758, #27dab4); color: #0a0a0a; font-weight: 600; }
  .sb-btn-primary:hover { box-shadow: 0 4px 14px rgba(36,215,88,0.35); }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/scope-builder/ServiceCard.astro
git commit -m "feat(scope-builder): ServiceCard component"
```

---

## Task 22: LearnMoreDrawer component

**Files:**
- Create: `frontend/src/components/scope-builder/LearnMoreDrawer.astro`

- [ ] **Step 1: Write component**

```astro
---
// frontend/src/components/scope-builder/LearnMoreDrawer.astro
import type { LearnMoreContent } from '../../lib/scope-builder/copy/offensive';
export interface Props { content: LearnMoreContent; category: string }
const { content, category } = Astro.props;
---
<aside class="sb-drawer" id={`sb-drawer-${category}`} aria-hidden="true" role="dialog" aria-labelledby={`sb-drawer-title-${category}`}>
  <div class="sb-drawer-bg" data-close></div>
  <div class="sb-drawer-panel">
    <header class="sb-drawer-head">
      <h2 id={`sb-drawer-title-${category}`}>{content.title}</h2>
      <button type="button" class="sb-drawer-close" data-close aria-label="Close">×</button>
    </header>
    <div class="sb-drawer-body">
      <h3>In plain English</h3><p>{content.plain_english}</p>
      <h3>You probably need this if…</h3><ul>{content.need_this_if.map((b) => <li>{b}</li>)}</ul>
      <h3>What you'll get</h3><ul>{content.what_you_get.map((b) => <li>{b}</li>)}</ul>
      <h3>Skip this if…</h3><ul>{content.skip_this_if.map((b) => <li>{b}</li>)}</ul>
      <h3>Common mistakes we see</h3><ul>{content.common_mistakes.map((b) => <li>{b}</li>)}</ul>
      <h3>How long it takes</h3><p>{content.how_long}</p>
      <h3>Pairs well with</h3><ul>{content.pairs_with.map((p) => <li><strong>{p.category}</strong> — {p.reason}</li>)}</ul>
      <div class="sb-drawer-meta"><span>Range: <strong>{content.range}</strong></span><span>Lead time: {content.leadTime}</span></div>
    </div>
    <footer class="sb-drawer-foot">
      <button type="button" class="sb-btn sb-btn-ghost" data-close>Close</button>
      <button type="button" class="sb-btn sb-btn-primary" data-add={category}>Add this to my cart</button>
    </footer>
  </div>
</aside>
<style>
  .sb-drawer { position: fixed; inset: 0; z-index: 9990; display: none; }
  .sb-drawer.is-open { display: block; }
  .sb-drawer-bg { position: absolute; inset: 0; background: rgba(0,0,0,0.55); }
  .sb-drawer-panel { position: absolute; top: 0; right: 0; height: 100vh; width: min(560px, 100%); background: #11161e; color: #e5e7eb; display: flex; flex-direction: column; transform: translateX(100%); transition: transform .26s ease-out; box-shadow: -8px 0 32px rgba(0,0,0,0.4); }
  .sb-drawer.is-open .sb-drawer-panel { transform: translateX(0); }
  .sb-drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.25rem; border-bottom: 1px solid rgba(255,255,255,0.08); }
  .sb-drawer-head h2 { margin: 0; font-size: 1rem; }
  .sb-drawer-close { background: transparent; border: 0; color: rgba(255,255,255,0.7); font-size: 1.6rem; cursor: pointer; padding: 0 .4rem; }
  .sb-drawer-body { padding: 1rem 1.25rem; overflow-y: auto; flex: 1; }
  .sb-drawer-body h3 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; margin: 1.1rem 0 .35rem; }
  .sb-drawer-body p, .sb-drawer-body li { font-size: 0.9rem; line-height: 1.55; }
  .sb-drawer-meta { display: flex; gap: 1rem; margin-top: 1rem; padding: .75rem; background: rgba(36,215,88,0.06); border-radius: 6px; font-size: 0.85rem; }
  .sb-drawer-foot { padding: 0.85rem 1.25rem; border-top: 1px solid rgba(255,255,255,0.08); display: flex; gap: .5rem; }
  .sb-btn { flex: 1; padding: 0.6rem 1rem; border-radius: 7px; font-size: 0.85rem; cursor: pointer; border: 1px solid transparent; }
  .sb-btn-ghost { background: transparent; color: #d1d5db; border-color: rgba(255,255,255,0.18); }
  .sb-btn-primary { background: linear-gradient(135deg, #24d758, #27dab4); color: #0a0a0a; font-weight: 600; }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/scope-builder/LearnMoreDrawer.astro
git commit -m "feat(scope-builder): LearnMoreDrawer component"
```

---

## Task 23: ConfigDrawer component (per-category forms)

**Files:**
- Create: `frontend/src/components/scope-builder/ConfigDrawer.astro`

> The drawer hosts three different forms (offensive, grc, cloud) toggled by the `data-category` attribute. Pricing engines run client-side too — import the same modules from `lib/scope-builder/pricing/`.

- [ ] **Step 1: Write component (markup + behaviour)**

```astro
---
// frontend/src/components/scope-builder/ConfigDrawer.astro
---
<aside class="sb-cfg" id="sb-cfg-drawer" aria-hidden="true" role="dialog">
  <div class="sb-cfg-bg" data-close></div>
  <div class="sb-cfg-panel">
    <header class="sb-cfg-head">
      <h2 id="sb-cfg-title">Configure service</h2>
      <button type="button" class="sb-cfg-close" data-close aria-label="Close">×</button>
    </header>
    <form id="sb-cfg-form" class="sb-cfg-body">

      <!-- Offensive form -->
      <fieldset data-cat="offensive" hidden>
        <label class="lbl">What needs testing?</label>
        <div class="chk-grid">
          <label><input type="checkbox" name="services" value="network_ext"> External network</label>
          <label><input type="checkbox" name="services" value="network_int"> Internal network</label>
          <label><input type="checkbox" name="services" value="web"> Web app</label>
          <label><input type="checkbox" name="services" value="mobile_one"> Mobile (1 platform)</label>
          <label><input type="checkbox" name="services" value="mobile_both"> Mobile (iOS + Android)</label>
          <label><input type="checkbox" name="services" value="api"> API</label>
          <label><input type="checkbox" name="services" value="cloud"> Cloud</label>
          <label><input type="checkbox" name="services" value="phishing"> Phishing simulation</label>
          <label><input type="checkbox" name="services" value="va_only"> VA only</label>
        </div>
        <label class="lbl">Engagement size</label>
        <select name="size" required><option value="xs">XS — single asset</option><option value="s" selected>S — small env</option><option value="m">M — mid env</option><option value="l">L — large env</option></select>
        <label><input type="checkbox" name="authenticated"> Authenticated test required</label>
        <label><input type="checkbox" name="retest"> Retest after fixes required</label>
        <label class="lbl">Driver</label>
        <select name="driver"><option value="audit">Audit / regulator</option><option value="board">Board ask</option><option value="breach">Breach response</option><option value="exploring">Exploring</option></select>
      </fieldset>

      <!-- GRC form -->
      <fieldset data-cat="grc" hidden>
        <label class="lbl">Frameworks</label>
        <div class="chk-grid">
          <label><input type="checkbox" name="frameworks" value="iso27001"> ISO 27001</label>
          <label><input type="checkbox" name="frameworks" value="nesa"> NESA / UAE IA V2</label>
          <label><input type="checkbox" name="frameworks" value="pdpl"> UAE PDPL</label>
          <label><input type="checkbox" name="frameworks" value="adhics"> ADHICS</label>
          <label><input type="checkbox" name="frameworks" value="dubai_isr"> Dubai ISR v2</label>
          <label><input type="checkbox" name="frameworks" value="pci"> PCI DSS v4</label>
          <label><input type="checkbox" name="frameworks" value="risk_register"> Risk Register only</label>
        </div>
        <label class="lbl">Engagement type for each (gap or implementation)</label>
        <select name="engagement_default"><option value="gap">Gap assessment</option><option value="implementation">Full implementation</option></select>
        <label class="lbl">Headcount</label>
        <select name="size"><option value="xs">&lt; 30</option><option value="s">30–100</option><option value="m" selected>100–500</option><option value="l">500+</option></select>
        <label class="lbl">Sector</label>
        <select name="sector"><option value="banking">Banking / financial</option><option value="healthcare">Healthcare</option><option value="government">Government / semi-govt</option><option value="sme">SME</option><option value="it">IT / SaaS</option><option value="retail">Retail</option><option value="other" selected>Other</option></select>
        <label class="lbl">Timeline</label>
        <select name="timeline"><option value="hard_deadline">Hard audit deadline</option><option value="six_months">Within 6 months</option><option value="twelve_months" selected>12 months</option><option value="roadmap">Roadmap only</option></select>
      </fieldset>

      <!-- Cloud form -->
      <fieldset data-cat="cloud" hidden>
        <label class="lbl">Scope</label>
        <div class="chk-grid">
          <label><input type="checkbox" name="scope" value="azure"> Azure tenant</label>
          <label><input type="checkbox" name="scope" value="m365"> Microsoft 365</label>
          <label><input type="checkbox" name="scope" value="entra"> Entra ID / Conditional Access</label>
        </div>
        <label class="lbl">Azure subscriptions</label>
        <select name="azure_subs"><option value="1" selected>1</option><option value="2">2–5</option><option value="3">6+</option></select>
        <label class="lbl">M365 user count</label>
        <select name="m365_users"><option value="xs">&lt; 50</option><option value="s" selected>50–150</option><option value="m">150–500</option><option value="l">500+</option></select>
        <label class="lbl">Conditional Access in place?</label>
        <select name="conditional_access"><option value="yes">Yes</option><option value="partial" selected>Partial</option><option value="no">No</option></select>
        <label class="lbl">MFA enforced?</label>
        <select name="mfa"><option value="yes" selected>Yes</option><option value="partial">Partial</option><option value="no">No</option></select>
        <label class="lbl">Defender licensed?</label>
        <select name="defender"><option value="yes">Yes</option><option value="no">No</option><option value="unsure" selected>Unsure</option></select>
        <label class="lbl">Driver</label>
        <select name="driver"><option value="cis">CIS Benchmark alignment</option><option value="iso17">ISO 27017 mapping</option><option value="audit">Internal audit</option><option value="insurance">Insurance</option><option value="cleanup" selected>Cleanup</option></select>
      </fieldset>

      <label class="lbl">Anything specific to flag for this service?</label>
      <textarea name="comments" rows="3" placeholder="e.g. our API uses NextAuth, please test that flow"></textarea>

      <div class="sb-cfg-live"><span>Estimated range</span><strong id="sb-cfg-range">—</strong></div>
    </form>
    <footer class="sb-cfg-foot">
      <button type="button" class="sb-btn sb-btn-ghost" data-close>Cancel</button>
      <button type="button" class="sb-btn sb-btn-primary" id="sb-cfg-save">Save to cart</button>
    </footer>
  </div>
</aside>

<style>
  .sb-cfg { position: fixed; inset: 0; z-index: 9991; display: none; }
  .sb-cfg.is-open { display: block; }
  .sb-cfg-bg { position: absolute; inset: 0; background: rgba(0,0,0,0.55); }
  .sb-cfg-panel { position: absolute; top: 0; right: 0; height: 100vh; width: min(540px, 100%); background: #11161e; color: #e5e7eb; display: flex; flex-direction: column; transform: translateX(100%); transition: transform .26s; }
  .sb-cfg.is-open .sb-cfg-panel { transform: translateX(0); }
  .sb-cfg-head { padding: 1rem 1.25rem; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; justify-content: space-between; align-items: center; }
  .sb-cfg-head h2 { margin: 0; font-size: 1rem; }
  .sb-cfg-close { background: transparent; border: 0; color: rgba(255,255,255,0.7); font-size: 1.6rem; cursor: pointer; }
  .sb-cfg-body { padding: 1rem 1.25rem; overflow-y: auto; flex: 1; }
  .sb-cfg-body fieldset { border: 0; padding: 0; margin: 0 0 1rem; }
  .sb-cfg-body .lbl { display: block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; margin: .9rem 0 .25rem; }
  .sb-cfg-body select, .sb-cfg-body textarea, .sb-cfg-body input[type=number] { width: 100%; padding: .55rem .7rem; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; color: #e5e7eb; font-size: 0.88rem; }
  .sb-cfg-body label { display: block; font-size: 0.85rem; line-height: 1.6; }
  .chk-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem 1rem; margin: 0.4rem 0 0.8rem; }
  .sb-cfg-live { margin-top: 1rem; padding: .75rem; background: rgba(36,215,88,0.08); border-radius: 6px; display: flex; justify-content: space-between; align-items: center; font-size: 0.9rem; }
  .sb-cfg-live strong { font-family: ui-monospace, monospace; color: #24d758; }
  .sb-cfg-foot { padding: 0.85rem 1.25rem; border-top: 1px solid rgba(255,255,255,0.08); display: flex; gap: .5rem; }
  .sb-btn { flex: 1; padding: 0.6rem 1rem; border-radius: 7px; font-size: 0.85rem; cursor: pointer; border: 1px solid transparent; }
  .sb-btn-ghost { background: transparent; color: #d1d5db; border-color: rgba(255,255,255,0.18); }
  .sb-btn-primary { background: linear-gradient(135deg, #24d758, #27dab4); color: #0a0a0a; font-weight: 600; }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/scope-builder/ConfigDrawer.astro
git commit -m "feat(scope-builder): ConfigDrawer with per-category forms"
```

---

## Task 24: CartSidebar + FoundingBanner + CrossSellPrompt components

**Files:**
- Create: `frontend/src/components/scope-builder/CartSidebar.astro`
- Create: `frontend/src/components/scope-builder/FoundingBanner.astro`
- Create: `frontend/src/components/scope-builder/CrossSellPrompt.astro`

- [ ] **Step 1: Write FoundingBanner**

```astro
---
// frontend/src/components/scope-builder/FoundingBanner.astro
---
<div class="sb-fc">
  <span class="sb-fc-dot"></span>
  <div>
    <strong>★ Founding Client offer</strong>
    <span>10–30% off for the first 10 clients who agree to a published case study. Opt in on the enquiry page.</span>
  </div>
</div>
<style>
  .sb-fc { display: flex; gap: .65rem; align-items: flex-start; padding: .7rem 1rem; background: linear-gradient(135deg, rgba(255,200,80,0.10), rgba(255,170,50,0.05)); border: 1px solid rgba(255,200,80,0.35); border-radius: 8px; color: #ffd97a; font-size: 0.78rem; line-height: 1.45; }
  .sb-fc strong { display: block; color: #ffe6a5; }
  .sb-fc-dot { width: 8px; height: 8px; border-radius: 50%; background: #ffd166; box-shadow: 0 0 8px rgba(255,209,102,0.6); margin-top: 0.4rem; flex-shrink: 0; animation: fcPulse 1.8s infinite; }
  @keyframes fcPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }
</style>
```

- [ ] **Step 2: Write CrossSellPrompt**

```astro
---
// frontend/src/components/scope-builder/CrossSellPrompt.astro
---
<div class="sb-xs" id="sb-crosssell" hidden>
  <span class="sb-xs-icon">💡</span>
  <span class="sb-xs-msg" id="sb-xs-msg"></span>
  <button type="button" class="sb-btn sb-btn-primary" id="sb-xs-yes">Yes, add</button>
  <button type="button" class="sb-btn sb-btn-ghost" id="sb-xs-no">Skip</button>
</div>
<style>
  .sb-xs { display: flex; gap: .5rem; align-items: center; padding: .65rem .85rem; background: rgba(36,215,88,0.06); border: 1px solid rgba(36,215,88,0.25); border-radius: 8px; font-size: 0.85rem; flex-wrap: wrap; }
  .sb-xs-msg { flex: 1; min-width: 200px; color: #e5e7eb; }
  .sb-btn { padding: .35rem .8rem; border-radius: 6px; font-size: 0.8rem; cursor: pointer; border: 1px solid transparent; }
  .sb-btn-ghost { background: transparent; color: #d1d5db; border-color: rgba(255,255,255,0.18); }
  .sb-btn-primary { background: linear-gradient(135deg, #24d758, #27dab4); color: #0a0a0a; font-weight: 600; }
</style>
```

- [ ] **Step 3: Write CartSidebar**

```astro
---
// frontend/src/components/scope-builder/CartSidebar.astro
---
<aside class="sb-cart" id="sb-cart">
  <header class="sb-cart-head">
    <h2>Your Cart</h2>
    <span class="sb-cart-count" id="sb-cart-count">0 items</span>
  </header>
  <ul class="sb-cart-list" id="sb-cart-list">
    <li class="sb-cart-empty" id="sb-cart-empty">Pick a service to start.<br>Your cart will save for 7 days.</li>
  </ul>
  <div class="sb-cart-totals" id="sb-cart-totals" hidden>
    <div class="row"><span>Subtotal range</span><strong id="sb-cart-sub">—</strong></div>
    <div class="row sb-cart-savings" id="sb-cart-savings" hidden><span id="sb-cart-savings-label"></span><strong id="sb-cart-savings-pct">—</strong></div>
    <div class="row total"><span>Adjusted range</span><strong id="sb-cart-adj">—</strong></div>
  </div>
  <button type="button" class="sb-btn sb-btn-primary" id="sb-cart-continue" disabled>Continue to enquiry →</button>
</aside>
<style>
  .sb-cart { background: #0e1218; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: 0.85rem; position: sticky; top: 100px; }
  .sb-cart-head { display: flex; justify-content: space-between; align-items: center; }
  .sb-cart-head h2 { margin: 0; font-size: 0.95rem; color: #fff; }
  .sb-cart-count { font-size: 0.72rem; color: rgba(255,255,255,0.55); }
  .sb-cart-list { list-style: none; margin: 0; padding: 0; max-height: 360px; overflow-y: auto; display: flex; flex-direction: column; gap: 0.5rem; }
  .sb-cart-empty { color: rgba(255,255,255,0.5); font-size: 0.85rem; padding: 1.5rem 0; text-align: center; }
  .sb-cart-list li:not(.sb-cart-empty) { padding: 0.55rem 0.7rem; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; font-size: 0.78rem; }
  .sb-cart-list li .sb-cart-line-summary { display: block; color: #e5e7eb; }
  .sb-cart-list li .sb-cart-line-range { display: block; font-family: ui-monospace, monospace; color: #24d758; margin-top: 2px; }
  .sb-cart-list li .sb-cart-line-actions { display: flex; gap: 0.5rem; margin-top: 4px; }
  .sb-cart-list li button { background: transparent; border: 0; color: rgba(255,255,255,0.55); font-size: 0.72rem; cursor: pointer; padding: 0; }
  .sb-cart-list li button:hover { color: #fff; }
  .sb-cart-totals .row { display: flex; justify-content: space-between; font-size: 0.82rem; padding: 0.25rem 0; }
  .sb-cart-totals .row.total { border-top: 1px solid rgba(255,255,255,0.08); padding-top: 0.55rem; margin-top: 0.25rem; font-weight: 600; color: #fff; }
  .sb-cart-totals strong { font-family: ui-monospace, monospace; color: #24d758; }
  .sb-btn { padding: 0.65rem 1rem; border-radius: 7px; font-size: 0.85rem; cursor: pointer; border: 1px solid transparent; }
  .sb-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .sb-btn-primary { background: linear-gradient(135deg, #24d758, #27dab4); color: #0a0a0a; font-weight: 600; }
  @media (max-width: 900px) {
    .sb-cart { position: fixed; bottom: 0; left: 0; right: 0; border-radius: 12px 12px 0 0; max-height: 70vh; z-index: 100; }
  }
</style>
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/scope-builder/CartSidebar.astro frontend/src/components/scope-builder/FoundingBanner.astro frontend/src/components/scope-builder/CrossSellPrompt.astro
git commit -m "feat(scope-builder): cart sidebar, founding banner, cross-sell components"
```

---

## Task 25: /scope-builder/index.astro — catalogue page

**Files:**
- Create: `frontend/src/pages/scope-builder/index.astro`

> This page wires everything together client-side: catalogue cards, drawers, cart, cross-sell, resume banner. All cart state runs in the browser; only the submit hits the API.

- [ ] **Step 1: Write the page**

```astro
---
// frontend/src/pages/scope-builder/index.astro
import Layout from '../../layouts/Layout.astro';
import ServiceCard      from '../../components/scope-builder/ServiceCard.astro';
import LearnMoreDrawer  from '../../components/scope-builder/LearnMoreDrawer.astro';
import ConfigDrawer     from '../../components/scope-builder/ConfigDrawer.astro';
import CartSidebar      from '../../components/scope-builder/CartSidebar.astro';
import FoundingBanner   from '../../components/scope-builder/FoundingBanner.astro';
import CrossSellPrompt  from '../../components/scope-builder/CrossSellPrompt.astro';
import { offensiveContent } from '../../lib/scope-builder/copy/offensive';
import { grcContent }       from '../../lib/scope-builder/copy/grc';
import { cloudContent }     from '../../lib/scope-builder/copy/cloud';

export const prerender = false;
const seed = Astro.url.searchParams.get('seed');
---
<Layout title="Build your scope · Underwings" description="Pick services, configure, get a written quote in 48 hours.">
  <main class="sb-main">
    <header class="sb-hero">
      <h1>Build your scope in 2 minutes</h1>
      <p>Pick services, configure each, see a live indicative range. Written quote within 48 hours.</p>
    </header>

    <div class="sb-resume" id="sb-resume" hidden>
      Welcome back — we kept your draft scope.
      <button type="button" id="sb-resume-continue">Continue</button>
      <button type="button" id="sb-resume-fresh">Start fresh</button>
    </div>

    <div class="sb-layout">
      <section class="sb-catalogue">
        <ServiceCard category="offensive" title="Offensive Security" tagline="Pen testing, VAPT, phishing — manual exploitation, not just scanning." range={offensiveContent.range} />
        <ServiceCard category="grc"       title="GRC — ISO, NESA, PDPL, ADHICS" tagline="Implementation, not advice. Gap → remediate → audit-ready evidence." range={grcContent.range} />
        <ServiceCard category="cloud"     title="Cloud Security — Azure & M365" tagline="CIS Benchmark + Microsoft best-practice review of Azure, M365, Entra." range={cloudContent.range} />
        <ServiceCard category="network"   title="Network Infrastructure" tagline="Firewall + architecture + segmentation review." range="Coming Phase 2" comingSoon={true} />
        <ServiceCard category="training"  title="Training & Awareness" tagline="Workshops, phishing sim, tabletop IR drills." range="Coming Phase 2" comingSoon={true} />

        <div id="sb-crosssell-slot"><CrossSellPrompt /></div>
        <FoundingBanner />
      </section>
      <CartSidebar />
    </div>

    <LearnMoreDrawer category="offensive" content={offensiveContent} />
    <LearnMoreDrawer category="grc"       content={grcContent} />
    <LearnMoreDrawer category="cloud"     content={cloudContent} />
    <ConfigDrawer />
  </main>
</Layout>

<script define:vars={{ seed }}>
  // ---------------------------------------------------------------
  // Imports via dynamic ES import for client bundle
  import('/scope-builder/runtime.js').then(({ initScopeBuilder }) => initScopeBuilder({ seed }));
</script>

<style>
  .sb-main { max-width: 1200px; margin: 0 auto; padding: 100px 24px 80px; color: #e5e7eb; }
  .sb-hero h1 { font-size: clamp(1.7rem, 3.5vw, 2.4rem); margin: 0 0 .5rem; color: #fff; }
  .sb-hero p { color: rgba(255,255,255,0.7); margin: 0 0 2rem; }
  .sb-resume { background: rgba(36,215,88,0.08); border: 1px solid rgba(36,215,88,0.3); padding: 0.7rem 1rem; border-radius: 8px; margin-bottom: 1.5rem; display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; font-size: 0.85rem; }
  .sb-resume button { background: transparent; border: 1px solid rgba(255,255,255,0.18); color: #fff; padding: .35rem .8rem; border-radius: 6px; cursor: pointer; font-size: 0.78rem; }
  .sb-layout { display: grid; grid-template-columns: 1fr 320px; gap: 2rem; }
  .sb-catalogue { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; align-content: start; }
  @media (max-width: 900px) { .sb-layout { grid-template-columns: 1fr; padding-bottom: 280px; } }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/scope-builder/index.astro
git commit -m "feat(scope-builder): catalogue page (index)"
```

---

## Task 26: Client-side runtime (cart wiring, drawers, persistence)

**Files:**
- Create: `frontend/public/scope-builder/runtime.js`

> Plain JS file shipped in `public/` so the catalogue page can dynamically import it without bundling.

- [ ] **Step 1: Write the runtime**

```js
// frontend/public/scope-builder/runtime.js

const STORAGE_KEY = 'uw_scope_cart_v1';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PRICES = {
  offensive: {
    network_ext:[15000,36000],network_int:[26000,52000],web:[12000,32000],
    mobile_one:[14000,28000],mobile_both:[22000,44000],api:[12000,28000],
    cloud:[9000,20000],phishing:[3500,12000],va_only:[3500,10000],
  },
  // GRC and Cloud computed by formulas below
};
const SIZE_MULT_OFF = { xs:0.85, s:1.0, m:1.15, l:1.3 };

function loadCart() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s.version !== 1) return null;
    if (Date.now() - s.updated_at > TTL_MS) { localStorage.removeItem(STORAGE_KEY); return null; }
    return s;
  } catch { return null; }
}
function saveCart(s) { s.updated_at = Date.now(); localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
function emptyCart() { return { items: [], universal: {}, founding_optin: false, updated_at: Date.now(), version: 1 }; }
function clearCart() { localStorage.removeItem(STORAGE_KEY); }

function fmtRange(low, high) { return `AED ${low.toLocaleString('en-AE')} – ${high.toLocaleString('en-AE')}`; }

function priceOffensive(a) {
  const m = SIZE_MULT_OFF[a.size] || 1;
  let low=0,high=0;
  for (const s of (a.services||[])) { const p = PRICES.offensive[s]; if (!p) continue; low += p[0]*m; high += p[1]*m; }
  if (a.authenticated) { low *= 1.05; high *= 1.10; }
  if (a.retest)        { low *= 1.05; high *= 1.05; }
  low  = Math.round(low /500)*500;
  high = Math.round(high/500)*500;
  return { low, high, summary: `Offensive · ${(a.services||[]).length} service(s) · ${(a.size||'s').toUpperCase()}${a.authenticated?' · authenticated':''}` };
}

function priceGrc(a) {
  const BASE = {
    iso27001:{gap:[14000,28000],implementation:[36000,88000]},
    nesa:{gap:[14000,35000],implementation:[40000,95000]},
    pdpl:{gap:[11000,24000],implementation:[22000,55000]},
    adhics:{gap:[18000,38000],implementation:[45000,100000]},
    dubai_isr:{gap:[16000,32000],implementation:[38000,80000]},
    pci:{gap:[18000,36000],implementation:[45000,95000]},
    risk_register:{gap:[14000,30000],implementation:[14000,30000]},
  };
  const SIZE = {xs:0.85,s:1.0,m:1.2,l:1.45};
  const SECT = {banking:1.2,healthcare:1.15,government:1.15,it:1.0,retail:1.0,sme:0.9,other:1.0};
  const TIME = {hard_deadline:1.15,six_months:1.0,twelve_months:0.95,roadmap:0.9};
  const m = (SIZE[a.size]||1)*(SECT[a.sector]||1)*(TIME[a.timeline]||1);
  const eng = a.engagement_default || 'gap';
  let low=0, high=0;
  for (const fw of (a.frameworks||[])) {
    const b = BASE[fw]; if (!b) continue;
    const r = b[eng] || b.gap;
    low += r[0]*m; high += r[1]*m;
  }
  low  = Math.round(low /500)*500;
  high = Math.round(high/500)*500;
  return { low, high, summary: `GRC · ${(a.frameworks||[]).join(', ')} · ${(a.size||'m').toUpperCase()}` };
}

function priceCloud(a) {
  const SCOPE = { azure:[9000,20000], m365:[7000,18000], entra:[6000,14000] };
  const M365 = {xs:0.85,s:1.0,m:1.2,l:1.45};
  const SUBS = {1:1.0,2:1.15,3:1.35};
  let low=0, high=0;
  for (const s of (a.scope||[])) {
    const b = SCOPE[s]; if (!b) continue;
    let m = 1;
    if (s === 'azure') m *= SUBS[a.azure_subs||1] || 1;
    if (s === 'm365' || s === 'entra') m *= M365[a.m365_users||'s'] || 1;
    low += b[0]*m; high += b[1]*m;
  }
  const pen = (a.conditional_access==='no'?0.05:0)+(a.mfa==='no'?0.05:0);
  low  *= (1+pen); high *= (1+pen);
  low  = Math.round(low /500)*500;
  high = Math.round(high/500)*500;
  return { low, high, summary: `Cloud · ${(a.scope||[]).join(' + ').toUpperCase()} · ${(a.m365_users||'s').toUpperCase()}` };
}

function priceFor(category, answers) {
  if (category==='offensive') return priceOffensive(answers);
  if (category==='grc')       return priceGrc(answers);
  if (category==='cloud')     return priceCloud(answers);
  return { low:0, high:0, summary: '' };
}

function bundle(items) {
  const subLow = items.reduce((s,i)=>s+i.range.low,0);
  const subHigh= items.reduce((s,i)=>s+i.range.high,0);
  const n = items.length;
  let pct = n===2?5 : n===3?10 : n>=4?15 : 0;
  const adjLow  = Math.round((subLow *(1-pct/100))/500)*500;
  const adjHigh = Math.round((subHigh*(1-pct/100))/500)*500;
  const signal = pct===0?'':`Bundle saves ~${pct}% — discussed in scoping call`;
  return { sub:{low:subLow,high:subHigh}, adj:{low:adjLow,high:adjHigh}, pct, signal };
}

const CROSS_SELL = [
  { if_added:'offensive', unless:['grc'],       suggest:'grc',       reason:'ISO 27001 requires evidence of penetration testing under control A.8.29.' },
  { if_added:'grc',       unless:['offensive'], suggest:'offensive', reason:'ISO and NESA both require evidence of pen testing — pair them now.' },
  { if_added:'cloud',     unless:['grc'],       suggest:'grc',       reason:'Cloud findings map cleanly to ISO 27017 evidence.' },
  { if_added:'cloud',     unless:['offensive'], suggest:'offensive', reason:'External pen test validates the cloud config from an attacker view.' },
];
function pickCross(added, current) {
  for (const r of CROSS_SELL) {
    if (r.if_added !== added) continue;
    if (r.unless.some((c)=>current.includes(c))) continue;
    return r;
  }
  return null;
}

function readForm(category, fieldset) {
  const a = {};
  fieldset.querySelectorAll('input, select, textarea').forEach((el) => {
    if (el.name === 'services' || el.name === 'frameworks' || el.name === 'scope') {
      if (!a[el.name]) a[el.name] = [];
      if (el.checked) a[el.name].push(el.value);
    } else if (el.type === 'checkbox') {
      a[el.name] = el.checked;
    } else {
      a[el.name] = el.value;
    }
  });
  if (a.azure_subs) a.azure_subs = parseInt(a.azure_subs, 10);
  return a;
}

export function initScopeBuilder({ seed }) {
  let state = loadCart();
  const hadResumable = !!state && state.items.length > 0;
  if (!state) state = emptyCart();

  // Resume banner
  if (hadResumable) {
    const r = document.getElementById('sb-resume');
    if (r) r.hidden = false;
    document.getElementById('sb-resume-continue')?.addEventListener('click', () => { document.getElementById('sb-resume').hidden = true; render(); });
    document.getElementById('sb-resume-fresh')?.addEventListener('click', () => { clearCart(); state = emptyCart(); document.getElementById('sb-resume').hidden = true; render(); });
  }

  // Learn-more open/close
  document.querySelectorAll('[data-learn]').forEach((b) => b.addEventListener('click', () => openLearn(b.dataset.learn)));
  document.querySelectorAll('.sb-drawer [data-close], .sb-drawer-bg').forEach((el) => el.addEventListener('click', () => closeAllLearn()));
  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => { closeAllLearn(); openConfig(b.dataset.add); }));

  // Config drawer
  document.querySelectorAll('#sb-cfg-drawer [data-close], #sb-cfg-drawer .sb-cfg-bg').forEach((el) => el.addEventListener('click', closeConfig));
  const form = document.getElementById('sb-cfg-form');
  if (form) form.addEventListener('input', updateLiveRange);
  document.getElementById('sb-cfg-save')?.addEventListener('click', saveFromForm);
  document.getElementById('sb-cart-continue')?.addEventListener('click', goToEnquiry);

  // Cross-sell buttons
  document.getElementById('sb-xs-no')?.addEventListener('click', () => { document.getElementById('sb-crosssell').hidden = true; });
  document.getElementById('sb-xs-yes')?.addEventListener('click', () => {
    const cat = document.getElementById('sb-crosssell').dataset.suggest;
    document.getElementById('sb-crosssell').hidden = true;
    if (cat) openConfig(cat);
  });

  // Seed
  if (seed && ['offensive','grc','cloud'].includes(seed)) setTimeout(() => openConfig(seed), 240);

  let currentEditId = null;
  let currentCategory = null;

  function openLearn(cat) { closeAllLearn(); document.getElementById(`sb-drawer-${cat}`)?.classList.add('is-open'); }
  function closeAllLearn() { document.querySelectorAll('.sb-drawer').forEach((d) => d.classList.remove('is-open')); }

  function openConfig(category, item) {
    currentCategory = category; currentEditId = item ? item.id : null;
    const drawer = document.getElementById('sb-cfg-drawer');
    drawer.classList.add('is-open');
    document.getElementById('sb-cfg-title').textContent = `Configure ${category[0].toUpperCase()}${category.slice(1)}`;
    drawer.querySelectorAll('fieldset[data-cat]').forEach((fs) => { fs.hidden = fs.dataset.cat !== category; });
    if (item) hydrateForm(category, item.answers, item.comments);
    else clearForm();
    updateLiveRange();
  }
  function closeConfig() { document.getElementById('sb-cfg-drawer').classList.remove('is-open'); currentEditId = null; currentCategory = null; }

  function hydrateForm(category, answers, comments) {
    const fs = document.querySelector(`fieldset[data-cat="${category}"]`);
    fs.querySelectorAll('input, select, textarea').forEach((el) => {
      if (Array.isArray(answers[el.name])) { el.checked = answers[el.name].includes(el.value); }
      else if (el.type === 'checkbox') el.checked = !!answers[el.name];
      else if (answers[el.name] !== undefined) el.value = answers[el.name];
    });
    document.querySelector('textarea[name="comments"]').value = comments || '';
  }
  function clearForm() {
    document.querySelectorAll('#sb-cfg-form input, #sb-cfg-form select, #sb-cfg-form textarea').forEach((el) => {
      if (el.type === 'checkbox') el.checked = false;
      else if (el.tagName === 'SELECT') el.selectedIndex = [...el.options].findIndex((o) => o.defaultSelected) || 0;
      else el.value = '';
    });
  }
  function readActiveAnswers() {
    if (!currentCategory) return {};
    const fs = document.querySelector(`fieldset[data-cat="${currentCategory}"]`);
    return readForm(currentCategory, fs);
  }
  function updateLiveRange() {
    const a = readActiveAnswers();
    const r = priceFor(currentCategory, a);
    document.getElementById('sb-cfg-range').textContent = (r.low === 0 && r.high === 0) ? '— pick at least one option —' : fmtRange(r.low, r.high);
  }
  function saveFromForm() {
    const a = readActiveAnswers();
    const r = priceFor(currentCategory, a);
    if (r.low === 0 && r.high === 0) { return; }
    const comments = document.querySelector('textarea[name="comments"]').value.trim();
    const newItem = { id: currentEditId || crypto.randomUUID(), category: currentCategory, answers: a, comments: comments || undefined, range: { low: r.low, high: r.high }, summary: r.summary };
    if (currentEditId) {
      state.items = state.items.map((i) => i.id === currentEditId ? newItem : i);
    } else {
      state.items.push(newItem);
    }
    saveCart(state);
    closeConfig();
    if (!currentEditId) maybeShowCrossSell(newItem.category);
    render();
  }
  function maybeShowCrossSell(addedCat) {
    const cats = state.items.map((i) => i.category);
    const r = pickCross(addedCat, cats);
    const slot = document.getElementById('sb-crosssell');
    if (!slot) return;
    if (!r) { slot.hidden = true; return; }
    slot.hidden = false;
    slot.dataset.suggest = r.suggest;
    document.getElementById('sb-xs-msg').textContent = `You added ${addedCat}. ${r.reason} Add ${r.suggest}?`;
  }
  function removeItem(id) { state.items = state.items.filter((i) => i.id !== id); saveCart(state); render(); }
  function editItem(id) { const item = state.items.find((i) => i.id === id); if (item) openConfig(item.category, item); }
  function render() {
    const list = document.getElementById('sb-cart-list');
    const empty = document.getElementById('sb-cart-empty');
    const totals = document.getElementById('sb-cart-totals');
    const continueBtn = document.getElementById('sb-cart-continue');
    list.innerHTML = '';
    if (state.items.length === 0) {
      list.appendChild(empty);
      totals.hidden = true;
      continueBtn.disabled = true;
      document.getElementById('sb-cart-count').textContent = '0 items';
      return;
    }
    state.items.forEach((it) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="sb-cart-line-summary">${escapeHtml(it.summary)}</span>
        <span class="sb-cart-line-range">${fmtRange(it.range.low, it.range.high)}</span>
        <span class="sb-cart-line-actions"><button data-edit>Edit</button><button data-remove>Remove</button></span>`;
      li.querySelector('[data-edit]').addEventListener('click', () => editItem(it.id));
      li.querySelector('[data-remove]').addEventListener('click', () => removeItem(it.id));
      list.appendChild(li);
    });
    const b = bundle(state.items);
    document.getElementById('sb-cart-sub').textContent = fmtRange(b.sub.low, b.sub.high);
    document.getElementById('sb-cart-adj').textContent = fmtRange(b.adj.low, b.adj.high);
    const sav = document.getElementById('sb-cart-savings');
    if (b.pct > 0) {
      sav.hidden = false;
      document.getElementById('sb-cart-savings-label').textContent = b.signal;
      document.getElementById('sb-cart-savings-pct').textContent = `−${b.pct}%`;
    } else { sav.hidden = true; }
    totals.hidden = false;
    continueBtn.disabled = false;
    document.getElementById('sb-cart-count').textContent = `${state.items.length} item${state.items.length===1?'':'s'}`;
  }
  function goToEnquiry() { window.location.href = '/scope-builder/enquiry'; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  render();
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/public/scope-builder/runtime.js
git commit -m "feat(scope-builder): client runtime (cart + drawers + cross-sell)"
```

---

## Task 27: /scope-builder/enquiry.astro — review + lead capture

**Files:**
- Create: `frontend/src/pages/scope-builder/enquiry.astro`

- [ ] **Step 1: Write the page**

```astro
---
// frontend/src/pages/scope-builder/enquiry.astro
import Layout from '../../layouts/Layout.astro';
import FoundingBanner from '../../components/scope-builder/FoundingBanner.astro';
export const prerender = false;
---
<Layout title="Review your scope · Underwings" description="Final review and lead capture">
  <main class="enq-main">
    <a href="/scope-builder" class="enq-back">← Back to cart</a>
    <h1>Review your scope</h1>

    <section class="enq-summary" id="enq-summary"></section>

    <FoundingBanner />

    <form id="enq-form" class="enq-form" novalidate>
      <h2>Comments & Information</h2>
      <p class="enq-help">Optional — but the more you tell us, the sharper the quote.</p>
      <label>Anything specific you're worried about?<textarea name="worry" rows="2"></textarea></label>
      <label>Compliance / audit deadline if any?<input type="text" name="deadline" placeholder="e.g. ISO audit 2026-08-15"></label>
      <label>Existing tools / vendors already in place?<textarea name="existing" rows="2"></textarea></label>
      <label>Anything else we should know?<textarea name="other" rows="2"></textarea></label>

      <h2>Founding Client</h2>
      <label class="enq-fc"><input type="checkbox" name="founding_optin"> I'd like to be considered for Founding Client pricing (10–30% off in exchange for a published case study, first 10 clients only)</label>

      <h2>Your details</h2>
      <div class="enq-grid">
        <label>Name<input type="text" name="name" required autocomplete="name"></label>
        <label>Work email<input type="email" name="email" required autocomplete="email"></label>
        <label>Company<input type="text" name="company" required autocomplete="organization"></label>
        <label>Phone (optional)<input type="tel" name="phone" autocomplete="tel"></label>
      </div>
      <label class="enq-row"><input type="checkbox" name="whatsapp_ok"> WhatsApp is OK on this number</label>
      <label>Best time to call?<select name="best_time"><option value="today">Today</option><option value="this_week" selected>This week</option><option value="no_rush">No rush</option></select></label>

      <label class="enq-consent"><input type="checkbox" name="consent" required checked> I agree to receive the scope quote by email and a follow-up call.</label>

      <button type="submit" class="enq-submit" id="enq-submit">Submit and get your scope plan in 48h</button>
      <div class="enq-error" id="enq-error" hidden></div>
    </form>
  </main>
</Layout>

<script>
  const STORAGE_KEY = 'uw_scope_cart_v1';
  function fmtRange(low, high) { return `AED ${low.toLocaleString('en-AE')} – ${high.toLocaleString('en-AE')}`; }
  function bundle(items) {
    const subLow = items.reduce((s,i)=>s+i.range.low,0); const subHigh = items.reduce((s,i)=>s+i.range.high,0);
    const n = items.length; const pct = n===2?5:n===3?10:n>=4?15:0;
    const adjLow = Math.round((subLow*(1-pct/100))/500)*500; const adjHigh = Math.round((subHigh*(1-pct/100))/500)*500;
    return { sub:{low:subLow,high:subHigh}, adj:{low:adjLow,high:adjHigh}, pct };
  }
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) { window.location.href = '/scope-builder'; }
  const state = JSON.parse(raw || '{"items":[]}');
  if (!state.items?.length) { window.location.href = '/scope-builder'; }

  const sum = document.getElementById('enq-summary');
  const b = bundle(state.items);
  sum.innerHTML = state.items.map((i)=>`<div class="enq-line"><span>${i.summary}</span><span>${fmtRange(i.range.low,i.range.high)}</span></div>`).join('') +
    `<div class="enq-total"><span>Estimated range</span><strong>${fmtRange(b.adj.low,b.adj.high)}</strong></div>`;

  document.getElementById('enq-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const submit = document.getElementById('enq-submit');
    const err = document.getElementById('enq-error');
    err.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Submitting…';
    try {
      const res = await fetch('/api/scope-builder-v2', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          cart: state.items,
          comments: { worry: fd.get('worry'), deadline: fd.get('deadline'), existing: fd.get('existing'), other: fd.get('other') },
          founding_optin: fd.get('founding_optin') === 'on',
          lead: {
            name: fd.get('name'), email: fd.get('email'), company: fd.get('company'),
            phone: fd.get('phone'), whatsapp_ok: fd.get('whatsapp_ok')==='on',
            best_time: fd.get('best_time'),
          },
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || 'submit_failed');
      localStorage.removeItem(STORAGE_KEY);
      window.location.href = j.redirect || `/scope-builder/thanks/${j.reference}`;
    } catch (e) {
      err.textContent = 'Sorry — something went wrong. Please try again or email us at quotes@underwings.org. (' + (e.message || e) + ')';
      err.hidden = false;
      submit.disabled = false;
      submit.textContent = 'Submit and get your scope plan in 48h';
    }
  });
</script>

<style>
  .enq-main { max-width: 720px; margin: 0 auto; padding: 100px 24px 80px; color: #e5e7eb; }
  .enq-back { color: rgba(255,255,255,0.6); font-size: 0.85rem; }
  h1 { color: #fff; }
  .enq-summary .enq-line { display: flex; justify-content: space-between; padding: .55rem 0; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 0.9rem; }
  .enq-total { display: flex; justify-content: space-between; padding: .85rem 0; font-size: 1.05rem; color: #fff; }
  .enq-total strong { color: #24d758; font-family: ui-monospace,monospace; }
  .enq-form { margin-top: 2rem; display: flex; flex-direction: column; gap: 0.7rem; }
  .enq-form h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: .08em; color: #6b7280; margin: 1.2rem 0 .25rem; }
  .enq-form label { display: flex; flex-direction: column; gap: .3rem; font-size: 0.85rem; color: rgba(255,255,255,0.78); }
  .enq-form input[type=text], .enq-form input[type=email], .enq-form input[type=tel], .enq-form select, .enq-form textarea { padding: .6rem .8rem; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; color: #e5e7eb; font-size: 0.9rem; }
  .enq-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
  .enq-row, .enq-fc, .enq-consent { flex-direction: row !important; align-items: center; gap: .5rem; }
  .enq-fc { background: rgba(255,200,80,0.06); border: 1px solid rgba(255,200,80,0.25); border-radius: 6px; padding: .65rem; }
  .enq-help { font-size: 0.78rem; color: rgba(255,255,255,0.5); margin: 0; }
  .enq-submit { margin-top: 1.2rem; padding: .9rem; border-radius: 8px; background: linear-gradient(135deg,#24d758,#27dab4); color: #0a0a0a; font-weight: 700; border: 0; cursor: pointer; font-size: 0.95rem; }
  .enq-submit:disabled { opacity: 0.5; cursor: wait; }
  .enq-error { margin-top: .8rem; padding: .65rem .85rem; background: rgba(255,76,76,0.1); border: 1px solid rgba(255,76,76,0.4); border-radius: 6px; color: #ffb6b6; font-size: 0.85rem; }
  @media (max-width:640px){ .enq-grid { grid-template-columns: 1fr; } }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/scope-builder/enquiry.astro
git commit -m "feat(scope-builder): enquiry page (review + lead capture)"
```

---

## Task 28: /scope-builder/thanks/[ref].astro — confirmation page

**Files:**
- Create: `frontend/src/pages/scope-builder/thanks/[ref].astro`

- [ ] **Step 1: Write page**

```astro
---
// frontend/src/pages/scope-builder/thanks/[ref].astro
import Layout from '../../../layouts/Layout.astro';
import { supa } from '../../../lib/scope-builder/server/supabase';
export const prerender = false;
const ref = Astro.params.ref || '';
const { data: scope } = await supa.from('scopes').select('reference, token, range_low, range_high, lead_name, founding_optin').eq('reference', ref).maybeSingle();
if (!scope) { return Astro.redirect('/scope-builder'); }
const fmt = (n) => 'AED ' + Number(n).toLocaleString('en-AE');
---
<Layout title={`Scope ready — ${scope.reference}`} description="Your scope plan is on its way.">
  <main class="thx">
    <div class="thx-card">
      <div class="thx-tick">✓</div>
      <h1>Thanks{scope.lead_name ? ', ' + scope.lead_name.split(' ')[0] : ''} — your scope plan is ready.</h1>
      <p class="thx-meta">Reference <strong>{scope.reference}</strong> · Estimated range <strong>{fmt(scope.range_low)} – {fmt(scope.range_high)}</strong></p>
      {scope.founding_optin && <div class="thx-fc">★ Founding Client opt-in noted — we will lead with the discount on our scoping call.</div>}
      <p>The full PDF was emailed to you. You can also <a href={`/scope/${scope.token}`}>view it online</a>.</p>
      <p>We will email a written fixed-price quote within 48 hours.</p>
      <div class="thx-actions">
        <a class="thx-btn primary" href={`/scope/${scope.token}`}>View online</a>
        <a class="thx-btn ghost" href={`https://wa.me/971547078203?text=${encodeURIComponent('Question about scope ' + scope.reference)}`}>Ask on WhatsApp</a>
      </div>
    </div>
  </main>
</Layout>
<style>
  .thx { max-width: 720px; margin: 0 auto; padding: 120px 24px 80px; color: #e5e7eb; }
  .thx-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 2rem; }
  .thx-tick { width: 56px; height: 56px; border-radius: 50%; background: linear-gradient(135deg,#24d758,#27dab4); color: #0a0a0a; font-size: 2rem; line-height: 56px; text-align: center; margin-bottom: 1rem; }
  h1 { margin: 0 0 .5rem; color: #fff; font-size: 1.5rem; }
  .thx-meta { font-size: 0.95rem; }
  .thx-fc { background: rgba(255,200,80,0.08); border: 1px solid rgba(255,200,80,0.3); padding: .6rem .85rem; border-radius: 6px; color: #ffd97a; margin: 1rem 0; font-size: 0.85rem; }
  .thx-actions { display: flex; gap: .6rem; margin-top: 1.2rem; flex-wrap: wrap; }
  .thx-btn { padding: .7rem 1.2rem; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 0.9rem; }
  .thx-btn.primary { background: linear-gradient(135deg,#24d758,#27dab4); color: #0a0a0a; }
  .thx-btn.ghost { background: transparent; border: 1px solid rgba(255,255,255,0.18); color: #d1d5db; }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/scope-builder/thanks/[ref].astro
git commit -m "feat(scope-builder): thanks confirmation page"
```

---

## Task 29: /scope/[token].astro — hosted PDF view page

**Files:**
- Create: `frontend/src/pages/scope/[token].astro`

- [ ] **Step 1: Write page**

```astro
---
// frontend/src/pages/scope/[token].astro
import Layout from '../../layouts/Layout.astro';
import { supa } from '../../lib/scope-builder/server/supabase';
export const prerender = false;

const token = Astro.params.token || '';
Astro.response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
Astro.response.headers.set('Cache-Control', 'private, no-store');

if (!/^[A-Za-z0-9_-]{32}$/.test(token)) {
  return new Response('Not found', { status: 404 });
}

const { data: scope } = await supa.from('scopes').select('*').eq('token', token).maybeSingle();
if (!scope) return new Response('Not found', { status: 404 });
if (new Date(scope.expires_at) < new Date()) {
  return new Response('This scope quote has expired. Please request a renewal at quotes@underwings.org.', { status: 410 });
}

const fmt = (n) => 'AED ' + Number(n).toLocaleString('en-AE');
const items = scope.cart;
const founding = scope.founding_optin;
const wa = `https://wa.me/971547078203?text=${encodeURIComponent('Question about scope ' + scope.reference)}`;
---
<Layout title={`Scope ${scope.reference}`} description="Your scope plan">
  <main class="hsv">
    <header class="hsv-head">
      <div>
        <h1>Scope plan</h1>
        <p class="hsv-meta">Reference <strong>{scope.reference}</strong> · {scope.lead_company} · Valid until {new Date(scope.expires_at).toLocaleDateString('en-AE')}</p>
      </div>
      <div class="hsv-status">
        {scope.status === 'won'  && <span class="hsv-pill ok">✓ Confirmed</span>}
        {scope.status === 'lost' && <span class="hsv-pill bad">Expired / declined</span>}
      </div>
    </header>

    <section class="hsv-items">
      {items.map((i) => (
        <div class="hsv-item">
          <div class="hsv-item-summary">{i.summary}</div>
          {i.comments && <div class="hsv-item-note">Note: {i.comments}</div>}
          <div class="hsv-item-range">{fmt(i.range.low)} – {fmt(i.range.high)}</div>
        </div>
      ))}
    </section>

    <section class="hsv-totals">
      <div class="row total"><span>Estimated range</span><strong>{fmt(scope.range_low)} – {fmt(scope.range_high)}</strong></div>
      {scope.bundle_savings && <div class="row"><span>{scope.bundle_savings}</span></div>}
    </section>

    {founding && <div class="hsv-fc">★ <strong>Founding Client opt-in</strong> noted on this scope. We will lead with this on the scoping call.</div>}

    <section class="hsv-actions">
      <a class="hsv-btn primary" href={`/api/scope/${token}/pdf`} target="_blank">Download PDF</a>
      <a class="hsv-btn ghost" href={wa}>Ask on WhatsApp</a>
    </section>
  </main>
</Layout>

<script define:vars={{ token }}>
  // Track view exactly once per page-load
  fetch('/api/scope/view-ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).catch(() => {});
</script>

<style>
  .hsv { max-width: 760px; margin: 0 auto; padding: 100px 24px 80px; color: #e5e7eb; }
  .hsv-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
  .hsv-meta { color: rgba(255,255,255,0.6); font-size: 0.85rem; }
  .hsv-pill { padding: .25rem .75rem; border-radius: 999px; font-size: 0.78rem; }
  .hsv-pill.ok  { background: rgba(36,215,88,0.12); color: #6deb8e; border: 1px solid rgba(36,215,88,0.3); }
  .hsv-pill.bad { background: rgba(255,76,76,0.1); color: #ffb6b6; border: 1px solid rgba(255,76,76,0.3); }
  .hsv-items { margin: 1.5rem 0; display: flex; flex-direction: column; gap: .65rem; }
  .hsv-item { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: .75rem 1rem; }
  .hsv-item-summary { font-weight: 600; }
  .hsv-item-note { color: rgba(255,255,255,0.55); font-size: 0.8rem; margin-top: 4px; }
  .hsv-item-range { color: #24d758; font-family: ui-monospace,monospace; margin-top: 4px; }
  .hsv-totals { border-top: 1px solid rgba(255,255,255,0.08); padding-top: .9rem; }
  .hsv-totals .row { display: flex; justify-content: space-between; padding: .25rem 0; font-size: 0.95rem; }
  .hsv-totals .row.total strong { color: #24d758; font-family: ui-monospace,monospace; }
  .hsv-fc { background: rgba(255,200,80,0.06); border: 1px solid rgba(255,200,80,0.3); color: #ffd97a; padding: .65rem .85rem; border-radius: 6px; margin-top: 1rem; font-size: 0.85rem; }
  .hsv-actions { display: flex; gap: .6rem; margin-top: 1.5rem; flex-wrap: wrap; }
  .hsv-btn { padding: .7rem 1.2rem; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 0.9rem; }
  .hsv-btn.primary { background: linear-gradient(135deg,#24d758,#27dab4); color: #0a0a0a; }
  .hsv-btn.ghost { background: transparent; border: 1px solid rgba(255,255,255,0.18); color: #d1d5db; }
</style>
```

- [ ] **Step 2: Add the PDF download endpoint**

Create `frontend/src/pages/api/scope/[token]/pdf.ts`:

```ts
// frontend/src/pages/api/scope/[token]/pdf.ts
import type { APIRoute } from 'astro';
import { readFile } from 'node:fs/promises';
import { supa } from '../../../../lib/scope-builder/server/supabase';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const token = params.token || '';
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return new Response('not found', { status: 404 });
  const { data: scope } = await supa.from('scopes').select('pdf_path, reference, expires_at').eq('token', token).maybeSingle();
  if (!scope || !scope.pdf_path) return new Response('not found', { status: 404 });
  if (new Date(scope.expires_at) < new Date()) return new Response('expired', { status: 410 });
  try {
    const pdf = await readFile(scope.pdf_path);
    return new Response(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${scope.reference}.pdf"`,
        'X-Robots-Tag': 'noindex, nofollow',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
};
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/scope/[token].astro frontend/src/pages/api/scope/[token]/pdf.ts
git commit -m "feat(scope-builder): hosted PDF view page + download endpoint"
```

---

## Task 30: Wire-up — legacy redirect, service-page CTAs, robots.txt

**Files:**
- Modify: `frontend/src/pages/services/offensive-security/scope-builder.astro`
- Modify: `frontend/src/pages/services/offensive-security/index.astro`
- Modify: `frontend/src/pages/services/grc/index.astro`
- Modify: `frontend/src/pages/services/cloud-security/index.astro`
- Modify: `frontend/public/robots.txt`

- [ ] **Step 1: Replace legacy scope-builder.astro with redirect**

Open `frontend/src/pages/services/offensive-security/scope-builder.astro` and replace its entire body with:

```astro
---
export const prerender = false;
return Astro.redirect('/scope-builder?seed=offensive', 301);
---
```

- [ ] **Step 2: Add seeded CTA to each category hub**

For each `services/<cat>/index.astro` file (offensive, grc, cloud), find the existing primary CTA on the hero/category page (e.g. "Get a Pen-Test Quote") and add (or update) a secondary or replacement CTA pointing to:
- offensive: `/scope-builder?seed=offensive`
- grc:       `/scope-builder?seed=grc`
- cloud:     `/scope-builder?seed=cloud`

Example markup to drop in or replace existing CTA:
```html
<a href="/scope-builder?seed=offensive" class="hero-btn hero-btn-primary">
  <span>Build a scope plan</span>
</a>
```
(Use whichever class system already exists in that file.)

- [ ] **Step 3: Add robots.txt disallow**

Open `frontend/public/robots.txt` and append:

```
Disallow: /scope/
```

- [ ] **Step 4: Build & verify legacy redirect**

```bash
docker compose build frontend && docker compose up -d frontend && docker compose restart nginx
sleep 4
curl -sI https://underwings.org/services/offensive-security/scope-builder | head -3
```

Expected: `HTTP/2 301` with `location: /scope-builder?seed=offensive`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/services/ frontend/public/robots.txt
git commit -m "feat(scope-builder): legacy redirect, hub CTAs, robots disallow"
```

---

## Task 31: PDF volume + env wiring in docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env`

- [ ] **Step 1: Add PDF volume to frontend service**

In the `frontend` service in docker-compose.yml, add to `volumes:`:
```yaml
      - scopes-data:/data/scopes
```

And add the named volume at the bottom of the file under `volumes:`:
```yaml
volumes:
  scopes-data:
```

- [ ] **Step 2: Confirm env vars present on frontend service**

In docker-compose.yml under the `frontend` service `environment:`:

```yaml
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
      - WEBHOOK_TOKEN=${WEBHOOK_TOKEN}
      - PDF_RENDER_URL=http://pdf-render:3000
      - PDF_RENDER_TOKEN=${PDF_RENDER_TOKEN}
      - SLACK_SCOPE_WEBHOOK=${SLACK_SCOPE_WEBHOOK:-}
      - KRAYIN_REVERSE_SECRET=${KRAYIN_REVERSE_SECRET}
      - KRAYIN_URL=https://crm.underwings.org
      - SMTP_HOST=stalwart
      - SMTP_PORT=587
      - SMTP_USER=newsletter@underwings.org
      - SMTP_PASS=${SMTP_PASS}
      - TEAM_EMAIL=itdept1@gcee.ae
```

- [ ] **Step 3: Add env values**

In `/home/deployer/underwings/.env` (create or update entries):

```
PDF_RENDER_TOKEN=<openssl rand -hex 24 output>
KRAYIN_REVERSE_SECRET=<openssl rand -hex 32 output>
SLACK_SCOPE_WEBHOOK=
```

`SLACK_SCOPE_WEBHOOK` left empty until the user creates a Slack workspace.

Generate the random tokens:
```bash
echo "PDF_RENDER_TOKEN=$(openssl rand -hex 24)"
echo "KRAYIN_REVERSE_SECRET=$(openssl rand -hex 32)"
```
Append the printed lines to `.env`.

- [ ] **Step 4: Recreate the frontend container with new env**

```bash
docker compose up -d frontend
docker compose exec frontend env | grep -E "PDF_RENDER|SUPABASE|KRAYIN|TEAM_EMAIL"
```

Confirm env vars are visible inside the container.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(scope-builder): docker-compose env + scopes volume"
```

---

## Task 32: End-to-end smoke test

> Run on staging or production (with throwaway test data). Each step is a verification, not a code change.

- [ ] **Step 1: Catalogue page loads**

```bash
curl -sI https://underwings.org/scope-builder | head -3
curl -s  https://underwings.org/scope-builder | grep -c "sb-card"
```
Expected: `200 OK`, count `>= 5` (5 service cards).

- [ ] **Step 2: Add an item via the UI**

In a real browser at `https://underwings.org/scope-builder`:
1. Click "Learn more" on Offensive — drawer opens, content visible.
2. Close drawer, click "+ Add to cart" on Offensive — config drawer opens.
3. Tick "Web app", set size = M, leave defaults, click "Save to cart".
4. Confirm cart sidebar shows the item with a green range and bundle savings prompt is hidden (only 1 item).
5. Add Cloud Security with Azure ticked. Confirm cross-sell prompt suggests GRC.
6. Add GRC with ISO 27001 + headcount=m. Confirm bundle saves shows ~10%.

- [ ] **Step 3: Submit enquiry**

Use a test email (e.g. `dev+test@underwings.org`):
1. Click "Continue to enquiry".
2. Fill in name = "Smoke Test", email = the test address, company = "Underwings QA", phone optional.
3. Tick Founding Client checkbox.
4. Submit.
5. You land on `/scope-builder/thanks/SCB-2026-NNNN`.

- [ ] **Step 4: Verify side effects**

```bash
# Supabase row created
docker compose exec db psql -U postgres -d postgres -c "SELECT reference, lead_email, founding_optin, range_low, range_high FROM scopes ORDER BY id DESC LIMIT 1;"
```

```bash
# Email landed (manual: check the inbox of the test address; check itdept1@gcee.ae)
```

```bash
# Krayin lead created
curl -s "https://crm.underwings.org/admin/leads?status=1" -H "Cookie: $YOUR_KRAYIN_SESSION" | grep -i 'Smoke Test'
```
Or visit `https://crm.underwings.org/admin/leads` — a "Scope Submitted" activity should appear on the new lead, founding-client-flagged with `[FC]` prefix in the title.

```bash
# PDF on disk
docker compose exec frontend ls -lh /data/scopes/ | tail -3
```

- [ ] **Step 5: Hosted link + view tracking**

In the email or DB:
```bash
TOKEN=$(docker compose exec -T db psql -U postgres -d postgres -t -c "SELECT token FROM scopes ORDER BY id DESC LIMIT 1" | tr -d '[:space:]')
curl -sI "https://underwings.org/scope/$TOKEN" | grep -E "x-robots-tag|status"
```
Expected: `X-Robots-Tag: noindex, nofollow, noarchive` and `200`.

Open the URL in a browser. Within 2 seconds, a `scope_views` row should be inserted:
```bash
docker compose exec db psql -U postgres -d postgres -c "SELECT count(*) FROM scope_views WHERE scope_id = (SELECT id FROM scopes ORDER BY id DESC LIMIT 1);"
```

And a Krayin "Scope viewed (#1)" activity should appear on the lead.

- [ ] **Step 6: Test expiry**

```bash
docker compose exec db psql -U postgres -d postgres -c "UPDATE scopes SET expires_at = now() - interval '1 day' WHERE id = (SELECT id FROM scopes ORDER BY id DESC LIMIT 1);"
curl -sI "https://underwings.org/scope/$TOKEN" | head -3
```
Expected: `HTTP/2 410`.

Reset:
```bash
docker compose exec db psql -U postgres -d postgres -c "UPDATE scopes SET expires_at = now() + interval '30 days' WHERE id = (SELECT id FROM scopes ORDER BY id DESC LIMIT 1);"
```

- [ ] **Step 7: Clean up test data**

```bash
docker compose exec db psql -U postgres -d postgres -c "DELETE FROM scopes WHERE lead_email LIKE 'dev+test%';"
```

Delete the Krayin test lead via UI.

- [ ] **Step 8: No commit needed.** Just record outcomes in a follow-up session note.

---

## Task 33: Production deploy

**Files:**
- None (operational task)

- [ ] **Step 1: Pull-build-up**

```bash
cd /home/deployer/underwings
docker compose build pdf-render frontend
docker compose up -d pdf-render frontend krayin
docker compose restart nginx
sleep 6
docker compose ps --filter status=running
```

- [ ] **Step 2: Health checks**

```bash
docker compose exec pdf-render wget -q -O - http://127.0.0.1:3000/health
curl -s -o /dev/null -w "%{http_code}\n" https://underwings.org/scope-builder
curl -s -o /dev/null -w "%{http_code}\n" https://crm.underwings.org/webhook-scope.php
```

Expected: `{"ok":true}`, `200`, `405` (because GET is rejected).

- [ ] **Step 3: Smoke test (Task 32) on production**

Re-run the smoke test against the production URLs.

- [ ] **Step 4: Commit any final config tweaks**

If env or compose changes were needed:
```bash
git add docker-compose.yml .env.example
git commit -m "chore(scope-builder): production deploy adjustments"
```

---

## Self-Review Checklist

After completing all tasks, verify:

- [ ] No exact midpoint price exposed anywhere — all UI shows `low – high` ranges
- [ ] `X-Robots-Tag: noindex, nofollow, noarchive` set on `/scope/[token]` and `/api/scope/[token]/pdf`
- [ ] `robots.txt` contains `Disallow: /scope/`
- [ ] Cart resume banner appears within 7 days, disappears after
- [ ] Founding-Client opt-in surfaces in: buyer email, team email, Krayin lead title (`[FC]` prefix), Krayin custom attribute, Slack message (when configured)
- [ ] Krayin lead created with `lead_source = "Scope Builder"` and pipeline = "Scope Builder"
- [ ] Hosted-link views log to `scope_views` table AND post Krayin activity
- [ ] Slack webhook is env-gated — works when set, silent no-op when absent
- [ ] PDF stored outside web root at `/data/scopes/{token}.pdf`, served via auth-checked endpoint
- [ ] WhatsApp click-to-chat number `+971547078203` baked into buyer email + thanks page + hosted scope page
- [ ] Legacy URL `/services/offensive-security/scope-builder` returns `301` to `/scope-builder?seed=offensive`
- [ ] Three category hubs (offensive, grc, cloud) link to seeded scope-builder

