# CRM — collapse the lead tabs into a "Leads" dropdown

**Date:** 2026-08-13
**Scope:** `crm/src/index.html`, `crm/src/css/crm.css`, `crm/src/js/crm.js` — front end only.
No migrations, no grant changes, no new tables.

## Problem

The top bar carries six flat tabs: Pipeline, LeadGen, Partners, BLead, Web Leads,
Reports. Four of those are lead sources that differ only in provenance, so the bar
reads as a wall of similar-weight choices and the two genuinely different views
(Pipeline, Reports) get lost among them. On narrow screens the six buttons are
squeezed to `flex:1` each and the labels crowd.

## Design

### Nav shape

LeadGen / Partners / BLead / Web Leads collapse into a single `.viewnav-menu`
element: a trigger button plus a `<ul role="menu">`. Pipeline and Reports stay as
plain `.viewnav-btn`s.

```
▚ Pipeline   ◇ Leads ▾   ▟ Reports
                │
                ├ ◇ LeadGen     1,204
                ├ ⋈ Partners       88
                ├ ▤ BLead       6,474
                └ ◈ Web Leads      35
```

The trigger reads `◇ Leads ▾` when no lead view is active and
`◇ Leads · BLead ▾` when one is, so the bar never loses track of location. It
carries `is-active` whenever any of the four views is showing.

### Wiring

Menu items keep their existing `data-crm-view` attributes, so the delegated
handler on `.viewnav` (crm.js:405) already routes them — it gains only a
"close the menu" line.

`crmSwitchView` currently syncs `.viewnav-btn` elements alone. It gains a second
pass, `crmSyncLeadsMenu(view)`, which marks the active `menuitem`, sets
`aria-current="page"` on it, toggles `is-active` on the trigger, and rewrites the
trigger label. Everything downstream — `LG_VIEW_KIND`, the space-separated panel
matcher, the command palette's "Go to …" entries — is untouched.

### Counts

Every number means the same thing: **rows still worth acting on.**

- LeadGen / Partners / BLead — one query. `v_crm_leadgen_stats` already returns a
  row per kind (migration 014), so `select('kind,total,by_status')` with no `.eq`
  filter returns all three in a single round trip. Open count =
  `total - (by_status.disqualified ?? 0)`; the view already excludes `suppressed`.
  That is exactly the "All open" default in `crmLeadgenQuery`
  (`status not in (suppressed, disqualified)`).
- Web Leads — two head-counts (`count: 'exact', head: true`) on `form_submissions`
  and `subscribers`, each filtered to `lead_status` not `closed` (NULL counts as
  open, so the filter is `or(lead_status.neq.closed,lead_status.is.null)`).
  Summed, matching how the view merges both tables client-side.

Fetched on boot, refreshed when the menu opens (throttled to 30s) and after a
successful Promote. A failed count query is non-fatal: the menu renders with
labels and no numbers, and logs a warning. Counts never gate opening the menu.

### Keyboard and a11y

`aria-haspopup="menu"` and `aria-expanded` on the trigger; `role="menu"` on the
list, `role="menuitem"` on the items, `aria-current="page"` on the active one.
Opens on click; closes on Escape, outside click, or selection. Escape returns
focus to the trigger. ArrowDown/ArrowUp move between items and wrap, Home/End
jump to the ends, Enter/Space activate.

The app-level Escape handler (crm.js:459) runs modal → drawer. The menu's own
Escape listener stops propagation while it is open so closing the menu never also
closes a drawer behind it.

### Mobile

The `max-width:820px` block stretches `.viewnav` full width with `flex:1`
children; `.viewnav-menu` joins them, so the trigger takes an equal share of the
row. The panel then drops to `left:0; right:0` — it spans its trigger's full
width instead of a fixed `min-width` card, which keeps it anchored to what
opened it and stops it overhanging the viewport.

### Also folded in

The command palette has "Go to" entries for Pipeline, LeadGen, Partners, BLead and
Reports but is **missing Web Leads** (crm.js:2063-2068). Added, with the `◈` icon
the nav already uses for it.

## Non-goals

- No change to what any view queries, renders, or writes.
- No change to RLS, column grants, or `LG_VIEW_KIND`.
- The LeadGen row controls stay as they are — ticks, not a dropdown
  (migration 016; the per-row status `<select>` is deliberately gone).

## Verification

- Structural: nav has exactly three top-level children; all four lead views
  reachable via the menu; panel matcher still resolves the shared
  `leadgen partners blead` panel.
- `node --check` on a `.mjs` copy (a plain `.js` ESM file is rubber-stamped).
- Headless Chrome screenshots — menu closed, menu open, active-child label, and
  the 820px mobile layout.

## Deploy

`docker compose build crm && docker compose up -d crm`, then
`docker restart underwings-nginx` — recreating the container changes its IP and
nginx caches the old one.
