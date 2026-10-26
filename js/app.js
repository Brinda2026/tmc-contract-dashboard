// TMC Contract Dashboard – UI.

(function () {
  'use strict';

  const { GitHubStore, loadConfig, saveConfig, clearConfig } = window.ContractStore;
  const { readText, analyze, addTerm, parseTenure, classify } = window.ContractExtract;
  const Cal = window.ContractCalendar;
  const SITE = location.origin + location.pathname;

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const state = {
    cfg: null,
    store: null,
    contracts: [],
    settings: {},
    filter: 'all',
    search: '',
    sort: { key: 'endDate', dir: 1 },
    openId: null,
    editing: null, // contract being edited, or null for a new upload
    pendingFile: null,
    lastLoaded: null,
    category: (() => { try { return localStorage.getItem('tmc.tab') || 'all'; } catch { return 'all'; } })(),
    subtype: '',
  };

  const CATEGORIES = {
    b2b: { label: 'B2B', desc: 'Clients · Consultant teachers · Vendors', subtypes: ['Client', 'Consultant / Teacher', 'Vendor'] },
    rtd: { label: 'RTD', desc: 'Clients · Sourcing partners', subtypes: ['Client', 'Sourcing partner'] },
    compliance: { label: 'Compliance', desc: 'GST · Income tax · ROC filings', subtypes: ['GST', 'Income tax / TDS', 'ROC / MCA', 'Licence / registration', 'Other'] },
  };
  const isComp = (c) => c.category === 'compliance';
  function catTag(c) {
    const k = CATEGORIES[c.category];
    return k ? `<span class="cat-tag ${c.category}">${k.label}</span>${esc(c.subtype || '')}` : '<span class="cat-tag none">No category</span>';
  }
  function inScope(c) {
    if (state.category === 'all') return true;
    if (state.category === 'none') return !CATEGORIES[c.category];
    return c.category === state.category;
  }
  function scoped() { return state.contracts.filter(inScope); }

  // ---------- helpers ----------

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function today() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function parse(iso) { if (!iso) return null; const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
  function toIso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function daysUntil(iso) { const d = parse(iso); return d ? Math.round((d - today()) / 864e5) : null; }
  function fmtDate(iso) { const d = parse(iso); return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
  function relDays(n) {
    if (n === null) return '';
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    const abs = Math.abs(n);
    const txt = abs >= 60 ? `${Math.round(abs / 30)} months` : `${abs} days`;
    return n > 0 ? `in ${txt}` : `${txt} ago`;
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function addDays(iso, n) { const d = parse(iso); d.setDate(d.getDate() + n); return toIso(d); }
  function fmtSize(b) { return b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB'; }
  function expiringDays() { return Number(state.cfg?.expiringDays || 90); }

  function toast(msg, kind = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast ' + kind;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 3800);
  }
  function busy(text) {
    $('#loading').hidden = !text;
    if (text) $('#loadingText').textContent = text;
  }

  // ---------- derived data ----------

  const STATUS = {
    active: { label: 'Active', cls: 'good', icon: '✓' },
    expiring: { label: 'Expiring soon', cls: 'warning', icon: '!' },
    expired: { label: 'Expired', cls: 'critical', icon: '✕' },
    upcoming: { label: 'Not started', cls: 'info', icon: '◷' },
    open: { label: 'No end date', cls: 'neutral', icon: '–' },
  };
  const STATUS_ORDER = ['expiring', 'active', 'upcoming', 'open', 'expired'];

  function statusOf(c) {
    const end = daysUntil(c.endDate);
    const start = isComp(c) ? null : daysUntil(c.effectiveDate);
    if (end !== null && end < 0) return 'expired';
    if (start !== null && start > 0) return 'upcoming';
    if (end === null) return 'open';
    if (end <= expiringDays()) return 'expiring';
    return 'active';
  }

  function eventsOf(c) {
    const ev = (c.milestones || []).map((m) => ({ ...m, kind: 'milestone', contract: c }));
    if (isComp(c)) {
      const what = c.subtype === 'Licence / registration' ? 'Renewal / validity ends' : `Next ${c.subtype || 'compliance'} filing due`;
      if (c.endDate) ev.push({ id: 'end', date: c.endDate, label: what, kind: 'due', contract: c });
      return ev.filter((e) => e.date).sort((a, b) => a.date.localeCompare(b.date));
    }
    if (c.endDate) ev.push({ id: 'end', date: c.endDate, label: 'Contract closes / expires', kind: 'end', contract: c });
    if (c.endDate && Number(c.noticeDays) > 0) {
      ev.push({ id: 'notice', date: addDays(c.endDate, -Number(c.noticeDays)), label: `Last day to give ${c.noticeDays}-day notice (renewal / termination)`, kind: 'notice', contract: c });
    }
    if (c.effectiveDate && daysUntil(c.effectiveDate) > 0) ev.push({ id: 'start', date: c.effectiveDate, label: 'Contract starts', kind: 'start', contract: c });
    return ev.filter((e) => e.date).sort((a, b) => a.date.localeCompare(b.date));
  }

  function nextEvent(c) {
    return eventsOf(c).find((e) => !e.done && daysUntil(e.date) >= 0) || null;
  }

  function tenurePct(c) {
    const s = parse(c.effectiveDate), e = parse(c.endDate);
    if (!s || !e || e <= s) return null;
    return Math.min(100, Math.max(0, Math.round(((today() - s) / (e - s)) * 100)));
  }

  const COMP_LABEL = { active: 'Up to date', expiring: 'Due soon', expired: 'Overdue', upcoming: 'Not yet effective', open: 'No due date' };
  function statusLabel(st, comp) { return comp ? COMP_LABEL[st] : STATUS[st].label; }
  function badge(st, c) {
    const s = STATUS[st];
    return `<span class="badge ${s.cls}"><span class="b-icon" aria-hidden="true">${s.icon}</span>${statusLabel(st, c && isComp(c))}</span>`;
  }

  // ---------- loading ----------

  async function connect(cfg, quiet) {
    const store = new GitHubStore(cfg);
    await store.check();
    state.cfg = { ...cfg, branch: store.cfg.branch };
    state.store = store;
    saveConfig(state.cfg);
    await reload(quiet);
  }

  async function reload(quiet) {
    if (!state.store) return;
    if (!quiet) busy('Loading contracts…');
    try {
      const data = await state.store.loadIndex();
      state.contracts = data.contracts;
      state.settings = data.settings || {};
      state.lastLoaded = new Date();
      showDashboard();
    } catch (e) {
      if (!quiet) toast(e.message, 'err');
    } finally {
      busy(null);
    }
  }

  function setSync() {
    const el = $('#syncStatus');
    if (!state.store) { el.textContent = 'Not connected'; return; }
    const t = state.lastLoaded ? state.lastLoaded.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    el.textContent = `${state.cfg.owner}/${state.cfg.repo} · updated ${t}`;
  }

  function showConnect(err) {
    $('#connectView').hidden = false;
    $('#dashView').hidden = true;
    $('#uploadBtn').hidden = true;
    $('#refreshBtn').hidden = true;
    const f = $('#connectForm');
    if (state.cfg) { f.owner.value = state.cfg.owner || ''; f.repo.value = state.cfg.repo || 'tmc-contracts-data'; }
    const e = $('#connectError');
    e.hidden = !err;
    e.textContent = err || '';
    setSync();
  }

  function showDashboard() {
    $('#connectView').hidden = true;
    $('#dashView').hidden = false;
    $('#uploadBtn').hidden = false;
    $('#refreshBtn').hidden = false;
    setSync();
    render();
    if (state.openId) renderDrawer();
  }

  // ---------- rendering ----------

  function render() {
    renderTabs();
    renderKpis();
    renderOverview();
    renderFilters();
    renderTable();
    renderTimeline();
  }

  function renderTabs() {
    const n = (k) => state.contracts.filter((c) => (k === 'all' ? true : k === 'none' ? !CATEGORIES[c.category] : c.category === k)).length;
    const tabs = [['all', 'All', ''], ...Object.entries(CATEGORIES).map(([k, v]) => [k, v.label, v.desc])];
    if (n('none')) tabs.push(['none', 'No category', '']);
    if (state.category === 'none' && !n('none')) state.category = 'all';
    $('#catTabs').innerHTML = tabs.map(([k, l, d]) =>
      `<button class="cat-tab" role="tab" data-cat="${k}" aria-selected="${state.category === k}">${l}<span class="count">${n(k)}</span>${d ? `<span class="desc hide-md">${d}</span>` : ''}</button>`).join('');
    const subs = CATEGORIES[state.category]?.subtypes || [];
    if (!subs.includes(state.subtype)) state.subtype = '';
    const sf = $('#subFilter');
    sf.hidden = !subs.length;
    sf.innerHTML = `<option value="">All types</option>` + subs.map((x) => `<option ${x === state.subtype ? 'selected' : ''}>${esc(x)}</option>`).join('');
    const comp = state.category === 'compliance';
    $('#listTitle').textContent = comp ? 'Compliance documents' : state.category === 'all' ? 'Contracts & documents' : `${CATEGORIES[state.category]?.label || ''} contracts`.trim();
    $('#thName').textContent = comp ? 'Document' : state.category === 'all' ? 'Name' : 'Contract';
    $('#thParty').textContent = comp ? 'Authority' : state.category === 'all' ? 'Counterparty / authority' : 'Counterparty';
    $('#thEnd').textContent = comp ? 'Next due date' : state.category === 'all' ? 'Closing / due date' : 'Closing date';
    $('#search').placeholder = comp ? 'Search documents…' : 'Search contracts…';
  }

  function renderKpis() {
    const list = scoped();
    const comp = state.category === 'compliance';
    const counts = { all: list.length, active: 0, expiring: 0, expired: 0 };
    let next = null;
    for (const c of list) {
      const s = statusOf(c);
      if (s === 'active' || s === 'open' || (s === 'expiring' && !comp)) counts.active++;
      if (s === 'expiring') counts.expiring++;
      if (s === 'expired') counts.expired++;
      const n = nextEvent(c);
      if (n && (!next || n.date < next.date)) next = n;
    }
    const tile = (filter, label, value, sub) => `
      <button class="kpi" data-filter="${filter}" aria-pressed="${state.filter === filter}">
        <span class="kpi-label">${label}</span>
        <span class="kpi-value">${value}</span>
        <span class="kpi-sub">${sub}</span>
      </button>`;
    $('#kpis').innerHTML = comp
      ? tile('all', 'Documents', counts.all, 'on record') +
        tile('active', 'Up to date', counts.active, 'nothing due yet') +
        tile('expiring', 'Due soon', counts.expiring, `due within ${expiringDays()} days`) +
        tile('expired', 'Overdue', counts.expired, 'past the due date')
      : tile('all', state.category === 'all' ? 'Total on record' : 'Total contracts', counts.all, state.category === 'all' ? 'contracts & documents' : 'on record') +
        tile('active', 'Active', counts.active, 'in force / up to date') +
        tile('expiring', 'Expiring / due soon', counts.expiring, `within ${expiringDays()} days`) +
        tile('expired', 'Expired / overdue', counts.expired, 'past closing or due date');
    $('#kpis').innerHTML +=
      `<button class="kpi next" ${next ? `data-open="${esc(next.contract.id)}"` : 'disabled'}>
        <span class="kpi-label">Next deadline</span>
        <span class="kpi-value sm">${next ? esc(relDays(daysUntil(next.date))) : '—'}</span>
        <span class="kpi-sub">${next ? `${esc(fmtDate(next.date))} · ${esc(next.contract.title)}` : 'nothing scheduled'}</span>
      </button>`;
  }

  function renderOverview() {
    const el = $('#overview');
    el.hidden = state.category !== 'all' || !state.contracts.length;
    if (el.hidden) return;
    el.innerHTML = Object.entries(CATEGORIES).map(([k, v]) => {
      const list = state.contracts.filter((c) => c.category === k);
      const comp = k === 'compliance';
      let ok = 0, soon = 0, late = 0, next = null;
      for (const c of list) {
        const st = statusOf(c);
        if (st === 'expiring') soon++; else if (st === 'expired') late++; else ok++;
        const n = nextEvent(c);
        if (n && (!next || n.date < next.date)) next = n;
      }
      const legend = [[ok, 'good', comp ? 'Up to date' : 'Active'], [soon, 'warning', comp ? 'Due soon' : 'Expiring soon'], [late, 'critical', comp ? 'Overdue' : 'Expired']];
      const bar = list.length ? legend.filter(([n]) => n).map(([n, cls]) => `<span class="${cls}" style="flex:${n}"></span>`).join('') : '';
      return `<button class="card ov-card" data-cat="${k}" title="Show ${v.label}">
        <div class="ov-head"><span class="cat-tag ${k}">${v.label}</span><span class="ov-total">${list.length}<small>${comp ? 'documents' : 'contracts'}</small></span></div>
        <div class="ov-bar" role="img" aria-label="${legend.map((l) => `${l[2]}: ${l[0]}`).join(', ')}">${bar}</div>
        <div class="ov-legend">${legend.map(([n, cls, l]) => `<span class="${cls}"><i></i>${l} ${n}</span>`).join('')}</div>
        <ul class="ov-subs">${v.subtypes.map((sub) => `<li><span>${esc(sub)}</span><b>${list.filter((c) => c.subtype === sub).length}</b></li>`).join('')}</ul>
        <div class="ov-next">${next ? `Next: <strong>${esc(next.label)}</strong> · ${fmtDate(next.date)} (${esc(relDays(daysUntil(next.date)))})` : 'Nothing scheduled'}</div>
      </button>`;
    }).join('');
  }

  const FILTERS = [
    ['all', 'All'], ['active', 'Active'], ['expiring', 'Expiring soon'], ['upcoming', 'Not started'], ['open', 'No end date'], ['expired', 'Expired'],
  ];

  function matchesFilter(c) {
    const s = statusOf(c);
    if (state.filter === 'all') return true;
    if (state.filter === 'active') return s === 'active' || s === 'expiring' || s === 'open';
    return s === state.filter;
  }

  function renderFilters() {
    const comp = state.category === 'compliance';
    const label = { active: comp ? 'Up to date' : 'Active', expiring: comp ? 'Due soon' : 'Expiring soon', upcoming: 'Not started', open: comp ? 'No due date' : 'No end date', expired: comp ? 'Overdue' : 'Expired' };
    const count = (f) => scoped().filter((c) => !state.subtype || c.subtype === state.subtype).filter((c) => { const keep = state.filter; state.filter = f; const r = matchesFilter(c); state.filter = keep; return r; }).length;
    $('#filters').innerHTML = FILTERS.filter(([k]) => !(comp && k === 'upcoming')).map(([k, l]) => [k, label[k] || l]).map(([k, l]) =>
      `<button class="chip" role="tab" data-filter="${k}" aria-selected="${state.filter === k}">${l}<span class="count">${count(k)}</span></button>`).join('');
  }

  function visibleContracts() {
    const q = state.search.trim().toLowerCase();
    const list = scoped().filter((c) => !state.subtype || c.subtype === state.subtype).filter(matchesFilter).filter((c) =>
      !q || [c.title, c.counterparty, c.parties, c.type, c.subtype, c.owner, c.notes, c.value, c.fees, c.period, c.reference, c.ids].join(' ').toLowerCase().includes(q));
    const { key, dir } = state.sort;
    const val = (c) => {
      if (key === 'status') return STATUS_ORDER.indexOf(statusOf(c));
      if (key === 'next') return nextEvent(c)?.date || '9999';
      if (key === 'endDate') return c.endDate || '9999';
      return (c[key] || '').toLowerCase();
    };
    return list.sort((a, b) => (val(a) > val(b) ? dir : val(a) < val(b) ? -dir : 0));
  }

  function renderTable() {
    const rows = visibleContracts();
    const any = scoped().length > 0;
    $('#emptyState').hidden = any;
    $('#contractTable').hidden = !any;
    $('#emptyState p').innerHTML = `<strong>${state.category === 'compliance' ? 'No compliance documents yet.' : state.category === 'all' ? 'No contracts yet.' : `No ${CATEGORIES[state.category]?.label || ''} contracts yet.`}</strong>`;
    $$('#contractTable th[data-sort]').forEach((th) => {
      th.setAttribute('aria-sort', th.dataset.sort === state.sort.key ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
    });
    const tbody = $('#contractTable tbody');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted center">No contracts match this view.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((c) => {
      const st = statusOf(c);
      const pct = tenurePct(c);
      const n = nextEvent(c);
      const left = daysUntil(c.endDate);
      return `<tr data-open="${esc(c.id)}" tabindex="0" class="${state.openId === c.id ? 'selected' : ''}">
        <td><div class="t-title">${esc(c.title)}</div><div class="t-sub">${catTag(c)}${c.value ? ' · ' + esc(c.value) : ''}</div></td>
        <td class="hide-md">${esc(c.counterparty || '—')}</td>
        <td><div>${fmtDate(c.endDate)}</div><div class="t-sub">${c.endDate ? esc(relDays(left)) : ''}</div></td>
        <td class="hide-sm">${isComp(c) ? `<div>${esc(c.period || '—')}</div><div class="t-sub">${c.effectiveDate ? 'filed ' + fmtDate(c.effectiveDate) : ''}</div>` : pct === null ? '<span class="muted">—</span>' : `<div class="bar" title="${pct}% of the tenure has passed"><span style="width:${pct}%"></span></div><div class="t-sub">${pct}%${c.tenure ? ' of ' + esc(c.tenure) : ''}</div>`}</td>
        <td>${badge(st, c)}</td>
        <td class="hide-md">${n ? `<div class="t-clip">${esc(n.label)}</div><div class="t-sub">${fmtDate(n.date)} · ${esc(relDays(daysUntil(n.date)))}</div>` : '<span class="muted">—</span>'}</td>
      </tr>`;
    }).join('');
  }

  function renderTimeline() {
    const horizon = Number($('#horizon').value);
    const all = scoped().flatMap(eventsOf);
    const overdue = all.filter((e) => (e.kind === 'milestone' || e.kind === 'due') && !e.done && daysUntil(e.date) < 0 && daysUntil(e.date) >= -180);
    const soon = all.filter((e) => !e.done && daysUntil(e.date) >= 0 && daysUntil(e.date) <= horizon);
    const item = (e) => {
      const d = daysUntil(e.date);
      const urgency = d < 0 ? 'critical' : d <= 14 ? 'serious' : d <= 45 ? 'warning' : 'calm';
      const kindLabel = { end: 'Closing date', notice: 'Notice deadline', start: 'Start', milestone: 'Milestone', due: 'Compliance due' }[e.kind];
      return `<li class="tl-item ${urgency}" data-open="${esc(e.contract.id)}" tabindex="0">
        <div class="tl-date"><span class="tl-day">${parse(e.date).getDate()}</span><span class="tl-mon">${parse(e.date).toLocaleDateString('en-GB', { month: 'short' })}</span></div>
        <div class="tl-body">
          <div class="tl-label">${esc(e.label)}</div>
          <div class="t-sub">${CATEGORIES[e.contract.category] ? `<span class="cat-tag ${e.contract.category}">${CATEGORIES[e.contract.category].label}</span>` : ''}${esc(e.contract.title)}</div>
          <div class="tl-meta"><span class="tag">${kindLabel}</span><span class="when">${esc(relDays(d))}</span></div>
        </div>
      </li>`;
    };
    let html = '';
    if (overdue.length) html += `<li class="tl-group">Overdue</li>` + overdue.map(item).join('');
    if (soon.length) html += (overdue.length ? `<li class="tl-group">Coming up</li>` : '') + soon.map(item).join('');
    if (!html) html = `<li class="muted tl-empty">Nothing due in this window.</li>`;
    $('#timeline').innerHTML = html;
  }

  // ---------- detail drawer ----------

  function openDrawer(id) {
    state.openId = id;
    renderDrawer();
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#drawerScrim').hidden = false;
    renderTable();
  }
  function closeDrawer() {
    state.openId = null;
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    $('#drawerScrim').hidden = true;
    renderTable();
  }

  function renderDrawer() {
    const c = state.contracts.find((x) => x.id === state.openId);
    if (!c) { closeDrawer(); return; }
    const st = statusOf(c);
    const pct = tenurePct(c);
    const left = daysUntil(c.endDate);
    const noticeDate = c.endDate && Number(c.noticeDays) > 0 ? addDays(c.endDate, -Number(c.noticeDays)) : null;
    const fact = (label, value, sub) => `<div class="fact"><dt>${label}</dt><dd>${value ? esc(value) : '<span class="muted">Not set</span>'}${sub ? `<span class="t-sub">${esc(sub)}</span>` : ''}</dd></div>`;
    const events = eventsOf(c);
    const calEv = Object.fromEntries(Cal.buildEvents(c, state.settings.calendar || {}, SITE).map((e) => [e.key, e]));
    const calKey = (e) => (e.kind === 'end' || e.kind === 'due' ? 'due' : e.kind === 'notice' ? 'notice' : e.kind === 'milestone' ? `ms-${e.id}` : '');
    const calIcon = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 10h17M8 3v4M16 3v4M12 13v5M9.5 15.5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    const guests = Cal.guestsFor(c, state.settings.calendar);
    const cal = calCfg();
    const synced = c.calendar?.syncedAt;
    const calBlock = cal
      ? `<div class="cal-state ${c.calendarError ? 'err' : ''}"><div class="ms-body">
          ${c.calendarError ? `<div><strong>Calendar sync failed</strong></div><p>${esc(c.calendarError)}</p>`
            : synced ? `<div><strong>In Google Calendar</strong> · ${Object.keys(c.calendar.events || {}).length} date(s)</div><p>${guests.length ? `Invited: ${esc(guests.join(', '))}` : 'Only in your calendar (no owner email yet).'} · synced ${esc(new Date(synced).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</p>`
            : `<div><strong>Not in Google Calendar yet</strong></div><p>Dates are added when you save; you can also sync now.</p>`}
          ${!c.ownerEmail ? '<p>Add an <em>owner email</em> (Edit details) so the owner is invited to these dates.</p>' : ''}
        </div><button class="btn ghost sm" data-action="cal-sync">Sync now</button></div>`
      : `<div class="cal-state"><div class="ms-body"><div><strong>Automatic reminders are off</strong></div><p>Use the calendar icon next to a date to add it to Google Calendar${guests.length ? ` with ${esc(guests.join(', '))} invited` : ''}, or turn on automatic reminders.</p></div><button class="btn ghost sm" data-action="cal-setup">Set up</button></div>`;

    $('#drawerBody').innerHTML = `
      <div class="drawer-head">
        <div>
          <p class="eyebrow">${catTag(c)}${!isComp(c) && c.type ? ' · ' + esc(c.type) : ''}</p>
          <h2 id="drawerTitle">${esc(c.title)}</h2>
          ${badge(st, c)}
        </div>
        <button class="icon-btn" data-action="close" aria-label="Close">✕</button>
      </div>

      <section class="hero">
        <div>
          <span class="kpi-label">${isComp(c) ? (left === null ? 'Next due date' : left < 0 ? 'Was due' : 'Next due') : left === null ? 'Closing date' : left < 0 ? 'Closed' : 'Closes'}</span>
          <span class="hero-value">${c.endDate ? esc(relDays(left)) : isComp(c) ? 'No due date' : 'No end date'}</span>
          <span class="t-sub">${c.endDate ? fmtDate(c.endDate) : isComp(c) ? 'Add the next due date or validity to get reminders' : 'Add an end date to track expiry'}</span>
        </div>
        ${pct !== null && !isComp(c) ? `<div class="hero-bar">
          <div class="bar lg"><span style="width:${pct}%"></span></div>
          <div class="bar-ends"><span>${fmtDate(c.effectiveDate)}</span><span>${pct}% elapsed</span><span>${fmtDate(c.endDate)}</span></div>
        </div>` : ''}
      </section>

      ${isComp(c) ? `<dl class="facts">
        ${fact('Document type', c.subtype)}
        ${fact('Authority / department', c.counterparty)}
        ${fact('Period', c.period)}
        ${fact('Reference no.', c.reference)}
        ${fact('Filed / issue date', c.effectiveDate && fmtDate(c.effectiveDate))}
        ${fact('Next due date / valid until', c.endDate && fmtDate(c.endDate), c.dueSuggested ? 'suggested from the return period, please check' : '')}
        ${fact('Amount paid', c.value)}
        ${fact('Registration IDs', c.ids)}
        ${fact('Owner at TMC', c.owner, c.ownerEmail)}
      </dl>` : `<dl class="facts">
        ${fact('Counterparty', c.counterparty)}
        ${fact('Parties', c.parties)}
        ${fact('Start / effective date', c.effectiveDate && fmtDate(c.effectiveDate))}
        ${fact('Closing / end date', c.endDate && fmtDate(c.endDate), c.endCalculated ? 'calculated from start date + tenure' : '')}
        ${fact('Tenure', c.tenure)}
        ${fact('Contract value', c.value)}
        ${fact('Notice period', c.noticeDays ? `${c.noticeDays} days` : '', noticeDate ? `give notice by ${fmtDate(noticeDate)}` : '')}
        ${fact('Owner at TMC', c.owner, c.ownerEmail)}
        ${fact('Governing law', c.governingLaw)}
      </dl>`}
      ${c.fees ? `<div class="block"><h3>Fees &amp; payment terms</h3><p class="pre">${esc(c.fees)}</p></div>` : ''}
      ${c.renewal ? `<div class="block"><h3>Renewal</h3><p>${esc(c.renewal)}</p></div>` : ''}
      ${c.notes ? `<div class="block"><h3>Notes</h3><p class="pre">${esc(c.notes)}</p></div>` : ''}

      <div class="block">
        <div class="ms-head"><h3>${isComp(c) ? 'Due dates &amp; reminders' : 'Milestones &amp; key dates'}</h3></div>
        <ul class="ms-list">
          ${events.length ? events.map((e) => {
            const d = daysUntil(e.date);
            const isMs = e.kind === 'milestone';
            const late = isMs && !e.done && d < 0;
            return `<li class="${e.done ? 'done' : ''} ${late ? 'late' : ''}">
              ${isMs ? `<input type="checkbox" data-action="toggle" data-ms="${esc(e.id)}" ${e.done ? 'checked' : ''} aria-label="Mark done">` : `<span class="ms-dot ${e.kind === 'due' ? 'notice' : e.kind}" aria-hidden="true"></span>`}
              <div class="ms-body">
                <div>${esc(e.label)}</div>
                <div class="t-sub">${fmtDate(e.date)} · ${e.done ? 'done' : late ? 'overdue ' + relDays(d).replace(' ago', '') : esc(relDays(d))}</div>
              </div>
              ${!e.done && d >= 0 && calEv[calKey(e)] ? `<a class="cal-link" href="${esc(Cal.gcalLink(calEv[calKey(e)]))}" target="_blank" rel="noopener" title="Add to Google Calendar${guests.length ? ' (invites ' + esc(guests.join(', ')) + ')' : ''}" aria-label="Add to Google Calendar">${calIcon}</a>` : ''}
              ${isMs ? `<button class="icon-btn sm" data-action="del-ms" data-ms="${esc(e.id)}" aria-label="Remove milestone">✕</button>` : ''}
            </li>`;
          }).join('') : '<li class="muted">No dates yet.</li>'}
        </ul>
        <form class="add-ms" id="addMsForm">
          <input type="date" name="date" required aria-label="Milestone date">
          <input name="label" required placeholder="New milestone, e.g. Q1 payment due" aria-label="Milestone description">
          <button class="btn ghost sm" type="submit">Add</button>
        </form>
      </div>

      <div class="block">
        <h3>Google Calendar</h3>
        ${calBlock}
      </div>

      <div class="block file">
        <h3>Document</h3>
        ${c.file ? `<div class="file-row">
          <span class="file-icon" aria-hidden="true">${esc((c.file.name.split('.').pop() || '').toUpperCase())}</span>
          <div class="ms-body"><div class="t-clip">${esc(c.file.name)}</div><div class="t-sub">${fmtSize(c.file.size)} · uploaded ${fmtDate((c.createdAt || '').slice(0, 10))}</div></div>
          <button class="btn ghost sm" data-action="view">Open</button>
          <button class="btn ghost sm" data-action="download">Download</button>
        </div>` : '<p class="muted">No file attached.</p>'}
      </div>

      <div class="drawer-foot">
        <button class="btn danger ghost" data-action="delete">Delete</button>
        <button class="btn primary" data-action="edit">Edit details</button>
      </div>`;
  }

  async function drawerAction(action, el) {
    const c = state.contracts.find((x) => x.id === state.openId);
    if (!c) return;
    try {
      if (action === 'close') closeDrawer();
      else if (action === 'cal-sync') await syncCalendar(c.id);
      else if (action === 'cal-setup') openCalDialog();
      else if (action === 'edit') openEdit(c);
      else if (action === 'toggle') {
        const id = el.dataset.ms, done = el.checked;
        await save((d) => { const m = find(d, c.id)?.milestones.find((x) => x.id === id); if (m) m.done = done; }, `Update milestone on ${c.title}`, true);
        syncCalendar(c.id, true);
      } else if (action === 'del-ms') {
        const id = el.dataset.ms;
        await save((d) => { const x = find(d, c.id); if (x) x.milestones = x.milestones.filter((m) => m.id !== id); }, `Remove milestone from ${c.title}`, true);
        syncCalendar(c.id, true);
      } else if (action === 'download' || action === 'view') {
        busy('Fetching document…');
        const blob = await state.store.downloadFile(c.file.path);
        const typed = new Blob([blob], { type: c.file.mime || blob.type });
        const url = URL.createObjectURL(typed);
        if (action === 'view') window.open(url, '_blank', 'noopener');
        else { const a = document.createElement('a'); a.href = url; a.download = c.file.name; a.click(); }
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        busy(null);
      } else if (action === 'delete') {
        if (!confirm(`Delete “${c.title}” and its file? This cannot be undone from the dashboard.`)) return;
        busy('Deleting…');
        if (calCfg() && Object.keys(c.calendar?.events || {}).length) {
          try { await Cal.call(calCfg(), { action: 'remove', existing: c.calendar.events }); } catch (e) { toast(`Deleted, but its calendar events could not be removed: ${e.message}`, 'err'); }
        }
        if (c.file) await state.store.deleteFile(c.file.path);
        await save((d) => { d.contracts = d.contracts.filter((x) => x.id !== c.id); }, `Delete ${c.title}`);
        closeDrawer();
        toast('Deleted');
      }
    } catch (e) {
      busy(null);
      toast(e.message, 'err');
    }
  }

  function find(data, id) { return data.contracts.find((x) => x.id === id); }

  // ---------- Google Calendar ----------

  function calCfg() { const c = state.settings?.calendar; return c?.url && c?.key ? c : null; }

  async function syncCalendar(id, quiet) {
    const cal = calCfg();
    const c = state.contracts.find((x) => x.id === id);
    if (!cal || !c) return false;
    const events = Cal.eventsToSync(c, cal, SITE);
    const existing = c.calendar?.events || {};
    if (!events.length && !Object.keys(existing).length) return true;
    try {
      const r = await Cal.call(cal, { action: 'sync', events, existing });
      const info = { events: r.events || {}, syncedAt: new Date().toISOString() };
      await save((d) => { const x = find(d, id); if (x) x.calendar = info; }, `Calendar sync for ${c.title}`, true);
      if (!quiet) {
        const g = Cal.guestsFor(c, cal);
        toast(`Added ${events.length} date(s) to Google Calendar${g.length ? ', invited ' + g.join(', ') : ''}`);
      }
      return true;
    } catch (e) {
      const x = state.contracts.find((y) => y.id === id);
      if (x) x.calendarError = e.message;
      if (state.openId === id) renderDrawer();
      if (!quiet) toast(`Calendar: ${e.message}`, 'err');
      return false;
    }
  }

  async function syncAll() {
    const list = state.contracts.filter((c) => c.endDate || (c.milestones || []).some((m) => !m.done) || c.calendar);
    let failed = 0;
    for (let i = 0; i < list.length; i++) {
      busy(`Adding dates to Google Calendar… ${i + 1} / ${list.length}`);
      if (!(await syncCalendar(list[i].id, true))) failed++;
    }
    busy(null);
    toast(failed ? `${list.length - failed} of ${list.length} synced; ${failed} failed (open them to see why)` : `All ${list.length} item(s) are in Google Calendar`, failed ? 'err' : '');
  }

  async function saveSettings(patch) {
    const data = await state.store.mutate((d) => { d.settings = { ...(d.settings || {}), ...patch }; }, 'Update dashboard settings');
    state.settings = data.settings || {};
    state.contracts = data.contracts;
  }

  let scriptTemplate = '';
  async function openCalDialog() {
    const f = $('#calForm');
    const cal = state.settings.calendar || {};
    state.calKey = cal.key || Cal.newKey();
    f.url.value = cal.url || '';
    f.leadDays.value = String(cal.leadDays ?? 30);
    f.alwaysInvite.value = cal.alwaysInvite || '';
    $('#calOffBtn').hidden = !cal.url;
    $('#calMsg').hidden = true;
    $('#copyMsg').textContent = '';
    if ($('#settingsDialog').open) $('#settingsDialog').close();
    $('#calDialog').showModal();
    try {
      if (!scriptTemplate) scriptTemplate = await (await fetch('apps-script/Code.gs', { cache: 'no-store' })).text();
      $('#scriptText').textContent = scriptTemplate.replace('__SECRET__', state.calKey);
    } catch {
      $('#scriptText').textContent = 'Could not load the script. Reload the page and try again.';
    }
  }

  function calMsg(text, kind) {
    const m = $('#calMsg');
    m.hidden = !text;
    m.className = 'notice ' + (kind || '');
    m.textContent = text || '';
  }

  async function testCal() {
    const url = $('#calForm').url.value.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
      calMsg('Paste the Web app URL from step 4. It looks like https://script.google.com/macros/s/…/exec', 'warn');
      return null;
    }
    calMsg('Checking the connection…');
    try {
      const r = await Cal.call({ url, key: state.calKey }, { action: 'ping' });
      calMsg(`Connected to the calendar “${r.calendar}”${r.account ? ' of ' + r.account : ''}.`, 'ok');
      return url;
    } catch (e) {
      calMsg(e.message, 'warn');
      return null;
    }
  }

  async function save(fn, message, quiet) {
    if (!quiet) busy('Saving…');
    try {
      // optimistic local update for snappy UI
      const local = { contracts: structuredClone(state.contracts) };
      fn(local);
      state.contracts = local.contracts;
      showDashboard();
      const data = await state.store.mutate(fn, message);
      state.contracts = data.contracts;
      state.settings = data.settings || {};
      state.lastLoaded = new Date();
      showDashboard();
    } catch (e) {
      await reload(true);
      throw e;
    } finally {
      if (!quiet) busy(null);
    }
  }

  // ---------- upload / edit dialog ----------

  function msRow(m) {
    return `<li data-id="${esc(m.id || uid())}">
      <input type="checkbox" class="ms-inc" ${m.include !== false ? 'checked' : ''} aria-label="Track this milestone">
      <input type="date" class="ms-date" value="${esc(m.date || '')}" aria-label="Date">
      <input class="ms-label" value="${esc(m.label || '')}" placeholder="Milestone description" aria-label="Description">
      <input type="hidden" class="ms-done" value="${m.done ? '1' : ''}">
    </li>`;
  }

  function openEdit(contract) {
    state.editing = contract || null;
    state.pendingFile = null;
    const f = $('#editForm');
    f.reset();
    $('#editTitle').textContent = contract ? 'Edit details' : 'Upload contract or document';
    $('#dropZone').hidden = !!contract;
    $('#factFields').hidden = !contract;
    $('#extractNotice').hidden = true;
    $('#editError').hidden = true;
    $('#saveBtn').disabled = !contract;
    $('#saveBtn').textContent = contract ? 'Save changes' : 'Save';
    $('#endHint').textContent = '';
    $('#msHint').hidden = !!contract;
    $('#msEdit').innerHTML = '';
    $('#rescanBtn').hidden = !contract?.file;
    state.extracted = null;
    state.autoEnd = !!contract?.endCalculated;
    state.dueSuggested = !!contract?.dueSuggested;
    let cat = contract?.category || '', sub = contract?.subtype || '';
    if (contract && !CATEGORIES[cat]) {
      // older entries saved before categories existed: suggest one from what we know
      const g = classify([contract.title, contract.type, contract.parties, contract.fees, contract.notes].join(' \n'), contract.title || '');
      cat = g.category; sub = g.subtype;
    }
    if (!contract && CATEGORIES[state.category]) { cat = state.category; sub = state.subtype; }
    setCategory(cat, sub, contract && !CATEGORIES[contract.category] && cat ? 'Suggested category, please check' : '');
    if (contract) {
      fillFields(contract);
      if (state.autoEnd) $('#endHint').textContent = 'Calculated from start date + tenure';
      $('#msEdit').innerHTML = (contract.milestones || []).map((m) => msRow({ ...m, include: true })).join('');
    }
    $('#editDialog').showModal();
  }

  function fillFields(v) {
    const f = $('#editForm');
    for (const k of ['title', 'counterparty', 'type', 'parties', 'effectiveDate', 'endDate', 'tenure', 'value', 'noticeDays', 'owner', 'governingLaw', 'renewal', 'fees', 'notes', 'period', 'reference', 'ids', 'ownerEmail']) {
      if (f[k]) f[k].value = v[k] ?? '';
    }
  }

  function setCategory(cat, sub, hint) {
    const f = $('#editForm');
    for (const r of $$('input[name=category]', f)) r.checked = r.value === cat;
    const subs = CATEGORIES[cat]?.subtypes || [];
    f.subtype.innerHTML = `<option value="">${cat ? 'Choose…' : 'Pick a category first'}</option>` + subs.map((x) => `<option ${x === sub ? 'selected' : ''}>${esc(x)}</option>`).join('');
    f.subtype.disabled = !subs.length;
    const comp = cat === 'compliance';
    f.classList.toggle('is-compliance', comp);
    $$('[data-c]', f).forEach((el) => { el.textContent = comp ? el.dataset.k : el.dataset.c; });
    $('#catHint').textContent = hint || '';
  }

  // Fill the closing date from start date + tenure, unless someone typed their own.
  function recalcEnd() {
    const f = $('#editForm');
    if (f.classList.contains('is-compliance')) return;
    const t = parseTenure(f.tenure.value);
    if (!f.effectiveDate.value || !t) {
      if (state.autoEnd) { f.endDate.value = ''; $('#endHint').textContent = ''; }
      return;
    }
    if (f.endDate.value && !state.autoEnd) return;
    f.endDate.value = addTerm(f.effectiveDate.value, t.n, t.unit);
    state.autoEnd = true;
    $('#endHint').textContent = 'Calculated from start date + tenure — please check';
  }

  async function rescan() {
    const c = state.editing;
    if (!c?.file) return;
    const btn = $('#rescanBtn');
    btn.disabled = true;
    try {
      const blob = await state.store.downloadFile(c.file.path);
      await handleFile(new File([blob], c.file.name, { type: c.file.mime || blob.type }), true);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function handleFile(file, rescanning) {
    if (!file) return;
    if (!rescanning) state.pendingFile = file;
    const notice = $('#extractNotice');
    notice.hidden = false;
    notice.className = 'notice';
    notice.innerHTML = `<span class="spinner sm"></span> Reading <strong>${esc(file.name)}</strong>…`;
    let facts;
    try {
      const text = await readText(file);
      facts = analyze(text, file.name, state.cfg.dateFormat || 'DMY');
    } catch (e) {
      console.error(e);
      facts = analyze('', file.name, 'DMY');
    }
    const f = $('#editForm');
    const keep = rescanning ? { owner: f.owner.value, notes: f.notes.value } : { owner: '', notes: '' };
    // when re-reading, keep dates someone already entered if the document has none
    if (rescanning && !facts.effectiveDate) { facts.effectiveDate = f.effectiveDate.value; facts.endDate = f.endDate.value; facts.endCalculated = state.autoEnd; }
    const curCat = f.category.value;
    const cat = facts.category || curCat;
    setCategory(cat, facts.category ? facts.subtype : f.subtype.value, facts.category ? 'Detected from the document, please check' : cat ? '' : 'Could not tell the category from the document, please choose one');
    fillFields({ ...facts, ...keep });
    state.extracted = facts;
    state.autoEnd = !!facts.endCalculated;
    state.dueSuggested = !!facts.dueSuggested;
    $('#endHint').textContent = facts.endCalculated ? 'Calculated from start date + tenure — please check' : facts.dueSuggested ? 'Suggested from the return period — please check' : '';
    recalcEnd();
    const todayIso = toIso(today());
    // past dates are usually history, so they start unticked
    const existing = new Set($$('#msEdit .ms-date').map((i) => i.value));
    const rows = facts.milestones.filter((m) => !existing.has(m.date)).map((m) => msRow({ ...m, include: m.include && m.date >= todayIso })).join('');
    if (rescanning) $('#msEdit').insertAdjacentHTML('beforeend', rows); else $('#msEdit').innerHTML = rows;
    $('#msHint').hidden = !facts.milestones.length;
    $('#factFields').hidden = false;
    $('#saveBtn').disabled = false;
    if (!rescanning) {
      $('#dropZone').classList.add('has-file');
      $('#dropZone p').innerHTML = `<strong>${esc(file.name)}</strong> · ${fmtSize(file.size)} — click to choose a different file`;
    }
    if (facts.textFound) {
      notice.className = 'notice ok';
      notice.textContent = `Facts were filled in automatically from the document. Please check them before saving${facts.milestones.length ? `; ${facts.milestones.length} dates found below` : ''}.`;
      if (facts.datesBlank && !f.effectiveDate.value && cat !== 'compliance') {
        notice.className = 'notice warn';
        notice.textContent = `The signing / start date is left blank in this document (it looks like an unsigned copy). Enter the start date below${facts.tenure ? ` and the closing date will be calculated from the ${facts.tenure.replace(/ from .*/, '')} tenure` : ''}. Other facts were filled in; please check them.`;
      }
    } else {
      notice.className = 'notice warn';
      notice.textContent = 'No readable text was found (this is common for scanned PDFs). The file will still be stored. Please type the key facts below.';
    }
  }

  function readMilestones() {
    return $$('#msEdit li').filter((li) => $('.ms-inc', li).checked && $('.ms-date', li).value).map((li) => ({
      id: li.dataset.id,
      date: $('.ms-date', li).value,
      label: $('.ms-label', li).value.trim() || 'Milestone',
      done: $('.ms-done', li).value === '1',
    }));
  }

  async function submitEdit(ev) {
    ev.preventDefault();
    const f = $('#editForm');
    const err = $('#editError');
    err.hidden = true;
    const get = (k) => f[k].value.trim();
    const fields = {
      title: get('title'), counterparty: get('counterparty'), type: get('type'), parties: get('parties'),
      effectiveDate: get('effectiveDate'), endDate: get('endDate'), tenure: get('tenure'), value: get('value'),
      noticeDays: get('noticeDays') ? Number(get('noticeDays')) : '', owner: get('owner'), governingLaw: get('governingLaw'),
      renewal: get('renewal'), fees: get('fees'), notes: get('notes'), milestones: readMilestones(),
      category: f.category.value, subtype: f.subtype.value, period: get('period'), reference: get('reference'), ids: get('ids'),
      ownerEmail: Cal.emails(get('ownerEmail')).join(', '),
      dueSuggested: !!(state.dueSuggested && get('endDate')),
    };
    if (!CATEGORIES[fields.category]) { err.textContent = 'Please choose a category: B2B, RTD or Compliance.'; err.hidden = false; return; }
    if (!fields.title) { err.textContent = 'Please give it a name.'; err.hidden = false; return; }
    if (get('ownerEmail') && !fields.ownerEmail) { err.textContent = 'The owner email does not look right.'; err.hidden = false; return; }
    if (fields.category === 'compliance') {
      // contract-only fields don't apply to compliance documents
      Object.assign(fields, { type: '', parties: '', tenure: '', noticeDays: '', governingLaw: '', renewal: '', fees: '' });
    } else if (fields.effectiveDate && fields.endDate && fields.endDate < fields.effectiveDate) { err.textContent = 'The closing date is before the start date.'; err.hidden = false; return; }
    fields.endCalculated = !!(state.autoEnd && fields.endDate && fields.category !== 'compliance');
    $('#saveBtn').disabled = true;
    try {
      if (state.editing) {
        const id = state.editing.id;
        $('#editDialog').close();
        await save((d) => { const c = find(d, id); if (c) Object.assign(c, fields, { updatedAt: new Date().toISOString() }); }, `Update ${fields.title}`);
        toast('Changes saved');
        syncCalendar(id);
      } else {
        const file = state.pendingFile;
        const id = uid();
        const safe = file.name.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_');
        const path = `files/${id}/${safe}`;
        busy('Uploading document…');
        await state.store.uploadFile(path, file);
        const now = new Date().toISOString();
        const record = { id, ...fields, file: { path, name: file.name, size: file.size, mime: file.type || '' }, createdAt: now, updatedAt: now };
        $('#editDialog').close();
        await save((d) => { d.contracts.push(record); }, `Add ${fields.title}`);
        toast('Saved');
        openDrawer(id);
        syncCalendar(id);
      }
    } catch (e) {
      busy(null);
      $('#saveBtn').disabled = false;
      if (!$('#editDialog').open) toast(e.message, 'err');
      else { err.textContent = e.message; err.hidden = false; }
    }
  }

  // ---------- CSV export ----------

  function exportCsv() {
    const cols = ['title', 'category', 'subtype', 'counterparty', 'type', 'status', 'period', 'reference', 'ids', 'effectiveDate', 'endDate', 'tenure', 'value', 'noticeDays', 'noticeDeadline', 'nextMilestone', 'nextMilestoneDate', 'owner', 'governingLaw', 'fees', 'renewal', 'notes'];
    const rows = visibleContracts().map((c) => {
      const n = nextEvent(c);
      return {
        ...c, category: CATEGORIES[c.category]?.label || '', status: statusLabel(statusOf(c), isComp(c)),
        noticeDeadline: c.endDate && c.noticeDays ? addDays(c.endDate, -Number(c.noticeDays)) : '',
        nextMilestone: n?.label || '', nextMilestoneDate: n?.date || '',
      };
    });
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...rows.map((r) => cols.map((k) => q(r[k])).join(','))].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `tmc-contracts-${toIso(today())}.csv`;
    a.click();
  }

  // ---------- events ----------

  function bind() {
    $('#connectForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const cfg = { ...(state.cfg || {}), owner: f.owner.value.trim(), repo: f.repo.value.trim(), token: f.token.value.trim(), branch: '' };
      busy('Connecting to GitHub…');
      try { await connect(cfg); f.token.value = ''; toast('Connected'); }
      catch (err) { busy(null); showConnect(err.message); }
    });

    $('#uploadBtn').addEventListener('click', () => openEdit(null));
    $('#emptyUpload').addEventListener('click', () => openEdit(null));
    $('#refreshBtn').addEventListener('click', () => reload());
    $('#exportBtn').addEventListener('click', exportCsv);

    $('#settingsBtn').addEventListener('click', () => {
      const f = $('#settingsForm');
      f.expiringDays.value = String(expiringDays());
      f.dateFormat.value = state.cfg?.dateFormat || 'DMY';
      $('#settingsConn').textContent = state.store ? `Connected to ${state.cfg.owner}/${state.cfg.repo} (${state.cfg.branch}).` : 'Not connected.';
      $('#disconnectBtn').hidden = !state.store;
      const cal = calCfg();
      $('#calStatus').textContent = cal
        ? `On. Dates go to the Google Calendar the script runs under, with each item's owner invited; heads-up ${cal.leadDays ?? 30} days before.`
        : 'Off. Owners can still be added to a date one at a time with the calendar icon next to it.';
      $('#calSetupBtn').textContent = cal ? 'Change' : 'Set up';
      $('#calSetupBtn').hidden = !state.store;
      $('#settingsDialog').showModal();
    });
    $('#settingsForm').addEventListener('submit', () => {
      const f = $('#settingsForm');
      state.cfg = { ...(state.cfg || {}), expiringDays: Number(f.expiringDays.value), dateFormat: f.dateFormat.value };
      if (state.store) { state.store.cfg = state.cfg; saveConfig(state.cfg); render(); if (state.openId) renderDrawer(); }
    });
    $('#disconnectBtn').addEventListener('click', () => {
      if (!confirm('Remove the access token from this browser? Your contracts stay safe in GitHub.')) return;
      clearConfig();
      state.store = null;
      state.contracts = [];
      state.cfg = { owner: state.cfg?.owner, repo: state.cfg?.repo };
      $('#settingsDialog').close();
      closeDrawer();
      showConnect();
    });

    $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

    document.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-cat]');
      if (tab) {
        state.category = tab.dataset.cat; state.subtype = ''; state.filter = 'all';
        try { localStorage.setItem('tmc.tab', state.category); } catch { /* storage blocked */ }
        render();
        return;
      }
      const f = e.target.closest('[data-filter]');
      if (f) { state.filter = f.dataset.filter; render(); return; }
      const th = e.target.closest('th[data-sort]');
      if (th) {
        const k = th.dataset.sort;
        state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
        renderTable();
        return;
      }
      const act = e.target.closest('#drawer [data-action]');
      if (act && act.dataset.action !== 'toggle') { drawerAction(act.dataset.action, act); return; }
      const open = e.target.closest('[data-open]');
      if (open) openDrawer(open.dataset.open);
    });
    document.addEventListener('change', (e) => {
      if (e.target.matches('#drawer [data-action="toggle"]')) drawerAction('toggle', e.target);
    });
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-open], li[data-open]')) { e.preventDefault(); openDrawer(e.target.dataset.open); }
      if (e.key === 'Escape' && state.openId && !$('dialog[open]')) closeDrawer();
    });
    document.addEventListener('submit', async (e) => {
      if (e.target.id !== 'addMsForm') return;
      e.preventDefault();
      const c = state.contracts.find((x) => x.id === state.openId);
      const date = e.target.date.value, label = e.target.label.value.trim();
      if (!c || !date || !label) return;
      try {
        await save((d) => { const x = find(d, c.id); if (x) (x.milestones = x.milestones || []).push({ id: uid(), date, label, done: false }); }, `Add milestone to ${c.title}`, true);
        toast('Milestone added');
        syncCalendar(c.id, true);
      } catch (err) { toast(err.message, 'err'); }
    });

    $('#drawerScrim').addEventListener('click', closeDrawer);
    $('#search').addEventListener('input', (e) => { state.search = e.target.value; renderTable(); });
    $('#horizon').addEventListener('change', renderTimeline);

    // file picking
    const dz = $('#dropZone'), fi = $('#fileInput');
    fi.addEventListener('change', () => handleFile(fi.files[0]));
    ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
    $('#addMsBtn').addEventListener('click', () => {
      $('#msEdit').insertAdjacentHTML('beforeend', msRow({ include: true }));
      $('#msEdit li:last-child .ms-date').focus();
    });
    $('#editForm').addEventListener('submit', submitEdit);
    $('#calSetupBtn').addEventListener('click', openCalDialog);
    $('#calTestBtn').addEventListener('click', testCal);
    $('#copyScriptBtn').addEventListener('click', async () => {
      const text = $('#scriptText').textContent;
      try { await navigator.clipboard.writeText(text); $('#copyMsg').textContent = 'Copied. Paste it into the script editor.'; }
      catch { const d = $('#scriptText').closest('details'); d.open = true; getSelection().selectAllChildren($('#scriptText')); $('#copyMsg').textContent = 'Press Ctrl+C (Cmd+C) to copy the selected script.'; }
    });
    $('#calForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const url = await testCal();
      if (!url) return;
      try {
        await saveSettings({ calendar: { url, key: state.calKey, leadDays: Number(f.leadDays.value), alwaysInvite: Cal.emails(f.alwaysInvite.value).join(', ') } });
        $('#calDialog').close();
        render();
        await syncAll();
      } catch (err) { calMsg(err.message, 'warn'); }
    });
    $('#calOffBtn').addEventListener('click', async () => {
      if (!confirm('Turn off automatic Google Calendar reminders? Events already in the calendar stay there.')) return;
      try { await saveSettings({ calendar: null }); $('#calDialog').close(); render(); if (state.openId) renderDrawer(); toast('Calendar reminders turned off'); }
      catch (err) { calMsg(err.message, 'warn'); }
    });
    $('#rescanBtn').addEventListener('click', rescan);
    ['effectiveDate', 'tenure'].forEach((k) => $(`#editForm [name=${k}]`).addEventListener('input', recalcEnd));
    $('#editForm [name=endDate]').addEventListener('input', () => { state.autoEnd = false; state.dueSuggested = false; $('#endHint').textContent = ''; });
    $$('#editForm input[name=category]').forEach((r) => r.addEventListener('change', () => { setCategory(r.value, ''); recalcEnd(); }));
    $('#subFilter').addEventListener('change', (e) => { state.subtype = e.target.value; render(); });

    // keep it live: refresh when you come back to the tab and every 2 minutes
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reload(true); });
    setInterval(() => { if (!document.hidden && !$('dialog[open]')) reload(true); }, 120000);
  }

  // ---------- start ----------

  async function start() {
    bind();
    state.cfg = loadConfig();
    if (state.cfg?.token) {
      busy('Connecting to GitHub…');
      try { await connect(state.cfg); }
      catch (e) { busy(null); showConnect(e.message); }
    } else {
      showConnect();
    }
  }

  start();
})();
