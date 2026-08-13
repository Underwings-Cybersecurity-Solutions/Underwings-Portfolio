'use strict';
/*
 * enrich.js — Claude scores/classifies each candidate against the Underwings
 * ICP. Forced tool-use for structured output. Never fabricates emails/names.
 */
const cfg = require('../config');
const { request, sleep } = require('./http');
const { bucketOf } = require('./region');

const TOOL = {
  name: 'record_assessments',
  description: 'Record the ICP assessment for each candidate lead.',
  input_schema: {
    type: 'object',
    properties: {
      leads: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'the candidate index given in the prompt' },
            company: { type: 'string', description: 'cleaned organisation name (do not invent)' },
            country: { type: 'string', description: "headquarters country in English; append '?' if inferred with low confidence; '' if unknown" },
            emirate: { type: 'string', description: "UAE emirate if known (Dubai, Abu Dhabi, Sharjah, Ajman, Umm Al Quwain, Ras Al Khaimah, Fujairah); '' otherwise" },
            industry: { type: 'string', description: 'one of the allowed sectors, verbatim' },
            service: { type: 'string', description: 'the single Underwings service line that best fits this lead, verbatim' },
            kind: { type: 'string', enum: ['customer', 'partner'], description: "'customer' = a UAE organisation that would BUY these services; 'partner' = a firm to COLLABORATE with (see the rules)" },
            icp_score: { type: 'integer', description: '1 (poor fit) to 10 (ideal buyer, or for a partner: ideal collaborator)' },
            why: { type: 'string', description: 'one line: for a customer, the compliance or security driver plus an outreach angle; for a partner, what the collaboration would be' },
            keep: { type: 'boolean', description: 'false only for individuals, job listings, non-businesses and noise' },
          },
          required: ['index', 'company', 'service', 'kind', 'icp_score', 'why', 'keep'],
        },
      },
    },
    required: ['leads'],
  },
};

// An alternate ICP (generate-vapt.js passes one) swaps the buyer definition
// and can suppress the partner track entirely: the default tie-break routes
// dev shops and IT firms to kind='partner', which is exactly wrong when those
// ARE the buyers being hunted.
function buildPrompt(batch, icp = cfg.icp) {
  const lines = batch.map((c, i) =>
    `[${i}] company="${c.company || '(unknown — infer from signal)'}" ` +
    `website="${c.website || ''}" location="${c.location || ''}" ` +
    `industry="${c.industry || ''}" source="${c.source}"` +
    (c.signal ? ` signal="${c.signal}"` : '')
  ).join('\n');

  const kindRules = icp.customerOnly
    ? (
      `Customer or partner — set 'kind':\n` +
      `- ALWAYS set kind='customer' for this run. Every organisation here is ` +
      `assessed as a potential BUYER, including IT services companies, ` +
      `software houses and integrators — for this campaign they are the ` +
      `buyers, not channels. Do not use kind='partner'.\n` +
      `- A pure cybersecurity firm that does exactly what Underwings does ` +
      `(penetration testing, ISO 27001 consulting, SOC services) is a direct ` +
      `competitor, not a buyer: keep=true but score it 1-2.\n\n`
    )
    : (
      `Customer or partner — set 'kind':\n` +
      `- kind='customer' (the default): an organisation that would BUY these ` +
      `services. Score it on buying fit.\n` +
      `- kind='partner': a firm Underwings would COLLABORATE with rather than ` +
      `sell to — IT managed-service providers, system integrators, cloud and ` +
      `software resellers, audit and accounting firms, law firms doing data ` +
      `protection work, insurers and brokers writing cyber cover, staffing and ` +
      `training companies, and other consultancies whose clients need security ` +
      `work they don't perform themselves. These were previously discarded as ` +
      `"competitors"; they are referral and white-label channels, so keep them ` +
      `and score them on how much security work their client base would ` +
      `generate.\n` +
      `- TIE-BREAK: many firms could both buy AND refer — an IT services ` +
      `company, an integrator, an accounting firm. Prefer kind='partner' for ` +
      `these. One sale is worth less than a channel that sends work ` +
      `repeatedly, and a partner conversation can still end in them buying.\n` +
      `- A pure cybersecurity firm that does exactly what Underwings does ` +
      `(penetration testing, ISO 27001 consulting, SOC services) is a direct ` +
      `competitor: kind='partner' with a LOW score, unless it is clearly ` +
      `specialised somewhere Underwings is not.\n` +
      `- For a partner, 'service' is the Underwings line the collaboration ` +
      `would revolve around.\n\n`
    );

  // Score anchors are part of the ICP: the VAPT track anchors on software
  // estate + mandates, the default on compliance obligations.
  const anchors = icp.anchors || (
    `    10 — UAE organisation with a LIVE trigger (breach in the news, a ` +
    `dated compliance deadline, a security tender) and no in-house security ` +
    `team.\n` +
    `    8-9 — UAE, clear standing obligation (ISO 27001 / NESA / ADHICS / ` +
    `PDPL applies to them), regulated sector, no visible security function.\n` +
    `    6-7 — UAE and plausibly in scope, but no trigger and no confirmed ` +
    `obligation. This is the DEFAULT; do not inflate it.\n` +
    `    4-5 — UAE but weak fit: tiny, unregulated, or likely already covered.\n` +
    `    1-3 — no UAE operations, or not a buyer at all.\n`
  );

  return (
    `You are a lead-qualification analyst for Underwings, a UAE cybersecurity ` +
    `and compliance consultancy. Underwings delivers ISO 27001 implementation ` +
    `and audit readiness, NESA / UAE IA and ADHICS compliance, UAE PDPL ` +
    `advisory, penetration testing (PTaaS), cloud security reviews (Azure and ` +
    `Microsoft 365), network and firewall reviews, and security awareness ` +
    `training.\n\n` +
    `Ideal Customer Profile:\n${icp.description}\n\n` +
    `Allowed sectors (pick the single best fit): ${icp.sectors.join('; ')}.\n\n` +
    `Allowed service lines (pick the single best fit): ${icp.services.join('; ')}.\n\n` +
    `Assess each candidate below. Rules:\n` +
    `- Score 1-10 for ICP fit, and USE THE WHOLE RANGE. Anchors:\n` +
    anchors +
    `  Reserve 9 and 10 for evidence you can point at in the fields given. If ` +
    `most of a batch lands on the same number you are not discriminating.\n` +
    `- Weight UAE presence heavily: an organisation with no UAE operations ` +
    `scores 3 or below.\n` +
    `- 'company' MUST be one specific, contactable organisation. If the ` +
    `signal refers to several unnamed organisations ("three major UAE ` +
    `companies were breached", "UAE private sector victims"), you cannot ` +
    `invent one: set keep=false. A breach story is only useful when the ` +
    `victim is named.\n` +
    `- Do NOT invent contact names or email addresses.\n` +
    `- country: headquarters country in English; append '?' if inferring; '' if unknown.\n` +
    `- If a candidate is just a news signal, infer the organisation it refers to.\n` +
    `- keep=false ONLY for individuals, job listings, non-businesses and ` +
    `obvious noise.\n\n` +
    kindRules +
    `Candidates:\n${lines}`
  );
}

// A news story about "three major UAE organisations" names no one you can
// email, but Claude happily returns it as a company — and scores it 8-9,
// because a breach is the strongest buying signal there is. Those rows then
// sit at the TOP of the sales list and cannot be worked at all. This is the
// deterministic guard; the prompt asks for the same thing, and neither alone
// was enough.
//
// Precision matters more than recall here: rejecting a real prospect costs a
// customer. Only plural collectives, leading quantifiers, anonymity words and
// parenthetical incident labels are refused — "Gulf Business Machines",
// "Consolidated Shipping Services Group" and "Emirates Insurance Company" all
// pass untouched.
const COLLECTIVE =
  /\b(organi[sz]ations|companies|firms|entities|businesses|victims|institutions|providers|operators|agencies|sectors?)\b/i;
const QUANTIFIER =
  /^\s*(three|several|multiple|various|many|some|two|four|five|dozens|numerous|a\s+number\s+of)\b/i;
const ANONYMOUS =
  /\b(unnamed|undisclosed|unidentified|anonymous|unknown|various)\b/i;
const INCIDENT_PAREN =
  /\([^)]*\b(breach|victims?|incident|leak|hack|attack|ransomware|compromise)\b[^)]*\)/i;

/** Is this a specific organisation we could actually contact? Pure; exported. */
function isNamedCompany(name) {
  const s = String(name || '').trim();
  if (s.length < 2) return false;
  if (QUANTIFIER.test(s) || ANONYMOUS.test(s) || INCIDENT_PAREN.test(s)) return false;
  if (COLLECTIVE.test(s)) return false;
  if (!/[a-z]/i.test(s)) return false;          // digits/punctuation only
  return true;
}

/** Merge Claude's assessments back onto the batch. Pure; exported for tests.
 * Returns { leads, assessed }:
 *   leads    — candidates Claude kept (keep === true), enriched
 *   assessed — every candidate that came back with an assessment at all
 * run.js only remembers `assessed` in seen.json, so a candidate lost to a
 * transient API failure is retried next cycle instead of being blacklisted. */
function mergeAssessments(batch, assessments, icp = cfg.icp) {
  const byIndex = new Map((assessments || []).map((a) => [a.index, a]));
  const leads = [];
  const assessed = [];
  batch.forEach((c, idx) => {
    const a = byIndex.get(idx);
    if (!a) return;              // no assessment at all → not assessed, retry later
    assessed.push(c);
    if (a.keep !== true) return; // assessed and rejected → remembered, dropped
    // A collective ("UAE organisations", "three major banks") is unworkable
    // however well it scores. Counted as assessed, so we stop re-billing it.
    if (!isNamedCompany(a.company || c.company)) return;
    const country = a.country || c.location || '';
    leads.push({
      ...c,
      company: a.company || c.company,
      country,
      geoBucket: bucketOf(country),
      emirate: a.emirate || '',
      industry: icp.sectors.includes(a.industry) ? a.industry : (c.industry || ''),
      service: icp.services.includes(a.service) ? a.service : '',
      icp_score: typeof a.icp_score === 'number' ? a.icp_score : 0,
      why: a.why || '',
      // customerOnly runs assess buyers exclusively — a stray 'partner' from
      // the model must not leak rows out of the campaign's kind
      kind: !icp.customerOnly && a.kind === 'partner' ? 'partner' : 'customer',
    });
  });
  return { leads, assessed };
}

async function callClaude(apiKey, batch, icp = cfg.icp) {
  const res = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.claudeModel, max_tokens: 2048,
      tools: [TOOL], tool_choice: { type: 'tool', name: 'record_assessments' },
      messages: [{ role: 'user', content: buildPrompt(batch, icp) }],
    }),
  }, { timeoutMs: 60000, retries: 2 });
  const j = await res.json();
  const tu = (j.content || []).find((c) => c.type === 'tool_use');
  return tu?.input?.leads || [];
}

/** Score every candidate. Returns { leads, assessed, failedBatches }.
 * Pass an alternate `icp` to run a campaign-specific assessment (see the
 * buildPrompt note); omitted, cfg.icp applies. */
async function enrich(apiKey, candidates, icp = cfg.icp) {
  const leads = [];
  const assessed = [];
  let failedBatches = 0;
  for (let i = 0; i < candidates.length; i += cfg.claudeBatchSize) {
    const batch = candidates.slice(i, i + cfg.claudeBatchSize);
    let assessments = [];
    try {
      assessments = await callClaude(apiKey, batch, icp);
    } catch (e) {
      failedBatches += 1;
      console.warn(`  [claude] batch ${i} failed: ${e.message}`);
    }
    const merged = mergeAssessments(batch, assessments, icp);
    leads.push(...merged.leads);
    assessed.push(...merged.assessed);
    await sleep(300); // gentle pacing
  }
  return { leads, assessed, failedBatches };
}

module.exports = { enrich, buildPrompt, mergeAssessments, isNamedCompany, TOOL };
