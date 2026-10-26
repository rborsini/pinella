// Test end-to-end del timer della mano (issue #6): tabellone e telefoni, ripartenza a ogni mano,
// telefono con l'orologio sbagliato, tocchi sul tastierino mentre il timer scorre.
// Uso:  node tools/e2e_timer.js [base_url]      (richiede playwright)
const { chromium } = require('playwright');
const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/$/, '') + '/';
const SHOTS = process.env.SHOTS || '/tmp';
const errors = [];
let passed = 0;
const ok = (c, l) => { if (!c) throw new Error('FALLITO: ' + l); passed++; console.log('  ok  ' + l); };
const tap = (p, sel) => p.locator(sel).first().click();
const secs = async (p) => {
  const t = (await p.locator('[data-timer] b').first().innerText()).split(':').map(Number);
  return t.reduce((acc, x) => acc * 60 + x, 0);
};

async function phone(browser, name, { landscape = false, skewMs = 0 } = {}) {
  const ctx = await browser.newContext({ viewport: landscape ? { width: 844, height: 390 } : { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  if (skewMs) await ctx.addInitScript((ms) => { const n = Date.now; Date.now = () => n() + ms; }, skewMs);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return p;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  try {
    const m = await phone(browser, 'master');
    await m.goto(BASE);
    await tap(m, '[data-act="go"][data-arg="setup"]');
    await m.fill('#setupName', 'Rob');
    await tap(m, '[data-act="fmt"][data-arg="1v1"]');
    await tap(m, '[data-act="create"]');
    await m.waitForSelector('.codetiles');
    const code = (await m.locator('.codetiles').innerText()).replace(/\s/g, '');
    // Silvia ha l'orologio del telefono avanti di un'ora
    const p = await phone(browser, 'Silvia', { skewMs: 3600 * 1000 });
    await p.goto(`${BASE}?join=${code}`);
    await p.fill('#joinName', 'Silvia');
    await tap(p, '[data-act="join"]');
    await p.waitForSelector('text=Sei dentro!');
    ok(await m.locator('[data-timer]').count() === 0 && await p.locator('[data-timer]').count() === 0, 'in sala d\'attesa nessun timer');
    await m.waitForSelector('[data-act="dealerPick"]:has-text("Silvia")');
    await tap(m, '[data-act="dealerPick"]');
    await tap(m, '[data-act="start"]');
    await m.setViewportSize({ width: 844, height: 390 });
    await m.waitForSelector('.bd-top [data-timer]');
    await p.waitForSelector('[data-timer]');

    console.log('Timer in corso');
    ok(await secs(m) <= 2, `tabellone: parte da zero (${await m.locator('[data-timer] b').innerText()})`);
    await m.waitForTimeout(3200);
    const a = await secs(m), b = await secs(p);
    // il database registra l'apertura al secondo intero: il timer può essere indietro fino a 1 s
    ok(a >= 2 && a <= 5, `dopo 3 secondi il tabellone segna ${a} s`);
    ok(Math.abs(a - b) <= 1, `il telefono con l'orologio avanti di un'ora segna lo stesso tempo (${b} s)`);
    await m.screenshot({ path: `${SHOTS}/t-board.png` });
    await p.screenshot({ path: `${SHOTS}/t-phone.png` });

    console.log('Tastierino mentre il timer scorre');
    for (const ch of '123450') { await tap(p, `[data-act="key"][data-who="p"][data-arg="${ch}"]`); await p.waitForTimeout(260); }
    // 6 tocchi in 1,5 secondi: il campo accetta al massimo 5 cifre
    ok((await p.locator('.display .num').innerText()) === '12345', `nessun tocco perso mentre il timer scorre (${await p.locator('.display .num').innerText()})`);
    for (let i = 0; i < 5; i++) await tap(p, '[data-act="key"][data-who="p"][data-arg="del"]');
    for (const ch of '80') await tap(p, `[data-act="key"][data-who="p"][data-arg="${ch}"]`);
    await tap(p, '[data-act="send"][data-who="p"]');
    await p.waitForSelector('text=Inviato');

    console.log('Nuova mano');
    await m.waitForTimeout(1800);
    await tap(m, '[data-act="openEntry"]');
    await tap(m, '[data-act="pickTeam"]:has-text("Rob")');
    for (const ch of '50') await tap(m, `[data-act="key"][data-who="m"][data-arg="${ch}"]`);
    await tap(m, '[data-act="send"][data-who="m"]');
    await m.waitForFunction(() => /Mano 2/.test(document.querySelector('.hand')?.innerText || ''));
    ok(await secs(m) <= 1, 'mano 2: il timer del tabellone riparte da zero');
    await p.waitForSelector('text=Mano 2');
    await p.waitForTimeout(300);
    ok(await secs(p) <= 2, 'anche sul telefono');

    console.log('Fine partita');
    await tap(m, '[data-act="finish"]');
    await tap(m, '[data-act="finish"]');
    await m.waitForSelector('.win, .victory, [data-act="rematch"]');
    ok(await m.locator('[data-timer]').count() === 0, 'a partita finita il timer sparisce');

    ok(errors.length === 0, 'nessun errore JavaScript' + (errors.length ? ': ' + errors.join(' | ') : ''));
    console.log(`\nTutti i ${passed} controlli superati.`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
