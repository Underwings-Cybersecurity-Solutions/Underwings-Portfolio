## You Bought a FortiGate. That Doesn't Mean Your Network Is Secure.

Across the UAE, thousands of businesses bought a FortiGate, plugged it in, got internet working, and never touched it again. The box is excellent — Fortinet makes genuinely strong hardware — but a firewall out of the box is a locked door with the key still in it. Security isn't the appliance; it's the *configuration*. And the configuration is where almost every network I review falls down.

This is a practical guide to hardening a FortiGate and the network around it — the gaps I find most often, written from doing these reviews. It applies whether you run one FortiGate at a single office or a fleet across oil-and-gas sites, manufacturing plants, and branch networks.

## Start Where Attackers Start: Management Access

The fastest way into a network is often the firewall's own admin interface. The most common findings:

- **Default or weak admin credentials**, or a single shared admin account with no individual accountability.
- **No MFA on admin login.** Inexcusable in 2026; FortiGate supports it natively.
- **Admin access exposed to the internet** — the management interface reachable from any IP, often on the default port. Restrict admin access to specific **trusted hosts** and, ideally, an internal management network only.
- **HTTP admin enabled** instead of HTTPS-only; **Telnet** left on instead of SSH.
- **No RBAC** — everyone who touches the box is a super-admin. Use admin profiles to give least privilege.

Lock the management plane first. If an attacker owns your firewall, nothing else you've done matters.

## Firewall Policy Hygiene

The policy table is where intent meets reality, and it rots over time:

- **`any-any` allow rules.** The classic — a "temporary" rule from a project three years ago that permits everything. Every policy should be least-privilege: specific source, destination, service.
- **No logging on policies.** If a rule doesn't log, you're blind to what passes through it. Log on all policies that matter, and ship the logs somewhere you'll actually look (see Visibility below).
- **Stale rules** for decommissioned servers and former vendors. Review and prune regularly.
- **No deny-and-log at the bottom.** Know what's being blocked, not just what's allowed.

## The One That Lets a Breach Spread: Flat Networks

If an attacker phishes one laptop and that laptop can reach your servers, your finance systems, your OT, and every other endpoint — you have a flat network, and a single compromise becomes a total compromise. This is the single biggest structural weakness I find.

**Segmentation** fixes it: separate VLANs/zones for users, servers, guests, OT/industrial systems, and management, with firewall policy controlling traffic *between* them — not just at the internet edge. East-west traffic (inside the network) is where modern attacks actually move. For manufacturing and oil-and-gas especially, **IT/OT segmentation is non-negotiable** — your industrial systems should never share a flat network with office laptops.

This is also the foundation of **Zero Trust**: stop trusting traffic just because it's "inside," and verify at every boundary.

## Turn On What You Paid For

FortiGate's value is its security services — and they're frequently licensed but switched off or left at defaults:

- **IPS** (intrusion prevention) — enabled and tuned to your traffic, not left passive.
- **Antivirus / anti-malware** on the right policies.
- **Web filtering** and **application control** to cut the attack surface.
- **SSL/TLS inspection** where appropriate — most threats hide in encrypted traffic; if you're not inspecting it, your IPS and AV are half-blind. (Scope this carefully around privacy and certificate handling.)

You're paying for the UTM/security subscription. Use it.

## The Remote-Access Attack Surface: VPN

SSL-VPN and IPsec are how your people get in — and how attackers try to. FortiGate VPN appliances have been actively targeted in real-world campaigns, so:

- **Keep firmware current.** VPN-facing firmware vulnerabilities get exploited fast; patch promptly.
- **MFA on all VPN access**, always.
- **Strong crypto**, disable legacy/weak ciphers.
- **Restrict and monitor** — limit who can connect, from where, and log it.

## Visibility — You Can't Secure What You Can't See

A FortiGate generating logs that go nowhere is a missed early-warning system. Centralise logging (FortiAnalyzer or your SIEM), retain it, and actually review it — or have someone review it for you. Most breaches are visible in the logs *before* they become disasters; the problem is nobody's watching.

## Firmware and Configuration Discipline

- **Patch on a schedule.** Out-of-date FortiOS is one of the most common — and most exploited — findings.
- **Back up the configuration**, encrypted, and test that you can restore it.
- **Disable unused features and services** — every enabled feature is attack surface.
- For fleets, use **FortiManager** for consistent, auditable configuration rather than per-box drift.

## How to Know If Yours Is Actually Hardened

You don't know until someone checks — and "it's working, traffic flows" is not the same as "it's secure." A **network security review** examines the firewall configuration, policy table, segmentation, VPN posture, firmware currency, and logging against best practice (CIS benchmarks, Fortinet hardening guidance), and gives you a prioritised list of what to fix. It's the network equivalent of a health check, and most organisations have never had one.

This also maps directly to compliance: ISO 27001, ADHICS, and NESA all expect network controls, segmentation, and logging you can evidence.

## Working With Underwings

We review and harden FortiGate and broader network infrastructure — configuration and policy review, segmentation design, VPN and remote-access hardening, logging and visibility — led by a **CCNP- and Fortinet-NSE-certified** practitioner, not a junior. Transparent AED pricing, fixed written quotes within 48 hours, and a limited number of **founding-client** places at preferential rates while we build our public track record.

If you're not sure your network is as secure as the hardware you paid for — or you're doing a refresh, an ISO/ADHICS programme, or worried after an incident — a free 30-minute scoping call will tell you where you stand. Book at **book.underwings.org**, email **contact@underwings.org**, or call **+971 54 707 8203**.

*Vinoth Samiyappa is CCNP- and Fortinet-NSE-certified (and Azure-certified) and leads network and infrastructure security at Underwings Cybersecurity Solutions, Abu Dhabi.*
