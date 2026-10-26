# Pinella

Tabellone per partite a carte con amici e famiglia. PWA + API PHP + MariaDB.
Ospitata nello stesso spazio Netsons di Gruzzolo: **https://gruzzolo.netsons.org/pinella/**

- Specifica delle API: [`docs/api.md`](docs/api.md)
- Schema del database: [`database/schema.sql`](database/schema.sql)
- Prototipo giocabile (solo browser, logica simulata): [`prototype/pinella-prototipo.html`](prototype/pinella-prototipo.html)

## Come si usa

1. Il master apre **https://gruzzolo.netsons.org/pinella/**, tocca «Crea una partita», sceglie formato e traguardo.
2. Gli altri inquadrano il QR (o aprono il link e digitano il codice di 4 caratteri), scrivono il nome e scelgono la squadra.
3. Il master tocca «Inizia la partita», gira il telefono in orizzontale e lo appoggia sul tavolo: diventa il tabellone (schermo sempre acceso, schermo intero con il tasto in alto).
4. A ogni mano ogni squadra segna i suoi punti dal proprio telefono, oppure il master dal tasto «Punti». Quando tutte hanno inserito, la mano si chiude da sola.
5. A fine partita: «Rivincita» crea una nuova partita e tutti ci rientrano in automatico.

Su Android e iPhone si può aggiungere alla schermata Home (menu del browser › «Aggiungi a schermata Home») e si apre come un'app.

## Convivenza con Gruzzolo

| | Gruzzolo | Pinella |
|---|---|---|
| Cartella web | `public_html/` | `public_html/pinella/` |
| Codice PHP e config | – | `/home/<utente>/pinella-app/` (fuori dal web) |
| Tabelle | `gz_*` (quando migrerà a MySQL) | `pin_*` |

Accorgimenti, visto che le due app condividono dominio e database:
- tutte le tabelle di Pinella hanno il prefisso `pin_` (configurabile in `config.php`, deve coincidere con `schema.sql`); le query toccano solo quelle;
- le API non usano cookie: l'identità del giocatore viaggia nell'header `X-Player-Token`;
- le risposte delle API hanno intestazioni restrittive (`nosniff`, nessun frame, CSP `default-src 'none'`);
- il frontend userà chiavi del localStorage con prefisso `pinella:` e non leggerà mai quelle di Gruzzolo;
- `public/.htaccess` blocca l'elenco dei file e i file sensibili (`.sql`, `.md`, file nascosti) dentro `/pinella/`.

## Struttura del repository

```
public/            → va in public_html/pinella/   (l'unica parte esposta al web)
  index.html, app.js, app.css   la PWA (telefono del master e dei giocatori)
  manifest.webmanifest, sw.js, icons/   installazione come app
  vendor/qrcode.js generatore di QR code (MIT, Kazuhiko Arase)
  .htaccess
  api/index.php    front controller delle API
  api/.htaccess
  _app/.htaccess   blocca tutto: serve per tenere src/ e config/ dentro la sottocartella
src/               logica: GameService (regole), Db, Auth, Http, Validate
config/            config.example.php → copiare in config.php (non versionare)
database/          schema.sql (tabelle con prefisso pin_)
tools/             server di sviluppo e test end-to-end
prototype/         prototipo giocabile in un solo file HTML
```

## Sviluppo in locale

Serve PHP 8.1+ con `pdo_mysql` e un MariaDB/MySQL.

```bash
# 1. database
mysql -u root -e "CREATE DATABASE pinella CHARACTER SET utf8mb4"
mysql -u root pinella < database/schema.sql

# 2. configurazione
cp config/config.example.php config/config.php   # utente/password, base_url http://localhost:8080, debug true

# 3. server
php -S localhost:8080 -t public tools/dev-router.php

# 4. test delle API: partita 2·2·2 completa, formati a singoli, casi limite
python3 tools/smoke_test.py

# 5. test della PWA: master + 3 giocatori su telefoni simulati (richiede Playwright)
node tools/e2e_pwa.js
node tools/e2e_chiusura.js   # chiusura automatica dell'inserimento punti (4 telefoni)
node tools/e2e_mazziere.js   # turni del mazziere: scelta, rotazione, correzione, annulla
node tools/e2e_carosello.js  # pausa del carosello del tabellone (circa 45 secondi)
node tools/e2e_timer.js     # timer della mano (anche con l'orologio del telefono sbagliato)
```

Apri http://localhost:8080/ nel browser: con gli strumenti per sviluppatori in modalità telefono puoi aprire più schede, una per "telefono".

Su Windows gli stessi comandi funzionano da PowerShell (usa `copy` al posto di `cp`).

## Deploy su Netsons, accanto a Gruzzolo

1. **Database** – nel database già usato per Gruzzolo apri *phpMyAdmin* e importa `database/schema.sql`. Crea solo tabelle `pin_*`: quelle di Gruzzolo non vengono toccate.
2. **PHP** – nel pannello: PHP 8.1 o superiore, estensione `pdo_mysql` attiva.
3. **File** – via FTP:
   ```
   public/*            →  /home/<utente>/public_html/pinella/
   src/  e  config/    →  /home/<utente>/pinella-app/src   e   /home/<utente>/pinella-app/config
   ```
   **Piano B** – se l'FTP del piano gratuito non permette di uscire da `public_html`: carica `src/` e `config/` dentro `public_html/pinella/_app/`. Il file `_app/.htaccess` ne blocca l'accesso dal web e `index.php` li trova da solo.

   **Aggiornamenti** – per una nuova versione basta ricaricare i file cambiati (vedi *Versione e rilascio*). `index.html`, `app.js` e `app.css` non vengono tenuti in cache, quindi i telefoni prendono la versione nuova alla prossima apertura; chi ha l'app già aperta vede la barra "Nuova versione disponibile" con il pulsante **Aggiorna**.
4. **Config** – crea `config.php` da `config.example.php`: stessi dati del database di Gruzzolo, `table_prefix` = `pin_`, `base_url` = `https://gruzzolo.netsons.org/pinella`, `debug` = `false`.
5. **HTTPS** – serve anche per tenere lo schermo acceso (Wake Lock) e per la PWA.
6. **Verifica**
   - `https://gruzzolo.netsons.org/pinella/api/health` → `{"ok":true,"version":"X.Y.Z",...}`, con la versione appena caricata
   - Gruzzolo si apre ancora normalmente
   - piano B: `https://gruzzolo.netsons.org/pinella/_app/config/config.php` deve rispondere **403**
   - test completo contro il server vero (crea qualche partita di prova, cancellabile da phpMyAdmin):
     ```bash
     python3 tools/smoke_test.py https://gruzzolo.netsons.org/pinella
     ```

## Versione e rilascio

La versione (semver `X.Y.Z`) compare nell'app (home, sale d'attesa, fine partita), in `/api/health` e nell'header `X-Pinella-Version` di ogni risposta delle API. Se un telefono ha l'app aperta durante un deploy, al primo polling vede che il server è cambiato e propone di ricaricare.

La versione è scritta in quattro punti che devono restare allineati: `src/Version.php`, `public/app.js`, `public/index.html` (parametro `?v=` degli asset) e `public/sw.js` (nome della cache). Non si modifica a mano:

```bash
python3 tools/set_version.py 0.2.0     # imposta la nuova versione ovunque
python3 tools/set_version.py --check   # controlla che sia allineata
```

Per un rilascio: imposta la versione, committa, carica **sia** `public/` **sia** `src/`, poi controlla `/api/health`. Se carichi solo una delle due parti, le versioni non coincidono e i telefoni continuano a proporre l'aggiornamento.

### Migrazioni del database

Quando una versione cambia la struttura del database, in `database/migrations/` c'è un file `NNN_nome.sql` da eseguire **una volta**, in phpMyAdmin (scheda *SQL* o *Importa*) sul database con le tabelle `pin_*`, **prima** di caricare i file della nuova versione. `database/schema.sql` è sempre già aggiornato: serve solo per un'installazione da zero.

| Versione | Migrazione | Cosa cambia |
|---|---|---|
| 0.4.0 | `002_mazziere.sql` | mazziere di ogni mano; stato `suspended` riservato allo storico |

## Da verificare sul piano gratuito

Con il polling ogni 1,5 s per telefono contano i limiti di **processi PHP contemporanei** e di **richieste al minuto**. Con 6 telefoni sono circa 4 richieste al secondo, quasi tutte risposte 304 vuote.

## Prossimi passi

- Pulizia automatica delle partite vecchie (cron, se il piano lo consente)
- Fase 2: account, foto con umore, messaggi e GIF, statistiche
