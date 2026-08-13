// ===========================================
// UNDERWINGS — Sales Operations Console
// Auth gate (mandatory MFA) + console UX
// ===========================================

import { createClient } from '@supabase/supabase-js';
import Chart from 'chart.js/auto';

// ===========================================
// CLIENT
// ===========================================
const supabaseUrl = window.SUPABASE_URL || location.origin;
const supabaseKey = window.SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// ===========================================
// UTILITIES (ported verbatim from admin.js)
// ===========================================
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// esc() does not escape double-quotes, so it is unsafe inside `value="..."` (or any
// double-quoted) HTML attribute. Use this instead when interpolating free-text
// strings into a double-quoted attribute.
function escAttr(str) {
  return esc(str).replace(/"/g, '&quot;');
}

function formatDate(dateString) {
  if (!dateString) return '—';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// esc()/escAttr() treat 0 as falsy (ported quirk) — guard numeric fields that can
// legitimately be 0 (e.g. a comped deal) by stringifying null/undefined only.
function numOrEmpty(n) {
  return (n === null || n === undefined || n === '') ? '' : String(n);
}

function money(n) {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '—';
  return 'AED ' + Number(n).toLocaleString();
}

function toast(msg, kind = 'info') {
  const host = document.getElementById('crm-toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'success' ? ' toast--success' : kind === 'error' ? ' toast--error' : '');
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  }, 4200);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function daysSince(dateString) {
  if (!dateString) return 0;
  const ms = Date.now() - new Date(dateString).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

// Staleness reads crm_deals.last_activity_at (maintained by the
// crm_activities_touch_deal trigger), NOT updated_at — updated_at is bumped by
// any field edit, so a deal nobody has contacted in 40 days looked "fresh" the
// moment someone corrected its value. v_crm_stale_deals uses the same column,
// so the ⏳ badge and the Reports "Stale deals" tile can no longer disagree.
function dealLastActivity(d) { return d.last_activity_at || d.updated_at; }

function isStale(d) {
  if (d.status !== 'open') return false;
  const threshold = d.motion === 'software' ? 21 : 30;
  return daysSince(dealLastActivity(d)) > threshold;
}

function val(id) { return document.getElementById(id).value.trim(); }

// HTML5 drag-and-drop does not fire on touch, but the board still renders on
// tablets — so on a coarse pointer we drop the drag affordance entirely and
// point people at the drawer stepper, which does work there.
const CRM_COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;

function crmApplyDragHint() {
  const hint = document.querySelector('.toolbar-hint');
  if (!hint) return;
  hint.textContent = CRM_COARSE_POINTER
    ? 'Tap a card to open it, then pick a stage in the stepper.'
    : 'Drag cards to move a deal along the chain.';
}

function csvCell(v) {
  if (v == null) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function setOverlayOpen(el, open) {
  if (!el) return;
  el.classList.toggle('is-open', open);
  el.setAttribute('aria-hidden', open ? 'false' : 'true');
}

// Focus management for the drawer + modal dialogs: move focus into the dialog on
// open, trap Tab inside it, and restore focus to the opener on close (the ⌘K
// palette manages its own focus separately). Keeps the aria-modal contract honest
// and stops focus from being stranded on the obscured background.
const _overlayFocus = new Map();   // overlayId -> { prev, dialog, keyHandler }
function crmFocusables(root) {
  return Array.from(root.querySelectorAll(
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
  )).filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement);
}
function crmOverlayFocusIn(overlayId, dialogSel, firstSel) {
  const overlay = document.getElementById(overlayId);
  const dialog = overlay && overlay.querySelector(dialogSel);
  if (!dialog) return;
  if (_overlayFocus.has(overlayId)) {                 // already open, content re-rendered — keep focus inside
    if (!dialog.contains(document.activeElement)) dialog.focus();
    return;
  }
  const prev = document.activeElement;
  if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
  const keyHandler = (e) => {
    if (e.key !== 'Tab') return;
    const f = crmFocusables(dialog);
    if (!f.length) { e.preventDefault(); dialog.focus(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  dialog.addEventListener('keydown', keyHandler);
  _overlayFocus.set(overlayId, { prev, dialog, keyHandler });
  ((firstSel && dialog.querySelector(firstSel)) || dialog).focus();
}
function crmOverlayFocusOut(overlayId) {
  const st = _overlayFocus.get(overlayId);
  if (!st) return;
  st.dialog.removeEventListener('keydown', st.keyHandler);
  _overlayFocus.delete(overlayId);
  if (st.prev && document.contains(st.prev)) { try { st.prev.focus(); } catch (_) { /* opener gone */ } }
}

// Chart.js — dark-themed to the design tokens
Chart.defaults.color = cssVar('--muted') || '#8A97A6';
Chart.defaults.borderColor = cssVar('--line') || '#26313D';
Chart.defaults.font.family = 'Geist, system-ui, sans-serif';

// ===========================================
// STATE + CANONICAL STAGES (ported from admin.js Phase A)
// ===========================================
const CRM_STAGES = {
  services: ['new', 'contacted', 'scoping', 'proposal_sent', 'negotiation', 'won', 'lost'],
  software: ['new', 'requirements', 'quote_sent', 'po_pending', 'won', 'lost'],
};

const STAGE_LABELS = {
  new: 'Intake', contacted: 'Contacted', scoping: 'Scoping',
  proposal_sent: 'Proposal', negotiation: 'Negotiation', won: 'Won', lost: 'Lost',
  requirements: 'Requirements', quote_sent: 'Quote sent', po_pending: 'PO pending',
};
function stageLabel(stage) { return STAGE_LABELS[stage] || stage; }

let crmState = {
  view: 'pipeline',       // 'pipeline' | 'leadgen' | 'reports'
  motion: 'services',     // 'services' | 'software'
  search: '',
  stageFilter: '',        // '' = all stages (signal-chain toggle)
  layout: 'kanban',       // 'kanban' | 'list'
  deals: [],
  stageTotals: null,      // server-side per-stage figures (v_crm_stage_totals)
  prospects: [],          // loaded LeadGen page — the ⌘K palette searches these
  lg: {                   // LeadGen view: filters are server-side, not client-side
    service: '', status: '', geo: '',
    size: '',             // size_band value, or 'none' = unclassified (NULL)
    reach: '',            // 'email' = has at least one contact with an email
    followup: false,      // contacted 7+ days ago, no touch since — due a nudge
    kind: 'customer',     // 'customer' = LeadGen tab, 'partner' = Partners tab
    offset: 0, total: 0, stats: null, loading: false,
  },
  wl: {                   // Web Leads view: small tables, filtered client-side
    kind: '', rows: [], loading: false,
  },
  _openId: null,
};

// ===========================================
// CRM MEMBERS / DEAL OWNERSHIP
// Roster comes from the crm_members() RPC (id, email, role). We resolve owners
// client-side from this map — no owner join needed in the board/drawer queries.
// ===========================================
let crmMembers = [];              // [{id, email, role}]
let crmOwnerById = new Map();     // id -> {email, role, name, initials}
let crmMe = null;                 // current user's auth id (default owner for new deals)

function memberName(email) { return (email || '').split('@')[0] || 'user'; }
function memberInitials(email) {
  const local = (email || '').split('@')[0] || '';
  const parts = local.split(/[.\-_]+/).filter(Boolean);
  const s = parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return (s || '?').toUpperCase();
}
// Deterministic 0–5 palette slot from the user id, so an owner keeps one colour.
function avaSlot(id) {
  const s = String(id || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h % 6;
}
async function crmLoadMembers() {
  const { data, error } = await supabase.rpc('crm_members');
  if (error) { console.warn('[crm] members', error.message); crmMembers = []; }
  else crmMembers = data || [];
  crmOwnerById = new Map(crmMembers.map((m) => [m.id, {
    email: m.email, role: m.role, name: memberName(m.email), initials: memberInitials(m.email),
  }]));
}
function ownerAvatarHtml(ownerId) {
  const o = ownerId && crmOwnerById.get(ownerId);
  if (!o) return `<span class="ava ava--empty" title="Unassigned" aria-label="Unassigned">–</span>`;
  return `<span class="ava ava--o${avaSlot(ownerId)}" title="${escAttr(o.email)}" aria-label="Owner ${escAttr(o.name)}">${esc(o.initials)}</span>`;
}
function ownerCellHtml(ownerId) {
  const o = ownerId && crmOwnerById.get(ownerId);
  if (!o) return `<span class="muted">—</span>`;
  return `<span class="owner-cell">${ownerAvatarHtml(ownerId)}<span>${esc(o.name)}</span></span>`;
}
function ownerName(ownerId) {
  const o = ownerId && crmOwnerById.get(ownerId);
  return o ? o.name : 'Unassigned';
}
// <option> list for an owner <select>, with `selectedId` pre-selected.
function ownerOptionsHtml(selectedId) {
  const opts = [`<option value=""${selectedId ? '' : ' selected'}>Unassigned</option>`];
  for (const m of crmMembers) {
    const sel = m.id === selectedId ? ' selected' : '';
    opts.push(`<option value="${escAttr(m.id)}"${sel}>${esc(memberName(m.email))}${m.role === 'admin' ? ' · admin' : ''}</option>`);
  }
  return opts.join('');
}

// ===========================================
// DOM ELEMENTS (auth screens)
// ===========================================
const loginScreen = document.getElementById('login-screen');
const mfaScreen = document.getElementById('mfa-screen');
const appEl = document.getElementById('app');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const mfaForm = document.getElementById('mfa-form');
const mfaError = document.getElementById('mfa-error');
const mfaCodeInput = document.getElementById('mfa-code');
const mfaInstructions = document.getElementById('mfa-instructions');
const mfaEnrollBlock = document.getElementById('mfa-enroll');

// ===========================================
// AUTH — login, mandatory MFA enroll/verify
// ===========================================
let pendingMfaFactorId = null;

async function checkAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { showLogin(); return; }
  await afterAuthed();
}

function showLogin() {
  loginScreen.style.display = 'flex';
  mfaScreen.style.display = 'none';
  appEl.style.display = 'none';
}

function showLoginError(msg) {
  showLogin();
  loginError.textContent = msg;
}

async function showMfaEnroll() {
  loginScreen.style.display = 'none';
  appEl.style.display = 'none';
  mfaScreen.style.display = 'flex';
  mfaEnrollBlock.style.display = 'flex';
  mfaInstructions.textContent = 'Set up an authenticator app to continue — scan the QR code, then enter the 6-digit code.';
  mfaError.textContent = '';
  mfaCodeInput.value = '';
  try {
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Underwings CRM TOTP' });
    if (error) throw error;
    window.__mfaEnrollFactorId = data.id;
    document.getElementById('mfa-qr').src = data.totp.qr_code;
    mfaCodeInput.focus();
  } catch (err) {
    mfaError.textContent = err.message || 'Could not start two-factor setup. Refresh and try again.';
  }
}

async function showMfaVerify() {
  loginScreen.style.display = 'none';
  appEl.style.display = 'none';
  mfaScreen.style.display = 'flex';
  mfaEnrollBlock.style.display = 'none';
  mfaInstructions.textContent = 'Enter the 6-digit code from your authenticator app.';
  mfaError.textContent = '';
  mfaCodeInput.value = '';
  mfaCodeInput.focus();
  const { data: f } = await supabase.auth.mfa.listFactors();
  pendingMfaFactorId = f?.totp?.[0]?.id || null;
}

function showApp() {
  loginScreen.style.display = 'none';
  mfaScreen.style.display = 'none';
  appEl.style.display = 'flex';
}

async function afterAuthed() {
  const { data: { user: _me } } = await supabase.auth.getUser();
  const { data: me } = await supabase.from('crm_users').select('role').eq('id', _me.id).maybeSingle();
  if (!me) { await supabase.auth.signOut(); showLoginError("This account doesn't have CRM access. Ask an admin to add you."); return; }
  window.__crmRole = me.role;
  const { data: f } = await supabase.auth.mfa.listFactors();
  if (!f?.totp?.length) { showMfaEnroll(); return; }          // enrollment mandatory
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== 'aal2') { showMfaVerify(); return; }
  showApp();
  crmBoot();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await afterAuthed();
  } catch (err) {
    loginError.textContent = err.message || 'Sign-in failed. Check your email and password.';
  }
});

mfaForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  mfaError.textContent = '';
  const code = mfaCodeInput.value.trim();
  try {
    const factorId = window.__mfaEnrollFactorId || pendingMfaFactorId;
    if (!factorId) throw new Error('Your session expired. Please sign in again.');
    const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({ factorId });
    if (chErr) throw chErr;
    const { error } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
    if (error) throw error;
    const wasEnrolling = !!window.__mfaEnrollFactorId;
    window.__mfaEnrollFactorId = null;
    pendingMfaFactorId = null;
    if (wasEnrolling) toast('Two-factor authentication enabled.', 'success');
    await afterAuthed();
  } catch (err) {
    mfaError.textContent = err.message || 'Invalid code. Please try again.';
  }
});

async function doLogout() {
  await supabase.auth.signOut();
  location.reload();
}

function updateUserChip(user, role) {
  const chip = document.getElementById('crm-user');
  if (!chip) return;
  const email = user?.email || '';
  const name = email.split('@')[0] || 'operator';
  const initials = name.slice(0, 2).toUpperCase() || 'OP';
  const avatar = chip.querySelector('.userchip-avatar');
  const nameEl = chip.querySelector('.userchip-name');
  if (avatar) avatar.textContent = initials;
  if (nameEl) nameEl.textContent = role ? `${name} · ${role}` : name;
}

checkAuth();

// ===========================================
// BOOT + VIEW ROUTER
// ===========================================
async function crmBoot() {
  if (crmBoot._wired) { crmSwitchView(crmState.view); return; }
  crmBoot._wired = true;

  const { data: { user } } = await supabase.auth.getUser();
  crmMe = user?.id || null;
  updateUserChip(user, window.__crmRole);
  await crmLoadMembers();

  document.querySelector('.viewnav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-crm-view]'); if (!btn) return;
    crmSwitchView(btn.dataset.crmView);
  });

  let _searchT;
  document.getElementById('crm-search').addEventListener('input', (e) => {
    crmState.search = e.target.value;
    clearTimeout(_searchT);
    _searchT = setTimeout(() => {
      if (crmState.view === 'pipeline') crmLoadBoard();
      else if (LG_VIEW_KIND[crmState.view]) crmLoadLeadgen({ reset: true });
      else if (crmState.view === 'webleads') crmRenderWebleads();
    }, 250);
  });

  document.getElementById('crm-logout').addEventListener('click', doLogout);
  document.getElementById('crm-export-btn').addEventListener('click', crmExport);

  document.getElementById('crm-view-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn'); if (!btn) return;
    crmState.layout = btn.dataset.layout;
    crmApplyLayout();
  });

  document.getElementById('crm-pipeline-strip').addEventListener('click', (e) => {
    const seg = e.target.closest('.chain-seg'); if (!seg || !seg.dataset.stage) return;
    crmState.stageFilter = crmState.stageFilter === seg.dataset.stage ? '' : seg.dataset.stage;
    crmRenderStrip(crmState.deals);
    crmRenderKanban(crmState.deals);
    crmRenderList(crmState.deals);
  });

  crmWireBoardDnD();
  crmWireNewDeal();
  crmInjectMotionToggle();
  crmWireCmdk();
  crmApplyDragHint();

  document.querySelector('[data-crm-view-panel="pipeline"] .board-list').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    crmOpenDrawer(tr.dataset.id);
  });

  crmWireLeadgen();
  crmWireWebleads();
  crmWireLeadsMenu();
  crmLoadNavCounts({ force: true });

  document.querySelectorAll('[data-crm-close]').forEach((el) => el.addEventListener('click', () => {
    const drawer = el.closest('.drawer');
    const modal = el.closest('.modal');
    if (drawer) crmCloseDrawer();
    if (modal) closeModal(modal.id);
  }));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('crm-cmdk').classList.contains('is-open')) return;  // palette owns its own Esc
    const openModalEl = document.querySelector('.modal.is-open');
    if (openModalEl) { closeModal(openModalEl.id); return; }
    if (document.getElementById('crm-drawer').classList.contains('is-open')) crmCloseDrawer();
  });

  let _resizeT;
  window.addEventListener('resize', () => { clearTimeout(_resizeT); _resizeT = setTimeout(crmApplyLayout, 150); });

  crmSwitchView('pipeline');
}

function crmSwitchView(view) {
  crmState.view = view;
  document.querySelectorAll('.viewnav-btn').forEach((b) => {
    const active = b.dataset.crmView === view;
    b.classList.toggle('is-active', active);
    if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  crmSyncLeadsMenu(view);
  document.querySelectorAll('[data-crm-view-panel]').forEach((p) => {
    // a panel may serve more than one view (leadgen + partners share one)
    const active = p.dataset.crmViewPanel.split(/\s+/).includes(view);
    p.classList.toggle('is-active', active);
    p.hidden = !active;
  });
  if (view === 'pipeline') crmLoadBoard();
  else if (LG_VIEW_KIND[view]) {
    crmState.lg.kind = LG_VIEW_KIND[view];
    crmApplyLeadgenCopy();
    crmLoadLeadgen({ reset: true });
  } else if (view === 'webleads') crmLoadWebleads();
  else if (view === 'reports') crmLoadReports();
}

// ===========================================
// LEADS NAV MENU
// The four lead sources differ only in provenance, so they sit behind one
// trigger instead of four flat tabs. The items keep data-crm-view, so the
// delegated .viewnav click handler in crmBoot still routes them exactly like a
// flat tab did — this module owns only open/close, the active-child label on
// the trigger, and the counts.
// ===========================================
const LEADS_VIEWS = ['leadgen', 'partners', 'blead', 'vapt', 'webleads'];
const LEADS_LABEL = { leadgen: 'LeadGen', partners: 'Partners', blead: 'BLead', vapt: 'VAPT', webleads: 'Web Leads' };

function crmLeadsMenuEls() {
  return {
    wrap: document.getElementById('crm-leads-menu'),
    trigger: document.getElementById('crm-leads-trigger'),
    list: document.getElementById('crm-leads-list'),
  };
}

function crmLeadsMenuIsOpen() {
  const { list } = crmLeadsMenuEls();
  return !!list && !list.hidden;
}

function crmLeadsMenuOpen(open) {
  const { trigger, list } = crmLeadsMenuEls();
  if (!trigger || !list) return;
  list.hidden = !open;
  trigger.setAttribute('aria-expanded', String(open));
  if (!open) return;
  crmLoadNavCounts();
  const items = [...list.querySelectorAll('.viewnav-item')];
  const target = items.find((i) => i.classList.contains('is-active')) || items[0];
  if (target) target.focus();
}

// Keeps the trigger honest about where you are: "Leads" on its own, or
// "Leads · BLead" once one of the four is showing.
function crmSyncLeadsMenu(view) {
  const { trigger, list } = crmLeadsMenuEls();
  if (!trigger || !list) return;
  const inLeads = LEADS_VIEWS.includes(view);
  trigger.classList.toggle('is-active', inLeads);
  const label = trigger.querySelector('.viewnav-trigger-label');
  if (label) {
    label.innerHTML = inLeads
      ? `Leads <span class="viewnav-trigger-sub">· ${LEADS_LABEL[view]}</span>`
      : 'Leads';
  }
  list.querySelectorAll('.viewnav-item').forEach((it) => {
    const active = it.dataset.crmView === view;
    it.classList.toggle('is-active', active);
    if (active) it.setAttribute('aria-current', 'page'); else it.removeAttribute('aria-current');
  });
}

function crmWireLeadsMenu() {
  const { wrap, trigger, list } = crmLeadsMenuEls();
  if (!wrap || !trigger || !list) return;

  trigger.addEventListener('click', () => crmLeadsMenuOpen(!crmLeadsMenuIsOpen()));
  // the .viewnav delegate does the routing; we only collapse behind it
  list.addEventListener('click', (e) => {
    if (e.target.closest('[data-crm-view]')) crmLeadsMenuOpen(false);
  });

  // Escape is caught on the wrapper, not the document, so closing the menu
  // never also closes a drawer sitting behind it (the app-level Escape handler
  // in crmBoot runs modal -> drawer and can't tell the difference).
  wrap.addEventListener('keydown', (e) => {
    const open = crmLeadsMenuIsOpen();
    const items = [...list.querySelectorAll('.viewnav-item')];
    const i = items.indexOf(document.activeElement);

    if (e.key === 'Escape') {
      if (!open) return;
      e.preventDefault(); e.stopPropagation();
      crmLeadsMenuOpen(false); trigger.focus(); return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { crmLeadsMenuOpen(true); return; }
      const down = e.key === 'ArrowDown';
      const next = i === -1
        ? (down ? 0 : items.length - 1)
        : (down ? (i + 1) % items.length : (i - 1 + items.length) % items.length);
      if (items[next]) items[next].focus();
      return;
    }
    if (!open) return;
    if (e.key === 'Home') { e.preventDefault(); if (items[0]) items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); const l = items[items.length - 1]; if (l) l.focus(); }
  });

  document.addEventListener('click', (e) => {
    if (crmLeadsMenuIsOpen() && !wrap.contains(e.target)) crmLeadsMenuOpen(false);
  });
}

// Every count means the same thing: rows still worth acting on.
// The three prospect kinds come from ONE query — v_crm_leadgen_stats returns a
// row per kind (migration 014) and its `total` already excludes 'suppressed',
// so subtracting disqualified reproduces the "All open" default of
// crmLeadgenQuery exactly. Web Leads is two head-counts, summed the same way
// the view merges the two tables. A failed count is non-fatal: the menu keeps
// its labels and simply shows no number.
let crmNavCountsAt = 0;
const LG_KIND_VIEW = { customer: 'leadgen', partner: 'partners', blead: 'blead', vapt: 'vapt' };

async function crmLoadNavCounts({ force = false } = {}) {
  if (!force && Date.now() - crmNavCountsAt < 30000) return;
  crmNavCountsAt = Date.now();

  const set = (view, n) => {
    const el = document.querySelector(`[data-crm-count="${view}"]`);
    if (el) el.textContent = Number(n).toLocaleString();
  };

  try {
    const { data, error } = await supabase.from('v_crm_leadgen_stats').select('kind,total,by_status');
    if (error) throw error;
    for (const r of data || []) {
      const view = LG_KIND_VIEW[r.kind];
      if (!view) continue;
      const dq = Number((r.by_status || {}).disqualified || 0);
      set(view, Math.max(0, Number(r.total || 0) - dq));
    }
  } catch (e) {
    console.warn('[crm] nav counts (prospects)', e.message || e);
  }

  try {
    // lead_status is NOT NULL with a 'new' default on both tables, so a plain
    // neq is enough — no NULL branch needed.
    const openCount = (t) => supabase.from(t)
      .select('id', { count: 'exact', head: true })
      .neq('lead_status', 'closed');
    const [forms, subs] = await Promise.all([openCount('form_submissions'), openCount('subscribers')]);
    if (forms.error) throw forms.error;
    if (subs.error) throw subs.error;
    set('webleads', (forms.count || 0) + (subs.count || 0));
  } catch (e) {
    console.warn('[crm] nav counts (web leads)', e.message || e);
  }
}

function crmInjectMotionToggle() {
  // scoped to the pipeline panel: the LeadGen view has its own .toolbar
  const toolbar = document.querySelector('[data-crm-view-panel="pipeline"] .toolbar');
  if (!toolbar || document.getElementById('crm-motion-toggle')) return;
  const wrap = document.createElement('div');
  wrap.className = 'seg';
  wrap.id = 'crm-motion-toggle';
  wrap.setAttribute('role', 'tablist');
  wrap.setAttribute('aria-label', 'Motion');
  wrap.innerHTML = `
    <button type="button" class="seg-btn is-active" data-motion="services" aria-selected="true">Services</button>
    <button type="button" class="seg-btn" data-motion="software" aria-selected="false">Software</button>
  `;
  toolbar.insertBefore(wrap, toolbar.firstChild);
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn'); if (!btn) return;
    crmState.motion = btn.dataset.motion;
    crmState.stageFilter = '';
    wrap.querySelectorAll('.seg-btn').forEach((b) => {
      const active = b === btn;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
    crmLoadBoard();
  });
}

function crmApplyLayout() {
  const forcedList = window.matchMedia('(max-width:600px)').matches;
  const effective = forcedList ? 'list' : crmState.layout;
  document.getElementById('crm-board').hidden = effective !== 'kanban';
  document.querySelector('[data-crm-view-panel="pipeline"] .board-list').hidden = effective !== 'list';
  document.querySelectorAll('#crm-view-toggle .seg-btn').forEach((b) => {
    const active = b.dataset.layout === crmState.layout;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-selected', String(active));
  });
}

// ===========================================
// PIPELINE — load + presentation (Phase A query, new UX)
// ===========================================
const BOARD_PAGE_SIZE = 500;

// PostgREST can't filter a parent row by an embedded resource without an inner
// join (which would silently drop deals that have no company/contact). So we
// resolve matching company/contact ids first and fold them into the same .or()
// — the search box promises "deals, company, contact" and now actually does it.
async function crmSearchIdFilters(term) {
  const like = `%${term}%`;
  const [{ data: cos }, { data: cts }] = await Promise.all([
    supabase.from('crm_companies').select('id').or(`name.ilike.${like},domain.ilike.${like}`).limit(200),
    supabase.from('crm_contacts').select('id').or(`name.ilike.${like},email.ilike.${like}`).limit(200),
  ]);
  const parts = [`title.ilike.${like}`, `description.ilike.${like}`];
  if (cos?.length) parts.push(`company_id.in.(${cos.map((r) => r.id).join(',')})`);
  if (cts?.length) parts.push(`contact_id.in.(${cts.map((r) => r.id).join(',')})`);
  return parts.join(',');
}

async function crmLoadBoard() {
  crmRenderBoardSkeleton();

  // Strip totals come from v_crm_stage_totals (server-side aggregate over ALL
  // deals). Previously they were summed from the loaded page, so past 500 deals
  // the pipeline silently under-reported, and any active search rewrote the
  // totals to match the filter.
  const totalsP = supabase.from('v_crm_stage_totals').select('*').eq('motion', crmState.motion);

  let q = supabase.from('crm_deals')
    .select('*, crm_companies!company_id(name,domain), crm_contacts(name,email,phone,whatsapp_ok)')
    .eq('motion', crmState.motion)
    .order('updated_at', { ascending: false })
    .limit(BOARD_PAGE_SIZE);
  if (crmState.search) {
    const s = crmState.search.replace(/[%,()]/g, '').trim();
    if (s) q = q.or(await crmSearchIdFilters(s));
  }

  const [{ data, error }, { data: totals, error: totalsErr }] = await Promise.all([q, totalsP]);
  if (error) {
    console.error('[crm] load board', error);
    toast('Could not load the pipeline: ' + error.message, 'error');
    crmRenderBoardEmpty('The board could not be loaded. Try refreshing.');
    document.getElementById('crm-pipeline-strip').innerHTML = '';
    return;
  }
  if (totalsErr) console.warn('[crm] stage totals', totalsErr.message);
  crmState.deals = data || [];
  crmState.stageTotals = totals || null;
  crmRenderStrip(crmState.deals);
  crmRenderKanban(crmState.deals);
  crmRenderList(crmState.deals);
  crmApplyLayout();
  if (crmState.deals.length >= BOARD_PAGE_SIZE) {
    toast(`Showing the ${BOARD_PAGE_SIZE} most recently updated deals — narrow with search.`);
  }
}

function crmRenderBoardSkeleton() {
  document.getElementById('crm-pipeline-strip').innerHTML = Array.from({ length: 5 }).map(() => `
    <div class="chain-seg" style="cursor:default">
      <span class="skeleton skeleton-line w-40"></span>
      <span class="skeleton skeleton-line w-60"></span>
    </div>`).join('');
  document.getElementById('crm-board').innerHTML = Array.from({ length: 4 }).map(() => `
    <section class="kcol">
      <header class="kcol-head"><span class="skeleton skeleton-line w-40"></span></header>
      <div class="kcol-body">${'<div class="skeleton skeleton-card"></div>'.repeat(2)}</div>
    </section>`).join('');
}

function crmRenderBoardEmpty(msg) {
  document.getElementById('crm-board').innerHTML = `
    <div class="empty">
      <span class="empty-ico" aria-hidden="true">▚</span>
      <p>${esc(msg)}</p>
      <button type="button" class="btn btn-primary btn-sm" id="crm-empty-new">New deal</button>
    </div>`;
  const btn = document.getElementById('crm-empty-new');
  if (btn) btn.addEventListener('click', openNewDealModal);
}

// Per-stage count/value. With no search active these come from the server view
// (authoritative across every deal); while searching they're computed from the
// loaded rows so the strip and the board always describe the same set.
function crmStageFigures(deals) {
  const m = new Map();
  if (!crmState.search && Array.isArray(crmState.stageTotals)) {
    for (const r of crmState.stageTotals) {
      m.set(r.stage, { count: Number(r.deal_count) || 0, val: Number(r.value_aed) || 0 });
    }
  } else {
    for (const d of deals) {
      const e = m.get(d.stage) || { count: 0, val: 0 };
      e.count += 1;
      e.val += Number(d.value_aed) || 0;
      m.set(d.stage, e);
    }
  }
  return m;
}

function crmRenderStrip(deals) {
  const stages = CRM_STAGES[crmState.motion];
  const figures = crmStageFigures(deals);
  const totals = stages.map((s) => {
    const f = figures.get(s) || { count: 0, val: 0 };
    return { stage: s, count: f.count, val: f.val };
  });
  const maxVal = Math.max(1, ...totals.map((t) => t.val));
  document.getElementById('crm-pipeline-strip').innerHTML = totals.map((t) => {
    const active = crmState.stageFilter === t.stage;
    const wonClass = t.stage === 'won' ? ' chain-seg--won' : '';
    const pct = Math.round((t.val / maxVal) * 100);
    return `<button type="button" class="chain-seg${wonClass}${active ? ' is-active' : ''}" data-stage="${t.stage}" role="tab" aria-selected="${active}">
      <span class="chain-name">${esc(stageLabel(t.stage))}</span>
      <span class="chain-fig"><span class="chain-count mono">${t.count}</span><span class="chain-val mono">${money(t.val)}</span></span>
      <span class="chain-bar"><i style="width:${pct}%"></i></span>
    </button>`;
  }).join('');
}

function crmRenderKanban(deals) {
  const board = document.getElementById('crm-board');
  if (!deals.length) {
    crmRenderBoardEmpty('No deals yet in this motion. Create one to get the board moving.');
    return;
  }
  const stages = CRM_STAGES[crmState.motion];
  const figures = crmStageFigures(deals);
  board.innerHTML = stages.map((stage) => {
    const stageRows = deals.filter((d) => d.stage === stage);
    const visibleRows = (crmState.stageFilter && crmState.stageFilter !== stage) ? [] : stageRows;
    const f = figures.get(stage) || { count: 0, val: 0 };
    const count = f.count;
    const sumVal = f.val;
    const wonClass = stage === 'won' ? ' kcol--won' : '';
    const cardsHtml = visibleRows.map(dealCardHtml).join('');
    return `<section class="kcol${wonClass}" data-stage="${stage}">
      <header class="kcol-head">
        <span class="kcol-name">${esc(stageLabel(stage))}</span>
        <span class="kcol-meta"><span class="mono">${count}</span> · <span class="mono">${money(sumVal)}</span></span>
      </header>
      <div class="kcol-body">${cardsHtml}</div>
    </section>`;
  }).join('');
}

function dealCardHtml(d) {
  const motionClass = d.motion === 'software' ? 'software' : 'services';
  const wonClass = d.stage === 'won' ? ' dcard--won' : '';
  const stale = isStale(d);
  const staleClass = stale ? ' dcard--stale' : '';
  const co = esc(d.crm_companies?.name || '—');
  const pillClass = d.stage === 'won' ? 'pill--won' : `pill--${motionClass}`;
  const pillLabel = d.stage === 'won' ? 'Won' : (d.motion === 'software' ? 'Software' : 'Services');
  return `<article class="dcard dcard--${motionClass}${wonClass}${staleClass}" tabindex="0" role="button"${CRM_COARSE_POINTER ? '' : ' draggable="true"'} data-id="${escAttr(d.id)}">
    <span class="dcard-edge"></span>
    <div class="dcard-head">
      <span class="pill ${pillClass}">${pillLabel}</span>
      <span class="dcard-val mono">${money(d.value_aed)}</span>
    </div>
    <h3 class="dcard-title">${esc(d.title || 'Untitled deal')}</h3>
    <p class="dcard-co muted">${co}</p>
    <div class="dcard-foot">
      ${ownerAvatarHtml(d.owner_id)}
      ${dealChipHtml(d, stale)}
    </div>
  </article>`;
}

function dealChipHtml(d, stale) {
  if (d.stage === 'won') return `<span class="chip chip--won">Closed</span>`;
  if (d.stage === 'lost') return `<span class="chip" title="${escAttr(d.lost_reason || '')}">Lost</span>`;
  if (stale) {
    const days = daysSince(dealLastActivity(d));
    return `<span class="chip chip--stale mono" title="No activity for ${days} days">⏳ ${days}d</span>`;
  }
  if (d.next_action) return `<span class="chip chip--next">${esc(d.next_action)}</span>`;
  return `<span class="chip">No next step</span>`;
}

function crmRenderList(deals) {
  const tbody = document.querySelector('.board-list tbody');
  if (!tbody) return;
  const rows = crmState.stageFilter ? deals.filter((d) => d.stage === crmState.stageFilter) : deals;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">No deals to show.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((d) => `<tr data-id="${escAttr(d.id)}" style="cursor:pointer">
    <td>${esc(d.title || 'Untitled deal')}</td>
    <td>${esc(d.crm_companies?.name || '—')}</td>
    <td>${esc(stageLabel(d.stage))}</td>
    <td class="ta-r mono">${money(d.value_aed)}</td>
    <td>${ownerCellHtml(d.owner_id)}</td>
    <td>${d.next_action ? esc(d.next_action) : '—'}</td>
  </tr>`).join('');
}

function crmWireBoardDnD() {
  const board = document.getElementById('crm-board');
  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.dcard'); if (!card) return;
    e.dataTransfer.setData('text/plain', card.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('crm-card--dragging');
  });
  board.addEventListener('dragend', (e) => {
    const card = e.target.closest('.dcard'); if (card) card.classList.remove('crm-card--dragging');
  });
  board.addEventListener('dragover', (e) => {
    const col = e.target.closest('.kcol'); if (!col) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    col.classList.add('crm-col--dropzone');
  });
  board.addEventListener('dragleave', (e) => {
    const col = e.target.closest('.kcol'); if (!col) return;
    if (!col.contains(e.relatedTarget)) col.classList.remove('crm-col--dropzone');
  });
  board.addEventListener('drop', async (e) => {
    const col = e.target.closest('.kcol'); if (!col) return;
    e.preventDefault();
    col.classList.remove('crm-col--dropzone');
    const id = e.dataTransfer.getData('text/plain');
    const newStage = col.dataset.stage;
    if (!id || !newStage) return;
    const deal = crmState.deals.find((d) => d.id === id);
    if (deal && deal.stage === newStage) return;
    const { error } = await supabase.from('crm_deals').update({ stage: newStage }).eq('id', id);
    if (error) { toast('Move failed: ' + error.message, 'error'); return; }
    toast('Moved to ' + stageLabel(newStage), 'success');   // DB trigger logs the stage-change activity
    crmLoadBoard();
  });
  board.addEventListener('click', (e) => {
    const card = e.target.closest('.dcard'); if (!card) return;
    crmOpenDrawer(card.dataset.id);
  });
  board.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.dcard'); if (!card) return;
    e.preventDefault();
    crmOpenDrawer(card.dataset.id);
  });
}

// ===========================================
// DRAWER — deal detail (stepper + fields + activity feed)
// ===========================================
async function crmOpenDrawer(id) {
  if (!id) return;
  crmState._openId = id;
  const [{ data: d, error: dErr }, { data: acts }] = await Promise.all([
    supabase.from('crm_deals').select('*, crm_companies!company_id(name,domain), crm_contacts(name,email,phone,whatsapp_ok)').eq('id', id).single(),
    supabase.from('crm_activities').select('*').eq('deal_id', id).order('occurred_at', { ascending: false }),
  ]);
  if (dErr || !d) { toast('Could not open that deal.', 'error'); return; }
  let sig = null;
  if (d.contact_id) {
    const { data: s } = await supabase.from('v_crm_contact_signals').select('*').eq('contact_id', d.contact_id).maybeSingle();
    sig = s;
  }
  crmRenderDrawer(d, acts || [], sig);
  setOverlayOpen(document.getElementById('crm-drawer'), true);
  crmOverlayFocusIn('crm-drawer', '.drawer-panel');
}

function crmRenderDrawer(d, acts, sig) {
  const stages = CRM_STAGES[d.motion] || [];
  const fullIdx = stages.indexOf(d.stage);
  const motionClass = d.motion === 'software' ? 'software' : 'services';

  const badges = [];
  if (d.ai_score !== null && d.ai_score !== undefined) badges.push(`<span class="badge">Score <b class="mono">${esc(String(d.ai_score))}</b></span>`);
  if (d.stage === 'lost') {
    badges.push(`<span class="badge">Lost${d.lost_reason ? ': ' + esc(d.lost_reason) : ''}</span>`);
  } else if (isStale(d)) {
    badges.push(`<span class="badge badge--warn mono">⏳ ${daysSince(dealLastActivity(d))}d idle</span>`);
  }

  const waPhone = (d.crm_contacts?.phone || '').replace(/[^0-9]/g, '');
  const waLink = waPhone ? ` · <a href="https://wa.me/${escAttr(waPhone)}" class="link" target="_blank" rel="noopener">wa.me</a>` : '';
  const signalBits = [];
  if (sig?.is_subscriber) signalBits.push('newsletter subscriber');
  if (sig?.on_waitlist) signalBits.push('waitlist');
  const signalTxt = signalBits.length ? ` · ${esc(signalBits.join(' · '))}` : '';

  const stepperStages = stages.filter((s) => s !== 'lost');
  const stepperHtml = stepperStages.map((s) => {
    const sIdx = stages.indexOf(s);
    const done = fullIdx > sIdx;
    const current = s === d.stage;
    const wonMod = s === 'won' ? ' step--won' : '';
    const cls = `step${done ? ' is-done' : ''}${current ? ' is-current' : ''}${wonMod}`;
    return `<button type="button" class="${cls}" data-stage="${escAttr(s)}" ${current ? 'aria-current="step"' : ''}><span class="step-dot"></span>${esc(stageLabel(s))}</button>`;
  }).join('');

  const feedHtml = acts.length ? acts.map((a) => `
    <li class="feed-item ${feedItemClass(a.type)}">
      <span class="feed-ico" aria-hidden="true">${feedIcon(a.type)}</span>
      <div class="feed-body"><p>${esc(a.body || '')}</p><time class="mono">${formatDate(a.occurred_at)}</time></div>
    </li>`).join('') : `<li class="feed-item"><div class="feed-body"><p class="muted">No activity logged yet.</p></div></li>`;

  document.getElementById('crm-drawer-body').innerHTML = `
    <header class="drawer-head">
      <div class="drawer-eyebrow">
        <span class="pill pill--${motionClass}">${motionClass === 'software' ? 'Software' : 'Services'}</span>
        <span class="drawer-owner">${ownerAvatarHtml(d.owner_id)}<span class="mono">${esc(ownerName(d.owner_id))}</span></span>
      </div>
      <h2 class="drawer-title">${esc(d.title || 'Untitled deal')}</h2>
      <p class="drawer-sub muted">${esc(d.crm_companies?.name || '—')} · <span class="mono">${esc(d.crm_contacts?.name || d.crm_contacts?.email || '—')}</span>${waLink}${signalTxt}</p>
      ${badges.length ? `<div class="drawer-badges">${badges.join('')}</div>` : ''}
    </header>
    <nav class="stepper" aria-label="Stage">${stepperHtml}</nav>
    <div class="drawer-grid">
      <label class="field"><span>Value (AED)</span><input class="mono" id="dw-value" type="number" value="${escAttr(numOrEmpty(d.value_aed))}"></label>
      <label class="field"><span>Owner</span><select id="dw-owner">${ownerOptionsHtml(d.owner_id)}</select></label>
      <label class="field"><span>Billing</span><select id="dw-billing">
        <option value="one_off"${d.billing === 'monthly' ? '' : ' selected'}>One-off</option>
        <option value="monthly"${d.billing === 'monthly' ? ' selected' : ''}>Monthly</option>
      </select></label>
      <label class="field"><span>MRR (AED)</span><input class="mono" id="dw-mrr" type="number" value="${escAttr(numOrEmpty(d.mrr_aed))}"></label>
      <label class="field"><span>Next action</span><input id="dw-next" value="${escAttr(d.next_action || '')}"></label>
      <label class="field"><span>Next action date</span><input class="mono" id="dw-nextdate" type="date" value="${escAttr(d.next_action_date || '')}"></label>
      <label class="field"><span>Expected close</span><input class="mono" id="dw-close" type="date" value="${escAttr(d.expected_close_date || '')}"></label>
      <label class="field"><span>Renewal date</span><input class="mono" id="dw-renewal" type="date" value="${escAttr(d.renewal_date || '')}"></label>
      <label class="field"><span>Lost reason</span><input id="dw-lost" value="${escAttr(d.lost_reason || '')}"></label>
    </div>
    <button type="button" id="dw-save" class="btn btn-primary btn-block">Save changes</button>
    <section class="activity" style="margin-top:var(--sp-5)">
      <div class="activity-head"><h3>Activity</h3></div>
      <div class="quick-add">
        <input id="dw-activity-input" placeholder="Log a call, note, or next step…" aria-label="Add activity">
        <button type="button" id="dw-activity-add" class="btn btn-primary btn-sm">Add</button>
      </div>
      <ol class="feed">${feedHtml}</ol>
    </section>
  `;

  document.getElementById('dw-save').addEventListener('click', () => crmSaveDeal(d.id));
  document.getElementById('dw-owner').addEventListener('change', (e) => crmSetOwner(d.id, e.target.value || null));
  document.getElementById('dw-activity-add').addEventListener('click', () => crmAddActivity(d.id));
  const activityInput = document.getElementById('dw-activity-input');
  activityInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); crmAddActivity(d.id); } });
  document.querySelector('#crm-drawer-body .stepper').addEventListener('click', (e) => {
    const btn = e.target.closest('.step'); if (!btn || btn.classList.contains('is-current')) return;
    crmChangeStage(d.id, btn.dataset.stage);
  });
}

function feedItemClass(type) {
  if (type === 'call') return 'feed-item--call';
  if (type === 'email' || type === 'whatsapp') return 'feed-item--mail';
  if (type === 'stage_change' || type === 'system') return 'feed-item--stage';
  return '';
}
function feedIcon(type) {
  switch (type) {
    case 'call': return '☎';
    case 'email': return '✉';
    case 'whatsapp': return '✉';
    case 'meeting': return '◇';
    case 'stage_change': case 'system': return '▚';
    default: return '●';
  }
}

function crmCloseDrawer() {
  setOverlayOpen(document.getElementById('crm-drawer'), false);
  crmOverlayFocusOut('crm-drawer');
  crmState._openId = null;
}

async function crmChangeStage(id, newStage) {
  const { error } = await supabase.from('crm_deals').update({ stage: newStage }).eq('id', id);
  if (error) { toast('Stage change failed: ' + error.message, 'error'); return; }
  toast('Moved to ' + stageLabel(newStage), 'success');   // DB trigger logs the stage-change activity
  await crmOpenDrawer(id);
  if (crmState.view === 'pipeline') crmLoadBoard();
}

async function crmSetOwner(id, ownerId) {
  const { error } = await supabase.from('crm_deals').update({ owner_id: ownerId }).eq('id', id);
  if (error) { toast('Could not set owner: ' + error.message, 'error'); return; }
  toast(ownerId ? `Owner set to ${ownerName(ownerId)}.` : 'Owner cleared.', 'success');
  await crmOpenDrawer(id);
  if (crmState.view === 'pipeline') crmLoadBoard();
}

async function crmSaveDeal(id) {
  const patch = {
    value_aed: val('dw-value') || null,
    billing: val('dw-billing') || 'one_off',
    mrr_aed: val('dw-mrr') || null,
    next_action: val('dw-next') || null,
    next_action_date: val('dw-nextdate') || null,
    expected_close_date: val('dw-close') || null,
    renewal_date: val('dw-renewal') || null,
    lost_reason: val('dw-lost') || null,
  };
  const { error } = await supabase.from('crm_deals').update(patch).eq('id', id);
  if (error) { toast('Save failed: ' + error.message, 'error'); return; }
  toast('Deal updated.', 'success');
  crmCloseDrawer();
  if (crmState.view === 'pipeline') crmLoadBoard();
}

async function crmAddActivity(id) {
  const input = document.getElementById('dw-activity-input');
  const body = input.value.trim();
  if (!body) return;
  const { error } = await supabase.from('crm_activities').insert({ deal_id: id, type: 'note', body });
  if (error) { toast('Could not add activity: ' + error.message, 'error'); return; }
  toast('Activity logged.', 'success');
  await crmOpenDrawer(id);
}

// ===========================================
// LEADGEN — prospects found by the underwings-leadgen pipeline.
//
// The pipeline writes crm_prospects as service_role and owns every enrichment
// column. Migration 011 grants browser sessions UPDATE on (status, notes) only,
// so this view can offer exactly those two edits and nothing else — the UI and
// the grant agree by construction rather than by discipline.
// ===========================================
const LG_PAGE_SIZE = 100;
// Three tracks share this panel; the nav view name picks the kind column.
// blead = bulk-imported outbound lists (leadgen/import-blead.js), heuristic-
// scored rather than Claude-scored, but worked through the same filters.
const LG_VIEW_KIND = { leadgen: 'customer', partners: 'partner', blead: 'blead', vapt: 'vapt' };
const LG_SERVICES = ['GRC / ISO 27001', 'PTaaS / Pen Testing', 'Cloud Security',
  'Network & Infrastructure', 'Training & Awareness'];
// mirrors the crm_prospects status CHECK; 'promoted' is set by the RPC, not by hand
const LG_STATUSES = ['new', 'enriched', 'contacted', 'replied', 'qualified',
  'disqualified', 'promoted', 'suppressed'];
const LG_STATUS_LABELS = {
  new: 'New', enriched: 'Enriched', contacted: 'Contacted', replied: 'Replied',
  qualified: 'Qualified', disqualified: 'Disqualified', promoted: 'Promoted',
  suppressed: 'Suppressed',
};
// The row shows these ticks instead of a lifecycle dropdown: "have I tried
// this company, and how" is the question a small team can answer
// consistently, where 'qualified' vs 'replied' is a quiz nobody agrees on.
// Mail is deliberately separate from Msg (migration 017): Mail is the drafted
// cold email actually going out, Msg is the WhatsApp/SMS follow.
// Columns are sales-owned (migrations 016 + 017).
const LG_TOUCHES = [
  { col: 'touch_call',   label: 'Call',   title: 'Called' },
  { col: 'touch_mail',   label: 'Mail',   title: 'Cold email sent' },
  { col: 'touch_msg',    label: 'Msg',    title: 'WhatsApp or SMS sent' },
  { col: 'touch_li',     label: 'LI',     title: 'Reached out on LinkedIn' },
  { col: 'touch_follow', label: 'Follow', title: 'Follow-up done' },
];

// mirrors the crm_prospects size_band CHECK (migration 006); 'none' is the
// UI-only value for NULL — most pre-Apollo rows until the backfill lands
const LG_SIZES = [
  { value: 'sub30',      label: 'Sub-30' },
  { value: 'sme',        label: 'SME (30–250)' },
  { value: 'midmarket',  label: 'Mid-market (250–1000)' },
  { value: 'enterprise', label: 'Enterprise (1000+)' },
  { value: 'none',       label: 'Unclassified' },
];
const LG_SIZE_LABELS = { sub30: 'Sub-30', sme: 'SME', midmarket: 'Mid-market',
  enterprise: 'Enterprise' };
const LG_FOLLOWUP_DAYS = 7;

function clampScore(n) { n = Number(n) || 0; return Math.max(0, Math.min(100, n)); }

/** Fit is scored 1-10; the meter wants a percentage. */
function fitPct(score) { return clampScore((Number(score) || 0) * 10); }

function crmWireLeadgen() {
  const svc = document.getElementById('crm-lg-service');
  for (const s of LG_SERVICES) svc.insertAdjacentHTML('beforeend', `<option value="${escAttr(s)}">${esc(s)}</option>`);
  const st = document.getElementById('crm-lg-status');
  for (const s of LG_STATUSES) st.insertAdjacentHTML('beforeend', `<option value="${escAttr(s)}">${esc(LG_STATUS_LABELS[s])}</option>`);
  const sz = document.getElementById('crm-lg-size');
  for (const s of LG_SIZES) sz.insertAdjacentHTML('beforeend', `<option value="${escAttr(s.value)}">${esc(s.label)}</option>`);

  for (const [id, key] of [['crm-lg-service', 'service'], ['crm-lg-status', 'status'],
                           ['crm-lg-geo', 'geo'], ['crm-lg-size', 'size'],
                           ['crm-lg-reach', 'reach']]) {
    document.getElementById(id).addEventListener('change', (e) => {
      crmState.lg[key] = e.target.value;
      crmLoadLeadgen({ reset: true });
    });
  }
  // toggle chip, not a select: "what's due a nudge" is a mode you flip into.
  // While active it forces status=contacted, so grey the dropdown out.
  document.getElementById('crm-lg-followup').addEventListener('click', (e) => {
    const on = !crmState.lg.followup;
    crmState.lg.followup = on;
    e.currentTarget.setAttribute('aria-pressed', String(on));
    document.getElementById('crm-lg-status').disabled = on;
    crmLoadLeadgen({ reset: true });
  });
  document.getElementById('crm-lg-more').addEventListener('click', () => crmLoadLeadgen({ reset: false }));
  document.getElementById('crm-lg-export').addEventListener('click', crmExport);
  document.getElementById('crm-lg-run').addEventListener('click', crmLeadgenRunNow);

  // one delegated listener for the whole table — rows are re-rendered often
  document.getElementById('crm-lg-rows').addEventListener('click', (e) => {
    const promote = e.target.closest('[data-lg-promote]');
    if (promote) { crmPromoteProspect(promote.dataset.lgPromote); return; }
    const copy = e.target.closest('[data-lg-copy]');
    if (copy) { crmCopyOutreach(copy.dataset.lgCopy); return; }
    const open = e.target.closest('[data-lg-open]');
    if (open) crmOpenProspect(open.dataset.lgOpen);
  });
  document.getElementById('crm-lg-rows').addEventListener('change', (e) => {
    const box = e.target.closest('[data-lg-touch]');
    if (box) crmLeadgenSetTouch(box.dataset.lgTouch, box.dataset.lgTouchCol, box.checked, box);
  });
  // commit notes on blur rather than per keystroke
  document.getElementById('crm-lg-rows').addEventListener('focusout', (e) => {
    const inp = e.target.closest('[data-lg-notes]');
    if (inp && inp.value !== inp.dataset.lgOriginal) crmLeadgenSetNotes(inp.dataset.lgNotes, inp.value, inp);
  });

  // "Run now" mutates shared state and costs API budget — admins only. The
  // hide is cosmetic; crm_leadgen_request_run() enforces is_crm_admin().
  document.getElementById('crm-lg-run').hidden = window.__crmRole !== 'admin';
}

/** The two tracks share one panel, so the copy has to say which one you are
 * looking at — partners are collaborators, not people to sell to. */
function crmApplyLeadgenCopy() {
  const kind = crmState.lg.kind;
  const copy = {
    partner: {
      eyebrow: 'Collaboration',
      title: 'Firms worth partnering with',
      sub: 'MSPs, integrators, auditors and advisers whose clients need security work. Approach them as channel partners, not prospects.',
    },
    blead: {
      eyebrow: 'Imported list',
      title: 'Bulk-imported companies to work',
      sub: 'Imported outbound lists, heuristically ranked — highest scores have a named contact and a corporate inbox. Same filters, same play.',
    },
    vapt: {
      eyebrow: 'VAPT pipeline',
      title: 'UAE pen-testing buyers',
      sub: 'UAE companies that operate customer-facing software — fintech, e-commerce, SaaS, apps. Phone-first where a number exists; the LinkedIn link is there for the manual touch.',
    },
    customer: {
      eyebrow: 'Lead generation',
      title: 'Prospects worth a first move',
      sub: 'Scored against the Underwings ICP every day. Promote the ones you\'ll pursue.',
    },
  }[kind] || {};
  document.getElementById('crm-lg-eyebrow').textContent = copy.eyebrow || '';
  document.getElementById('crm-lg-title').textContent = copy.title || '';
  document.getElementById('crm-lg-sub').textContent = copy.sub || '';
}

/** Build the PostgREST query for the current filters. Shared by the table and
 * the CSV export so what you download is what you are looking at. */
function crmLeadgenQuery(select = '*') {
  const { service, status, geo, size, reach, followup } = crmState.lg;
  // "has an email" is a fact about the child table: an inner-join embed keeps
  // only prospects with ≥1 contact row carrying an email. The embed rides on
  // the select, so it must be decided before .select() is called. Known-dead
  // addresses (bounced, or on a domain with no mail route — the MX pass)
  // don't count as reachable: a prospect whose every email is 'invalid'
  // drops out of this filter.
  if (reach === 'email') select += ', reach:crm_prospect_contacts!inner(email,email_status)';
  let q = supabase.from('crm_prospects').select(select, { count: 'exact' })
    .eq('kind', crmState.lg.kind);
  if (reach === 'email') {
    q = q.not('reach.email', 'is', null)
         .or('email_status.neq.invalid,email_status.is.null', { referencedTable: 'reach' });
  }
  if (followup) {
    // due a nudge: contacted, and the last recorded touch is 7+ days old.
    // NULL last_outreach_at means contacted-but-never-stamped — due too.
    const cutoff = new Date(Date.now() - LG_FOLLOWUP_DAYS * 864e5).toISOString();
    q = q.eq('status', 'contacted')
         .or(`last_outreach_at.lt.${cutoff},last_outreach_at.is.null`);
  } else if (status) q = q.eq('status', status);
  // "All open" hides the two terminal states: suppressed (sales verdict) and
  // disqualified (the pipeline's size gate) — both stay reachable via Status
  else q = q.not('status', 'in', '("suppressed","disqualified")');
  if (service) q = q.eq('service', service);
  if (geo) q = q.eq('geo_bucket', geo);
  if (size === 'none') q = q.is('size_band', null);
  else if (size) q = q.eq('size_band', size);
  if (crmState.search) {
    const s = crmState.search.replace(/[%,()]/g, '');
    if (s) q = q.or(`company_name.ilike.%${s}%,domain.ilike.%${s}%,industry.ilike.%${s}%`);
  }
  return q.order('ai_score', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false });
}

async function crmLoadLeadgen({ reset = true } = {}) {
  if (crmState.lg.loading) return;
  crmState.lg.loading = true;
  if (reset) { crmState.lg.offset = 0; crmRenderLeadgenSkeleton(); }
  try {
    const from = crmState.lg.offset;
    const { data, error, count } = await crmLeadgenQuery().range(from, from + LG_PAGE_SIZE - 1);
    if (error) throw error;
    const rows = data || [];
    crmState.prospects = reset ? rows : crmState.prospects.concat(rows);
    crmState.lg.offset = from + rows.length;
    crmState.lg.total = count ?? crmState.prospects.length;
    crmRenderLeadgen(crmState.prospects);
    crmRenderLeadgenCount();
  } catch (e) {
    console.error('[crm] load leadgen', e);
    toast('Could not load prospects: ' + (e.message || 'Unknown error'), 'error');
    if (reset) crmRenderLeadgenEmpty();
  } finally {
    crmState.lg.loading = false;
  }
  crmLoadLeadgenStats();
}

async function crmLoadLeadgenStats() {
  // the view returns one row PER KIND (migration 014) — without the filter
  // this would be a multi-row response and maybeSingle() would error
  const { data, error } = await supabase.from('v_crm_leadgen_stats').select('*')
    .eq('kind', crmState.lg.kind).maybeSingle();
  if (error) { console.warn('[crm] leadgen stats', error.message); return; }
  crmState.lg.stats = data || null;
  crmRenderLeadgenStats(data);
}

function crmRenderLeadgenStats(s) {
  const host = document.getElementById('crm-lg-stats');
  if (!s) { host.innerHTML = ''; return; }
  const pct = (n) => (s.total ? Math.round((n / s.total) * 100) : 0);
  const lastRun = s.last_run_at
    ? `${formatDate(s.last_run_at)}${s.last_run_ok === false ? ' · failed' : ''}`
    : 'never';
  host.innerHTML = [
    { label: 'Prospects', num: s.total, meta: `${s.added_7d} added this week` },
    { label: 'With an email', num: s.with_email, meta: `${pct(s.with_email)}% of total` },
    { label: 'Named contacts', num: s.named_contacts, meta: `${pct(s.named_contacts)}% of total` },
    { label: 'Verified emails', num: s.verified_emails, meta: `${pct(s.verified_emails)}% of total` },
    { label: 'Avg fit', num: s.avg_score ?? '—', meta: 'out of 10', brand: true },
    { label: 'Promoted', num: s.promoted, meta: `last run ${lastRun}` },
  ].map((t) => `
    <div class="tile">
      <span class="tile-label">${esc(t.label)}</span>
      <span class="tile-num${t.brand ? ' tile-num--brand' : ''} mono">${esc(String(t.num ?? 0))}</span>
      <span class="tile-meta">${esc(t.meta)}</span>
    </div>`).join('');
}

function crmRenderLeadgenCount() {
  const shown = crmState.prospects.length;
  const total = crmState.lg.total;
  document.getElementById('crm-lg-count').textContent =
    total ? `Showing ${shown} of ${total}` : '';
  // no silent truncation: the button is the only way more rows arrive
  document.getElementById('crm-lg-more').hidden = shown >= total;
}

function crmRenderLeadgenSkeleton() {
  document.getElementById('crm-lg-rows').innerHTML = Array.from({ length: 6 }).map(() => `
    <tr><td colspan="9"><span class="skeleton skeleton-line w-60"></span></td></tr>`).join('');
}

function crmRenderLeadgenEmpty() {
  document.getElementById('crm-lg-rows').innerHTML = `
    <tr><td colspan="9">
      <div class="empty">
        <span class="empty-ico" aria-hidden="true">◇</span>
        <p>${crmState.lg.followup
          ? 'Nothing is due a follow-up — every contacted prospect was touched within the last week.'
          : 'No prospects match these filters. The leadgen pipeline adds new ones every day.'}</p>
      </div>
    </td></tr>`;
  document.getElementById('crm-lg-more').hidden = true;
}

function crmRenderLeadgen(rows) {
  const host = document.getElementById('crm-lg-rows');
  if (!rows.length) { crmRenderLeadgenEmpty(); return; }
  host.innerHTML = rows.map((p) => {
    const promoted = p.status === 'promoted';
    const where = [p.emirate, p.country].filter(Boolean)[0] || '—';
    const touches = LG_TOUCHES.map(({ col, label, title }) => `
      <label class="lg-touch" title="${escAttr(title)} — ${escAttr(p.company_name)}">
        <input type="checkbox" data-lg-touch="${escAttr(p.id)}" data-lg-touch-col="${col}"${p[col] ? ' checked' : ''}>
        <span>${esc(label)}</span>
      </label>`).join('');
    return `<tr data-id="${escAttr(p.id)}">
      <td>
        <button type="button" class="lg-co" data-lg-open="${escAttr(p.id)}">${esc(p.company_name)}</button>
        <span class="lg-domain mono">${esc(p.domain || '—')}</span>
      </td>
      <td>${p.service ? `<span class="pill pill--services">${esc(p.service)}</span>` : '<span class="muted">—</span>'}</td>
      <td class="ta-r">
        <span class="lg-fit"><i class="lg-fit-bar" style="--v:${fitPct(p.ai_score)}%"></i><span class="mono">${p.ai_score ?? '—'}</span></span>
      </td>
      <td>${esc(where)}</td>
      <td>${p.size_band
        ? `<span class="pill pill--muted">${esc(LG_SIZE_LABELS[p.size_band] || p.size_band)}</span>`
        : '<span class="muted">—</span>'}</td>
      <td class="lg-contact" data-lg-open="${escAttr(p.id)}"><span class="muted">View</span></td>
      <td class="lg-touches">${touches}</td>
      <td><input class="lg-notes" type="text" placeholder="Add a note…" aria-label="Notes for ${escAttr(p.company_name)}"
                 value="${escAttr(p.notes || '')}" data-lg-notes="${escAttr(p.id)}" data-lg-original="${escAttr(p.notes || '')}"></td>
      <td class="ta-r lg-actions">
        <button type="button" class="btn btn-sm lg-mail-btn" data-lg-copy="${escAttr(p.id)}"
                title="Copy cold email for ${escAttr(p.company_name)}" aria-label="Copy cold email for ${escAttr(p.company_name)}">✉</button>
        ${promoted
          ? '<span class="pill pill--muted">In pipeline</span>'
          : `<button type="button" class="btn btn-primary btn-sm" data-lg-promote="${escAttr(p.id)}">Promote</button>`}
      </td>
    </tr>`;
  }).join('');
  crmLeadgenFillContacts(rows);
}

/** Contacts live in a child table. One batched query for the whole page beats
 * a request per row; the highest-confidence contact wins. */
async function crmLeadgenFillContacts(rows) {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return;
  const { data, error } = await supabase.from('crm_prospect_contacts')
    .select('prospect_id,name,job_title,email,email_status,phone')
    .in('prospect_id', ids)
    .order('confidence', { ascending: false, nullsFirst: false });
  if (error) { console.warn('[crm] prospect contacts', error.message); return; }
  const best = new Map();
  const count = new Map();
  for (const c of data || []) {
    if (!best.has(c.prospect_id)) best.set(c.prospect_id, c);
    count.set(c.prospect_id, (count.get(c.prospect_id) || 0) + 1);
  }
  for (const row of document.querySelectorAll('#crm-lg-rows tr[data-id]')) {
    const c = best.get(row.dataset.id);
    const cell = row.querySelector('.lg-contact');
    if (!cell) continue;
    if (!c) { cell.innerHTML = '<span class="muted">—</span>'; continue; }
    const who = c.name || c.email || c.phone || '—';
    const sub = c.name ? (c.job_title || c.email || '') : '';
    // a company usually has several reachable addresses now; say so, because
    // the row can only show one and the rest are a click away in the drawer
    const extra = (count.get(row.dataset.id) || 1) - 1;
    cell.innerHTML = `<span class="lg-who">${esc(who)}</span>` +
      (sub ? `<span class="lg-domain">${esc(sub)}</span>` : '') +
      (c.email_status ? ` <span class="pill pill--muted lg-estatus">${esc(c.email_status)}</span>` : '') +
      (extra > 0 ? ` <span class="lg-more-c" title="${extra} more contact${extra > 1 ? 's' : ''}">+${extra}</span>` : '');
  }
}

// ---------- sales-owned mutations (only the granted columns are writable) ----------

/** Tick/untick one outreach box. Also advances `status` on the first touch so
 * the funnel still means something without anyone maintaining a dropdown —
 * but never downgrades a row that is already further along. */
async function crmLeadgenSetTouch(id, col, checked, box) {
  const row = crmState.prospects.find((p) => p.id === id);
  const patch = { [col]: checked };
  if (checked && row && (row.status === 'new' || row.status === 'enriched')) {
    patch.status = 'contacted';
  }
  const { error } = await supabase.from('crm_prospects').update(patch).eq('id', id);
  if (error) {
    toast('Could not save: ' + error.message, 'error');
    if (box) box.checked = !checked;          // put the tick back where it was
    return;
  }
  if (row) Object.assign(row, patch);
  crmLoadLeadgenStats();
}

async function crmLeadgenSetNotes(id, notes, input) {
  const { error } = await supabase.from('crm_prospects').update({ notes }).eq('id', id);
  if (error) {
    toast('Could not save note: ' + error.message, 'error');
    if (input) input.value = input.dataset.lgOriginal || '';
    return;
  }
  if (input) input.dataset.lgOriginal = notes;
  const row = crmState.prospects.find((p) => p.id === id);
  if (row) row.notes = notes;
  toast('Note saved.', 'success');
}

// ---------- cold-email drafts (outreach_subject/body — sales-owned, mig. 013) ----------
// The pipeline writes one AI draft per prospect (hook-led, personalised);
// sales edit here, copy, and send from their own mailbox.

/** Clipboard with a fallback for anything that blocks the async API. */
async function crmCopyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* denied */ }
    ta.remove();
    return ok;
  }
}

function crmOutreachSubject(p) {
  if (p.outreach_subject) return p.outreach_subject;
  const sector = (p.industry || '').trim();
  return `${sector ? sector.charAt(0).toUpperCase() + sector.slice(1) : 'Your'} security — worth 15 minutes?`;
}

/** Stored AI draft, or a client-side rendering of the fixed template
 * (2026-08-05 spec) for rows the pipeline hasn't backfilled yet. The
 * fallback deliberately does NOT use `why` — that column is written in
 * internal analyst voice ("no in-house security team") and must never be
 * pasted to a client verbatim. Keep this skeleton in sync with
 * leadgen/lib/outreach.js composeEmail(). */
function crmOutreachBody(p, contactName) {
  if (p.outreach_body) return p.outreach_body;
  const first = String(contactName || '').trim().split(/\s+/)[0] || '';
  const sector = (p.industry || '').trim().toLowerCase();
  const services = p.kind === 'partner'
    ? 'white-label security and compliance delivery for their clients'
    : p.kind === 'vapt'
      ? 'penetration testing — web, mobile and cloud'
      : (p.service || 'cybersecurity and compliance');
  const block = p.kind === 'partner'
    ? `Security and compliance requirements keep landing on firms like ${p.company_name}'s clients — work that sits outside what most teams deliver day to day. Handled on referral or white-label terms, it becomes revenue instead of something you turn away.`
    : p.kind === 'vapt'
      // VAPT rows are software-operating companies — the hook is their app
      // estate, not audit pressure. Same skeleton, pen-test-first angle.
      ? `Companies running customer-facing platforms in the UAE — payments, portals, apps — are exactly what attackers probe first, and what regulators and enterprise clients now expect to see tested. A scoped penetration test answers both without slowing your team down.`
      : `${sector ? sector.charAt(0).toUpperCase() + sector.slice(1) : 'UAE'} organisations are under growing audit and regulatory pressure — ISO 27001, UAE PDPL and sector frameworks — usually with a lean IT team carrying it. The gap tends to surface only when an audit, a client questionnaire, or an incident forces it.`;
  return `${first ? `Hi ${first},` : 'Hello,'}\n\n` +
    `Quick note from Underwings Cybersecurity Solutions. We work with ${sector || 'UAE'} organisations on ${services}.\n\n` +
    `${block}\n\n` +
    `I'm not asking you to switch anything. A 15-minute call, and I'll tell you honestly whether we're a fit.\n\n` +
    `Pick a slot that works: https://calendly.com/underwings1415/30min\n\n` +
    `If it's easier to look before you talk, I've attached our company profile and current service list, and our free assessment is open here: https://underwings.org/#contact\n\n` +
    `Regards,\n[YOUR NAME]\n[TITLE] | Underwings Cybersecurity Solutions\n+971 505670394 | https://underwings.org`;
}

/** Short nudge for the follow-up queue. Deliberately not AI-drafted: a
 * follow-up's job is to be brief and easy to answer, and the low-pressure
 * out ("a one-line not-now") is what gets replies from busy owners. */
function crmFollowupBody(p) {
  return 'Hello,\n\n' +
    `Floating my earlier note back to the top of your inbox — security work rarely makes the list until an audit, a client questionnaire or an incident forces it, and by then it's urgent.\n\n` +
    `If a 15-minute look at where ${p.company_name} stands would be useful, pick any slot: https://calendly.com/underwings1415/30min\n\n` +
    `And if now isn't the time, a one-line "not now" is genuinely helpful too.\n\n` +
    'Regards,\n[YOUR NAME]\n[TITLE] | Underwings Cybersecurity Solutions\n+971 505670394 | https://underwings.org';
}

async function crmCopyOutreach(id) {
  const p = crmState.prospects.find((r) => r.id === id);
  if (!p) return;
  // In follow-up mode the ✉ copies the nudge, not the original cold email.
  // Tick the Follow box after sending — that's what re-stamps the clock
  // (migration 019 trigger) and drops the row out of this queue.
  const followup = crmState.lg.followup;
  const ok = await crmCopyText(followup ? crmFollowupBody(p) : crmOutreachBody(p));
  toast(ok
    ? (followup
        ? `Follow-up for ${p.company_name} copied — send it, then tick Follow.`
        : `Cold email for ${p.company_name} copied — edit before sending.`)
    : 'Copy failed — open the prospect and copy from there.', ok ? 'success' : 'error');
}

async function crmSaveOutreach(id, subject, body) {
  const { error } = await supabase.from('crm_prospects')
    .update({ outreach_subject: subject, outreach_body: body }).eq('id', id);
  if (error) { toast('Could not save draft: ' + error.message, 'error'); return false; }
  const row = crmState.prospects.find((r) => r.id === id);
  if (row) { row.outreach_subject = subject; row.outreach_body = body; }
  toast('Draft saved.', 'success');
  return true;
}

async function crmLeadgenRunNow() {
  const btn = document.getElementById('crm-lg-run');
  btn.disabled = true;
  try {
    const { data, error } = await supabase.rpc('crm_leadgen_request_run');
    if (error) throw error;
    toast(data && data.queued === false
      ? 'A run is already queued.'
      : 'Run queued — the pipeline picks it up within a minute.', 'success');
  } catch (e) {
    toast('Could not queue a run: ' + (e.message || 'Unknown error'), 'error');
  } finally {
    btn.disabled = false;
  }
}

/** Prospect detail: everything the pipeline knows, including every contact —
 * this child table was previously never shown anywhere in the UI. */
async function crmOpenProspect(id) {
  const body = document.getElementById('crm-drawer-body');
  body.innerHTML = '<span class="skeleton skeleton-line w-60"></span>';
  setOverlayOpen(document.getElementById('crm-drawer'), true);
  crmOverlayFocusIn('crm-drawer', '.drawer-panel');
  try {
    const { data: p, error } = await supabase.from('crm_prospects').select('*').eq('id', id).single();
    if (error) throw error;
    const { data: contacts } = await supabase.from('crm_prospect_contacts')
      .select('*').eq('prospect_id', id).order('confidence', { ascending: false, nullsFirst: false });

    const talk = (p.talking_points || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // contacts arrive ordered by confidence — the mail link wants one WITH an email
    const bestContact = (contacts || []).find((c) => c.email) || (contacts || [])[0] || null;
    const mailPill = (s) => s === 'verified' ? 'pill--won' : s === 'invalid' ? 'pill--danger' : s === 'risky' ? 'pill--warn' : 'pill--muted';
    const contactHtml = (contacts || []).length ? (contacts || []).map((c) => `
      <li class="lg-person${bestContact && c.id === bestContact.id ? ' is-primary' : ''}">
        <div class="lg-person-top">
          <span class="lg-person-name">${esc(c.name || '(unnamed)')}${bestContact && c.id === bestContact.id ? ' <span class="pill pill--won">best</span>' : ''}</span>
          <span class="lg-domain">via ${esc(c.source || '—')}</span>
        </div>
        ${c.job_title ? `<span class="lg-person-title">${esc(c.job_title)}</span>` : ''}
        <div class="lg-person-ways">
          ${c.email ? `<a class="mono lg-person-mail" href="mailto:${escAttr(c.email)}">${esc(c.email)}</a>
            <span class="pill ${mailPill(c.email_status)}">${esc(c.email_status || 'unchecked')}</span>
            <button type="button" class="btn btn-sm" data-copy-email="${escAttr(c.email)}">Copy</button>` : '<span class="muted">No email found</span>'}
          ${c.phone ? `<a class="mono" href="tel:${escAttr(String(c.phone).replace(/[^+\d]/g, ''))}">${esc(c.phone)}</a>` : ''}
          ${c.linkedin_url ? `<a href="${escAttr(c.linkedin_url)}" rel="noopener noreferrer" target="_blank">LinkedIn ↗</a>` : ''}
        </div>
      </li>`).join('') : '<li class="muted">No contact found yet — the pipeline keeps looking.</li>';

    const statusPill = p.status === 'promoted' ? 'pill--won'
      : p.status === 'replied' || p.status === 'qualified' ? 'pill--services' : 'pill--muted';

    body.innerHTML = `
      <header class="drawer-head">
        <div class="drawer-eyebrow">
          <span class="eyebrow">${{ partner: 'Channel partner', blead: 'Imported prospect', vapt: 'VAPT prospect' }[p.kind] || 'LeadGen prospect'}</span>
          <span class="pill ${statusPill}">${esc(LG_STATUS_LABELS[p.status] || p.status || '—')}</span>
        </div>
        <h2 class="drawer-title">${esc(p.company_name)}</h2>
        <p class="drawer-sub muted">
          <span class="mono">${esc(p.domain || '—')}</span>
          ${[p.emirate, p.country].filter(Boolean).length ? `<span>· ${esc([p.emirate, p.country].filter(Boolean).join(', '))}</span>` : ''}
          ${p.website ? `<a href="${escAttr(p.website)}" rel="noopener noreferrer" target="_blank">Website ↗</a>` : ''}
        </p>
      </header>
      <div class="meters lgd-meters">
        <div class="meter"><span class="meter-label">Fit</span><span class="meter-track"><i class="meter-fill" style="--v:${fitPct(p.ai_score)}%"></i></span><span class="meter-num mono">${p.ai_score ?? '—'}</span></div>
        <div class="meter"><span class="meter-label">Gap</span><span class="meter-track"><i class="meter-fill" style="--v:${clampScore(p.gap_score)}%"></i></span><span class="meter-num mono">${p.gap_score ?? '—'}</span></div>
      </div>
      <section class="lgd-sec">
        <dl class="lg-facts">
          <dt>Service</dt><dd>${esc(p.service || '—')}</dd>
          <dt>Industry</dt><dd>${esc(p.industry || '—')}</dd>
          <dt>Size</dt><dd>${esc(p.size_band ? (LG_SIZE_LABELS[p.size_band] || p.size_band) : '—')}</dd>
          <dt>Company LinkedIn</dt><dd>${p.linkedin_url
            ? `<a href="${escAttr(p.linkedin_url)}" rel="noopener noreferrer" target="_blank">Open ↗</a>`
            : '—'}</dd>
          <dt>Source</dt><dd>${esc(p.source || '—')}</dd>
          <dt>Found</dt><dd>${esc(formatDate(p.created_at))}</dd>
          <dt>Last touch</dt><dd>${esc(p.last_outreach_at ? formatDate(p.last_outreach_at) : 'never')}</dd>
        </dl>
      </section>
      ${p.why || p.signal || talk.length ? `
      <section class="lgd-sec">
        <h3 class="lg-subhead">Why this prospect <span class="lgd-internal-tag">internal — don't paste</span></h3>
        <div class="lgd-internal">
          ${p.why ? `<p class="lg-why">${esc(p.why)}</p>` : ''}
          ${p.signal ? `<p class="lg-signal muted">Signal: ${esc(p.signal)}</p>` : ''}
          ${talk.length ? `<ul class="talk">${talk.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        </div>
      </section>` : ''}
      <section class="lgd-sec">
        <h3 class="lg-subhead">Contacts (${(contacts || []).length})</h3>
        <ul class="lg-people">${contactHtml}</ul>
      </section>
      <section class="lgd-sec">
        <h3 class="lg-subhead">${p.kind === 'partner' ? 'Outreach email' : 'Cold email'}</h3>
        <div class="lg-mail">
          <label class="lg-mail-label" for="lg-mail-subject">Subject</label>
          <input id="lg-mail-subject" class="lg-mail-subject" type="text"
                 value="${escAttr(crmOutreachSubject(p))}">
          <label class="lg-mail-label" for="lg-mail-body">Body</label>
          <textarea id="lg-mail-body" class="lg-mail-body" rows="14">${esc(crmOutreachBody(p, bestContact && bestContact.name))}</textarea>
          <div class="lg-mail-actions">
            <button type="button" class="btn btn-primary btn-sm" id="lg-mail-copy">Copy body</button>
            <button type="button" class="btn btn-sm" id="lg-mail-copy-subject">Copy subject</button>
            <button type="button" class="btn btn-sm" id="lg-mail-save">Save draft</button>
            ${bestContact && bestContact.email
              ? `<a class="btn btn-sm" id="lg-mail-open" href="#">Email ${esc(bestContact.email)}</a>` : ''}
          </div>
          <p class="muted lg-mail-hint">${p.outreach_body
            ? 'Drafted for this prospect. Replace [YOUR NAME] and [TITLE] with your own details, attach the company profile, and send from your own mailbox.'
            : 'Standard template — the pipeline drafts a personalised one on its next cycle.'}</p>
        </div>
      </section>
      <footer class="lgd-foot">
        <div class="lgd-touches" role="group" aria-label="Outreach touches">
          ${LG_TOUCHES.map((t) => `
            <label class="lgd-touch" title="${escAttr(t.title)}">
              <input type="checkbox" data-lgd-touch="${t.col}" ${p[t.col] ? 'checked' : ''}>
              <span>${t.label}</span>
            </label>`).join('')}
        </div>
        ${p.status === 'promoted'
          ? '<span class="pill pill--won">In pipeline</span>'
          : `<button type="button" class="btn btn-primary btn-sm" id="lgd-promote">Promote to pipeline</button>`}
      </footer>`;

    const subjEl = document.getElementById('lg-mail-subject');
    const bodyEl = document.getElementById('lg-mail-body');
    const PLACEHOLDER_RE = /\[YOUR NAME\]|\[TITLE\]/;
    document.getElementById('lg-mail-copy').addEventListener('click', async () => {
      const ok = await crmCopyText(bodyEl.value);
      if (!ok) { toast('Copy failed.', 'error'); return; }
      toast(PLACEHOLDER_RE.test(bodyEl.value)
        ? 'Body copied — replace [YOUR NAME] and [TITLE] before sending.'
        : 'Email body copied.', 'success');
    });
    document.getElementById('lg-mail-copy-subject').addEventListener('click', async () => {
      const ok = await crmCopyText(subjEl.value);
      toast(ok ? 'Subject copied.' : 'Copy failed.', ok ? 'success' : 'error');
    });
    document.getElementById('lg-mail-save').addEventListener('click', () =>
      crmSaveOutreach(id, subjEl.value.trim(), bodyEl.value.trim()));
    const mailLink = document.getElementById('lg-mail-open');
    if (mailLink) {
      // href is built at click time so edits (even unsaved ones) are included
      mailLink.addEventListener('click', () => {
        if (PLACEHOLDER_RE.test(bodyEl.value)) toast('Replace [YOUR NAME] and [TITLE] before sending.', 'success');
        mailLink.href = `mailto:${encodeURIComponent(bestContact.email)}` +
          `?subject=${encodeURIComponent(subjEl.value)}&body=${encodeURIComponent(bodyEl.value)}`;
      });
    }
    // per-contact email copy
    body.querySelector('.lg-people').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-copy-email]');
      if (!btn) return;
      const ok = await crmCopyText(btn.dataset.copyEmail);
      toast(ok ? `${btn.dataset.copyEmail} copied.` : 'Copy failed.', ok ? 'success' : 'error');
    });
    // touches sync straight back to the table + stat tiles
    body.querySelector('.lgd-touches').addEventListener('change', async (e) => {
      const box = e.target.closest('[data-lgd-touch]');
      if (!box) return;
      await crmLeadgenSetTouch(id, box.dataset.lgdTouch, box.checked, box);
      crmRenderLeadgen(crmState.prospects);
    });
    const promoteBtn = document.getElementById('lgd-promote');
    if (promoteBtn) {
      promoteBtn.addEventListener('click', async () => {
        promoteBtn.disabled = true;
        await crmPromoteProspect(id);
        crmCloseDrawer();
      });
    }
  } catch (e) {
    body.innerHTML = `<p class="muted">Could not load this prospect: ${esc(e.message || 'Unknown error')}</p>`;
  }
}

// ===========================================
// WEB LEADS VIEW
// Inbound from the website, merged from two tables: form_submissions
// (contact/quote forms) and subscribers (newsletter + lead_magnet checklist
// downloads). Both are small (dozens of rows), so they're fetched whole and
// filtered client-side. Browser sessions may only write lead_status +
// admin_notes (column grants, migration 018) — mirrored in the controls.
// ===========================================
const WL_KINDS = [
  { key: '', label: 'All' },
  { key: 'contact', label: 'Contact' },
  { key: 'quote', label: 'Quote' },
  { key: 'resource', label: 'Resources' },
  { key: 'newsletter', label: 'Newsletter' },
];
const WL_STATUSES = ['new', 'reviewed', 'contacted', 'closed'];
const WL_KIND_PILL = { contact: 'pill--services', quote: 'pill--software', resource: 'pill--warn', newsletter: 'pill--muted' };

/** A lead_magnet:* subscription is a resource download; everything else on
 * subscribers is a newsletter signup. form_submissions carries its own type. */
function wlKindOf(row) {
  if (row._table === 'subscribers') {
    return String(row.subscription_source || '').startsWith('lead_magnet') ? 'resource' : 'newsletter';
  }
  return row.form_type || 'contact';
}

/** Human label for what a subscriber actually downloaded. */
function wlResourceName(source) {
  return String(source || '').replace(/^lead_magnet:/, '').replace(/-/g, ' ');
}

function crmWireWebleads() {
  const kinds = document.getElementById('crm-wl-kinds');
  kinds.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn'); if (!btn) return;
    crmState.wl.kind = btn.dataset.wlKind;
    crmRenderWebleads();
  });
  const rows = document.getElementById('crm-wl-rows');
  rows.addEventListener('click', (e) => {
    if (e.target.closest('select,input,a,button')) return;
    const tr = e.target.closest('tr[data-wl-open]');
    if (tr) crmOpenWeblead(tr.dataset.wlOpen);
  });
  rows.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-wl-status]');
    if (sel) crmWebleadUpdate(sel.dataset.wlStatus, { lead_status: sel.value }, sel);
  });
  rows.addEventListener('focusout', (e) => {
    const inp = e.target.closest('[data-wl-notes]');
    if (inp && inp.value !== inp.dataset.wlOriginal) {
      crmWebleadUpdate(inp.dataset.wlNotes, { admin_notes: inp.value }, inp);
    }
  });
}

async function crmLoadWebleads() {
  if (crmState.wl.loading) return;
  crmState.wl.loading = true;
  document.getElementById('crm-wl-rows').innerHTML =
    '<tr><td colspan="6"><span class="skeleton skeleton-line w-60"></span></td></tr>';
  try {
    const [subs, forms] = await Promise.all([
      supabase.from('subscribers').select('*').order('created_at', { ascending: false }).limit(1000),
      supabase.from('form_submissions').select('*').order('created_at', { ascending: false }).limit(1000),
    ]);
    if (forms.error) throw forms.error;
    if (subs.error) throw subs.error;
    const rows = [
      ...(forms.data || []).map((r) => ({ ...r, _table: 'form_submissions' })),
      ...(subs.data || []).map((r) => ({ ...r, _table: 'subscribers' })),
    ];
    rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    crmState.wl.rows = rows;
    crmRenderWebleads();
  } catch (e) {
    console.error('[crm] load webleads', e);
    toast('Could not load web leads: ' + (e.message || 'Unknown error'), 'error');
    document.getElementById('crm-wl-rows').innerHTML =
      '<tr><td colspan="6" class="muted">Could not load web leads — retry from the Web Leads tab.</td></tr>';
  } finally {
    crmState.wl.loading = false;
  }
}

function crmWebleadVisible() {
  const s = (crmState.search || '').trim().toLowerCase();
  return crmState.wl.rows.filter((r) => {
    if (crmState.wl.kind && wlKindOf(r) !== crmState.wl.kind) return false;
    if (!s) return true;
    return [r.name, r.email, r.company, r.message, r.subscription_source]
      .some((v) => v && String(v).toLowerCase().includes(s));
  });
}

function crmRenderWebleads() {
  const visible = crmWebleadVisible();

  const counts = {};
  for (const r of crmState.wl.rows) counts[wlKindOf(r)] = (counts[wlKindOf(r)] || 0) + 1;
  document.getElementById('crm-wl-kinds').innerHTML = WL_KINDS.map((k) => `
    <button type="button" class="seg-btn${crmState.wl.kind === k.key ? ' is-active' : ''}"
            data-wl-kind="${k.key}" aria-selected="${crmState.wl.kind === k.key}">
      ${k.label} <span class="mono">${k.key ? counts[k.key] || 0 : crmState.wl.rows.length}</span>
    </button>`).join('');

  document.getElementById('crm-wl-count').textContent =
    `${visible.length} of ${crmState.wl.rows.length} leads`;

  document.getElementById('crm-wl-rows').innerHTML = visible.length ? visible.map((r) => {
    const kind = wlKindOf(r);
    const who = r._table === 'subscribers'
      ? `<span class="mono">${esc(r.email)}</span>`
      : `<strong>${esc(r.name || '—')}</strong><br><span class="mono muted">${esc(r.email)}</span>${r.company ? `<br><span class="muted">${esc(r.company)}</span>` : ''}`;
    const msg = r._table === 'subscribers'
      ? (kind === 'resource' ? `Downloaded: ${esc(wlResourceName(r.subscription_source))}` : 'Newsletter signup')
      : esc((r.message || r.service_interest || '—').slice(0, 140));
    const key = `${r._table}:${r.id}`;
    return `
    <tr data-wl-open="${escAttr(key)}" tabindex="0">
      <td class="mono">${esc(formatDate(r.created_at))}</td>
      <td><span class="pill ${WL_KIND_PILL[kind] || 'pill--muted'}">${esc(kind)}</span></td>
      <td>${who}</td>
      <td class="wl-msg">${msg}</td>
      <td>
        <select class="wl-status" data-wl-status="${escAttr(key)}" aria-label="Lead status">
          ${WL_STATUSES.map((s) => `<option value="${s}"${(r.lead_status || 'new') === s ? ' selected' : ''}>${s}</option>`).join('')}
        </select>
      </td>
      <td><input class="wl-notes" type="text" value="${escAttr(r.admin_notes || '')}"
                 data-wl-notes="${escAttr(key)}" data-wl-original="${escAttr(r.admin_notes || '')}"
                 placeholder="Add a note…" aria-label="Notes"></td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="muted">No web leads match — clear the search or pick another type.</td></tr>';
}

function crmWebleadFind(key) {
  const [table, id] = String(key).split(/:(.+)/);
  return crmState.wl.rows.find((r) => r._table === table && String(r.id) === id) || null;
}

async function crmWebleadUpdate(key, patch, el) {
  const row = crmWebleadFind(key);
  if (!row) return;
  const { error } = await supabase.from(row._table).update(patch).eq('id', row.id);
  if (error) {
    toast('Could not save: ' + error.message, 'error');
    crmRenderWebleads();   // snap the control back to stored state
    return;
  }
  Object.assign(row, patch);
  if (el && 'wlOriginal' in el.dataset) el.dataset.wlOriginal = el.value;
  toast('Saved.', 'success');
}

/** Web-lead detail drawer: the full message plus every qualifying field the
 * form captured, with copy/mailto — triage stays in the table row. */
function crmOpenWeblead(key) {
  const r = crmWebleadFind(key);
  if (!r) return;
  const kind = wlKindOf(r);
  const body = document.getElementById('crm-drawer-body');
  const facts = r._table === 'subscribers'
    ? [['Source', kind === 'resource' ? wlResourceName(r.subscription_source) : 'Newsletter'],
       ['Subscribed', r.subscribed ? 'yes' : 'unsubscribed'],
       ['Received', formatDate(r.created_at)]]
    : [['Service interest', r.service_interest], ['Budget', r.budget_range],
       ['Timeline', r.timeline], ['Heard via', r.how_heard], ['Phone', r.phone],
       ['Received', formatDate(r.created_at)]];
  body.innerHTML = `
    <header class="drawer-head">
      <div class="drawer-eyebrow">
        <span class="eyebrow">Web lead</span>
        <span class="pill ${WL_KIND_PILL[kind] || 'pill--muted'}">${esc(kind)}</span>
      </div>
      <h2 class="drawer-title">${esc(r.name || r.email)}</h2>
      <p class="drawer-sub muted">
        <span class="mono">${esc(r.email)}</span>
        ${r.company ? `<span>· ${esc(r.company)}</span>` : ''}
      </p>
    </header>
    <section class="lgd-sec">
      <dl class="lg-facts">
        ${facts.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
      </dl>
    </section>
    ${r.message ? `
    <section class="lgd-sec">
      <h3 class="lg-subhead">Message</h3>
      <p class="wl-message">${esc(r.message)}</p>
    </section>` : ''}
    <section class="lgd-sec">
      <div class="lg-mail-actions">
        <a class="btn btn-primary btn-sm" href="mailto:${escAttr(r.email)}">Reply by email</a>
        <button type="button" class="btn btn-sm" id="wl-copy-email">Copy email</button>
      </div>
    </section>`;
  document.getElementById('wl-copy-email').addEventListener('click', async () => {
    const ok = await crmCopyText(r.email);
    toast(ok ? `${r.email} copied.` : 'Copy failed.', ok ? 'success' : 'error');
  });
  setOverlayOpen(document.getElementById('crm-drawer'), true);
  crmOverlayFocusIn('crm-drawer', '.drawer-panel');
}

// ---------- Intake (shared by Promote + New Deal, and by the website forms) ----------
// One atomic server-side upsert instead of the old read-then-insert pair, which
// created a duplicate company whenever no domain was supplied and raised a
// unique-violation when two writers raced on the same domain.
async function crmIntake(payload) {
  const { data, error } = await supabase.rpc('crm_intake', { payload });
  if (error) throw error;
  return data || {};
}

// Promote runs entirely server-side (crm_prospect_promote, migration 011).
// The old client-side version called crm_intake and then PATCHed the prospect
// in a second, unchecked round trip: if that PATCH failed you got a deal with
// no back-link and a prospect that still looked unpromoted. Both writes now
// share one transaction, and the best contact is chosen in SQL.
async function crmPromoteProspect(id) {
  try {
    const { data, error } = await supabase.rpc('crm_prospect_promote', { p_prospect_id: id });
    if (error) throw error;
    toast(data && data.created === false ? 'Already in the pipeline.' : 'Promoted to pipeline', 'success');
    crmLoadLeadgen({ reset: true });
    crmLoadNavCounts({ force: true });   // a promote moves a row out of "open"
  } catch (e) {
    toast('Promote failed: ' + (e.message || 'Unknown error'), 'error');
  }
}

// ===========================================
// NEW DEAL MODAL
// ===========================================
function openModal(id) {
  setOverlayOpen(document.getElementById(id), true);
  crmOverlayFocusIn(id, '.modal-card', 'input:not([disabled]),select:not([disabled]),textarea:not([disabled])');
}
function closeModal(id) {
  setOverlayOpen(document.getElementById(id), false);
  crmOverlayFocusOut(id);
}

function crmWireNewDeal() {
  document.getElementById('crm-new-deal-btn').addEventListener('click', openNewDealModal);
  document.getElementById('nd-save').addEventListener('click', crmNewDeal);
}

function openNewDealModal() {
  ['nd-title', 'nd-company', 'nd-domain', 'nd-email', 'nd-name', 'nd-value'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('nd-motion').value = crmState.motion;
  document.getElementById('nd-owner').innerHTML = ownerOptionsHtml(crmMe);   // default: me
  openModal('crm-newdeal-modal');
}

async function crmNewDeal() {
  const btn = document.getElementById('nd-save');
  btn.disabled = true;                                   // no double-submit
  try {
    await crmIntake({
      company_name: val('nd-company'), domain: val('nd-domain'),
      email: val('nd-email'), contact_name: val('nd-name'),
      title: val('nd-title') || 'Untitled', motion: val('nd-motion'), stage: 'new',
      value_aed: val('nd-value') || null, source: 'other',
      owner_id: document.getElementById('nd-owner').value || null,
    });
    closeModal('crm-newdeal-modal');
    toast('Deal created.', 'success');
    if (crmState.view === 'pipeline') crmLoadBoard();
  } catch (e) {
    toast('Create failed: ' + (e.message || 'Unknown error'), 'error');
  } finally {
    btn.disabled = false;
  }
}

// ===========================================
// REPORTS — scoreboard + pipeline chart (Phase A count-based reads)
// ===========================================
function crmRenderReportsSkeleton() {
  document.getElementById('crm-scoreboard').innerHTML = Array.from({ length: 7 }).map(() => `
    <div class="tile">
      <span class="skeleton skeleton-line w-60"></span>
      <span class="skeleton skeleton-line w-40"></span>
    </div>`).join('');
}

function crmRenderReportsError(msg) {
  document.getElementById('crm-scoreboard').innerHTML = `
    <div class="empty">
      <span class="empty-ico" aria-hidden="true">▟</span>
      <p>${esc(msg)}</p>
    </div>`;
  if (crmPipelineChart) { crmPipelineChart.destroy(); crmPipelineChart = null; }
}

async function crmLoadReports() {
  // Skeleton first: without it the panel showed the design-reference numbers
  // baked into index.html until the fetch resolved, and a failed fetch left
  // them on screen looking like real figures.
  crmRenderReportsSkeleton();
  const [sbRes, pipeRes, staleRes, renewRes] = await Promise.all([
    supabase.from('v_crm_quarter_scoreboard').select('*').maybeSingle(),
    supabase.from('v_crm_pipeline').select('*'),
    supabase.from('v_crm_stale_deals').select('*', { count: 'exact', head: true }),
    supabase.from('v_crm_renewals_next_90d').select('*', { count: 'exact', head: true }),
  ]);
  // Report failures instead of rendering zeros — "AED 0 / 0%" is indistinguishable
  // from a genuinely empty quarter, which is the worst possible failure mode for
  // a number someone might forecast against.
  const failed = [sbRes, pipeRes, staleRes, renewRes].find((r) => r.error);
  if (failed) {
    console.error('[crm] load reports', failed.error);
    toast('Could not load reports: ' + failed.error.message, 'error');
    crmRenderReportsError('Reports could not be loaded, so no figures are shown. Try refreshing.');
    return;
  }
  crmRenderScoreboard(sbRes.data || {}, pipeRes.data || [], staleRes.count || 0, renewRes.count || 0);
  crmRenderPipelineChart(pipeRes.data || []);
}

function crmRenderScoreboard(sb, pipeRows, staleCount, renewCount) {
  const openPipelineAed = pipeRows.reduce((a, r) => a + (Number(r.value_aed) || 0), 0);
  const tile = (label, num) => `<div class="tile"><span class="tile-label">${esc(label)}</span><span class="tile-num mono">${num}</span></div>`;
  document.getElementById('crm-scoreboard').innerHTML = [
    tile('Open pipeline', money(openPipelineAed)),
    tile('Won this quarter', money(sb.won_value_aed || 0)),
    tile('Deals won', sb.won_count ?? 0),
    tile('Win rate', (sb.win_rate_pct ?? 0) + '%'),
    tile('Avg. deal size', money(sb.avg_won_aed || 0)),
    tile('Stale deals', staleCount),
    tile('Renewals due (90d)', renewCount),
  ].join('');
}

let crmPipelineChart = null;
let crmLastPipeRows = [];
function crmRenderPipelineChart(rows) {
  crmLastPipeRows = rows;                 // cached so a theme toggle can re-render
  const canvas = document.getElementById('crm-chart-pipeline'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (crmPipelineChart) crmPipelineChart.destroy();
  const services = rows.filter((r) => r.motion === 'services');
  const software = rows.filter((r) => r.motion === 'software');
  // Canonical pipeline order. Deriving the axis from the rows put stages in
  // whatever order the GROUP BY happened to return, so the funnel read as noise.
  const canonical = [...new Set([...CRM_STAGES.services, ...CRM_STAGES.software])];
  const stages = canonical.filter((s) => rows.some((r) => r.stage === s));
  // All colours come from CSS custom properties, so the chart adapts to the theme.
  const gridColor = cssVar('--line') || '#DCE4E1';
  const labelColor = cssVar('--muted') || '#5D6B65';
  crmPipelineChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: stages.map(stageLabel),
      datasets: [
        { label: 'Services (AED)', data: stages.map((st) => services.find((r) => r.stage === st)?.value_aed || 0), backgroundColor: cssVar('--brand') || '#12924A', borderRadius: 4, maxBarThickness: 34 },
        { label: 'Software (AED)', data: stages.map((st) => software.find((r) => r.stage === st)?.value_aed || 0), backgroundColor: cssVar('--software') || '#2563EB', borderRadius: 4, maxBarThickness: 34 },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: gridColor, display: false }, ticks: { color: labelColor } },
        y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: labelColor } },
      },
    },
  });
}

// ===========================================
// CSV EXPORT
// ===========================================
// Embedded resources arrive as nested objects; the old export dropped every
// non-scalar column, so the file carried company_id/contact_id UUIDs and none
// of the names that were explicitly fetched. Flatten them into real columns.
function csvFlatten(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const prefix = k.replace(/^crm_/, '').replace(/s$/, '');
      for (const [k2, v2] of Object.entries(v)) out[`${prefix}_${k2}`] = v2;
    } else if (Array.isArray(v)) {
      out[k] = JSON.stringify(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function crmExport() {
  try {
    let data, error;
    if (LG_VIEW_KIND[crmState.view]) {
      // export exactly what the current filters show, not the whole table
      ({ data, error } = await crmLeadgenQuery().range(0, 4999));
    } else {
      ({ data, error } = await supabase.from('crm_deals')
        .select('*, crm_companies!company_id(name,domain), crm_contacts(name,email,phone)')
        .eq('motion', crmState.motion).limit(5000));
    }
    if (error) throw error;
    if (!data || !data.length) { toast('Nothing to export.', 'error'); return; }
    const flat = data.map(csvFlatten);
    const cols = [...new Set(flat.flatMap((r) => Object.keys(r)))];
    const rows = [cols.join(',')];
    for (const r of flat) rows.push(cols.map((c) => csvCell(r[c])).join(','));
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const what = LG_VIEW_KIND[crmState.view] ? crmState.view : crmState.motion;
    a.download = `underwings-crm-${what}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Export started.', 'success');
  } catch (e) {
    toast('Export failed: ' + (e.message || 'Unknown error'), 'error');
  }
}

// ===========================================
// COMMAND PALETTE (⌘K) — keyboard launcher over loaded deals/prospects + actions.
// Client-side only: searches crmState.deals (current motion) + crmState.prospects.
// ===========================================
let cmdkItems = [];
let cmdkSel = 0;
let cmdkPrevFocus = null;

function crmWireCmdk() {
  const overlay = document.getElementById('crm-cmdk');
  const input = document.getElementById('cmdk-input');
  const list = document.getElementById('cmdk-list');
  if (!overlay || !input || !list) return;

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); crmOpenCmdk(); }
  });
  const opener = document.getElementById('crm-cmdk-open');
  if (opener) opener.addEventListener('click', crmOpenCmdk);
  overlay.querySelector('.cmdk-backdrop').addEventListener('click', crmCloseCmdk);
  input.addEventListener('input', () => crmRenderCmdk(input.value));
  input.addEventListener('keydown', crmCmdkKeydown);
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-cmdk-i]'); if (!li) return;
    crmCmdkActivate(Number(li.dataset.cmdkI));
  });
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('[data-cmdk-i]'); if (!li) return;
    const i = Number(li.dataset.cmdkI);
    if (i !== cmdkSel) { cmdkSel = i; crmCmdkPaintSel(); }
  });
}

function crmOpenCmdk() {
  const overlay = document.getElementById('crm-cmdk');
  if (overlay.classList.contains('is-open')) return;
  cmdkPrevFocus = document.activeElement;
  setOverlayOpen(overlay, true);
  const input = document.getElementById('cmdk-input');
  input.value = '';
  crmRenderCmdk('');
  input.focus();
}

function crmCloseCmdk() {
  const overlay = document.getElementById('crm-cmdk');
  if (!overlay.classList.contains('is-open')) return;
  setOverlayOpen(overlay, false);
  if (cmdkPrevFocus && document.contains(cmdkPrevFocus)) { try { cmdkPrevFocus.focus(); } catch (_) { /* gone */ } }
  cmdkPrevFocus = null;
}

function crmCmdkBuild(query) {
  const q = query.trim().toLowerCase();
  const items = [];
  const actions = [
    { icon: '+', label: 'New deal', kind: 'Action', run: () => { crmCloseCmdk(); openNewDealModal(); } },
    { icon: '▚', label: 'Go to Pipeline', kind: 'Go', run: () => { crmCloseCmdk(); crmSwitchView('pipeline'); } },
    { icon: '◇', label: 'Go to LeadGen', kind: 'Go', run: () => { crmCloseCmdk(); crmSwitchView('leadgen'); } },
    { icon: '⋈', label: 'Go to Partners', kind: 'Go', run: () => { crmCloseCmdk(); crmSwitchView('partners'); } },
    { icon: '▤', label: 'Go to BLead', kind: 'Go', run: () => { crmCloseCmdk(); crmSwitchView('blead'); } },
    { icon: '⌖', label: 'Go to VAPT Leads', kind: 'Go', run: () => { crmCloseCmdk(); crmSwitchView('vapt'); } },
    { icon: '◈', label: 'Go to Web Leads', kind: 'Go', run: () => { crmCloseCmdk(); crmSwitchView('webleads'); } },
    { icon: '▷', label: 'Run LeadGen now', kind: 'Action', admin: true, run: () => { crmCloseCmdk(); crmLeadgenRunNow(); } },
    { icon: '▤', label: 'Go to Reports', kind: 'Go', run: () => { crmCloseCmdk(); crmSwitchView('reports'); } },
    { icon: '↧', label: 'Export current view (CSV)', kind: 'Action', run: () => { crmCloseCmdk(); crmExport(); } },
  ];
  if (crmState._openId) {
    actions.push({ icon: '✎', label: 'Log activity on open deal', kind: 'Action', run: () => { crmCloseCmdk(); const i = document.getElementById('dw-activity-input'); if (i) i.focus(); } });
  }
  for (const a of actions) {
    if (a.admin && window.__crmRole !== 'admin') continue;
    if (!q || a.label.toLowerCase().includes(q)) items.push(a);
  }

  for (const d of crmState.deals) {
    const co = d.crm_companies?.name || '';
    if (q && !(`${d.title || ''} ${co}`.toLowerCase().includes(q))) continue;
    items.push({ icon: '◆', label: d.title || 'Untitled deal', sub: `${co ? co + ' · ' : ''}${stageLabel(d.stage)}`, kind: 'Deal', run: () => { crmCloseCmdk(); crmOpenDrawer(d.id); } });
    if (items.length >= 50) return items;
  }
  for (const p of crmState.prospects) {
    if (p.status === 'suppressed') continue;
    if (q && !(`${p.company_name || ''} ${p.domain || ''}`.toLowerCase().includes(q))) continue;
    items.push({ icon: '◇', label: p.company_name || 'Prospect', sub: p.domain || 'prospect', kind: 'Prospect', run: () => { crmCloseCmdk(); crmFocusProspect(p.id); } });
    if (items.length >= 70) return items;
  }
  return items;
}

function crmRenderCmdk(query) {
  cmdkItems = crmCmdkBuild(query);
  cmdkSel = 0;
  const list = document.getElementById('cmdk-list');
  const input = document.getElementById('cmdk-input');
  if (!cmdkItems.length) {
    list.innerHTML = `<li class="cmdk-empty">No matches${query.trim() ? ` for “${esc(query.trim())}”` : ''}.</li>`;
    input.removeAttribute('aria-activedescendant');
    return;
  }
  list.innerHTML = cmdkItems.map((it, i) => `
    <li class="cmdk-row${i === 0 ? ' is-sel' : ''}" data-cmdk-i="${i}" id="cmdk-opt-${i}" role="option" aria-selected="${i === 0}">
      <span class="cmdk-ri" aria-hidden="true">${esc(it.icon || '›')}</span>
      <span class="cmdk-rt"><span class="cmdk-rl">${esc(it.label)}</span>${it.sub ? `<span class="cmdk-rs">${esc(it.sub)}</span>` : ''}</span>
      <span class="cmdk-rk">${esc(it.kind || '')}</span>
    </li>`).join('');
  input.setAttribute('aria-activedescendant', 'cmdk-opt-0');
}

function crmCmdkPaintSel() {
  const rows = document.querySelectorAll('#cmdk-list .cmdk-row');
  const input = document.getElementById('cmdk-input');
  rows.forEach((r, i) => {
    const on = i === cmdkSel;
    r.classList.toggle('is-sel', on);
    r.setAttribute('aria-selected', String(on));
    if (on) { r.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', r.id); }
  });
}

function crmCmdkKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); crmCloseCmdk(); return; }
  if (e.key === 'Tab') { e.preventDefault(); return; }              // trap focus — input is the only stop
  if (!cmdkItems.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdkSel = (cmdkSel + 1) % cmdkItems.length; crmCmdkPaintSel(); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); cmdkSel = (cmdkSel - 1 + cmdkItems.length) % cmdkItems.length; crmCmdkPaintSel(); return; }
  if (e.key === 'Enter') { e.preventDefault(); crmCmdkActivate(cmdkSel); return; }
}

function crmCmdkActivate(i) {
  const it = cmdkItems[i];
  if (it && typeof it.run === 'function') it.run();
}

// Jump to a prospect: switch to the view holding it, then scroll + flash its
// row once the table has rendered (the load is async, so poll briefly for it).
function crmFocusProspect(id) {
  // a partner lives in the Partners tab; switching to LeadGen would load a
  // page that can never contain it, and the poll below would just time out
  const row = crmState.prospects.find((p) => p.id === id);
  crmSwitchView(row && row.kind === 'partner' ? 'partners'
    : row && row.kind === 'blead' ? 'blead' : 'leadgen');
  const sel = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
  let tries = 0;
  const tick = () => {
    const row = document.querySelector(`#crm-lg-rows tr[data-id="${sel}"]`);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('lg-row--flash');
      setTimeout(() => row.classList.remove('lg-row--flash'), 1600);
    } else if (tries++ < 12) {
      setTimeout(tick, 120);
    }
  };
  setTimeout(tick, 120);
}
