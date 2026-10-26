// TMC Contract Dashboard – UI.

(function () {
  'use strict';

  const { GitHubStore, loadConfig, saveConfig, clearConfig } = window.ContractStore;
  const { readText, analyze } = window.ContractExtract;

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const state = {
    cfg: null,
    store: null,
    contracts: [],
    filter: 'all',
    search: '',
    sort: { key: 'endDate', dir: 1 },
    openId: null,
    editing: null, // contract being edited, or null for a new upload
    pendingFile: null,
    lastLoaded: null,
  };

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
    const start = daysUntil(c.effectiveDate);
    if (end !== null && end < 0) return 'expired';
    if (start !== null && start > 0) return 'upcoming';
    if (end === null) return 'open';
    if (end <= expiringDays()) return 'expiring';
    return 'active';
  }

  function eventsOf(c) {
    const ev = (c.milestones || []).map((m) => ({ ...m, kind: 'milestone', contract: c }));
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

  function badge(st) {
    const s = STATUS[st];
    return `<span class="badge ${s.cls}"><span class="b-icon" aria-hidden="true">${s.icon}</span>${s.label}</span>`;
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
    renderKpis();
    renderFilters();
    renderTable();
    renderTimeline();
  }

  function renderKpis() {
    const counts = { all: state.contracts.length, active: 0, expiring: 0, expired: 0 };
    let next = null;
    for (const c of state.contracts) {
      const s = statusOf(c);
      if (s === 'active' || s === 'expiring' || s === 'open') counts.active++;
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
    $('#kpis').innerHTML =
      tile('all', 'Total contracts', counts.all, 'on record') +
      tile('active', 'Active', counts.active, 'currently in force') +
      tile('expiring', 'Expiring soon', counts.expiring, `closing within ${expiringDays()} days`) +
      tile('expired', 'Expired', counts.expired, 'past closing date') +
      `<button class="kpi next" ${next ? `data-open="${esc(next.contract.id)}"` : 'disabled'}>
        <span class="kpi-label">Next deadline</span>
        <span class="kpi-value sm">${next ? esc(relDays(daysUntil(next.date))) : '—'}</span>
        <span class="kpi-sub">${next ? `${esc(fmtDate(next.date))} · ${esc(next.contract.title)}` : 'nothing scheduled'}</span>
      </button>`;
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
    const count = (f) => state.contracts.filter((c) => { const keep = state.filter; state.filter = f; const r = matchesFilter(c); state.filter = keep; return r; }).length;
    $('#filters').innerHTML = FILTERS.map(([k, l]) =>
      `<button class="chip" role="tab" data-filter="${k}" aria-selected="${state.filter === k}">${l}<span class="count">${count(k)}</span></button>`).join('');
  }

  function visibleContracts() {
    const q = state.search.trim().toLowerCase();
    const list = state.contracts.filter(matchesFilter).filter((c) =>
      !q || [c.title, c.counterparty, c.parties, c.type, c.owner, c.notes, c.value].join(' ').toLowerCase().includes(q));
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
    $('#emptyState').hidden = state.contracts.length > 0;
    $('#contractTable').hidden = state.contracts.length === 0;
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
        <td><div class="t-title">${esc(c.title)}</div><div class="t-sub">${esc(c.type || '')}${c.type && c.value ? ' · ' : ''}${esc(c.value || '')}</div></td>
        <td class="hide-md">${esc(c.counterparty || '—')}</td>
        <td><div>${fmtDate(c.endDate)}</div><div class="t-sub">${c.endDate ? esc(relDays(left)) : ''}</div></td>
        <td class="hide-sm">${pct === null ? '<span class="muted">—</span>' : `<div class="bar" title="${pct}% of the tenure has passed"><span style="width:${pct}%"></span></div><div class="t-sub">${pct}%${c.tenure ? ' of ' + esc(c.tenure) : ''}</div>`}</td>
        <td>${badge(st)}</td>
        <td class="hide-md">${n ? `<div class="t-clip">${esc(n.label)}</div><div class="t-sub">${fmtDate(n.date)} · ${esc(relDays(daysUntil(n.date)))}</div>` : '<span class="muted">—</span>'}</td>
      </tr>`;
    }).join('');
  }

  function renderTimeline() {
    const horizon = Number($('#horizon').value);
    const all = state.contracts.flatMap(eventsOf);
    const overdue = all.filter((e) => e.kind === 'milestone' && !e.done && daysUntil(e.date) < 0 && daysUntil(e.date) >= -180);
    const soon = all.filter((e) => !e.done && daysUntil(e.date) >= 0 && daysUntil(e.date) <= horizon);
    const item = (e) => {
      const d = daysUntil(e.date);
      const urgency = d < 0 ? 'critical' : d <= 14 ? 'serious' : d <= 45 ? 'warning' : 'calm';
      const kindLabel = { end: 'Closing date', notice: 'Notice deadline', start: 'Start', milestone: 'Milestone' }[e.kind];
      return `<li class="tl-item ${urgency}" data-open="${esc(e.contract.id)}" tabindex="0">
        <div class="tl-date"><span class="tl-day">${parse(e.date).getDate()}</span><span class="tl-mon">${parse(e.date).toLocaleDateString('en-GB', { month: 'short' })}</span></div>
        <div class="tl-body">
          <div class="tl-label">${esc(e.label)}</div>
          <div class="t-sub">${esc(e.contract.title)}</div>
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

    $('#drawerBody').innerHTML = `
      <div class="drawer-head">
        <div>
          <p class="eyebrow">${esc(c.type || 'Contract')}</p>
          <h2 id="drawerTitle">${esc(c.title)}</h2>
          ${badge(st)}
        </div>
        <button class="icon-btn" data-action="close" aria-label="Close">✕</button>
      </div>

      <section class="hero">
        <div>
          <span class="kpi-label">${left === null ? 'Closing date' : left < 0 ? 'Closed' : 'Closes'}</span>
          <span class="hero-value">${c.endDate ? esc(relDays(left)) : 'No end date'}</span>
          <span class="t-sub">${c.endDate ? fmtDate(c.endDate) : 'Add an end date to track expiry'}</span>
        </div>
        ${pct !== null ? `<div class="hero-bar">
          <div class="bar lg"><span style="width:${pct}%"></span></div>
          <div class="bar-ends"><span>${fmtDate(c.effectiveDate)}</span><span>${pct}% elapsed</span><span>${fmtDate(c.endDate)}</span></div>
        </div>` : ''}
      </section>

      <dl class="facts">
        ${fact('Counterparty', c.counterparty)}
        ${fact('Parties', c.parties)}
        ${fact('Start / effective date', c.effectiveDate && fmtDate(c.effectiveDate))}
        ${fact('Closing / end date', c.endDate && fmtDate(c.endDate), c.endCalculated ? 'calculated from start date + tenure' : '')}
        ${fact('Tenure', c.tenure)}
        ${fact('Contract value', c.value)}
        ${fact('Notice period', c.noticeDays ? `${c.noticeDays} days` : '', noticeDate ? `give notice by ${fmtDate(noticeDate)}` : '')}
        ${fact('Owner at TMC', c.owner)}
        ${fact('Governing law', c.governingLaw)}
      </dl>
      ${c.renewal ? `<div class="block"><h3>Renewal</h3><p>${esc(c.renewal)}</p></div>` : ''}
      ${c.notes ? `<div class="block"><h3>Notes</h3><p class="pre">${esc(c.notes)}</p></div>` : ''}

      <div class="block">
        <div class="ms-head"><h3>Milestones &amp; key dates</h3></div>
        <ul class="ms-list">
          ${events.length ? events.map((e) => {
            const d = daysUntil(e.date);
            const isMs = e.kind === 'milestone';
            const late = isMs && !e.done && d < 0;
            return `<li class="${e.done ? 'done' : ''} ${late ? 'late' : ''}">
              ${isMs ? `<input type="checkbox" data-action="toggle" data-ms="${esc(e.id)}" ${e.done ? 'checked' : ''} aria-label="Mark done">` : `<span class="ms-dot ${e.kind}" aria-hidden="true"></span>`}
              <div class="ms-body">
                <div>${esc(e.label)}</div>
                <div class="t-sub">${fmtDate(e.date)} · ${e.done ? 'done' : late ? 'overdue ' + relDays(d).replace(' ago', '') : esc(relDays(d))}</div>
              </div>
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
      else if (action === 'edit') openEdit(c);
      else if (action === 'toggle') {
        const id = el.dataset.ms, done = el.checked;
        await save((d) => { const m = find(d, c.id)?.milestones.find((x) => x.id === id); if (m) m.done = done; }, `Update milestone on ${c.title}`, true);
      } else if (action === 'del-ms') {
        const id = el.dataset.ms;
        await save((d) => { const x = find(d, c.id); if (x) x.milestones = x.milestones.filter((m) => m.id !== id); }, `Remove milestone from ${c.title}`, true);
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
        if (!confirm(`Delete “${c.title}” and its document? This cannot be undone from the dashboard.`)) return;
        busy('Deleting…');
        if (c.file) await state.store.deleteFile(c.file.path);
        await save((d) => { d.contracts = d.contracts.filter((x) => x.id !== c.id); }, `Delete ${c.title}`);
        closeDrawer();
        toast('Contract deleted');
      }
    } catch (e) {
      busy(null);
      toast(e.message, 'err');
    }
  }

  function find(data, id) { return data.contracts.find((x) => x.id === id); }

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
    $('#editTitle').textContent = contract ? 'Edit contract' : 'Upload contract';
    $('#dropZone').hidden = !!contract;
    $('#factFields').hidden = !contract;
    $('#extractNotice').hidden = true;
    $('#editError').hidden = true;
    $('#saveBtn').disabled = !contract;
    $('#saveBtn').textContent = contract ? 'Save changes' : 'Save contract';
    $('#endHint').textContent = '';
    $('#msHint').hidden = !!contract;
    $('#msEdit').innerHTML = '';
    if (contract) {
      fillFields(contract);
      $('#msEdit').innerHTML = (contract.milestones || []).map((m) => msRow({ ...m, include: true })).join('');
    }
    $('#editDialog').showModal();
  }

  function fillFields(v) {
    const f = $('#editForm');
    for (const k of ['title', 'counterparty', 'type', 'parties', 'effectiveDate', 'endDate', 'tenure', 'value', 'noticeDays', 'owner', 'governingLaw', 'renewal', 'notes']) {
      if (f[k]) f[k].value = v[k] ?? '';
    }
  }

  async function handleFile(file) {
    if (!file) return;
    state.pendingFile = file;
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
    fillFields({ ...facts, owner: '', notes: '' });
    state.extracted = facts;
    $('#endHint').textContent = facts.endCalculated ? 'Calculated from start date + tenure — please check' : '';
    const todayIso = toIso(today());
    // past dates are usually history, so they start unticked
    $('#msEdit').innerHTML = facts.milestones.map((m) => msRow({ ...m, include: m.include && m.date >= todayIso })).join('');
    $('#msHint').hidden = !facts.milestones.length;
    $('#factFields').hidden = false;
    $('#saveBtn').disabled = false;
    $('#dropZone').classList.add('has-file');
    $('#dropZone p').innerHTML = `<strong>${esc(file.name)}</strong> · ${fmtSize(file.size)} — click to choose a different file`;
    if (facts.textFound) {
      notice.className = 'notice ok';
      notice.textContent = `Facts were filled in automatically from the document. Please check them before saving${facts.milestones.length ? `; ${facts.milestones.length} dates found below` : ''}.`;
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
      renewal: get('renewal'), notes: get('notes'), milestones: readMilestones(),
    };
    if (!fields.title) { err.textContent = 'Please give the contract a name.'; err.hidden = false; return; }
    if (fields.effectiveDate && fields.endDate && fields.endDate < fields.effectiveDate) { err.textContent = 'The closing date is before the start date.'; err.hidden = false; return; }
    const ext = state.extracted;
    fields.endCalculated = !!(ext && ext.endCalculated && ext.endDate === fields.endDate && !state.editing);
    $('#saveBtn').disabled = true;
    try {
      if (state.editing) {
        const id = state.editing.id;
        if (state.editing.endDate !== fields.endDate) fields.endCalculated = false;
        else fields.endCalculated = state.editing.endCalculated || false;
        $('#editDialog').close();
        await save((d) => { const c = find(d, id); if (c) Object.assign(c, fields, { updatedAt: new Date().toISOString() }); }, `Update ${fields.title}`);
        toast('Changes saved');
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
        toast('Contract saved');
        openDrawer(id);
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
    const cols = ['title', 'counterparty', 'type', 'status', 'effectiveDate', 'endDate', 'tenure', 'value', 'noticeDays', 'noticeDeadline', 'nextMilestone', 'nextMilestoneDate', 'owner', 'governingLaw', 'renewal', 'notes'];
    const rows = visibleContracts().map((c) => {
      const n = nextEvent(c);
      return {
        ...c, status: STATUS[statusOf(c)].label,
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
