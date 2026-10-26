/* Pinella – app per i telefoni (master e giocatori), collegata alle API PHP. */
(() => {
'use strict';

// ===================================================================
// Costanti
// ===================================================================
const TEAM_COLORS = ['#FF6B57', '#18C2B0', '#FFC22E', '#A48BFF', '#3AA0FF', '#FF8FC7'];
const TEAM_NAMES  = ['Corallo', 'Turchese', 'Sole', 'Lavanda', 'Cielo', 'Fragola'];
// Ordine di visualizzazione: prima i formati a squadre, poi quelli a singoli
const FORMATS = {
  '1v1': [1, 1], '2v2': [2, 2], '3v3': [3, 3], '2v2v2': [2, 2, 2],
  '3x1': [1, 1, 1], '4x1': [1, 1, 1, 1], '5x1': [1, 1, 1, 1, 1],
};
const FORMAT_LABEL = { '1v1': '1 vs 1', '2v2': '2 vs 2', '3v3': '3 vs 3', '2v2v2': '2 · 2 · 2', '3x1': '3 singoli', '4x1': '4 singoli', '5x1': '5 singoli', custom: 'personalizzata' };
const MOODS = [
  { label: 'disperato', bg: '#B9C6E8', mouth: 'M8 21 Q14 14 20 21', brows: 'M7 9 L12 7.4 M16 7.4 L21 9', tear: true },
  { label: 'teso',      bg: '#FFD0C2', mouth: 'M9 19 Q14 16.5 19 19', brows: 'M7.5 8.6 L11.5 7.6 M16.5 7.6 L20.5 8.6' },
  { label: 'neutro',    bg: '#E4DEFF', mouth: 'M10 18 L18 18' },
  { label: 'contento',  bg: '#9FEBE1', mouth: 'M9 17 Q14 21.5 19 17' },
  { label: 'euforico',  bg: '#FFE08A', mouth: 'M8 16 Q14 24 20 16 Z', fill: '#FFFFFF', happyEyes: true },
];
// Versione della PWA: aggiornata da tools/set_version.py insieme a server, index.html e sw.js
const APP_VERSION = '0.5.0';
const POLL_VISIBLE = 1500;
const POLL_HIDDEN = 10000;
const BOARD_W = 844, BOARD_H = 390;
const SLIDE_MS = 8000;        // durata di ogni vista del carosello
const SLIDE_HOLD_MS = 20000;  // dopo un tocco su una scheda, la vista resta ferma più a lungo

// ===================================================================
// Archivio locale (chiavi con prefisso "pinella:" per non toccare quelle di Gruzzolo)
// ===================================================================
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('pinella:' + k)); } catch (e) { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem('pinella:' + k); else localStorage.setItem('pinella:' + k, JSON.stringify(v)); } catch (e) { /* ignora */ } },
};

// ===================================================================
// Stato dell'app
// ===================================================================
const A = {
  session: store.get('session'),          // { code, token, playerId, isMaster }
  state: null, etag: null,
  view: 'home',                           // home | setup | code | join | game
  summary: null, joinTeam: null,
  setup: store.get('setup') || { format: '2v2v2', target: 1500 },
  drafts: {}, entry: false,
  slide: 0, slideAt: Date.now(), pauseUntil: 0,
  carouselPaused: !!store.get('carouselPaused'),   // pausa del carosello, ricordata sul dispositivo
  banner: null, err: '', notice: '', busy: false, offline: false,
  confirmFinish: false, hideRotate: false, sentAt: 0, clear: [],
  newVersion: null,                       // versione del server, se diversa da APP_VERSION
  toast: null,                            // { text, until }: avviso breve in alto
  dealerPick: null,                       // primo mazziere scelto dal master in sala d'attesa
  dealerOpen: false,                      // pannello di correzione del mazziere sul tabellone
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtPts = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
const val = (id) => (document.getElementById(id)?.value || '').trim();
class UserError extends Error {}
const fail = (m) => { throw new UserError(m); };

// ===================================================================
// API
// ===================================================================
async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (A.session && A.session.token) headers['X-Player-Token'] = A.session.token;
  let r;
  try {
    r = await fetch('api' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch (e) {
    fail('Connessione assente: riprova');
  }
  checkVersion(r);
  let data = null;
  try { data = await r.json(); } catch (e) { /* risposta vuota */ }
  if (!r.ok) {
    const err = new UserError((data && data.message) || `Errore ${r.status}`);
    err.status = r.status; err.code = data && data.error;
    throw err;
  }
  return data;
}
const gpath = (p = '') => `/games/${A.session.code}${p}`;

// Il server dichiara la sua versione in ogni risposta: se è cambiata (nuovo deploy
// mentre l'app era aperta) si propone di ricaricare. Restituisce true se è una novità.
function checkVersion(r) {
  const v = r.headers.get('X-Pinella-Version');
  if (!v || v === APP_VERSION || v === A.newVersion) return false;
  A.newVersion = v;
  return true;
}

// ===================================================================
// Sessione e polling
// ===================================================================
function setSession(s) {
  A.session = s; store.set('session', s);
  A.state = null; A.etag = null; A.drafts = {}; A.entry = false;
}
function endSession(msg) {
  setSession(null);
  clearTimeout(pollTimer);
  A.view = 'home'; A.err = msg || '';
  render();
}

let pollTimer = null, polling = false, pollAgain = false;
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!A.session) return;
  pollTimer = setTimeout(poll, document.hidden ? POLL_HIDDEN : POLL_VISIBLE);
}
function pollNow() { clearTimeout(pollTimer); poll(); }
async function poll() {
  if (!A.session) return;
  if (polling) { pollAgain = true; return; }
  polling = true;
  const code = A.session.code;
  try {
    const headers = { Accept: 'application/json', 'X-Player-Token': A.session.token };
    if (A.etag) headers['If-None-Match'] = A.etag;
    const r = await fetch(`api/games/${code}/state`, { headers, cache: 'no-store' });
    const wasOffline = A.offline;
    A.offline = false;
    if (checkVersion(r) && r.status === 304) render();
    if (!A.session || A.session.code !== code) { /* sessione cambiata nel frattempo */ }
    else if (r.status === 304) { if (wasOffline) render(); }
    else if (r.ok) { A.etag = r.headers.get('ETag'); applyState(await r.json()); }
    else if (r.status === 404) { polling = false; endSession('Questa partita non esiste più'); return; }
    else if (wasOffline) render();
  } catch (e) {
    if (!A.offline) { A.offline = true; render(); }
  }
  polling = false;
  if (pollAgain) { pollAgain = false; poll(); return; }
  schedulePoll();
}

function applyState(s) {
  if (!s) return;
  if (!s.me) { endSession('Non fai più parte di questa partita'); return; }
  // Rivincita: chi era nella vecchia partita ci entra con lo stesso token
  if (s.status === 'finished' && s.rematch_code && s.rematch_code !== A.session.code) {
    A.session = { ...A.session, code: s.rematch_code };
    store.set('session', A.session);
    A.state = null; A.etag = null; A.drafts = {};
    A.notice = 'Rivincita! Siete di nuovo in sala d\'attesa';
    pollNow();
    return;
  }
  const prev = A.state;
  if (prev && prev.code === s.code && s.status === 'playing' && s.hands.length > prev.hands.length) bannerAfterClose(s);
  if (prev && prev.code === s.code) handChanged(prev, s);
  if (prev && prev.status !== 'playing' && s.status === 'playing') { A.slide = 0; A.slideAt = Date.now(); A.notice = ''; }
  if (s.me.is_master !== A.session.isMaster) { A.session = { ...A.session, isMaster: s.me.is_master }; store.set('session', A.session); }
  A.state = s;
  A.view = 'game';
  if (s.status !== 'playing') { A.entry = false; A.dealerOpen = false; }
  render();
  if (s.me.is_master && s.status === 'playing') requestWakeLock();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { if (A.session) pollNow(); requestWakeLock(); }
});
window.addEventListener('online', () => { if (A.session) pollNow(); });

// ===================================================================
// Valori derivati (classifica, andamento, umore)
// ===================================================================
const teamLabel = (t) => (t.size === 1 && t.players.length ? t.players[0].name : t.name);
// Giocatore per id, con il colore della sua squadra (serve per il mazziere)
function playerById(s, id) {
  for (const t of s.teams) {
    const p = t.players.find((x) => x.id === id);
    if (p) return { ...p, color: t.color };
  }
  const u = s.unassigned.find((x) => x.id === id);
  return u ? { ...u, color: '#8A84B0' } : null;
}
const playerName = (s, id) => { const p = playerById(s, id); return p ? p.name : '?'; };
// Il giro del mazzo a partire da un giocatore
function orderFrom(s, startId) {
  const o = s.dealer_order || [];
  const i = o.indexOf(startId);
  return i < 0 ? o : [...o.slice(i), ...o.slice(0, i)];
}
function derive(s) {
  const teams = [...s.teams].sort((a, b) => a.id - b.id);
  const ids = teams.map((t) => t.id);
  const byId = {}; s.teams.forEach((t) => { byId[t.id] = t; });
  const run = {}, series = {};
  ids.forEach((i) => { run[i] = 0; series[i] = [0]; });
  const history = s.hands.map((h) => {
    const row = {};
    ids.forEach((i) => { const p = h.scores[String(i)] ?? 0; row[i] = p; run[i] += p; series[i].push(run[i]); });
    return { number: h.number, scores: row };
  });
  const totals = {}, ranks = {};
  s.teams.forEach((t) => { totals[t.id] = t.total; ranks[t.id] = t.rank; });
  const leaderTotal = Math.max(...ids.map((i) => totals[i]));
  const leaders = ids.filter((i) => totals[i] === leaderTotal);
  const d = { teams, ids, byId, series, history, totals, ranks, leaderTotal, uniqueLeader: leaders.length === 1 ? leaders[0] : null,
              order: s.teams.map((t) => t.id), last: history[history.length - 1] || null };
  d.moods = moods(s, d);
  return d;
}
// Umore = posizione in classifica (45%) + distacco dal primo (30%) + andamento delle ultime 2 mani (25%)
function moods(s, d) {
  const n = d.ids.length, m = {};
  d.ids.forEach((i) => {
    if (s.status === 'finished') {
      m[i] = s.winner_team_id === i ? 4 : d.ranks[i] === n ? 0 : (n > 2 && d.ranks[i] === 2 ? 2 : 1);
      return;
    }
    if (!d.history.length) { m[i] = 2; return; }
    const pos = n > 1 ? 1 - (d.ranks[i] - 1) / (n - 1) : 1;
    const gap = 1 - Math.min((d.leaderTotal - d.totals[i]) / (s.target_score * 0.3), 1);
    const recent = d.history.slice(-2);
    const mine = recent.reduce((acc, h) => acc + h.scores[i], 0);
    const avg = recent.reduce((acc, h) => acc + Object.values(h.scores).reduce((a, b) => a + b, 0) / n, 0);
    const trend = Math.max(-1, Math.min(1, (mine - avg) / (s.target_score * 0.1))) * 0.5 + 0.5;
    const sc = 0.45 * pos + 0.3 * gap + 0.25 * trend;
    m[i] = sc >= 0.8 ? 4 : sc >= 0.6 ? 3 : sc >= 0.4 ? 2 : sc >= 0.22 ? 1 : 0;
  });
  return m;
}
function badgesFor(s, tid) {
  return s.events.filter((e) => e.team_id === tid).map((e) =>
    e.type === 'overtake' ? { t: 'SORPASSO!', alt: false } :
    e.type === 'best_hand' ? { t: 'MANO RECORD', alt: true } :
    { t: `a ${e.to_target} dal traguardo`, alt: true });
}
function bannerAfterClose(s) {
  const byId = {}; s.teams.forEach((t) => { byId[t.id] = t; });
  const last = s.hands[s.hands.length - 1];
  const ov = s.events.find((e) => e.type === 'overtake');
  const best = s.events.find((e) => e.type === 'best_hand');
  const near = s.events.find((e) => e.type === 'near_target');
  const sub = ov ? `Sorpasso di ${teamLabel(byId[ov.team_id])}!`
    : best ? `Mano record: ${fmtPts(best.points)} per ${teamLabel(byId[best.team_id])}`
    : near ? `${teamLabel(byId[near.team_id])} a ${near.to_target} dal traguardo` : '';
  const dealer = s.current_hand && s.current_hand.dealer_player_id;
  A.banner = { title: `Mano ${last.number} chiusa`, sub, deal: dealer ? `Ora dà le carte ${playerName(s, dealer)}` : '', until: Date.now() + 2800 };
  if (!A.carouselPaused) { A.slide = 0; A.slideAt = Date.now(); }
}

// La mano su cui si stava lavorando non è più quella aperta (chiusa dagli inserimenti
// degli altri, annullata dal master o partita finita): si chiude il pannello del master
// e si scarta l'inserimento a metà, così i punti non finiscono nella mano sbagliata.
function handChanged(prev, s) {
  const before = prev.status === 'playing' && prev.current_hand ? prev.current_hand.number : null;
  const after = s.status === 'playing' && s.current_hand ? s.current_hand.number : null;
  if (before == null || before === after) return;
  const who = s.me.is_master ? 'm' : 'p';
  const dr = A.drafts[who];
  const lost = !!(dr && dr.digits !== '');
  if (dr) { dr.digits = ''; dr.neg = false; dr.closed = false; dr.team = null; }
  const wasOpen = A.entry;
  A.entry = false;
  if (s.status !== 'playing') return;              // partita finita: c'è già la schermata finale
  const what = after > before ? `Mano ${before} chiusa` : `Il master ha riaperto la mano ${after}`;
  // sul tabellone l'annuncio grande dice già "Mano N chiusa": basta spiegare cosa è successo ai punti
  if (lost) { showToast(s.me.is_master ? 'I punti che stavi scrivendo non sono stati inviati' : `${what}: i punti che stavi scrivendo non sono stati inviati`); return; }
  if (A.toast && A.toast.keep && Date.now() < A.toast.until) return;  // non coprire l'avviso di invio rifiutato
  else if (!s.me.is_master) {                      // sul tabellone c'è già l'annuncio
    const myDeal = after > before && s.current_hand.dealer_player_id === s.me.player_id;
    showToast(myDeal ? `${what}: tocca a te dare le carte` : what);
  }
  else if (wasOpen && after < before) showToast(what);
}
function showToast(text, keep = false) { A.toast = { text, keep, until: Date.now() + 4000 }; }

// ===================================================================
// Pezzi grafici
// ===================================================================
function face(mood, px) {
  const M = MOODS[mood];
  const eyes = M.happyEyes
    ? '<path d="M8 11.5 Q10 8.6 12 11.5 M16 11.5 Q18 8.6 20 11.5" fill="none" stroke="#1E1B3A" stroke-width="1.7" stroke-linecap="round"/>'
    : '<circle cx="10" cy="11.5" r="1.6" fill="#1E1B3A"/><circle cx="18" cy="11.5" r="1.6" fill="#1E1B3A"/>';
  const brows = M.brows ? `<path d="${M.brows}" fill="none" stroke="#1E1B3A" stroke-width="1.5" stroke-linecap="round"/>` : '';
  const tear = M.tear ? '<path d="M20.5 13.5 Q19.4 15.6 20.5 16.6 Q21.6 15.6 20.5 13.5 Z" fill="#3AA0FF"/>' : '';
  return `<svg width="${px}" height="${px}" viewBox="0 0 28 28" aria-hidden="true">${brows}${eyes}${tear}<path d="${M.mouth}" fill="${M.fill || 'none'}" stroke="#1E1B3A" stroke-width="1.8" stroke-linecap="round"/></svg>`;
}
function avatar(name, mood, color, size) {
  return `<div class="av" role="img" aria-label="${esc(name)}, umore ${MOODS[mood].label}" style="width:${size}px;height:${size}px;background:${MOODS[mood].bg};border-color:${color}">${face(mood, Math.round(size * 0.8))}</div>`;
}
const qrCache = {};
function qrSvg(text, px) {
  if (!qrCache[text]) {
    let rects = '', n = 25;
    try {
      const q = qrcode(0, 'M'); q.addData(text); q.make();
      n = q.getModuleCount();
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) rects += `<rect x="${c}" y="${r}" width="1.02" height="1.02"/>`;
    } catch (e) { rects = ''; }
    qrCache[text] = { rects, n };
  }
  const { rects, n } = qrCache[text];
  return `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" width="${px}" height="${px}" role="img" aria-label="QR code per entrare nella partita" style="border-radius:10px;flex-shrink:0"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><g fill="#1E1B3A">${rects}</g></svg>`;
}
const icon = {
  pause: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1.5"/><rect x="14" y="4" width="5" height="16" rx="1.5"/></svg>',
  play: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  undo: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  flag: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4h12l-2 4 2 4H5"/></svg>',
  close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  full: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  cards: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="11" height="15" rx="2" transform="rotate(-12 8.5 13.5)"/><rect x="10" y="3" width="11" height="15" rx="2" fill="currentColor" fill-opacity=".18"/></svg>',
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
};
const backBtn = (to) => `<button class="btn2" style="width:44px;padding:0;display:grid;place-items:center" data-act="go" data-arg="${to}" aria-label="Indietro">${icon.back}</button>`;
const errLine = () => `<p class="err" role="alert">${esc(A.err)}</p>`;
const verLine = () => `<p class="ver">Pinella v${APP_VERSION}</p>`;

// ===================================================================
// Schermate senza partita
// ===================================================================
function homeView() {
  return `<div class="ph center" style="gap:18px">
    <div class="logo big" aria-hidden="true">P</div>
    <h1 class="h1" style="font-size:42px">Pinella</h1>
    <p class="small" style="margin:0 0 10px;font-size:15px">Il tabellone per le vostre partite a carte</p>
    <div class="stack" style="width:100%;max-width:340px;gap:14px">
      <button class="btn" data-act="go" data-arg="setup">Crea una partita</button>
      <button class="btn sun" data-act="go" data-arg="code">Entra con un codice</button>
    </div>
    ${errLine()}
    ${verLine()}
  </div>`;
}

function setupView() {
  const fm = Object.keys(FORMATS).map((k) => {
    const on = A.setup.format === k;
    const groups = FORMATS[k].map((n, i) => `<span class="grp" style="background:${TEAM_COLORS[i]}">${'<i></i>'.repeat(n)}</span>`).join('');
    return `<button class="fmt${on ? ' on' : ''}" data-act="fmt" data-arg="${k}" aria-pressed="${on}"><span class="grps">${groups}</span>${FORMAT_LABEL[k]}</button>`;
  }).join('');
  const presets = [1000, 1500, 2000, 3000].map((v) => `<button class="pill${A.setup.target === v ? ' on' : ''}" data-act="targetSet" data-arg="${v}">${v}</button>`).join('');
  const sizes = FORMATS[A.setup.format];
  const teams = sizes.every((s) => s === 1)
    ? `<div class="trow"><span class="small">${sizes.length} giocatori, ognuno con il suo colore</span><span class="row" style="margin-left:auto;gap:5px">${sizes.map((_, i) => `<span class="sw" style="width:18px;height:18px;background:${TEAM_COLORS[i]}"></span>`).join('')}</span></div>`
    : sizes.map((s, i) => `<div class="trow"><span class="sw" style="background:${TEAM_COLORS[i]}"></span><span class="tname grow">${TEAM_NAMES[i]}</span><span class="small">${s} giocator${s === 1 ? 'e' : 'i'}</span></div>`).join('');
  return `<div class="ph">
    <div class="row">${backBtn('home')}<h1 class="h1">Nuova partita</h1></div>
    <div class="stack"><label class="lbl" for="setupName">Il tuo nome</label>
      <input class="input" id="setupName" maxlength="30" value="${esc(store.get('name') || '')}" autocomplete="given-name" enterkeyhint="go"></div>
    <div class="stack"><p class="lbl">Formato</p><div class="fmts">${fm}</div></div>
    <div class="stack"><p class="lbl">Punti per vincere</p>
      <div class="card stepper"><button data-act="target" data-arg="-100" aria-label="Diminuisci di 100">−</button><b>${A.setup.target}</b><button data-act="target" data-arg="100" aria-label="Aumenta di 100">+</button></div>
      <div class="pills">${presets}</div></div>
    <div class="stack"><p class="lbl">Squadre</p>${teams}</div>
    ${errLine()}
    <div class="grow"></div>
    <button class="btn" data-act="create" ${A.busy ? 'disabled' : ''}>${A.busy ? 'Creo la partita…' : 'Crea partita e mostra QR'}</button>
  </div>`;
}

function codeView() {
  return `<div class="ph">
    <div class="row">${backBtn('home')}<h1 class="h1">Entra in una partita</h1></div>
    <label class="lbl" for="codeInput">Codice partita</label>
    <input class="input code" id="codeInput" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" placeholder="····">
    <p class="small" style="margin:0">Il codice di 4 caratteri è sul telefono del master, sotto il QR.</p>
    ${errLine()}
    <div class="grow"></div>
    <button class="btn sun" data-act="codeNext" ${A.busy ? 'disabled' : ''}>Avanti</button>
  </div>`;
}

function joinView() {
  const s = A.summary;
  if (s.status === 'finished') {
    return `<div class="ph center"><h1 class="h1">Questa partita è finita</h1><p class="small">Chiedi al master il codice della nuova partita.</p><button class="btn2" data-act="go" data-arg="home">Torna all'inizio</button></div>`;
  }
  const avail = s.teams.filter((t) => t.taken < t.size);
  if (A.joinTeam == null || !avail.some((t) => t.id === A.joinTeam)) A.joinTeam = avail[0] ? avail[0].id : null;
  const teams = s.teams.map((t) => {
    const free = t.size - t.taken;
    const on = A.joinTeam === t.id;
    return `<button class="trow${on ? ' on' : ''}" style="min-height:54px" data-act="joinTeam" data-arg="${t.id}" ${free > 0 ? '' : 'disabled'} aria-pressed="${on}">
      <span class="sw" style="background:${esc(t.color)}"></span><span class="tname grow">${t.size === 1 ? (free ? 'Posto libero' : 'Occupato') : esc(t.name)}</span>
      <span class="small">${free > 0 ? (free === 1 ? '1 posto libero' : free + ' posti liberi') : 'completa'}</span></button>`;
  }).join('');
  return `<div class="ph">
    <div class="card" style="background:var(--lav);padding:14px 16px;display:flex;flex-direction:column;gap:3px">
      <span class="lbl" style="color:var(--ink)">Sei invitato!</span>
      <span class="h1" style="font-size:25px">La partita di ${esc(s.master_name)}</span>
      <span style="font-weight:800">${FORMAT_LABEL[s.format] || s.format} · si vince a ${s.target_score}${s.status === 'playing' ? ' · già in corso' : ''}</span>
    </div>
    <div class="stack"><label class="lbl" for="joinName">Il tuo nome</label>
      <input class="input" id="joinName" maxlength="30" value="${esc(store.get('name') || '')}" autocomplete="given-name" enterkeyhint="go"></div>
    <div class="stack"><p class="lbl">Scegli la squadra</p>${avail.length ? teams : '<p class="small">Tutte le squadre sono al completo.</p>'}</div>
    ${errLine()}
    <div class="grow"></div>
    <button class="btn sun" data-act="join" ${A.busy || !avail.length ? 'disabled' : ''}>${A.busy ? 'Entro…' : 'Entra nella partita'}</button>
    <button class="link" data-act="go" data-arg="home">Annulla</button>
  </div>`;
}

// ===================================================================
// Sala d'attesa
// ===================================================================
function playerChip(p, opts = {}) {
  return `<span class="pchip${p.is_master ? ' master' : ''}">${p.online ? '<i class="on" title="collegato"></i>' : ''}${esc(p.name)}${p.is_master ? ' ★' : ''}${p.has_device ? '' : ' · a mano'}${opts.kick ? `<button class="x" data-act="kick" data-arg="${p.id}" aria-label="Togli ${esc(p.name)}">×</button>` : ''}</span>`;
}

function masterLobby(s) {
  const teams = [...s.teams].sort((a, b) => a.id - b.id);
  const total = teams.reduce((acc, t) => acc + t.size, 0);
  const count = teams.reduce((acc, t) => acc + t.players.length, 0) + s.unassigned.length;
  const tiles = [...s.code].map((c, i) => `<span style="background:${TEAM_COLORS[i]}">${esc(c)}</span>`).join('');
  const myTeam = s.me.team_id;
  const rows = teams.map((t) => {
    const chips = t.players.map((p) => playerChip(p, { kick: !p.is_master })).join('')
      + '<span class="pchip free">libero</span>'.repeat(Math.max(0, t.size - t.players.length));
    return `<div class="trow"><span class="sw" style="background:${esc(t.color)}"></span><span class="tname" style="width:78px;flex-shrink:0">${t.size === 1 ? '' : esc(t.name)}</span><div class="chips">${chips}</div></div>`;
  }).join('');
  const unassigned = s.unassigned.length
    ? `<div class="trow"><span class="tname" style="width:110px;flex-shrink:0;font-size:14px">Senza squadra</span><div class="chips">${s.unassigned.map((p) => playerChip(p, { kick: !p.is_master })).join('')}</div></div>` : '';
  // Primo mazziere: lo sceglie il master tra i giocatori già in squadra
  const order = s.dealer_order || [];
  if (A.dealerPick != null && !order.includes(A.dealerPick)) A.dealerPick = null;
  const picks = order.map((id) => {
    const p = playerById(s, id);
    const on = A.dealerPick === id;
    return `<button class="pill dpill${on ? ' on' : ''}" data-act="dealerPick" data-arg="${id}" aria-pressed="${on}"><span class="sw" style="width:12px;height:12px;background:${esc(p.color)}"></span>${esc(p.name)}</button>`;
  }).join('');
  const giro = A.dealerPick != null && order.length > 1
    ? `<span class="small">Poi il mazzo gira verso destra: ${orderFrom(s, A.dealerPick).map((id) => esc(playerName(s, id))).join(' → ')}</span>`
    : `<span class="small">Il mazzo poi gira verso destra, alternando le squadre</span>`;
  const dealerBox = order.length
    ? `<div class="stack" style="gap:6px"><p class="lbl">Chi dà le carte nella prima mano?</p><div class="pills">${picks}</div>${giro}</div>` : '';
  const mine = teams.filter((t) => t.id !== myTeam && t.players.length < t.size)
    .map((t) => `<button class="btn2" data-act="myTeam" data-arg="${t.id}"><span class="sw" style="width:14px;height:14px;vertical-align:-2px;margin-right:6px;background:${esc(t.color)}"></span>${t.size === 1 ? 'Posto libero' : esc(t.name)}</button>`).join('');
  return `<div class="ph">
    <div class="row between"><h1 class="h1">Partita pronta!</h1><span class="small">${FORMAT_LABEL[s.format] || ''} · a ${s.target_score}</span></div>
    ${A.notice ? `<div class="notice">${esc(A.notice)}</div>` : ''}
    <div class="card codebox">${qrSvg(s.join_url, 168)}
      <div class="stack" style="gap:8px;min-width:0"><p class="lbl">Codice partita</p><div class="codetiles">${tiles}</div>
      <span class="small">Inquadra il QR o digita il codice su</span><span class="joinurl">${esc(s.join_url.replace(/\?join=.*$/, ''))}</span></div></div>
    <div class="row between"><p class="lbl">Chi c'è</p><span class="small">${count} di ${total}</span></div>
    <div class="stack" style="gap:6px">${rows}${unassigned}</div>
    ${mine ? `<div class="row wrap"><span class="small">Spostati in:</span>${mine}</div>` : ''}
    <div class="row"><label class="sr" for="manualName">Nome del giocatore da aggiungere a mano</label>
      <input class="input" id="manualName" maxlength="30" placeholder="Aggiungi a mano: nome" style="height:44px;font-size:16px" autocomplete="off" enterkeyhint="done">
      <button class="btn2" data-act="manual">Aggiungi</button></div>
    <div class="row wrap"><button class="btn2" data-act="shuffle">Sorteggia le squadre</button></div>
    ${dealerBox}
    ${errLine()}
    <div class="grow"></div>
    <button class="btn teal" data-act="start" ${A.busy || A.dealerPick == null ? 'disabled' : ''}>${A.dealerPick == null ? 'Scegli chi dà le carte' : 'Inizia la partita'}</button>
    <button class="link" data-act="leave">Esci (la partita resta aperta)</button>
    ${verLine()}
  </div>`;
}

function playerLobby(s) {
  const t = s.teams.find((x) => x.id === s.me.team_id);
  const master = [...s.teams.flatMap((x) => x.players), ...s.unassigned].find((p) => p.is_master);
  const others = [...s.teams].sort((a, b) => a.id - b.id).filter((x) => x.id !== s.me.team_id && x.players.length < x.size)
    .map((x) => `<button class="btn2" data-act="myTeam" data-arg="${x.id}"><span class="sw" style="width:14px;height:14px;vertical-align:-2px;margin-right:6px;background:${esc(x.color)}"></span>${x.size === 1 ? 'Posto libero' : esc(x.name)}</button>`).join('');
  const mates = t ? t.players.filter((p) => p.id !== s.me.player_id).map((p) => playerChip(p)).join('') : '';
  return `<div class="ph">
    <p class="lbl">Ciao ${esc(s.me.name)}</p>
    <h1 class="h1">Sei dentro!</h1>
    ${A.notice ? `<div class="notice">${esc(A.notice)}</div>` : ''}
    <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:10px">
      ${t ? `<div class="row"><span class="sw" style="width:34px;height:34px;background:${esc(t.color)}"></span><span class="tname" style="font-size:24px">${t.size === 1 ? 'Giochi da solo' : esc(t.name)}</span></div>
      ${t.size > 1 ? `<div class="chips">${mates || '<span class="small">Nessun compagno, per ora</span>'}</div>` : ''}` : '<span class="small">Il master ti assegnerà una squadra.</span>'}
    </div>
    ${others ? `<p class="lbl">Cambia squadra</p><div class="row wrap">${others}</div>` : ''}
    ${errLine()}
    <div class="grow"></div>
    <div class="sent">In attesa che ${esc(master ? master.name : 'il master')} inizi la partita…</div>
    <button class="link" data-act="leave">Esci da questa partita</button>
    ${verLine()}
  </div>`;
}

// ===================================================================
// Telefono del giocatore durante la partita
// ===================================================================
function draft(who) {
  if (!A.drafts[who]) A.drafts[who] = { digits: '', neg: false, closed: false, team: null };
  return A.drafts[who];
}
function signToggle(who, dr) {
  return `<div class="sign" role="group" aria-label="Segno">
    <button class="${dr.neg ? '' : 'on'}" data-act="sign" data-who="${who}" data-arg="+" aria-pressed="${!dr.neg}">+</button>
    <button class="${dr.neg ? 'on neg' : ''}" data-act="sign" data-who="${who}" data-arg="-" aria-pressed="${dr.neg}">−</button></div>`;
}
function keypad(who, layout) {
  return layout.map((k) => `<button data-act="key" data-who="${who}" data-arg="${k}" class="${k === 'del' ? 'alt' : ''}" aria-label="${k === 'del' ? 'Cancella' : k}">${k === 'del' ? '⌫' : k}</button>`).join('');
}

function playerPlay(s) {
  const d = derive(s);
  const t = d.byId[s.me.team_id];
  if (!t) return `<div class="ph center"><h1 class="h1">Non sei in nessuna squadra</h1><p class="small">Chiedi al master di aggiungerti.</p></div>`;
  const h = s.current_hand;
  const dr = draft('p');
  const mine = h.scores.find((x) => x.team_id === t.id);
  const status = d.teams.map((x) => {
    const sc = h.scores.find((y) => y.team_id === x.id);
    const done = sc && sc.points != null;
    return `<div><span class="sw" style="width:14px;height:14px;transform:none;background:${esc(x.color)}"></span><span class="grow">${esc(teamLabel(x))}${x.id === t.id ? ' (voi)' : ''}</span><span class="${done ? 'ok' : 'wait'}">${done ? `${fmtPts(sc.points)} · ${esc(sc.entered_by || '')}` : 'in attesa'}</span></div>`;
  }).join('');
  const sent = Date.now() - A.sentAt < 2500;
  const typed = dr.digits !== '';
  const label = sent ? 'Inviato!' : typed ? `Invia ${fmtPts((dr.neg ? -1 : 1) * Number(dr.digits))}` : (mine && mine.points != null) ? 'Inviato: digita per correggere' : 'Digita i punti';
  return `<div class="ph" style="gap:10px">
    <div class="row between"><div><p class="lbl">Mano ${h.number}</p><h1 class="h1" style="font-size:25px">Punti di ${esc(t.size === 1 ? s.me.name : t.name)}</h1></div>
      ${avatar(s.me.name, d.moods[t.id], t.color, 52)}</div>
    <div class="mini"><b>${t.total}</b><span class="small">${t.rank}° posto · mancano ${t.to_target}</span></div>
    ${dealerLine(s)}
    <div class="card display">${signToggle('p', dr)}<span class="num${typed ? '' : ' placeholder'}">${typed ? esc(dr.digits) : (mine && mine.points != null ? Math.abs(mine.points) : '0')}</span></div>
    <label class="check" style="background:var(--paper);border-radius:14px;padding:8px 12px"><input type="checkbox" data-act="closedT" data-who="p" ${dr.closed ? 'checked' : ''}><span class="grow">Abbiamo chiuso noi</span><span class="small">bonus incluso</span></label>
    <div class="keys">${keypad('p', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'del'])}</div>
    <div class="status">${status}</div>
    ${errLine()}
    <div class="grow"></div>
    <button class="btn" data-act="send" data-who="p" ${typed && !A.busy ? '' : 'disabled'}>${label}</button>
  </div>`;
}

function dealerLine(s) {
  const id = s.current_hand && s.current_hand.dealer_player_id;
  if (!id) return '';
  return id === s.me.player_id
    ? `<div class="deal me">${icon.cards}<b>Tocca a te dare le carte</b></div>`
    : `<div class="deal">${icon.cards}<span>Dà le carte <b>${esc(playerName(s, id))}</b></span></div>`;
}

function playerEnd(s) {
  const d = derive(s);
  const t = d.byId[s.me.team_id];
  const won = t && s.winner_team_id === t.id;
  const w = s.winner_team_id != null ? d.byId[s.winner_team_id] : null;
  const rows = d.order.map((tid) => { const x = d.byId[tid]; return `<div class="trow"><span class="small" style="width:22px">${x.rank}°</span><span class="sw" style="background:${esc(x.color)}"></span><span class="tname grow">${esc(teamLabel(x))}</span><b style="font:700 20px var(--display)">${x.total}</b></div>`; }).join('');
  return `<div class="ph" style="${won ? 'background:#FFF4D1' : ''}">
    ${t ? `<div style="align-self:center">${avatar(s.me.name, d.moods[t.id], t.color, 120)}</div>` : ''}
    <h1 class="h1" style="text-align:center;font-size:34px">${won ? 'Avete vinto!' : w ? `Vince ${esc(teamLabel(w))}` : 'Pareggio!'}</h1>
    <p class="lbl" style="text-align:center">Classifica finale</p>
    <div class="stack" style="gap:6px">${rows}</div>
    <div class="grow"></div>
    <div class="sent">Se il master lancia la rivincita, entri in automatico</div>
    <button class="link" data-act="leave">Esci da questa partita</button>
    ${verLine()}
  </div>`;
}

// ===================================================================
// Tabellone del master
// ===================================================================
function boardView(s) {
  const portrait = window.innerHeight > window.innerWidth;
  const hint = portrait && !A.hideRotate
    ? `<div class="rotate" role="status">Gira il telefono in orizzontale e appoggialo sul tavolo<button data-act="hideRotate">Ok</button></div>` : '';
  return `<div class="boardwrap" id="boardwrap"><div class="bd" id="bd">${s.status === 'finished' ? victory(s) : boardPlaying(s)}</div>${hint}</div>`;
}

function boardPlaying(s) {
  const d = derive(s);
  const h = s.current_hand;
  const slides = ['Classifica', 'Andamento', 'Mani'];
  // Barra sotto la scheda attiva: quanto manca al cambio di vista (assente in pausa)
  const total = Math.max(SLIDE_MS, A.pauseUntil - A.slideAt);
  const elapsed = Math.min(total, Date.now() - A.slideAt);
  const prog = A.carouselPaused ? '' : `<i class="sprog" style="animation-duration:${total}ms;animation-delay:-${elapsed}ms"></i>`;
  const tabs = slides.map((x, i) => `<button class="stab${A.slide === i ? ' on' : ''}" data-act="slide" data-arg="${i}">${x}${A.slide === i ? prog : ''}</button>`).join('')
    + `<button class="stab spause${A.carouselPaused ? ' on' : ''}" data-act="carouselPause" aria-pressed="${A.carouselPaused}" aria-label="${A.carouselPaused ? 'Riprendi il carosello' : 'Metti in pausa il carosello'}" title="${A.carouselPaused ? 'Riprendi' : 'Pausa'}">${A.carouselPaused ? icon.play : icon.pause}</button>`;
  const dots = d.teams.map((t) => {
    const sc = h && h.scores.find((x) => x.team_id === t.id);
    const done = sc && sc.points != null;
    return `<i title="${esc(teamLabel(t))}" style="border-color:${esc(t.color)};background:${done ? esc(t.color) : 'transparent'}"></i>`;
  }).join('');
  const mid = A.slide === 0 ? standings(s, d) : A.slide === 1 ? chart(s, d) : handsTable(s, d);
  const banner = A.banner && Date.now() < A.banner.until
    ? `<div class="banner" role="status"><b>${esc(A.banner.title)}</b>${A.banner.sub ? `<span>${esc(A.banner.sub)}</span>` : ''}${A.banner.deal ? `<em>${icon.cards}${esc(A.banner.deal)}</em>` : ''}</div>` : '';
  const fs = document.fullscreenEnabled ? `<button class="bbtn icon" data-act="fullscreen" aria-label="Schermo intero">${icon.full}</button>` : '';
  return `
    <div class="bd-top">
      <span class="hand">Mano ${h ? h.number : '–'}</span><span class="sub">si vince a ${s.target_score}</span><span class="code-pill" title="Codice per entrare">${esc(s.code)}</span>
      <span class="grow"></span>
      ${fs}
      <button class="bbtn" data-act="undo">${icon.undo}Annulla</button>
      <button class="bbtn${A.confirmFinish ? ' danger' : ''}" data-act="finish">${icon.flag}${A.confirmFinish ? 'Confermi la fine?' : 'Termina'}</button>
      <button class="bbtn primary" data-act="openEntry">${icon.plus}Punti</button>
    </div>
    <div class="bd-mid">${mid}</div>
    <div class="bd-bot">${tabs}<span class="hdots" aria-label="Squadre che hanno inserito i punti">mano ${h ? h.number : ''}: ${dots}</span><span class="grow"></span>${A.err ? `<span class="berr" role="alert">${esc(A.err)}</span>` : boardDealer(s)}</div>
    ${banner}
    ${A.entry ? entryOverlay(s, d) : ''}
    ${A.dealerOpen ? dealerOverlay(s) : ''}`;
}

function boardDealer(s) {
  const h = s.current_hand;
  if (!h || !h.dealer_player_id) return '';
  const p = playerById(s, h.dealer_player_id);
  const nx = h.next_dealer_player_id && h.next_dealer_player_id !== h.dealer_player_id ? `<span class="nx">poi ${esc(playerName(s, h.next_dealer_player_id))}</span>` : '';
  return `<button class="dealer" data-act="dealerOpen" aria-label="Chi dà le carte: tocca per cambiarlo">${icon.cards}<span>dà le carte <b style="color:${esc(p ? p.color : '#fff')}">${esc(p ? p.name : '?')}</b></span>${nx}</button>`;
}

function dealerOverlay(s) {
  const cur = s.current_hand && s.current_hand.dealer_player_id;
  const list = (s.dealer_order || []).map((id) => {
    const p = playerById(s, id);
    return `<button class="${id === cur ? 'on' : ''}" data-act="setDealer" data-arg="${id}"><span class="sw" style="width:18px;height:18px;background:${esc(p.color)}"></span>${esc(p.name)}<em>${id === cur ? 'dà le carte' : ''}</em></button>`;
  }).join('');
  return `<div class="entry" role="dialog" aria-label="Chi dà le carte">
    <div class="row"><span style="font:700 21px var(--display)">Chi dà le carte nella mano ${s.current_hand.number}?</span><span class="grow"></span>
      <button class="bbtn icon" data-act="dealerClose" aria-label="Chiudi">${icon.close}</button></div>
    <p class="dhint">Se al tavolo siete seduti in un altro ordine, scegli chi dà le carte adesso: dalla prossima mano il giro riparte da qui.</p>
    <div class="tpick dlist">${list}</div>
  </div>`;
}

function standings(s, d) {
  const n = d.ids.length;
  if (n <= 3) {
    const avSize = n === 2 ? 66 : 58;
    const cards = d.order.map((tid) => {
      const t = d.byId[tid];
      const leader = d.uniqueLeader === tid && d.history.length > 0;
      const b = badgesFor(s, tid)[0];
      const pct = Math.max(0, Math.min(100, t.total / s.target_score * 100));
      const gapTxt = !d.history.length ? 'si parte!' : leader ? `mancano ${t.to_target}` : t.gap_to_leader === 0 ? 'a pari merito in testa' : `−${t.gap_to_leader} dal primo`;
      const avs = t.players.map((p) => `<div class="avw">${avatar(p.name, d.moods[tid], t.color, avSize)}<span>${esc(p.name)}</span></div>`).join('');
      return `<div class="tcard" style="border-color:${leader ? esc(t.color) : 'var(--night-2)'}">
        ${b ? `<span class="badge${b.alt ? ' alt' : ''}">${esc(b.t)}</span>` : ''}
        <div class="row"><span class="pos" style="color:${esc(t.color)}">${t.rank}°</span><span class="ttl">${esc(teamLabel(t))}</span></div>
        <div class="avs">${avs}</div>
        <div class="grow"></div>
        <div class="score"><b>${t.total}</b>${t.last_delta != null ? `<span class="delta ${t.last_delta < 0 ? 'down' : 'up'}">${fmtPts(t.last_delta)}</span>` : ''}</div>
        <div class="bar"><i style="width:${pct}%;background:${esc(t.color)}"></i></div>
        <span class="gap">${gapTxt}</span>
      </div>`;
    }).join('');
    return `<div class="cards" style="grid-template-columns:repeat(${n},minmax(0,1fr))">${cards}</div>`;
  }
  const rows = d.order.map((tid) => {
    const t = d.byId[tid];
    const pct = Math.max(0, Math.min(100, t.total / s.target_score * 100));
    const b = badgesFor(s, tid)[0];
    const p = t.players[0];
    const leader = d.uniqueLeader === tid && d.history.length > 0;
    return `<div class="trow-b" style="border-color:${leader ? esc(t.color) : 'var(--night-2)'}">
      <span class="pos" style="color:${esc(t.color)}">${t.rank}</span>
      ${p ? avatar(p.name, d.moods[tid], t.color, 38) : ''}
      <span class="ttl">${esc(teamLabel(t))}</span>
      <div class="bar"><i style="width:${pct}%;background:${esc(t.color)}"></i></div>
      ${b ? `<span class="rb">${esc(b.t)}</span>` : ''}
      <span class="tot">${t.total}</span>
      <span class="delta ${t.last_delta != null && t.last_delta < 0 ? 'down' : 'up'}">${t.last_delta != null ? fmtPts(t.last_delta) : ''}</span>
    </div>`;
  }).join('');
  return `<div class="rows">${rows}</div>`;
}

function chart(s, d) {
  const N = d.history.length;
  if (!N) return '<div class="blank">L\'andamento compare dopo la prima mano</div>';
  const W = 812, H = 262, L = 46, R = 84, T = 12, B = 24;
  const all = d.ids.flatMap((i) => d.series[i]);
  const yMax = Math.max(s.target_score, ...all) * 1.06;
  const yMin = Math.min(0, ...all);
  const x = (k) => L + k * (W - L - R) / Math.max(1, N);
  const y = (v) => T + (yMax - v) / (yMax - yMin) * (H - T - B);
  let svg = '';
  const ticks = [0, Math.round(s.target_score / 2), s.target_score];
  if (yMin < 0) ticks.unshift(Math.round(yMin));
  ticks.forEach((v) => {
    const tgt = v === s.target_score;
    svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${tgt ? '#FFC22E' : '#3A3363'}" stroke-width="${tgt ? 2 : 1}" ${tgt ? 'stroke-dasharray="6 5"' : ''}/>`;
    svg += `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="12" font-weight="800" fill="${tgt ? '#FFC22E' : '#C9C3EA'}" font-family="Nunito, sans-serif">${v}</text>`;
  });
  const step = N > 14 ? Math.ceil(N / 14) : 1;
  for (let k = 1; k <= N; k += step) svg += `<text x="${x(k)}" y="${H - 6}" text-anchor="middle" font-size="11" font-weight="800" fill="#C9C3EA" font-family="Nunito, sans-serif">${k}</text>`;
  const ends = d.ids.map((i) => ({ i, v: d.series[i][N], y: y(d.series[i][N]) })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 15) ends[k].y = ends[k - 1].y + 15;
  d.ids.forEach((i) => {
    const t = d.byId[i];
    const pts = d.series[i].map((v, k) => `${x(k).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    svg += `<polyline points="${pts}" fill="none" stroke="${esc(t.color)}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
    svg += `<circle cx="${x(N)}" cy="${y(d.series[i][N])}" r="5" fill="${esc(t.color)}" stroke="#17132E" stroke-width="2"/>`;
  });
  ends.forEach((e) => { const t = d.byId[e.i]; svg += `<text x="${x(N) + 10}" y="${e.y + 4}" font-size="13" font-weight="700" fill="${esc(t.color)}" font-family="Fredoka, sans-serif">${e.v} ${esc(teamLabel(t).slice(0, 9))}</text>`; });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Andamento dei punteggi mano per mano">${svg}</svg>`;
}

function handsTable(s, d) {
  const h = s.current_hand;
  const head = d.teams.map((t) => `<th style="color:${esc(t.color)}">${esc(teamLabel(t).slice(0, 10))}</th>`).join('');
  const shown = d.history.slice(h ? -5 : -6);
  const rows = shown.map((r) => `<tr><td>Mano ${r.number}</td>${d.ids.map((i) => `<td class="${r.scores[i] < 0 ? 'down' : ''}">${fmtPts(r.scores[i])}</td>`).join('')}</tr>`).join('');
  const cur = h ? `<tr class="cur"><td>Mano ${h.number}</td>${d.ids.map((i) => { const sc = h.scores.find((x) => x.team_id === i); return `<td>${sc && sc.points != null ? fmtPts(sc.points) : '…'}</td>`; }).join('')}</tr>` : '';
  const tot = `<tr class="tot"><td>Totale</td>${d.ids.map((i) => `<td>${d.totals[i]}</td>`).join('')}</tr>`;
  const more = d.history.length > shown.length ? `<p class="gap" style="margin:0 0 2px">${d.history.length - shown.length} mani precedenti nascoste</p>` : '';
  return `<div style="height:100%;overflow:hidden">${more}<table class="htable"><thead><tr><th>Mano</th>${head}</tr></thead><tbody>${rows}${cur}${tot}</tbody></table></div>`;
}

function entryOverlay(s, d) {
  const h = s.current_hand;
  const dr = draft('m');
  const pending = d.teams.find((t) => { const sc = h.scores.find((x) => x.team_id === t.id); return !sc || sc.points == null; });
  if (dr.team == null || !d.byId[dr.team]) dr.team = (pending || d.teams[0]).id;
  const list = d.teams.map((t) => {
    const sc = h.scores.find((x) => x.team_id === t.id);
    const done = sc && sc.points != null;
    return `<button class="${dr.team === t.id ? 'on' : ''}" data-act="pickTeam" data-arg="${t.id}"><span class="sw" style="width:18px;height:18px;background:${esc(t.color)}"></span>${esc(teamLabel(t))}<em class="${done ? 'done' : ''}">${done ? fmtPts(sc.points) : 'da inserire'}</em></button>`;
  }).join('');
  const t = d.byId[dr.team];
  const typed = dr.digits !== '';
  return `<div class="entry" role="dialog" aria-label="Inserisci i punti della mano">
    <div class="row"><span style="font:700 21px var(--display)">Punti della mano ${h.number}</span><span class="grow"></span>
      ${A.err ? `<span class="berr" role="alert">${esc(A.err)}</span>` : ''}
      <button class="bbtn icon" data-act="closeEntry" aria-label="Chiudi">${icon.close}</button></div>
    <div class="entry-body">
      <div class="tpick">${list}</div>
      <div class="epanel">
        <div style="display:flex;flex-direction:column;gap:8px;min-width:0">
          <div class="card display" style="box-shadow:none">${signToggle('m', dr)}<span class="num${typed ? '' : ' placeholder'}">${typed ? esc(dr.digits) : '0'}</span></div>
          <label class="check"><input type="checkbox" data-act="closedT" data-who="m" ${dr.closed ? 'checked' : ''}>${esc(teamLabel(t))} ha chiuso la mano</label>
          <div class="grow"></div>
          <button class="btn sun" data-act="send" data-who="m" ${typed && !A.busy ? '' : 'disabled'}>Segna ${typed ? fmtPts((dr.neg ? -1 : 1) * Number(dr.digits)) : ''} a ${esc(teamLabel(t))}</button>
        </div>
        <div class="keys">${keypad('m', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '00', 'del'])}</div>
      </div>
    </div>
  </div>`;
}

function victory(s) {
  const d = derive(s);
  const w = s.winner_team_id != null ? d.byId[s.winner_team_id] : null;
  let conf = '';
  for (let i = 0; i < 28; i++) {
    const xx = (i * 137) % 830, yy = (i * 89 + 17) % 380;
    if (xx > 20 && xx < 320 && yy > 50 && yy < 320) continue;
    if (xx > 350 && xx < 820 && yy > 60 && yy < 340) continue;
    conf += `<span class="confetti" aria-hidden="true" style="left:${xx}px;top:${yy}px;width:${8 + (i % 3) * 4}px;height:${4 + (i % 2) * 6}px;background:${TEAM_COLORS[i % 6]};animation-delay:${(i % 7) * 0.3}s"></span>`;
  }
  const faces = w ? w.players.map((p, i) => `<div class="avw" style="transform:rotate(${i % 2 ? 5 : -4}deg)">${avatar(p.name, 4, w.color, w.players.length > 2 ? 92 : 112)}<span style="font:600 17px var(--display);color:#fff">${esc(p.name)}</span></div>`).join('') : '';
  const finals = d.order.map((tid) => { const t = d.byId[tid]; return `<div><span class="sw" style="width:12px;height:12px;border-width:0;background:${esc(t.color)}"></span>${esc(teamLabel(t))}<b>${t.total}</b></div>`; }).join('');
  let best = null;
  d.history.forEach((h) => d.ids.forEach((i) => { const p = h.scores[i]; if (!best || p > best.p) best = { p, t: i, n: h.number }; }));
  const sub = s.finish_reason === 'manual' ? 'Partita chiusa dal master' : 'Traguardo raggiunto';
  return `<div class="win">${conf}
    <div class="avs" style="position:relative;gap:14px">${faces}</div>
    <div style="position:relative;display:flex;flex-direction:column;gap:11px;flex:1;min-width:0">
      <span class="lbl" style="color:var(--sun)">${sub} · ${d.history.length} mani</span>
      <h3>${w ? `Vince ${esc(teamLabel(w))}!` : 'Pareggio!'}</h3>
      <div class="finals">${finals}</div>
      ${best ? `<span class="gap" style="font-size:14px">Mano migliore: ${fmtPts(best.p)} di ${esc(teamLabel(d.byId[best.t]))} alla mano ${best.n}</span>` : ''}
      <div class="row wrap" style="gap:10px;margin-top:4px">
        <button class="btn sun" style="width:auto;min-height:50px;box-shadow:4px 4px 0 #000" data-act="rematch" ${A.busy ? 'disabled' : ''}>Rivincita</button>
        <button class="bbtn" style="height:46px" data-act="undo">${icon.undo}Annulla ultima mano</button>
        <button class="bbtn" style="height:46px" data-act="leave">Nuova partita</button>
      </div>
      ${A.err ? `<span class="berr" role="alert">${esc(A.err)}</span>` : ''}
    </div></div>`;
}

// ===================================================================
// Rendering
// ===================================================================
function currentView() {
  if (A.view === 'home') return homeView();
  if (A.view === 'setup') return setupView();
  if (A.view === 'code') return codeView();
  if (A.view === 'join' && A.summary) return joinView();
  if (A.view === 'game') {
    const s = A.state;
    if (!s) return `<div class="ph center"><div class="logo big" aria-hidden="true">P</div><p class="lbl">Mi collego alla partita…</p>${errLine()}<button class="link" data-act="leave">Annulla</button></div>`;
    if (s.status === 'lobby') return s.me.is_master ? masterLobby(s) : playerLobby(s);
    if (s.me.is_master) return boardView(s);
    return s.status === 'playing' ? playerPlay(s) : playerEnd(s);
  }
  return homeView();
}

function render() {
  // Conserva testo, focus e cursore dei campi mentre il polling ridisegna la pagina
  const saved = {};
  document.querySelectorAll('input[id]').forEach((i) => {
    if (i.type !== 'checkbox') saved[i.id] = { v: i.value, f: document.activeElement === i, s: i.selectionStart };
  });
  const isBoard = A.view === 'game' && A.state && A.state.status !== 'lobby' && A.state.me.is_master;
  document.body.classList.toggle('dark', !!isBoard);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', isBoard ? '#17132E' : '#F3EFFF');
  const topBar = A.offline
    ? '<div class="offline" role="status">Connessione persa: riprovo…</div>'
    : A.toast && Date.now() < A.toast.until
      ? `<div class="offline toast" role="status">${esc(A.toast.text)}</div>`
      : A.newVersion
      ? `<div class="offline update" role="status">Nuova versione ${esc(A.newVersion)} disponibile <button data-act="reload">Aggiorna</button></div>`
      : '';
  $('#app').innerHTML = topBar + currentView();
  for (const [id, o] of Object.entries(saved)) {
    if (A.clear.includes(id)) continue;
    const el = document.getElementById(id);
    if (!el) continue;
    el.value = o.v;
    if (o.f) { el.focus(); try { el.setSelectionRange(o.s, o.s); } catch (e) { /* ignora */ } }
  }
  A.clear = [];
  layoutBoard();
}

function layoutBoard() {
  const wrap = $('#boardwrap'), bd = $('#bd');
  if (!wrap || !bd) return;
  const cs = getComputedStyle(wrap);
  const w = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const scale = Math.min(w / BOARD_W, h / BOARD_H);
  bd.style.left = (parseFloat(cs.paddingLeft) + w / 2) + 'px';
  bd.style.top = (parseFloat(cs.paddingTop) + h / 2) + 'px';
  bd.style.transform = `translate(-50%, -50%) scale(${scale})`;
}
window.addEventListener('resize', () => { if ($('#boardwrap')) render(); });

// Carosello e annunci del tabellone
let lastBoardKey = '';
setInterval(() => {
  const s = A.state;
  if (A.view !== 'game' || !s || s.status !== 'playing') return;
  const now = Date.now();
  if (s.me.is_master && !A.carouselPaused && !A.entry && !A.dealerOpen && now > A.pauseUntil && now - A.slideAt > SLIDE_MS && !(A.banner && now < A.banner.until)) {
    A.slide = (A.slide + 1) % 3; A.slideAt = now;
  }
  const key = [A.slide, A.carouselPaused, !!(A.banner && now < A.banner.until), A.confirmFinish, now - A.sentAt < 2500, !!(A.toast && now < A.toast.until)].join('|');
  if (key !== lastBoardKey) { lastBoardKey = key; render(); }
}, 500);

// Schermo sempre acceso sul tabellone
let wakeLock = null;
async function requestWakeLock() {
  if (!A.state || !A.session || !A.session.isMaster || A.state.status === 'lobby') return;
  try {
    if ('wakeLock' in navigator && !wakeLock && !document.hidden) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* non concesso: pazienza */ }
}

// ===================================================================
// Azioni
// ===================================================================
async function openJoin(code) {
  A.summary = await api('GET', `/games/${encodeURIComponent(code)}`);
  A.view = 'join'; A.joinTeam = null;
}

const actions = {
  reload() { location.reload(); return 'rendered'; },
  go(el, a) { A.view = a; A.summary = a === 'join' ? A.summary : null; },
  fmt(el, a) { A.setup.format = a; store.set('setup', A.setup); },
  target(el, a) { A.setup.target = Math.max(100, Math.min(100000, A.setup.target + Number(a))); store.set('setup', A.setup); },
  targetSet(el, a) { A.setup.target = Number(a); store.set('setup', A.setup); },

  async create() {
    const name = val('setupName');
    if (!name) fail('Scrivi il tuo nome');
    store.set('name', name);
    const teams = FORMATS[A.setup.format].map((n, i) => ({ name: TEAM_NAMES[i], color: TEAM_COLORS[i], size: n }));
    const r = await api('POST', '/games', { master_name: name, format: A.setup.format, target_score: A.setup.target, teams });
    setSession({ code: r.code, token: r.player_token, playerId: r.player_id, isMaster: true });
    A.view = 'game';
    // Il master entra subito nella prima squadra (può spostarsi dalla sala d'attesa)
    const s = await api('GET', gpath('/state'));
    const first = [...s.teams].sort((x, y) => x.id - y.id)[0];
    applyState(await api('PATCH', gpath(`/players/${r.player_id}`), { team_id: first.id }));
    schedulePoll();
  },
  async codeNext() {
    const code = val('codeInput').toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) fail('Il codice ha 4 caratteri');
    try { await openJoin(code); } catch (e) { if (e.status === 404) fail('Nessuna partita con questo codice'); throw e; }
  },
  joinTeam(el, a) { A.joinTeam = Number(a); },
  async join() {
    const name = val('joinName');
    if (!name) fail('Scrivi il tuo nome');
    if (A.joinTeam == null) fail('Scegli una squadra');
    store.set('name', name);
    const code = A.summary.code;
    let r;
    try { r = await api('POST', `/games/${code}/players`, { name, team_id: A.joinTeam }); }
    catch (e) { if (e.code === 'team_full') await openJoin(code); throw e; }
    setSession({ code, token: r.player_token, playerId: r.player_id, isMaster: false });
    A.view = 'game';
    pollNow();
  },
  leave() { endSession(''); return 'rendered'; },

  // sala d'attesa
  async myTeam(el, a) { applyState(await api('PATCH', gpath(`/players/${A.session.playerId}`), { team_id: Number(a) })); },
  async manual() {
    const name = val('manualName');
    if (!name) fail('Scrivi il nome del giocatore');
    const free = [...A.state.teams].sort((x, y) => x.id - y.id).find((t) => t.players.length < t.size);
    applyState(await api('POST', gpath('/players/manual'), { name, team_id: free ? free.id : null }));
    A.clear.push('manualName');
  },
  async kick(el, a) { applyState(await api('DELETE', gpath(`/players/${Number(a)}`))); },
  async shuffle() { applyState(await api('POST', gpath('/shuffle'))); },
  dealerPick(el, a) { A.dealerPick = Number(a); },
  async start() {
    if (A.dealerPick == null) fail('Scegli chi dà le carte nella prima mano');
    applyState(await api('POST', gpath('/start'), { dealer_player_id: A.dealerPick }));
    A.dealerPick = null;
    requestWakeLock();
  },

  // tastierino
  key(el, a, who) {
    const dr = draft(who);
    if (a === 'del') dr.digits = dr.digits.slice(0, -1);
    else if ((dr.digits + a).replace(/^0+/, '').length <= 5) dr.digits = (dr.digits + a).replace(/^0+(?=\d)/, '');
    if (/^0+$/.test(dr.digits)) dr.digits = '0';
  },
  sign(el, a, who) { draft(who).neg = a === '-'; },
  closedT(el, a, who) { draft(who).closed = el.checked; },
  async send(el, a, who) {
    const dr = draft(who);
    if (dr.digits === '') return;
    const pts = (dr.neg ? -1 : 1) * Number(dr.digits);
    const tid = who === 'm' ? dr.team : A.state.me.team_id;
    let s;
    try {
      s = await api('PUT', gpath(`/hands/current/scores/${tid}`), { points: pts, closed_hand: dr.closed, hand_number: A.state.current_hand.number });
    } catch (e) {
      if (e.code !== 'hand_changed') throw e;
      // La mano si è chiusa mentre si scriveva: il polling non lo aveva ancora segnalato
      dr.digits = ''; dr.neg = false; dr.closed = false; dr.team = null;
      A.entry = false;
      showToast(e.message, true);
      pollNow();
      return;
    }
    dr.digits = ''; dr.neg = false; dr.closed = false;
    if (who === 'm') {
      const h = s.current_hand;
      const handClosed = !h || h.number !== A.state.current_hand.number;
      const next = h && s.teams.slice().sort((x, y) => x.id - y.id).find((t) => { const sc = h.scores.find((x) => x.team_id === t.id); return !sc || sc.points == null; });
      if (handClosed || !next) A.entry = false; else dr.team = next.id;
    } else {
      A.sentAt = Date.now();
    }
    applyState(s);
  },

  // tabellone
  openEntry() { A.entry = true; draft('m').team = null; },
  closeEntry() { A.entry = false; },
  dealerOpen() { A.dealerOpen = true; A.entry = false; },
  dealerClose() { A.dealerOpen = false; },
  async setDealer(el, a) {
    const s = await api('PUT', gpath('/hands/current/dealer'), { player_id: Number(a) });
    A.dealerOpen = false;
    applyState(s);
  },
  pickTeam(el, a) { const dr = draft('m'); dr.team = Number(a); dr.digits = ''; dr.neg = false; dr.closed = false; },
  slide(el, a) { A.slide = Number(a); A.pauseUntil = Date.now() + SLIDE_HOLD_MS; A.slideAt = Date.now(); },
  carouselPause() {
    A.carouselPaused = !A.carouselPaused;
    store.set('carouselPaused', A.carouselPaused || null);
    A.slideAt = Date.now(); A.pauseUntil = 0;   // alla ripresa la vista attuale dura un giro intero
  },
  async undo() { A.confirmFinish = false; applyState(await api('DELETE', gpath('/hands/last'))); },
  async finish() {
    if (!A.confirmFinish) { A.confirmFinish = true; setTimeout(() => { A.confirmFinish = false; }, 3500); return; }
    A.confirmFinish = false;
    applyState(await api('POST', gpath('/finish')));
  },
  async rematch() {
    const r = await api('POST', gpath('/rematch'));
    A.session = { ...A.session, code: r.code }; store.set('session', A.session);
    A.state = null; A.etag = null; A.drafts = {}; A.notice = 'Rivincita pronta: i giocatori entrano da soli';
    pollNow();
  },
  hideRotate() { A.hideRotate = true; },
  async fullscreen() {
    try {
      await document.documentElement.requestFullscreen();
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape').catch(() => {});
    } catch (e) { /* non supportato */ }
    requestWakeLock();
  },
};

async function handle(el) {
  const fn = actions[el.dataset.act];
  if (!fn || (A.busy && el.dataset.act !== 'leave')) return;
  A.err = '';
  let result;
  try {
    result = fn(el, el.dataset.arg, el.dataset.who);
    if (result instanceof Promise) { A.busy = true; render(); result = await result; }
  } catch (e) {
    A.err = e instanceof UserError ? e.message : 'Qualcosa è andato storto: riprova';
    if (!(e instanceof UserError)) console.error(e);
  }
  A.busy = false;
  if (result !== 'rendered') render();
}
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled || el.type === 'checkbox') return;
  handle(el);
});
document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.type === 'checkbox' && el.dataset.act) handle(el);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || !ev.target.id) return;
  const map = { setupName: 'create', manualName: 'manual', joinName: 'join', codeInput: 'codeNext' };
  const act = map[ev.target.id];
  if (act) { const b = document.querySelector(`[data-act="${act}"]`); if (b) handle(b); }
});

// ===================================================================
// Avvio
// ===================================================================
async function boot() {
  const params = new URLSearchParams(location.search);
  const joinCode = (params.get('join') || '').toUpperCase();
  if (joinCode) history.replaceState(null, '', location.pathname);
  if (joinCode && /^[A-Z0-9]{4}$/.test(joinCode) && !(A.session && A.session.code === joinCode)) {
    try { await openJoin(joinCode); }
    catch (e) { A.view = 'home'; A.err = e.status === 404 ? 'Il QR punta a una partita che non esiste più' : (e.message || 'Errore'); }
    render();
    return;
  }
  if (A.session) { A.view = 'game'; render(); pollNow(); return; }
  render();
}
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
boot();
})();
