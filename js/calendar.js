// Google Calendar: turns an item's key dates into calendar events, talks to the
// Apps Script web app that writes them, and builds one-click "add" links.

(function () {
  'use strict';

  function pad(n) { return String(n).padStart(2, '0'); }
  function parse(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
  function toIso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function addDays(iso, n) { const d = parse(iso); d.setDate(d.getDate() + n); return toIso(d); }
  function fmt(iso) { return parse(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function todayIso() { return toIso(new Date()); }

  function emails(s) {
    return String(s || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  }

  function guestsFor(c, cal) {
    return [...new Set([...emails(c.ownerEmail), ...emails(cal?.alwaysInvite)])];
  }

  const CAT = { b2b: 'B2B', rtd: 'RTD', compliance: 'Compliance' };

  function describe(c, siteUrl) {
    const comp = c.category === 'compliance';
    const lines = [
      [CAT[c.category], c.subtype].filter(Boolean).join(' · '),
      c.counterparty && `${comp ? 'Authority' : 'Counterparty'}: ${c.counterparty}`,
      comp && c.period && `Period: ${c.period}`,
      comp && c.reference && `Reference: ${c.reference}`,
      c.endDate && `${comp ? 'Due date' : 'Closing date'}: ${fmt(c.endDate)}`,
      !comp && Number(c.noticeDays) > 0 && `Notice period: ${c.noticeDays} days`,
      !comp && c.renewal && `Renewal: ${c.renewal}`,
      (c.owner || c.ownerEmail) && `Owner: ${[c.owner, c.ownerEmail].filter(Boolean).join(' – ')}`,
      '',
      siteUrl && `Open the TMC Contract Dashboard: ${siteUrl}`,
    ];
    return lines.filter((l) => l !== false && l !== undefined && l !== null).join('\n');
  }

  // Every date worth a calendar entry for one contract / document.
  function buildEvents(c, cal, siteUrl) {
    const comp = c.category === 'compliance';
    const licence = c.subtype === 'Licence / registration';
    const name = c.title || 'Untitled';
    const guests = guestsFor(c, cal);
    const description = describe(c, siteUrl);
    const lead = Number(cal?.leadDays ?? 30);
    const ev = [];
    const add = (key, date, title, reminderDays) => ev.push({ key, date, title, description, guests, reminderDays });

    if (c.endDate) {
      add('due', c.endDate, comp ? `${licence ? 'Renewal due' : 'Filing due'}: ${name}` : `Contract ends: ${name}`, [7, 1]);
    }
    const notice = !comp && c.endDate && Number(c.noticeDays) > 0 ? addDays(c.endDate, -Number(c.noticeDays)) : null;
    if (notice) add('notice', notice, `Last day to give notice: ${name}`, [7, 1]);
    const base = notice || c.endDate;
    if (base && lead > 0) {
      const what = comp ? `Prepare ${licence ? 'renewal' : 'filing'}: ${name} (due ${fmt(c.endDate)})`
        : notice ? `Start renewal: ${name} (notice by ${fmt(notice)})` : `Start renewal: ${name} (ends ${fmt(c.endDate)})`;
      add('heads-up', addDays(base, -lead), what, [0]);
    }
    for (const m of c.milestones || []) {
      if (!m.done && m.date) add(`ms-${m.id}`, m.date, `${m.label} – ${name}`, [1]);
    }
    return ev;
  }

  // Only events still ahead are created; ones already in the calendar are kept up to date.
  function eventsToSync(c, cal, siteUrl) {
    const existing = c.calendar?.events || {};
    const today = todayIso();
    return buildEvents(c, cal, siteUrl).filter((e) => e.date >= today || existing[e.key]);
  }

  function gcalLink(e) {
    const d = e.date.replace(/-/g, '');
    const next = addDays(e.date, 1).replace(/-/g, '');
    const q = new URLSearchParams({ action: 'TEMPLATE', text: e.title, dates: `${d}/${next}`, details: e.description || '' });
    if (e.guests?.length) q.set('add', e.guests.join(','));
    return `https://calendar.google.com/calendar/render?${q.toString()}`;
  }

  async function call(cal, body) {
    let res;
    try {
      // text/plain keeps this a "simple" request, which Apps Script web apps accept from other sites
      res = await fetch(cal.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...body, key: cal.key }), redirect: 'follow' });
    } catch {
      throw new Error('Could not reach the Google script. Check the web app URL and that it is deployed with access "Anyone".');
    }
    let data;
    try { data = await res.json(); } catch { throw new Error(`The Google script did not answer properly (HTTP ${res.status}). Check that you deployed it as a Web app.`); }
    if (!data.ok) throw new Error(data.error || 'The Google script reported an error.');
    return data;
  }

  function newKey() {
    const a = new Uint8Array(18);
    crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  window.ContractCalendar = { buildEvents, eventsToSync, gcalLink, call, newKey, guestsFor, emails };
})();
