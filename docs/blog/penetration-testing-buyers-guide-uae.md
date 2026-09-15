## Most "Penetration Tests" Sold in the UAE Are Just Scanner Reports

If you've been asked to "get a pen test" — by an enterprise customer, an auditor, your board, or an investor — you're about to spend real money, and the market is full of vendors who will sell you a Nessus scan with a logo on it and call it a penetration test. It isn't. A scanner finds known vulnerabilities with known signatures. A real penetration test has a human attacker chaining those findings together, abusing your business logic, and getting somewhere a scanner never could.

Knowing the difference is the difference between a report that satisfies a checkbox and a report that actually tells you whether you'd survive an attack. This is a buyer's guide — how to scope, buy, and judge a penetration test in the UAE, written from the testing side of the table.

## Why You're Buying One (Get This Clear First)

The *reason* you need the test shapes everything about how it should be scoped. The common drivers:

- **An enterprise customer's security review.** They won't sign until you show a recent third-party pen-test report. Scope to the system they care about (usually your product).
- **ISO 27001 / SOC 2 / compliance.** ISO 27001's control set expects evidence of technical testing; SOC 2 auditors ask for it. Scope to the certified environment.
- **Regulatory.** Sector regulators increasingly expect regular testing.
- **The board or an investor.** Risk assurance, or due diligence before a raise or acquisition.
- **You were breached, or nearly.** Scope to understand the actual exposure.

Tell your tester *why* up front. A test scoped for an enterprise sales review looks different from one scoped for breach response. A vendor who doesn't ask why isn't thinking about your outcome.

## The Types — Buy the Right One

"Penetration test" is an umbrella. The main types:

- **External network** — your internet-facing infrastructure, from an outside attacker's view.
- **Internal network** — assumed-breach: what an attacker (or malicious insider) does once inside. AD escalation, lateral movement, segmentation.
- **Web application** — your web app/portal, against the OWASP Top 10 and deeper business-logic abuse.
- **API** — REST/GraphQL endpoints; increasingly the real attack surface for modern apps.
- **Mobile application** — iOS/Android, mapped to OWASP MASVS.
- **Cloud configuration review** — Azure/AWS/M365 misconfigurations (often paired with, not instead of, a pen test).
- **Phishing / social engineering** — your people, not just your tech.

Most first-time buyers need a **web app + API test** (if you're a SaaS) or an **external + internal network test** (if you're an enterprise with infrastructure). Don't let a vendor sell you everything; scope to your actual risk and driver.

## Scoping — The Decisions That Matter

A good tester walks you through these. Be wary of one who doesn't.

- **Black, grey, or white box.** Black = no information (realistic but slow, you pay for reconnaissance). Grey = some access/credentials (the sweet spot for most — efficient, realistic). White = full information/source (deepest coverage). For most web/API tests, **grey-box with test credentials** gives the best value: the tester spends time finding real issues, not guessing usernames.
- **Authenticated vs unauthenticated.** Most real risk is *behind* the login. If the test is unauthenticated only, you're testing the front door and ignoring the house. Insist on authenticated testing for anything with user accounts.
- **In-scope and out-of-scope assets**, in writing. Exact URLs, IP ranges, apps.
- **Rules of engagement** — testing window, production vs staging, who to call if something breaks, whether denial-of-service is explicitly excluded (it should be, unless you've agreed otherwise).

## What a Real Engagement Looks Like

1. **Kickoff + signed rules of engagement.** Scope, credentials, allow-list the tester's source IP in your WAF.
2. **Manual testing**, methodology-driven — OWASP WSTG/ASVS for web, MASVS for mobile, MITRE ATT&CK-informed for networks. Not just a tool run.
3. **Immediate escalation** of any Critical or High finding — out-of-band, within hours, not held for the final report. If your tester sits on a critical for three weeks, that's a problem.
4. **A report** with every finding scored (CVSS v3.1), a proof-of-concept showing exactly how it was exploited, screenshots, and specific remediation guidance — plus an executive summary your board can read.
5. **A retest** after you fix the findings, confirming they're actually closed. A test without a retest is half a service.

## How to Read the Report (and Spot a Weak One)

- **Findings should have proof.** "Possible SQL injection" with no PoC is a scanner guess. A real finding shows the payload and the result.
- **Severity should be contextual**, not just copied from a CVE database. A medium CVSS on an internet-facing admin panel may be your biggest real risk.
- **Remediation should be specific** to your stack, not "apply vendor patches."
- **Red flag:** a 200-page report that's 90% automated-scanner output padding. A good 25-page report of real, exploited findings beats it every time.

## Choosing a Tester — The Red Flags

- **"Automated penetration testing."** There's no such thing. Automated *scanning* is real and useful; calling it a pen test is marketing.
- **No named tester / no certifications.** Ask who actually does the work and what they hold (OSCP is the meaningful baseline for hands-on offensive skill).
- **No methodology named.** If they can't tell you whether they follow OWASP WSTG/ASVS, walk away.
- **No retest included.** Means they're not confident you'll fix anything, or they want to bill you again.
- **A quote with no scoping call.** Anyone who prices a pen test without understanding your environment is guessing — and you'll get a guess-quality test.

## Timeline and Cost

A focused web-app or external-network test is typically **1–3 weeks** end to end (kickoff, testing, report, with a retest window after fixes). Cost depends on scope — number of endpoints, applications, IP ranges, authenticated roles. In the UAE you should expect a clear, scoped, fixed quote in AED after a short scoping call; a vendor who can't give you that hasn't understood your environment.

## Working With Underwings

We do **manual penetration testing** — OSCP-certified, methodology-driven, with proof-of-concept findings and a retest included as standard. Named senior tester on your engagement, transparent AED pricing, a fixed written quote within 48 hours of a scoping call, and a limited number of **founding-client** places at preferential rates while we build our public track record.

If you need a pen test — for an enterprise deal, an audit, or your own peace of mind — a free 30-minute scoping call will tell you exactly what you need (and what you don't). Book at **book.underwings.org**, email **contact@underwings.org**, or call **+971 54 707 8203**.

*Nelson Durairaj is OSCP- and CEH-certified and leads offensive security at Underwings Cybersecurity Solutions, Abu Dhabi.*
