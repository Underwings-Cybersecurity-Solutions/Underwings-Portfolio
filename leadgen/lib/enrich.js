'use strict';
/*
 * enrich.js — Claude scores/classifies each candidate against the ICP.
 * Uses tool-use for clean structured output. Never fabricates emails/names.
 */
const cfg = require('../config');
const { request, sleep } = require('./http');

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
            company: { type: 'string', description: 'cleaned company name (do not invent)' },
            industry: { type: 'string' },
            target_title: { type: 'string', description: 'likely decision-maker role to reach, generic (e.g. "IT Manager / CISO"). Never invent a person.' },
            service: { type: 'string', description: 'best-fit Underwings service from the allowed list' },
            icp_score: { type: 'integer', description: '1 (poor fit) to 10 (ideal fit)' },
            summary: { type: 'string', description: 'one concise sentence: why they fit + any signal' },
            opener: { type: 'string', description: 'one-sentence outreach opener tailored to them' },
            keep: { type: 'boolean', description: 'false if obviously irrelevant/not a real UAE business' },
          },
          required: ['index', 'company', 'icp_score', 'service', 'summary', 'opener', 'keep'],
        },
      },
    },
    required: ['leads'],
  },
};

async function callClaude(apiKey, batch) {
  const lines = batch.map((c, i) =>
    `[${i}] company="${c.company || '(unknown — infer from signal)'}" ` +
    `industry="${c.industry || ''}" website="${c.website || ''}" ` +
    `location="${c.location || ''}" source="${c.source}"` +
    (c.signal ? ` signal="${c.signal}"` : '')
  ).join('\n');

  const prompt =
    `You are a lead-qualification analyst for Underwings, a UAE cybersecurity ` +
    `consultancy.\n\nIdeal Customer Profile:\n${cfg.icp.description}\n\n` +
    `Allowed services (pick the single best fit): ${cfg.icp.services.join('; ')}.\n\n` +
    `Assess each candidate below. Rules:\n` +
    `- Score 1-10 for ICP fit (10 = ideal UAE target who likely needs our services).\n` +
    `- Do NOT invent contact names or email addresses.\n` +
    `- target_title = generic decision-maker role only.\n` +
    `- If a candidate is just a news signal, infer the company it refers to.\n` +
    `- keep=false for non-UAE, non-businesses, or obvious noise.\n\n` +
    `Candidates:\n${lines}`;

  const res = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.claudeModel, max_tokens: 2048,
      tools: [TOOL], tool_choice: { type: 'tool', name: 'record_assessments' },
      messages: [{ role: 'user', content: prompt }],
    }),
  }, { timeoutMs: 60000, retries: 2 });

  const j = await res.json();
  const tu = (j.content || []).find((c) => c.type === 'tool_use');
  return tu?.input?.leads || [];
}

/** Returns candidates merged with Claude assessment fields. */
async function enrich(apiKey, candidates) {
  const enriched = [];
  for (let i = 0; i < candidates.length; i += cfg.claudeBatchSize) {
    const batch = candidates.slice(i, i + cfg.claudeBatchSize);
    let assessments = [];
    try { assessments = await callClaude(apiKey, batch); }
    catch (e) { console.warn(`  [claude] batch ${i} failed: ${e.message}`); }
    const byIndex = new Map(assessments.map((a) => [a.index, a]));
    batch.forEach((c, idx) => {
      const a = byIndex.get(idx) || {};
      if (a.keep === false) return; // drop noise
      enriched.push({
        ...c,
        company: a.company || c.company,
        industry: a.industry || c.industry,
        target_title: a.target_title || '',
        service: a.service || '',
        icp_score: typeof a.icp_score === 'number' ? a.icp_score : 0,
        summary: a.summary || '',
        opener: a.opener || '',
      });
    });
    await sleep(300); // gentle pacing
  }
  return enriched;
}

module.exports = { enrich };
