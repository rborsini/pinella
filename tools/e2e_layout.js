// Test del layout adattivo (issue #7): tutte le viste su 6 misure di schermo, in verticale e orizzontale.
// Controlla che niente esca dallo schermo o dalla tela del tabellone e salva gli screenshot in SHOTS.
// Uso:  node tools/e2e_layout.js [base_url]      (richiede playwright)
const { chromium, request } = require('playwright');
const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/$/, '') + '/';
const SHOTS = process.env.SHOTS || '/tmp';
const SIZES = {
  'telefono-v': [390, 844], 'telefono-o': [844, 390],
  'tablet7-v': [600, 960], 'tablet7-o': [960, 600],
  'ipad-v': [820, 1180], 'ipad-o': [1180, 820],
};
const errors = [];
let passed = 0;
const ok = (c, l) => { if (!c) throw new Error('FALLITO: ' + l); passed++; };

// --- preparazione delle partite via API
async function setupGame(api, format, teams, names, hands, finish = false) {
  const call = async (method, path, data, token) => {
    const r = await api.fetch(BASE + 'api' + path, { method, data, headers: token ? { 'X-Player-Token': token } : {} });
    return r.json();
  };
  const g = await call('POST', '/games', { master_name: names[0], format, target_score: 1500, teams });
  const st0 = await call('GET', `/games/${g.code}/state`, undefined, g.player_token);
  const tids = st0.teams.map((t) => t.id).sort((a, b) => a - b);
  const sizes = teams.map((t) => t.size);
  const slots = []; // a giro, come il sorteggio
  for (let r = 0; r < Math.max(...sizes); r++) tids.forEach((id, i) => { if (r < sizes[i]) slots.push(id); });
  await call('PATCH', `/games/${g.code}/players/${st0.me.player_id}`, { team_id: slots[0] }, g.player_token);
  const tokens = [g.player_token];
  for (let i = 1; i < names.length; i++) {
    const j = await call('POST', `/games/${g.code}/players`, { name: names[i], team_id: slots[i] });
    tokens.push(j.player_token);
  }
  await call('POST', `/games/${g.code}/start`, {}, g.player_token);
  for (const pts of hands) for (const [i, tid] of tids.entries()) await call('PUT', `/games/${g.code}/hands/current/scores/${tid}`, { points: pts[i] }, g.player_token);
  if (finish) await call('POST', `/games/${g.code}/finish`, {}, g.player_token);
  return { code: g.code, master: g.player_token, player: tokens[1], playerId: null };
}

async function open(browser, [w, h], session, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await ctx.addInitScript(([s, paused]) => {
    if (s) localStorage.setItem('pinella:session', JSON.stringify(s));
    if (paused) localStorage.setItem('pinella:carouselPaused', 'true');
  }, [session, !!opts.paused]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${w}x${h}: ${e.message}`));
  await p.goto(BASE);
  return p;
}

// niente scorrimento orizzontale e (sul tabellone) niente fuori dalla tela
async function checkFits(p, label) {
  const r = await p.evaluate(() => {
    const out = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`scroll orizzontale ${document.documentElement.scrollWidth}>${innerWidth}`);
    const bd = document.getElementById('bd');
    if (bd) {
      const b = bd.getBoundingClientRect();
      if (b.left < -1 || b.top < -1 || b.right > innerWidth + 1 || b.bottom > innerHeight + 1) out.push('tela fuori dallo schermo');
      for (const el of bd.querySelectorAll('*')) {
        if (el.closest('.confetti') || el.closest('svg') || el.closest('.sprog')) continue;
        const e = el.getBoundingClientRect();
        if (!e.width || !e.height) continue;
        if (e.left < b.left - 2 || e.right > b.right + 2 || e.top < b.top - 2 || e.bottom > b.bottom + 2) {
          out.push(`fuori dalla tela: ${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.innerText || '').slice(0, 20)}"`);
          if (out.length > 4) break;
        }
      }
    }
    return out;
  });
  ok(r.length === 0, `${label}: ${r.join(' | ')}`);
}
// tutto il necessario per inserire i punti è visibile senza scorrere
async function checkPlayVisible(p, label) {
  const r = await p.evaluate(() => {
    const vis = (sel) => { const e = document.querySelector(sel); if (!e) return false; const b = e.getBoundingClientRect(); return b.top >= -1 && b.bottom <= innerHeight + 1; };
    return { send: vis('[data-act="send"]'), key1: vis('[data-act="key"][data-arg="1"]'), del: vis('[data-act="key"][data-arg="del"]'), display: vis('.display') };
  });
  ok(r.send && r.key1 && r.del && r.display, `${label}: tastierino e Invia visibili senza scorrere ${JSON.stringify(r)}`);
}

(async () => {
  const api = await request.newContext();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  try {
    const teams3 = [['Corallo', '#FF6B57'], ['Turchese', '#18C2B0'], ['Sole', '#FFC22E']].map(([name, color]) => ({ name, color, size: 2 }));
    const g222 = await setupGame(api, '2v2v2', teams3, ['Rob', 'Silvia', 'Giorgia', 'Luca', 'Marta', 'Paolo'], [[120, 85, -20], [300, 410, 150], [90, 60, 260]]);
    const singles = ['#FF6B57', '#18C2B0', '#FFC22E', '#A48BFF', '#3AA0FF'].map((color, i) => ({ name: 'G' + i, color, size: 1 }));
    const g5 = await setupGame(api, '5x1', singles, ['Rob', 'Silvia', 'Giorgia', 'Luca', 'Marta'], [[120, 85, -20, 300, 60], [80, 410, 150, 20, 95]]);
    const gEnd = await setupGame(api, '2v2v2', teams3, ['Rob', 'Silvia', 'Giorgia', 'Luca', 'Marta', 'Paolo'], [[800, 400, 300], [750, 300, 200]]);

    for (const [name, size] of Object.entries(SIZES)) {
      const portrait = size[1] > size[0];
      console.log(name);
      // tabellone 2·2·2 e 5 singoli, tutte le viste
      for (const [gname, g] of [['222', g222], ['5x1', g5]]) {
        const m = await open(browser, size, { code: g.code, token: g.master, isMaster: true }, { paused: true });
        await m.waitForSelector('.bd-top');
        await m.waitForTimeout(400);
        for (const slide of portrait ? [1, 2] : [0, 1, 2]) {
          await m.locator(`[data-act="slide"][data-arg="${slide}"]`).click();
          await m.waitForTimeout(250);
          await checkFits(m, `${name} tabellone ${gname} vista ${slide}`);
          await m.screenshot({ path: `${SHOTS}/L-${name}-board-${gname}-${slide}.png` });
        }
        if (portrait) ok(await m.locator('.pstand .trow-b').count() === (gname === '222' ? 3 : 5), `${name}: classifica sempre visibile in verticale`);
        await m.locator('[data-act="openEntry"]').click();
        await m.waitForSelector('.entry');
        await checkFits(m, `${name} pannello punti ${gname}`);
        if (gname === '5x1') await m.screenshot({ path: `${SHOTS}/L-${name}-entry.png` });
        await m.locator('[data-act="closeEntry"]').click();
        await m.locator('[data-act="dealerOpen"]').click();
        await m.waitForSelector('.dlist');
        await checkFits(m, `${name} pannello mazziere ${gname}`);
        if (gname === '222') await m.screenshot({ path: `${SHOTS}/L-${name}-dealer.png` });
        await m.context().close();
      }
      // vittoria
      const v = await open(browser, size, { code: gEnd.code, token: gEnd.master, isMaster: true });
      await v.waitForSelector('.win');
      await checkFits(v, `${name} vittoria`);
      await v.screenshot({ path: `${SHOTS}/L-${name}-win.png` });
      await v.context().close();
      // telefono del giocatore
      const pl = await open(browser, size, { code: g222.code, token: g222.player, isMaster: false });
      await pl.waitForSelector('[data-act="send"]');
      await checkFits(pl, `${name} giocatore`);
      await checkPlayVisible(pl, `${name} giocatore`);
      await pl.screenshot({ path: `${SHOTS}/L-${name}-player.png` });
      await pl.context().close();
      // creazione partita (senza sessione)
      const h = await open(browser, size, null);
      await h.locator('[data-act="go"][data-arg="setup"]').click();
      await h.waitForSelector('.fmts');
      await checkFits(h, `${name} creazione`);
      await h.screenshot({ path: `${SHOTS}/L-${name}-setup.png` });
      await h.context().close();
    }
    ok(errors.length === 0, 'nessun errore JavaScript' + (errors.length ? ': ' + errors.join(' | ') : ''));
    console.log(`\nTutti i ${passed} controlli superati.`);
  } finally {
    await browser.close();
    await api.dispose();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
