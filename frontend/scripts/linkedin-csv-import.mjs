// Import a LinkedIn Lead Gen Form CSV export into Zoho CRM.
//   node scripts/linkedin-csv-import.mjs <file.csv>
// Runs under node:24 (native TS import) with the site's env (ZOHO_*). For each
// row: look the email up in Zoho, create the Lead (source LinkedIn, tag
// linkedin) or patch only the safe subset of an existing one and add a Note.
// The 15-minute linkedin-sync then mirrors new Leads into Supabase + email.
import fs from 'node:fs';
import { parseLinkedInCsv, buildLinkedInLead } from '../src/lib/linkedin-csv.ts';
import { syncLead } from '../src/lib/lead-sync.ts';
import { zoho } from '../src/lib/zoho.ts';

const file = process.argv[2];
if (!file) { console.error('usage: linkedin-csv-import.mjs <file.csv>'); process.exit(2); }
if (!zoho.enabled) { console.error('ZOHO_* env missing'); process.exit(2); }
const rows = parseLinkedInCsv(fs.readFileSync(file, 'utf8'));
let created = 0, updated = 0, failed = 0;
for (const r of rows) {
  let payload = buildLinkedInLead(r, zoho.ownerId);
  let res = await syncLead({ supabase: null, table: 'form_submissions', recordId: r.leadId || r.email, form: 'Contact', payload, repeatDetails: `LinkedIn form: ${r.formName || '-'}${r.submittedAt ? ` at ${r.submittedAt} UTC` : ''}` });
  if (!res.ok && /Lead_Source/.test(res.error)) {
    // The "LinkedIn" picklist value has not been added yet: fall back to a stock value; the tag still marks it.
    payload = { ...payload, insert: { ...payload.insert, Lead_Source: 'Advertisement' } };
    res = await syncLead({ supabase: null, table: 'form_submissions', recordId: r.leadId || r.email, form: 'Contact', payload, repeatDetails: `LinkedIn form: ${r.formName || '-'}` });
  }
  if (res.ok) { res.action === 'insert' ? created++ : updated++; console.log(`${res.action}  ${r.email}  → ${res.id}`); }
  else { failed++; console.error(`FAILED ${r.email}: ${res.error}`); }
}
console.log(JSON.stringify({ file, rows: rows.length, created, updated, failed }));
process.exit(failed ? 1 : 0);
