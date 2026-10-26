// Test end-to-end della PWA: un master e tre giocatori su telefoni separati (contesti browser distinti).
// Uso:  node tools/e2e_pwa.js [base_url]      (richiede playwright)
const { chromium } = require('playwright');
const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/$/, '') + '/';
const SHOTS = process.env.SHOTS || '/tmp';

const errors = [];
let passed = 0;
function check(cond, label) {
  if (!cond) throw new Error('FALLITO: ' + label);
  passed++; console.log('  ok  ' + label);
}
async function phone(browser, name, landscape = false) {
  const ctx = await browser.newContext({
    viewport: landscape ? { width: 844, height: 390 } : { width: 390, height: 844 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|net::ERR|Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  page.label = name;
  return page;
}
const tap = (p, sel) => p.locator(sel).first().click();
async function typePoints(p, who, n) {
  for (const ch of String(Math.abs(n))) await tap(p, `[data-act="key"][data-who="${who}"][data-arg="${ch}"]`);
  if (n < 0) await tap(p, `[data-act="sign"][data-who="${who}"][data-arg="-"]`);
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  const master = await phone(browser, 'master');

  console.log('Creazione partita');
  await master.goto(BASE);
  const health = await (await master.request.get(BASE + 'api/health')).json();
  check((await master.locator('.ver').innerText()) === `Pinella v${health.version}`, `versione mostrata e uguale a quella del server (${health.version})`);
  await tap(master, '[data-act="go"][data-arg="setup"]');
  await master.fill('#setupName', 'Marco');
  check(await master.locator('.fmt').count() === 7, 'sette formati, inclusi 3 e 4 singoli');
  await tap(master, '[data-act="fmt"][data-arg="2v2"]');
  await tap(master, '[data-act="targetSet"][data-arg="1000"]');
  await tap(master, '[data-act="create"]');
  await master.waitForSelector('.codetiles');
  const code = (await master.locator('.codetiles').innerText()).replace(/\s/g, '');
  check(/^[A-Z0-9]{4}$/.test(code), `codice mostrato: ${code}`);
  check(await master.locator('svg[aria-label^="QR code"] rect').count() > 100, 'QR code reale generato');
  check((await master.locator('.pchip.master').innerText()).includes('Marco'), 'il master è già in una squadra');

  console.log('Ingresso dei giocatori (link del QR e codice)');
  const players = [];
  for (const name of ['Lucia', 'Paolo', 'Anna']) {
    const p = await phone(browser, name);
    if (name === 'Anna') {
      await p.goto(BASE);
      await tap(p, '[data-act="go"][data-arg="code"]');
      await p.fill('#codeInput', code.toLowerCase());
      await tap(p, '[data-act="codeNext"]');
    } else {
      await p.goto(`${BASE}?join=${code}`);
    }
    await p.waitForSelector('#joinName');
    await p.fill('#joinName', name);
    await tap(p, '[data-act="join"]');
    await p.waitForSelector('text=Sei dentro!');
    players.push(p);
  }
  check(true, 'tre giocatori entrati (due dal QR, una con il codice)');
  await master.waitForFunction(() => document.querySelectorAll('.pchip:not(.free)').length === 4, null, { timeout: 5000 });
  check(true, 'il master vede i 4 giocatori senza ricaricare');
  await master.screenshot({ path: `${SHOTS}/pwa-lobby.png` });

  // Prova di "squadra piena": un quinto giocatore non trova posti
  const late = await phone(browser, 'ritardatario');
  await late.goto(`${BASE}?join=${code}`);
  await late.waitForSelector('text=Tutte le squadre sono al completo');
  check(true, 'quinto giocatore: squadre al completo');

  console.log('Avvio');
  await tap(master, '[data-act="dealerPick"]');   // primo mazziere: il primo del giro
  await tap(master, '[data-act="start"]');
  await master.setViewportSize({ width: 844, height: 390 });
  await master.waitForSelector('.bd .tcard');
  check(await master.locator('.tcard').count() === 2, 'tabellone con 2 squadre');
  for (const p of players) await p.waitForSelector('text=Mano 1');
  check(true, 'i telefoni dei giocatori passano all\'inserimento punti');

  console.log('Mano 1: un giocatore e il master');
  const lucia = players[0];
  const luciaTeam = await lucia.locator('h1').innerText();
  await typePoints(lucia, 'p', 145);
  await tap(lucia, '[data-act="closedT"][data-who="p"]');
  await tap(lucia, '[data-act="send"][data-who="p"]');
  await lucia.waitForSelector('text=Inviato');
  await master.waitForFunction(() => document.querySelectorAll('.hdots i[style*="background:#"]').length === 1, null, { timeout: 5000 });
  check(true, `${luciaTeam}: punti inviati da Lucia, il tabellone segna 1 squadra su 2`);
  await tap(master, '[data-act="openEntry"]');
  await master.waitForSelector('.entry');
  await typePoints(master, 'm', 60);
  await tap(master, '[data-act="sign"][data-who="m"][data-arg="-"]');
  await tap(master, '[data-act="send"][data-who="m"]');
  await master.waitForSelector('.banner');
  check((await master.locator('.banner').innerText()).includes('Mano 1 chiusa'), 'annuncio "Mano 1 chiusa"');
  await master.screenshot({ path: `${SHOTS}/pwa-board.png` });
  for (const p of players) await p.waitForSelector('text=Mano 2', { timeout: 5000 });
  check(true, 'tutti i telefoni passano alla mano 2');

  console.log('Ricarica del telefono');
  await players[1].reload();
  await players[1].waitForSelector('text=Mano 2');
  check(true, 'dopo la ricarica Paolo rientra nella partita');
  await players[1].screenshot({ path: `${SHOTS}/pwa-phone.png` });

  console.log('Errore gestito: punti di un\'altra squadra non possibili dal telefono');
  // (il telefono segna solo la propria squadra: verifichiamo l'API direttamente)
  const forbidden = await lucia.evaluate(async (c) => {
    const s = JSON.parse(localStorage.getItem('pinella:session'));
    const st = await (await fetch(`api/games/${c}/state`, { headers: { 'X-Player-Token': s.token } })).json();
    const other = st.teams.find((t) => t.id !== st.me.team_id);
    const r = await fetch(`api/games/${c}/hands/current/scores/${other.id}`, { method: 'PUT', headers: { 'X-Player-Token': s.token, 'Content-Type': 'application/json' }, body: '{"points":10}' });
    return r.status;
  }, code);
  check(forbidden === 403, 'l\'API rifiuta i punti per un\'altra squadra (403)');

  console.log('Carosello');
  await tap(master, '[data-act="slide"][data-arg="1"]');
  check(await master.locator('svg.chart polyline').count() === 2, 'grafico andamento con 2 linee');
  await tap(master, '[data-act="slide"][data-arg="2"]');
  check(await master.locator('.htable tbody tr').count() === 3, 'tabella mani: mano 1, mano 2 in corso, totale');

  console.log('Fino alla vittoria');
  for (let i = 0; i < 6; i++) {
    const st = await master.evaluate(() => document.querySelector('.win') ? 'fine' : 'gioco');
    if (st === 'fine') break;
    await tap(master, '[data-act="openEntry"]');
    await typePoints(master, 'm', 300);
    await tap(master, '[data-act="send"][data-who="m"]');
    await typePoints(master, 'm', 100);
    await tap(master, '[data-act="send"][data-who="m"]');
    await master.waitForTimeout(400);
  }
  await master.waitForSelector('.win');
  check((await master.locator('.win h3').innerText()).startsWith('Vince'), 'schermata di vittoria sul tabellone');
  await master.screenshot({ path: `${SHOTS}/pwa-win.png` });
  for (const p of players) await p.waitForSelector('text=Classifica finale', { timeout: 5000 });
  check(true, 'i giocatori vedono la classifica finale');

  console.log('Rivincita');
  await tap(master, '[data-act="rematch"]');
  await master.setViewportSize({ width: 390, height: 844 });
  await master.waitForSelector('.codetiles');
  const code2 = (await master.locator('.codetiles').innerText()).replace(/\s/g, '');
  check(code2 !== code, `nuovo codice ${code2}`);
  for (const p of players) await p.waitForSelector('text=Sei dentro!', { timeout: 6000 });
  check(true, 'i giocatori entrano nella rivincita da soli');
  await master.waitForFunction(() => document.querySelectorAll('.pchip:not(.free)').length === 4, null, { timeout: 5000 });
  check(true, 'nella rivincita ci sono tutti e 4');

  console.log('Codice inesistente');
  const lost = await phone(browser, 'smarrito');
  await lost.goto(`${BASE}?join=ZZZZ`);
  await lost.waitForSelector('text=Il QR punta a una partita che non esiste più');
  check(true, 'messaggio chiaro per un QR scaduto');

  check(errors.length === 0, 'nessun errore JavaScript nei 6 telefoni' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log(`\nTutti i ${passed} controlli superati.`);
  await browser.close();
})().catch(async (e) => { console.error(e.message); console.error(errors.join('\n')); process.exit(1); });
