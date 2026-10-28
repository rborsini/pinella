// Test degli stili grafici (issue #17): per ogni stile crea una partita dalla PWA, la gioca via API
// e controlla creazione, sala d'attesa, telefono del giocatore, tabellone (orizzontale e verticale) e vittoria.
// Verifica anche il contrasto dei colori di ogni stile e salva gli screenshot in SHOTS.
// Uso:  node tools/e2e_temi.js [base_url]      (richiede playwright)
// Senza rete verso Google Fonts i titoli usano Fredoka; con FONTS_DIR=<cartella con node_modules/@fontsource/*>
// i font vengono serviti in locale, per vedere negli screenshot quelli veri.
const fs = require('fs');
const path = require('path');
const { chromium, request } = require('playwright');
const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/$/, '') + '/';
const SHOTS = process.env.SHOTS || '/tmp';
const FONTS_DIR = process.env.FONTS_DIR || '';
const THEMES = ['classico', 'halloween', 'pasqua', 'natale', 'capodanno', 'befana', 'mare', 'casino', 'compleanno'];
const PHONE = [390, 844], LAND = [844, 390], TAB_V = [820, 1180];
const errors = [];
let passed = 0;
const ok = (c, l) => { if (!c) throw new Error('FALLITO: ' + l); passed++; };

// Google Fonts servito dai pacchetti @fontsource (solo per il test)
async function routeFonts(ctx) {
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'fonts.gstatic.com' || !FONTS_DIR) {
      const f = url.pathname.slice(1);
      if (FONTS_DIR && fs.existsSync(path.join(FONTS_DIR, f))) return route.fulfill({ body: fs.readFileSync(path.join(FONTS_DIR, f)), contentType: 'font/woff2' });
      return route.abort();
    }
    let css = '';
    for (const fam of url.searchParams.getAll('family')) {
      const [name, axes] = fam.split(':');
      const slug = name.toLowerCase().replace(/ /g, '-');
      const weights = axes ? axes.replace('wght@', '').split(';') : ['400'];
      for (const w of weights) {
        const rel = `node_modules/@fontsource/${slug}/files/${slug}-latin-${w}-normal.woff2`;
        if (fs.existsSync(path.join(FONTS_DIR, rel))) css += `@font-face{font-family:'${name}';font-weight:${w};font-display:swap;src:url(https://fonts.gstatic.com/${rel}) format('woff2')}\n`;
      }
    }
    return route.fulfill({ body: css, contentType: 'text/css' });
  });
}

async function open(browser, [w, h], session) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await routeFonts(ctx);
  await ctx.addInitScript((s) => {
    if (s) localStorage.setItem('pinella:session', JSON.stringify(s));
    localStorage.setItem('pinella:carouselPaused', 'true');
  }, session);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${w}x${h}: ${e.message}`));
  await p.goto(BASE);
  return p;
}
const settle = async (p) => { await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(250); };

async function checkFits(p, label) {
  const r = await p.evaluate(() => {
    const out = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push('scroll orizzontale');
    const bd = document.getElementById('bd');
    if (bd) {
      const b = bd.getBoundingClientRect();
      for (const el of bd.querySelectorAll('*')) {
        if (el.closest('.confetti') || el.closest('svg') || el.closest('.sprog')) continue;
        const e = el.getBoundingClientRect();
        if (e.width && e.height && (e.left < b.left - 2 || e.right > b.right + 2 || e.top < b.top - 2 || e.bottom > b.bottom + 2)) {
          out.push(`fuori dalla tela: ${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.innerText || '').slice(0, 20)}"`);
          if (out.length > 3) break;
        }
      }
    }
    return out;
  });
  ok(r.length === 0, `${label}: ${r.join(' | ')}`);
}

// contrasto WCAG tra i token del tema attivo
async function checkContrast(p, theme) {
  const r = await p.evaluate(() => {
    const v = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();
    const lum = (hex) => {
      const c = hex.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    // [testo, fondo, minimo]: 4.5 testo normale, 3 testo grande in grassetto (bottoni, titoli)
    const pairs = [
      ['--ink', '--lilac', 4.5], ['--ink', '--paper', 4.5], ['--muted', '--lilac', 4.5], ['--muted', '--paper', 4.5],
      ['--ink', '--coral', 3], ['--ink', '--sun', 3], ['--ink', '--teal', 3], ['--ink', '--lav', 4.5], ['--ink', '--b-accent', 4.5],
      ['--soft', '--night-2', 4.5], ['--soft', '--night', 4.5], ['--danger', '--lilac', 3],
    ];
    return pairs.map(([a, b, min]) => ({ a, b, min, r: Math.round(cr(v(a), v(b)) * 100) / 100 }));
  });
  for (const x of r) ok(x.r >= x.min, `${theme}: contrasto ${x.a} su ${x.b} = ${x.r} (minimo ${x.min})`);
  return r;
}
// i colori delle squadre devono staccarsi dal fondo del tabellone (barre, numeri della posizione)
async function checkTeamColors(p, theme) {
  const r = await p.evaluate(() => {
    const lum = (hex) => {
      const c = hex.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const bg = getComputedStyle(document.body).getPropertyValue('--night-2').trim();
    const cols = [...document.querySelectorAll('.thm.on .ts i')].map((i) => {
      const m = getComputedStyle(i).backgroundColor.match(/\d+/g).slice(0, 3).map(Number);
      return '#' + m.map((x) => x.toString(16).padStart(2, '0')).join('');
    });
    return cols.map((c) => { const [x, y] = [lum(c), lum(bg)].sort((m, n) => n - m); return { c, r: Math.round((x + 0.05) / (y + 0.05) * 100) / 100 }; });
  });
  for (const x of r) ok(x.r >= 3, `${theme}: colore squadra ${x.c} sul tabellone (contrasto ${x.r})`);
}

async function call(api, method, p, data, token) {
  const r = await api.fetch(BASE + 'api' + p, { method, data, headers: token ? { 'X-Player-Token': token } : {} });
  return r.json();
}

(async () => {
  const api = await request.newContext();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  const report = [];
  try {
    for (const theme of THEMES) {
      console.log(theme);
      // 1. creazione: scelgo lo stile e controllo l'anteprima
      const h = await open(browser, PHONE, null);
      await h.locator('[data-act="go"][data-arg="setup"]').click();
      await h.locator(`[data-act="theme"][data-arg="${theme}"]`).click();
      await h.locator('[data-act="fmt"][data-arg="2v2v2"]').click();
      ok(await h.evaluate(() => document.body.dataset.theme) === theme, `${theme}: stile applicato subito alla creazione`);
      ok(await h.locator(`[data-act="theme"][data-arg="${theme}"][aria-pressed="true"]`).count() === 1, `${theme}: tessera selezionata`);
      await checkTeamColors(h, theme);
      report.push({ theme, contrast: await checkContrast(h, theme) });
      await settle(h);
      await checkFits(h, `${theme} creazione`);
      await h.screenshot({ path: `${SHOTS}/T-${theme}-1-setup.png`, fullPage: true });
      const teamNames = (await h.locator('.trow .tname').allInnerTexts()).map((x) => x.replace(/^[^A-Za-zÀ-ú]+/u, '').trim());
      await h.locator('#setupName').fill('Rob');
      await h.locator('[data-act="create"]').click();
      await h.waitForSelector('.codetiles');
      ok(await h.evaluate(() => document.body.dataset.theme) === theme, `${theme}: la sala d'attesa usa lo stile`);
      const sess = await h.evaluate(() => JSON.parse(localStorage.getItem('pinella:session')));
      ok(sess.theme === theme, `${theme}: stile salvato nella sessione`);

      // 2. giocatori via API, stessa squadra assegnata a giro
      let st = await call(api, 'GET', `/games/${sess.code}/state`, undefined, sess.token);
      ok(st.theme === theme, `${theme}: il server ha registrato lo stile`);
      const tids = st.teams.map((t) => t.id).sort((a, b) => a - b);
      ok(JSON.stringify(st.teams.sort((a, b) => a.id - b.id).map((t) => t.name)) === JSON.stringify(teamNames), `${theme}: squadre create con i nomi dello stile (${teamNames.join(', ')})`);
      const tokens = [];
      for (const [i, name] of ['Silvia', 'Giorgia', 'Luca', 'Marta', 'Paolo'].entries()) {
        const j = await call(api, 'POST', `/games/${sess.code}/players`, { name, team_id: [tids[1], tids[2], tids[0], tids[1], tids[2]][i] });
        tokens.push(j.player_token);
      }
      await h.waitForTimeout(1800);
      await settle(h);
      await h.screenshot({ path: `${SHOTS}/T-${theme}-2-lobby.png`, fullPage: true });
      await h.context().close();
      await call(api, 'POST', `/games/${sess.code}/start`, { dealer_player_id: sess.playerId }, sess.token);
      for (const pts of [[120, 85, -20], [300, 410, 150], [90, 60, 260]]) {
        for (const [i, tid] of tids.entries()) await call(api, 'PUT', `/games/${sess.code}/hands/current/scores/${tid}`, { points: pts[i] }, sess.token);
      }

      // 3. telefono di un giocatore
      const pl = await open(browser, PHONE, { code: sess.code, token: tokens[0], isMaster: false });
      await pl.waitForSelector('[data-act="send"]');
      ok(await pl.evaluate(() => document.body.dataset.theme) === theme, `${theme}: il telefono del giocatore usa lo stile della partita`);
      await settle(pl);
      await checkFits(pl, `${theme} giocatore`);
      await pl.screenshot({ path: `${SHOTS}/T-${theme}-3-player.png` });
      await pl.context().close();

      // 4. tabellone in orizzontale (classifica e andamento) e su tablet in verticale
      const m = await open(browser, LAND, { code: sess.code, token: sess.token, isMaster: true });
      await m.waitForSelector('.bd-top');
      ok(await m.evaluate(() => document.body.dataset.theme) === theme, `${theme}: tabellone a tema`);
      if (theme !== 'classico') {
        ok(await m.locator('.bd .ttl .tico').count() === 3, `${theme}: emoji delle squadre sul tabellone`);
        ok(await m.locator('.fx span').count() > 0 && await m.evaluate(() => getComputedStyle(document.querySelector('.fx')).display !== 'none'), `${theme}: particelle di sottofondo attive`);
      } else ok(await m.locator('.fx').count() === 0 && await m.locator('.tico').count() === 0, 'classico: niente emoji né particelle');
      for (const slide of [0, 1]) {
        await m.locator(`[data-act="slide"][data-arg="${slide}"]`).click();
        await settle(m);
        await checkFits(m, `${theme} tabellone vista ${slide}`);
        await m.screenshot({ path: `${SHOTS}/T-${theme}-4-board-${slide}.png` });
      }
      // annuncio di fine mano
      await call(api, 'PUT', `/games/${sess.code}/hands/current/scores/${tids[0]}`, { points: 40 }, sess.token);
      await call(api, 'PUT', `/games/${sess.code}/hands/current/scores/${tids[1]}`, { points: 25 }, sess.token);
      await call(api, 'PUT', `/games/${sess.code}/hands/current/scores/${tids[2]}`, { points: 70 }, sess.token);
      await m.waitForSelector('.banner', { timeout: 5000 });
      await m.screenshot({ path: `${SHOTS}/T-${theme}-5-banner.png` });
      await m.context().close();
      const tv = await open(browser, TAB_V, { code: sess.code, token: sess.token, isMaster: true });
      await tv.waitForSelector('.pstand');
      await settle(tv);
      await checkFits(tv, `${theme} tablet verticale`);
      await tv.screenshot({ path: `${SHOTS}/T-${theme}-6-tablet.png` });
      await tv.context().close();

      // 5. vittoria
      await call(api, 'POST', `/games/${sess.code}/finish`, {}, sess.token);
      const v = await open(browser, LAND, { code: sess.code, token: sess.token, isMaster: true });
      await v.waitForSelector('.win');
      await settle(v);
      await checkFits(v, `${theme} vittoria`);
      if (theme !== 'classico') ok(await v.locator('.confetti.emo').count() > 0, `${theme}: coriandoli a tema`);
      await v.screenshot({ path: `${SHOTS}/T-${theme}-7-win.png` });
      // rivincita: stesso stile
      await v.locator('[data-act="rematch"]').click();
      await v.waitForSelector('.codetiles');
      ok(await v.evaluate(() => document.body.dataset.theme) === theme, `${theme}: la rivincita mantiene lo stile`);
      await v.context().close();
    }
    // stile ricordato per la partita successiva, anche nella schermata iniziale
    const h = await open(browser, PHONE, null);
    await h.evaluate(() => localStorage.setItem('pinella:setup', JSON.stringify({ format: '2v2', target: 1500, theme: 'mare' })));
    await h.reload();
    await h.waitForSelector('.logo.big');
    ok(await h.evaluate(() => document.body.dataset.theme) === 'mare', 'la schermata iniziale ricorda l\'ultimo stile scelto');
    await settle(h);
    await h.screenshot({ path: `${SHOTS}/T-home-mare.png` });
    await h.context().close();

    ok(errors.length === 0, 'nessun errore JavaScript' + (errors.length ? ': ' + errors.join(' | ') : ''));
    if (process.env.CONTRAST) console.log(JSON.stringify(report, null, 1));
    console.log(`\nTutti i ${passed} controlli superati.`);
  } finally {
    await browser.close();
    await api.dispose();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
