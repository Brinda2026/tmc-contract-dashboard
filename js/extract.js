// Reads text out of an uploaded contract and pulls out the key facts.
// Everything runs in the browser; the file never leaves the device except
// when it is saved to your private GitHub data repository.

(function () {
  'use strict';

  const MONTHS = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
    september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };
  const WORD_NUMS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, fifteen: 15, eighteen: 18, twenty: 20,
    'twenty-four': 24, thirty: 30, 'thirty-six': 36, forty: 40, 'forty-five': 45,
    sixty: 60, ninety: 90, 'one hundred twenty': 120, 'one hundred eighty': 180,
  };
  const NUM_WORD = '(\\d{1,3}|' + Object.keys(WORD_NUMS).sort((a, b) => b.length - a.length).join('|') + ')';

  function toNum(s) {
    if (!s) return null;
    s = s.toLowerCase().trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    return WORD_NUMS[s] ?? null;
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(y, m, d) {
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1950 || y > 2100) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getMonth() !== m - 1) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  // ---------- text extraction ----------

  async function readText(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.pdf') || file.type === 'application/pdf') {
      const pdfjsLib = window.pdfjsLib;
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        let line = '', out = [], lastY = null;
        for (const item of content.items) {
          const y = item.transform ? item.transform[5] : null;
          if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) { out.push(line); line = ''; }
          line += item.str + (item.hasEOL ? '\n' : '');
          lastY = y;
        }
        out.push(line);
        pages.push(out.join('\n'));
      }
      return pages.join('\n\n');
    }
    if (name.endsWith('.docx')) {
      const res = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      return res.value;
    }
    if (name.endsWith('.txt') || name.endsWith('.md') || file.type.startsWith('text/')) {
      return await file.text();
    }
    return '';
  }

  // ---------- date finding ----------

  const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
  const DATE_PATTERNS = [
    // January 5, 2026 / Jan. 5th 2026
    { re: new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), f: (m) => iso(+m[3], MONTHS[m[1].toLowerCase().replace('.', '')], +m[2]) },
    // 5 January 2026 / 5th day of January, 2026
    { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:day\\s+of\\s+)?${MONTH_RE},?\\s+(\\d{4})\\b`, 'gi'), f: (m) => iso(+m[3], MONTHS[m[2].toLowerCase().replace('.', '')], +m[1]) },
    // 2026-01-05
    { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, f: (m) => iso(+m[1], +m[2], +m[3]) },
    // 05/01/2026 or 05.01.2026 or 05-01-2026
    { re: /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\b/g, f: (m, fmt) => {
      let a = +m[1], b = +m[2];
      let d = fmt === 'MDY' ? b : a, mo = fmt === 'MDY' ? a : b;
      if (mo > 12 && d <= 12) [d, mo] = [mo, d];
      return iso(+m[3], mo, d);
    } },
  ];

  function findDates(text, fmt) {
    const found = [];
    for (const p of DATE_PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(text))) {
        const date = p.f(m, fmt);
        if (!date) continue;
        if (found.some((x) => m.index < x.end && m.index + m[0].length > x.index)) continue;
        found.push({ date, index: m.index, end: m.index + m[0].length, raw: m[0] });
      }
    }
    return found.sort((a, b) => a.index - b.index);
  }

  function sentenceAround(text, index, end) {
    // a sentence ends at ". " / "; " / a line break (so "30/06/2025." or "2.5" do not split early)
    const isStop = (i) => text[i] === '\n' || (/[.;]/.test(text[i]) && /\s/.test(text[i + 1] || ' '));
    let s = index, e = end;
    while (s > 0 && index - s < 220 && !isStop(s - 1)) s--;
    while (e < text.length && e - end < 220 && !isStop(e)) e++;
    return text.slice(s, e).replace(/\s+/g, ' ').trim();
  }

  // ---------- facts ----------

  const KW = {
    effective: /(effective\s+date|commence|commencement|start\s+date|dated\s+as\s+of|entered\s+into|made\s+(?:on|this)|signed\s+on|executed\s+on|with\s+effect\s+from)/i,
    end: /(expir|end\s+date|terminat\w*\s+on|shall\s+(?:end|terminate)|until|through|valid\s+(?:till|until|up\s*to))/i,
    milestone: /(due|deliver|payment|pay\b|milestone|review|renew|notice|complet|deadline|phase|launch|go-live|handover|installment|instalment|audit|report|submit|acceptance|kick-?off|invoice)/i,
  };

  function addTerm(start, n, unit) {
    const [y, m, d] = start.split('-').map(Number);
    let dt = new Date(y, m - 1, d);
    if (unit.startsWith('year')) dt.setFullYear(dt.getFullYear() + n);
    else if (unit.startsWith('month')) dt.setMonth(dt.getMonth() + n);
    else if (unit.startsWith('week')) dt.setDate(dt.getDate() + 7 * n);
    else dt.setDate(dt.getDate() + n);
    dt.setDate(dt.getDate() - 1); // a 1-year term from 1 Jan ends 31 Dec
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }

  function findTerm(text) {
    const re = new RegExp(`\\b(?:term|tenure|duration|period)\\b[^.]{0,120}?\\b${NUM_WORD}\\s*(?:\\(\\s*\\d+\\s*\\)\\s*)?(year|month|week|day)s?\\b`, 'i');
    const m = text.match(re);
    if (!m) return null;
    const n = toNum(m[1]);
    if (!n) return null;
    const unit = m[2].toLowerCase();
    return { n, unit, text: `${n} ${unit}${n === 1 ? '' : 's'}` };
  }

  function findNotice(text) {
    const re = new RegExp(`\\b${NUM_WORD}\\s*(?:\\(\\s*\\d+\\s*\\)\\s*)?(day|month)s?['’]?\\s*(?:prior\\s+|advance\\s+)?(?:written\\s+)?notice`, 'i');
    const m = text.match(re);
    if (!m) return null;
    const n = toNum(m[1]);
    if (!n) return null;
    return m[2].toLowerCase() === 'month' ? n * 30 : n;
  }

  function findRenewal(text) {
    const m = text.match(/[^.]{0,160}\b(automatic(?:ally)?\s+renew\w*|auto-?renew\w*|renew\w*\s+automatically|shall\s+be\s+renewed|may\s+be\s+renewed|renewal\s+term|option\s+to\s+renew|extend(?:ed)?\s+by\s+mutual)[^.]{0,160}/i);
    if (!m) return '';
    const s = m[0].replace(/\s+/g, ' ').trim();
    const auto = /automatic|auto-?renew/i.test(s);
    return (auto ? 'Auto-renews. ' : '') + (s.length > 220 ? s.slice(0, 217) + '…' : s);
  }

  function findLaw(text) {
    const m = text.match(/governed\s+by\s+(?:and\s+(?:construed|interpreted)\s+in\s+accordance\s+with\s+)?the\s+laws?\s+of\s+(?:the\s+)?([A-Z][A-Za-z ]{2,40}?)(?=[,.;(]|\s+(?:and|without|in|applicable))/);
    return m ? m[1].trim() : '';
  }

  function findValue(text) {
    const re = /(?:₹|Rs\.?|INR|USD|US\$|\$|€|EUR|£|GBP|AED|SGD)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:lakhs?|crores?|million|mn|billion|k)\b)?/gi;
    const all = [];
    let m;
    while ((m = re.exec(text))) {
      const ctx = text.slice(Math.max(0, m.index - 80), m.index).toLowerCase();
      const score = /(total|contract\s+(?:value|price|sum)|consideration|fee|amount|price|compensation)/.test(ctx) ? 2 : 1;
      all.push({ v: m[0].replace(/\s+/g, ' ').trim(), score, i: m.index });
    }
    if (!all.length) return '';
    all.sort((a, b) => b.score - a.score || a.i - b.i);
    return all[0].v;
  }

  const PARTY_END = /\s*(?:\n|\.\s+(?=(?:This|The|Whereas|WHEREAS|NOW|Now|Each|Both|Hereinafter|Recitals|RECITALS)\b)|,|\(|;|\bhaving\b|\ba company\b|\ba partnership\b|\bincorporated\b|\bregistered\b|\bwith (?:its|a) (?:registered|principal)\b|\bhereinafter\b|\bresiding\b|\band\b)/i;
  function cleanParty(s) {
    return s.replace(/\s+/g, ' ').replace(/^(?:the\s+|M\/s\.?\s*)/i, '').replace(/[,;:."']+$/, '').trim().slice(0, 90);
  }
  function findParties(text) {
    const head = text.slice(0, 5000).replace(/[ \t\r]+/g, ' ');
    const at = head.search(/\bbetween\b\s*:?/i);
    if (at < 0) return [];
    const seg = head.slice(at).replace(/^between\s*:?\s*/i, '').slice(0, 900);
    const cut1 = seg.search(PARTY_END);
    const p1 = cleanParty(cut1 > 0 ? seg.slice(0, cut1) : seg.slice(0, 80));
    const rest = seg.slice(Math.max(cut1, 0));
    const m = rest.match(/\b(?:and|AND|And)\s+(?:the\s+)?(?=M\/s|[A-Z0-9])/);
    if (!m) return p1.length > 2 ? [p1] : [];
    const seg2 = rest.slice(m.index + m[0].length);
    const cut2 = seg2.search(PARTY_END);
    const p2 = cleanParty(cut2 > 0 ? seg2.slice(0, cut2) : seg2.slice(0, 80));
    return [p1, p2].filter((p) => p.length > 2);
  }

  function findTitle(text, filename) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 15);
    const t = lines.find((l) => /(agreement|contract|memorandum|lease|deed|order|terms|addendum|amendment|mou|nda|sow|statement of work)/i.test(l) && l.length < 120);
    if (t) return t.replace(/\s+/g, ' ').replace(/^(.)(.*)$/, (_, a, b) => (t === t.toUpperCase() ? a + b.toLowerCase() : a + b));
    return filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  }

  function findType(text) {
    const t = text.slice(0, 3000).toLowerCase();
    const types = [
      ['non-disclosure', 'NDA'], ['confidentiality agreement', 'NDA'], ['statement of work', 'SOW'],
      ['master service', 'MSA'], ['service agreement', 'Services'], ['services agreement', 'Services'],
      ['lease', 'Lease'], ['rental', 'Lease'], ['employment', 'Employment'], ['consult', 'Consulting'],
      ['supply', 'Supply'], ['purchase', 'Purchase'], ['licen', 'License'], ['maintenance', 'Maintenance'],
      ['memorandum of understanding', 'MoU'], ['partnership', 'Partnership'], ['vendor', 'Vendor'],
    ];
    for (const [k, v] of types) if (t.includes(k)) return v;
    return '';
  }

  function analyze(text, filename, fmt) {
    const dates = findDates(text, fmt).map((d) => ({ ...d, context: sentenceAround(text, d.index, d.end) }));
    let effectiveDate = '', endDate = '';
    for (const d of dates) {
      const pre = text.slice(Math.max(0, d.index - 140), d.index);
      if (!effectiveDate && KW.effective.test(pre + ' ' + d.context.slice(0, 80))) effectiveDate = d.date;
      if (!endDate && KW.end.test(pre)) endDate = d.date;
    }
    if (!effectiveDate && dates.length) effectiveDate = dates[0].date;
    if (endDate && effectiveDate && endDate <= effectiveDate) endDate = '';

    const term = findTerm(text);
    let endCalculated = false;
    if (!endDate && term && effectiveDate) { endDate = addTerm(effectiveDate, term.n, term.unit); endCalculated = true; }

    const seen = new Set([effectiveDate, endDate]);
    const milestones = [];
    for (const d of dates) {
      if (seen.has(d.date)) continue;
      seen.add(d.date);
      let label = d.context.replace(d.raw, '').replace(/\s+/g, ' ').replace(/^[^A-Za-z0-9]+/, '').trim();
      if (label.length > 140) label = label.slice(0, 137) + '…';
      milestones.push({ date: d.date, label: label || 'Date mentioned in contract', include: KW.milestone.test(d.context) });
      if (milestones.length >= 30) break;
    }

    const parties = findParties(text);
    return {
      title: findTitle(text, filename),
      type: findType(text),
      parties: parties.join(' ⟷ '),
      counterparty: parties[1] || parties[0] || '',
      value: findValue(text),
      effectiveDate,
      endDate,
      endCalculated,
      tenure: term ? term.text : '',
      noticeDays: findNotice(text) || '',
      renewal: findRenewal(text),
      governingLaw: findLaw(text),
      milestones,
      textFound: text.trim().length > 50,
    };
  }

  window.ContractExtract = { readText, analyze, addTerm };
})();
