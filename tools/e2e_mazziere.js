// Test end-to-end dei turni del mazziere (issue #4): scelta in sala d'attesa, rotazione,
// indicazione su tabellone e telefoni, correzione del master, annulla.
// Uso:  node tools/e2e_mazziere.js [base_url]      (richiede playwright)
const { chromium } = require('playwright');
const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/$/, '') + '/';
const SHOTS = process.env.SHOTS || '/tmp';
const errors = [];
let passed = 0;
const ok = (c, l) => { if (!c) throw new Error('FALLITO: ' + l); passed++; console.log('  ok  ' + l); };

async function phone(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return p;
}
const tap = (p, sel) => p.locator(sel).first().click();
async function send(p, n) {
  for (const ch of String(n)) await tap(p, `[data-act="key"][data-who="p"][data-arg="${ch}"]`);
  await tap(p, '[data-act="send"][data-who="p"]');
  await p.waitForSelector('text=Inviato');
}
const text = (p, sel) => p.locator(sel).first().innerText();

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  try {
    console.log('Sala d\'attesa: 2 vs 2');
    const master = await phone(browser, 'master');
    await master.goto(BASE);
    await tap(master, '[data-act="go"][data-arg="setup"]');
    await master.fill('#setupName', 'Rob');
    await tap(master, '[data-act="fmt"][data-arg="2v2"]');
    await tap(master, '[data-act="create"]');
    await master.waitForSelector('.codetiles');
    const code = (await text(master, '.codetiles')).replace(/\s/g, '');
    const P = {};
    for (const name of ['Silvia', 'Giorgia', 'Luca']) {
      const p = await phone(browser, name);
      await p.goto(`${BASE}?join=${code}`);
      await p.fill('#joinName', name);
      await tap(p, '[data-act="join"]');
      await p.waitForSelector('text=Sei dentro!');
      P[name] = p;
    }
    await master.waitForFunction(() => document.querySelectorAll('[data-act="dealerPick"]').length === 4, null, { timeout: 5000 });
    const names = await master.locator('[data-act="dealerPick"]').allInnerTexts();
    ok(names.length === 4, `scelta del mazziere tra i 4 giocatori, nel giro: ${names.join(', ')}`);
    ok(await master.locator('[data-act="start"]').isDisabled(), 'senza mazziere non si può iniziare');
    ok((await text(master, '[data-act="start"]')).includes('Scegli chi dà le carte'), 'il pulsante dice cosa manca');
    await tap(master, '[data-act="dealerPick"]:has-text("Giorgia")');
    const giro = await text(master, '.stack:has(.dpill) > span.small');
    ok(giro.startsWith('Poi il mazzo gira verso destra: Giorgia'), `giro mostrato: "${giro}"`);
    const order = giro.replace(/^.*: /, '').split(' → ');
    await master.screenshot({ path: `${SHOTS}/m-lobby.png`, fullPage: true });

    console.log('Mano 1');
    await tap(master, '[data-act="start"]');
    await master.setViewportSize({ width: 844, height: 390 });
    await master.waitForSelector('.dealer');
    ok((await text(master, '.dealer')).includes(`dà le carte ${order[0]}`) && (await text(master, '.dealer')).includes(`poi ${order[1]}`), `tabellone: "${await text(master, '.dealer')}"`);
    await P.Giorgia.waitForSelector('.deal.me');
    ok((await text(P.Giorgia, '.deal')).includes('Tocca a te dare le carte'), 'Giorgia: "Tocca a te dare le carte"');
    await P.Silvia.waitForSelector('.deal');
    ok((await text(P.Silvia, '.deal')).includes('Dà le carte Giorgia'), 'gli altri vedono chi dà le carte');
    await P.Giorgia.screenshot({ path: `${SHOTS}/m-phone-me.png` });

    console.log('Rotazione');
    const teamOf = {};
    for (const [n, p] of Object.entries(P)) teamOf[n] = await text(p, 'h1');
    // un telefono per squadra chiude la mano
    const senders = [];
    for (const [n, t] of Object.entries(teamOf)) if (!senders.some((x) => teamOf[x] === t)) senders.push(n);
    const masterTeamMissing = senders.length < 2;
    for (const n of senders) await send(P[n], 50);
    if (masterTeamMissing) {
      await tap(master, '[data-act="openEntry"]');
      for (const ch of '50') await tap(master, `[data-act="key"][data-who="m"][data-arg="${ch}"]`);
      await tap(master, '[data-act="send"][data-who="m"]');
    }
    await master.waitForSelector('.banner');
    ok((await text(master, '.banner')).includes(`Ora dà le carte ${order[1]}`), `annuncio: "${(await text(master, '.banner')).replace(/\n/g, ' · ')}"`);
    await master.screenshot({ path: `${SHOTS}/m-banner.png` });
    ok((await text(master, '.dealer')).includes(`dà le carte ${order[1]}`), `mano 2: il mazzo passa a ${order[1]}`);
    if (P[order[1]]) {
      await P[order[1]].waitForSelector('.deal.me');
      ok(true, `${order[1]} vede che ora tocca a lui/lei`);
    }

    console.log('Correzione del master');
    await master.waitForTimeout(3000);
    await tap(master, '[data-act="dealerOpen"]');
    await master.waitForSelector('.dlist');
    ok(await master.locator('.dlist button').count() === 4, 'pannello con i 4 giocatori');
    await master.screenshot({ path: `${SHOTS}/m-correct.png` });
    await tap(master, `.dlist button:has-text("${order[3]}")`);
    await master.waitForSelector('.dlist', { state: 'detached' });
    ok((await text(master, '.dealer')).includes(`dà le carte ${order[3]}`) && (await text(master, '.dealer')).includes(`poi ${order[0]}`), `corretto: dà ${order[3]}, poi ${order[0]}`);
    if (P[order[3]]) { await P[order[3]].waitForSelector('.deal.me'); ok(true, `${order[3]} riceve il cambio sul telefono`); }

    console.log('Annulla');
    await tap(master, '[data-act="undo"]');      // mano 2 vuota: si torna alla mano 1, chiusa con Giorgia
    await master.waitForFunction(() => /Mano 1/.test(document.querySelector('.hand')?.innerText || ''), null, { timeout: 5000 });
    ok((await text(master, '.dealer')).includes(`dà le carte ${order[0]}`), `torna la mano 1 con il suo mazziere (${order[0]})`);

    ok(errors.length === 0, 'nessun errore JavaScript' + (errors.length ? ': ' + errors.join(' | ') : ''));
    console.log(`\nTutti i ${passed} controlli superati.`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
