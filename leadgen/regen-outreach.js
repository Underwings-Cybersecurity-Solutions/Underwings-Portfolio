'use strict';
/* regen-outreach.js — one-off (2026-08-05): redraft EVERY draft-less prospect
 * with the new fixed template (docs/superpowers/specs/2026-08-05-outreach-
 * template-design.md). Run AFTER nulling outreach_subject/body; writes go
 * through the same IS NULL guard as the pipeline, so a draft that already
 * exists is never overwritten.
 *   docker exec underwings-leadgen node regen-outreach.js */
const store = require('./lib/store-pg');
const outreach = require('./lib/outreach');

(async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const { leads } = await store.load();
  const todo = leads.filter((r) => !r.hasDraft && r.company);
  console.log(`${leads.length} prospects loaded, ${todo.length} need drafts`);
  const drafted = await outreach.draftAll(apiKey, todo);
  let written = 0;
  for (const r of todo) {
    if (!r.outreachSubject) continue;
    if (await store.setOutreachDraft(r.id, r.outreachSubject, r.outreachBody)) written++;
  }
  console.log(`Done: ${drafted} drafted, ${written} written`);
  const missed = todo.filter((r) => !r.outreachSubject).length;
  if (missed) console.log(`${missed} still draft-less — the loop backfill retries them next cycle`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
