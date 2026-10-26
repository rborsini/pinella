// Test end-to-end della pausa del carosello del tabellone (issue #5).
// Uso:  node tools/e2e_carosello.js [base_url]      (richiede playwright)
const { chromium } = require('playwright');
const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/$/, '') + '/';
const SHOTS = process.env.SHOTS || '/tmp';
const errors = [];
let passed = 0;
const ok = (c, l) => { if (!c) throw new Error('FALLITO: ' + l); passed++; console.log('  ok  ' + l); };
const tap = (p, sel) => p.locator(sel).first().click();
const slide = (p) => p.locator('.stab.on[data-act="slide"]').innerText();

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  try {
    const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const m = await ctx.newPage();
    m.on('pageerror', (e) => errors.push(e.message));
    await m.goto(BASE);
    await tap(m, '[data-act="go"][data-arg="setup"]');
    await m.fill('#setupName', 'Rob');
    await tap(m, '[data-act="fmt"][data-arg="1v1"]');
    await tap(m, '[data-act="create"]');
    await m.waitForSelector('#manualName');
    await m.fill('#manualName', 'Silvia');
    await tap(m, '[data-act="manual"]');
    await m.waitForSelector('[data-act="dealerPick"]:has-text("Silvia")');
    await tap(m, '[data-act="dealerPick"]');
    await tap(m, '[data-act="start"]');
    await m.waitForSelector('.bd .tcard');

    // una mano giocata, così grafico e tabella hanno qualcosa da mostrare
    const hand = async (a, b) => {
      await tap(m, '[data-act="openEntry"]');
      for (const [pts, who] of [[a, 'Rob'], [b, 'Silvia']]) {
        await tap(m, `[data-act="pickTeam"]:has-text("${who}")`);
        for (const ch of String(pts)) await tap(m, `[data-act="key"][data-who="m"][data-arg="${ch}"]`);
        await tap(m, '[data-act="send"][data-who="m"]');
      }
      await m.waitForSelector('.banner');
    };
    await hand(120, 80);
    await m.waitForSelector('.banner', { state: 'detached', timeout: 6000 });

    console.log('Avanzamento automatico');
    ok(await slide(m) === 'Classifica', 'si parte dalla classifica');
    ok(await m.locator('.stab.on .sprog').count() === 1, 'barra di avanzamento sotto la scheda attiva');
    await m.waitForFunction(() => document.querySelector('.stab.on[data-act="slide"]').innerText === 'Andamento', null, { timeout: 10000 });
    ok(true, 'dopo 8 secondi passa ad Andamento');
    await m.waitForTimeout(4000);
    const w = await m.locator('.stab.on .sprog').evaluate((el) => el.getBoundingClientRect().width / el.parentElement.getBoundingClientRect().width);
    ok(w > 0.3 && w < 0.8, `a metà giro la barra è a metà (${Math.round(w * 100)}%)`);
    await m.screenshot({ path: `${SHOTS}/k-progress.png` });

    console.log('Pausa');
    await tap(m, '[data-act="carouselPause"]');
    ok(await m.locator('.spause.on[aria-pressed="true"]').count() === 1, 'pulsante in pausa (evidenziato)');
    ok(await m.locator('.sprog').count() === 0, 'in pausa la barra sparisce');
    await m.screenshot({ path: `${SHOTS}/k-paused.png` });
    await m.waitForTimeout(9500);
    ok(await slide(m) === 'Andamento', 'dopo 9,5 secondi resta su Andamento');
    await tap(m, '[data-act="slide"][data-arg="2"]');
    await m.waitForTimeout(9000);
    ok(await slide(m) === 'Mani', 'in pausa si può cambiare scheda e ci si resta');

    console.log('Fine mano in pausa');
    await hand(30, 40);
    ok(await slide(m) === 'Mani', 'alla chiusura della mano resta sulla vista scelta (Mani)');
    ok((await m.locator('.htable tbody tr').count()) >= 3, 'la tabella mostra la mano appena chiusa');

    console.log('Pausa ricordata');
    await m.reload();
    await m.waitForSelector('.bd');
    ok(await m.locator('.spause.on').count() === 1, 'dopo il ricaricamento il carosello è ancora in pausa');

    console.log('Ripresa');
    await tap(m, '[data-act="slide"][data-arg="0"]');
    await tap(m, '[data-act="carouselPause"]');
    ok(await m.locator('.spause.on').count() === 0 && await m.locator('.stab.on .sprog').count() === 1, 'ripreso: torna la barra');
    await m.waitForFunction(() => document.querySelector('.stab.on[data-act="slide"]').innerText === 'Andamento', null, { timeout: 10000 });
    ok(true, 'e il carosello riparte');
    await m.screenshot({ path: `${SHOTS}/k-running.png` });

    ok(errors.length === 0, 'nessun errore JavaScript' + (errors.length ? ': ' + errors.join(' | ') : ''));
    console.log(`\nTutti i ${passed} controlli superati.`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
