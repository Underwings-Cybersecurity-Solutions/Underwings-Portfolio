# Frappe CRM — Mapping Reference for Automations (replaces krayin-ids-reference.md)

**Generated:** 2026-06 · **Site:** https://crm.underwings.org · **Apps:** frappe 16, crm 1.75, helpdesk 1.26
**API:** Frappe REST API IS available — `/api/resource/<DocType>` + `/api/method/...`, token auth
(`Authorization: token <api_key>:<api_secret>`). Unlike Krayin (which had no REST API), the
crm-bridge talks to Frappe over REST, NOT direct DB.

## Entity model decision
- A Krayin **lead** (pipeline + stage + value) → a Frappe **CRM Deal** (carries value, stage, org, contact).
- The deal's **line of business** is the custom **Pipeline** field (not separate pipelines).
- Deal **stage** = Frappe's clean 7-status flow (Kanban). The **exact** source stage is preserved in
  `custom_stage_detail` so reports keep granularity even though the Kanban is simplified.
- `custom_external_ref` = the original Krayin lead id (lets the bridge upsert idempotently / dedupe).

## Pipeline mapping  (Krayin pipeline → `custom_pipeline`)
| Krayin Pipeline (id) | `custom_pipeline` value |
|---|---|
| UW Cybersecurity Sales (4) | `Cybersecurity Sales` |
| UW Software Resale (5) | `Software Resale` |
| UW Subscriptions (6) | `Subscriptions` |

## Stage mapping  (Krayin stage → Frappe `status`; exact name → `custom_stage_detail`)
Frappe `CRM Deal Status` flow: **Qualification → Demo/Making → Proposal/Quotation → Negotiation → Ready to Close → Won → Lost** (probabilities 20/40/60/75/90/100/0).

**Pipeline 4 — Cybersecurity Sales**
| Krayin stage (id) | Frappe status |
|---|---|
| New (13), MQL (14), Contacted (15) | Qualification |
| Discovery Booked (16), Scoping (17) | Demo/Making |
| Proposal Sent (18) | Proposal/Quotation |
| Negotiation (19) | Negotiation |
| Won (20) | Won |
| Lost (21) | Lost |

**Pipeline 5 — Software Resale**
| Krayin stage (id) | Frappe status |
|---|---|
| New (22), Requirements Gathered (23) | Qualification |
| Vendor Shortlist (24) | Demo/Making |
| Quote Sent (25) | Proposal/Quotation |
| PO Pending (26) | Negotiation |
| Ordered (27), Deployed (28) | Ready to Close |
| Won (29) | Won |
| Lost (30) | Lost |

**Pipeline 6 — Subscriptions**
| Krayin stage (id) | Frappe status |
|---|---|
| New (31), Qualified (32) | Qualification |
| Demo Booked (33) | Demo/Making |
| Trial Offered (34) | Proposal/Quotation |
| Trial Active (35) | Negotiation |
| Contract Sent (36) | Ready to Close |
| Won (37) | Won |
| Lost (38) | Lost |

> The bridge always sets BOTH `status` (collapsed, above) and `custom_stage_detail` (the exact Krayin
> stage name, e.g. "PO Pending"). Metabase/reports should group by `custom_stage_detail` for fidelity.

## Lead sources  (`CRM Lead Source`, mapped by NAME — all 22 Krayin sources added)
Name-based 1:1. Krayin "Web Form"/"Web" map to those exact `CRM Lead Source` names (the bridge passes
the source name string, not an id). Full list now present: Email, Web, Web Form, Phone, Direct,
Scope Builder, Scope Builder Quiz, ADHICS Readiness Quiz, ISO 27001 Gap Quiz, Newsletter Signup,
LinkedIn Outbound - Manoj/Nelson/Vinoth, Cold Email - Manoj/Nelson/Vinoth, Apollo Outbound, Referral,
Pipeline 1 Upsell, WhatsApp, Founding Outreach, Referral Partner (+ Frappe defaults like Website).

## Lead types  (Krayin type → `custom_lead_type` select)
New Business · Existing Business · One-off Project · Subscription · Software Resale · Multi-service (1:1 by name).

## Custom fields on CRM Deal & CRM Lead
`custom_pipeline` (Select) · `custom_lead_type` (Select) · `custom_icp_segment` (Select: Healthcare/ISO/PDPL/Other)
· `custom_outbound_confidence_score` (Int) · `custom_stage_detail` (Data) · `custom_external_ref` (Data)
· scope-builder: `custom_scope_token`, `custom_scope_reference`, `custom_scope_range_low`,
`custom_scope_range_high`, `custom_founding_optin` (Check), `custom_scope_view_count` (Int),
`custom_scope_last_viewed_at` (Datetime), `custom_cart_summary` (Small Text).

## Team users (seeded, welcome email OFF — they must set password via "Forgot Password")
manoj@ (Sales Manager + System Manager) · gowtham@ (Sales User) · kumaraguru@ (Sales User) ·
nelson@ (Sales Manager) · vinoth@ (Sales Manager). Roles available: Sales User, Sales Manager, Sales Master Manager.

## Newsletter
`Email Group` = **"Underwings Newsletter"**. Subscribers added as `Email Group Member` (email + email_group).
The website newsletter form (Phase 4) will POST to `/api/resource/Email Group Member`.
