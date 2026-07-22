# CRM High-End Light UI/UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Re-skin + polish the standalone CRM (`crm/`) to a high-end **light-default** product (dark via persisted toggle) matching the approved preview, and add deal ownership + a ⌘K command palette.

**Architecture:** Token-driven CSS theming (light `:root`, dark `:root[data-theme="dark"]`, JS toggle persisted to localStorage). Deal ownership via a `crm_members()` RPC (owner picker + avatars). Command palette = vanilla-JS launcher over already-loaded data. No new deps.

**Spec:** `docs/superpowers/specs/2026-07-22-crm-highend-light-ux-design.md`. **Visual target:** `docs/superpowers/specs/2026-07-22-crm-highend-light-preview.html` (the approved preview — the CSS/markup there is the reference).

## Global Constraints
- Files: `crm/src/css/crm.css`, `crm/src/js/crm.js`, `crm/src/index.html`, and `supabase/migrations/009_crm_members.sql`. Do NOT touch `admin/` or the frontend.
- **Light is the default.** `:root` = light palette; `:root[data-theme="dark"]` = dark. Toggle persists to `localStorage['crmTheme']` (default `light`); applied before first paint (no flash). Toggle always wins over OS.
- Every color/space derives from `:root` custom properties — no ad-hoc hexes in component rules (a few `rgba()` shadows OK).
- Type: Geist (UI) + Geist Mono (data voice, `tabular-nums`). Self-hosted (already in `crm/src/fonts/`), no CDN.
- Keep the existing element IDs/JS behavior working (auth gate + MFA, kanban drag-drop → stage update, drawer, prospects promote, reports, toasts, CSV export). XSS discipline: `esc()` for text, `escAttr()` for double-quoted attributes on all DB/OSINT free-text.
- `prefers-reduced-motion` respected; visible `:focus-visible`; responsive to ~360px.
- Each task: commit only its files; the working tree has unrelated pending changes — never stage them. Verify with `docker build -t crm-verify ./crm` (clean Vite build) each task; re-deploy (`docker compose build crm && docker compose up -d crm`) after Task 2 and Task 4 for live review.

---

### Task 1: Migration 009 — `crm_members()` roster RPC (owner picker source)

**Files:** Create `supabase/migrations/009_crm_members.sql`

**Interfaces:** Produces `public.crm_members()` → `TABLE(id uuid, email text, role text)`. The app calls `supabase.rpc('crm_members')` to populate the owner picker + resolve owner display. Later tasks (3) consume it.

**Why a function, not a view:** `auth.users` is not SELECTable by the `authenticated` role, so a `security_invoker` view can't read it. A `SECURITY DEFINER` function reads it as owner, and gates on `is_crm_user()` so only CRM members get the roster.

- [ ] **Step 1: Write the migration** (idempotent):
```sql
-- ===========================================
-- MIGRATION 009: crm_members() — roster of CRM users (id,email,role) for the
-- owner picker + owner-avatar display. SECURITY DEFINER (reads auth.users),
-- gated on is_crm_user() so only CRM members can enumerate the team.
-- ===========================================
CREATE OR REPLACE FUNCTION public.crm_members()
RETURNS TABLE (id UUID, email TEXT, role TEXT)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_crm_user() THEN RETURN; END IF;
  RETURN QUERY
    SELECT c.id, u.email::text, c.role
    FROM public.crm_users c
    JOIN auth.users u ON u.id = c.id
    ORDER BY c.role, u.email;
END;
$$;
REVOKE ALL ON FUNCTION public.crm_members() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crm_members() TO anon, authenticated;
```
(Execute is granted broadly but the body returns nothing unless `is_crm_user()` — and that requires an authenticated CRM-member session.)

- [ ] **Step 2: Validate + apply + reload PostgREST**
```bash
{ echo "BEGIN;"; cat supabase/migrations/009_crm_members.sql; echo "ROLLBACK;"; } | docker exec -i underwings-db psql -U postgres -d underwings -v ON_ERROR_STOP=1
cat supabase/migrations/009_crm_members.sql | docker exec -i underwings-db psql -U postgres -d underwings -v ON_ERROR_STOP=1
docker exec -i underwings-db psql -U postgres -d underwings -c "NOTIFY pgrst, 'reload schema';"
```
- [ ] **Step 3: Verify** — as postgres, the function returns rows (bypasses the is_crm_user gate only if run in a session where auth.uid() is a member; from psql auth.uid() is NULL so it returns 0 rows — that's expected. Instead verify it EXISTS and is SECURITY DEFINER):
```bash
docker exec -i underwings-db psql -U postgres -d underwings -c "SELECT proname, prosecdef FROM pg_proc WHERE proname='crm_members';"
```
Expected: `crm_members | t`.
- [ ] **Step 4: Commit** — `git add supabase/migrations/009_crm_members.sql && git commit -m "feat(crm): crm_members() RPC — CRM roster for owner picker"`

---

### Task 2: Theme + design-system re-skin (the core)

**REQUIRED SUB-SKILL:** invoke `frontend-design:frontend-design`. **Match the approved preview** `docs/superpowers/specs/2026-07-22-crm-highend-light-preview.html` — its palette, type, spacing, shadows, and component treatments are the target. This is the founder-signed-off look.

**Files:** Modify `crm/src/css/crm.css`, `crm/src/index.html`, `crm/src/js/crm.js`.

**Interfaces:** Produces the light-default themed app + a working persisted theme toggle. IDs/behavior preserved.

- [ ] **Step 1: Read the preview + current files.** Read the preview HTML (target look) and the current `crm/src/index.html`/`crm.css`/`crm.js` (real markup/classes to re-skin). Map the preview's component styles onto the real class names.

- [ ] **Step 2: Restructure tokens in `crm.css`.** Put the **light palette** (spec §2 values) on `:root` as the default; move/retune the current dark values under `:root[data-theme="dark"]`. Define both fully (bg/surface/surface-2/surface-3/line/line-soft/text/muted/faint/brand/brand-bright/brand-tint/software(+tint)/warn(+tint)/danger(+tint)/shadows/radius/ring). Optionally set a first-visit default from `@media (prefers-color-scheme: dark)` — but the JS toggle + localStorage always win.

- [ ] **Step 3: Re-skin components** to the preview quality bar (spec §3): top bar, signal-chain strip, kanban columns/cards (incl. owner-avatar slot, stale amber edge, motion tags, hover lift), drawer (stepper, field grid, activity feed), intel cards (score meters, talking points), report tiles + mini chart, buttons/inputs/chips/pills/badges, skeletons, empty states, toasts, `:focus-visible`, responsive ≤360px. Everything from tokens.

- [ ] **Step 4: Theme toggle** — add a sun/moon toggle button to the top bar in `index.html`; in `crm.js`: on load, `document.documentElement.dataset.theme = localStorage.getItem('crmTheme') || 'light'` (do this as early as possible to avoid flash); a handler flips it, persists, swaps the icon, and **re-renders the pipeline chart** (so its colors update — read theme colors via the existing `cssVar()`). Ensure `crmRenderPipelineChart` pulls grid/label/series colors from CSS vars.

- [ ] **Step 5: Verify + deploy for review.**
```bash
docker build -t crm-verify ./crm    # clean Vite build
docker compose build crm && docker compose up -d crm
```
Confirm build clean. (Founder reviews `https://crm.underwings.org` live — light default, toggle → dark, both legible.)

- [ ] **Step 6: Commit** — `git add crm/src/css/crm.css crm/src/index.html crm/src/js/crm.js && git commit -m "feat(crm): high-end light theme + dark toggle, design-system re-skin"`

---

### Task 3: Deal ownership — picker + avatars

**Files:** Modify `crm/src/js/crm.js` (+ `crm/src/index.html` if the new-deal modal needs an owner `<select>`).

**Interfaces:** Consumes `crm_members()` (Task 1) and the themed avatar styles (Task 2). Sets `crm_deals.owner_id`.

- [ ] **Step 1: Load the roster once** — after `afterAuthed`, `const { data: members } = await supabase.rpc('crm_members')`; cache it (`window.__crmMembers`); build an `ownerById` map (id → {email, role, initials}). Initials = first letters of the email local-part or a name split.

- [ ] **Step 2: Render owner avatars** — on kanban cards and in the drawer header, show the deal's owner initials avatar (from `ownerById[deal.owner_id]`); tooltip = email. Blank/placeholder if unassigned.

- [ ] **Step 3: Owner picker** — in the deal drawer, an owner `<select>` (options from `members`) that on change does `supabase.from('crm_deals').update({ owner_id }).eq('id', dealId)` → toast + refresh. In the new-deal modal, an owner select defaulting to the current user; include `owner_id` in the insert.

- [ ] **Step 4: Verify** — build clean; seed/assign an owner to a deal via the UI (or SQL) and confirm the avatar renders + the update persists:
```bash
docker build -t crm-verify ./crm
```
- [ ] **Step 5: Commit** — `git add crm/src/js/crm.js crm/src/index.html && git commit -m "feat(crm): deal ownership — owner picker + avatars"`

---

### Task 4: Command palette (⌘K)

**Files:** Modify `crm/src/index.html` (palette markup), `crm/src/js/crm.js` (logic), `crm/src/css/crm.css` (styles — from tokens, per preview `.cmdk*`).

**Interfaces:** Client-side only; searches already-loaded deals/prospects and fires existing actions.

- [ ] **Step 1: Markup + styles** — a `#crm-cmdk` overlay (input + results list) styled per the preview's `.cmdk` components (both themes). Hidden by default.
- [ ] **Step 2: Open/close + keyboard** — `⌘K`/`Ctrl+K` (and clicking the top-bar search) opens it and focuses the input; `Esc` closes; `↑/↓` move selection; `Enter` activates. Trap focus; restore focus on close; reduced-motion respected.
- [ ] **Step 3: Search + actions** — filter currently-loaded deals (title/company) and prospects (company_name/domain) as the user types (`esc()` all rendered text). Selecting a deal → `crmOpenDrawer(id)`; a prospect → switch to Prospects view + scroll/highlight it. Static actions: New deal, Go to Pipeline/Prospects/Reports, Log activity on open deal, Toggle theme.
- [ ] **Step 4: Verify + deploy** — `docker build -t crm-verify ./crm`; `docker compose build crm && docker compose up -d crm`. Confirm build clean; ⌘K opens, searches, navigates.
- [ ] **Step 5: Commit** — `git add crm/src/index.html crm/src/js/crm.js crm/src/css/crm.css && git commit -m "feat(crm): ⌘K command palette"`

---

## Post-implementation
- Final whole-branch review over the range (theme correctness both modes, RPC security, XSS, no behavior regressions in auth/drag-drop/promote).
- Founder live review at `https://crm.underwings.org`; iterate on feedback.
- Update memory [[project-crm-status]] (light theme + ownership + ⌘K shipped).
