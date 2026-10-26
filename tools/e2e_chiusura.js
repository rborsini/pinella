// Test end-to-end della chiusura automatica dell'inserimento punti (issue #3):
// pannello del master, telefono del giocatore, invio in ritardo rifiutato dal server, annulla.
// Uso:  node tools/e2e_chiusura.js [base_url]      (richiede playwright)
const { chromium } = require('playwright');
const SHOTS = process.env.SHOTS || '/tmp';
const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/$/, '') + '/';
const ok = (c, l) => { if (!c) throw new Error('FALLITO: ' + l); console.log('  ok  ' + l); };
const errors = [];

async function phone(browser, name, landscape = false) {
  const ctx = await browser.newContext({ viewport: landscape ? { width: 844, height: 390 } : { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return p;
}
const tap = (p, sel) => p.locator(sel).first().click();
async function typePoints(p, who, n) { for (const ch of String(n)) await tap(p, `[data-act="key"][data-who="${who}"][data-arg="${ch}"]`); }
async function send(p, n) { await typePoints(p, 'p', n); await tap(p, '[data-act="send"][data-who="p"]'); await p.waitForSelector('text=Inviato'); }
const handOf = async (p) => Number((await p.locator('.lbl').first().innerText()).replace(/\D/g, ''));
const totals = (p) => p.evaluate(async () => {
  const s = JSON.parse(localStorage.getItem('pinella:session'));
  const st = await (await fetch(`api/games/${s.code}/state`, { headers: { 'X-Player-Token': s.token } })).json();
  return { hand: st.current_hand.number, scored: st.current_hand.scores.filter((x) => x.points != null).length, hands: st.hands.length };
});

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  try {
    const master = await phone(browser, 'master');
    await master.goto(BASE);
    await tap(master, '[data-act="go"][data-arg="setup"]');
    await master.fill('#setupName', 'Rob');
    await tap(master, '[data-act="fmt"][data-arg="4x1"]');
    await tap(master, '[data-act="create"]');
    await master.waitForSelector('.codetiles');
    const code = (await master.locator('.codetiles').innerText()).replace(/\s/g, '');
    const P = [];
    for (const name of ['Silvia', 'Giorgia', 'Luca']) {
      const p = await phone(browser, name);
      await p.goto(`${BASE}?join=${code}`);
      await p.fill('#joinName', name);
      await tap(p, '[data-act="join"]');
      await p.waitForSelector('text=Sei dentro!');
      P.push(p);
    }
    await master.waitForFunction(() => document.querySelectorAll('.pchip:not(.free)').length === 4, null, { timeout: 5000 });
    await tap(master, '[data-act="start"]');
    await master.setViewportSize({ width: 844, height: 390 });
    await master.waitForSelector('.bd');
    for (const p of P) await p.waitForSelector('text=Mano 1');

    console.log('1. Pannello del master aperto, la mano si chiude dai telefoni');
    await send(P[0], 100);
    await send(P[1], 80);
    await master.waitForTimeout(1700);
    await tap(master, '[data-act="openEntry"]');
    await master.waitForSelector('.entry');
    await tap(master, `[data-act="pickTeam"]:has-text("Luca")`);
    await typePoints(master, 'm', 55);                    // il master sta scrivendo i punti di Luca…
    ok((await master.locator('.entry .num').innerText()) === '55', 'il master sta scrivendo 55 per Luca');
    await send(P[2], 60);                                  // …ma Luca li manda dal suo telefono
    // manca ancora Rob: la mano non è chiusa, il pannello deve restare aperto
    await master.waitForTimeout(2000);
    ok(await master.locator('.entry').count() === 1, 'mano ancora aperta: il pannello resta aperto');
    await tap(master, `[data-act="pickTeam"]:has-text("Rob")`);
    await typePoints(master, 'm', 40);
    await tap(master, '[data-act="send"][data-who="m"]');  // il master chiude la mano da sé: nessun avviso
    await master.waitForSelector('.banner');
    ok(await master.locator('.entry').count() === 0 && await master.locator('.toast').count() === 0, 'chiusura fatta dal master: pannello chiuso, nessun avviso in più');

    console.log('2. Mano 2: il master ha il pannello aperto con punti a metà, gli altri chiudono la mano');
    // il master inserisce per Rob, poi apre il pannello e inizia a scrivere per Luca
    await master.waitForTimeout(3200);
    await tap(master, '[data-act="openEntry"]');
    await typePoints(master, 'm', 30);
    await tap(master, '[data-act="send"][data-who="m"]');  // Rob = 30, il pannello passa a Silvia
    await tap(master, `[data-act="pickTeam"]:has-text("Luca")`);
    await typePoints(master, 'm', 77);
    for (const [i, p] of P.entries()) { await p.waitForSelector('text=Mano 2'); await send(p, 10 + i); }
    await master.waitForSelector('.entry', { state: 'detached', timeout: 5000 });
    ok(true, 'il pannello del master si chiude da solo');
    await master.waitForSelector('.toast', { timeout: 3000 });
    const t2 = await master.locator('.toast').innerText();
    ok(t2.includes('non sono stati inviati'), `avviso al master: "${t2}"`);
    await master.screenshot({ path: `${SHOTS}/c-master-toast.png` });
    await tap(master, '[data-act="openEntry"]');
    ok((await master.locator('.entry .num').innerText()) === '0', 'riaprendo il pannello della mano 3 i 77 sono stati scartati');
    await tap(master, '[data-act="closeEntry"]');
    let st = await totals(master);
    ok(st.hand === 3 && st.scored === 0, 'nella mano 3 non è finito nessun punto');

    console.log('3. Un giocatore sta scrivendo, la mano si chiude per i punti degli altri');
    await master.waitForTimeout(3000);
    await typePoints(P[2], 'p', 123);                      // Luca scrive ma non invia
    await send(P[0], 5); await send(P[1], 6);
    await tap(master, '[data-act="openEntry"]');
    await tap(master, `[data-act="pickTeam"]:has-text("Rob")`); await typePoints(master, 'm', 7); await tap(master, '[data-act="send"][data-who="m"]');
    await tap(master, `[data-act="pickTeam"]:has-text("Luca")`); await typePoints(master, 'm', 8); await tap(master, '[data-act="send"][data-who="m"]');
    await P[2].waitForSelector('text=Mano 4', { timeout: 5000 });
    await P[2].waitForSelector('.toast', { timeout: 3000 });
    const t3 = await P[2].locator('.toast').innerText();
    ok(t3.includes('Mano 3 chiusa') && t3.includes('non sono stati inviati'), `avviso a Luca: "${t3}"`);
    ok((await P[2].locator('[data-act="send"]').isDisabled()) && (await P[2].locator('.display .num').innerText()) === '0', 'il 123 di Luca è stato scartato, Invia disattivato');
    await P[2].screenshot({ path: `${SHOTS}/c-player-toast.png` });
    const t0 = await P[0].locator('.toast').innerText().catch(() => '');
    ok(t0.includes('Mano 3 chiusa') && !t0.includes('non sono'), `avviso semplice a chi aveva già inviato: "${t0}"`);
    await P[2].waitForSelector('.toast', { state: 'detached', timeout: 6000 });
    ok(true, 'l\'avviso sparisce da solo');

    console.log('4. Corsa: il telefono non ha ancora saputo della chiusura e preme Invia');
    await master.waitForTimeout(3000);
    await P[2].route('**/api/games/*/state', (r) => r.abort());   // Luca non riceve più aggiornamenti
    await P[2].waitForTimeout(1600);
    await typePoints(P[2], 'p', 321);
    await send(P[0], 1); await send(P[1], 2);
    await tap(master, '[data-act="openEntry"]');
    await tap(master, `[data-act="pickTeam"]:has-text("Rob")`); await typePoints(master, 'm', 3); await tap(master, '[data-act="send"][data-who="m"]');
    await tap(master, `[data-act="pickTeam"]:has-text("Luca")`); await typePoints(master, 'm', 4); await tap(master, '[data-act="send"][data-who="m"]');
    await master.waitForSelector('.banner');
    ok(await handOf(P[2]) === 4, 'Luca vede ancora la mano 4 (chiusa sul server)');
    await P[2].unroute('**/api/games/*/state');
    await tap(P[2], '[data-act="send"][data-who="p"]');
    await P[2].waitForSelector('.toast', { timeout: 3000 });
    const t4 = await P[2].locator('.toast').innerText();
    ok(t4.includes('già stata chiusa'), `il server rifiuta e Luca è avvisato: "${t4}"`);
    await P[2].waitForSelector('text=Mano 5', { timeout: 5000 });
    st = await totals(master);
    ok(st.hand === 5 && st.scored === 0, 'il 321 non è finito nella mano 5');

    console.log('5. Il master annulla l\'ultima mano');
    await master.waitForTimeout(3500);
    await tap(master, '[data-act="undo"]');
    await P[0].waitForFunction(() => /riaperto la mano 4/.test(document.querySelector('.toast')?.innerText || ''), null, { timeout: 6000 });
    ok(await handOf(P[0]) === 4, 'i giocatori tornano alla mano 4');
    ok(true, 'e sanno che il master l\'ha riaperta');
    await P[0].screenshot({ path: `${SHOTS}/c-undo-toast.png` });

    ok(errors.length === 0, 'nessun errore JavaScript' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
  }
})().then(() => console.log('\nTutti i controlli superati.')).catch((e) => { console.error(e.message); process.exit(1); });
