# Runbook — Cold-outreach sending domain (`outreach.underwings.org`)

**Purpose:** dedicated subdomain for Phase H/I cold outbound, isolated from the
primary `underwings.org` transactional mail so outreach reputation can't bleed
into business mail.
**Built:** 2026-05-28. **Status at build:** Stalwart + `.env` done; DNS + warmup
pending.

> **Reputation note:** a subdomain isolates *From-domain / DKIM / DMARC*
> reputation but **shares the sending IP** with `mail.underwings.org` (same VPS,
> same Stalwart). True IP isolation would need a separate relay/IP. Acceptable at
> low, human-reviewed volume (≤25/day).

---

## 1. Stalwart objects (already created, via mgmt API `underwings-mail:8080`)

- **Domain** `outreach.underwings.org` (principal id 46)
- **Mailbox** `sales@outreach.underwings.org` (principal id 47) — also receives
  `postmaster@` and `abuse@`. Password is the SMTP submission credential, stored
  **only** in gitignored `.env` as `OUTBOUND_SMTP_PASS`.
- **DKIM keys**: RSA selector `uw2026`, Ed25519 selector `uw2026e`.

> **Gotcha (fixed 2026-05-28):** a Stalwart individual needs the **`user` role**
> to authenticate for SMTP submission/IMAP — explicit `email-send`/`email-receive`
> permissions alone yield `550 5.7.1 Your account is not authorized to use this
> service`. The `sales@` account now has `roles:["user"]`; SMTP AUTH on 587
> verified (loopback message queued + DKIM-signed). Any new sender mailbox must
> include the `user` role.

Re-create / inspect (mgmt API is reachable from any container on
`underwings-network`, e.g. `pandoc-render`; Basic auth `MAIL_ADMIN_*` from `.env`):

```bash
set -a && . ./.env && set +a
docker exec underwings-pandoc-render sh -c \
  'curl -s -u "$0:$1" "http://underwings-mail:8080/api/dns/records/outreach.underwings.org"' \
  "$MAIL_ADMIN_USER" "$MAIL_ADMIN_PASS"
```

## 1b. CRITICAL: outbound relays through Brevo (not direct)

The VPS **blocks outbound ports 25 and 587** (verified 2026-05-29), so Stalwart
cannot send directly. `queue.strategy.route` sends every non-local recipient to
the **Brevo smarthost** `smtp-relay.brevo.com:2525` (route `queue.route.brevo`,
SMTP AUTH user `779aec001@smtp-brevo.com`). This is the SAME Brevo account that
carries transactional mail.

Implications for outreach:
- **Recipients see Brevo's IP**, not `143.244.135.89`. So SPF must authorize
  Brevo: the record is `v=spf1 mx include:spf.brevo.com ~all` (mirrors the proven
  `underwings.org` SPF). Brevo also rewrites the envelope return-path to its own
  bounce domain, so **SPF aligns to Brevo, not us → DMARC must pass via DKIM**
  (relaxed alignment: a `d=underwings.org` signature aligns with a
  `From: …@outreach.underwings.org` because the org-domain matches).
- **Brevo AUP forbids cold/unsolicited email.** Founder decision (2026-05-29):
  send outreach through Brevo the same as transactional, relying on the built-in
  safety design (human-approved drafts only, ≤25/day, personalized B2B) to stay
  AUP-defensible. Do NOT run a high-volume scraped blast — that risks suspending
  the account and taking transactional mail down with it.
- **For guaranteed DMARC alignment, authenticate `outreach.underwings.org` in the
  Brevo dashboard** (Senders, Domains & Dedicated IPs → Domains → add subdomain →
  publish Brevo's `brevo1/brevo2._domainkey` records). Until then, alignment may
  still pass via relaxed `d=underwings.org` signing, but verify empirically.

**VERIFIED 2026-05-29:** test from `sales@outreach.underwings.org` landed in Gmail
**Inbox**, `signed-by: underwings.org` → SPF/DKIM/DMARC all pass (DKIM relaxed
alignment via the org-domain signature). Reputation clean at start.

> **Two Brevo gotchas that blocked delivery (both fixed 2026-05-29):**
> 1. `underwings.org` Brevo auth was INCOMPLETE — `brevo-code` TXT was present but
>    the `brevo1/brevo2._domainkey` CNAMEs were never published. Brevo couldn't
>    sign with an aligned key. Published `brevo1/brevo2._domainkey.underwings.org`
>    → `b1/b2.underwings-org.dkim.brevo.com`.
> 2. Brevo only delivers from **per-domain-authenticated** senders. Sending from
>    `sales@outreach.underwings.org` while only `underwings.org` was authenticated
>    → Brevo accepted at SMTP (`250`) then **silently dropped** the mail (no
>    bounce, nothing in Gmail). Fix: add `outreach.underwings.org` as its own
>    domain in Brevo + publish its records:
>    - TXT `outreach` `brevo-code:aa2102cc...` (alongside SPF, not replacing it)
>    - CNAME `brevo1._domainkey.outreach` → `b1.outreach-underwings-org.dkim.brevo.com`
>    - CNAME `brevo2._domainkey.outreach` → `b2.outreach-underwings-org.dkim.brevo.com`
>    then click Authenticate in Brevo. After that, mail delivers.
> Note: ignore Brevo's suggested `_dmarc … p=none` — kept our stricter `p=quarantine`.
> Port25 + MXToolbox email-reflectors were tried for autonomous verification; both
> are defunct (accept mail, never reply) — use a real Gmail inbox check instead.

## 2. DNS records (Cloudflare zone `underwings.org`, all **grey-cloud / DNS-only**)

Published with `scripts/cf-publish-outreach-dns.sh` (idempotent; needs a
short-lived `CF_API_TOKEN` with Zone:DNS:Edit, then revoke it).

| Type | Name | Value |
|---|---|---|
| A | `outreach` | `143.244.135.89` |
| MX | `outreach` | `mail.underwings.org` (prio 10) |
| TXT | `outreach` | `v=spf1 mx include:spf.brevo.com ~all` |
| TXT | `uw2026._domainkey.outreach` | RSA DKIM public key |
| TXT | `uw2026e._domainkey.outreach` | Ed25519 DKIM public key |
| TXT | `_dmarc.outreach` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@outreach.underwings.org; fo=1` |
| TXT | `_smtp._tls.outreach` | `v=TLSRPTv1; rua=mailto:postmaster@outreach.underwings.org` |

DMARC starts at **`p=quarantine`** during warmup; flip to **`p=reject`** once
warmup completes and alignment is confirmed (edit the `_dmarc` record).

Verify (use public resolvers — this VPS negative-caches NXDOMAIN):

```bash
dig +short TXT outreach.underwings.org @1.1.1.1
dig +short TXT _dmarc.outreach.underwings.org @1.1.1.1
dig +short TXT uw2026._domainkey.outreach.underwings.org @8.8.8.8
dig +short MX  outreach.underwings.org @1.1.1.1
```

## 3. Enable sending in the sidecar

`pandoc-render/server.js` enables sending only when `OUTBOUND_SMTP_USER` +
`OUTBOUND_SMTP_PASS` + `OUTBOUND_FROM` are all set (already in `.env`). To load:

```bash
docker compose up -d --force-recreate pandoc-render
```

**Do not do this before DNS is verified** — sending mail that fails
SPF/DKIM/DMARC harms the new domain's reputation from day one.

## 4. Verify alignment (before any real outreach)

1. Dry-run preview (no mail leaves):
   `curl -s -X POST -H "X-Shared-Token: $SHARED_TOKEN" -H 'Content-Type: application/json' \
    -d '{"draft_id":<id>,"dry_run":true}' http://localhost:<port>/outbound/send`
2. Real test send to a fresh `test-XXXX@mail-tester.com` address; open the score
   page. Require: **SPF pass, DKIM pass, DMARC aligned, no SpamAssassin red flags,
   PTR ok** (PTR is on the shared `mail.underwings.org` IP).
3. Also send to a Gmail + an Outlook inbox; check "Show original" → all three
   should read `PASS`.

## 5. Warmup ramp (≈3 weeks, gated — do NOT bulk-send a cold domain)

A brand-new domain that suddenly sends 25 cold emails/day looks like spam.
Ramp daily volume, keep content varied and human-reviewed, watch for bounces.

| Week | Max sends/day | Notes |
|---|---|---|
| 1 | 5 | warmest/known contacts first; aim for replies |
| 2 | 10–15 | mix in cold; keep bounce rate < 3% |
| 3 | 20–25 | reach steady-state cap |

`OUTBOUND_DAILY_CAP` in `.env` enforces the ceiling (start at 5, raise weekly).
The sidecar logs every send to `uw_outbound_log`.

## 6. Go-live activation (after warmup)

1. Flip DMARC `_dmarc.outreach` to `p=reject`.
2. n8n: create the **"Outreach IMAP"** credential (host `stalwart`, port 993 TLS,
   user `sales@outreach.underwings.org`, the `.env` password) for workflow 17.
3. Activate n8n workflows **15** (discover+harvest), **16** (send), **17** (reply
   IMAP), **18** (LinkedIn human-send queue). All currently imported INACTIVE.
4. Optional: add `GOOGLE_CSE_*` / `HUNTER_API_KEY` to `.env` to widen discovery
   beyond OSM + website scrape.

## 6b. Monitoring (real-time)

- **Live snapshot:** `POST /outbound/status` (X-Shared-Token) → JSON: drafts by
  status, email sent today vs cap, last-7d, reply rate + sentiment, LinkedIn
  sends, sending-enabled flag. Add `?slack=1` to also post a digest to
  #sales-pipeline.
- **Daily digest:** `outbound-status-digest.timer` posts that digest to
  #sales-pipeline every day 18:00 Asia/Dubai (`scripts/outbound-status-digest.sh`).
- **Trends (24h-lagged):** Metabase "Outbound" dashboard (collection "Outbound
  KPIs"), fed by the nightly `outbound-warehouse-sync` into warehouse `raw.*`.
- **Real-time activity:** Slack #sales-pipeline (discovery/sends), #hot-leads
  (LinkedIn queue + hot replies), #ops (daily ops summary, warmup alerts).
- **Infra:** `systemctl list-timers` (all scheduled jobs), n8n exec history,
  Stalwart logs (`docker logs underwings-mail`) for deliveries/bounces.

## 7. Rollback / kill switch

- **Stop all sending instantly:** blank `OUTBOUND_SMTP_USER` in `.env` +
  `docker compose up -d --force-recreate pandoc-render`. Sidecar then refuses
  every send (dry-run only).
- **Deactivate** n8n workflows 15/16/17/18.
- **Remove the domain** entirely: delete principals 46/47 via mgmt API and the
  Cloudflare records — outreach disappears, primary mail untouched.
