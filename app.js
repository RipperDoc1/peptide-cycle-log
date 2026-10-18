(function(){
const DAY = ['S','M','T','W','T','F','S'];
const DAYNAME = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const $ = id => document.getElementById(id);
const LS_KEY = 'peptide-cycles-v1';
let cycles = [];        // [{id, name, start, lenValue, lenUnit, days:[], dose, unit, created}]
let editingId = null;
let confirmId = null;
let adjustId = null;
let cycId = null;              // card with the Change cycle panel open
const expanded = new Set();    // cards showing detailed info
let titSteps = [];  // form state: [{week, dir, amt}]
let view = 'home', prevView = 'home';
let profile = null, loaded = false, editingProfile = false;
let isOwner = false, testers = null, rosterSync = null;
const LS_PROFILE = 'peptide-profile-v1';
const collapsed = new Set();   // cards on the Today view whose details the viewer opened (closed by default)
const openRows = new Set();    // collapsed rows the viewer has expanded
let selDays = new Set([1,2,3,4,5]), selEvery = 0;
let store = null;       // {save(c), remove(id)}
const offMsg = m => navigator.onLine === false ? 'You\'re offline. Connect to the internet to save changes.' : m;
// local copy of the last data loaded from the server, so the app opens instantly and works offline (read-only)
const CACHE_KEY = 'pcl-cache-v1';
const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; } };
const writeCache = () => { try { if (sessionUser && profile && profile.status === 'approved') localStorage.setItem(CACHE_KEY, JSON.stringify({uid: sessionUser.id, email: sessionUser.email, profile, isOwner, cycles, at: Date.now()})); } catch {} };
const clearCache = () => { try { localStorage.removeItem(CACHE_KEY); } catch {} };
const hasAuthToken = () => { try { return Object.keys(localStorage).some(k => /^sb-.*-auth-token$/.test(k)); } catch { return false; } };
const parse = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const addDays = (d,n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const today = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };
const diff = (a,b) => Math.round((b - a) / 86400000);
const fmt = d => d.toLocaleDateString(undefined, {month:'short', day:'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined});
const num = n => n == null || isNaN(n) ? '—' : Number.isInteger(n) ? String(n) : String(+n.toFixed(3));
const OPEN_AHEAD = 730;
const isOpen = c => c.lenUnit === 'open';
// dose day check: 'every other day' cycles count from the start (paused days don't count), others use weekdays
// off-cycle: break after a cycle ends; the next round only starts once the user confirms
const offDaysOf = c => c.offValue > 0 && !isOpen(c) ? (c.offUnit === 'days' ? c.offValue : c.offValue * 7) : 0;
const offLabel = c => c.offUnit === 'days' ? `${c.offValue}-day` : `${c.offValue}-week`;
function offInfo(c, s){
const od = offDaysOf(c); if (!od || c.nextId || c.noRepeat) return null;
s = s || stats(c); if (s.status !== 'complete') return null;
const last = s.endedEarly ? addDays(parse(c.endedOn), -1) : s.end, from = addDays(last, 1), due = addDays(from, od), t = today();
return {from, due, days: od, ready: due <= t, left: diff(t, due), elapsed: Math.min(Math.max(diff(from, t), 0), od),
snoozed: !!(c.snoozeUntil && parse(c.snoozeUntil) > t)};
}
// what's missing on a cycle that would stop the app showing doses, units or vials
function missing(c){
const out = [];
if (c.dose == null) out.push('No dose set');
if (!(c.interval > 1) && !(c.days || []).length) out.push('No days selected');
if (isNasal(c)){ if (!(c.bacMl > 0) || !(c.spMl > 0)) out.push('Bottle size or spray volume missing'); return out; }
if ((c.vialMg > 0) !== (c.bacMl > 0)) out.push(c.premixed ? 'Vial size or concentration missing' : 'Vial size or BAC water missing');
else if ((c.unit === 'units' || c.unit === 'mL') && c.dose != null && !(c.vialMg > 0 && c.bacMl > 0)) out.push(`Dose is in ${c.unit} but there is no vial info to work out mg`);
return out;
}
let nxPick = null;
let dupAck = null;
// delivery route: subcutaneous / intramuscular / nasal. Nasal doses are stored as mL (sprays x 2 nostrils x mL per spray).
let selRoute = 'subq';
const ROUTES = {subq: ['SubQ', 'Subcutaneous'], im: ['IM', 'Intramuscular'], nasal: ['Nasal', 'Nasal spray']};
const routeOf = c => ROUTES[c.route] ? c.route : 'subq';
const isNasal = c => c.route === 'nasal';
const spraysOf = (c, dv) => c.spMl > 0 ? +(dv / (2 * c.spMl)).toFixed(2) : null;
function syncRoute(){
const n = selRoute === 'nasal';
$('form').classList.toggle('nasal', n);
document.querySelectorAll('[data-route]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.route === selRoute)));
$('perdayLabel').textContent = n ? 'Times per day' : 'Doses per day';
$('perdayHint').textContent = n ? 'How many times a day you spray.' : 'The dose above is per injection.';
nasalSync('sprays'); updateNasal();
}
function updateNasal(){
const el = $('nasalCalc'); if (!el || selRoute !== 'nasal') return;
const bottle = parseFloat($('n-bottle').value), sp = parseFloat($('n-spray').value), n = parseInt($('n-sprays').value, 10), mg = parseFloat($('n-mg').value), per = parseInt($('f-perday').value, 10) || 1;
if (!(bottle > 0 && sp > 0 && n > 0)){ el.innerHTML = '<span class="hint">Enter the bottle size, spray volume and sprays per nostril.</span>'; return; }
const doseMl = n * 2 * sp, doses = Math.floor(bottle / doseMl + 1e-9), perWeek = (selEvery ? 3.5 : selDays.size) * per;
const weeks = perWeek ? doses / perWeek : 0, conc = mg > 0 ? mg / bottle : null;
const lasts = !perWeek ? '' : weeks < 2 ? `${Math.round(weeks * 7)} days` : `${+weeks.toFixed(1)} weeks`;
const mgTx = m => m < 1 ? `${num(+(m * 1000).toFixed(1))} mcg` : `${num(+m.toFixed(3))} mg`;
el.innerHTML = `<div>Each dose: <b>${n * 2} spray${n * 2 === 1 ? '' : 's'}</b> (${n} per nostril) = <b>${num(+doseMl.toFixed(3))} mL</b>${conc ? ` = <b>${mgTx(doseMl * conc)}</b>` : ''}</div>
<div>One ${num(bottle)} mL bottle ≈ <b>${doses} dose${doses === 1 ? '' : 's'}</b>${lasts ? `, about <b>${lasts}</b> at this schedule` : ''}.</div>`;
}
// sprays per nostril <-> mcg dose (needs the mg in the bottle); sprays are whole numbers, so a typed mcg dose rounds to the nearest spray
function nasalMcgPerSpray(){ const bottle = parseFloat($('n-bottle').value), sp = parseFloat($('n-spray').value), mg = parseFloat($('n-mg').value); return bottle > 0 && sp > 0 && mg > 0 ? mg / bottle * sp * 1000 : null; }
function nasalSync(from){
const per = nasalMcgPerSpray(), mcgEl = $('n-mcg'), note = $('n-mcgnote');
mcgEl.disabled = per == null; mcgEl.placeholder = per == null ? 'Add peptide in bottle first' : 'e.g. 200';
if (per == null){ if (from !== 'mcg') mcgEl.value = ''; note.textContent = 'Add the mg in the bottle to set the dose in mcg.'; return; }
if (from === 'mcg'){
const want = parseFloat(mcgEl.value);
if (!(want > 0)){ note.textContent = `Each spray = ${num(+per.toFixed(1))} mcg.`; return; }
const exact = want / per / 2, n = Math.max(1, Math.round(exact));
$('n-sprays').value = n;
note.textContent = Math.abs(exact - n) < 0.01 ? `= ${n} spray${n === 1 ? '' : 's'} per nostril (each spray ${num(+per.toFixed(1))} mcg).` : `${num(+exact.toFixed(2))} sprays per nostril isn't possible, so it's rounded to ${n} = ${num(+(n * 2 * per).toFixed(1))} mcg per dose.`;
} else {
const n = parseInt($('n-sprays').value, 10);
if (n > 0) mcgEl.value = +(n * 2 * per).toFixed(1);
note.textContent = `Each spray = ${num(+per.toFixed(1))} mcg. Type a mcg dose to work out the sprays.`;
}
}
document.addEventListener('input', e => { if (e.target.id === 'n-mcg') { nasalSync('mcg'); updateNasal(); } else if (['n-sprays', 'n-mg', 'n-bottle', 'n-spray'].includes(e.target.id)) nasalSync('sprays'); });
document.addEventListener('click', e => { const b = e.target.closest('[data-route]'); if (!b) return; selRoute = b.dataset.route; syncRoute(); });
['n-bottle', 'n-spray', 'n-sprays', 'n-mg', 'f-perday'].forEach(id => document.addEventListener('input', e => { if (e.target.id === id) updateNasal(); }));
document.addEventListener('change', e => { if (e.target.id === 'f-perday') updateNasal(); });
document.addEventListener('click', e => { if (e.target.closest('.day,[data-preset]')) setTimeout(updateNasal); });
// change-dose helpers: enter the new dose in the cycle's unit or the other one (mg <-> syringe units), then confirm
let adjMode = null, adjDraft = null, adjConfirm = null;
const concOf = c => c.vialMg > 0 && c.bacMl > 0 ? c.vialMg / c.bacMl : null;
const altUnit = c => !concOf(c) ? null : (c.unit === 'mg' || c.unit === 'mcg') ? 'units' : c.unit === 'units' ? 'mg' : null;
function toBase(c, v, mode){
if (mode === c.unit) return v;
const conc = concOf(c);
if (mode === 'units'){ const mg = v / 100 * conc; return c.unit === 'mcg' ? mg * 1000 : mg; }
if (mode === 'mg' && c.unit === 'units') return v / conc * 100;
return v;
}
function fromBase(c, v, mode){
if (mode === c.unit) return v;
const conc = concOf(c);
if (mode === 'units'){ const mg = c.unit === 'mcg' ? v / 1000 : v; return mg / conc * 100; }
if (mode === 'mg' && c.unit === 'units') return v / 100 * conc;
return v;
}
function adjHint(c, base, mode){
if (mode !== c.unit) return `= ${num(+base.toFixed(4))} ${c.unit}${sec(c, base) && c.unit !== 'units' ? '' : ''} per injection`;
return sec(c, base) ? `= ${sec(c, base)} per injection` : '';
}
function adjConfirmHtml(){
const c = cycles.find(x => x.id === adjConfirm.id); if (!c) return '';
const s = stats(c), base = adjConfirm.base, mg = mgOf(c, base), un = unitsFor(c, base), per = c.perDay || 1;
const main = mg != null ? `${num(+mg.toFixed(4))} mg` : `${num(base)} ${c.unit}`;
const unitsTx = un != null ? `${+un.toFixed(1)} units` : (c.unit !== 'mg' && mg == null ? '' : '');
const was = s.curDose != null ? `${mgOf(c, s.curDose) != null ? num(+mgOf(c, s.curDose).toFixed(4)) + ' mg' : num(s.curDose) + ' ' + c.unit}${unitsFor(c, s.curDose) != null ? ' · ' + (+unitsFor(c, s.curDose).toFixed(1)) + ' units' : ''}` : '';
const when = parse(adjConfirm.date).toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'});
return `<div class="sheet-wrap anim cfm"><div class="sheet-bg" data-act="adj-back"></div>
<div class="sheet cfmbox" role="alertdialog" aria-modal="true" aria-label="Confirm dose change">
<div class="cfm-body"><span class="label">Confirm dose change</span><h3>${esc(c.name)}</h3>
<div class="cfm-dose"><span class="label">New dose per injection</span><b>${main}</b>${unitsTx ? `<span class="cfm-units">${unitsTx} on a U-100 syringe</span>` : ''}${per > 1 ? `<span class="cfm-per">${per}× a day · ${mg != null ? num(+(mg * per).toFixed(4)) + ' mg' : num(+(base * per).toFixed(4)) + ' ' + c.unit}${un != null ? ' · ' + (+(un * per).toFixed(1)) + ' units' : ''} per day</span>` : ''}</div>
<div class="cfm-rows"><div><span>Starting</span><b>${when}</b></div>${was ? `<div><span>Current dose</span><b>${was}</b></div>` : ''}</div>
<div class="actions cfm-actions"><button class="btn ghost" data-act="adj-back">Go back</button><button class="btn" data-act="adj-confirm" data-id="${c.id}">Confirm change</button></div>
<span class="err" id="cfm-err"></span></div></div></div>`;
}
let allYear = (() => { try { return parseInt(localStorage.getItem('pcl-allyear'), 10) || new Date().getFullYear(); } catch { return new Date().getFullYear(); } })();
let allMode = (() => { try { return localStorage.getItem('pcl-allmode') === 'month' ? 'month' : 'list'; } catch { return 'list'; } })();
const notesOpen = new Set();
const optsOpen = new Set(); // cards with Cycle Options open // cards with the notes section open
const sortedNotes = c => (c.notes || []).slice().sort((a, b) => (b.date + b.at).localeCompare(a.date + a.at));
function notesBlock(c){
const list = sortedNotes(c);
return `<div class="notes">
<div class="noteadd"><div class="field"><label class="label" for="nt-date-${c.id}">Date</label><input type="date" id="nt-date-${c.id}" value="${iso(today())}"></div>
<div class="field"><label class="label" for="nt-text-${c.id}">Note</label><textarea id="nt-text-${c.id}" rows="3" maxlength="2000" placeholder="How it's going, side effects, injection site, anything worth remembering"></textarea></div>
<div class="actions"><button class="btn" data-act="nt-add" data-id="${c.id}">Add note</button><span class="err" id="nt-err-${c.id}"></span></div></div>
${list.length ? `<div class="notelist">${list.map(n => `<div class="note"><div class="nhead"><b>${fmt(parse(n.date))}</b><button class="link del" data-act="nt-del" data-id="${c.id}" data-nid="${n.id}">Delete</button></div><p>${esc(n.text).replace(/\n/g, '<br>')}</p></div>`).join('')}</div>` : '<p class="hint" style="margin:0">No notes yet.</p>'}
<div class="actions noteexp"><span class="label">Export</span><button class="btn ghost" data-act="nt-txt" data-id="${c.id}">Text file</button><button class="btn ghost" data-act="nt-pdf" data-id="${c.id}">PDF</button></div>
</div>`;
}
// summary used by note exports
function freqText(c){
const per = c.perDay || 1, perTx = per > 1 ? `, ${per}× a day` : '';
let days;
if (c.interval > 1) days = 'Every other day';
else if ((c.days || []).length === 7) days = 'Daily';
else { const ord = [1,2,3,4,5,6,0].filter(i => c.days.includes(i)); days = ord.map(i => DAYNAME[i]).join(', '); }
const dose = c.dose != null ? ` · ${doseWithUnits(c, c.dose)} per injection` : '';
return days + perTx + dose;
}
function exportInfo(c){
const s = stats(c);
const end = s.endedEarly ? `${fmt(parse(c.endedOn))} (ended early)` : isOpen(c) ? 'Open-ended (no end date)' : fmt(s.end);
const fmtY = d => d.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
return {name: c.name, start: fmtY(s.start), end: s.endedEarly ? fmtY(parse(c.endedOn)) + ' (ended early)' : isOpen(c) ? 'Open-ended (no end date)' : fmtY(s.end),
freq: freqText(c), notes: sortedNotes(c).slice().reverse().map(n => ({date: fmtY(parse(n.date)), text: n.text}))};
}
const fileBase = c => (c.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'cycle') + '-notes';
async function deliver(blob, filename, text){
const file = new File([blob], filename, {type: blob.type});
if (navigator.canShare && navigator.canShare({files: [file]})){ try { await navigator.share(text ? {files: [file], text} : {files: [file], title: filename}); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
const url = URL.createObjectURL(blob), a = document.createElement('a');
a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function exportTxt(c){
const x = exportInfo(c);
const lines = [x.name, '='.repeat(Math.max(x.name.length, 8)), `Cycle start: ${x.start}`, `Cycle end:   ${x.end}`, `Frequency:   ${x.freq}`, '', `Notes (${x.notes.length})`, '-'.repeat(12)];
x.notes.forEach(n => { lines.push(n.date); lines.push(n.text); lines.push(''); });
if (!x.notes.length) lines.push('No notes.');
return deliver(new Blob([lines.join('\n')], {type: 'text/plain'}), fileBase(c) + '.txt');
}
// ---- share card: a nicely formatted image (plus text) of a cycle ----
function daysText(c){
if (c.interval > 1) return 'Every other day';
const d = c.days || [];
if (d.length === 7) return 'Daily';
if (d.length === 5 && [1,2,3,4,5].every(x => d.includes(x))) return 'Mon – Fri';
if (d.length === 2 && d.includes(0) && d.includes(6)) return 'Weekends';
return [1,2,3,4,5,6,0].filter(i => d.includes(i)).map(i => DAYNAME[i]).join(', ');
}
function shareData(c){
const s = stats(c), per = c.perDay || 1, fmtY = d => d.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
const dose = s.curDose != null ? s.curDose : c.dose;
const len = isOpen(c) ? 'Ongoing' : `${c.lenValue} ${c.lenUnit === 'weeks' ? (c.lenValue == 1 ? 'week' : 'weeks') : (c.lenValue == 1 ? 'day' : 'days')}`;
const wk = (a, b) => { const x = Math.floor(a / 7) + 1, y = Math.floor(b / 7) + 1; return x === y ? `Week ${x}` : `Weeks ${x}–${y}`; };
const steps = s.steps.length > 1 ? s.steps.map((st, i) => ({when: isOpen(c) && i === s.steps.length - 1 ? `Week ${Math.floor(st.from / 7) + 1} onward` : wk(st.from, st.to), dose: `${num(st.dose)} ${c.unit}`, extra: sec(c, st.dose)})) : [];
const status = s.status === 'upcoming' ? `Starts ${fmtY(s.start)}` : s.status === 'paused' ? 'Paused' : isOpen(c) ? `Day ${Math.max(s.elapsed, 0)} · ongoing` : `Day ${Math.max(s.elapsed, 0)} of ${s.span}`;
const dp = dosePair(c, dose), nas = isNasal(c);
return {name: c.name, status, statusKey: s.status, dose: nas && dose != null ? dp.main + ' per nostril' : dp.main, doseSub: [dose == null ? '' : nas ? dp.sub.replace(/^per nostril \u00b7 /, '') : (dp.sub ? `${dp.sub} per injection` : 'per injection'), per > 1 ? `${per}× a day` : ''].filter(Boolean).join(' · '),
rows: [['Route', ROUTES[routeOf(c)][1]], ['Frequency', daysText(c) + (per > 1 ? ` · ${per}× a day` : '')], ['Start', fmtY(s.start)], ['End', s.endedEarly ? fmtY(parse(c.endedOn)) : isOpen(c) ? 'Indefinite' : fmtY(s.end)], ['Length', len]].concat(offDaysOf(c) ? [['Off-cycle after', `${c.offValue} ${c.offUnit === 'days' ? (c.offValue == 1 ? 'day' : 'days') : (c.offValue == 1 ? 'week' : 'weeks')}`]] : []),
steps};
}
async function shareCycle(c){
const x = shareData(c);
try { await Promise.all(['400', '600', '800'].map(w => document.fonts.load(`${w} 40px Figtree`))); } catch {}
const F = (w, px) => `${w} ${px}px Figtree, -apple-system, "Segoe UI", sans-serif`;
const W = 1080, P = 72, IN = 64, CW = W - P * 2, TW = CW - IN * 2;
const C = {bg1: '#eaf0fa', bg2: '#f4f4f7', card: '#ffffff', ink: '#15171c', muted: '#7d838f', line: '#eceef2', sel: '#2f5fb3', soft: '#e8f0fc', ok: '#2f8a5b', okSoft: '#e6f4ec', warn: '#a86a12', warnSoft: '#fbf1e1', pause: '#7a5bc7', pauseSoft: '#f1ecfb'};
const pillC = {active: [C.okSoft, C.ok], upcoming: [C.warnSoft, C.warn], paused: [C.pauseSoft, C.pause]}[x.statusKey] || [C.soft, C.sel];
const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
const wrap = (text, font, max) => { ctx.font = font; const words = String(text).split(/\s+/), out = []; let line = '';
words.forEach(w => { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > max && line){ out.push(line); line = w; } else line = t; }); if (line) out.push(line); return out; };
const rr = (x0, y0, w, h, r) => { ctx.beginPath(); ctx.moveTo(x0 + r, y0); ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r); ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r); ctx.arcTo(x0, y0 + h, x0, y0, r); ctx.arcTo(x0, y0, x0 + w, y0, r); ctx.closePath(); };
// one pass to measure, one to draw
const paint = draw => {
const L = P + IN; let y = P + 64;
const T = (str, font, color, x0, yy, align) => { if (!draw) return; ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align || 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(str, x0, yy); };
// brand
if (draw){ ctx.fillStyle = C.ink; rr(L, y - 4, 22, 9, 3); ctx.fill(); rr(L - 3, y + 8, 28, 40, 7); ctx.fill(); }
T('Peptide Log', F(800, 34), C.ink, L + 44, y + 38);
y += 110;
// name + status pill
const nameLines = wrap(x.name, F(800, 76), TW);
nameLines.forEach(l => { y += 80; T(l, F(800, 76), C.ink, L, y); });
y += 30;
ctx.font = F(700, 28); const pw = ctx.measureText(x.status).width + 64;
if (draw){ ctx.fillStyle = pillC[0]; rr(L, y, pw, 54, 27); ctx.fill(); ctx.fillStyle = pillC[1]; ctx.beginPath(); ctx.arc(L + 28, y + 27, 6, 0, Math.PI * 2); ctx.fill(); }
T(x.status, F(700, 28), pillC[1], L + 44, y + 37);
y += 54 + 44;
// dose box
const subLines = x.doseSub ? wrap(x.doseSub, F(500, 32), TW - 80) : [];
const bh = 70 + 96 + (subLines.length ? subLines.length * 44 + 10 : 0) + 40;
if (draw){ ctx.fillStyle = C.soft; rr(L, y, TW, bh, 32); ctx.fill(); }
T('DOSE', F(700, 26), C.sel, L + 40, y + 62);
T(x.dose, F(800, 92), C.ink, L + 40, y + 62 + 96);
subLines.forEach((l, i) => T(l, F(500, 32), C.muted, L + 40, y + 62 + 96 + 52 + i * 44));
y += bh + 34;
// info rows
x.rows.forEach(([k, v], i) => {
const vl = wrap(v, F(700, 34), TW * 0.6);
const rh = Math.max(84, 40 + vl.length * 44);
if (draw && i){ ctx.fillStyle = C.line; ctx.fillRect(L, y, TW, 2); }
T(k, F(500, 32), C.muted, L, y + 54);
vl.forEach((l, j) => T(l, F(700, 34), C.ink, L + TW, y + 54 + j * 44, 'right'));
y += rh;
});
// titration
if (x.steps.length){
y += 30;
T('Titration', F(800, 40), C.ink, L, y + 40); y += 70;
x.steps.forEach((st, i) => {
const rh = 76;
if (draw){ ctx.fillStyle = i % 2 ? C.card : '#f5f7fb'; rr(L, y, TW, rh - 8, 18); ctx.fill(); }
T(st.when, F(600, 30), C.ink, L + 26, y + 46);
T(st.dose, F(800, 32), C.sel, L + TW - (st.extra ? 200 : 26), y + 46, 'right');
if (st.extra) T(st.extra, F(500, 28), C.muted, L + TW - 26, y + 46, 'right');
y += rh;
});
}
y += 40;
return y + IN; // card bottom
};
const cardBottom = paint(false);
const H = Math.max(1080, cardBottom + 110);
cv.width = W; cv.height = H;
const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, C.bg1); g.addColorStop(1, C.bg2); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
ctx.save(); ctx.shadowColor = 'rgba(20,30,50,.10)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 12; ctx.fillStyle = C.card; rr(P, P, CW, cardBottom - P, 48); ctx.fill(); ctx.restore();
paint(true);
ctx.font = F(500, 26); ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.fillText('Shared from Peptide Log', W / 2, H - 46);
const text = [`${x.name} — ${x.status}`, `Dose: ${x.dose}${x.doseSub ? ' (' + x.doseSub + ')' : ''}`, ...x.rows.map(([k, v]) => `${k}: ${v}`), ...(x.steps.length ? ['Titration:', ...x.steps.map(st => `  ${st.when}: ${st.dose}${st.extra ? ' (' + st.extra + ')' : ''}`)] : [])].join('\n');
const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
return deliver(blob, (c.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'cycle') + '.png', text);
}
async function shareAll(list){
const items = list.map(c => ({c, x: shareData(c)}));
try { await Promise.all(['400', '500', '600', '700', '800'].map(w => document.fonts.load(`${w} 40px Figtree`))); } catch {}
const F = (w, px) => `${w} ${px}px Figtree, -apple-system, "Segoe UI", sans-serif`;
const W = 1080, P = 64, IN = 56, CW = W - P * 2, TW = CW - IN * 2;
const C = {bg1: '#eaf0fa', bg2: '#f4f4f7', card: '#ffffff', ink: '#15171c', muted: '#7d838f', line: '#eceef2', sel: '#2f5fb3', soft: '#e8f0fc', tile: '#f5f7fb', ok: '#2f8a5b', okSoft: '#e6f4ec', warn: '#a86a12', warnSoft: '#fbf1e1', pause: '#7a5bc7', pauseSoft: '#f1ecfb'};
const pillOf = k => ({active: [C.okSoft, C.ok], upcoming: [C.warnSoft, C.warn], paused: [C.pauseSoft, C.pause]}[k] || [C.soft, C.sel]);
const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
const wrap = (text, font, max) => { ctx.font = font; const words = String(text).split(/\s+/), out = []; let line = '';
words.forEach(w => { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > max && line){ out.push(line); line = w; } else line = t; }); if (line) out.push(line); return out; };
const rr = (x0, y0, w, h, r) => { ctx.beginPath(); ctx.moveTo(x0 + r, y0); ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r); ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r); ctx.arcTo(x0, y0 + h, x0, y0, r); ctx.arcTo(x0, y0, x0 + w, y0, r); ctx.closePath(); };
const asOf = new Date().toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
const paint = draw => {
const L = P + IN; let y = P + 56;
const T = (str, font, color, x0, yy, align) => { if (!draw) return; ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align || 'left'; ctx.fillText(str, x0, yy); };
if (draw){ ctx.fillStyle = C.ink; rr(L, y - 4, 20, 8, 3); ctx.fill(); rr(L - 3, y + 7, 26, 36, 6); ctx.fill(); }
T('Peptide Log', F(800, 32), C.ink, L + 40, y + 34);
y += 130;
T('My current protocol', F(800, 62), C.ink, L, y); y += 50;
T(`${items.length} compound${items.length === 1 ? '' : 's'} · as of ${asOf}`, F(500, 30), C.muted, L, y); y += 44;
items.forEach(({x}) => {
// tile per compound
const IP = 32, IW = TW - IP * 2;
ctx.font = F(700, 24); const pw = ctx.measureText(x.status).width + 50;
const nameLines = wrap(x.name, F(800, 44), IW - pw - 16);
const doseLine = x.dose + (x.doseSub ? '  ·  ' + x.doseSub : '');
const doseLines = wrap(doseLine, F(700, 32), IW);
const dates = `${x.rows[2][1]} – ${x.rows[3][1]}`;
const info = [['Route', x.rows[0][1]], ['Frequency', x.rows[1][1]], ['Dates', dates]].concat(x.rows[5] ? [['Off-cycle', x.rows[5][1] + ' after']] : []);
const infoLines = info.map(([k, v]) => ({k, v: wrap(v, F(600, 28), IW - 190)}));
const titLines = x.steps.length ? wrap('Titration: ' + x.steps.map(st => `${st.when.replace('Weeks', 'Wk').replace('Week', 'Wk')} ${st.dose}`).join('  →  '), F(500, 26), IW) : [];
const th = IP + nameLines.length * 52 + 14 + doseLines.length * 42 + 16 + infoLines.reduce((a, r) => a + r.v.length * 38 + 6, 0) + (titLines.length ? 10 + titLines.length * 34 : 0) + IP - 10;
y += 24;
if (draw){ ctx.fillStyle = C.tile; rr(L, y, TW, th, 30); ctx.fill(); }
let ty = y + IP;
nameLines.forEach((l, i) => { T(l, F(800, 44), C.ink, L + IP, ty + 42 + i * 52); });
const pc = pillOf(x.statusKey);
if (draw){ ctx.fillStyle = pc[0]; rr(L + TW - IP - pw, ty + 6, pw, 46, 23); ctx.fill(); ctx.fillStyle = pc[1]; ctx.beginPath(); ctx.arc(L + TW - IP - pw + 22, ty + 29, 5, 0, Math.PI * 2); ctx.fill(); }
T(x.status, F(700, 24), pc[1], L + TW - IP - pw + 36, ty + 38);
ty += nameLines.length * 52 + 14;
doseLines.forEach((l, i) => T(l, F(700, 32), C.sel, L + IP, ty + 32 + i * 42)); ty += doseLines.length * 42 + 16;
infoLines.forEach(r => { T(r.k, F(500, 28), C.muted, L + IP, ty + 30); r.v.forEach((l, i) => T(l, F(600, 28), C.ink, L + IP + 190, ty + 30 + i * 38)); ty += r.v.length * 38 + 6; });
if (titLines.length){ ty += 10; titLines.forEach((l, i) => T(l, F(500, 26), C.muted, L + IP, ty + 26 + i * 34)); }
y += th;
});
return y + 40 + IN;
};
const bottom = paint(false), H = bottom + 100;
cv.width = W; cv.height = H;
const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, C.bg1); g.addColorStop(1, C.bg2); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
ctx.save(); ctx.shadowColor = 'rgba(20,30,50,.10)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 12; ctx.fillStyle = C.card; rr(P, P, CW, bottom - P, 48); ctx.fill(); ctx.restore();
paint(true);
ctx.font = F(500, 26); ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.fillText('Shared from Peptide Log', W / 2, H - 40);
const text = [`My current protocol (as of ${asOf})`, ''].concat(...items.map(({x}) => [`${x.name} — ${x.status}`, `  Dose: ${x.dose}${x.doseSub ? ' (' + x.doseSub + ')' : ''}`, `  Route: ${x.rows[0][1]}`, `  Frequency: ${x.rows[1][1]}`, `  Dates: ${x.rows[2][1]} – ${x.rows[3][1]}`, ...(x.steps.length ? ['  Titration: ' + x.steps.map(st => `${st.when} ${st.dose}`).join(', ')] : []), ''])).join('\n');
const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
return deliver(blob, 'current-protocol.png', text);
}
let pdfLib = null;
const loadPdf = () => pdfLib || (pdfLib = new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'vendor/jspdf-2.5.1.min.js'; sc.onload = () => res(window.jspdf.jsPDF); sc.onerror = () => { pdfLib = null; rej(new Error('load')); }; document.head.appendChild(sc); }));
async function exportPdf(c){
const jsPDF = await loadPdf(), x = exportInfo(c);
const doc = new jsPDF({unit: 'pt', format: 'letter'}), W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 54;
let y = M;
const need = h => { if (y + h > H - M){ doc.addPage(); y = M; } };
doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.text(x.name, M, y + 8); y += 30;
doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(120); doc.text(`Exported ${new Date().toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'})} · Peptide Log`, M, y); y += 22;
doc.setTextColor(20);
[['Cycle start', x.start], ['Cycle end', x.end], ['Frequency', x.freq]].forEach(([k, v]) => {
doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(k, M, y);
doc.setFont('helvetica', 'normal'); const vl = doc.splitTextToSize(v, W - M * 2 - 90); doc.text(vl, M + 90, y); y += 16 * vl.length;
});
y += 10; doc.setDrawColor(220); doc.line(M, y, W - M, y); y += 24;
doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text(`Notes (${x.notes.length})`, M, y); y += 20;
if (!x.notes.length){ doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.text('No notes.', M, y); }
x.notes.forEach(n => {
const body = doc.setFont('helvetica', 'normal').setFontSize(11).splitTextToSize(n.text, W - M * 2);
need(18 + body.length * 15 + 12);
doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(47, 95, 179); doc.text(n.date, M, y); y += 16;
doc.setFont('helvetica', 'normal'); doc.setTextColor(20);
body.forEach(line => { need(15); doc.text(line, M, y); y += 15; });
y += 12;
});
return deliver(doc.output('blob'), fileBase(c) + '.pdf');
} // compound name the user already confirmed as an intentional duplicate // off-cycle item whose start-date picker is open
const doseDay = (c, i, d) => c.interval > 1 ? i % c.interval === 0 : c.days.includes(d.getDay());
const lenOf = c => isOpen(c) ? (c.start ? Math.max(diff(parse(c.start), today()), 0) : 0) + OPEN_AHEAD
: c.lenUnit === 'weeks' ? c.lenValue * 7 : c.lenValue;
function vialLife(c, fromIdx){
if (!(c.vialMg > 0) || !(c.bacMl > 0) || c.dose == null || mgOf(c, 1) == null) return null;
const sched = schedule(c), days = new Set(c.days), per = c.perDay || 1;
if (fromIdx >= sched.length) return null;
let used = 0, doses = 0, last = null;
for (let i = Math.max(fromIdx, 0); i < sched.length; i++){
const d = sched[i];
if (!doseDay(c, i, d)) continue;
const dv = doseAtIndex(c, i); if (!dv) continue;
const mg = mgOf(c, dv);
for (let k = 0; k < per; k++){
if (used + mg > c.vialMg + 1e-9) return {doses, from: sched[fromIdx], last, next: d, outlasts: false};
used += mg; doses++; last = d;
}
}
return {doses, from: sched[fromIdx], last, next: null, outlasts: true};
}
function vialLifeText(c, life, opener){
if (!life) return '';
if (!life.doses) return 'One dose is more than a full vial. Check the vial size or dose.';
const span = life.next ? diff(life.from, life.next) : diff(life.from, life.last) + 1;
const wks = span / 7;
const dur = span < 14 ? `${span} day${span === 1 ? '' : 's'}` : `${+wks.toFixed(1)} weeks`;
return life.outlasts
? `One vial covers the rest of this cycle (${life.doses} dose${life.doses === 1 ? '' : 's'}).`
: `One vial lasts about ${dur} (${life.doses} dose${life.doses === 1 ? '' : 's'}). ${opener} next one around ${dayWord(life.next)}.`;
}
function normalize(c){
c = {...c, days: [...(c.days||[])], pauses: [...(c.pauses||[])]};
if (c.titrate && !c.steps && c.every && c.step && c.dose != null){
const steps = []; let d = c.dose;
for (let k = 1; k * c.every * 7 < lenOf(c); k++){
let nd = d + (c.dir||1) * c.step;
if (c.limit != null) nd = (c.dir||1) > 0 ? Math.min(nd, c.limit) : Math.max(nd, c.limit);
if (Math.abs(nd - d) < 1e-9) break;
steps.push({week: k * c.every + 1, dir: (c.dir||1), amt: +Math.abs(nd - d).toFixed(6)}); d = nd;
}
c.steps = steps;
}
if (!Array.isArray(c.plan)){
const ev = [
...(c.titrate ? (c.steps||[]) : []).map(x => ({i: (x.week - 1) * 7, rel: true, v: x.dir * x.amt, week: x.week})),
...(c.changes||[]).map(x => ({i: idxOfDate(c, parse(x.date)), rel: false, v: x.dose, date: x.date})),
].sort((a,b) => a.i - b.i || b.rel - a.rel);
let d = c.dose ?? 0; const plan = [];
for (const e of ev){
d = Math.max(+(e.rel ? d + e.v : e.v).toFixed(6), 0);
const entry = e.week != null ? {week: e.week, dose: d, _i: e.i} : {date: e.date, dose: d, _i: e.i};
if (plan.length && plan[plan.length - 1]._i === e.i) plan[plan.length - 1] = entry; else plan.push(entry);
}
c.plan = plan.map(({_i, ...r}) => r);
if (c.plan.length) c.titrate = true;
}
c.plan = c.titrate ? c.plan.map(x => ({...x})) : [];
delete c.steps; delete c.changes;
delete c.every; delete c.step; delete c.limit; delete c.dir;
return c;
}
const schedCache = new WeakMap();
function schedule(c){
if (schedCache.has(c)) return schedCache.get(c);
const start = parse(c.start), lenDays = lenOf(c), t = today();
const pauses = (c.pauses||[]).map(p => ({from: parse(p.from), to: p.to ? parse(p.to) : t}));
const endOn = c.endedOn ? parse(c.endedOn) : null;
const out = [];
for (let d = start, g = 0; out.length < lenDays && g < 5000; d = addDays(d, 1), g++){
if (endOn && d >= endOn) break;
if (pauses.some(p => d >= p.from && d <= p.to)) continue;
out.push(d);
}
schedCache.set(c, out); return out;
}
function idxOfDate(c, date){
const s = schedule(c), k = s.findIndex(d => d >= date);
return k < 0 ? lenOf(c) : k;
}
const evCache = new WeakMap();
function events(c){
if (evCache.has(c)) return evCache.get(c);
const ev = [
...(c.titrate ? (c.plan||[]) : []).map(p => ({i: planIdx(c, p), set: true, v: p.dose, dated: !!p.date})),
].sort((a,b) => a.i - b.i);
evCache.set(c, ev); return ev;
}
function doseAtIndex(c, i){
if (c.dose == null) return null;
let d = c.dose;
for (const e of events(c)){ if (e.i > i) break; d = e.set ? e.v : d + e.v; }
return Math.max(+d.toFixed(6), 0);
}
const planIdx = (c, p) => p.week != null ? (p.week - 1) * 7 : idxOfDate(c, parse(p.date));
const isAdjustedAt = (c, i) => events(c).some(e => e.dated && Math.max(e.i,0) === i);
// a dose in its own unit -> mg (needs the vial's concentration for syringe units and mL)
function mgOf(c, dose){
if (dose == null) return null;
if (c.unit === 'mg') return dose;
if (c.unit === 'mcg') return dose / 1000;
const conc = c.vialMg > 0 && c.bacMl > 0 ? c.vialMg / c.bacMl : null;
if (!conc) return null;
if (c.unit === 'units') return dose / 100 * conc;
if (c.unit === 'mL') return dose * conc;
return null;
}
function unitsFor(c, dose){
if (dose == null || !(c.vialMg > 0) || !(c.bacMl > 0)) return null;
const mg = mgOf(c, dose);
if (mg == null) return null;
return mg / (c.vialMg / c.bacMl) * 100;
}
// what's left in the vial in use: walks past doses from the cycle start; each logged refill
// (or a dose that no longer fits) starts a full vial, then looks ahead to when it runs out
const rDate = r => typeof r === 'string' ? r : r.date;
const rfEdit = new Set(); // vial rows where the new-vial size is being changed
function vialStatus(c){
// nasal bottle without a known mg amount: track it by mL instead (treat 1 mL as one unit of "mg")
const byMl = isNasal(c) && !(c.vialMg > 0) && c.bacMl > 0;
if (byMl) c = {...c, vialMg: c.bacMl, refills: (c.refills || []).map(r => typeof r === 'object' ? {...r, mg: r.ml} : r), vial0: c.vial0 ? {mg: c.vial0.ml, ml: c.vial0.ml} : null};
if (!(c.vialMg > 0) || !(c.bacMl > 0) || c.dose == null || mgOf(c, 1) == null) return null;
const sched = schedule(c), days = new Set(c.days), per = c.perDay || 1, t = today(), conc = c.vialMg / c.bacMl;
// each vial keeps its own size/mix: the first one from vial0 (if the size was ever changed), later ones from their refill entry
const refills = (c.refills || []).map(r => ({d: parse(rDate(r)), mg: r.mg > 0 ? r.mg : c.vialMg, ml: r.ml > 0 ? r.ml : c.bacMl})).sort((a, b) => a.d - b.d);
let vial = c.vial0 && c.vial0.mg > 0 ? {mg: c.vial0.mg, ml: c.vial0.ml} : {mg: c.vialMg, ml: c.bacMl};
const mgIn = dv => mgOf({...c, vialMg: vial.mg, bacMl: vial.ml}, dv);
let rem = vial.mg, opened = parse(c.start), auto = false, ri = 0, i = 0;
const open = r => { vial = {mg: r.mg, ml: r.ml}; rem = r.mg; opened = r.d; auto = false; ri++; };
for (; i < sched.length && sched[i] < t; i++){
const d = sched[i];
while (ri < refills.length && refills[ri].d <= d) open(refills[ri]);
if (!doseDay(c, i, d)) continue;
const dv = doseAtIndex(c, i); if (!dv) continue;
const mg = mgIn(dv);
for (let k = 0; k < per; k++){ if (mg > rem + 1e-9){ rem = vial.mg; opened = d; auto = true; } rem -= mg; }
}
while (ri < refills.length && refills[ri].d <= t) open(refills[ri]);
let r2 = rem, left = 0, runOut = null;
outer: for (; i < sched.length; i++){
const d = sched[i];
if (!doseDay(c, i, d)) continue;
const dv = doseAtIndex(c, i); if (!dv) continue;
const mg = mgIn(dv);
for (let k = 0; k < per; k++){ if (mg > r2 + 1e-9){ runOut = d; break outer; } r2 -= mg; left++; }
}
rem = Math.max(rem, 0);
return {rem, pct: rem / vial.mg, opened, auto, dosesLeft: left, runOut, mlLeft: rem / (vial.mg / vial.ml), conc: vial.mg / vial.ml, vialMg: vial.mg, vialMl: vial.ml, byMl};
}
// the other way to read a dose: syringe units for mg/mcg, mg for units, mg + units for mL
function sec(c, dose){
const mg = mgOf(c, dose), un = unitsFor(c, dose);
if (mg == null) return '';
const mgTxt = `${num(+mg.toFixed(3))} mg`;
if (c.unit === 'units') return mgTxt;
if (c.unit === 'mL') return un != null ? `${mgTxt} \u00b7 ${u(un)}` : mgTxt;
return un != null ? u(un) : '';
}
const u = n => n == null ? '' : `${+n.toFixed(1)} units`;
function stats(c){
const lenDays = lenOf(c), sched = schedule(c), t = today();
const start = parse(c.start);
const end = sched.length ? sched[sched.length - 1] : start;
const days = new Set(c.days), per = c.perDay || 1;
let total = 0, done = 0, next = null, nextIdx = 0, elapsed = 0, doseToday = null;
let totalAmt = c.dose != null ? 0 : null, takenAmt = 0;
sched.forEach((d, i) => {
if (d <= t) elapsed = i + 1;
if (!doseDay(c, i, d)) return;
const dv = doseAtIndex(c, i);
if (dv === 0) return;
total += per;
if (totalAmt != null) totalAmt += dv * per;
if (d < t) { done += per; if (dv != null) takenAmt += dv * per; }
else {
if (!next) { next = d; nextIdx = i; }
if (+d === +t) doseToday = dv;
}
});
const openPause = (c.pauses||[]).find(p => !p.to && parse(p.from) <= t);
const endedEarly = !!c.endedOn && t >= parse(c.endedOn);
const status = openPause ? 'paused'
: endedEarly ? 'complete'
: t < start ? 'upcoming'
: t > end ? 'complete' : 'active';
const span = Math.max(sched.length, 1);
const curIdx = status === 'upcoming' ? 0 : Math.min(Math.max(elapsed - 1, 0), span - 1);
const curDose = doseAtIndex(c, curIdx);
const pausedDays = (c.pauses||[]).reduce((n, p) => {
const a = parse(p.from), b = p.to ? parse(p.to) : t;
return n + Math.max(diff(a, b) + 1, 0);
}, 0);
const steps = [];
if (c.dose != null){
for (let i = 0; i < sched.length; i++){
const dv = doseAtIndex(c, i), last = steps[steps.length - 1];
if (last && last.dose === dv) last.to = i;
else steps.push({from: i, to: i, dose: dv, adjusted: isAdjustedAt(c, i)});
}
}
return { lenDays, span, sched, start, end, total, done, next, nextIdx, status, elapsed, curIdx, curDose,
doseToday, openPause, endedEarly, pausedDays, steps,
remaining: Math.max(sched.length - elapsed, 0),
perWeek: (c.interval > 1 ? 7 / c.interval : c.days.length) * per,
weeklyAmt: curDose != null ? curDose * (c.interval > 1 ? 7 / c.interval : c.days.length) * per : null,
totalAmt,
totalTaken: c.dose != null ? takenAmt : null,
vialsTaken: c.dose != null && c.vialMg > 0 && mgOf(c, 1) != null ? mgOf(c, takenAmt) / c.vialMg : null,
vials: totalAmt != null && c.vialMg > 0 && mgOf(c, 1) != null ? mgOf(c, totalAmt) / c.vialMg : null,
totalMg: totalAmt != null ? mgOf(c, totalAmt) : null };
}
function renderDays(){
$('days').innerHTML = '';
[1,2,3,4,5,6,0].forEach(i => {
const b = document.createElement('button');
b.type = 'button'; b.className = 'day'; b.textContent = DAYNAME[i];
b.setAttribute('aria-pressed', !selEvery && selDays.has(i));
b.onclick = () => { if (selEvery){ selEvery = 0; selDays = new Set([i]); } else selDays.has(i) ? selDays.delete(i) : selDays.add(i); renderDays(); };
$('days').appendChild(b);
});
document.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('on', b.dataset.preset === 'eod' ? !!selEvery : !selEvery && b.dataset.preset === [...selDays].sort().join(',')));
$('eodNote').hidden = !selEvery;
}
const dayWord = d => { const dd = diff(today(), d); return dd === 0 ? 'today' : dd === 1 ? 'tomorrow' : `${DAYNAME[d.getDay()]} ${fmt(d)}`; };
// dose for display, always mg first when it can be worked out (units / mL doses show mg, then the amount entered)
function dosePair(c, dv){
if (dv == null) return {main: 'Dose not set', sub: ''};
if (isNasal(c) && c.spMl > 0){
const n = spraysOf(c, dv), mg = c.vialMg > 0 && c.bacMl > 0 ? dv * c.vialMg / c.bacMl : null;
return {main: `${num(n)} spray${n === 1 ? '' : 's'}`, sub: `per nostril \u00b7 ${num(+dv.toFixed(3))} mL${mg != null ? ' \u00b7 ' + (mg < 1 ? num(+(mg * 1000).toFixed(1)) + ' mcg' : num(+mg.toFixed(3)) + ' mg') : ''}`};
}
const mg = mgOf(c, dv);
if ((c.unit === 'units' || c.unit === 'mL') && mg != null){
const un = unitsFor(c, dv);
return {main: `${num(+mg.toFixed(4))} mg`, sub: c.unit === 'units' ? `${num(+dv.toFixed(2))} units` : `${num(dv)} mL${un != null ? ' \u00b7 ' + u(un) : ''}`};
}
return {main: `${num(dv)} ${c.unit}`, sub: sec(c, dv)};
}
const doseWithUnits = (c, dv) => { if (dv == null) return 'dose not set'; const d = dosePair(c, dv); return d.main + (d.sub ? ` (${d.sub})` : ''); };
function todayBlock(c, s){
const per = c.perDay || 1, x = per > 1 ? `<span class="tx">× ${per} ${isNasal(c) ? 'times a day' : 'injections'}</span>` : '';
if (s.status === 'paused')
return `<div class="today paused"><span class="label">Paused</span><div class="big">Paused since ${fmt(parse(s.openPause.from))}</div><span class="tx">No doses until you resume. Use Pause/End Cycle to resume.</span></div>`;
if (s.status === 'complete')
return `<div class="today done"><span class="label">${s.endedEarly ? 'Ended early' : 'Finished'}</span><div class="big">${s.endedEarly ? 'Ended ' + fmt(parse(c.endedOn)) : 'Finished ' + fmt(s.end)}</div>${s.curDose != null ? `<span class="tx">Last dose level ${num(s.curDose)} ${c.unit}</span>` : ''}</div>`;
if (s.status === 'upcoming'){
const fd = doseAtIndex(c, s.nextIdx);
return `<div class="today"><span class="label">Starts ${dayWord(s.start)}</span><div class="big">${dosePair(c, fd).main}${fd != null && dosePair(c, fd).sub ? ` <span class=\"bu\">${dosePair(c, fd).sub}</span>` : ''}</div>${x}<span class="tx">First dose ${s.next ? dayWord(s.next) : '—'}</span></div>`;
}
if (s.doseToday != null){
const sx = sec(c, s.doseToday);
return `<div class="today on"><span class="label">Dose today</span><div class="big">${dosePair(c, s.doseToday).main}${dosePair(c, s.doseToday).sub ? ` <span class="bu">${dosePair(c, s.doseToday).sub}</span>` : ''}</div>${x}</div>`;
}
const nd = s.next ? doseAtIndex(c, s.nextIdx) : null;
return `<div class="today off"><span class="label">Dose today</span><div class="big">No dose today</div><span class="tx">${s.next ? `Next ${dayWord(s.next)}${nd != null ? ' · ' + doseWithUnits(c, nd) : ''}` : 'No doses left in this cycle'}</span></div>`;
}
function detailsBlock(c, s){
const weekRange = (a, b) => { const wa = Math.floor(a/7)+1, wb = Math.floor(b/7)+1; return wa === wb ? `Wk ${wa}` : `Wk ${wa}–${wb}`; };
const conc = c.vialMg > 0 && c.bacMl > 0 ? c.vialMg / c.bacMl : null;
const stepsHtml = s.steps.length > 1 ? `<div class="kv"><span class="label">Titration schedule</span>
<div class="steps">${s.steps.map(st => `<div class="${s.status==='active' && s.curIdx>=st.from && s.curIdx<=st.to ? 'now':''}"><span>${weekRange(st.from, st.to)}<span class="hint" style="display:inline;margin-left:6px">${fmt(s.sched[st.from])}</span></span><span>${num(st.dose)} ${c.unit}${st.adjusted ? '<span class="tag">changed</span>' : ''}</span><span>${sec(c, st.dose)}</span></div>`).join('')}</div></div>` : '';
const pausesHtml = (c.pauses||[]).length ? `<div class="adjlist"><span class="label">Pauses · ${s.pausedDays} day${s.pausedDays === 1 ? '' : 's'} total</span>${c.pauses.map((p, i) => `<div><span>${fmt(parse(p.from))} – ${p.to ? fmt(parse(p.to)) : 'now'}</span><button class="link del" data-act="pause-rm" data-id="${c.id}" data-i="${i}">Remove</button></div>`).join('')}</div>` : '';
return `<div class="details">
<div class="grid">
<div class="kv"><span class="label">Dose / injection</span><b>${s.curDose != null ? doseWithUnits(c, s.curDose) : '—'}</b></div>
<div class="kv"><span class="label">Doses / wk</span><b>${c.interval > 1 ? "~" + num(+s.perWeek.toFixed(1)) : s.perWeek}</b></div>
<div class="kv"><span class="label">Per week</span><b>${s.weeklyAmt != null ? num(+s.weeklyAmt.toFixed(3)) + ' ' + c.unit : '—'}${(c.unit === 'units' || c.unit === 'mL') && mgOf(c, s.weeklyAmt) != null ? ` (${num(+mgOf(c, s.weeklyAmt).toFixed(3))} mg)` : ''}</b></div>
${isOpen(c) && !s.endedEarly ? `
<div class="kv"><span class="label">Doses taken</span><b>${s.done}</b></div>
<div class="kv"><span class="label">Taken so far</span><b>${s.totalTaken != null ? num(+s.totalTaken.toFixed(3)) + ' ' + c.unit : '—'}${(c.unit === 'units' || c.unit === 'mL') && mgOf(c, s.totalTaken) != null ? ` (${num(+mgOf(c, s.totalTaken).toFixed(3))} mg)` : ''}</b></div>
<div class="kv"><span class="label">Vials used so far</span><b>${s.vialsTaken != null ? +s.vialsTaken.toFixed(2) : '—'}</b></div>
<div class="kv"><span class="label">Per 4 weeks</span><b>${s.weeklyAmt != null ? num(+(s.weeklyAmt * 4).toFixed(3)) + ' ' + c.unit : '—'}</b></div>` : `
<div class="kv"><span class="label">Doses taken</span><b>${s.done} of ${s.total}</b></div>
<div class="kv"><span class="label">Total doses</span><b>${s.total}</b></div>
<div class="kv"><span class="label">Cycle total</span><b>${s.totalAmt != null ? num(+s.totalAmt.toFixed(3)) + ' ' + c.unit : '—'}${(c.unit === 'units' || c.unit === 'mL') && mgOf(c, s.totalAmt) != null ? ` (${num(+mgOf(c, s.totalAmt).toFixed(3))} mg)` : ''}</b></div>
<div class="kv"><span class="label">Vials needed</span><b>${s.vials != null ? `${Math.ceil(s.vials - 1e-9)} <span class="hint" style="display:inline">(${+s.vials.toFixed(2)} used)</span>` : '—'}</b></div>`}
<div class="kv"><span class="label">Concentration</span><b>${conc ? num(+conc.toFixed(3)) + ' mg/mL' : '—'}</b></div>
</div>
${conc ? `<div class="vial">${c.premixed ? `Premixed: ${num(c.bacMl)} mL vial at ${num(+conc.toFixed(3))} mg/mL (${num(+c.vialMg.toFixed(3))} mg total)` : `${num(c.vialMg)} mg vial + ${num(c.bacMl)} mL BAC water`}</div>` : ''}
${stepsHtml}
${pausesHtml}
${s.endedEarly ? `<div class="vial">${isOpen(c) ? `Ended on ${fmt(parse(c.endedOn))} after ${s.sched.length} days.` : `Ended early on ${fmt(parse(c.endedOn))}, ${s.sched.length} of ${s.lenDays} planned days run.`}</div>` : ''}
</div>`;
}
function cyclePanel(c, s){
const t = iso(today());
let body;
if (s.status === 'paused'){
body = `<div class="cyopt"><span class="hint">Paused since ${fmt(parse(s.openPause.from))}. Resuming pushes the end date back by the days paused.</span>
<div class="field"><label class="label" for="cy-resume">Resume on</label><input id="cy-resume" type="date" value="${t}"></div>
<button class="btn" data-act="cy-resume" data-id="${c.id}">Resume cycle</button></div>
<div class="cyopt"><div class="field"><label class="label" for="cy-end">End cycle on</label><input id="cy-end" type="date" value="${t}"></div>
<button class="btn ghost dangerbtn" data-act="cy-end" data-id="${c.id}">End cycle</button></div>`;
} else if (s.status === 'complete'){
body = c.endedOn
? `<div class="cyopt"><span class="hint">This cycle was ended on ${fmt(parse(c.endedOn))}. Reopening restores the full planned length.</span><button class="btn" data-act="cy-reopen" data-id="${c.id}">Reopen cycle</button></div>`
: `<div class="cyopt"><span class="hint">This cycle has finished. Edit it to extend the length, or use Repeat to start a new one.</span></div>`;
} else {
body = `<div class="cyopt"><div class="field"><label class="label" for="cy-pause">Pause starting</label><input id="cy-pause" type="date" value="${t < c.start ? c.start : t}"></div>
<button class="btn" data-act="cy-pause" data-id="${c.id}">Pause cycle</button>
<span class="hint">Paused days don't count. The end date moves back.</span></div>
<div class="cyopt"><div class="field"><label class="label" for="cy-end">End cycle on</label><input id="cy-end" type="date" value="${t}"></div>
<button class="btn ghost dangerbtn" data-act="cy-end" data-id="${c.id}">End cycle</button>
<span class="hint">No doses from this date on.</span></div>`;
}
return `<div class="adjust cypanel">${body}<div class="actions"><button class="btn ghost" data-act="cy-cancel">Close</button><span class="err" id="cy-err"></span></div></div>`;
}
// tapping a cycle opens its full card in a bottom sheet over the page
let sheetId = null, sheetFresh = false, vialSheetId = null, vialFresh = false;
const detOpen = c => (view === 'home' && ['active','paused'].includes(stats(c).status) ? collapsed : expanded).has(c.id);
function renderList(){
const prev = document.querySelector('.sheet'), top = prev ? prev.scrollTop : 0;
renderListInner();
const vc = vialSheetId && cycles.find(x => x.id === vialSheetId), vv = vc && vialStatus(vc);
if (vialSheetId && !vv) vialSheetId = null;
const c = sheetId && cycles.find(x => x.id === sheetId);
if (sheetId && !c) sheetId = null;
const showV = !!vv && phase === 'app' && view !== 'add';
const show = !!c && phase === 'app' && view !== 'add';
document.documentElement.classList.toggle('sheet-open', show || showV);
if (showV){
$('list').insertAdjacentHTML('beforeend', `<div class="sheet-wrap${vialFresh ? ' anim' : ''}"><div class="sheet-bg" data-act="vsheet-close"></div>
<div class="sheet vsheet" role="dialog" aria-modal="true" aria-label="${esc(vc.name)} vial"><div class="sheet-bar"><button type="button" class="sheet-x" data-act="vsheet-close" aria-label="Close">\u2715</button></div>
<div class="vs-body">${vialRow(vc, vv, true)}</div></div></div>`);
vialFresh = false;
}
if (!show) return;
$('list').insertAdjacentHTML('beforeend', `<div class="sheet-wrap${sheetFresh ? ' anim' : ''}"><div class="sheet-bg" data-act="sheet-close"></div>
<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(c.name)}"><div class="sheet-bar"><span class="sheet-grab" aria-hidden="true"></span><button type="button" class="sheet-x" data-act="sheet-close" aria-label="Close">✕</button></div>
${card({c, s: stats(c)}, detOpen(c))}</div></div>`);
const el = document.querySelector('.sheet');
if (sheetFresh){ sheetFresh = false; } else el.scrollTop = top;
if (adjConfirm) $('list').insertAdjacentHTML('beforeend', adjConfirmHtml());
}
function renderListInner(){
if (phase === 'app') writeCache();
const withStats = cycles.map(c => ({c, s: stats(c)}));
const order = {active:0, paused:1, upcoming:2, complete:3};
withStats.sort((a,b) => order[a.s.status]-order[b.s.status]
|| (a.s.status === 'active' && (b.s.doseToday != null) - (a.s.doseToday != null))
|| (a.s.status==='complete' ? b.s.end - a.s.end : a.s.start - b.s.start));
const activeN = withStats.filter(x => x.s.status === 'active').length;
const pausedN = withStats.filter(x => x.s.status === 'paused').length;
$('count').textContent = `${activeN} active${pausedN ? ` · ${pausedN} paused` : ''} · ${cycles.length} total`;
const names = [...new Set(cycles.map(c => c.name))].sort();
$('peptides').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
const list = $('list');
const t = today(), now = new Date();
const h = now.getHours();
$('greet').textContent = `Good ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}${profile && profile.name ? ', ' + profile.name : ''}.`;
$('todayStr').textContent = t.toLocaleDateString(undefined, {weekday: 'long', month: 'long', day: 'numeric'});
$('asOf').textContent = 'As of ' + now.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'}).replace(' ', '').toLowerCase();
const panel = (title, sub, body, badge) => `<section class="panel">
<div class="phead"><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${badge || ''}</div>
<div class="pbody">${body}</div></section>`;
const startCta = (h3, p) => `<div class="pempty"><h3>${h3}</h3><p>${p}</p><button type="button" class="btn" data-nav="add">Start</button></div>`;
if (view === 'home'){
const badge = `<div class="datebadge"><span>${t.toLocaleDateString(undefined, {month: 'short'}).toUpperCase()}</span><b>${t.getDate()}</b></div>`;
const running = withStats.filter(x => x.s.status === 'active' || x.s.status === 'paused');
const coming = withStats.filter(x => x.s.status === 'upcoming');
const due = running.filter(x => x.s.doseToday != null);
const inj = due.reduce((n, x) => n + (x.c.perDay || 1), 0);
const todaySub = !cycles.length ? 'Your daily doses appear here.'
: due.length ? `${due.length} peptide${due.length > 1 ? 's' : ''} due today · ${inj} dose${inj > 1 ? 's' : ''}`
: 'Your daily doses appear here.';
const nextUp = withStats.filter(x => x.s.status !== 'complete' && x.s.status !== 'paused' && x.s.next).sort((a,b) => a.s.next - b.s.next)[0];
const todayBody = !cycles.length
? startCta('Set up your protocol', 'Add the peptides you take to build your schedule. Today’s doses, progress, and vial counts will show up here.')
: due.length ? `<div class="rows">${due.map(x => trow(x, 'home|' + x.c.id)).join('')}</div>`
: `<div class="pempty quiet"><h3>No dose today</h3>${nextUp ? `<p>Next: ${esc(nextUp.c.name)} ${dayWord(nextUp.s.next)} · ${doseWithUnits(nextUp.c, doseAtIndex(nextUp.c, nextUp.s.nextIdx))}</p>` : '<p>Nothing scheduled.</p>'}</div>`;
const days = [];
for (let k = 1; k <= 7; k++){
const d = addDays(t, k), items = [];
withStats.forEach(({c, s}) => {
if (s.status === 'complete') return;
const i = s.sched.findIndex(x => +x === +d);
if (i < 0 || !doseDay(c, i, d)) return;
const dv = doseAtIndex(c, i); if (!dv) return;
items.push({c, dv, x: withStats.find(w => w.c === c)});
});
if (items.length) days.push({d, items});
}
const later = coming.filter(x => diff(t, x.s.start) > 7);
const upMore = openRows.has('up|more'), near = days.filter(x => diff(t, x.d) <= 3), shownDays = upMore ? days : near, hidden = days.length - near.length;
const upToggle = hidden > 0 || upMore ? `<button type="button" class="upmore" data-act="row" data-key="up|more" aria-expanded="${upMore}">${upMore ? 'Show next 3 days' : `Show next 7 days${hidden ? ` (${hidden} more day${hidden === 1 ? '' : 's'})` : ''}`}</button>` : '';
const upBody = (days.length ? (shownDays.length ? `<div class="uplist bubbles">${shownDays.map(({d, items}) => `<div class="upday">
<div class="d"><b>${DAYNAME[d.getDay()]}</b><span>${fmt(d)}</span></div>
<div class="upitems">${items.map(({c, dv}) => `<div class="upitem"><span class="n">${esc(c.name)}</span><span class="q"><b>${dosePair(c, dv).main}${(c.perDay||1) > 1 ? ' \u00d7 ' + c.perDay : ''}</b>${dosePair(c, dv).sub ? `<span class="u">${dosePair(c, dv).sub}</span>` : ''}</span></div>`).join('')}</div>
</div>`).join('')}</div>` : `<div class="pempty quiet"><h3>No doses in the next 3 days.</h3></div>`) + upToggle : `<div class="pempty quiet"><h3>There are no upcoming doses to show.</h3></div>`)
+ (later.length ? `<div class="upnote">${later.map(x => `${esc(x.c.name)} starts ${fmt(x.s.start)}`).join(' · ')}</div>` : '')
+ (withStats.some(x => x.s.status === 'paused') ? `<div class="upnote">Paused: ${withStats.filter(x => x.s.status === 'paused').map(x => esc(x.c.name)).join(', ')}</div>` : '');
const waiting = isOwner ? (testers || []).filter(r => r.status === 'pending') : [];
const alertBox = waiting.length ? `<section class="panel approvals"><div class="phead"><div><h2>${waiting.length === 1 ? '1 person is' : waiting.length + ' people are'} waiting for approval</h2><p>New sign-ups can’t use the app until you approve them.</p></div></div>
<div class="pbody"><div class="uplist">${waiting.map(r => `<div class="upday" style="grid-template-columns:minmax(0,1fr) auto;align-items:center">
<div class="d"><b>${esc(r.name)}</b><span class="tg">@${esc(r.telegram || '')}</span><span>Signed up ${fmt(new Date(r.joined))}</span></div>
<div class="tact"><button class="btn" data-tact="approved" data-id="${r.id}">Approve</button><button class="btn ghost" data-tact="paused" data-id="${r.id}">Pause</button></div>
</div>`).join('')}</div></div></section>` : '';
const ready = withStats.map(x => ({...x, o: offInfo(x.c, x.s)})).filter(x => x.o && x.o.ready && !x.o.snoozed);
const readyBox = ready.map(({c, o}) => `<section class="panel readybox"><div class="phead"><div><h2>Ready to start ${esc(c.name)} again?</h2><p>Your ${offLabel(c)} off-cycle ${o.left === 0 ? 'ends today' : 'ended ' + fmt(o.due)}. The next round won’t start until you confirm.</p></div></div>
<div class="pbody">${nxControls(c, o, 'home')}<div class="actions" style="margin-top:6px"><button class="link" data-act="nx-snooze" data-id="${c.id}">Not yet</button><button class="link del" data-act="nx-stop" data-id="${c.id}">Stop repeating</button></div></div></section>`).join('');
const needs = withStats.filter(x => x.s.status !== 'complete').map(x => ({c: x.c, m: missing(x.c)})).filter(x => x.m.length);
const needBox = needs.length ? `<section class="panel attn" role="alert"><div class="phead"><div><h2>Needs attention</h2><p>${needs.length === 1 ? 'This compound is' : 'These compounds are'} missing information, so doses or vial counts can’t be shown.</p></div></div>
<div class="pbody"><div class="attnlist">${needs.map(({c, m}) => `<div class="attnrow"><div><b>${esc(c.name)}</b><span>${m.join(' · ')}</span></div><button class="btn" data-act="edit" data-id="${c.id}">Fix</button></div>`).join('')}</div></div></section>` : '';
list.innerHTML = alertBox + needBox + readyBox + panel('Today', todaySub, todayBody, badge)
+ panel('Upcoming', upMore ? 'Your scheduled doses for the next 7 days.' : 'Your scheduled doses for the next 3 days.', upBody)
+ vialsPanel(withStats.filter(x => x.s.status !== 'complete'), panel);
return;
}
if (view === 'testers'){
const rows = (testers || []).slice().sort((a,b) => (b.joined||0) - (a.joined||0));
const pend = rows.filter(r => r.status === 'pending').length;
const pillOf = {pending: 'upcoming', approved: 'active', paused: 'paused', blocked: 'complete'}, word = {pending: 'Waiting', approved: 'Approved', paused: 'Paused', blocked: 'Declined'};
list.innerHTML = panel('Testers', testers == null ? 'Loading…' : `${rows.length} ${rows.length === 1 ? 'person' : 'people'} signed up${pend ? ` · ${pend} waiting for approval` : ''}. Only you can see this list.`,
rows.length ? `<div class="uplist">${rows.map(r => `<div class="upday" style="grid-template-columns:minmax(0,1fr) auto;align-items:center">
<div class="d"><b>${esc(r.name || 'Unnamed')}${r.you ? ' <span class="hint" style="display:inline">(you)</span>' : ''}</b><span class="tg">@${esc(r.telegram || '')}</span><span>Joined ${r.joined ? fmt(new Date(r.joined)) : '—'} · <span class="pill ${pillOf[r.status]}" style="padding:1px 8px">${word[r.status]}</span></span></div>
<div class="tact">${r.you ? '' : delId === r.id
? `<span class="hint" style="flex-basis:100%;text-align:right">Delete ${esc(r.name)} and all their cycles?</span><button class="btn dangerfill" data-tdel="${r.id}">Delete</button><button class="btn ghost" data-tdelno="1">Keep</button>`
: (r.status === 'approved'
? `<button class="btn ghost" data-tact="paused" data-id="${r.id}">Pause</button>`
: `<button class="btn" data-tact="approved" data-id="${r.id}">${r.status === 'pending' ? 'Approve' : 'Resume'}</button>`)
+ `<button class="btn ghost del" data-tdelask="${r.id}">Delete</button>`}</div>
</div>`).join('')}</div>`
: `<div class="pempty quiet"><h3>No testers yet.</h3><p>Send people the link. They sign in with their email, and you approve them here.</p></div>`);
return;
}
if (view === 'upcoming'){
const offs = withStats.map(x => ({...x, o: offInfo(x.c, x.s)})).filter(x => x.o).sort((a, b) => a.o.due - b.o.due);
const sched = withStats.filter(x => x.s.status === 'upcoming');
const offHtml = offs.map(({c, o}) => `<div class="offrow">
<div class="offtop"><div><div class="cname">${esc(c.name)}</div><div class="cline">${o.ready ? 'Off-cycle done · ready to start' : `Off-cycle · ${o.left} day${o.left === 1 ? '' : 's'} left`}</div></div>
<div class="offdue"><span class="label">${o.ready ? 'Was due' : 'Next round'}</span><b>${fmt(o.due)}</b></div></div>
<div class="track"><div class="fill" style="width:${Math.round(o.elapsed / o.days * 100)}%"></div></div>
<div class="progtext"><span>Off since ${fmt(o.from)}</span><span>${offLabel(c)} break</span></div>
${nxControls(c, o, 'up')}
<div class="actions"><button class="link del" data-act="nx-stop" data-id="${c.id}">Stop repeating</button></div>
</div>`).join('');
list.innerHTML = panel('Off-cycle', offs.length ? 'Cycles on a break, with when the next round is due. Nothing starts until you confirm.' : '',
offs.length ? `<div class="offlist">${offHtml}</div>` : `<div class="pempty quiet"><h3>Nothing on an off-cycle.</h3><p>Add an off-cycle length to a cycle and it shows up here when the cycle ends.</p></div>`)
+ (sched.length ? panel('Scheduled to start', 'Cycles with a start date in the future.', `<div class="rows">${sched.map(x => crow(x, 'up|' + x.c.id)).join('')}</div>`) : '');
return;
}
const titles = {current: 'Current cycles', complete: 'Completed cycles', all: 'All cycles'};
const shown = withStats.filter(({s}) => view === 'all' || (view === 'complete' ? s.status === 'complete' : s.status !== 'complete'));
const subs = {current: 'Active, paused, and upcoming cycles.', complete: 'Cycles that finished or were ended.', all: 'Every cycle you’ve logged.'};
const sub = `${subs[view]}${shown.length ? ` ${shown.length} cycle${shown.length === 1 ? '' : 's'}.` : ''}`;
const seg = view === 'all' && shown.length ? `<div class="seg" role="tablist"><button type="button" role="tab" data-allmode="list" aria-selected="${allMode === 'list'}">List</button><button type="button" role="tab" data-allmode="month" aria-selected="${allMode === 'month'}">Timeline</button></div>` : '';
const shareAllBtn = view === 'current' && shown.length ? `<button type="button" class="shareall" data-shareall="1" aria-label="Share all current cycles"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>Share all</button>` : '';
list.innerHTML = panel(titles[view], sub, shown.length
? seg + (view === 'all' && allMode === 'month' ? monthView(shown) : `<div class="rows">${shown.map(x => crow(x, view + '|' + x.c.id)).join('')}</div>`)
: view === 'complete'
? `<div class="pempty quiet"><h3>No completed cycles yet.</h3></div>`
: startCta('Set up your protocol', 'Add the peptides you take to build your schedule.'), shareAllBtn);
}
// All cycles grouped by month: each month lists the compounds dosed in it
function monthView(rows){
const t = today(), months = new Map();
rows.forEach(({c, s}) => {
const stop = isOpen(c) && !c.endedOn ? t : null; // open-ended cycles only count up to today
s.sched.forEach((d, i) => {
if (stop && d > stop) return;
if (!doseDay(c, i, d) || !doseAtIndex(c, i)) return;
const k = d.getFullYear() * 12 + d.getMonth();
if (k > t.getFullYear() * 12 + t.getMonth()) return; // timeline stops at the current month
if (!months.has(k)) months.set(k, new Map());
const m = months.get(k), e = m.get(c.id) || {c, s, n: 0, first: d, last: d};
e.n += c.perDay || 1; e.last = d; m.set(c.id, e);
});
});
if (!months.size) return '<div class="pempty quiet"><h3>No doses scheduled yet.</h3></div>';
const years = [...new Set([...months.keys()].map(k => Math.floor(k / 12)))].sort((a, b) => b - a);
if (!years.includes(allYear)) allYear = years.includes(t.getFullYear()) ? t.getFullYear() : years[0];
const yearBar = `<div class="years" role="tablist" aria-label="Year">${years.map(y => `<button type="button" role="tab" data-allyear="${y}" aria-selected="${y === allYear}">${y}</button>`).join('')}</div>`;
const md = d => d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
return yearBar + `<div class="months">${[...months.keys()].filter(k => Math.floor(k / 12) === allYear).sort((a, b) => b - a).map(k => {
const label = new Date(Math.floor(k / 12), k % 12, 1).toLocaleDateString(undefined, {month: 'long', year: 'numeric'});
const items = [...months.get(k).values()].sort((a, b) => a.first - b.first || a.c.name.localeCompare(b.c.name));
const isNow = k === t.getFullYear() * 12 + t.getMonth(), future = k > t.getFullYear() * 12 + t.getMonth();
return `<section class="month"><div class="mhead"><h3>${label}</h3><span>${isNow ? 'This month · ' : future ? 'Planned · ' : ''}${items.length} compound${items.length === 1 ? '' : 's'}</span></div>
<div class="mlist">${items.map(e => `<button type="button" class="mitem" data-act="sheet" data-id="${e.c.id}" aria-haspopup="dialog"><span class="mi-main"><span class="mi-name">${esc(e.c.name)}</span><span class="mi-sub">${md(e.first)}${+e.first !== +e.last ? ' – ' + md(e.last) : ''} · ${e.n} dose${e.n === 1 ? '' : 's'}${e.c.dose != null ? ' · ' + num(e.c.dose) + ' ' + e.c.unit : ''}</span></span><span class="pill ${e.s.status}">${e.s.status}</span><span class="chev" aria-hidden="true">\u203a</span></button>`).join('')}</div></section>`;
}).join('')}</div>`;
}
function vialsPanel(rows, panel){
const items = rows.map(x => ({x, v: vialStatus(x.c)})).filter(r => r.v);
if (!items.length) return '';
return panel('Vials', 'What\u2019s left in each vial you\u2019re using. Tap one to start a new vial.', `<div class="vials">${items.map(({x, v}) => vialRow(x.c, v, false)).join('')}</div>`);
}
function vialRow(c, v, inSheet){
{
const pct = Math.round(v.pct * 100);
const lvl = pct <= 20 ? 'low' : pct <= 50 ? 'mid' : 'ok';
const nasal = isNasal(c), sprLeft = nasal && c.spMl > 0 ? Math.floor(v.mlLeft / c.spMl + 1e-9) : null;
const mgTxt = nasal ? `${num(+v.mlLeft.toFixed(2))} of ${num(+v.vialMl.toFixed(2))} mL left${!v.byMl ? ' · ' + num(+v.rem.toFixed(2)) + ' mg' : ''}` : `${num(+v.rem.toFixed(2))} of ${num(+v.vialMg.toFixed(2))} mg left`;
const sub = v.runOut ? `${v.dosesLeft} dose${v.dosesLeft === 1 ? '' : 's'} left \u00b7 new ${isNasal(c) ? "bottle" : "vial"} ${dayWord(v.runOut)}` : `${v.dosesLeft} dose${v.dosesLeft === 1 ? '' : 's'} left \u00b7 lasts the rest of the cycle`;
const vdesc = (mg, ml) => isNasal(c) ? `${num(+ml.toFixed(3))} mL bottle${mg > 0 ? ' · ' + num(+mg.toFixed(3)) + ' mg' : ''}` : c.premixed ? `${num(+ml.toFixed(3))} mL at ${num(+(mg / ml).toFixed(3))} mg/mL (${num(+mg.toFixed(3))} mg)` : `${num(+mg.toFixed(3))} mg + ${num(+ml.toFixed(3))} mL BAC water`;
const sizeTag = r => typeof r === 'object' && r.mg > 0 && (r.mg !== c.vialMg || r.ml !== c.bacMl) ? ` (${c.premixed ? num(+r.ml.toFixed(3)) + ' mL' : num(+r.mg.toFixed(3)) + ' mg'})` : '';
const hist = [`${fmt(parse(c.start))} (start${c.vial0 && (c.vial0.mg !== c.vialMg || c.vial0.ml !== c.bacMl) ? ', ' + (c.premixed ? num(+c.vial0.ml.toFixed(3)) + ' mL' : num(+c.vial0.mg.toFixed(3)) + ' mg') : ''})`, ...(c.refills || []).slice().sort((a, b) => rDate(a).localeCompare(rDate(b))).map(r => `${fmt(parse(rDate(r)))}${sizeTag(r)} <button class="link del" data-act="refill-rm" data-id="${c.id}" data-date="${rDate(r)}">remove</button>`)];
const ed = rfEdit.has(c.id);
const sizeBox = ed ? `<div class="vconfirm edit"><span class="label">New vial</span>
<div class="vcgrid">${isNasal(c)
? `<div class="field"><label class="label" for="rf-a-${c.id}">Bottle size (mL)</label><input id="rf-a-${c.id}" type="number" min="0" step="any" inputmode="decimal" value="${+c.bacMl.toFixed(4)}"></div>
<div class="field"><label class="label" for="rf-b-${c.id}">Peptide in bottle (mg)</label><input id="rf-b-${c.id}" type="number" min="0" step="any" inputmode="decimal" placeholder="Optional" value="${c.vialMg > 0 ? +c.vialMg.toFixed(4) : ''}"></div>`
: c.premixed
? `<div class="field"><label class="label" for="rf-a-${c.id}">Vial size (mL)</label><input id="rf-a-${c.id}" type="number" min="0" step="any" inputmode="decimal" value="${+c.bacMl.toFixed(4)}"></div>
<div class="field"><label class="label" for="rf-b-${c.id}">Concentration (mg/mL)</label><input id="rf-b-${c.id}" type="number" min="0" step="any" inputmode="decimal" value="${+(c.vialMg / c.bacMl).toFixed(4)}"></div>`
: `<div class="field"><label class="label" for="rf-a-${c.id}">Vial size (mg)</label><input id="rf-a-${c.id}" type="number" min="0" step="any" inputmode="decimal" value="${+c.vialMg.toFixed(4)}"></div>
<div class="field"><label class="label" for="rf-b-${c.id}">BAC water (mL)</label><input id="rf-b-${c.id}" type="number" min="0" step="any" inputmode="decimal" value="${+c.bacMl.toFixed(4)}"></div>`}</div>
<span class="hint">A different size or mix changes syringe units for doses from this vial on. Your cycle stays the same.</span>
<button class="link" data-act="rf-change" data-id="${c.id}">Keep current size</button></div>`
: `<div class="vconfirm"><div><span class="label">New vial</span><b>${vdesc(c.vialMg || 0, c.bacMl)}</b></div><button class="link" data-act="rf-change" data-id="${c.id}">Change</button></div>`;
const head = `
<span class="vialmeter" aria-hidden="true"><span class="vm-fill" style="height:${pct}%"></span></span>
<span class="vm-text"><span class="vm-name">${esc(c.name)}<span class="vm-pct">${pct}%</span></span>
<span class="vm-bar"><span style="width:${pct}%"></span></span>
<span class="vm-sub">${nasal ? mgTxt + (sprLeft != null ? ` · ${sprLeft} sprays` : '') : `${mgTxt} (${num(+v.mlLeft.toFixed(2))} mL)`}</span>
<span class="vm-sub">${sub}</span></span>
${inSheet ? '' : '<span class="chev" aria-hidden="true">\u203a</span>'}`;
if (!inSheet) return `<div class="vialrow ${lvl}"><button type="button" class="vialhead" data-act="vsheet" data-id="${c.id}" aria-haspopup="dialog">${head}</button></div>`;
return `<div class="vialrow ${lvl} insheet"><div class="vialhead">${head}</div></div>
<h3 class="vs-title">Start a new vial</h3>
<div class="refill">
<div class="field"><label class="label" for="rf-${c.id}">New vial opened on</label><input id="rf-${c.id}" type="date" value="${iso(today())}"></div>
${sizeBox}
<button class="btn" data-act="refill" data-id="${c.id}">Confirm new vial</button>
<span class="hint">Current vial ${v.auto ? 'assumed opened' : 'opened'} ${fmt(v.opened)}${v.auto ? ' (when the last one ran out)' : ''}.</span>
<div class="adjlist"><span class="label">Vials opened</span><div>${hist.join(' \u00b7 ')}</div></div>
<span class="err" id="rf-err-${c.id}"></span>
</div>`;
}
}
function nxControls(c, o, where){
const key = where + '|' + c.id, open = nxPick === key, min = iso(o.from);
return open ? `<div class="nxpick"><div class="field"><label class="label" for="nx-date">Started on</label><input id="nx-date" type="date" min="${min}" value="${iso(today())}"></div>
<div class="actions"><button class="btn" data-act="nx-go" data-id="${c.id}">Start next round</button><button class="btn ghost" data-act="nx-cancel" data-id="${c.id}">Cancel</button><span class="err" id="nx-err"></span></div></div>`
: `<div class="actions">${o.ready ? `<button class="btn" data-act="nx-today" data-id="${c.id}">Start today</button>` : ''}<button class="btn ${o.ready ? 'ghost' : ''}" data-act="nx-pick" data-key="${key}" data-id="${c.id}">${o.ready ? 'Pick a start date' : 'Start now'}</button></div>`;
}
async function startNext(c, dateIso){
const plan = (c.plan || []).map(p => p.week != null ? p : {week: Math.floor(idxOfDate(c, parse(p.date)) / 7) + 1, dose: p.dose}).filter(p => p.week >= 2);
const nc = normalize({...c, id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2,6), start: dateIso, plan,
pauses: [], endedOn: null, refills: [], nextId: null, noRepeat: false, snoozeUntil: null, created: Date.now()});
await store.save(nc);
cycles.push(nc);
const oc = normalize({...c, nextId: nc.id});
try { await store.save(oc); cycles = cycles.map(x => x.id === c.id ? oc : x); } catch {}
nxPick = null; view = 'home'; setView('home');
}
function crow(x, key){
const {c, s} = x, on = openRows.has(key);
let line;
if (s.status === 'paused') line = `Paused since ${fmt(parse(s.openPause.from))}`;
else if (s.status === 'complete' && offInfo(c, s)){ const o = offInfo(c, s); line = o.ready ? 'Off-cycle done · ready for next round' : `Off-cycle · next round ${fmt(o.due)}`; }
else if (s.status === 'complete') line = (s.endedEarly ? `Ended ${fmt(parse(c.endedOn))}` : `Finished ${fmt(s.end)}`) + (c.noRepeat ? ' · not repeating' : '');
else if (s.status === 'upcoming') line = `Starts ${dayWord(s.start)}`;
else if (s.doseToday != null) line = `Due today · ${doseWithUnits(c, s.doseToday)}`;
else if (s.next) line = `Next ${dayWord(s.next)} · ${doseWithUnits(c, doseAtIndex(c, s.nextIdx))}`;
else line = 'No doses left';
return `<div class="crow"><button type="button" class="crowhead" data-act="sheet" data-id="${c.id}" aria-haspopup="dialog">
<span class="cmain"><span class="cname">${esc(c.name)}</span><span class="cline">${line}</span></span>
<span class="pill ${s.status}">${s.status}</span><span class="chev" aria-hidden="true">›</span></button></div>`;
}
// Today: compact row (name, today's dose, day x of y, days left); tap to open the full card
function trow(x, key){
const {c, s} = x, on = openRows.has(key), open_ = isOpen(c), per = c.perDay || 1;
const sx = sec(c, s.doseToday);
const prog = open_ ? `Day ${Math.max(s.elapsed, 0)} · Open-ended` : `Day ${Math.max(s.elapsed, 0)} of ${s.span} · ${s.remaining} day${s.remaining === 1 ? '' : 's'} left`;
return `<div class="crow trow"><button type="button" class="crowhead" data-act="sheet" data-id="${c.id}" aria-haspopup="dialog">
${(() => { const pct = open_ ? 1 : Math.min(Math.max(s.elapsed / s.span, 0), 1), C = 2 * Math.PI * 22; return `<span class="ring" aria-hidden="true"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="22" class="rt"/><circle cx="26" cy="26" r="22" class="rf" stroke-dasharray="${C}" stroke-dashoffset="${open_ ? 0 : C * (1 - pct)}"/></svg><span class="rn">${open_ ? 'Day' : s.remaining}<small>${open_ ? Math.max(s.elapsed, 0) : 'left'}</small></span></span>`; })()}<span class="cmain"><span class="cname">${esc(c.name)}<span class="rchip r-${routeOf(c)}">${ROUTES[routeOf(c)][0]}</span></span><span class="tdose">${dosePair(c, s.doseToday).main}${dosePair(c, s.doseToday).sub ? ` <span class="bu">${dosePair(c, s.doseToday).sub}</span>` : ''}${per > 1 ? ` <span class="bu">\u00d7 ${per}</span>` : ''}</span><span class="cline">${prog}</span></span>
<span class="chev" aria-hidden="true">›</span></button></div>`;
}
function card({c, s}, open){
const open_ = isOpen(c);
const pct = open_ ? 0 : Math.round(s.elapsed / s.span * 100);
const lifeNow = s.status === 'complete' ? null : vialLife(c, s.status === 'upcoming' ? 0 : s.curIdx);
const lifeLine = lifeNow ? `<div class="vialline"><span class="label">Vial</span><span>${vialLifeText(c, lifeNow, s.status === 'upcoming' ? 'Starting from day 1, open the' : 'If you open one today, open the')}</span></div>` : '';
const wk = [1,2,3,4,5,6,0].map(i => `<span class="${c.days.includes(i)?'on':''}" title="${DAYNAME[i]}">${DAY[i]}</span>`).join('');
const progL = s.status === 'upcoming' ? `Starts in ${diff(today(), s.start)} day${diff(today(), s.start) === 1 ? '' : 's'}`
: open_ ? `Day ${Math.max(s.elapsed, 0)}` : `Day ${Math.max(s.elapsed, 0)} of ${s.span}`;
const progR = s.status === 'complete' ? (s.endedEarly ? 'Ended early' : 'Complete')
: open_ ? (s.status === 'paused' ? 'Open-ended · on hold' : 'Open-ended')
: s.status === 'paused' ? `${s.remaining} day${s.remaining === 1 ? '' : 's'} left · on hold`
: `${s.remaining} day${s.remaining === 1 ? '' : 's'} left`;
const alt = altUnit(c), mode = adjustId === c.id && adjMode && (adjMode === c.unit || adjMode === alt) ? adjMode : c.unit;
const dDate = adjDraft && adjDraft.id === c.id && adjDraft.date ? adjDraft.date : iso(today() < s.start ? s.start : today() > s.end ? s.end : today());
const dBase = adjDraft && adjDraft.id === c.id ? adjDraft.base : s.curDose;
const dVal = dBase == null ? '' : +fromBase(c, dBase, mode).toFixed(mode === 'units' ? 1 : 4);
const adjForm = adjustId === c.id ? `<div class="adjust">
${alt ? `<div class="seg adjseg" role="tablist" aria-label="Enter dose in" style="grid-column:1/-1"><button type="button" role="tab" data-act="adj-mode" data-id="${c.id}" data-mode="${c.unit}" aria-selected="${mode === c.unit}">${c.unit}</button><button type="button" role="tab" data-act="adj-mode" data-id="${c.id}" data-mode="${alt}" aria-selected="${mode === alt}">${alt}</button></div>` : ''}
<div class="field"><label class="label" for="a-date">Starting on</label><input id="a-date" type="date" value="${dDate}"></div>
<div class="field"><label class="label" for="a-dose">New dose (${mode})</label><input id="a-dose" type="number" min="0" step="any" inputmode="decimal" value="${dVal}" data-id="${c.id}" data-mode="${mode}"></div>
<span class="hint" id="a-units" style="grid-column:1/-1">${dBase != null ? adjHint(c, dBase, mode) : ''}</span>
<div class="actions"><button class="btn" data-act="chg-save" data-id="${c.id}">Save dose change</button><button class="btn ghost" data-act="chg-cancel">Cancel</button><span class="err" id="a-err"></span></div>
</div>` : '';
const on = x => x ? ' on' : '';
const acts = `<div class="row-actions">${(s.status === 'active' || s.status === 'upcoming') && !isNasal(c) ? `<button class="link${on(adjustId === c.id)}" data-act="chg" data-id="${c.id}" aria-pressed="${adjustId === c.id}">Change dose</button>` : ''}<button class="link${on(cycId === c.id)}" data-act="cy" data-id="${c.id}" aria-pressed="${cycId === c.id}">Pause/End Cycle</button><button class="link" data-act="edit" data-id="${c.id}">Edit Cycle</button>${s.status === 'complete' ? `<button class="link" data-act="dup" data-id="${c.id}">Repeat</button>` : ''}<button class="link del${on(confirmId === c.id)}" data-act="del" data-id="${c.id}" aria-pressed="${confirmId === c.id}">Delete</button></div>`
+ (confirmId === c.id ? `<div class="confirm">Delete this cycle? This can’t be undone. <button class="btn dangerfill" data-act="del-yes" data-id="${c.id}">Delete</button><button class="btn ghost" data-act="del-no">Keep</button></div>` : '');
return `<article class="cyc ${s.status}">
<div class="band"></div>
<div class="body">
<div class="top">
<div class="name">${esc(c.name)}</div>
<span class="pill ${s.status}">${s.status}</span>${s.status !== 'complete' ? `<button type="button" class="sharebtn" data-act="share" data-id="${c.id}" aria-label="Share ${esc(c.name)}" title="Share"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg></button>` : ''}
</div>
${todayBlock(c, s)}
<div class="prog">
${open_ ? '' : `<div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="fill" style="width:${pct}%"></div></div>`}
<div class="progtext"><span>${progL}</span><span>${progR}</span></div>
</div>
<div class="foot"><div class="footbtns"><button class="detbtn" data-act="det" data-id="${c.id}" aria-expanded="${open}">${open ? 'Hide detailed info' : 'Detailed info'}</button><button class="detbtn" data-act="notes" data-id="${c.id}" aria-expanded="${notesOpen.has(c.id)}">${notesOpen.has(c.id) ? 'Hide notes' : 'Notes' + ((c.notes || []).length ? ` (${c.notes.length})` : '')}</button><button class="detbtn" data-act="opts" data-id="${c.id}" aria-expanded="${optsOpen.has(c.id)}">${optsOpen.has(c.id) ? 'Hide options' : 'Options'}</button></div></div>
${optsOpen.has(c.id) ? `<div class="cyopts">${acts}${cycId === c.id ? cyclePanel(c, s) : ''}${adjForm}</div>` : ''}
${open ? `<div class="details"><div class="grid">
<div class="kv"><span class="label">Start</span><b>${fmt(s.start)}</b></div>
<div class="kv"><span class="label">End${s.pausedDays && !s.endedEarly ? ' · moved' : ''}</span><b>${s.endedEarly ? fmt(parse(c.endedOn)) : open_ ? 'No end date' : fmt(s.end)}</b></div>
<div class="kv"><span class="label">Route</span><b>${ROUTES[routeOf(c)][1]}</b></div>
${isNasal(c) ? `<div class="kv"><span class="label">Spray</span><b>${num(c.spMl)} mL each · ${num(c.bacMl)} mL bottle</b></div>` : ''}
<div class="kv"><span class="label">Length</span><b>${open_ ? 'Open-ended' : `${c.lenValue} ${c.lenUnit === 'weeks' ? (c.lenValue==1?'wk':'wks') : (c.lenValue==1?'day':'days')}`}</b></div>
${c.noRepeat && !offDaysOf(c) ? '<div class="kv"><span class="label">Repeat</span><b>No plan to repeat</b></div>' : ''}${offDaysOf(c) ? `<div class="kv"><span class="label">Off-cycle after</span><b>${c.offValue} ${c.offUnit === 'days' ? (c.offValue == 1 ? 'day' : 'days') : (c.offValue == 1 ? 'wk' : 'wks')}</b></div>` : ''}
<div class="kv"><span class="label">Schedule${(c.perDay||1)>1 ? ' · '+c.perDay+'×/day' : ''}</span>${c.interval > 1 ? '<b>Every other day</b>' : `<div class="wk">${wk}</div>`}</div>
</div>
${lifeLine}</div>` + detailsBlock(c, s) : ''}
${notesOpen.has(c.id) ? notesBlock(c) : ''}
</div>
</article>`;
}
function esc(s){ return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function resetForm(){
editingId = null; doseSource = 'mg';
$('form').reset();
$('f-start').value = iso(today());
$('f-len').value = 8; $('f-lenunit').value = 'weeks'; $('f-unit').value = 'mg'; $('f-off').value = ''; $('f-offunit').value = 'weeks'; $('f-norep').checked = false; syncNoRep(); selRoute = 'subq'; $('n-bottle').value = 10; $('n-spray').value = 0.1; $('n-sprays').value = 1; $('n-mg').value = ''; syncRoute();
selDays = new Set([1,2,3,4,5]); selEvery = 0; renderDays();
$('f-perday').value = '1'; syncLen(); syncPremix();
titSteps = []; renderSteps();
syncTit(); updateCalc();
$('formTitle').textContent = 'New cycle'; $('submitBtn').textContent = 'Save'; clearDup();
$('cancelBtn').hidden = false; $('err').textContent = '';
}
function fillForm(c, asNew){
clearDup();
$('f-name').value = c.name;
$('f-start').value = asNew ? (isOpen(c) && !c.endedOn ? iso(today()) : iso(addDays(stats(c).end, 1) > today() ? addDays(stats(c).end,1) : today())) : c.start;
$('f-len').value = c.lenValue ?? 8; $('f-lenunit').value = c.lenUnit; $('f-off').value = c.offValue > 0 ? c.offValue : ''; $('f-offunit').value = c.offUnit || 'weeks'; $('f-norep').checked = !!c.noRepeat; syncNoRep();
selRoute = routeOf(c);
if (isNasal(c)){ $('n-bottle').value = c.bacMl ?? 10; $('n-spray').value = c.spMl ?? 0.1; $('n-sprays').value = c.dose != null && c.spMl > 0 ? Math.max(1, Math.round(c.dose / (2 * c.spMl))) : 1; $('n-mg').value = c.vialMg > 0 ? c.vialMg : ''; }
else { $('n-bottle').value = 10; $('n-spray').value = 0.1; $('n-sprays').value = 1; $('n-mg').value = ''; } syncLen();
$('f-dose').value = c.dose ?? ''; $('f-unit').value = c.unit;
selDays = new Set(c.days); selEvery = c.interval > 1 ? c.interval : 0; renderDays();
$('f-premix').checked = !!c.premixed;
if (c.premixed){ $('f-pml').value = c.bacMl ?? ''; $('f-pconc').value = c.vialMg > 0 && c.bacMl > 0 ? +(c.vialMg / c.bacMl).toFixed(6) : ''; $('f-vial').value = ''; $('f-bac').value = ''; }
else { $('f-vial').value = c.vialMg ?? ''; $('f-bac').value = c.bacMl ?? ''; $('f-pml').value = ''; $('f-pconc').value = ''; }
syncPremix();
$('f-tit').checked = !!c.titrate; $('f-perday').value = String(c.perDay || 1);
{
const rows = (c.plan||[]).map(p => p.week != null ? {kind: 'week', week: p.week, dose: p.dose}
: asNew ? {kind: 'week', week: Math.floor(idxOfDate(c, parse(p.date)) / 7) + 1, dose: p.dose}
: {kind: 'date', date: p.date, dose: p.dose});
titSteps = asNew ? rows.filter((r, i) => r.week >= 2 && !rows.slice(i + 1).some(x => x.week === r.week)) : rows;
}
if (!asNew && titSteps.length) $('f-tit').checked = true;
renderSteps();
syncTit(); updateCalc();
syncRoute();
editingId = asNew ? null : c.id;
$('formTitle').textContent = asNew ? 'Repeat cycle' : 'Edit cycle';
$('submitBtn').textContent = 'Save';
$('cancelBtn').hidden = false; $('err').textContent = '';
$('f-name').focus({preventScroll:true});
}
$('form').addEventListener('submit', async e => {
e.preventDefault();
const name = $('f-name').value.trim();
const start = $('f-start').value;
const lenValue = parseInt($('f-len').value, 10);
const doseRaw = $('f-dose').value.trim();
const dose = doseRaw === '' ? null : parseFloat(doseRaw);
if (!name) return $('err').textContent = 'Enter the peptide name.';
if (!start) return $('err').textContent = 'Pick a start date.';
const openLen = $('f-lenunit').value === 'open';
if (!openLen && !(lenValue > 0)) return $('err').textContent = 'Cycle length must be at least 1.';
if (!selEvery && !selDays.size) return $('err').textContent = 'Select at least one day of the week.';
if (dose != null && !(dose >= 0)) return $('err').textContent = 'Dose must be a number.';
const noRepeat = $('f-norep').checked, offRaw = $('f-off').value.trim(), offValue = offRaw === '' || openLen || noRepeat ? null : parseInt(offRaw, 10);
if (offValue != null && !(offValue >= 0)) return $('err').textContent = 'Off-cycle length must be a whole number, or leave it blank.';
const optNum = id => { const v = $(id).value.trim(); return v === '' ? null : parseFloat(v); };
const nasal = selRoute === 'nasal';
let nas = null;
if (nasal){
const bottle = parseFloat($('n-bottle').value), sp = parseFloat($('n-spray').value), n = parseInt($('n-sprays').value, 10), mgRaw = $('n-mg').value.trim(), mg = parseFloat(mgRaw);
if (!(bottle > 0)) return $('err').textContent = 'Enter the bottle size in mL.';
if (!(sp > 0)) return $('err').textContent = 'Enter how many mL each spray delivers.';
if (!(n > 0)) return $('err').textContent = 'Enter sprays per nostril (at least 1).';
if (mgRaw !== '' && !(mg > 0)) return $('err').textContent = 'Peptide in bottle must be a number, or leave it blank.';
nas = {route: 'nasal', spMl: sp, unit: 'mL', dose: +(n * 2 * sp).toFixed(6), bacMl: bottle, vialMg: mg > 0 ? mg : null, premixed: true, titrate: false, plan: []};
}
const fv = formVial(), premixed = $('f-premix').checked;
if (!nasal && fv.partial) return $('err').textContent = premixed ? 'Enter both the vial size in mL and the concentration, or leave both blank.' : 'Enter both vial size and BAC water, or leave both blank.';
const vialMg = fv.mg, bacMl = fv.ml;
const titrate = !nasal && $('f-tit').checked;
let plan = [];
if (titrate){
if (dose == null) return $('err').textContent = 'Enter a starting dose to titrate from.';
if (!titSteps.length) return $('err').textContent = 'Add at least one titration line, or turn titration off.';
const len = formLen();
let prev = 0;
for (let i = 0; i < titSteps.length; i++){
const r = titSteps[i], x = rowIdx(r);
if (x == null) return $('err').textContent = `Titration line ${i+1} needs a ${r.kind === 'week' ? 'week' : 'date'}.`;
if (r.dose == null || !(r.dose >= 0)) return $('err').textContent = `Titration line ${i+1} needs a dose.`;
if (x <= prev) return $('err').textContent = `Titration line ${i+1} must start after line ${i || 'the start'}.`;
if (x >= len) return $('err').textContent = `Titration line ${i+1} starts after the cycle ends.`;
prev = x;
plan.push(r.kind === 'week' ? {week: r.week, dose: r.dose} : {date: r.date, dose: r.dose});
}
}
const existing = editingId && cycles.find(c => c.id === editingId);
{ // one-time check: another cycle of this compound is already in use
const key = name.toLowerCase();
const clash = cycles.find(x => x.id !== editingId && String(x.name).trim().toLowerCase() === key && stats(x).status !== 'complete');
if (clash && dupAck !== key){
dupAck = key;
const st = stats(clash);
$('dupWarn').innerHTML = `<b>You already have ${st.status === "active" ? "an active" : st.status === "upcoming" ? "an upcoming" : "a paused"} ${esc(clash.name)} cycle</b><span>${st.status === 'upcoming' ? 'Starts' : 'Started'} ${fmt(st.start)}${isOpen(clash) ? ' · open-ended' : ' · ends ' + fmt(st.end)}. Saving adds a second cycle of the same compound. Tap <b>Save anyway</b> to keep both, or Cancel.</span>`;
$('dupWarn').hidden = false; $('submitBtn').textContent = 'Save anyway';
$('dupWarn').scrollIntoView({block: 'nearest', behavior: 'smooth'});
return;
}
}
const c = { ...(existing || {}), id: editingId || ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2,6)),
offValue: offValue > 0 ? offValue : null, offUnit: $('f-offunit').value, noRepeat,
name, start, lenValue: openLen ? null : lenValue, lenUnit: $('f-lenunit').value, days: selEvery ? [0,1,2,3,4,5,6] : [...selDays].sort(), interval: selEvery || null,
dose, unit: $('f-unit').value, perDay: parseInt($('f-perday').value, 10) || 1, vialMg, bacMl, premixed: premixed && vialMg != null,
titrate, plan,
pauses: existing ? (existing.pauses||[]) : [], endedOn: existing ? (existing.endedOn ?? null) : null,
created: existing ? existing.created : Date.now() };
if (nas) Object.assign(c, nas); else { c.route = selRoute; delete c.spMl; }
$('submitBtn').disabled = true;
try {
await store.save(c);
const i = cycles.findIndex(x => x.id === c.id);
if (i >= 0) cycles[i] = normalize(c); else cycles.push(normalize(c));
resetForm(); setView(prevView === 'add' ? 'home' : prevView);
} catch (err) {
$('err').textContent = err && err.code === 'quota_exceeded'
? 'Storage is full. Delete some old cycles and try again.'
: offMsg('Couldn\'t save. Check your connection and try again.');
} finally { $('submitBtn').disabled = false; }
});
$('cancelBtn').onclick = () => { resetForm(); setView(prevView === 'add' ? 'home' : prevView); };
function syncTit(){
const on = $('f-tit').checked;
$('titBox').hidden = !on;
$('doseLabel').textContent = on ? 'Starting dose' : 'Dose';
if (on && !titSteps.length) addRow('week', true);
document.querySelectorAll('.unitEcho').forEach(el => el.textContent = $('f-unit').value);
updateDeltas();
}
const formLen = () => {
if ($('f-lenunit').value === 'open'){ const st = $('f-start').value; return (st ? Math.max(diff(parse(st), today()), 0) : 0) + OPEN_AHEAD; }
const v = parseInt($('f-len').value, 10) || 0; return $('f-lenunit').value === 'weeks' ? v * 7 : v;
};
function syncNoRep(){ const n = $('f-norep').checked; $('f-off').disabled = n; $('f-offunit').disabled = n; if (n) $('f-off').value = ''; $('offHint').textContent = n ? 'This cycle won’t be offered again when it ends. You can still use Repeat on it later.' : 'Optional break before the next round. You confirm before it starts.'; }
$('f-norep').addEventListener('change', syncNoRep);
function syncLen(){ const o = $('f-lenunit').value === 'open'; $('offField').hidden = o; $('f-len').hidden = o; $('f-lenunit').hidden = o; $('f-open').checked = o; $('openNote').hidden = !o; }
$('f-open').addEventListener('change', () => { const sel = $('f-lenunit'); sel.value = $('f-open').checked ? 'open' : 'weeks'; if (!$('f-open').checked && !(parseInt($('f-len').value, 10) > 0)) $('f-len').value = 8; sel.dispatchEvent(new Event('change', {bubbles: true})); });
$('f-lenunit').addEventListener('change', syncLen);
function rowIdx(s){
if (s.kind === 'week') return s.week ? (s.week - 1) * 7 : null;
const st = $('f-start').value;
return s.date && st ? diff(parse(st), parse(s.date)) : null;
}
function bounds(i){
let lo = 0, hi = formLen();
for (let k = i - 1; k >= 0; k--){ const x = rowIdx(titSteps[k]); if (x != null){ lo = x; break; } }
for (let k = i + 1; k < titSteps.length; k++){ const x = rowIdx(titSteps[k]); if (x != null){ hi = x; break; } }
return {lo, hi};
}
function weekRangeFor(i){ const {lo, hi} = bounds(i); return {mn: Math.floor(lo / 7) + 2, mx: Math.ceil(hi / 7)}; }
function dateRangeFor(i){
const st = $('f-start').value; if (!st) return null;
const {lo, hi} = bounds(i);
return {mn: iso(addDays(parse(st), lo + 1)), mx: iso(addDays(parse(st), hi - 1))};
}
function clampRow(i){
const s = titSteps[i];
if (s.kind === 'week'){
const {mn, mx} = weekRangeFor(i);
if (mx < mn) return 'No full week fits between the lines around this one. Use a date instead.';
if (!(s.week >= mn && s.week <= mx)){
s.week = Math.min(Math.max(Math.round(s.week) || mn, mn), mx);
return mn === mx ? `Only Wk ${mn} fits here.` : `Pick a week from ${mn} to ${mx}. Set to Wk ${s.week}.`;
}
} else {
const r = dateRangeFor(i); if (!r) return 'Set the cycle start date first.';
if (r.mx < r.mn) return 'No days fit between the lines around this one.';
if (!s.date || s.date < r.mn || s.date > r.mx){
s.date = !s.date || s.date < r.mn ? r.mn : r.mx;
return `Pick a date from ${fmt(parse(r.mn))} to ${fmt(parse(r.mx))}.`;
}
}
return '';
}
function prevDose(i){
for (let k = i - 1; k >= 0; k--) if (titSteps[k].dose != null) return titSteps[k].dose;
const d0 = parseFloat($('f-dose').value); return d0 >= 0 ? d0 : null;
}
function renderSteps(msgs = {}){
const unit = esc($('f-unit').value);
const d0 = $('f-dose').value;
const head = `<div class="steprow head"><span class="stepno">0</span><span class="when">Start · Wk 1</span><span class="arrow">→</span><span class="startdose">${d0 !== '' ? esc(d0) + ' ' + unit : 'set starting dose above'}</span></div>`;
$('stepRows').innerHTML = head + titSteps.map((s, i) => {
const wr = weekRangeFor(i), dr = dateRangeFor(i);
const when = s.kind === 'week'
? `<input type="number" step="1" inputmode="numeric" data-k="week" min="${wr.mn}" max="${wr.mx}" value="${s.week ?? ''}" aria-label="Line ${i+1} week">`
: `<input type="date" data-k="date" ${dr ? `min="${dr.mn}" max="${dr.mx}"` : ''} value="${s.date ?? ''}" aria-label="Line ${i+1} date">`;
return `<div class="steprow" data-i="${i}">
<span class="stepno">${i + 1}</span>
<select data-k="kind" aria-label="Line ${i+1} starts by"><option value="week"${s.kind === 'week' ? ' selected' : ''}>Week</option><option value="date"${s.kind === 'date' ? ' selected' : ''}>Date</option></select>
${when}
<span class="arrow">→</span>
<div class="inline dosein"><input type="number" min="0" step="any" inputmode="decimal" data-k="dose" value="${s.dose ?? ''}" placeholder="0.5" aria-label="Line ${i+1} dose"><span class="suffix unitEcho">${unit}</span></div>
<span class="delta" data-delta="${i}"></span>
<button type="button" class="link del" data-rm="${i}" aria-label="Delete line ${i+1}">×</button>
<span class="rowmsg" role="alert">${esc(msgs[i] || '')}</span>
</div>`;
}).join('');
updateDeltas();
}
function updateDeltas(){
const unit = $('f-unit').value;
titSteps.forEach((s, i) => {
const el = document.querySelector(`[data-delta="${i}"]`); if (!el) return;
const p = prevDose(i);
if (s.dose == null || p == null) { el.textContent = ''; el.className = 'delta'; return; }
const dlt = +(s.dose - p).toFixed(6);
el.textContent = dlt === 0 ? 'no change' : `${dlt > 0 ? '+' : '−'}${num(Math.abs(dlt))} ${unit}`;
el.className = 'delta ' + (dlt > 0 ? 'up' : dlt < 0 ? 'down' : '');
});
const sd = document.querySelector('.startdose');
if (sd) sd.textContent = $('f-dose').value !== '' ? `${$('f-dose').value} ${unit}` : 'set starting dose above';
previewSteps();
}
function previewSteps(){
const d0 = parseFloat($('f-dose').value), st = $('f-start').value, unit = $('f-unit').value;
if (!$('f-tit').checked || !(d0 >= 0) || !titSteps.length){ $('stepPreview').textContent = ''; return; }
const parts = [`Wk 1: ${num(d0)}`];
titSteps.forEach(s => {
if (s.dose == null) return;
if (s.kind === 'week' && s.week) parts.push(`Wk ${s.week}: ${num(s.dose)}`);
else if (s.kind === 'date' && s.date && st) parts.push(`${fmt(parse(s.date))}: ${num(s.dose)}`);
});
$('stepPreview').textContent = parts.join('  →  ') + ' ' + unit;
}
function addRow(kind, silent){
const last = titSteps[titSteps.length - 1];
const lastIdx = last ? rowIdx(last) : 0;
if (last && lastIdx == null){ $('titMsg').textContent = 'Finish the last line before adding another.'; return; }
const len = formLen(), st = $('f-start').value;
const row = {kind, dose: last ? last.dose : (parseFloat($('f-dose').value) >= 0 ? parseFloat($('f-dose').value) : null)};
if (kind === 'week'){
row.week = Math.floor(lastIdx / 7) + 2;
if ((row.week - 1) * 7 >= len){ if (!silent) $('titMsg').textContent = 'No weeks left in this cycle. Increase the cycle length to add more.'; return; }
} else {
if (!st){ $('titMsg').textContent = 'Set the cycle start date first.'; return; }
const minIdx = Math.max(lastIdx + 1, diff(parse(st), today()));
if (minIdx >= len){ $('titMsg').textContent = 'No days left in this cycle. Increase the cycle length to add more.'; return; }
row.date = iso(addDays(parse(st), minIdx));
}
$('titMsg').textContent = '';
titSteps.push(row);
renderSteps();
if (!silent){ const ins = $('stepRows').querySelectorAll('[data-k="dose"]'); ins[ins.length - 1].focus(); ins[ins.length - 1].select(); }
}
$('stepRows').addEventListener('input', e => {
const row = e.target.closest('.steprow[data-i]'); if (!row) return;
if (e.target.dataset.k !== 'dose') return;
const v = e.target.value;
titSteps[+row.dataset.i].dose = v === '' ? null : parseFloat(v);
updateDeltas();
});
$('stepRows').addEventListener('change', e => {
const row = e.target.closest('.steprow[data-i]'); if (!row) return;
const i = +row.dataset.i, s = titSteps[i], k = e.target.dataset.k, v = e.target.value;
if (k === 'kind'){
const idx = rowIdx(s), st = $('f-start').value;
s.kind = v;
if (v === 'date') s.date = idx != null && st ? iso(addDays(parse(st), idx)) : null;
else s.week = idx != null ? Math.floor(idx / 7) + 1 : null;
} else if (k === 'week') s.week = v === '' ? null : parseInt(v, 10);
else if (k === 'date') s.date = v || null;
else return;
const msg = clampRow(i);
renderSteps(msg ? {[i]: msg} : {});
});
$('stepRows').addEventListener('click', e => {
const b = e.target.closest('[data-rm]'); if (!b) return;
titSteps.splice(+b.dataset.rm, 1);
$('titMsg').textContent = '';
renderSteps();
});
$('addStep').onclick = () => addRow('week');
$('addSet').onclick = () => addRow('date');
['f-start','f-len','f-lenunit'].forEach(id => $(id).addEventListener('change', () => { if ($('f-tit').checked) renderSteps(); }));
function updateCalc(){
const fv = formVial(), v = fv.mg, b = fv.ml, d = parseFloat($('f-dose').value);
syncUnitsField();
const unit = $('f-unit').value;
if (!(v > 0 && b > 0)) { $('calc').innerHTML = ''; return; }
const conc = v / b;
const parts = [`Concentration <b>${num(+conc.toFixed(3))} mg/mL</b>`, `${num(+(conc/10).toFixed(4))} mg per 10 units`];
if (d > 0){
if (unit === 'units' || unit === 'mL'){
const mg = unit === 'units' ? d / 100 * conc : d * conc;
parts.push(`${num(d)} ${unit} = <b>${num(+mg.toFixed(3))} mg</b>${unit === 'mL' ? ` (${+(d*100).toFixed(1)} units)` : ''}`);
parts.push(`~${Math.floor(v / mg)} doses per vial`);
} else if (unit === 'mg' || unit === 'mcg'){
const units = (unit === 'mcg' ? d/1000 : d) / conc * 100;
parts.push(`${num(d)} ${unit} = <b>${+units.toFixed(1)} units</b> on a U-100 syringe`);
if (units > 100) parts.push('Over 1 mL: use less BAC water or split the dose');
else parts.push(`~${Math.floor(b*100/units)} doses per vial`);
} else parts.push('IU doses cannot be converted to mg or syringe units');
}
$('calc').innerHTML = parts.map(p => `<span>${p}</span>`).join('');
updateVials();
}
function draftCycle(){
const existing = editingId && cycles.find(c => c.id === editingId);
const optNum = id => { const v = $(id).value.trim(); return v === '' ? null : parseFloat(v); };
const titrate = $('f-tit').checked;
const plan = titrate ? titSteps.filter(r => r.dose != null && r.dose >= 0 && rowIdx(r) != null && rowIdx(r) > 0 && rowIdx(r) < formLen())
.map(r => r.kind === 'week' ? {week: r.week, dose: r.dose} : {date: r.date, dose: r.dose}) : [];
return normalize({start: $('f-start').value, lenValue: parseInt($('f-len').value, 10) || 0, lenUnit: $('f-lenunit').value,
days: selEvery ? [0,1,2,3,4,5,6] : [...selDays], interval: selEvery || null, perDay: parseInt($('f-perday').value, 10) || 1, dose: optNum('f-dose'), unit: $('f-unit').value,
vialMg: formVial().mg, bacMl: formVial().ml, titrate, plan,
pauses: existing ? existing.pauses : [], endedOn: existing ? existing.endedOn : null});
}
function updateVials(){
const el = $('vialsNeed');
const fv = formVial(), v = fv.mg, b = fv.ml, unit = $('f-unit').value;
if (!(v > 0 && b > 0)) { el.hidden = true; return; }
el.hidden = false;
const c = draftCycle();
if (!c.start || !(isOpen(c) || c.lenValue > 0) || !c.days.length || c.dose == null){
el.innerHTML = `<span class="label">Vials needed</span><div class="vn">—</div><span class="tx">Fill in start date, length, days, and dose to see how many vials to have on hand.</span>`;
return;
}
if (mgOf(c, 1) == null){
el.innerHTML = `<span class="label">Vials needed</span><div class="vn">—</div><span class="tx">IU doses cannot be converted to mg, so vials cannot be counted.</span>`;
return;
}
const life = vialLife(c, 0);
const lifeTx = life ? `<span class="tx life">${vialLifeText(c, life, 'Starting on day 1, open the')}</span>` : '';
if (isOpen(c)){
if (!life || !life.doses){ el.innerHTML = `<span class="label">How long a vial lasts</span><div class="vn">—</div>${lifeTx}`; return; }
const span = life.next ? diff(life.from, life.next) : diff(life.from, life.last) + 1;
el.innerHTML = `<span class="label">How long one vial lasts</span>
<div class="vn">${span < 14 ? `${span} day${span === 1 ? '' : 's'}` : `${+(span / 7).toFixed(1)} weeks`}</div>
<span class="tx">${life.doses} dose${life.doses === 1 ? '' : 's'} per ${num(v)} mg vial at this schedule${c.plan.length ? ', following your titration' : ''}. Open the next vial around ${life.next ? fmt(life.next) : '—'}.</span>`;
return;
}
const s = stats(c), need = Math.ceil(s.vials - 1e-9);
const totalMg = s.totalMg;
el.innerHTML = `<span class="label">Vials needed before you start</span>
<div class="vn">${need} vial${need === 1 ? '' : 's'}</div>
<span class="tx">${num(+totalMg.toFixed(3))} mg over ${s.total} dose${s.total === 1 ? '' : 's'} ÷ ${num(v)} mg per vial = ${+s.vials.toFixed(2)} vials${need > s.vials + 1e-9 ? `, rounded up` : ''}</span>${lifeTx}`;
}
['f-vial','f-bac','f-pml','f-pconc'].forEach(id => $(id).addEventListener('input', () => { updateCalc(); previewSteps(); }));
let doseSource = 'mg';
$('f-dose').addEventListener('input', () => { doseSource = 'mg'; unitsFromDose(); updateCalc(); previewSteps(); });
$('f-premix').addEventListener('change', () => { syncPremix(); updateCalc(); updateVials(); });
$('f-units').addEventListener('input', () => { doseSource = 'units'; doseFromUnits(); updateCalc(); updateDeltas(); updateVials(); });
function doseFromUnits(){
const conc = formVial().conc, unit = $('f-unit').value, v = parseFloat($('f-units').value);
if (!(conc > 0) || !(v >= 0) || (unit !== 'mg' && unit !== 'mcg')) return;
const mg = v / 100 * conc;
$('f-dose').value = +(unit === 'mcg' ? mg * 1000 : mg).toFixed(4);
$('unitsEq').textContent = `= ${num(+(unit === 'mcg' ? mg * 1000 : mg).toFixed(4))} ${unit} \u00b7 1 unit = ${num(+(conc / 100 * (unit === 'mcg' ? 1000 : 1)).toFixed(4))} ${unit}`;
}
// vial in the form: reconstituted (mg + BAC mL) or premixed (mL x mg/mL); both give total mg and mL
function formVial(){
const n = id => { const x = $(id).value.trim(); return x === '' ? null : parseFloat(x); };
if ($('f-premix').checked){
const ml = n('f-pml'), conc = n('f-pconc');
if (ml == null && conc == null) return {mg: null, ml: null, conc: null, partial: false};
if (!(ml > 0) || !(conc > 0)) return {mg: null, ml: null, conc: null, partial: true};
return {mg: +(ml * conc).toFixed(6), ml, conc, partial: false};
}
const mg = n('f-vial'), ml = n('f-bac');
if (mg == null && ml == null) return {mg: null, ml: null, conc: null, partial: false};
if (!(mg > 0) || !(ml > 0)) return {mg: null, ml: null, conc: null, partial: true};
return {mg, ml, conc: mg / ml, partial: false};
}
function syncPremix(){
const p = $('f-premix').checked;
document.querySelectorAll('#form .recon').forEach(el => el.hidden = p);
document.querySelectorAll('#form .premix').forEach(el => el.hidden = !p);
syncUnitsField();
}
function syncUnitsField(){
const conc = formVial().conc, unit = $('f-unit').value, ok = $('f-premix').checked && conc > 0 && (unit === 'mg' || unit === 'mcg');
$('unitsField').hidden = !ok;
if (ok){
if (doseSource === 'units' && $('f-units').value !== '') doseFromUnits();
else { $('unitsEq').textContent = `1 unit = ${num(+(conc / 100 * (unit === 'mcg' ? 1000 : 1)).toFixed(4))} ${unit}`; if (document.activeElement !== $('f-units')) unitsFromDose(); }
}
}
function unitsFromDose(){
const conc = formVial().conc, unit = $('f-unit').value, d = parseFloat($('f-dose').value);
if (!(conc > 0) || (unit !== 'mg' && unit !== 'mcg')) return;
$('f-units').value = d >= 0 ? +((unit === 'mcg' ? d / 1000 : d) / conc * 100).toFixed(2) : '';
}
$('f-unit').addEventListener('change', () => { syncTit(); updateCalc(); });
$('f-tit').addEventListener('change', syncTit);
function clearDup(){ dupAck = null; $('dupWarn').hidden = true; $('submitBtn').textContent = 'Save'; }
$('f-name').addEventListener('input', () => { if (dupAck !== null) clearDup(); });
$('form').addEventListener('input', updateVials);
$('form').addEventListener('change', updateVials);
$('form').addEventListener('click', e => { if (e.target.closest('.day,[data-preset],[data-rm],#addStep,#addSet')) setTimeout(updateVials); });
document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
if (b.dataset.preset === 'eod'){ selEvery = 2; selDays = new Set([0,1,2,3,4,5,6]); }
else { selEvery = 0; selDays = new Set(b.dataset.preset.split(',').map(Number)); }
renderDays();
});
function setView(v, keepForm){
if (v === 'add' && view !== 'add') prevView = view;
if (v === 'add' && !keepForm) resetForm();
view = v; cycId = null; adjustId = null; confirmId = null; sheetId = null; vialSheetId = null;
document.querySelectorAll('#nav [data-view]').forEach(b => b.toggleAttribute('aria-current', b.dataset.view === v));
document.querySelectorAll('#nav [aria-current]').forEach(b => b.setAttribute('aria-current', 'page'));
gate();
window.scrollTo({top: 0});
if (v === 'add' && !keepForm) $('f-name').focus({preventScroll: true});
}
$('nav').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
$('fab').addEventListener('click', () => setView('add'));
$('list').addEventListener('click', e => { const b = e.target.closest('[data-nav]'); if (b) setView(b.dataset.nav); });
$('list').addEventListener('click', async e => { const b = e.target.closest('[data-shareall]'); if (!b) return; b.disabled = true;
try { const order = {active: 0, paused: 1, upcoming: 2}; await shareAll(cycles.map(c => ({c, s: stats(c)})).filter(x => x.s.status !== 'complete').sort((a, z) => order[a.s.status] - order[z.s.status] || a.s.start - z.s.start).map(x => x.c)); } catch (err) { console.error(err); } finally { b.disabled = false; } });
$('list').addEventListener('click', e => { const y = e.target.closest('[data-allyear]'); if (!y) return; allYear = parseInt(y.dataset.allyear, 10); try { localStorage.setItem('pcl-allyear', allYear); } catch {} renderList(); });
$('list').addEventListener('click', e => { const b = e.target.closest('[data-allmode]'); if (!b) return; allMode = b.dataset.allmode; try { localStorage.setItem('pcl-allmode', allMode); } catch {} renderList(); });
async function saveCycle(next, errId){
next = normalize(next);
try {
await store.save(next);
cycles = cycles.map(x => x.id === next.id ? next : x);
cycId = null; renderList();
} catch { const el = $(errId); if (el) el.textContent = offMsg('Couldn\'t save. Try again.'); }
}
$('list').addEventListener('click', async e => {
const b = e.target.closest('[data-act]'); if (!b) return;
const c = cycles.find(x => x.id === b.dataset.id);
if (b.dataset.act && b.dataset.act.startsWith('nx-')){
const act = b.dataset.act, msg = m => { const e = $('nx-err'); if (e) e.textContent = m; else $('sync').textContent = m; };
try {
if (act === 'nx-pick'){ nxPick = b.dataset.key; renderList(); const d = $('nx-date'); if (d) d.focus(); return; }
if (act === 'nx-cancel'){ nxPick = null; renderList(); return; }
if (act === 'nx-today'){ b.disabled = true; return await startNext(c, iso(today())); }
if (act === 'nx-go'){ const v = $('nx-date').value, o = offInfo(c);
if (!v) return msg('Pick the date you started.');
if (o && v < iso(o.from)) return msg(`Pick a date after the last round ended (${fmt(addDays(o.from, -1))}).`);
b.disabled = true; return await startNext(c, v); }
if (act === 'nx-snooze'){ await saveCycle({...c, snoozeUntil: iso(addDays(today(), 1))}, 'err'); return; }
if (act === 'nx-stop'){ await saveCycle({...c, noRepeat: true}, 'err'); return; }
} catch { b.disabled = false; msg(offMsg('Couldn\'t start the next round. Try again.')); }
return;
}
if (b.dataset.act === 'vsheet'){ vialSheetId = b.dataset.id; vialFresh = true; rfEdit.delete(b.dataset.id); renderList(); return; }
if (b.dataset.act === 'vsheet-close'){ vialSheetId = null; renderList(); return; }
if (b.dataset.act === 'sheet'){ [expanded, collapsed, notesOpen, optsOpen].forEach(st => st.delete(b.dataset.id)); sheetId = b.dataset.id; sheetFresh = true; cycId = null; adjustId = null; confirmId = null; renderList(); return; }
if (b.dataset.act === 'sheet-close'){ if (sheetId) [expanded, collapsed, notesOpen, optsOpen].forEach(st => st.delete(sheetId)); sheetId = null; adjConfirm = null; adjDraft = null; cycId = null; adjustId = null; confirmId = null; renderList(); return; }
if (b.dataset.act === 'row'){ const k = b.dataset.key; openRows.has(k) ? openRows.delete(k) : openRows.add(k); renderList(); return; }
switch (b.dataset.act){
case 'share': b.disabled = true; try { await shareCycle(c); } catch (e) { console.error(e); } finally { b.disabled = false; } break;
case 'opts': if (optsOpen.has(c.id)){ optsOpen.delete(c.id); if (adjustId === c.id) adjustId = null; if (cycId === c.id) cycId = null; if (confirmId === c.id) confirmId = null; } else optsOpen.add(c.id); renderList(); break;
case 'notes': notesOpen.has(c.id) ? notesOpen.delete(c.id) : notesOpen.add(c.id); renderList(); break;
case 'nt-add': {
const txt = $('nt-text-' + c.id).value.trim(), date = $('nt-date-' + c.id).value || iso(today());
if (!txt){ $('nt-err-' + c.id).textContent = 'Write a note first.'; break; }
const note = {id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2,5), date, at: new Date().toISOString(), text: txt};
await saveCycle({...c, notes: [...(c.notes || []), note]}, 'nt-err-' + c.id);
break;
}
case 'nt-del': await saveCycle({...c, notes: (c.notes || []).filter(n => n.id !== b.dataset.nid)}, 'nt-err-' + c.id); break;
case 'nt-txt': exportTxt(c); break;
case 'nt-pdf': b.disabled = true; try { await exportPdf(c); } catch { const e = $('nt-err-' + c.id); if (e) e.textContent = offMsg('Couldn\'t make the PDF. Try again.'); } finally { b.disabled = false; } break;
case 'det': {
const homeRunning = view === 'home' && ['active','paused'].includes(stats(c).status);
const set = homeRunning ? collapsed : expanded;
set.has(c.id) ? set.delete(c.id) : set.add(c.id); renderList(); break;
}
case 'cy': confirmId = null; adjustId = null; cycId = cycId === c.id ? null : c.id; renderList(); break;
case 'cy-cancel': cycId = null; renderList(); break;
case 'cy-pause': {
let from = $('cy-pause').value;
if (!from) { $('cy-err').textContent = 'Pick the date the pause starts.'; break; }
if (from < c.start) from = c.start;
await saveCycle({...c, pauses: [...(c.pauses||[]).filter(p => p.to), {from, to: null}]}, 'cy-err');
break;
}
case 'cy-resume': {
const r = $('cy-resume').value;
if (!r) { $('cy-err').textContent = 'Pick the date you resume.'; break; }
const pauses = (c.pauses||[]).map(p => {
if (p.to) return p;
const to = iso(addDays(parse(r), -1));
return to < p.from ? null : {from: p.from, to};
}).filter(Boolean);
await saveCycle({...c, pauses}, 'cy-err');
break;
}
case 'cy-end': {
const d = $('cy-end').value;
if (!d) { $('cy-err').textContent = 'Pick the date the cycle ends.'; break; }
const pauses = (c.pauses||[]).map(p => {
if (p.to) return p;
const to = iso(addDays(parse(d), -1));
return to < p.from ? null : {from: p.from, to};
}).filter(Boolean);
await saveCycle({...c, pauses, endedOn: d}, 'cy-err');
break;
}
case 'refill': {
const d = $('rf-' + c.id).value, err = $('rf-err-' + c.id);
if (!d) { err.textContent = 'Pick the date you opened the new vial.'; break; }
if (d < c.start) { err.textContent = 'Pick a date on or after the cycle started.'; break; }
let mg = c.vialMg, ml = c.bacMl;
if (rfEdit.has(c.id)){
const a = parseFloat($('rf-a-' + c.id).value), bb = parseFloat($('rf-b-' + c.id).value);
if (isNasal(c)){ if (!(a > 0)) { err.textContent = 'Enter the bottle size in mL.'; break; } ml = a; mg = bb > 0 ? bb : null; }
else {
if (!(a > 0) || !(bb > 0)) { err.textContent = c.premixed ? 'Enter the vial size in mL and the concentration.' : 'Enter the vial size in mg and the BAC water in mL.'; break; }
if (c.premixed){ ml = a; mg = a * bb; } else { mg = a; ml = bb; }
}
}
const changed = Math.abs(mg - c.vialMg) > 1e-9 || Math.abs(ml - c.bacMl) > 1e-9;
// keep earlier vials at the size they were before this change
const old = (c.refills || []).filter(r => rDate(r) !== d).map(r => typeof r === 'string' ? {date: r, mg: c.vialMg, ml: c.bacMl} : r);
const next = {...c, refills: [...old, {date: d, mg, ml}].sort((x, y) => x.date.localeCompare(y.date))};
if (changed){ next.vial0 = c.vial0 || {mg: c.vialMg, ml: c.bacMl}; next.vialMg = mg; next.bacMl = ml; }
rfEdit.delete(c.id);
await saveCycle(next, 'rf-err-' + c.id);
if ((cycles.find(x => x.id === c.id)?.refills || []).some(r => rDate(r) === d)){ vialSheetId = null; renderList(); }
break;
}
case 'refill-rm': await saveCycle({...c, refills: (c.refills || []).filter(r => rDate(r) !== b.dataset.date)}, 'err'); break;
case 'rf-change': rfEdit.has(c.id) ? rfEdit.delete(c.id) : rfEdit.add(c.id); renderList(); break;
case 'cy-reopen': await saveCycle({...c, endedOn: null}, 'cy-err'); break;
case 'pause-rm': {
const i = +b.dataset.i;
await saveCycle({...c, pauses: (c.pauses||[]).filter((_, k) => k !== i)}, 'err');
break;
}
case 'chg': confirmId = null; cycId = null; adjDraft = null; adjMode = c.unit; if (adjustId === c.id){ adjustId = null; renderList(); break; } adjustId = c.id; renderList(); { const el = $('a-dose'); if (el){ el.focus(); el.select(); } } break;
case 'chg-cancel': adjustId = null; renderList(); break;
case 'adj-mode': {
const v = parseFloat($('a-dose').value), from = $('a-dose').dataset.mode || c.unit;
adjDraft = {id: c.id, date: $('a-date').value, base: v >= 0 ? toBase(c, v, from) : null};
adjMode = b.dataset.mode; renderList(); break;
}
case 'chg-save': {
const date = $('a-date').value, v = $('a-dose').value.trim(), val = parseFloat(v), mode = $('a-dose').dataset.mode || c.unit;
if (!date) { $('a-err').textContent = 'Pick the date the new dose starts.'; break; }
if (v === '' || !(val >= 0)) { $('a-err').textContent = 'Enter the new dose.'; break; }
const base = +toBase(c, val, mode).toFixed(6);
adjDraft = {id: c.id, date, base};
adjConfirm = {id: c.id, date, base}; renderList(); break;
}
case 'adj-back': adjConfirm = null; renderList(); break;
case 'adj-confirm': {
const {date, base: dose} = adjConfirm;
const ni = idxOfDate(c, parse(date));
const plan = [...(c.plan||[]).filter(p => planIdx(c, p) !== ni), {date, dose}].sort((a,b) => planIdx(c, a) - planIdx(c, b));
const next = {...c, titrate: true, plan};
delete next.every; delete next.step; delete next.limit; delete next.dir;
b.disabled = true;
try { await store.save(next); cycles = cycles.map(x => x.id === c.id ? normalize(next) : x); adjustId = null; adjConfirm = null; adjDraft = null; renderList(); }
catch { b.disabled = false; const e = $('cfm-err'); if (e) e.textContent = offMsg('Couldn\'t save. Try again.'); }
break;
}
case 'chg-rm': {
const next = {...c, changes: (c.changes||[]).filter(x => x.date !== b.dataset.date)};
delete next.every; delete next.step; delete next.limit; delete next.dir;
try { await store.save(next); cycles = cycles.map(x => x.id === c.id ? normalize(next) : x); renderList(); }
catch { $('err').textContent = offMsg('Couldn\'t remove that change. Try again.'); }
break;
}
case 'edit': confirmId = null; adjustId = null; setView('add', true); fillForm(c, false); break;
case 'dup':  confirmId = null; setView('add', true); fillForm(c, true); break;
case 'del':  adjustId = null; cycId = null; confirmId = confirmId === c.id ? null : c.id; renderList(); break;
case 'del-no': confirmId = null; renderList(); break;
case 'del-yes':
try { await store.remove(c.id); cycles = cycles.filter(x => x.id !== c.id); }
catch { $('err').textContent = offMsg('Couldn\'t delete. Try again.'); }
confirmId = null; if (editingId === c.id) resetForm(); renderList(); break;
}
});
$('list').addEventListener('input', e => {
if (e.target.id !== 'a-dose') return;
const c = cycles.find(x => x.id === e.target.dataset.id), v = parseFloat(e.target.value), mode = e.target.dataset.mode || (c && c.unit);
$('a-units').textContent = c && v >= 0 ? adjHint(c, toBase(c, v, mode), mode) : '';
});
const SB_URL = 'https://ojxscacnyybvtxffbere.supabase.co';
const SB_KEY = 'sb_publishable_bo2h1xqaDYMqEaFNdQwNKA_dcfA_T9h';
let sb = null, sessionUser = null, phase = 'loading', linkError = '';
const alertRow = msg => { const el = document.querySelector('#list .phead p'); if (el) el.textContent = msg; };
function gate(){
$('loading').hidden = phase !== 'loading';
$('signin').hidden = phase !== 'signin';
if (phase === 'signin' && linkError){ $('siErr').textContent = linkError; linkError = ''; }
const need = phase === 'profile' || (editingProfile && (phase === 'app' || phase === 'waiting'));
$('onboard').hidden = !need;
$('waiting').hidden = phase !== 'waiting' || need;
const app = phase === 'app' && !need;
$('nav').hidden = !app; $('fab').hidden = !app || view === 'add';
$('listSec').hidden = !app || view === 'add';
$('form').hidden = !app || view !== 'add';
const out = sessionUser ? `<button type="button" class="link" id="signOut">Sign out</button>` : '';
if (profile){
$('whoami').hidden = false;
$('whoami').innerHTML = `@${esc(profile.telegram)}<button type="button" class="link" id="editProfile">Edit profile</button>${out}`;
} else if (sessionUser){
$('whoami').hidden = false; $('whoami').innerHTML = `${esc(sessionUser.email || '')}${out}`;
} else $('whoami').hidden = true;
if (need){
$('obTitle').textContent = profile ? 'Your profile' : 'Welcome';
$('obSub').textContent = profile ? 'Update your name or Telegram username.' : 'Before you start, tell us who you are.';
$('obSubmit').textContent = profile ? 'Save' : 'Continue';
$('obCancel').hidden = !profile;
}
if (phase === 'waiting'){
const blocked = profile && profile.status === 'blocked', paused = profile && profile.status === 'paused';
$('waitTitle').textContent = blocked ? 'Access removed' : paused ? 'Access paused' : 'Waiting for approval';
$('waitSub').textContent = blocked
? 'Your access to this app has been removed. Contact the person who shared it with you.'
: paused ? 'Your access is paused for now. Your cycles are saved and will be here when it\'s turned back on.'
: `Thanks${profile ? ', ' + profile.name : ''}. The app owner needs to approve you before you can start. Check back soon.`;
}
$('navTesters').hidden = !isOwner;
const pend = (testers || []).filter(t => t.status === 'pending').length;
{ const t = $('navTesters'); t.querySelector('span').textContent = 'Testers'; let d = t.querySelector('.ndot'); if (pend){ if (!d){ d = document.createElement('i'); d.className = 'ndot'; t.appendChild(d); } d.textContent = pend; } else if (d) d.remove(); }
renderList();
}
// one-time "What's new" pop-up per user (remembered on the account, so it shows once across devices)
const WN_ID = '2026-10-18b', WN_SINCE = '2026-10-18';
const WN_HTML = `<h2 class="wn-title">What’s new</h2><p class="wn-sub">New features added Oct 18, 2026</p>
<ul>
<li><b>Every other day</b> schedule option</li>
<li><b>Off-cycle</b> length on each compound, with an <b>Off-Cycle</b> tab showing breaks and expected restart dates</li>
<li>A <b>“Ready to start again?”</b> banner when a break ends. Nothing restarts without your OK, and you can start now and backdate the start date.</li>
<li>Red <b>Needs attention</b> banner for compounds missing key info, with a Fix button</li>
<li>One-time warning before adding a second active cycle of the same compound</li>
<li>Date-stamped <b>Notes</b> on each compound, exportable as a text file or PDF</li>
<li><b>Options</b> button that groups Change dose, Pause/End Cycle, Edit Cycle and Delete</li>
<li><b>Change dose</b> lets you enter mg or syringe units and asks you to confirm before saving</li>
<li>Tap a vial to open a pop-up for starting a new one, with a check of the vial size and BAC water (change it if the new vial is different)</li>
<li><b>Timeline</b> view in All: pick a year to see the compounds used each month</li>
<li><b>Share</b> a compound as a styled image with dose, frequency, dates and titration</li>
<li><b>Share all</b> current compounds in one image from the Current tab</li>
<li>Light/dark mode toggle (top right)</li>
</ul>`;
let wnShown = false;
function maybeWhatsNew(){
if (wnShown || !sessionUser || !profile) return;
const key = 'pcl-wn-' + sessionUser.id;
let local = null; try { local = localStorage.getItem(key); } catch {}
const meta = (sessionUser.user_metadata || {}).whatsNew;
if (local === WN_ID || meta === WN_ID) return;
if (profile.created && profile.created >= Date.parse(WN_SINCE + 'T07:00:00Z')) { try { localStorage.setItem(key, WN_ID); } catch {} return; } // brand-new accounts skip it
wnShown = true;
const el = document.createElement('div');
el.className = 'sheet-wrap anim wn';
el.innerHTML = `<div class="sheet-bg" data-wn-close></div><div class="sheet" role="dialog" aria-modal="true" aria-label="What’s new"><div class="sheet-bar"><button type="button" class="sheet-x" data-wn-close aria-label="Close">\u2715</button></div><div class="wn-body">${WN_HTML}<div class="actions"><button type="button" class="btn" data-wn-close>Got it</button></div></div></div>`;
document.body.appendChild(el); document.documentElement.classList.add('sheet-open');
el.addEventListener('click', e => {
if (!e.target.closest('[data-wn-close]')) return;
el.remove(); if (!sheetId) document.documentElement.classList.remove('sheet-open');
try { localStorage.setItem(key, WN_ID); } catch {}
try { const r = sb.auth.updateUser && sb.auth.updateUser({data: {whatsNew: WN_ID}}); if (r && r.catch) r.catch(() => {}); } catch {}
});
}
async function loadAll(){
const cache = readCache();
let fromCache = false;
if (phase !== 'app' && cache && hasAuthToken()){
sessionUser = {id: cache.uid, email: cache.email}; profile = cache.profile; isOwner = cache.isOwner;
cycles = (cache.cycles || []).map(normalize); fromCache = true;
$('sync').textContent = 'Updating…'; phase = 'app'; gate();
} else if (phase !== 'app'){ phase = 'loading'; gate(); }
const offline = () => {
if (phase === 'app'){ $('sync').textContent = 'Offline · showing saved copy'; return; }
phase = 'loading'; gate();
$('loading').hidden = false;
$('loading').innerHTML = `Couldn't reach the server. <button type="button" class="link" id="retryLoad">Try again</button>`;
};
try {
const { data: { session }, error: se } = await sb.auth.getSession();
if (!session && se && fromCache) return offline();
sessionUser = session ? session.user : null;
if (!sessionUser){ clearCache(); profile = null; cycles = []; isOwner = false; phase = 'signin'; return gate(); }
const { data: prof, error } = await sb.from('profiles').select('name,telegram,status,is_admin,created_at').eq('id', sessionUser.id).maybeSingle();
if (error) throw error;
profile = prof ? {name: prof.name, telegram: prof.telegram, status: prof.status, isAdmin: prof.is_admin, created: Date.parse(prof.created_at)} : null;
isOwner = !!(profile && profile.isAdmin);
if (!profile){ clearCache(); phase = 'profile'; return gate(); }
if (profile.status !== 'approved'){ clearCache(); phase = 'waiting'; return gate(); }
const { data: rows, error: e2 } = await sb.from('cycles').select('id,data').order('updated_at');
if (e2) throw e2;
cycles = (rows || []).map(r => normalize({...r.data, id: r.id}));
if (isOwner) loadTesters();
$('sync').textContent = 'Synced to your account';
phase = 'app'; gate(); writeCache(); maybeWhatsNew();
} catch (err) {
offline();
}
}
document.addEventListener('click', e => { if (e.target.id === 'retryLoad') loadAll(); });
store = {
save: async c => {
const { error } = await sb.from('cycles').upsert({id: c.id, user_id: sessionUser.id, data: c, updated_at: new Date().toISOString()});
if (error) throw error;
},
remove: async id => { const { error } = await sb.from('cycles').delete().eq('id', id); if (error) throw error; },
saveProfile: async pr => {
const q = profile
? sb.from('profiles').update({name: pr.name, telegram: pr.telegram}).eq('id', sessionUser.id)
: sb.from('profiles').insert({id: sessionUser.id, name: pr.name, telegram: pr.telegram});
const { error } = await q; if (error) throw error;
},
};
async function loadTesters(){
const { data, error } = await sb.from('profiles').select('id,name,telegram,status,is_admin,created_at').order('created_at', {ascending: false});
if (error) return;
testers = data.map(r => ({id: r.id, name: r.name, telegram: r.telegram, status: r.status, joined: Date.parse(r.created_at), you: r.id === sessionUser.id}));
gate();
}
let delId = null;
$('list').addEventListener('click', async e => {
const ask = e.target.closest('[data-tdelask]'), no = e.target.closest('[data-tdelno]'), yes = e.target.closest('[data-tdel]');
if (ask){ delId = ask.dataset.tdelask; return renderList(); }
if (no){ delId = null; return renderList(); }
if (yes){
yes.disabled = true;
const id = yes.dataset.tdel;
const r1 = await sb.from('cycles').delete().eq('user_id', id);
const r2 = r1.error ? r1 : await sb.from('profiles').delete().eq('id', id);
delId = null;
if (r2.error){ renderList(); alertRow('Couldn\'t delete. Try again.'); return; }
return loadTesters();
}
const b = e.target.closest('[data-tact]'); if (!b) return;
b.disabled = true;
const { error } = await sb.from('profiles').update({status: b.dataset.tact}).eq('id', b.dataset.id);
if (error) { b.disabled = false; return; }
loadTesters();
});
$('siForm').addEventListener('submit', async e => {
e.preventDefault();
const email = $('si-email').value.trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return $('siErr').textContent = 'Enter a valid email address.';
$('siErr').textContent = ''; $('siSubmit').disabled = true;
const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
$('siSubmit').disabled = false;
if (error){ $('siErr').textContent = /rate/i.test(error.message) ? 'Too many sign-in emails just now. Wait a few minutes and try again.' : 'Couldn\'t send the link. Try again.'; return; }
$('siSent').hidden = false;
$('siSent').textContent = `${(navigator.standalone || matchMedia('(display-mode: standalone)').matches) ? `Check ${email} and type the code below. (Links open in your browser, not in this app.)` : `Check ${email}. Tap the link once, or type the code below. If the link opens inside your email app, use the code instead.`}`;
$('codeField').hidden = false; $('codeActions').hidden = false;
try { localStorage.setItem('pcl-email', email); } catch {}
});
$('waitRefresh').onclick = () => loadAll();
$('siVerify').onclick = async () => {
const email = $('si-email').value.trim(), token = $('si-code').value.replace(/\D/g, '');
if (!email) return $('siErr').textContent = 'Enter your email first.';
if (token.length < 6 || token.length > 10) return $('siErr').textContent = 'Enter the full code from the email.';
$('siErr').textContent = ''; $('siVerify').disabled = true;
const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
$('siVerify').disabled = false;
if (error) $('siErr').textContent = 'That code didn\'t work. It may have expired or been used. Send a new one.';
};
$('obForm').addEventListener('submit', async e => {
e.preventDefault();
const name = $('ob-name').value.trim();
const tg = $('ob-tg').value.trim().replace(/^@+/, '');
if (!name) return $('obErr').textContent = 'Enter your name.';
if (!/^[A-Za-z0-9_]{5,32}$/.test(tg)) return $('obErr').textContent = 'Telegram usernames are 5–32 characters: letters, numbers, and underscores.';
$('obErr').textContent = ''; $('obSubmit').disabled = true;
try { await store.saveProfile({name, telegram: tg}); editingProfile = false; await loadAll(); }
catch { $('obErr').textContent = 'Couldn\'t save. Check your connection and try again.'; }
finally { $('obSubmit').disabled = false; }
});
$('ob-tg').addEventListener('input', e => { if (e.target.value.startsWith('@')) e.target.value = e.target.value.replace(/^@+/, ''); });
$('obCancel').onclick = () => { editingProfile = false; gate(); };
document.querySelector('header').addEventListener('click', async e => {
if (e.target.id === 'signOut'){ clearCache(); await sb.auth.signOut(); phase = 'loading'; view = 'home'; testers = null; return loadAll(); }
if (e.target.id !== 'editProfile') return;
editingProfile = true;
$('ob-name').value = profile.name; $('ob-tg').value = profile.telegram; $('obErr').textContent = '';
gate(); $('ob-name').focus();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && isOwner && phase === 'app') loadTesters(); });
async function init(){
resetForm();
{
const h = new URLSearchParams(location.hash.slice(1)), q = new URLSearchParams(location.search);
const ec = h.get('error_code') || q.get('error_code'), ed = h.get('error_description') || q.get('error_description');
if (ec || ed){
linkError = ec === 'otp_expired' || /expired|invalid/i.test(ed || '') ? 'That sign-in link has already been used or has expired. Send a new one, or use the code from the newest email.' : `Sign-in didn't finish: ${ed || ec}. Send a new link and try again.`;
history.replaceState(null, '', location.pathname);
}
try { const em = localStorage.getItem('pcl-email'); if (em) $('si-email').value = em; } catch {}
}
if (!window.supabase){ $('loading').textContent = 'Couldn\'t load the app. Check your connection and refresh.'; return; }
sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'implicit' } });
sb.auth.onAuthStateChange(evt => { if (evt === 'SIGNED_IN' || evt === 'SIGNED_OUT') setTimeout(loadAll); });
loadAll();
document.addEventListener('keydown', e => { if (e.key === 'Escape' && vialSheetId){ vialSheetId = null; renderList(); return; } if (e.key === 'Escape' && sheetId){ [expanded, collapsed, notesOpen, optsOpen].forEach(st => st.delete(sheetId)); sheetId = null; adjConfirm = null; adjDraft = null; renderList(); } });
// light / dark toggle: remembers the choice on this device; otherwise follows the phone setting
(function themeToggle(){
const btn = $('themeBtn'), mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
const cur = () => document.documentElement.getAttribute('data-theme') || (mq && mq.matches ? 'dark' : 'light');
const sync = () => { const t = cur(); btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'); btn.dataset.mode = t;
document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', t === 'dark' ? '#0f1115' : '#f3f3f6')); };
btn.addEventListener('click', () => { const t = cur() === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('pcl-theme', t); } catch {} sync(); });
if (mq && mq.addEventListener) mq.addEventListener('change', sync);
sync();
})();
window.addEventListener('online', () => { if (phase === 'app') loadAll(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
// pull-to-refresh for the installed (home-screen) app, which has no browser reload gesture
(function pullToRefresh(){
const standalone = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
if (!standalone) return;
const el = document.createElement('div'); el.className = 'ptr'; el.innerHTML = '<span class="ptr-spin"></span>';
document.body.appendChild(el);
const MAX = 110, TRIGGER = 70;
let y0 = null, dy = 0, busy = false;
const set = (h, ready) => { el.style.transform = `translate(-50%, ${h - 50}px)`; el.style.opacity = Math.min(h / TRIGGER, 1); el.classList.toggle('ready', !!ready); el.firstChild.style.transform = `rotate(${h * 4}deg)`; };
window.addEventListener('touchstart', e => {
if (busy || window.scrollY > 0 || e.touches.length !== 1) { y0 = null; return; }
if (e.target.closest('input,select,textarea,.sheet') || document.documentElement.classList.contains('sheet-open')) { y0 = null; return; }
y0 = e.touches[0].clientY; dy = 0; el.style.transition = 'none';
}, {passive: true});
window.addEventListener('touchmove', e => {
if (y0 == null) return;
dy = e.touches[0].clientY - y0;
if (dy <= 0 || window.scrollY > 0) { set(0); return; }
const h = Math.min(MAX, dy * 0.5);
set(h, h >= TRIGGER);
}, {passive: true});
window.addEventListener('touchend', () => {
if (y0 == null) return;
const h = Math.min(MAX, dy * 0.5); y0 = null;
el.style.transition = 'transform .2s, opacity .2s';
if (h >= TRIGGER){ busy = true; el.classList.add('spinning'); set(TRIGGER, true); setTimeout(() => location.reload(), 250); }
else set(0);
}, {passive: true});
})();
})();
