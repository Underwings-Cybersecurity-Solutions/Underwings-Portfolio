/**
 * Minimal Zoho CRM v7 client for the website: refresh-token OAuth (Self Client),
 * Leads upsert keyed on Email, and Notes. Never throws; every failure is an
 * { ok:false, error } the caller logs. Timeouts are hard (8 s) because this runs
 * inside the visitor's request. See docs/runbooks/zoho-crm-website.md.
 */
export interface ZohoEnv { clientId?: string; clientSecret?: string; refreshToken?: string; accountsUrl?: string; apiUrl?: string; ownerId?: string }
export type UpsertResult = { ok: true; id: string; action: 'insert' | 'update' } | { ok: false; skipped?: true; error: string };

const MARGIN_MS = 60_000;

export function envFromProcess(): ZohoEnv {
  const e = process.env;
  return {
    clientId: e.ZOHO_CLIENT_ID, clientSecret: e.ZOHO_CLIENT_SECRET, refreshToken: e.ZOHO_REFRESH_TOKEN,
    accountsUrl: e.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com', apiUrl: e.ZOHO_API_URL || 'https://www.zohoapis.com',
    ownerId: e.ZOHO_OWNER_ID,
  };
}

export function createZohoClient(opts: { env?: ZohoEnv; fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {}) {
  const env = opts.env ?? envFromProcess();
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const enabled = !!(env.clientId && env.clientSecret && env.refreshToken);
  const accounts = (env.accountsUrl || 'https://accounts.zoho.com').replace(/\/$/, '');
  const api = (env.apiUrl || 'https://www.zohoapis.com').replace(/\/$/, '');
  let token: { value: string; expiresAt: number } | null = null;

  async function call(url: string, init: RequestInit): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { return await doFetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt - MARGIN_MS > now()) return token.value;
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: env.clientId!, client_secret: env.clientSecret!, refresh_token: env.refreshToken! });
    const res = await call(`${accounts}/oauth/v2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw new Error(`zoho token refresh failed: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    token = { value: json.access_token, expiresAt: now() + Number(json.expires_in || 3600) * 1000 };
    return token.value;
  }

  async function post(path: string, payload: unknown): Promise<any> {
    const at = await accessToken();
    const res = await call(`${api}${path}`, { method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${at}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const json: any = await res.json().catch(() => ({}));
    const rec = Array.isArray(json.data) ? json.data[0] : null;
    if (!res.ok || !rec || rec.code !== 'SUCCESS') {
      const summary = rec ? `${rec.code}: ${rec.message || ''} ${JSON.stringify(rec.details || {})}` : `HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`;
      throw new Error(`zoho ${path} failed: ${summary}`);
    }
    return rec;
  }

  return {
    enabled,
    ownerId: env.ownerId || '',
    async upsertLead(lead: Record<string, unknown>): Promise<UpsertResult> {
      if (!enabled) return { ok: false, skipped: true, error: 'zoho not configured' };
      try {
        const rec = await post('/crm/v7/Leads/upsert', { data: [lead], duplicate_check_fields: ['Email'], trigger: ['workflow'] });
        return { ok: true, id: String(rec.details.id), action: rec.action === 'update' ? 'update' : 'insert' };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
    async addNote(leadId: string, title: string, content: string): Promise<boolean> {
      if (!enabled) return false;
      try {
        await post('/crm/v7/Notes', { data: [{ Note_Title: title.slice(0, 120), Note_Content: content.slice(0, 32000), Parent_Id: { module: { api_name: 'Leads' }, id: leadId } }] });
        return true;
      } catch (e: any) {
        console.error('[zoho] addNote failed:', e?.message || e);
        return false;
      }
    },
  };
}

export const zoho = createZohoClient();
if (!zoho.enabled) console.warn('[zoho] ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN not set — website leads will not reach Zoho CRM');
