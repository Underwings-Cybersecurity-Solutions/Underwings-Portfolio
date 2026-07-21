# Underwings CRM — Standalone-App Rework Plan (Phase A2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Relocate the Phase A CRM out of the `/admin` CMS into a **standalone app served at `crm.underwings.org`**, with its **own accounts/roles** (`crm_users`: admin/member) separate from CMS admins. Reuse the Phase A data model (migration 006) and CRM UI logic (admin.js A5–A11) verbatim.

**Architecture:** New `crm/` Vite SPA (mirrors `admin/`) served at `crm.underwings.org/`; nginx on that vhost also proxies `/{auth,rest,realtime,storage}/v1/*` → Kong so **Supabase is same-origin** (no CORS). Auth = Supabase password + **enforced TOTP MFA**, gated on `crm_users` membership. RLS on `crm_*` tables swapped from `is_admin()` → `is_crm_user()`/`is_crm_admin()`. Public/internet-reachable (login+MFA+RLS is the gate).

**Tech Stack:** vanilla JS + Vite 5 + `@supabase/supabase-js` + Chart.js; PostgreSQL 15; nginx; Docker.

## Global Constraints

- **Reuse, don't rewrite:** the CRM module (`CRM_TABS`/`crmInit`/`crmReload`/drawer/prospects/scoreboard/export, incl. the `escAttr` XSS fix and the `crm_companies!company_id` embed fix) already exists in `admin/src/js/admin.js` — port it verbatim into `crm/src/js/crm.js`. The auth/MFA code in `admin/src/js/admin.js` (lines ~167–394) is the template for the CRM login shell.
- **DB conventions:** match migration 006 style — `DROP POLICY IF EXISTS` before `CREATE POLICY`, `CREATE OR REPLACE FUNCTION`, idempotent, safe to re-run. Apply via `cat file | docker exec -i underwings-db psql -U postgres -d underwings -v ON_ERROR_STOP=1`, then **`NOTIFY pgrst, 'reload schema'`**.
- **Same-origin Supabase:** the `crm.underwings.org` vhost mirrors the existing `/auth/ /rest/ /realtime/ /storage/` → `http://kong/...` proxy blocks (nginx.conf:277–310). The CRM app's `SUPABASE_URL` = `https://crm.underwings.org`.
- **MFA is mandatory** for CRM login (not optional like `/admin`): a session without `aal2` must be blocked from data.
- **Roles:** `crm_member` = SELECT/INSERT/UPDATE on `crm_*`; `crm_admin` = also DELETE. Views stay `security_invoker=true`.
- **Commit scope:** each task commits only its own files; the working tree has many unrelated pending changes — never stage them.
- Money shows `AED`. Vanilla JS only.

---

### Task R1: Migration 007 — `crm_users`, role functions, RLS swap

**Files:** Create `supabase/migrations/007_crm_roles.sql`

**Interfaces:** Produces `public.crm_users`, `public.is_crm_user()`, `public.is_crm_admin()`; every `crm_*` table's RLS now keys off CRM roles. The CRM app (R4) reads `crm_users` to gate login; `provision-crm-user.sh` (R7) writes it.

- [ ] **Step 1: Write the migration**

```sql
-- ===========================================
-- MIGRATION 007: CRM roles — separate crm_users identity for the standalone
-- crm.underwings.org app (distinct from admin_users/CMS). Swaps all crm_*
-- RLS off is_admin() onto is_crm_user()/is_crm_admin(). Idempotent.
-- ===========================================

CREATE TABLE IF NOT EXISTS public.crm_users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.crm_users ENABLE ROW LEVEL SECURITY;
-- a CRM user may read the roster; only a CRM admin may change it
DROP POLICY IF EXISTS "crm users readable by crm users" ON public.crm_users;
CREATE POLICY "crm users readable by crm users" ON public.crm_users
    FOR SELECT USING (public.is_crm_user());
DROP POLICY IF EXISTS "crm users managed by crm admin" ON public.crm_users;
CREATE POLICY "crm users managed by crm admin" ON public.crm_users
    FOR ALL USING (public.is_crm_admin()) WITH CHECK (public.is_crm_admin());

CREATE OR REPLACE FUNCTION public.is_crm_user()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (SELECT 1 FROM public.crm_users WHERE id = auth.uid());
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_crm_admin()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (SELECT 1 FROM public.crm_users WHERE id = auth.uid() AND role = 'admin');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ---------- swap RLS on every crm_* data table ----------
-- Drop the migration-006 admin policies, add member (read/write) + admin (delete).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'crm_companies','crm_contacts','crm_deals','crm_activities',
    'crm_suppression','crm_prospects','crm_prospect_contacts'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Admins can manage %s" ON public.%I;',
                   replace(t,'crm_',''), t);
    -- exact old names from 006 were "Admins can manage crm companies" etc; also drop those:
    EXECUTE format('DROP POLICY IF EXISTS %L ON public.%I;',
                   'Admins can manage ' || replace(replace(t,'crm_',''),'_',' '), t);
    EXECUTE format('DROP POLICY IF EXISTS "crm read" ON public.%I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "crm write" ON public.%I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "crm modify" ON public.%I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "crm delete" ON public.%I;', t);
    EXECUTE format('CREATE POLICY "crm read" ON public.%I FOR SELECT USING (public.is_crm_user());', t);
    EXECUTE format('CREATE POLICY "crm write" ON public.%I FOR INSERT WITH CHECK (public.is_crm_user());', t);
    EXECUTE format('CREATE POLICY "crm modify" ON public.%I FOR UPDATE USING (public.is_crm_user()) WITH CHECK (public.is_crm_user());', t);
    EXECUTE format('CREATE POLICY "crm delete" ON public.%I FOR DELETE USING (public.is_crm_admin());', t);
  END LOOP;
END $$;
```

Note: migration 006 named its policies `"Admins can manage crm companies"`, `"...crm contacts"`, `"...crm deals"`, `"...crm activities"`, `"...crm suppression"`, `"...crm prospects"`, `"...crm prospect contacts"`. The `DO` block's second DROP reconstructs those exact names (`crm_` stripped, `_`→space). Verify each old policy is gone after applying (Step 3).

- [ ] **Step 2: Validate in a rolled-back transaction**

Run: `{ echo "BEGIN;"; cat supabase/migrations/007_crm_roles.sql; echo "ROLLBACK;"; } | docker exec -i underwings-db psql -U postgres -d underwings -v ON_ERROR_STOP=1`
Expected: no `ERROR:`, ends `ROLLBACK`.

- [ ] **Step 3: Apply for real + reload PostgREST + verify policies swapped**

```bash
cat supabase/migrations/007_crm_roles.sql | docker exec -i underwings-db psql -U postgres -d underwings -v ON_ERROR_STOP=1
docker exec -i underwings-db psql -U postgres -d underwings -c "NOTIFY pgrst, 'reload schema';"
docker exec -i underwings-db psql -U postgres -d underwings -c \
"SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename LIKE 'crm\_%' ORDER BY tablename, cmd;"
```
Expected: every `crm_*` table shows `crm read/write/modify/delete` policies and NO `Admins can manage...` policy remains.

- [ ] **Step 4: Commit** — `git add supabase/migrations/007_crm_roles.sql && git commit -m "feat(crm): migration 007 — crm_users roles + RLS swap"`

---

### Task R2: Scaffold the `crm/` app (build tooling)

**Files:** Create `crm/package.json`, `crm/vite.config.js`, `crm/Dockerfile`, `crm/nginx.conf`, `crm/docker-entrypoint.sh`

**Interfaces:** Produces a buildable Vite SPA served at `/` on container port 5173. R3/R4 add its `src/`.

- [ ] **Step 1: `crm/package.json`** (copy of admin's, renamed)
```json
{
  "name": "underwings-crm",
  "type": "module",
  "version": "1.0.0",
  "scripts": { "dev": "vite --host", "build": "vite build", "preview": "vite preview --host" },
  "dependencies": { "@supabase/supabase-js": "^2.39.0", "chart.js": "^4.4.0" },
  "devDependencies": { "vite": "^5.0.0" }
}
```

- [ ] **Step 2: `crm/vite.config.js`** — base `/` (served at domain root, not `/admin/`)
```js
import { defineConfig } from 'vite';
export default defineConfig({
  base: '/',
  root: 'src',
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 5173, host: true },
});
```

- [ ] **Step 3: `crm/Dockerfile`** — copy `admin/Dockerfile` verbatim (it references `nginx.conf`/`docker-entrypoint.sh` relatively, so it works unchanged; keep `EXPOSE 5173`, entrypoint name may stay `/docker-entrypoint-admin.sh` or rename to `/docker-entrypoint-crm.sh` — rename for clarity and update the two COPY/ENTRYPOINT lines accordingly).

- [ ] **Step 4: `crm/nginx.conf`** — serve the SPA at `/` (NOT `/admin/`):
```nginx
server {
    listen 5173;
    server_name localhost;
    root /usr/share/nginx/html;
    location / {
        try_files $uri $uri/ /index.html;
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
            expires 30d;
            add_header Cache-Control "public, immutable";
        }
    }
}
```

- [ ] **Step 5: `crm/docker-entrypoint.sh`** — copy admin's (same `sed` env substitution on `index.html`):
```sh
#!/bin/sh
sed -i "s|__SUPABASE_URL__|${SUPABASE_URL}|g" /usr/share/nginx/html/index.html
sed -i "s|__SUPABASE_ANON_KEY__|${SUPABASE_ANON_KEY}|g" /usr/share/nginx/html/index.html
exec "$@"
```

- [ ] **Step 6: Commit** — `git add crm/package.json crm/vite.config.js crm/Dockerfile crm/nginx.conf crm/docker-entrypoint.sh && git commit -m "feat(crm): scaffold standalone crm/ app build tooling"`
(Build is exercised in R4 once `src/` exists.)

---

### Task R3: Design system + app shell + component styles ("Sales Operations Console")

**REQUIRED SUB-SKILL:** the implementer MUST invoke `frontend-design:frontend-design` and follow it. This is a design-led task, not a style-copy. Build a distinctive, brand-true dark **security-ops console**, not a ported admin table.

**Files:** Create `crm/src/index.html`, `crm/src/css/crm.css`, copy `admin/src/images/logo.png` → `crm/src/images/logo.png`, and self-host the two webfonts under `crm/src/fonts/` (do NOT hotlink Google Fonts — the site self-hosts; reuse the woff2 files already in `frontend/public/fonts/` if present, else `admin`'s).

**Design tokens (define once at the top of `crm.css` as CSS custom properties; every color/space value derives from these — no ad-hoc hexes):**
```
--ink:#0B0F14  --surface:#131A22  --surface-2:#1B242E  --line:#26313D
--text:#E6EDF3  --muted:#8A97A6
--brand:#24D758 (Underwings green — PRIMARY ACTIONS + WON only, used with restraint)
--services:#24D758  --software:#38BDF8 (the two motions read apart at a glance)
--warn:#F5A623 (stale/attention)  --danger:#F2555A (lost)
--radius:10px  --radius-sm:6px
Type: UI/body = Inter (self-hosted); DATA VOICE = "Geist Mono" — every number, AED value,
score, stage tag, date, metric uses mono with `font-variant-numeric: tabular-nums`.
Compact scale (13px base). Motion: 120–200ms ease; respect `prefers-reduced-motion`.
```

**Interfaces:** Produces the branded login + MFA screens, the app shell, and ALL component styles + the markup IDs R4 drives: app shell (`#app`, header with `#crm-user`/`#crm-logout`, view nav `[data-crm-view="pipeline|prospects|reports"]`), pipeline strip (`#crm-pipeline-strip`), deals board (`#crm-board` — kanban columns container; `#crm-view-toggle` kanban/list), `#crm-search`, `#crm-new-deal-btn`, `#crm-export-btn`, drawer (`#crm-drawer`,`#crm-drawer-body`,`[data-crm-close]`), prospects feed (`#crm-prospects`), reports (`#crm-scoreboard`,`#crm-chart-pipeline`), new-deal modal (`#crm-newdeal-modal` + `nd-*` inputs), a toast host (`#crm-toasts`), plus login (`#login-*`)/MFA (`#mfa-*`) ids matching `admin/src/js/admin.js`'s auth code.

- [ ] **Step 1: Invoke `frontend-design` and design against these tokens.** Produce the token block, then the component specs below. Keep boldness in the two signatures; everything else quiet.

- [ ] **Step 2: Build `crm/src/index.html`** — the `window.SUPABASE_*` head injection + `<script type="module" src="/js/crm.js">`; a **branded login screen** (Underwings mark, "Sales Operations Console" wordmark, email/password, error slot `#login-error`) and MFA enroll/verify screens (ids matching the auth code); then the app shell: a slim top bar (mark + `Pipeline / Prospects / Reports` view switch + user menu/logout) and three view containers — `#crm-board` (+ `#crm-pipeline-strip` above it), `#crm-prospects`, `#crm-reports` (`#crm-scoreboard` + `#crm-chart-pipeline`) — plus `#crm-drawer`, `#crm-newdeal-modal`, and `#crm-toasts`. No CMS anything.

- [ ] **Step 3: Component styles in `crm.css`** (all from tokens):
  - **Pipeline strip:** connected horizontal segments (one per stage), each showing stage name + count + AED (mono); a thin value bar; active/hover state; services vs software tint. This is signature #1 — make it read like a signal chain, not a generic stat row.
  - **Kanban:** horizontally-scrollable columns (one per stage) with a count/value header; **deal cards** = title, company (muted), AED value (mono, prominent), owner initials chip, a `next-action` chip; **stale** cards get a `--warn` left edge + a "⏳ 34d" mono chip; won/lost muted. `.crm-card--dragging`/`.crm-col--dropzone` states for drag-drop. A **list/table fallback** style for narrow screens.
  - **Drawer:** right-slide panel; header (deal title, company · contact · wa.me, signal badges); **stage stepper** (clickable horizontal steps for the motion's stages, current highlighted); editable fields; **activity timeline** as a feed with per-type icon + timestamp; quick-add row. Style the close affordance (fixes the A5 `.lead-drawer-x` gap).
  - **Intel feed (prospects):** signal cards — company + domain (mono), an `ai_score` and `gap_score` **meter** (small bar, `--warn`→`--brand`), `talking_points` as the body, a **Promote** primary button; promoted → muted with a ✓.
  - **Reports:** stat tiles (big mono number, target-vs-actual, small delta), chart wrapper.
  - **Toasts** (`#crm-toasts`): stacked, auto-dismiss, `--brand` success / `--danger` error. **Skeletons** (shimmer rows/cards for loading). **Empty states** (icon + one line of direction + a primary action).
  - Buttons (`.btn`,`.btn-primary`=brand,`.btn-ghost`), inputs, chips, pills (stage pills tinted by stage group). Visible `:focus-visible` ring. Fully responsive to ~360px (top bar collapses, kanban → single-column list, drawer → full-screen sheet).

- [ ] **Step 4: Commit** — `git add crm/src/index.html crm/src/css/crm.css crm/src/fonts crm/src/images && git commit -m "feat(crm): sales-ops-console design system, shell, login + component styles"`

---

### Task R4: CRM app logic (`crm/src/js/crm.js`) — auth gate + data layer + console UX

**Files:** Create `crm/src/js/crm.js`

**Approach:** REUSE the Phase A **data/query layer verbatim** (the Supabase queries in `admin/src/js/admin.js`'s CRM section — deals board query with `crm_companies!company_id(...)`, stage/search filters, prospects query, promote logic, scoreboard view reads, upserts, CSV export, the `escAttr` XSS discipline). BUILD A NEW **presentation layer** per R3's design system: kanban render, pipeline strip, intel feed, drawer with stepper, toasts, empty/loading states. Same data in, better UX out.

**Interfaces:** Consumes `window.SUPABASE_*`, R3 markup, `crm_users` (R1). Produces the running console.

- [ ] **Step 1: Client + utils** — `createClient(window.SUPABASE_URL || location.origin, window.SUPABASE_ANON_KEY)`; port `esc`/`escAttr`/`formatDate`; add `toast(msg, kind)` (renders into `#crm-toasts`, auto-dismiss) and `money(n)` (`AED ` + `Number(n).toLocaleString()` or `—`).

- [ ] **Step 2: Auth gate + mandatory MFA** (port admin.js ~167–394 login/MFA-enroll/verify), then:
```js
async function afterAuthed() {
  const { data: me } = await supabase.from('crm_users').select('role').maybeSingle();
  if (!me) { await supabase.auth.signOut(); showLoginError("This account doesn't have CRM access. Ask an admin to add you."); return; }
  window.__crmRole = me.role;
  const { data: f } = await supabase.auth.mfa.listFactors();
  if (!f?.totp?.length) { showMfaEnroll(); return; }          // enrollment mandatory
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== 'aal2') { showMfaVerify(); return; }
  showApp(); crmBoot();
}
```
`checkAuth()` on load routes to login vs `afterAuthed()`. Errors/empties speak in the interface's voice (active, specific), never `alert()`.

- [ ] **Step 3: View router + data loads (reuse Phase A queries).** `crmBoot()` wires the top-bar view switch (`[data-crm-view]` → Pipeline / Prospects / Reports), search, new-deal, export, and drawer close. Keep `crmState` (motion, search, `_openId`) and `CRM_STAGES`. Load functions reuse the exact Phase A Supabase queries but render the new components:
  - `crmLoadBoard()` — the Phase A deals query (`.select('*, crm_companies!company_id(name,domain), crm_contacts(name,email,phone,whatsapp_ok)')`, motion + search filters; drop pagination for kanban, `.limit(500)` which covers the volume), then `crmRenderStrip(deals)` + `crmRenderKanban(deals)`. Show a **skeleton** while loading and an **empty state** when zero.
  - `crmLoadProspects()` — the Phase A prospects query → `crmRenderIntel(...)`.
  - `crmLoadReports()` — the Phase A scoreboard/pipeline/stale/renewal reads (with the `count`-based reads) → tiles + `crmRenderPipelineChart` (Chart.js, dark-themed to the tokens).

- [ ] **Step 4: Presentation (new).**
  - `crmRenderStrip(deals)` — group by stage in `CRM_STAGES[motion]` order; each segment shows stage label + count + summed AED (mono); click a segment → filter the board to that stage (toggle). Signature #1.
  - `crmRenderKanban(deals)` — one column per stage (canonical `CRM_STAGES` order, NOT first-seen), column header = count + AED; deal cards (title, company muted, `money(value_aed)`, owner initials, next-action chip); **stale** flag (services >30d / software >21d since `updated_at`) → amber edge + `⏳ Nd` chip. **Drag-drop:** HTML5 DnD; on drop into another column, `supabase.from('crm_deals').update({stage:newStage}).eq('id',id)` then `toast('Moved to '+newStage)` + reload (the DB trigger logs the stage change). Card click → `crmOpenDrawer(id)`. Provide a compact **list fallback** toggle (`#crm-view-toggle`) and auto-list on ≤600px.
  - `crmOpenDrawer(id)` — reuse the Phase A drawer data (deal + activities + `v_crm_contact_signals`); render the **stage stepper** (click a step → update stage, toast, reload), editable fields (value/next-action/next-action-date/lost-reason via `escAttr`), and the **activity timeline** feed + quick-add. `crmSaveDeal`/`crmAddActivity` logic reused from Phase A (no manual stage_change insert).
  - `crmRenderIntel(prospects)` — signal cards with ai/gap meters + talking points + **Promote** (reuse Phase A `crmPromoteProspect` → `toast('Promoted to pipeline')`).
  - `crmNewDeal`/`crmUpsertCompany`/`crmUpsertContact`/`crmExport` — reuse Phase A logic; swap `alert()` → `toast()`.

- [ ] **Step 5: Role-aware + a11y.** Members: hide any destructive affordance (delete) — none exist in v1, but the drawer/promote all work; note RLS enforces delete=admin server-side. Ensure keyboard operability (drawer Esc-closes, focus-visible), and honor `prefers-reduced-motion` (disable card stagger/drawer slide).

- [ ] **Step 6: Build to verify it compiles** — `docker build -t crm-test ./crm` (or `docker compose build crm` after R5). Confirm Vite build clean; bundle contains `crmBoot`/`crmRenderKanban`/`afterAuthed`.

- [ ] **Step 7: Commit** — `git add crm/src/js/crm.js && git commit -m "feat(crm): console UX — auth gate, kanban pipeline, intel feed, drawer, toasts"`

---

### Task R5: Wire it up — compose service + nginx `crm.underwings.org` vhost

**Files:** Modify `docker-compose.yml`, `nginx/nginx.conf`

- [ ] **Step 1: Add the `crm` service** to `docker-compose.yml` (mirror the `admin` service, but SUPABASE_URL is the public same-origin host):
```yaml
  crm:
    build: ./crm
    container_name: underwings-crm
    environment:
      - SUPABASE_URL=https://crm.underwings.org
      - SUPABASE_ANON_KEY=${ANON_KEY}
    restart: always
    networks:
      - underwings-network
```

- [ ] **Step 2: Add upstream + replace the redirect vhost** in `nginx/nginx.conf`. Add near the other upstreams: `upstream crm { server crm:5173; }`. Replace the current `crm.underwings.org` redirect server blocks (the ones added in Phase A Task A4) with:
```nginx
    server {
        listen 80;
        server_name crm.underwings.org;
        location /.well-known/acme-challenge/ { root /var/www/certbot; }
        location / { return 301 https://crm.underwings.org$request_uri; }
    }
    server {
        listen 443 ssl;
        http2 on;
        server_name crm.underwings.org;
        ssl_certificate     /etc/letsencrypt/live/crm.underwings.org/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/crm.underwings.org/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        client_max_body_size 20m;

        # Supabase (same-origin) — mirror the main-vhost kong proxies
        location /auth/     { proxy_pass http://kong/auth/;     proxy_set_header Host $host; proxy_http_version 1.1; }
        location /rest/     { proxy_pass http://kong/rest/;     proxy_set_header Host $host; proxy_http_version 1.1; }
        location /storage/  { proxy_pass http://kong/storage/;  proxy_set_header Host $host; proxy_http_version 1.1; }
        location /realtime/ { proxy_pass http://kong/realtime/; proxy_set_header Host $host; proxy_http_version 1.1;
                              proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 86400; }

        # CRM SPA
        location / {
            proxy_pass http://crm;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }
```

- [ ] **Step 3: Build + bring up + validate**
```bash
docker compose build crm && docker compose up -d crm
docker compose build nginx && docker compose up -d nginx
docker compose exec -T nginx nginx -t
```
Expected: nginx test successful; both containers healthy.

- [ ] **Step 4: Smoke-test same-origin routing** (auth endpoint reachable through the crm vhost):
```bash
docker compose exec -T nginx sh -c "wget -qO- -S --header='Host: crm.underwings.org' http://127.0.0.1/auth/v1/health 2>&1 | grep -i 'HTTP/' | head -1"
docker compose exec -T nginx sh -c "wget -qO- -S --header='Host: crm.underwings.org' http://127.0.0.1/ 2>&1 | grep -i 'HTTP/' | head -1"
```
Expected: `/auth/v1/health` → 200; `/` → 200 (the SPA).

- [ ] **Step 5: Commit** — `git add docker-compose.yml nginx/nginx.conf && git commit -m "feat(crm): crm.underwings.org serves standalone app + same-origin Supabase"`

---

### Task R6: Remove the CRM from `/admin` (revert Phase A UI into CMS)

**Files:** Modify `admin/src/index.html`, `admin/src/js/admin.js`, `admin/src/css/admin.css`

**Interfaces:** `/admin` returns to CMS-only. The CRM now lives solely in `crm/`.

- [ ] **Step 1: Remove from `admin/src/index.html`** — the `<a data-page="crm">` sidebar item, the `#page-crm` block, the `#crm-drawer`, and the `#crm-newdeal-modal` (all added in Phase A A5/A8).
- [ ] **Step 2: Remove from `admin/src/js/admin.js`** — the `case 'crm': loadCrm(); break;` in `navigateTo`, and the entire CRM module (everything from `// CRM MODULE`/`loadCrm` through `crmExport`, incl. `CRM_TABS`, `crmState`, all `crm*` functions and the `crmWireNewDeal()` call inside `crmInit`… note: `crmInit` here is the CRM one — remove the whole block). Remove the `escAttr` helper only if it is now unused in admin.js (grep to confirm; it was added solely for the CRM drawer).
- [ ] **Step 3: Remove from `admin/src/css/admin.css`** — the `/* CRM */` block appended in Phase A A5.
- [ ] **Step 4: Build + verify CMS still works, CRM gone**
```bash
docker compose build admin && docker compose up -d admin
docker exec underwings-admin sh -c "grep -c 'page-crm' /usr/share/nginx/html/index.html || true"   # expect 0
```
Expected: build clean; `page-crm` count 0; the other CMS pages (posts/partners/careers/media/analytics/leads/clients) untouched.
- [ ] **Step 5: Commit** — `git add admin/src/index.html admin/src/js/admin.js admin/src/css/admin.css && git commit -m "refactor(admin): remove CRM from CMS admin (moved to standalone crm app)"`

---

### Task R7: `provision-crm-user.sh` + provision the team

**Files:** Create `scripts/provision-crm-user.sh`

**Interfaces:** Creates a GoTrue user (or updates password) and upserts `crm_users(id, role)`.

- [ ] **Step 1: Write `scripts/provision-crm-user.sh`** modeled on `scripts/provision-admin.sh` — read `CRM_EMAIL`, `CRM_PASSWORD`, `CRM_ROLE` (default `member`), `SERVICE_ROLE_KEY`, `POSTGRES_*` from `.env`/env; create/confirm the auth user via the GoTrue admin API (`http://localhost:8000/auth/v1/admin/users`, `email_confirm:true`); then:
```bash
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" underwings-db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "INSERT INTO public.crm_users (id, role) VALUES ('$USER_ID', '${CRM_ROLE:-member}') ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role;"
```
- [ ] **Step 2: Provision the team** (once Manoj supplies emails + temp passwords):
```bash
CRM_EMAIL="manoj@underwings.org"  CRM_ROLE=admin  CRM_PASSWORD="<temp>" bash scripts/provision-crm-user.sh
CRM_EMAIL="guna@underwings.org"   CRM_ROLE=member CRM_PASSWORD="<temp>" bash scripts/provision-crm-user.sh
CRM_EMAIL="nelson@underwings.org" CRM_ROLE=member CRM_PASSWORD="<temp>" bash scripts/provision-crm-user.sh
CRM_EMAIL="vinoth@underwings.org" CRM_ROLE=member CRM_PASSWORD="<temp>" bash scripts/provision-crm-user.sh
```
- [ ] **Step 3: Verify** — `docker exec -i underwings-db psql -U postgres -d underwings -c "SELECT u.email, c.role FROM crm_users c JOIN auth.users u ON u.id=c.id ORDER BY c.role;"` → the 4 users with correct roles.
- [ ] **Step 4: Commit** — `git add scripts/provision-crm-user.sh && git commit -m "feat(crm): provision-crm-user script"`

---

## Post-rework
- End-to-end: log into `https://crm.underwings.org` as a provisioned user → MFA → board loads with deals; a non-`crm_users` account is rejected.
- `/admin` shows no CRM; CMS intact.
- Whole-branch review over the rework range; then Phases B & C (unchanged — they write via service-role).
- Update memory [[project-crm-status]].
