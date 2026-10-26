# Pinella – API MVP

API REST in JSON, PHP 8 + MariaDB su Netsons, nello stesso spazio e database di Gruzzolo.
Base URL: `https://gruzzolo.netsons.org/pinella/api`

Le tabelle hanno il prefisso `pin_` (vedi `database/schema.sql` e `table_prefix` in `config.php`).

## Concetti chiave

**Codice partita**: 4 caratteri (`KX7P`). Lettere maiuscole e cifre, escludendo quelle che si confondono (`0 O 1 I L`). Il QR contiene `https://gruzzolo.netsons.org/pinella/?join=KX7P`: apre l'app direttamente sulla schermata di ingresso.

**Token giocatore**: quando crei o entri in una partita, il server restituisce un token casuale (32 byte, esadecimale). Il telefono lo salva in `localStorage` e lo manda in ogni richiesta:

```
X-Player-Token: 9f2c…e81a
```

Nel DB si salva solo l'hash SHA-256. Senza account: il token *è* l'identità del giocatore in quella partita. Se il telefono si blocca o ricarica la pagina, il token resta e si rientra senza rifare nulla. Con la rivincita il giocatore tiene lo stesso token (l'unicità del token è per partita).

**Permessi**

| Chi | Può fare |
|---|---|
| Master | tutto: gestire giocatori e squadre, avviare, inserire/correggere qualsiasi punteggio, chiudere la partita |
| Giocatore | inserire/correggere il punteggio **della propria squadra** nella mano aperta, cambiare squadra in lobby |
| Senza token | leggere il riepilogo pubblico per la schermata di ingresso |

**Versione e polling**: ogni modifica fa `games.version = version + 1` nella stessa transazione. Lo stato si legge con un'unica chiamata che usa la versione come `ETag`. L'ETag contiene anche una finestra di 15 secondi, così ogni 15 s arriva comunque uno stato fresco e si aggiorna chi è collegato:

```
GET /api/games/KX7P/state
If-None-Match: "57-120543281"
→ 304 Not Modified                  (niente di nuovo, risposta vuota)
→ 200 + ETag: "58-120543281" + JSON (stato completo aggiornato)
```

Il client fa polling ogni **1,5 s** quando l'app è in primo piano, ogni **10 s** quando la pagina è nascosta (`visibilitychange`). La maggior parte delle risposte sarà un 304 da pochi byte.

**Errori**: sempre nella forma

```json
{ "error": "not_your_team", "message": "Puoi inserire solo i punti della tua squadra" }
```

| HTTP | Quando |
|---|---|
| 400 | dati non validi |
| 401 | token mancante o non valido |
| 403 | azione non permessa (non master, squadra sbagliata) |
| 404 | partita non trovata |
| 409 | conflitto di stato (es. partita già avviata, mano già chiusa) |

---

## Endpoint

### 1. Crea partita
`POST /api/games`

Il master crea la partita ed entra automaticamente come giocatore.

```json
{
  "master_name": "Marco",
  "format": "2v2v2",
  "target_score": 1500,
  "teams": [
    { "name": "Corallo",  "color": "#FF6B57", "size": 2 },
    { "name": "Turchese", "color": "#18C2B0", "size": 2 },
    { "name": "Sole",     "color": "#FFC22E", "size": 2 }
  ]
}
```

Formati predefiniti (il client precompila `teams`):

| format | squadre × giocatori |
|---|---|
| `1v1` | 2 × 1 |
| `2v2` | 2 × 2 |
| `3v3` | 2 × 3 |
| `2v2v2` | 3 × 2 |
| `3x1` | 3 × 1 |
| `4x1` | 4 × 1 |
| `5x1` | 5 × 1 |

Validazioni: 2–6 squadre, 1–4 giocatori per squadra, `target_score` tra 100 e 100 000.

**201**
```json
{ "code": "KX7P", "player_id": 1, "player_token": "9f2c…e81a", "join_url": "https://gruzzolo.netsons.org/pinella/?join=KX7P" }
```

### 2. Riepilogo pubblico (schermata di ingresso)
`GET /api/games/{code}`

Nessun token richiesto. Mostra cosa serve per scegliere la squadra.

```json
{
  "code": "KX7P",
  "master_name": "Marco",
  "format": "2v2v2",
  "target_score": 1500,
  "status": "lobby",
  "teams": [
    { "id": 11, "name": "Corallo", "color": "#FF6B57", "size": 2, "taken": 2 },
    { "id": 12, "name": "Turchese", "color": "#18C2B0", "size": 2, "taken": 2 },
    { "id": 13, "name": "Sole", "color": "#FFC22E", "size": 2, "taken": 0 }
  ]
}
```

### 3. Entra nella partita
`POST /api/games/{code}/players`

```json
{ "name": "Pia", "team_id": 13 }
```
`team_id` è facoltativo (se c'è il sorteggio lo decide il master).

**201** `{ "player_id": 5, "player_token": "…" }`
**409** se la squadra è piena o la partita è già finita. Entrare a partita **avviata** è permesso solo in una squadra con posti liberi (es. qualcuno arriva in ritardo).

### 4. Aggiungi giocatore a mano *(master)*
`POST /api/games/{code}/players/manual`

```json
{ "name": "Nonna Pia", "team_id": 13 }
```
Il giocatore non ha token: compare nel tabellone ma non può inserire punti (lo fa il master per lui).

### 5. Sposta un giocatore *(master; o il giocatore stesso in lobby)*
`PATCH /api/games/{code}/players/{player_id}`

```json
{ "team_id": 12 }
```

### 6. Rimuovi un giocatore *(master, solo in lobby)*
`DELETE /api/games/{code}/players/{player_id}`

### 7. Sorteggia le squadre *(master, solo in lobby)*
`POST /api/games/{code}/shuffle`

Mescola tutti i giocatori presenti e li distribuisce rispettando `size`.

### 8. Avvia la partita *(master)*
`POST /api/games/{code}/start`

Controlla che ogni squadra abbia almeno 1 giocatore, imposta `status = playing` e apre la mano 1.
**409** se la partita non è in lobby.

### 9. Stato completo (polling)
`GET /api/games/{code}/state` · header `If-None-Match` facoltativo

Usato sia dal tabellone del master sia dai telefoni dei giocatori. Il token è facoltativo: se presente, la risposta include `me`.

```json
{
  "code": "KX7P",
  "version": 58,
  "status": "playing",
  "target_score": 1500,
  "me": { "player_id": 5, "team_id": 13, "is_master": false },
  "teams": [
    {
      "id": 13, "name": "Sole", "color": "#FFC22E",
      "total": 1285, "rank": 1, "last_delta": 145,
      "gap_to_leader": 0, "to_target": 215,
      "players": [
        { "id": 5, "name": "Pia",  "online": true },
        { "id": 6, "name": "Gino", "online": true }
      ]
    },
    { "id": 11, "name": "Corallo", "color": "#FF6B57", "total": 1210, "rank": 2, "last_delta": 40, "gap_to_leader": 75, "to_target": 290, "players": [ ] }
  ],
  "current_hand": {
    "number": 7,
    "scores": [
      { "team_id": 11, "points": 120, "closed_hand": false, "entered_by": "Marco" },
      { "team_id": 12, "points": null },
      { "team_id": 13, "points": null }
    ]
  },
  "hands": [
    { "number": 1, "scores": { "11": 85, "12": -20, "13": 140 } },
    { "number": 2, "scores": { "11": 210, "12": 95, "13": 60 } }
  ],
  "events": [
    { "type": "overtake", "team_id": 13, "hand": 6 }
  ],
  "winner_team_id": null
}
```

Note:
- `online` = `last_seen_at` negli ultimi 15 s (ogni chiamata di polling con token aggiorna `last_seen_at`; per non scrivere a ogni richiesta, si aggiorna solo se è più vecchio di 10 s).
- `events` contiene gli eventi dell'**ultima mano chiusa** calcolati al volo: `overtake` (sorpasso in testa), `near_target` (una squadra a meno del 15 % dal traguardo), `best_hand` (mano più alta della partita). Il tabellone li usa per i badge.
- `hands` serve al grafico "Andamento" e alla schermata finale.

### 10. Inserisci o correggi il punteggio della mano aperta
`PUT /api/games/{code}/hands/current/scores/{team_id}`

```json
{ "points": 145, "closed_hand": true, "hand_number": 3 }
```

- Giocatore: solo per la propria squadra. Master: per qualsiasi squadra.
- Si può riscrivere finché la mano è aperta (l'ultimo inserimento vince).
- `points` intero tra −10 000 e 10 000 (negativi ammessi).
- `hand_number` *(facoltativo)*: il numero della mano che il client vedeva aperta. Se nel frattempo è stata chiusa dagli altri inserimenti → **409** `hand_changed` e i punti non vengono salvati, così non finiscono nella mano successiva. La PWA lo invia sempre.

**Chiusura automatica**: quando tutte le squadre hanno un punteggio, nella stessa transazione:
1. la mano passa a `closed`;
2. si ricalcolano i totali;
3. se almeno una squadra ha `total ≥ target_score` → vince quella con il totale più alto (`status = finished`, `winner_team_id`). In caso di **pareggio in testa** si gioca un'altra mano;
4. altrimenti si apre la mano successiva.

**200** → stato completo (come `/state`), così il client si aggiorna subito senza aspettare il polling.

### 11. Correggi una mano già chiusa *(master)*
`PUT /api/games/{code}/hands/{number}/scores/{team_id}`

Stesso corpo del punto 10. Ricalcola i totali e il vincitore:
- partita finita e la correzione cambia chi è in testa → cambia il vincitore;
- nessuno è più oltre il traguardo → la partita torna `playing` e si apre una nuova mano;
- partita in corso e la correzione porta qualcuno oltre il traguardo → la partita si chiude, se la mano in corso è ancora vuota.

### 12. Annulla l'ultima mano *(master)*
`DELETE /api/games/{code}/hands/last`

In ordine:
- partita finita → riapre l'ultima mano e la partita torna in corso;
- mano aperta con punti → cancella i punti inseriti;
- mano aperta vuota → la elimina e riapre la precedente (con i suoi punti: basta reinviarne uno corretto per richiuderla).

### 13. Termina la partita *(master)*
`POST /api/games/{code}/finish`

Chiude la partita anche senza raggiungere il traguardo: vince chi ha il totale più alto al momento (pari merito in testa = nessun vincitore). La mano in corso, anche se parzialmente compilata, non conta e viene eliminata.

### 14. Rivincita *(master)*
`POST /api/games/{code}/rematch`

Crea una nuova partita **in sala d'attesa** con stesse squadre, giocatori e traguardo (il master può risorteggiare e poi avviare). I giocatori tengono lo stesso token: nel `/state` della vecchia partita compare `"rematch_code": "R4TQ"` e il client ci salta dentro. Chiamarla due volte restituisce la stessa rivincita.

**201** `{ "code": "R4TQ", "join_url": "…" }`

---

## Concorrenza

Due telefoni possono scrivere quasi nello stesso istante (es. le ultime due squadre inseriscono insieme e tutte e due farebbero scattare la chiusura della mano). Ogni operazione di scrittura:

```sql
START TRANSACTION;
SELECT id, status, version FROM games WHERE code = ? FOR UPDATE;   -- lock sulla partita
-- ...modifiche...
UPDATE games SET version = version + 1 WHERE id = ?;
COMMIT;
```

Il `FOR UPDATE` sulla riga della partita mette in fila le scritture della stessa partita: semplice, e con 6 giocatori non crea code percepibili.

## Struttura e deploy

Vedi il `README.md`: la cartella `public/` va in `public_html/pinella/`, mentre `src/` e `config/` stanno fuori dal web (`/home/<utente>/pinella-app/`) oppure, come piano B, in `public_html/pinella/_app/` protetta da `.htaccess`.

## Fuori dall'MVP (fasi successive)

- Account registrati (email + magic link) e profilo persistente tra partite
- Foto con umore e scelta automatica nel carosello
- Messaggi, emoticon, GIF (tabelle `messages`, `player_photos`)
- Statistiche storiche e classifica di lungo periodo
- Pulizia automatica: partite in lobby da più di 24 h e partite finite da più di 90 giorni (cron di cPanel)
