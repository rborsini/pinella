#!/usr/bin/env python3
"""Imposta o controlla la versione di Pinella in tutti i punti in cui compare.

Uso:
    python3 tools/set_version.py 0.2.0     imposta la nuova versione (semver X.Y.Z)
    python3 tools/set_version.py --check   verifica che tutti i punti siano allineati

Punti aggiornati:
    src/Version.php     costante del server (risposta di /api/health e header X-Pinella-Version)
    public/app.js       costante della PWA, mostrata nell'app
    public/index.html   parametro ?v= degli asset, per non usare file vecchi dalla cache
    public/sw.js        nome della cache del service worker, così la cache vecchia viene eliminata
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
V = r"(\d+\.\d+\.\d+)"

# file -> (regex con un gruppo per la versione, numero di occorrenze attese)
TARGETS = {
    "src/Version.php": (r"public const APP = '" + V + "';", 1),
    "public/app.js": (r"const APP_VERSION = '" + V + "';", 1),
    "public/index.html": (r'\?v=' + V + '"', 3),
    "public/sw.js": (r"const CACHE = 'pinella-" + V + "';", 1),
}


def read(rel):
    with open(ROOT / rel, encoding="utf-8", newline="") as f:
        return f.read()


def found_versions():
    result = {}
    for rel, (pattern, expected) in TARGETS.items():
        hits = re.findall(pattern, read(rel))
        if len(hits) != expected:
            sys.exit(f"{rel}: attese {expected} occorrenze della versione, trovate {len(hits)}")
        result[rel] = set(hits)
    return result


def check():
    versions = found_versions()
    distinct = set().union(*versions.values())
    if len(distinct) != 1:
        for rel, v in versions.items():
            print(f"  {rel}: {', '.join(sorted(v))}")
        sys.exit("Versioni non allineate: usa tools/set_version.py X.Y.Z")
    print(f"Versione {distinct.pop()} allineata in tutti i file")


def set_version(new):
    if not re.fullmatch(r"\d+\.\d+\.\d+", new):
        sys.exit("Versione non valida: usa il formato X.Y.Z, es. 0.2.0")
    found_versions()  # fallisce se un file non ha la forma attesa
    for rel, (pattern, _) in TARGETS.items():
        text = re.sub(pattern, lambda m: m.group(0).replace(m.group(1), new), read(rel))
        with open(ROOT / rel, "w", encoding="utf-8", newline="") as f:  # mantiene i fine riga (CRLF su Windows)
            f.write(text)
        print(f"  {rel}")
    check()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    check() if sys.argv[1] == "--check" else set_version(sys.argv[1])
