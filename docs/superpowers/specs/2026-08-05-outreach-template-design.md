# Outreach template rework — 2026-08-05

User-approved design (this session).

## Goal
Replace the free-form hook-led cold-email drafts with a fixed skeleton the user
supplied; AI fills only the industry-specific slots. Applies to all 252 existing
prospects (drafts regenerated) and every future lead.

## Skeleton (fixed text; `{…}` = AI slot, `[…]` = literal placeholder kept for sales)
```
Subject: {Sector} security — worth 15 minutes?

Hi {first name},   ← "Hello," when no contact name

Quick note from Underwings Cybersecurity Solutions. We work with {sector}
organisations on {1–2 core services matched to this prospect}.

{INDUSTRY BLOCK — 3–4 lines: sector's regulatory/audit pressure with named
standards (ADHICS, NESA/UAE IA, PCI DSS, UAE PDPL, ISO 27001…), typical weak
point, cost when it goes wrong; uses the prospect's real trigger when present.}

I'm not asking you to switch anything. A 15-minute call, and I'll tell you
honestly whether we're a fit.

Pick a slot that works: https://calendly.com/underwings1415/30min

If it's easier to look before you talk, I've attached our company profile and
current service list, and our free assessment is open here:
https://underwings.org/#contact

Regards,
[YOUR NAME]
[TITLE] | Underwings Cybersecurity Solutions
+971 547078203 | https://underwings.org
```

## Decisions (user)
- Assessment link → contact form; the form's service dropdown gains a
  highlighted "Free Security Assessment" option at the very top.
- Signature: literal `[YOUR NAME]` / `[TITLE]` placeholders; phone/site fixed.
- Partners: same template (outbound lead-gen, not collaboration framing).
- Industry block: AI-written per prospect (not a static per-vertical library).

## Implementation
1. `leadgen/lib/outreach.js`: tool schema becomes `{index, sector, services,
   block}`; the email is COMPOSED IN CODE around those slots so links,
   signature, and structure are exact. Update tests.
2. One-off regen: NULL `outreach_subject/body` on all crm_prospects, run a
   script in the leadgen container that redrafts everything (no per-cycle cap).
3. `frontend` contact form: top dropdown option `free-assessment`, highlighted;
   make sure the intake path (contact.ts / crm-inbound SOURCE_MAP) accepts it.
4. `crm/src/js/crm.js` fallback template rewritten to the same skeleton
   (generic block, still never interpolates `why`). Rebuild crm + frontend,
   restart underwings-nginx.

## Known caveat
"I've attached our company profile" — attachment is manual at send time; the
existing profile PDF >10MB bounces through Brevo relay if sent from webmail.
