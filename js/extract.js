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
    while (s > 0 && index - s < 260 && !isStop(s - 1)) s--;
    while (e < text.length && e - end < 260 && !isStop(e)) e++;
    return text.slice(s, e).replace(/\s+/g, ' ').trim();
  }

  // PDFs break every printed line; join lines back into paragraphs, keeping a
  // break only where a new clause, bullet or heading starts.
  function flatten(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const isItem = (l) => /^(?:[•\-–▪●]|\d+(?:\.\d+)*[.)]\s|[A-Za-z][.)]\s|\(?[ivx]+[.)]\s|[A-Z][A-Z0-9 &/,.'’()–-]{3,}$)/.test(l);
    let out = lines[0] || '';
    for (let i = 1; i < lines.length; i++) out += (isItem(lines[i]) || isItem(lines[i - 1]) && /^[A-Z0-9 &/,.'’()–-]+$/.test(lines[i - 1]) ? '\n' : ' ') + lines[i];
    return out;
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

  // "2 years", "two (2) years", "18 months" typed into the tenure box
  function parseTenure(s) {
    const m = String(s || '').match(new RegExp(`${NUM_WORD}\\s*(?:\\(\\s*[\\w-]+\\s*\\)\\s*)?(year|month|week|day)s?`, 'i'));
    const n = m && toNum(m[1]);
    return n ? { n, unit: m[2].toLowerCase() } : null;
  }

  const DURATION_RE = new RegExp(`\\b${NUM_WORD}\\s*(?:\\(\\s*[\\w-]+\\s*\\)\\s*)?(?:calendar\\s+|working\\s+|business\\s+)?(year|month|week|day)s?\\b`, 'gi');

  // Every duration in the text is scored by what surrounds it, so the contract's own
  // term wins over e.g. "insurance valid for 180 days" or "3 years after termination".
  function findTerm(text) {
    let best = null;
    DURATION_RE.lastIndex = 0;
    let m;
    while ((m = DURATION_RE.exec(text))) {
      const n = toNum(m[1]);
      if (!n) continue;
      const before = text.slice(Math.max(0, m.index - 160), m.index);
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 80);
      const near = before.slice(-90) + ' ' + m[0] + ' ' + after;
      let score = 0;
      if (/\b(validity|valid\s+for|term\s+of|tenure|duration\s+of\s+(?:this|the)|shall\s+(?:remain|continue)\s+in\s+(?:full\s+)?(?:force|effect)|continue\s+for|for\s+a\s+(?:period|term)\s+of|period\s+of)\b/i.test(before.slice(-90))) score += 5;
      if (/(?:^|\n)\s*(?:\d+\.\s*)?(?:TERM|Term|TENURE|Tenure|DURATION|Duration|VALIDITY|Validity)(?:\s+(?:AND|and)\s+\w+)?\s*[:.]?\s*\n/.test(before)) score += 4;
      if (/\b(agreement|contract|mou)\b/i.test(near)) score += 2;
      if (/\b(from\s+the\s+(?:date|effective)|commencement|date\s+of\s+(?:signing|execution))\b/i.test(after)) score += 2;
      if (/\b(insurance|confidential|after\s+(?:the\s+)?(?:termination|expiry|expiration)|surviv|warrant|notice|interest|invoice|within|probation|training|stay|visa|salary|leave)\b/i.test(near)) score -= 8;
      if (score >= 4 && (!best || score > best.score)) {
        const unit = m[2].toLowerCase();
        const from = after.match(/^\s*(from\s+the\s+date\s+of\s+(?:signing|execution)|from\s+the\s+effective\s+date)/i);
        best = { n, unit, score, text: `${n} ${unit}${n === 1 ? '' : 's'}${from ? ' ' + from[1].toLowerCase() : ''}` };
      }
    }
    return best;
  }

  function findNotice(text) {
    const re = new RegExp(`\\b${NUM_WORD}\\s*(?:\\(\\s*[\\w-]+\\s*\\)\\s*)?(?:calendar\\s+|working\\s+|business\\s+|clear\\s+)?(day|month)s?['’]?\\s*(?:\\(\\s*[\\w-]+\\s*\\)\\s*)?(?:prior\\s+|advance\\s+)?(?:written\\s+)?notice`, 'i');
    const m = text.match(re);
    if (!m) return null;
    const n = toNum(m[1]);
    if (!n) return null;
    return m[2].toLowerCase() === 'month' ? n * 30 : n;
  }

  function findRenewal(flat) {
    const m = flat.match(/[^.\n]{0,160}\b(automatic(?:ally)?\s+renew\w*|auto-?renew\w*|renew\w*\s+automatically|(?:shall|may|to)\s+be\s+renewed|renew\w*\s+by\s+mutual|renewal\s+term|option\s+to\s+renew|extend(?:ed)?\s+by\s+mutual)[^.\n]{0,160}/i);
    if (!m) return '';
    const s = m[0].replace(/\s+/g, ' ').trim();
    const auto = /automatic|auto-?renew/i.test(s);
    return (auto ? 'Auto-renews. ' : '') + (s.length > 220 ? s.slice(0, 217) + '…' : s);
  }

  const LAW_ADJ = { indian: 'India', english: 'England and Wales', german: 'Germany', singapore: 'Singapore', japanese: 'Japan', french: 'France', american: 'United States', uae: 'UAE', dutch: 'Netherlands', irish: 'Ireland' };
  function findLaw(flat) {
    let law = '';
    const a = flat.match(/governed\s+(?:by|according\s+to|in\s+accordance\s+with|under)\s+(?:and\s+(?:construed|interpreted)\s+in\s+accordance\s+with\s+)?(?:the\s+)?laws?\s+of\s+(?:the\s+)?([A-Z][A-Za-z ]{2,40}?)(?=[,.;(]|\s+(?:and|without|in|applicable|as))/);
    const b = flat.match(/governed\s+(?:by|according\s+to|in\s+accordance\s+with|under)\s+(?:the\s+)?([A-Z][a-z]+)\s+laws?\b/);
    if (a) law = a[1].trim();
    else if (b) law = LAW_ADJ[b[1].toLowerCase()] || b[1];
    const c = flat.match(/jurisdiction\s+of\s+(?:the\s+)?[Cc]ourts?\s+(?:at|of|in)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/) || flat.match(/[Cc]ourts?\s+(?:at|of|in)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+shall\s+have\s+(?:exclusive\s+)?jurisdiction/);
    if (c && c[1] !== law) law = law ? `${law} (courts at ${c[1]})` : `Courts at ${c[1]}`;
    return law;
  }

  const MONEY_RE = /(?:₹|Rs\.?|INR|USD|US\$|\$|€|EUR|£|GBP|AED|SGD)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:\/-|lakhs?|crores?|million|mn|billion|k)\b)?/gi;
  // Contract value only when the text calls it that; other priced items go to fees.
  function findMoney(flat) {
    let value = '', valueScore = 0;
    const fees = [];
    MONEY_RE.lastIndex = 0;
    let m;
    while ((m = MONEY_RE.exec(flat))) {
      const before = flat.slice(Math.max(0, m.index - 250), m.index).toLowerCase();
      if (/stamp\s+paper|stamp\s+duty|court\s+fee/.test(before.slice(-60))) continue;
      const amt = m[0].replace(/\s+/g, ' ').trim();
      const near = before.slice(-120);
      const score = /(total\s+(?:contract\s+)?(?:value|price|amount|consideration)|contract\s+(?:value|price|sum)|consideration\s+of|aggregate\s+(?:value|amount))/.test(near) ? 3 : 0;
      if (score > valueScore) { value = amt; valueScore = score; }
      if (/(fee|charge|payment|pay|price|cost|commission|rate|remuneration|compensation|refundable|amount|invoice|rent)/.test(before) || score) {
        const s = sentenceAround(flat, m.index, m.index + m[0].length).replace(/^(?:which\s+is\s+|and\s+)/i, '');
        if (!fees.includes(s)) fees.push(s);
      }
    }
    const feeText = fees.slice(0, 4).map((s) => (s.length > 200 ? s.slice(0, 197) + '…' : s)).map((s) => s[0].toUpperCase() + s.slice(1)).join('\n');
    return { value, fees: feeText };
  }

  // ---------- parties ----------

  const OUR_COMPANY = /\b(TMC|The\s+Migration\s+Company|Edmove)\b/i;
  const CO_SUFFIX = '(?:Private\\s+Limited|Pvt\\.?\\s*Ltd\\.?|Limited|LLP|Ltd\\.?|Inc\\.?|LLC|GmbH|Corporation|Corp\\.)';
  const NAME_RE = new RegExp(`((?:[A-Z][\\w&.'’-]*)(?:[ \\t]+(?:[A-Z][\\w&.'’-]*|and|of|&|for)){0,8}[ \\t]+${CO_SUFFIX})`, 'g');
  const NOT_NAME = /^(?:the|m\/s\.?|and|between|by|partner|party|first|second|client|company|vendor|a|an|this|agreement)\s+/i;

  function cleanParty(s) {
    let p = s.replace(/\s+/g, ' ').replace(/[,;:."']+$/, '').trim();
    while (NOT_NAME.test(p)) p = p.replace(NOT_NAME, '');
    return p.replace(/^(?:AND|BETWEEN)\s*:?\s*/, '').slice(0, 90);
  }

  function findPartiesByName(text) {
    const end = text.search(/\b(?:WHEREAS|Whereas|INTRODUCTION|RECITALS|Recitals|NOW,?\s+THEREFORE|1\.\s+[A-Z])/);
    const head = text.slice(0, end > 200 ? Math.min(end, 6000) : 4000);
    const names = [];
    let m;
    NAME_RE.lastIndex = 0;
    while ((m = NAME_RE.exec(head))) {
      // skip a company that is only part of an address ("office at Sanjay Sales Corp., M-12 …"),
      // unless the same name is mentioned elsewhere as a party
      const inAddress = /(?:office|address|situated|located|residing)\s+(?:is\s+)?(?:at|in)\s*:?\s*$/i.test(head.slice(Math.max(0, m.index - 40), m.index));
      const firstWords = m[1].split(/\s+/).slice(0, 2).join(' ');
      if (inAddress && head.split(firstWords).length < 3) continue;
      // "X Pvt Ltd and Y Pvt Ltd" in one run of capitals is two parties
      const pieces = m[1].split(new RegExp(`(?<=${CO_SUFFIX})\\s+and\\s+`));
      for (const piece of pieces) addName(piece);
    }
    function addName(raw) {
      const n = cleanParty(raw);
      if (n.split(' ').length < 2 || /^(?:Companies|Company|Private|Pvt|Limited)\b/.test(n)) return;
      const key = n.toLowerCase().replace(/\s+(?:private\s+limited|pvt\.?\s*ltd\.?|limited|ltd\.?)$/, '');
      const dup = names.find((x) => x.key.startsWith(key) || key.startsWith(x.key));
      if (dup) { if (n.length > dup.name.length) { dup.name = n; dup.key = key; } return; }
      names.push({ name: n, key });
    }
    return names.map((x) => x.name);
  }

  const PARTY_END = /\s*(?:\n|\.\s+(?=(?:This|The|Whereas|WHEREAS|NOW|Now|Each|Both|Hereinafter|Recitals|RECITALS)\b)|,|\(|;|\bhaving\b|\ba company\b|\ba partnership\b|\bincorporated\b|\bregistered\b|\bwith (?:its|a) (?:registered|principal)\b|\bhereinafter\b|\bresiding\b|\band\b)/i;
  function findPartiesBetween(text) {
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
    return [p1, p2].filter((p) => p.length > 2 && !/^(?:partner|party|parties)\b/i.test(p));
  }

  function findParties(text) {
    const byName = findPartiesByName(text);
    if (byName.length >= 2) return byName.slice(0, 3);
    const between = findPartiesBetween(text);
    const all = [...byName];
    for (const p of between) if (!all.some((x) => x.toLowerCase().startsWith(p.toLowerCase().slice(0, 12)))) all.push(p);
    return all.slice(0, 3);
  }

  // ---------- title & type ----------

  const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
  function titleCase(s) {
    return s.toLowerCase().replace(/[\w’']+/g, (w, i) => {
      if (/^(nda|mou|sow|msa|tmc|llp|uk|usa|uae|it|hr)$/.test(w)) return w.toUpperCase();
      return i > 0 && SMALL.has(w) ? w : w[0].toUpperCase() + w.slice(1);
    });
  }

  function mostlyCaps(s) {
    const letters = (s || '').replace(/[^A-Za-z]/g, '');
    return letters.length > 2 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.8;
  }

  function findTitle(text, filename) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 15);
    const i = lines.findIndex((l) => /(agreement|contract|memorandum|lease|deed|order|terms|addendum|amendment|mou|nda|sow|statement of work)/i.test(l) && l.length < 140);
    if (i < 0) return filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    let t = lines[i];
    // a heading that wraps onto a second all-caps line ("… FOR INTERNATIONAL SKILLING / AND PLACEMENTS …")
    const next = lines[i + 1] || '';
    if (mostlyCaps(t) && mostlyCaps(next) && next.length < 80 && /^[A-Z&]/.test(next)) t += ' ' + next;
    t = t.replace(/\b(?:No|Dt|Dated|Date)\.?\s*[:\-]?\s*_{2,}/gi, '').replace(/_{2,}/g, '').replace(/\s+/g, ' ').trim();
    return mostlyCaps(t) ? titleCase(t) : t;
  }

  const TYPES = [
    ['non-disclosure', 'NDA'], ['confidentiality agreement', 'NDA'], ['statement of work', 'SOW'],
    ['master service', 'MSA'], ['channel partner', 'Partnership'], ['partner agreement', 'Partnership'], ['partnership', 'Partnership'],
    ['memorandum of understanding', 'MoU'], ['service agreement', 'Services'], ['services agreement', 'Services'],
    ['lease', 'Lease'], ['rental', 'Lease'], ['employment agreement', 'Employment'], ['employment contract', 'Employment'], ['consult', 'Consulting'],
    ['supply', 'Supply'], ['purchase', 'Purchase'], ['licen', 'License'], ['maintenance', 'Maintenance'], ['vendor', 'Vendor'],
  ];
  function findType(title, text) {
    for (const src of [title.toLowerCase(), text.slice(0, 3000).toLowerCase()]) {
      for (const [k, v] of TYPES) if (src.includes(k)) return v;
    }
    return '';
  }

  // ---------- put it together ----------

  function analyze(text, filename, fmt) {
    const flat = flatten(text);
    const dates = findDates(flat, fmt).map((d) => ({ ...d, context: sentenceAround(flat, d.index, d.end) }));
    let effectiveDate = '', endDate = '';
    for (const d of dates) {
      const pre = flat.slice(Math.max(0, d.index - 140), d.index);
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
    const others = parties.filter((p) => !OUR_COMPANY.test(p));
    const money = findMoney(flat);
    const title = findTitle(text, filename);
    const head = text.slice(0, 2500);
    return {
      title,
      type: findType(title, text),
      parties: parties.join(' ⟷ '),
      counterparty: others[0] || parties[1] || parties[0] || '',
      value: money.value,
      fees: money.fees,
      effectiveDate,
      endDate,
      endCalculated,
      tenure: term ? term.text : '',
      noticeDays: findNotice(flat) || '',
      renewal: findRenewal(flat),
      governingLaw: findLaw(flat),
      milestones,
      datesBlank: !effectiveDate && /(_{3,}|\bday\s+of\s+\(?month\)?|\bdated?\s*[:.]?\s*_{2,}|\bDt\.?\s*_{2,})/i.test(head),
      textFound: text.trim().length > 50,
    };
  }

  window.ContractExtract = { readText, analyze, addTerm, parseTenure };
})();
