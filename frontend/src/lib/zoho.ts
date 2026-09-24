/**
 * Minimal Zoho CRM v7 client for the website (Self Client refresh-token OAuth).
 * Never throws; every failure is an { ok:false, error } the caller logs. Each HTTP
 * exchange — headers AND body — must finish inside `timeoutMs` (8 s) because the
 * caller may be inside a visitor's request. See docs/runbooks/zoho-crm-website.md.
 *
 * Why find → create | update instead of Zoho's upsert: upsert writes every field of
 * the payload onto an existing Lead, so a repeat visit would reset Lead_Status,
 * Owner, Company and Description that sales had worked on (review finding 2026-09-24).
 */
export interface ZohoEnv { clientId?: string; clientSecret?: string; refreshToken?: string; accountsUrl?: string; apiUrl?: string; ownerId?: string }
export type Fail = { ok: false; skipped?: true; error: string };
export type IdResult = { ok: true; id: string } | Fail;
export type FindResult = { ok: true; id: string | null } | Fail;

const MARGIN_MS = 60_000;
const NOT_CONFIGURED: Fail = { ok: false, skipped: true, error: 'zoho not configured' };

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

  /** One HTTP exchange, fully read, under one timer. */
  async function exchange(url: string, init: RequestInit): Promise<{ status: number; json: any }> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(new Error(`zoho timeout after ${timeoutMs} ms`)), timeoutMs);
    try {
      const res = await doFetch(url, { ...init, signal: ctl.signal });
      if (res.status === 204) return { status: 204, json: null };
      const text = await res.text();
      let json: any = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 300) }; }
      return { status: res.status, json };
    } finally {
      clearTimeout(t);
    }
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt - MARGIN_MS > now()) return token.value;
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: env.clientId!, client_secret: env.clientSecret!, refresh_token: env.refreshToken! });
    const { status, json } = await exchange(`${accounts}/oauth/v2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (status < 200 || status >= 300 || !json?.access_token) throw new Error(`zoho token refresh failed: HTTP ${status} ${JSON.stringify(json).slice(0, 200)}`);
    token = { value: json.access_token, expiresAt: now() + Number(json.expires_in || 3600) * 1000 };
    return token.value;
  }

  async function api_(method: string, path: string, payload?: unknown): Promise<{ status: number; json: any }> {
    const at = await accessToken();
    return exchange(`${api}${path}`, {
      method,
      headers: { Authorization: `Zoho-oauthtoken ${at}`, ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
  }

  /** Record-level call: Zoho answers 200/201/202 with data[0].code even for failures. */
  async function recordCall(method: string, path: string, payload: unknown): Promise<any> {
    const { status, json } = await api_(method, path, payload);
    const rec = Array.isArray(json?.data) ? json.data[0] : null;
    if (status < 200 || status >= 300 || !rec || rec.code !== 'SUCCESS') {
      const summary = rec ? `${rec.code}: ${rec.message || ''} ${JSON.stringify(rec.details || {})}` : `HTTP ${status} ${JSON.stringify(json).slice(0, 300)}`;
      throw new Error(`zoho ${method} ${path} failed: ${summary}`);
    }
    return rec;
  }

  const fail = (e: unknown): Fail => ({ ok: false, error: (e as any)?.message || String(e) });

  return {
    enabled,
    ownerId: env.ownerId || '',

    /** COQL is real-time (unlike the search index), so a repeat seconds later is still found. */
    async findLeadByEmail(email: string): Promise<FindResult> {
      if (!enabled) return NOT_CONFIGURED;
      try {
        const safe = email.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const { status, json } = await api_('POST', '/crm/v7/coql', { select_query: `select id from Leads where Email = '${safe}' limit 1` });
        if (status === 204) return { ok: true, id: null };
        if (status < 200 || status >= 300) throw new Error(`zoho coql failed: HTTP ${status} ${JSON.stringify(json).slice(0, 300)}`);
        const id = json?.data?.[0]?.id;
        return { ok: true, id: id ? String(id) : null };
      } catch (e) { return fail(e); }
    },

    async createLead(insert: Record<string, unknown>): Promise<IdResult> {
      if (!enabled) return NOT_CONFIGURED;
      try {
        const rec = await recordCall('POST', '/crm/v7/Leads', { data: [insert], trigger: ['workflow'] });
        return { ok: true, id: String(rec.details.id) };
      } catch (e) { return fail(e); }
    },

    async updateLead(id: string, update: Record<string, unknown>): Promise<IdResult> {
      if (!enabled) return NOT_CONFIGURED;
      try {
        await recordCall('PUT', `/crm/v7/Leads/${encodeURIComponent(id)}`, { data: [update], trigger: ['workflow'] });
        return { ok: true, id };
      } catch (e) { return fail(e); }
    },

    async addTags(id: string, names: string[]): Promise<boolean> {
      if (!enabled || !names.length) return false;
      try {
        // v7 wants the tags in the body; over_write:false appends to the Lead's existing tags.
        await recordCall('POST', `/crm/v7/Leads/actions/add_tags?ids=${encodeURIComponent(id)}`, { tags: names.map((name) => ({ name })), over_write: false });
        return true;
      } catch (e) {
        console.error('[zoho] addTags failed:', (e as any)?.message || e);
        return false;
      }
    },

    async addNote(leadId: string, title: string, content: string): Promise<boolean> {
      if (!enabled) return false;
      try {
        await recordCall('POST', '/crm/v7/Notes', { data: [{ Note_Title: title.slice(0, 120), Note_Content: content.slice(0, 32000), Parent_Id: { module: { api_name: 'Leads' }, id: leadId } }] });
        return true;
      } catch (e) {
        console.error('[zoho] addNote failed:', (e as any)?.message || e);
        return false;
      }
    },
  };
}

export type ZohoClient = ReturnType<typeof createZohoClient>;

export const zoho = createZohoClient();
if (!zoho.enabled) console.warn('[zoho] ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN not set — website leads will not reach Zoho CRM');
