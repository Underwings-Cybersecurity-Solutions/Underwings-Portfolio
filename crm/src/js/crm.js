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

function isStale(d) {
  if (d.status !== 'open') return false;
  const threshold = d.motion === 'software' ? 21 : 30;
  return daysSince(d.updated_at) > threshold;
}

function val(id) { return document.getElementById(id).value.trim(); }

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
  view: 'pipeline',       // 'pipeline' | 'prospects' | 'reports'
  motion: 'services',     // 'services' | 'software'
  search: '',
  stageFilter: '',        // '' = all stages (signal-chain toggle)
  layout: 'kanban',       // 'kanban' | 'list'
  deals: [],
  _openId: null,
};

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
  const { data: me } = await supabase.from('crm_users').select('role').maybeSingle();
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
  updateUserChip(user, window.__crmRole);

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
      else if (crmState.view === 'prospects') crmLoadProspects();
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

  document.querySelector('.board-list').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    crmOpenDrawer(tr.dataset.id);
  });

  document.querySelectorAll('[data-crm-close]').forEach((el) => el.addEventListener('click', () => {
    const drawer = el.closest('.drawer');
    const modal = el.closest('.modal');
    if (drawer) crmCloseDrawer();
    if (modal) closeModal(modal.id);
  }));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
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
  document.querySelectorAll('[data-crm-view-panel]').forEach((p) => {
    const active = p.dataset.crmViewPanel === view;
    p.classList.toggle('is-active', active);
    p.hidden = !active;
  });
  if (view === 'pipeline') crmLoadBoard();
  else if (view === 'prospects') crmLoadProspects();
  else if (view === 'reports') crmLoadReports();
}

function crmInjectMotionToggle() {
  const toolbar = document.querySelector('.toolbar');
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
  document.querySelector('.board-list').hidden = effective !== 'list';
  document.querySelectorAll('#crm-view-toggle .seg-btn').forEach((b) => {
    const active = b.dataset.layout === crmState.layout;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-selected', String(active));
  });
}

// ===========================================
// PIPELINE — load + presentation (Phase A query, new UX)
// ===========================================
async function crmLoadBoard() {
  crmRenderBoardSkeleton();
  let q = supabase.from('crm_deals')
    .select('*, crm_companies!company_id(name,domain), crm_contacts(name,email,phone,whatsapp_ok)')
    .eq('motion', crmState.motion)
    .order('updated_at', { ascending: false })
    .limit(500);
  if (crmState.search) {
    const s = crmState.search.replace(/[%,]/g, '');
    q = q.or(`title.ilike.%${s}%,description.ilike.%${s}%`);
  }
  const { data, error } = await q;
  if (error) {
    console.error('[crm] load board', error);
    toast('Could not load the pipeline: ' + error.message, 'error');
    crmRenderBoardEmpty('The board could not be loaded. Try refreshing.');
    document.getElementById('crm-pipeline-strip').innerHTML = '';
    return;
  }
  crmState.deals = data || [];
  crmRenderStrip(crmState.deals);
  crmRenderKanban(crmState.deals);
  crmRenderList(crmState.deals);
  crmApplyLayout();
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

function crmRenderStrip(deals) {
  const stages = CRM_STAGES[crmState.motion];
  const totals = stages.map((s) => {
    const rows = deals.filter((d) => d.stage === s);
    return { stage: s, count: rows.length, val: rows.reduce((a, d) => a + (Number(d.value_aed) || 0), 0) };
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
  board.innerHTML = stages.map((stage) => {
    const stageRows = deals.filter((d) => d.stage === stage);
    const visibleRows = (crmState.stageFilter && crmState.stageFilter !== stage) ? [] : stageRows;
    const count = stageRows.length;
    const sumVal = stageRows.reduce((a, d) => a + (Number(d.value_aed) || 0), 0);
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
  return `<article class="dcard dcard--${motionClass}${wonClass}${staleClass}" tabindex="0" role="button" draggable="true" data-id="${escAttr(d.id)}">
    <span class="dcard-edge"></span>
    <div class="dcard-head">
      <span class="pill ${pillClass}">${pillLabel}</span>
      <span class="dcard-val mono">${money(d.value_aed)}</span>
    </div>
    <h3 class="dcard-title">${esc(d.title || 'Untitled deal')}</h3>
    <p class="dcard-co muted">${co}</p>
    <div class="dcard-foot">
      <span class="ava" title="Owner not tracked in this view">—</span>
      ${dealChipHtml(d, stale)}
    </div>
  </article>`;
}

function dealChipHtml(d, stale) {
  if (d.stage === 'won') return `<span class="chip chip--won">Closed</span>`;
  if (d.stage === 'lost') return `<span class="chip" title="${escAttr(d.lost_reason || '')}">Lost</span>`;
  if (stale) {
    const days = daysSince(d.updated_at);
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
    <td>—</td>
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
    badges.push(`<span class="badge badge--warn mono">⏳ ${daysSince(d.updated_at)}d idle</span>`);
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
      <span class="pill pill--${motionClass}">${motionClass === 'software' ? 'Software' : 'Services'}</span>
      <h2 class="drawer-title">${esc(d.title || 'Untitled deal')}</h2>
      <p class="drawer-sub muted">${esc(d.crm_companies?.name || '—')} · <span class="mono">${esc(d.crm_contacts?.name || d.crm_contacts?.email || '—')}</span>${waLink}${signalTxt}</p>
      ${badges.length ? `<div class="drawer-badges">${badges.join('')}</div>` : ''}
    </header>
    <nav class="stepper" aria-label="Stage">${stepperHtml}</nav>
    <div class="drawer-grid">
      <label class="field"><span>Value (AED)</span><input class="mono" id="dw-value" type="number" value="${escAttr(numOrEmpty(d.value_aed))}"></label>
      <label class="field"><span>Next action</span><input id="dw-next" value="${escAttr(d.next_action || '')}"></label>
      <label class="field"><span>Next action date</span><input class="mono" id="dw-nextdate" type="date" value="${escAttr(d.next_action_date || '')}"></label>
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
  crmState._openId = null;
}

async function crmChangeStage(id, newStage) {
  const { error } = await supabase.from('crm_deals').update({ stage: newStage }).eq('id', id);
  if (error) { toast('Stage change failed: ' + error.message, 'error'); return; }
  toast('Moved to ' + stageLabel(newStage), 'success');   // DB trigger logs the stage-change activity
  await crmOpenDrawer(id);
  if (crmState.view === 'pipeline') crmLoadBoard();
}

async function crmSaveDeal(id) {
  const patch = {
    value_aed: val('dw-value') || null,
    next_action: val('dw-next') || null,
    next_action_date: val('dw-nextdate') || null,
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
// PROSPECTS / SIGNALS (intel feed)
// ===========================================
async function crmLoadProspects() {
  crmRenderIntelSkeleton();
  let q = supabase.from('crm_prospects')
    .select('*')
    .neq('status', 'suppressed')
    .order('ai_score', { ascending: false, nullsFirst: false })
    .limit(200);
  if (crmState.search) {
    const s = crmState.search.replace(/[%,]/g, '');
    q = q.or(`company_name.ilike.%${s}%,domain.ilike.%${s}%`);
  }
  const { data, error } = await q;
  if (error) {
    console.error('[crm] load prospects', error);
    toast('Could not load signals: ' + error.message, 'error');
    crmRenderIntelEmpty();
    return;
  }
  crmRenderIntel(data || []);
}

function crmRenderIntelSkeleton() {
  document.getElementById('crm-prospects').innerHTML = Array.from({ length: 3 }).map(() => `
    <article class="icard">
      <span class="skeleton skeleton-line w-60"></span>
      <span class="skeleton skeleton-line w-40"></span>
      <div class="skeleton skeleton-card"></div>
    </article>`).join('');
}

function crmRenderIntelEmpty() {
  document.getElementById('crm-prospects').innerHTML = `
    <div class="empty">
      <span class="empty-ico" aria-hidden="true">◇</span>
      <p>No signals yet. The leadgen automation will populate this feed as it finds fits.</p>
    </div>`;
}

function clampScore(n) { n = Number(n) || 0; return Math.max(0, Math.min(100, n)); }

function crmRenderIntel(prospects) {
  const host = document.getElementById('crm-prospects');
  if (!prospects.length) { crmRenderIntelEmpty(); return; }
  host.innerHTML = prospects.map((p) => {
    const promoted = p.status === 'promoted';
    const fit = clampScore(p.ai_score);
    const gap = clampScore(p.gap_score);
    const talk = (p.talking_points || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const talkHtml = talk.length ? talk.map((t) => `<li>${esc(t)}</li>`).join('') : `<li class="muted">No talking points yet.</li>`;
    const pillHtml = promoted
      ? `<span class="pill pill--muted"><span aria-hidden="true">✓</span> Promoted</span>`
      : (p.industry ? `<span class="pill pill--muted">${esc(p.industry)}</span>` : '');
    const footBtn = promoted
      ? `<button type="button" class="btn btn-ghost btn-sm" disabled>In pipeline</button>`
      : `<button type="button" class="btn btn-primary btn-sm" data-promote="${escAttr(p.id)}">Promote to deal</button>`;
    const srcTxt = promoted ? `promoted · ${esc(formatDate(p.updated_at))}` : `source · ${esc(p.source || '—')}`;
    return `<article class="icard${promoted ? ' icard--promoted' : ''}">
      <header class="icard-head">
        <div>
          <h3 class="icard-co">${esc(p.company_name)}</h3>
          <span class="icard-domain mono">${esc(p.domain || '')}</span>
        </div>
        ${pillHtml}
      </header>
      <div class="meters">
        <div class="meter"><span class="meter-label">Fit</span><span class="meter-track"><i class="meter-fill" style="--v:${fit}%"></i></span><span class="meter-num mono">${p.ai_score ?? '—'}</span></div>
        <div class="meter"><span class="meter-label">Gap</span><span class="meter-track"><i class="meter-fill" style="--v:${gap}%"></i></span><span class="meter-num mono">${p.gap_score ?? '—'}</span></div>
      </div>
      <ul class="talk">${talkHtml}</ul>
      <div class="icard-foot"><span class="icard-src mono">${srcTxt}</span>${footBtn}</div>
    </article>`;
  }).join('');
  host.querySelectorAll('[data-promote]').forEach((b) => b.addEventListener('click', () => crmPromoteProspect(b.dataset.promote)));
}

// ---------- Company/contact upsert helpers (reused verbatim by Promote + New Deal) ----------
async function crmUpsertCompany({ name, domain }) {
  if (domain) {
    const { data } = await supabase.from('crm_companies').select('id').eq('domain', domain.toLowerCase()).maybeSingle();
    if (data) return data.id;
  }
  const { data, error } = await supabase.from('crm_companies').insert({ name: name || domain || 'Unknown', domain: domain ? domain.toLowerCase() : null }).select('id').single();
  if (error) throw error;
  return data.id;
}
async function crmUpsertContact({ email, name, company_id, phone, job_title }) {
  if (email) {
    const { data } = await supabase.from('crm_contacts').select('id').eq('email', email.toLowerCase()).maybeSingle();
    if (data) return data.id;
  }
  const { data, error } = await supabase.from('crm_contacts').insert({ email: email ? email.toLowerCase() : null, name, company_id, phone, job_title }).select('id').single();
  if (error) throw error;
  return data.id;
}

async function crmPromoteProspect(id) {
  try {
    const { data: p, error: pErr } = await supabase.from('crm_prospects').select('*').eq('id', id).single();
    if (pErr) throw pErr;
    const { data: pcs } = await supabase.from('crm_prospect_contacts').select('*').eq('prospect_id', id).order('confidence', { ascending: false });
    const top = (pcs || [])[0] || {};
    const companyId = await crmUpsertCompany({ name: p.company_name, domain: p.domain });
    const contactId = top.email ? await crmUpsertContact({ email: top.email, name: top.name, company_id: companyId, phone: top.phone, job_title: top.job_title }) : null;
    const { data: deal, error } = await supabase.from('crm_deals').insert({
      title: `${p.company_name} — outbound`, motion: 'services', stage: 'new',
      company_id: companyId, contact_id: contactId, source: 'leadgen',
      ai_score: p.ai_score, description: p.talking_points, icp_segment: 'other',
    }).select('id').single();
    if (error) throw error;
    await supabase.from('crm_prospects').update({ status: 'promoted', promoted_deal_id: deal.id }).eq('id', id);
    toast('Promoted to pipeline', 'success');
    crmLoadProspects();
  } catch (e) {
    toast('Promote failed: ' + (e.message || 'Unknown error'), 'error');
  }
}

// ===========================================
// NEW DEAL MODAL
// ===========================================
function openModal(id) { setOverlayOpen(document.getElementById(id), true); }
function closeModal(id) { setOverlayOpen(document.getElementById(id), false); }

function crmWireNewDeal() {
  document.getElementById('crm-new-deal-btn').addEventListener('click', openNewDealModal);
  document.getElementById('nd-save').addEventListener('click', crmNewDeal);
}

function openNewDealModal() {
  ['nd-title', 'nd-company', 'nd-domain', 'nd-email', 'nd-name', 'nd-value'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('nd-motion').value = crmState.motion;
  openModal('crm-newdeal-modal');
}

async function crmNewDeal() {
  try {
    const companyId = await crmUpsertCompany({ name: val('nd-company'), domain: val('nd-domain') });
    const contactId = val('nd-email') ? await crmUpsertContact({ email: val('nd-email'), name: val('nd-name'), company_id: companyId }) : null;
    const { error } = await supabase.from('crm_deals').insert({
      title: val('nd-title') || 'Untitled', motion: val('nd-motion'), stage: 'new',
      value_aed: val('nd-value') || null, company_id: companyId, contact_id: contactId, source: 'other',
    });
    if (error) throw error;
    closeModal('crm-newdeal-modal');
    toast('Deal created.', 'success');
    if (crmState.view === 'pipeline') crmLoadBoard();
  } catch (e) {
    toast('Create failed: ' + (e.message || 'Unknown error'), 'error');
  }
}

// ===========================================
// REPORTS — scoreboard + pipeline chart (Phase A count-based reads)
// ===========================================
async function crmLoadReports() {
  const [{ data: sb }, { data: pipe }, { count: staleCount }, { count: renewCount }] = await Promise.all([
    supabase.from('v_crm_quarter_scoreboard').select('*').maybeSingle(),
    supabase.from('v_crm_pipeline').select('*'),
    supabase.from('v_crm_stale_deals').select('*', { count: 'exact', head: true }),
    supabase.from('v_crm_renewals_next_90d').select('*', { count: 'exact', head: true }),
  ]);
  crmRenderScoreboard(sb || {}, pipe || [], staleCount || 0, renewCount || 0);
  crmRenderPipelineChart(pipe || []);
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
function crmRenderPipelineChart(rows) {
  const canvas = document.getElementById('crm-chart-pipeline'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (crmPipelineChart) crmPipelineChart.destroy();
  const services = rows.filter((r) => r.motion === 'services');
  const software = rows.filter((r) => r.motion === 'software');
  const stages = [...new Set(rows.map((r) => r.stage))];
  crmPipelineChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: stages.map(stageLabel),
      datasets: [
        { label: 'Services (AED)', data: stages.map((st) => services.find((r) => r.stage === st)?.value_aed || 0), backgroundColor: cssVar('--services') || '#24D758' },
        { label: 'Software (AED)', data: stages.map((st) => software.find((r) => r.stage === st)?.value_aed || 0), backgroundColor: cssVar('--software') || '#38BDF8' },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: cssVar('--line') || '#26313D' } },
        y: { beginAtZero: true, grid: { color: cssVar('--line') || '#26313D' } },
      },
    },
  });
}

// ===========================================
// CSV EXPORT
// ===========================================
async function crmExport() {
  try {
    let data;
    if (crmState.view === 'prospects') {
      ({ data } = await supabase.from('crm_prospects').select('*').limit(5000));
    } else {
      ({ data } = await supabase.from('crm_deals').select('*, crm_companies!company_id(name), crm_contacts(email)').eq('motion', crmState.motion).limit(5000));
    }
    if (!data || !data.length) { toast('Nothing to export.', 'error'); return; }
    const cols = Object.keys(data[0]).filter((c) => typeof data[0][c] !== 'object');
    const rows = [cols.join(',')];
    for (const r of data) rows.push(cols.map((c) => csvCell(r[c])).join(','));
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `underwings-crm-${crmState.view === 'prospects' ? 'prospects' : crmState.motion}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Export started.', 'success');
  } catch (e) {
    toast('Export failed: ' + (e.message || 'Unknown error'), 'error');
  }
}
