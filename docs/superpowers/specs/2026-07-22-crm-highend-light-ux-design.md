# Underwings CRM — High-End Light UI/UX Refinement Spec

**Date:** 2026-07-22
**Status:** Approved direction (visual preview signed off) — ready for implementation planning
**Scope:** Re-skin + polish the existing standalone CRM (`crm/`) to a high-end, **light-default** product (dark available via toggle), matching the approved preview. Same information architecture and features; elevated visual + interaction quality, plus deal ownership and a command palette.

## 1. Context
The standalone CRM (`crm.underwings.org`, dir `crm/`) shipped as a dark "security-ops console." The founder wants a **light** theme and overall **high-end CRM** polish (Attio/Linear/Folk tier). Approved visual direction: the preview at `docs/superpowers/specs/` companion (published artifact). Structure stays — pipeline kanban, signal-chain strip, prospects intel feed, deal drawer, reports. Files touched: `crm/src/css/crm.css`, `crm/src/js/crm.js`, `crm/src/index.html`, plus one migration for an owner-picker view.

## 2. Design system (light default + dark toggle)
Token-driven. `:root` = **light** (default). `:root[data-theme="dark"]` = dark. A toggle in the top bar flips + persists to `localStorage['crmTheme']` (default `light`); on load, apply the stored theme before first paint. The Chart.js pipeline chart reads CSS custom properties, so it **re-renders on theme switch**. `prefers-reduced-motion` respected. All values below are custom properties; **no component styles ad-hoc hexes.**

**Light palette (cool paper, faint green bias, chosen neutrals):**
`--bg:#F2F5F4 · --surface:#FFFFFF · --surface-2:#EBF0EE · --surface-3:#F6F9F8 · --line:#DCE4E1 · --line-soft:#E7ECEA · --text:#12201B · --muted:#5D6B65 · --faint:#8A968F · --brand:#12924A (deep emerald: primary + won) · --brand-bright:#24D758 (small accents) · --brand-tint:#E5F6EC · --software:#2563EB / --software-tint:#E7EEFD · --warn:#B26A00 / --warn-tint:#FBEEDA · --danger:#D32B39 / --danger-tint:#FBE6E8`. Elevation via soft shadows (`rgba(16,32,24,.05–.16)`), not glows.

**Dark palette** keeps the current R3 values (ink `#0B0F14` base, brighter accents) under `[data-theme="dark"]`, re-tuned so contrast holds.

**Type:** Geist (UI, self-hosted) + **Geist Mono** as the data voice — every number, AED value, score, stage tag, date uses mono with `tabular-nums`. Compact ~13.5px base. Type scale + weights per the preview.

## 3. Component quality bar (match the preview)
- **Top bar:** brand mark + wordmark, Pipeline/Prospects/Reports nav, search field with `⌘K` hint, primary "New deal", **theme toggle** (sun/moon), user avatar.
- **Signal-chain strip:** chevron segments, mono count + AED, value bar, active/hover; the board's summary line (open count · AED · quarter coverage).
- **Kanban:** columns with count+AED headers; cards = title, company (muted), **AED (mono, prominent)**, **owner avatar (initials)**, next-action chip, motion tag; stale = amber left-edge + `⏳ Nd` chip; hover lift + focus ring; drag-drop drop-zone states retained.
- **Drawer:** eyebrow (motion·stage), title, company·contact·WhatsApp + signal badges, **stage stepper**, inline field grid, **activity timeline** with per-type icons, quick-add.
- **Intel feed:** prospect cards with ICP-fit + gap-score **meters** and talking-points list, Promote action.
- **Reports:** stat tiles (mono numbers, target-vs-actual) + mini pipeline chart (Chart.js, theme-aware).
- **States:** crafted empty states (direction + primary action), skeleton loaders, toast notifications (already present) restyled; visible `:focus-visible`; responsive to ~360px (top bar wraps, kanban → single column / list, drawer → full-screen sheet).

## 4. Deal ownership (fixes the blank owner chip)
Deals get an assignable **owner** (a CRM user).
- **Migration:** a `v_crm_members` view = `crm_users ⋈ auth.users` exposing `id, email, role` (+ a derived display label), `security_invoker=true`, readable by any `crm_user` (so the app can populate an owner picker and resolve owner display). Do **not** expose password/token columns — select only id/email/role.
- **Board/drawer queries:** resolve the owner for display (join/lookup by `owner_id`) → render initials avatar + name. `owner_id` FK already points at `auth.users` (fixed in migration 008).
- **UI:** an owner picker (select of CRM members) in the deal drawer and the new-deal modal; sets `crm_deals.owner_id`. New deals default owner = the current user.

## 5. Command palette (⌘K)
A keyboard-first launcher (signature high-end feature), scoped for a small team.
- Open with `⌘K`/`Ctrl+K` (and a click on the search field); `Esc` closes; arrow keys + Enter navigate.
- **Search:** across currently-loaded deals + prospects (title/company/domain) — client-side filter, no new backend. Selecting a deal opens its drawer; a prospect switches to Prospects and highlights it.
- **Actions:** New deal, Go to Pipeline/Prospects/Reports, Log activity on the open deal, Toggle theme.
- Rendered in the app's design system (see preview). Reduced-motion respected.

## 6. Explicitly EXCLUDED (YAGNI)
Saved/custom views, bulk edit, custom fields UI, per-user dashboards, drag-reorder within a column, email/calendar integration, mobile app, dark-mode auto from OS at the *expense* of the light default (light stays the default; dark is opt-in via toggle — OS `prefers-color-scheme` may inform first-visit default but the toggle always wins and persists). No new external dependencies (vanilla JS + existing Chart.js only).

## 7. Build order (for the plan)
1. **Migration** `009_crm_members_view.sql` — `v_crm_members` (owner picker/display source).
2. **Theme + design system** — re-skin `crm.css` to the light-default palette + dark toggle; toggle control in `index.html`; theme init/persist + chart re-render + theme-aware chart colors in `crm.js`. Match the preview's component quality bar.
3. **Deal ownership** — owner join in board/drawer queries + owner avatar rendering; owner picker in drawer + new-deal modal (from `v_crm_members`); default new-deal owner = current user.
4. **Command palette (⌘K)** — launcher modal + keyboard + client-side search over loaded deals/prospects + quick actions.

Each step ends in a clean `docker build crm` and is independently reviewable; the app is re-deployed and the founder reviews live after step 2 (the core re-skin) and again at the end.
