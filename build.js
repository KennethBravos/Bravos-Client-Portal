'use strict';
// Builds dist/index.html (the client portal) from your Google Sheet data.
// Run by GitHub Actions. Needs env SHEET_API_URL (secret) – or SHEET_JSON_FILE for local tests.
const fs = require('fs'), path = require('path'), c = require('crypto');
const fm = s => s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
const N = x => { const v = parseFloat(String(x == null ? '' : x).replace(/[₱,\s]/g, '')); return isNaN(v) ? 0 : v; };
const D = x => { if (!x) return ''; const s = String(x).trim(); if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); const t = new Date(s); return isNaN(t) ? '' : t.toISOString().slice(0, 10); };
async function load() {
  if (process.env.SHEET_JSON_FILE) return JSON.parse(fs.readFileSync(process.env.SHEET_JSON_FILE, 'utf8'));
  if (!process.env.SHEET_API_URL) throw new Error('SHEET_API_URL secret is not set');
  const r = await fetch(process.env.SHEET_API_URL, { redirect: 'follow' });
  if (!r.ok) throw new Error('Sheet request failed: HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('Sheet request refused: ' + j.error);
  return j;
}
(async () => {
  const d = await load(), secret = process.env.SHEET_API_URL || 'local-test';
  const settings = d.settings || [], set = k => (settings.find(r => r.key === k) || {}).value;
  const rlo = N(set('rate_low')) || 3, rhi = N(set('rate_high')) || 6;
  const contact = settings.filter(r => r.key === 'contact' && r.value).map(r => { const p = String(r.value).split('|'); return { label: p[0], url: p[1], k: p[2] || 'link' }; });
  const ledRaw = d.ledger || [], byLoan = {};
  ledRaw.forEach((r, i) => { if (r.loan_id) (byLoan[r.loan_id] = byLoan[r.loan_id] || []).push(Object.assign({}, r, { _i: i })); });
  const warn = [], clients = {};
  for (const L of (d.loans || [])) {
    if (!L.loan_id || !L.client) continue;
    const id = L.loan_id, fin = N(L.amount_financed), rate = N(L.rate_per_month), months = N(L.months), total = N(L.total_payable), rel = D(L.released), fp = D(L.first_payment_date);
    if (!fin || !months || !rel || !total) { warn.push('Incomplete loan row: ' + id); continue; }
    const rows = (byLoan[id] || []).map(r => ({ d: D(r.date), t: String(r.type || '').trim().toLowerCase(), a: N(r.amount), cv: (r.installments_covered === '' || r.installments_covered == null) ? 1 : N(r.installments_covered), n: r.note || '', pf: D(r.pay_for_date) || D(r.date), _i: r._i }));
    rows.sort((a, b) => a.d.localeCompare(b.d) || a._i - b._i);
    const pays = rows.filter(r => r.t === 'pay'), relRows = rows.filter(r => ['cash', 'offset', 'fee', 'rel'].includes(r.t));
    const openPaid = N(L.opening_paid), openInst = N(L.opening_installments_paid);
    const paid = openPaid + pays.reduce((s, r) => s + r.a, 0), pi = openInst + pays.reduce((s, r) => s + r.cv, 0);
    const an = pays.length ? pays.map(r => r.pf).sort().pop() : rel, n = months * 2, closed = paid >= total - 1;
    const led = [];
    relRows.forEach(r => led.push([r.d || rel, r.t, r.a, r.n]));
    if (!relRows.length) led.push([rel, 'rel', fin, '']);
    else if (!relRows.some(r => r.t === 'rel')) { const s = relRows.reduce((t, r) => t + r.a, 0); if (Math.abs(s - fin) > 1) warn.push(`Release lines for ${id} add up to ${s}, amount financed is ${fin}`); }
    pays.forEach(r => led.push([r.d, 'pay', r.a, r.n, r.pf, r.cv]));
    led.sort((a, b) => a[0].localeCompare(b[0]));
    if (openPaid > 0 && !(closed && !pays.length)) led.push(['', 'sum', openPaid, '']);
    if (closed) led.push(['', 'closed', 0, L.note || '']);
    (clients[L.client] = clients[L.client] || []).push({ label: L.loan_label || id, date: fm(rel), rd: rel, fin, rate, months, total, paid: Math.round(paid * 100) / 100, n, pi, oi: openInst, fp, an, daily: +(fin * rate / 100 / 30).toFixed(4), pp: +(fin / n).toFixed(4), lump: /^(y|yes|true|1)$/i.test(String(L.lump_sum || '')), note: L.note || '', led });
  }
  const codes = {}; (d.codes || []).forEach(r => { if (r.client && r.access_code) codes[r.client] = String(r.access_code).toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  const offers = {}; (d.offers || []).forEach(r => { if (r.client && N(r.rate)) offers[r.client] = { rate: N(r.rate), until: D(r.valid_until), reason: r.reason || '' }; });
  const today = new Date().toISOString().slice(0, 10), dates = ledRaw.map(r => D(r.date)).filter(x => x && x <= today).sort();
  const asof = D(set('as_of')) || dates[dates.length - 1] || today;
  const token = (() => { try { return new URL(process.env.SHEET_API_URL).searchParams.get('token') || 'test'; } catch (e) { return 'test'; } })();
  const upkey = nm => c.createHmac('sha256', token).update('upload:' + nm).digest('hex').slice(0, 24);
  const proofs = d.proofs || [];
  const GS = c.createHmac('sha256', secret).update('gs').digest().slice(0, 16), BL = {}, seen = {};
  let built = 0;
  for (const [name, loans] of Object.entries(clients)) {
    const code = codes[name];
    if (!code || code.length < 6) { warn.push('No access code for client: ' + name); continue; }
    const myProofs = proofs.filter(p => p.client === name).map(p => ({ id: p.proof_id, sub: D(p.submitted), loan: p.loan, paid: D(p.paid_on), amt: N(p.amount), st: p.status || 'Pending', note: p.your_note || '' })).sort((a, b) => (b.sub || '').localeCompare(a.sub || '')).slice(0, 12);
    const plain = JSON.stringify({ name, loans, offer: offers[name] || null, upkey: upkey(name), proofs: myProofs });
    const bits = c.pbkdf2Sync(code, GS, 200000, 48, 'sha256'), id = bits.slice(0, 16).toString('hex');
    if (seen[id]) throw new Error('Two clients share the same access code: ' + name + ' / ' + seen[id]);
    seen[id] = name;
    const iv = c.createHmac('sha256', secret).update('iv:' + name + ':' + c.createHash('sha256').update(plain).digest('hex')).digest().slice(0, 12);
    const ci = c.createCipheriv('aes-256-gcm', bits.slice(16), iv);
    const ct = Buffer.concat([ci.update(plain), ci.final(), ci.getAuthTag()]);
    BL[id] = { i: iv.toString('base64'), c: ct.toString('base64') }; built++;
  }
  warn.forEach(w => console.warn('WARNING:', w));
  if (!built) throw new Error('No client statements were built – refusing to publish an empty portal');
  const html = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8')
    .replace('__BLOBS__', JSON.stringify(BL)).replace('__GS__', GS.toString('base64')).replace('__ASOF__', fm(asof))
    .replace(/__RLO__/g, rlo).replace(/__RHI__/g, rhi).replace('__CONTACT__', JSON.stringify(contact)).replace('__PAYINFO__', JSON.stringify(String(set('how_to_pay') || ''))).replace('__UPLOAD__', process.env.SHEET_API_URL ? process.env.SHEET_API_URL.split('?')[0] : '');
  const out = path.join(__dirname, '..', 'dist'); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'index.html'), html);
  console.log(`Built portal: ${built} clients, data through ${asof}, ${html.length} bytes`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
