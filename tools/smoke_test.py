#!/usr/bin/env python3
"""Test end-to-end delle API Pinella: simula una partita 2v2v2 completa.

Uso:  python3 tools/smoke_test.py [base_url]     (default http://localhost:8080)
"""
import json
import time
import sys
import threading
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080").rstrip("/") + "/api"
passed = 0


def call(method, path, body=None, token=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("X-Player-Token", token)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None), dict(r.headers)
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, (json.loads(raw) if raw else None), dict(e.headers)


def check(cond, label):
    global passed
    if not cond:
        raise AssertionError("FALLITO: " + label)
    passed += 1
    print("  ok  " + label)


def score(code, token, team, points, hand="current", closed=False):
    return call("PUT", f"/games/{code}/hands/{hand}/scores/{team}", {"points": points, "closed_hand": closed}, token)


print("Versione")
s, h, hd = call("GET", "/health")
check(s == 200 and h["ok"], "health risponde")
check(bool(h.get("version")), f"health espone la versione ({h.get('version')})")
check(hd.get("X-Pinella-Version") == h.get("version"), "header X-Pinella-Version coerente con health")

print("Creazione partita")
s, g, _ = call("POST", "/games", {
    "master_name": "Marco", "format": "2v2v2", "target_score": 1500,
    "teams": [
        {"name": "Corallo", "color": "#FF6B57", "size": 2},
        {"name": "Turchese", "color": "#18C2B0", "size": 2},
        {"name": "Sole", "color": "#ffc22e", "size": 2},
    ]})
check(s == 201 and len(g["code"]) == 4, "201 con codice di 4 caratteri")
code, master = g["code"], g["player_token"]
check(g["join_url"].endswith("/?join=" + code), "join_url contiene il codice")

s, e, _ = call("POST", "/games", {"master_name": "X", "format": "2v2", "target_score": 1500, "teams": [{"name": "A", "color": "#000000", "size": 2}]})
check(s == 400 and e["error"] == "invalid_teams", "rifiuta una sola squadra")

s, summ, _ = call("GET", f"/games/{code.lower()}")
check(s == 200 and summ["master_name"] == "Marco" and summ["teams"][2]["color"] == "#FFC22E", "riepilogo pubblico (codice minuscolo accettato)")
T = [t["id"] for t in summ["teams"]]

print("Ingresso giocatori")
tok = {}
for name, team in [("Lucia", T[0]), ("Paolo", T[1]), ("Anna", T[1]), ("Pia", T[2])]:
    s, j, _ = call("POST", f"/games/{code}/players", {"name": name, "team_id": team})
    check(s == 201 and len(j["player_token"]) == 64, f"{name} entra")
    tok[name] = j["player_token"]
s, e, _ = call("POST", f"/games/{code}/players", {"name": "Intruso", "team_id": T[1]})
check(s == 409 and e["error"] == "team_full", "squadra piena -> 409")
s, e, _ = call("POST", f"/games/{code}/players/manual", {"name": "Gino", "team_id": T[2]}, tok["Pia"])
check(s == 403, "solo il master aggiunge a mano")
s, st, _ = call("POST", f"/games/{code}/players/manual", {"name": "Gino", "team_id": T[2]}, master)
check(s == 201, "master aggiunge Gino a mano")

s, e, _ = call("POST", f"/games/{code}/start", None, master)
check(s == 409 and e["error"] == "unassigned_players", "non parte con il master senza squadra")
s, st, _ = call("GET", f"/games/{code}/state", token=master)
me_id = st["me"]["player_id"]
check(st["me"]["is_master"] and len(st["unassigned"]) == 1, "stato: master non assegnato")
s, e, _ = call("PATCH", f"/games/{code}/players/{me_id}", {"team_id": T[1]}, tok["Lucia"])
check(s == 403, "un giocatore non sposta gli altri")
s, st, _ = call("PATCH", f"/games/{code}/players/{me_id}", {"team_id": T[0]}, master)
check(s == 200 and st["unassigned"] == [], "master si mette in Corallo")

print("Sorteggio")
s, st, _ = call("POST", f"/games/{code}/shuffle", None, master)
sizes = sorted(len(t["players"]) for t in st["teams"])
check(s == 200 and sizes == [2, 2, 2], "sorteggio: 2 giocatori per squadra")

print("Avvio e polling")
s, st, h = call("POST", f"/games/{code}/start", None, master)
check(s == 200 and st["status"] == "playing" and st["current_hand"]["number"] == 1, "partita avviata, mano 1 aperta")
check(st["current_hand"]["dealer_player_id"] == me_id, "senza scelta il primo mazziere è il master")
el0 = st["current_hand"]["elapsed_s"]
check(isinstance(el0, int) and 0 <= el0 <= 5, f"timer: la mano 1 è appena aperta ({el0} s)")
time.sleep(2.2)
s, st, _ = call("GET", f"/games/{code}/state", token=master)
check(st["current_hand"]["elapsed_s"] >= el0 + 2, f"timer: dopo 2 secondi il server conta {st['current_hand']['elapsed_s']} s")
s, st, h = call("GET", f"/games/{code}/state", token=tok["Pia"])
etag = h["ETag"]
s2, body2, _ = call("GET", f"/games/{code}/state", token=tok["Pia"], headers={"If-None-Match": etag})
check(s2 == 304 and body2 is None, "polling senza novità -> 304 vuoto")

team_of = {}
for t in st["teams"]:
    for p in t["players"]:
        team_of[p["name"]] = t["id"]
pia_team = team_of["Pia"]
other = next(t for t in T if t != pia_team)

print("Punteggi")
s, e, _ = score(code, tok["Pia"], other, 100)
check(s == 403 and e["error"] == "not_your_team", "Pia non può segnare per un'altra squadra")
s, e, _ = score(code, None, pia_team, 100)
check(s == 401, "senza token -> 401")
s, st, _ = score(code, tok["Pia"], pia_team, 140)
check(s == 200 and st["current_hand"]["number"] == 1, "Pia inserisce, mano ancora aperta")
s2, _, _ = call("GET", f"/games/{code}/state", token=tok["Pia"], headers={"If-None-Match": etag})
check(s2 == 200, "dopo una modifica il polling restituisce 200")
s, st, _ = score(code, tok["Pia"], pia_team, 145, closed=True)
cur = {x["team_id"]: x for x in st["current_hand"]["scores"]}
check(cur[pia_team]["points"] == 145 and cur[pia_team]["closed_hand"], "correzione nella mano aperta: vince l'ultimo inserimento")

# Mano 1: il master completa le altre due squadre
others = [t for t in T if t != pia_team]
score(code, master, others[0], 85)
s, st, _ = score(code, master, others[1], -20)
check(st["current_hand"]["number"] == 2 and len(st["hands"]) == 1, "mano 1 chiusa automaticamente, aperta la 2")
check(st["current_hand"]["elapsed_s"] <= 1, "timer: la mano 2 riparte da zero")
s, e, _ = call("PUT", f"/games/{code}/hands/current/scores/{pia_team}", {"points": 999, "hand_number": 1}, tok["Pia"])
check(s == 409 and e["error"] == "hand_changed", "punti per la mano 1 già chiusa -> 409 hand_changed")
s, st, _ = call("GET", f"/games/{code}/state", token=tok["Pia"])
check(all(x["points"] is None for x in st["current_hand"]["scores"]), "i punti rifiutati non finiscono nella mano 2")
s, e, _ = call("PUT", f"/games/{code}/hands/current/scores/{pia_team}", {"points": 10, "hand_number": "x"}, tok["Pia"])
check(s == 400 and e["error"] == "invalid_hand_number", "hand_number non valido -> 400")
tot = {t["id"]: t["total"] for t in st["teams"]}
check(sorted(tot.values()) == sorted([85, -20, 145]), "totali corretti dopo la mano 1 (negativi inclusi)")
check(st["teams"][0]["rank"] == 1 and st["teams"][0]["total"] == 145, "classifica ordinata")

def play_hand(pts):
    """pts: dict team_id -> punti, inseriti dal master"""
    out = None
    for t, p in pts.items():
        _, out, _ = score(code, master, t, p)
    return out

# Mani successive per arrivare vicino al traguardo
A, B, C = T  # Corallo, Turchese, Sole
st = play_hand({A: 400, B: 300, C: 200})   # mano 2
st = play_hand({A: 300, B: 300, C: 300})   # mano 3
tot = {t["id"]: t["total"] for t in st["teams"]}
print("    totali:", tot)
# sorpasso: chi è dietro fa una mano enorme
behind = min(tot, key=tot.get)
leader = max(tot, key=tot.get)
big = max(tot[leader] - tot[behind] + 50, 450)  # sorpassa ed è anche la mano più alta finora
st = play_hand({A: 0, B: 0, C: 0} | {behind: big})  # mano 4
ev = [x["type"] for x in st["events"]]
check("overtake" in ev, "evento sorpasso")
check("best_hand" in ev, "evento mano record")

print("Annulla")
num_before = st["current_hand"]["number"]
score(code, master, A, 10)
s, st, _ = call("DELETE", f"/games/{code}/hands/last", None, master)
check(all(x["points"] is None for x in st["current_hand"]["scores"]), "annulla: cancella i punti della mano aperta")
s, st, _ = call("DELETE", f"/games/{code}/hands/last", None, master)
check(st["current_hand"]["number"] == num_before - 1 and len(st["hands"]) == num_before - 2, "annulla: riapre la mano precedente")
reopened = {x["team_id"]: x["points"] for x in st["current_hand"]["scores"]}
check(all(v is not None for v in reopened.values()), "la mano riaperta conserva i punti")
s, st, _ = score(code, master, A, reopened[A])  # reinvio: richiude
check(st["current_hand"]["number"] == num_before, "reinviando un punteggio la mano si richiude")

print("Concorrenza: le ultime due squadre inviano insieme")
score(code, master, A, 10)
results = []
def send(team):
    results.append(score(code, master, team, 20))
threads = [threading.Thread(target=send, args=(t,)) for t in (B, C)]
[t.start() for t in threads]; [t.join() for t in threads]
s, st, _ = call("GET", f"/games/{code}/state", token=master)
check(all(r[0] == 200 for r in results), "entrambe le richieste ok")
check(st["current_hand"]["number"] == num_before + 1 and [h["number"] for h in st["hands"]] == list(range(1, num_before + 1)),
      "la mano si chiude una sola volta, nessuna mano duplicata")

print("Pareggio in testa oltre il traguardo")
tot = {t["id"]: t["total"] for t in st["teams"]}
lead = max(tot.values())
need = {t: 1600 - tot[t] for t in (A, B)}  # A e B a 1600 pari
st = play_hand({A: need[A], B: need[B], C: 0})
check(st["status"] == "playing" and st["winner_team_id"] is None, "pari merito oltre 1500: si continua")

print("Vittoria")
st = play_hand({A: 50, B: 10, C: 0})
check(st["status"] == "finished" and st["winner_team_id"] == A and st["finish_reason"] == "target", "vince Corallo")
check(st["current_hand"] is None, "nessuna mano aperta a fine partita")
s, e, _ = score(code, master, A, 10)
check(s == 409, "non si segna a partita finita")

print("Correzione dopo la fine")
last_n = st["hands"][-1]["number"]
tie = {int(k): v for k, v in st["hands"][-2]["scores"].items()}
s, st, _ = score(code, master, A, -100, hand=str(last_n))
check(st["status"] == "finished" and st["winner_team_id"] == B, "correzione che cambia il vincitore (ora vince Turchese)")
score(code, master, A, 0, hand=str(last_n - 1))
s, st, _ = score(code, master, B, 0, hand=str(last_n - 1))
check(st["status"] == "playing" and st["winner_team_id"] is None and st["current_hand"] is not None,
      "correzione che toglie la vittoria a tutti: la partita riprende")
score(code, master, A, tie[A], hand=str(last_n - 1))
score(code, master, B, tie[B], hand=str(last_n - 1))
s, st, _ = score(code, master, A, 50, hand=str(last_n))
check(st["status"] == "finished" and st["winner_team_id"] == A and st["current_hand"] is None,
      "ripristino: vince di nuovo Corallo e la mano vuota sparisce")
s, e, _ = score(code, tok["Lucia"], A, 50, hand=str(last_n))
check(s == 403, "solo il master corregge le mani chiuse")

print("Rivincita")
s, r, _ = call("POST", f"/games/{code}/rematch", None, master)
check(s == 201 and r["code"] != code, "nuova partita creata")
s, r2, _ = call("POST", f"/games/{code}/rematch", None, master)
check(r2["code"] == r["code"], "rivincita idempotente")
s, st, _ = call("GET", f"/games/{code}/state", token=tok["Pia"])
check(st["rematch_code"] == r["code"], "il vecchio stato segnala la rivincita")
s, st2, _ = call("GET", f"/games/{r['code']}/state", token=tok["Pia"])
check(st2["me"] and st2["me"]["name"] == "Pia" and st2["status"] == "lobby", "Pia entra nella rivincita con lo stesso token")
check(sum(len(t["players"]) for t in st2["teams"]) == 6, "tutti e 6 i giocatori copiati")

print("Fine anticipata")
s, st, _ = call("POST", f"/games/{r['code']}/start", None, master)
s, st, _ = score(r["code"], master, st2["teams"][0]["id"], 10)
s, st, _ = call("POST", f"/games/{r['code']}/finish", None, master)
check(st["status"] == "finished" and st["finish_reason"] == "manual" and st["winner_team_id"] is None and st["hands"] == [],
      "fine anticipata senza mani chiuse: nessun vincitore, mano parziale eliminata")

print("Mazziere")
s, g2, _ = call("POST", "/games", {"master_name": "Ada", "format": "2v2", "target_score": 5000,
    "teams": [{"name": "A", "color": "#FF6B57", "size": 2}, {"name": "B", "color": "#18C2B0", "size": 2}]})
c2, mt2 = g2["code"], g2["player_token"]
s, st, _ = call("GET", f"/games/{c2}/state", token=mt2)
TA, TB = [t["id"] for t in sorted(st["teams"], key=lambda t: t["id"])]
ada = st["me"]["player_id"]
call("PATCH", f"/games/{c2}/players/{ada}", {"team_id": TA}, mt2)
pid, tk = {"Ada": ada}, {}
for name, team in [("Bea", TB), ("Ciro", TA), ("Dino", TB)]:
    s, j, _ = call("POST", f"/games/{c2}/players", {"name": name, "team_id": team})
    pid[name], tk[name] = j["player_id"], j["player_token"]
name_of = {v: k for k, v in pid.items()}
s, st, _ = call("GET", f"/games/{c2}/state", token=mt2)
check([name_of[i] for i in st["dealer_order"]] == ["Ada", "Bea", "Ciro", "Dino"], "giro del mazzo: squadre alternate (Ada, Bea, Ciro, Dino)")
s, e, _ = call("POST", f"/games/{c2}/start", {"dealer_player_id": 999999}, mt2)
check(s == 400 and e["error"] == "invalid_dealer", "mazziere che non è in partita -> 400")
s, st, _ = call("POST", f"/games/{c2}/start", {"dealer_player_id": pid["Ciro"]}, mt2)
cur = st["current_hand"]
check(name_of[cur["dealer_player_id"]] == "Ciro" and name_of[cur["next_dealer_player_id"]] == "Dino", "mano 1: dà Ciro, poi Dino")

def hand2(pa, pb):
    score(c2, mt2, TA, pa)
    return score(c2, mt2, TB, pb)[1]

def dealer(st):
    return name_of[st["current_hand"]["dealer_player_id"]]

st = hand2(10, 20)
check(st["current_hand"]["number"] == 2 and dealer(st) == "Dino", "mano 2: il mazzo passa a Dino")
st = hand2(10, 20)
check(dealer(st) == "Ada" and name_of[st["current_hand"]["next_dealer_player_id"]] == "Bea", "mano 3: si ricomincia il giro da Ada")
s, e, _ = call("PUT", f"/games/{c2}/hands/current/dealer", {"player_id": pid["Bea"]}, None)
check(s == 401, "correzione del mazziere senza token -> 401")
s, e, _ = call("PUT", f"/games/{c2}/hands/current/dealer", {"player_id": pid["Bea"]}, tk["Bea"])
check(s == 403 and e["error"] == "not_master", "solo il master corregge il mazziere")
s, st, _ = call("PUT", f"/games/{c2}/hands/current/dealer", {"player_id": pid["Bea"]}, mt2)
check(s == 200 and dealer(st) == "Bea" and name_of[st["current_hand"]["next_dealer_player_id"]] == "Ciro", "il master corregge: dà Bea, poi Ciro")
s, e, _ = call("PUT", f"/games/{c2}/hands/current/dealer", {"player_id": 999999}, mt2)
check(s == 400 and e["error"] == "invalid_dealer", "correzione con un giocatore inesistente -> 400")
st = hand2(10, 20)
check(dealer(st) == "Ciro", "dopo la correzione la rotazione riparte: mano 4 a Ciro")
check([name_of[h["dealer_player_id"]] for h in st["hands"]] == ["Ciro", "Dino", "Bea"], "lo storico delle mani ricorda chi ha dato le carte")
s, st, _ = call("DELETE", f"/games/{c2}/hands/last", None, mt2)
check(st["current_hand"]["number"] == 3 and dealer(st) == "Bea", "annulla: torna la mano 3 con il suo mazziere (Bea)")
st = hand2(30, 40)
check(st["current_hand"]["number"] == 4 and dealer(st) == "Ciro", "rigiocata la mano 3, la 4 torna a Ciro")
s, st, _ = call("PUT", f"/games/{c2}/hands/1/scores/{TA}", {"points": 15}, mt2)
check(dealer(st) == "Ciro", "la correzione di una mano chiusa non cambia il mazziere")
s, st, _ = call("POST", f"/games/{c2}/finish", None, mt2)
check(st["current_hand"] is None, "partita terminata: nessun mazziere in corso")
s, st, _ = call("DELETE", f"/games/{c2}/hands/last", None, mt2)
check(st["status"] == "playing" and st["current_hand"]["number"] == 3 and dealer(st) == "Bea", "annulla a partita finita: riapre la mano 3 con Bea")

print("Formati a singoli (3x1, 4x1, 5x1)")
for fmt, n in [("3x1", 3), ("4x1", 4), ("5x1", 5)]:
    s, g1, _ = call("POST", "/games", {
        "master_name": "M", "format": fmt, "target_score": 500,
        "teams": [{"name": f"G{i}", "color": "#FF6B57", "size": 1} for i in range(n)]})
    check(s == 201, f"{fmt}: partita creata")
    c1, mt = g1["code"], g1["player_token"]
    s, st, _ = call("GET", f"/games/{c1}/state", token=mt)
    ids = [t["id"] for t in st["teams"]]
    check(st["format"] == fmt and len(ids) == n and all(t["size"] == 1 for t in st["teams"]), f"{fmt}: {n} squadre da 1")
    call("PATCH", f"/games/{c1}/players/{st['me']['player_id']}", {"team_id": ids[0]}, mt)
    for i, tid in enumerate(ids[1:], 1):
        s, _, _ = call("POST", f"/games/{c1}/players", {"name": f"P{i}", "team_id": tid})
    s, e, _ = call("POST", f"/games/{c1}/players", {"name": "Extra", "team_id": ids[1]})
    check(s == 409 and e["error"] == "team_full", f"{fmt}: un solo giocatore per posto")
    s, st, _ = call("POST", f"/games/{c1}/start", None, mt)
    check(s == 200 and st["status"] == "playing", f"{fmt}: partita avviata")
    for i, tid in enumerate(ids):
        _, st, _ = score(c1, mt, tid, 100 + 10 * i)
    check(st["current_hand"]["number"] == 2 and st["teams"][0]["total"] == 100 + 10 * (n - 1), f"{fmt}: mano chiusa e classifica corretta")
    for tid in ids:
        _, st, _ = score(c1, mt, tid, 500 if tid == ids[0] else 0)
    check(st["status"] == "finished" and st["winner_team_id"] == ids[0], f"{fmt}: vittoria al traguardo")

s, e, _ = call("GET", "/games/ZZZZ/state")
check(s == 404, "partita inesistente -> 404")
s, e, _ = call("GET", "/nope")
check(s == 404 and e["error"] == "route_not_found", "endpoint inesistente -> 404")

print(f"\nTutti i {passed} controlli superati.")
