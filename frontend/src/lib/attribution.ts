/**
 * First-touch traffic attribution sent by the browser with every form post.
 * Untrusted input: allow-list keys, cap length, strip control chars.
 */
export interface Attribution {
  utm_source?: string; utm_medium?: string; utm_campaign?: string;
  utm_term?: string; utm_content?: string;
  landing_page?: string; conversion_page?: string; referrer?: string;
  ga_client_id?: string;
}

const TEXT_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ga_client_id'] as const;
const URL_KEYS = ['landing_page', 'conversion_page', 'referrer'] as const;
const MAX = 200;

function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX);
  return s.length ? s : null;
}

function cleanUrl(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  return s.startsWith('/') || /^https?:\/\//i.test(s) ? s : null;
}

export function parseAttribution(input: unknown): Attribution {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const src = input as Record<string, unknown>;
  const out: Attribution = {};
  for (const k of TEXT_KEYS) { const v = clean(src[k]); if (v) out[k] = v; }
  for (const k of URL_KEYS) { const v = cleanUrl(src[k]); if (v) out[k] = v; }
  return out;
}
