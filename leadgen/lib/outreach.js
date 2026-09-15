'use strict';
/*
 * outreach.js — one cold-email DRAFT per prospect, written at enrichment
 * time and stored on crm_prospects (outreach_subject / outreach_body). The
 * CRM drawer shows it with edit + copy; from the moment it lands the draft
 * is SALES-OWNED (like status and notes — migration 013 extends the column
 * grant), and the pipeline only ever fills a NULL draft, never overwrites.
 *
 * Format (user-approved 2026-08-05, docs/superpowers/specs/): a FIXED
 * skeleton composed in code — greeting, intro, 15-minute ask, Calendly and
 * free-assessment links, signature with literal [YOUR NAME]/[TITLE]
 * placeholders the salesperson replaces. Claude supplies only three slots
 * per prospect: `sector`, `services`, and the industry-pressure `block`.
 * Composing in code is what guarantees every draft carries the exact links
 * and structure; the model can only vary what it's supposed to vary.
 */
const cfg = require('../config');
const { request, sleep } = require('./http');

const CALENDLY_URL = 'https://calendly.com/underwings1415/30min';
const ASSESSMENT_URL = 'https://underwings.org/#contact';

const TOOL = {
  name: 'record_drafts',
  description: 'Record the template slots for each prospect.',
  input_schema: {
    type: 'object',
    properties: {
      drafts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'the prospect index given in the prompt' },
            sector: { type: 'string', description: "the prospect's sector, 1-3 words, cased to read naturally mid-sentence" },
            services: { type: 'string', description: 'the 1-2 most relevant Underwings service lines, as a natural phrase' },
            block: { type: 'string', description: 'the industry-pressure paragraph per the rules in the prompt' },
          },
          required: ['index', 'sector', 'services', 'block'],
        },
      },
    },
    required: ['drafts'],
  },
};

function buildPrompt(batch) {
  const lines = batch.map((l, i) =>
    `[${i}] kind="${l.kind === 'partner' ? 'partner' : 'customer'}" ` +
    `company="${l.company || ''}" service="${l.service || ''}" ` +
    `industry="${l.industry || ''}" where="${[l.emirate, l.country].filter(Boolean).join(', ')}" ` +
    `driver="${l.why || ''}"` +
    (l.signal ? ` trigger="${l.signal}"` : '') +
    (l.contactName ? ` contact="${l.contactName}" contact_title="${l.title || ''}"` : '')
  ).join('\n');

  return (
    `You fill the variable slots of a FIXED cold-outreach email template for ` +
    `Underwings, a UAE cybersecurity and compliance consultancy (ISO 27001 ` +
    `implementation and audit readiness, NESA/UAE IA and ADHICS compliance, ` +
    `UAE PDPL advisory, penetration testing, cloud security reviews, security ` +
    `awareness training). A salesperson edits and sends the final email. The ` +
    `rest of the template — greeting, the 15-minute-call ask, booking and ` +
    `assessment links, signature — is added by code. You supply ONLY three ` +
    `slots per prospect.\n\n` +
    `The email will read:\n` +
    `  "Quick note from Underwings Cybersecurity Solutions. We work with ` +
    `{sector} organisations on {services}."\n` +
    `followed by your {block} paragraph, then the fixed ask and links.\n\n` +
    `Slots:\n` +
    `- sector: 1-3 words naming the prospect's sector, cased to read ` +
    `naturally mid-sentence ("healthcare", "banking and finance", "IT ` +
    `services"). It is also used in the subject "<Sector> security — worth ` +
    `15 minutes?", which must stay under 60 characters. If industry is ` +
    `blank, infer a concrete sector from the service/company fields — never ` +
    `a filler like "business".\n` +
    `- services: the 1-2 Underwings service lines most relevant to this ` +
    `prospect, as a natural phrase ("penetration testing and ADHICS ` +
    `compliance readiness").\n` +
    `- block: one plain-text paragraph, 3-4 lines, about the pressure THIS ` +
    `sector is actually under: (1) the regulatory or audit obligation, ` +
    `naming real standards (ADHICS, NESA/UAE IA, UAE PDPL, PCI DSS, ` +
    `ISO 27001, SAMA CSF...) — never vague "compliance requirements"; ` +
    `(2) the specific weak point typically found in that environment; ` +
    `(3) what it costs when it goes wrong. If a trigger is given for the ` +
    `prospect (e.g. a breach in the news), open the block with it — factual ` +
    `and tactful, never alarmist.\n\n` +
    `Rules:\n` +
    `- Never invent facts, names, numbers, or regulations not implied by the ` +
    `fields given. Never claim past clients, case studies, or track record ` +
    `("we've helped firms like yours") — describe what Underwings does, not ` +
    `unverifiable history.\n` +
    `- No placeholders like [Name] inside slot text.\n` +
    `- kind="partner": these firms deliver adjacent services (IT, audit, ` +
    `consulting). Same template, angled as outbound lead generation: sector ` +
    `= their vertical, services = what Underwings can deliver around their ` +
    `client base (e.g. white-label penetration testing and compliance ` +
    `delivery), block = the security and compliance demand building among ` +
    `their clients and what meeting it is worth to them.\n\n` +
    `Prospects:\n${lines}`
  );
}

/** Deterministic assembly of the approved skeleton around the AI slots.
 * Returns {subject, body} or null when any slot is missing — half a draft
 * is worse than none; the backfill pass retries those. */
function composeEmail(lead, slots) {
  const sector = String((slots && slots.sector) || '').trim();
  const services = String((slots && slots.services) || '').trim();
  const block = String((slots && slots.block) || '').trim();
  if (!sector || !services || !block) return null;
  const first = String(lead.contactName || '').trim().split(/\s+/)[0] || '';
  const subject = `${sector.charAt(0).toUpperCase()}${sector.slice(1)} security — worth 15 minutes?`;
  const body =
    `${first ? `Hi ${first},` : 'Hello,'}\n\n` +
    `Quick note from Underwings Cybersecurity Solutions. We work with ${sector} organisations on ${services}.\n\n` +
    `${block}\n\n` +
    `I'm not asking you to switch anything. A 15-minute call, and I'll tell you honestly whether we're a fit.\n\n` +
    `Pick a slot that works: ${CALENDLY_URL}\n\n` +
    `If it's easier to look before you talk, I've attached our company profile and current service list, and our free assessment is open here: ${ASSESSMENT_URL}\n\n` +
    `Regards,\n` +
    `[YOUR NAME]\n` +
    `[TITLE] | Underwings Cybersecurity Solutions\n` +
    `+971 547078203 | https://underwings.org`;
  return { subject, body };
}

/** Merge slot sets back onto the batch by index, composing the full email.
 * Mutates leads; returns how many got a draft. Exported for tests. */
function mergeDrafts(batch, drafts) {
  let n = 0;
  const byIndex = new Map((drafts || []).map((d) => [d.index, d]));
  batch.forEach((l, idx) => {
    const composed = composeEmail(l, byIndex.get(idx));
    if (!composed) return;
    l.outreachSubject = composed.subject;
    l.outreachBody = composed.body;
    n++;
  });
  return n;
}

async function callClaude(apiKey, batch) {
  const res = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.claudeModel, max_tokens: 4096,
      tools: [TOOL], tool_choice: { type: 'tool', name: 'record_drafts' },
      messages: [{ role: 'user', content: buildPrompt(batch) }],
    }),
  }, { timeoutMs: 90000, retries: 2 });
  const j = await res.json();
  const tu = (j.content || []).find((c) => c.type === 'tool_use');
  return tu?.input?.drafts || [];
}

/** Draft an email for every lead that doesn't have one. A failed batch just
 * leaves its leads draft-less — the backfill pass retries them next cycle. */
async function draftAll(apiKey, leads) {
  const todo = (leads || []).filter((l) => !l.outreachSubject);
  let drafted = 0;
  for (let i = 0; i < todo.length; i += cfg.claudeBatchSize) {
    const batch = todo.slice(i, i + cfg.claudeBatchSize);
    try {
      drafted += mergeDrafts(batch, await callClaude(apiKey, batch));
    } catch (e) {
      console.warn(`  [outreach] draft batch ${i} failed: ${e.message}`);
    }
    await sleep(300);
  }
  return drafted;
}

module.exports = { draftAll, mergeDrafts, composeEmail, buildPrompt, TOOL, CALENDLY_URL, ASSESSMENT_URL };
