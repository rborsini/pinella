<?php
declare(strict_types=1);

namespace Pinella;

/**
 * Regole del gioco e operazioni sulle partite.
 *
 * Ogni operazione di scrittura passa da mutate(): transazione + lock sulla riga
 * della partita (SELECT ... FOR UPDATE) + version = version + 1. Così le scritture
 * sulla stessa partita vengono messe in fila e il polling vede sempre uno stato coerente.
 */
final class GameService
{
    private const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // senza 0 O 1 I L
    private const FORMATS       = ['1v1', '2v2', '3v3', '2v2v2', '3x1', '4x1', '5x1', 'custom'];
    private const ONLINE_SECONDS    = 15;  // "collegato" se visto negli ultimi N secondi
    private const LAST_SEEN_THROTTLE = 10; // aggiorna last_seen_at al massimo ogni N secondi
    private const NEAR_TARGET_RATIO = 0.15;

    public function __construct(private readonly Db $db, private readonly array $config) {}

    // =================================================================
    // Creazione e ingresso
    // =================================================================

    public function createGame(array $in): array
    {
        $masterName = Validate::name($in['master_name'] ?? null, 'master_name');
        $format = $in['format'] ?? 'custom';
        if (!is_string($format) || !in_array($format, self::FORMATS, true)) {
            throw ApiError::badRequest('invalid_format', 'Formato non valido');
        }
        $target = Validate::int($in['target_score'] ?? null, 100, 100000, 'target_score');

        $teams = $in['teams'] ?? null;
        if (!is_array($teams) || !array_is_list($teams) || count($teams) < 2 || count($teams) > 6) {
            throw ApiError::badRequest('invalid_teams', 'Servono da 2 a 6 squadre');
        }
        $clean = [];
        foreach ($teams as $i => $t) {
            if (!is_array($t)) {
                throw ApiError::badRequest('invalid_teams', "Squadra $i non valida");
            }
            $clean[] = [
                'name'  => Validate::name($t['name'] ?? null, 'team_name', 40),
                'color' => Validate::color($t['color'] ?? null, 'team_color'),
                'size'  => Validate::int($t['size'] ?? null, 1, 4, 'team_size'),
            ];
        }

        $token = Auth::newToken();

        return $this->db->transaction(function () use ($masterName, $format, $target, $clean, $token) {
            $code = $this->newCode();
            $gameId = $this->db->insert(
                'INSERT INTO {p}games (code, format, target_score) VALUES (?, ?, ?)',
                [$code, $format, $target]
            );
            foreach ($clean as $pos => $t) {
                $this->db->insert(
                    'INSERT INTO {p}teams (game_id, name, color, size, position) VALUES (?, ?, ?, ?, ?)',
                    [$gameId, $t['name'], $t['color'], $t['size'], $pos]
                );
            }
            $playerId = $this->db->insert(
                'INSERT INTO {p}players (game_id, name, is_master, token_hash, last_seen_at) VALUES (?, ?, 1, ?, NOW())',
                [$gameId, $masterName, Auth::hash($token)]
            );
            return [
                'code'         => $code,
                'player_id'    => $playerId,
                'player_token' => $token,
                'join_url'     => $this->joinUrl($code),
            ];
        });
    }

    /** Riepilogo pubblico per la schermata di ingresso (nessun token richiesto). */
    public function publicSummary(string $code): array
    {
        $game = $this->db->one('SELECT * FROM {p}games WHERE code = ?', [$this->normCode($code)]);
        if (!$game) {
            throw ApiError::notFound();
        }
        $teams = $this->db->all(
            'SELECT t.id, t.name, t.color, t.size, COUNT(p.id) AS taken
               FROM {p}teams t LEFT JOIN {p}players p ON p.team_id = t.id
              WHERE t.game_id = ?
              GROUP BY t.id, t.name, t.color, t.size, t.position
              ORDER BY t.position',
            [$game['id']]
        );
        $master = $this->db->value('SELECT name FROM {p}players WHERE game_id = ? AND is_master = 1', [$game['id']]);

        return [
            'code'         => $game['code'],
            'master_name'  => $master,
            'format'       => $game['format'],
            'target_score' => (int) $game['target_score'],
            'status'       => $game['status'],
            'teams'        => array_map(fn ($t) => [
                'id'    => (int) $t['id'],
                'name'  => $t['name'],
                'color' => $t['color'],
                'size'  => (int) $t['size'],
                'taken' => (int) $t['taken'],
            ], $teams),
        ];
    }

    public function join(string $code, array $in): array
    {
        $name = Validate::name($in['name'] ?? null, 'name');
        $teamId = Validate::optionalInt($in['team_id'] ?? null, 1, PHP_INT_MAX, 'team_id');
        $token = Auth::newToken();

        return $this->mutate($code, null, function (array $game) use ($name, $teamId, $token) {
            if ($game['status'] === 'finished') {
                throw ApiError::conflict('game_finished', 'La partita è già finita');
            }
            if ($teamId === null && $game['status'] === 'playing') {
                throw ApiError::badRequest('team_required', 'A partita avviata devi scegliere una squadra');
            }
            if ($teamId !== null) {
                $this->assertTeamHasRoom($game, $teamId);
            }
            $playerId = $this->db->insert(
                'INSERT INTO {p}players (game_id, team_id, name, token_hash, last_seen_at) VALUES (?, ?, ?, ?, NOW())',
                [$game['id'], $teamId, $name, Auth::hash($token)]
            );
            return ['player_id' => $playerId, 'player_token' => $token];
        });
    }

    public function addManualPlayer(string $code, ?string $token, array $in): array
    {
        $name = Validate::name($in['name'] ?? null, 'name');
        $teamId = Validate::optionalInt($in['team_id'] ?? null, 1, PHP_INT_MAX, 'team_id');

        return $this->mutate($code, $token, function (array $game, ?array $me) use ($name, $teamId) {
            $this->requireMaster($me);
            if ($game['status'] === 'finished') {
                throw ApiError::conflict('game_finished', 'La partita è già finita');
            }
            if ($teamId === null && $game['status'] === 'playing') {
                throw ApiError::badRequest('team_required', 'A partita avviata devi scegliere una squadra');
            }
            if ($teamId !== null) {
                $this->assertTeamHasRoom($game, $teamId);
            }
            $this->db->insert(
                'INSERT INTO {p}players (game_id, team_id, name) VALUES (?, ?, ?)',
                [$game['id'], $teamId, $name]
            );
            return null;
        });
    }

    public function movePlayer(string $code, ?string $token, int $playerId, array $in): array
    {
        $teamId = Validate::int($in['team_id'] ?? null, 1, PHP_INT_MAX, 'team_id');

        return $this->mutate($code, $token, function (array $game, ?array $me) use ($playerId, $teamId) {
            $this->requireMe($me);
            $player = $this->findPlayer($game, $playerId);
            if (!$me['is_master']) {
                if ((int) $me['id'] !== $playerId) {
                    throw ApiError::forbidden('not_master', 'Solo il master può spostare gli altri giocatori');
                }
                if ($game['status'] !== 'lobby') {
                    throw ApiError::conflict('game_started', 'A partita avviata solo il master può cambiare le squadre');
                }
            }
            if ($game['status'] === 'finished') {
                throw ApiError::conflict('game_finished', 'La partita è già finita');
            }
            if ((int) $player['team_id'] !== $teamId) {
                $this->assertTeamHasRoom($game, $teamId);
                $this->db->exec('UPDATE {p}players SET team_id = ? WHERE id = ?', [$teamId, $playerId]);
            }
            return null;
        });
    }

    public function removePlayer(string $code, ?string $token, int $playerId): array
    {
        return $this->mutate($code, $token, function (array $game, ?array $me) use ($playerId) {
            $this->requireMaster($me);
            if ($game['status'] !== 'lobby') {
                throw ApiError::conflict('game_started', 'I giocatori si possono togliere solo prima di iniziare');
            }
            $player = $this->findPlayer($game, $playerId);
            if ($player['is_master']) {
                throw ApiError::conflict('cannot_remove_master', 'Il master non può essere tolto');
            }
            $this->db->exec('DELETE FROM {p}players WHERE id = ?', [$playerId]);
            return null;
        });
    }

    /** Mescola i giocatori e li distribuisce nelle squadre rispettando i posti previsti. */
    public function shuffle(string $code, ?string $token): array
    {
        return $this->mutate($code, $token, function (array $game, ?array $me) {
            $this->requireMaster($me);
            if ($game['status'] !== 'lobby') {
                throw ApiError::conflict('game_started', 'Il sorteggio si fa prima di iniziare');
            }
            $teams = $this->db->all('SELECT id, size FROM {p}teams WHERE game_id = ? ORDER BY position', [$game['id']]);
            $playerIds = array_map('intval', array_column(
                $this->db->all('SELECT id FROM {p}players WHERE game_id = ?', [$game['id']]), 'id'
            ));

            // Posti in ordine "a giro": 1° posto di ogni squadra, poi il 2°... così le squadre si riempiono in modo equilibrato.
            $slots = [];
            $maxSize = max(array_map(fn ($t) => (int) $t['size'], $teams));
            for ($round = 0; $round < $maxSize; $round++) {
                foreach ($teams as $t) {
                    if ($round < (int) $t['size']) {
                        $slots[] = (int) $t['id'];
                    }
                }
            }
            if (count($playerIds) > count($slots)) {
                throw ApiError::conflict('too_many_players', 'Ci sono più giocatori che posti nelle squadre');
            }
            shuffle($playerIds);
            foreach ($playerIds as $i => $pid) {
                $this->db->exec('UPDATE {p}players SET team_id = ? WHERE id = ?', [$slots[$i], $pid]);
            }
            return null;
        });
    }

    public function start(string $code, ?string $token, array $in = []): array
    {
        $dealerId = Validate::optionalInt($in['dealer_player_id'] ?? null, 1, PHP_INT_MAX, 'dealer_player_id');

        return $this->mutate($code, $token, function (array $game, ?array $me) use ($dealerId) {
            $this->requireMaster($me);
            if ($game['status'] !== 'lobby') {
                throw ApiError::conflict('game_started', 'La partita è già iniziata');
            }
            $unassigned = (int) $this->db->value(
                'SELECT COUNT(*) FROM {p}players WHERE game_id = ? AND team_id IS NULL', [$game['id']]
            );
            if ($unassigned > 0) {
                throw ApiError::conflict('unassigned_players', 'Ci sono giocatori senza squadra');
            }
            $emptyTeams = (int) $this->db->value(
                'SELECT COUNT(*) FROM {p}teams t WHERE t.game_id = ?
                   AND NOT EXISTS (SELECT 1 FROM {p}players p WHERE p.team_id = t.id)', [$game['id']]
            );
            if ($emptyTeams > 0) {
                throw ApiError::conflict('empty_team', 'Ogni squadra deve avere almeno un giocatore');
            }
            // Primo mazziere: quello scelto dal master; se manca, il master stesso (o il primo del giro)
            $order = $this->dealerOrder((int) $game['id']);
            if ($dealerId !== null && !in_array($dealerId, $order, true)) {
                throw ApiError::badRequest('invalid_dealer', 'Il mazziere deve essere un giocatore di una squadra');
            }
            $dealerId ??= in_array((int) $me['id'], $order, true) ? (int) $me['id'] : $order[0];
            $this->db->exec("UPDATE {p}games SET status = 'playing', started_at = NOW() WHERE id = ?", [$game['id']]);
            $this->db->insert('INSERT INTO {p}hands (game_id, number, dealer_player_id) VALUES (?, 1, ?)', [$game['id'], $dealerId]);
            return null;
        });
    }

    // =================================================================
    // Punteggi
    // =================================================================

    /**
     * Inserisce o corregge il punteggio di una squadra.
     * $handRef = 'current' (mano aperta) oppure il numero di una mano (solo master).
     */
    public function putScore(string $code, ?string $token, string $handRef, int $teamId, array $in): array
    {
        $points = Validate::int($in['points'] ?? null, -10000, 10000, 'points');
        $closedHand = !empty($in['closed_hand']);
        // Facoltativo: il numero della mano che il client vedeva aperta. Se nel frattempo
        // la mano è stata chiusa da altri, i punti non devono finire in quella successiva.
        $expectedHand = isset($in['hand_number']) ? Validate::int($in['hand_number'], 1, 100000, 'hand_number') : null;

        return $this->mutate($code, $token, function (array $game, ?array $me) use ($handRef, $teamId, $points, $closedHand, $expectedHand) {
            $this->requireMe($me);
            $team = $this->db->one('SELECT id FROM {p}teams WHERE id = ? AND game_id = ?', [$teamId, $game['id']]);
            if (!$team) {
                throw ApiError::notFound('team_not_found', 'Squadra non trovata');
            }

            if ($handRef === 'current') {
                if ($game['status'] !== 'playing') {
                    throw ApiError::conflict('not_playing', 'La partita non è in corso');
                }
                $hand = $this->openHand($game);
                if (!$hand) {
                    throw ApiError::conflict('no_open_hand', 'Nessuna mano aperta');
                }
                if ($expectedHand !== null && $expectedHand !== (int) $hand['number']) {
                    throw ApiError::conflict('hand_changed', "La mano $expectedHand è già stata chiusa: punti non inviati");
                }
                if (!$me['is_master'] && (int) $me['team_id'] !== $teamId) {
                    throw ApiError::forbidden('not_your_team', 'Puoi inserire solo i punti della tua squadra');
                }
            } else {
                $this->requireMaster($me);
                $hand = $this->db->one(
                    'SELECT * FROM {p}hands WHERE game_id = ? AND number = ?', [$game['id'], (int) $handRef]
                );
                if (!$hand) {
                    throw ApiError::notFound('hand_not_found', 'Mano non trovata');
                }
            }

            $this->db->exec(
                'INSERT INTO {p}hand_scores (hand_id, team_id, points, closed_hand, entered_by)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE points = VALUES(points), closed_hand = VALUES(closed_hand),
                                         entered_by = VALUES(entered_by), entered_at = NOW()',
                [$hand['id'], $teamId, $points, $closedHand ? 1 : 0, $me['id']]
            );
            if ($closedHand) {
                // Una sola squadra può aver chiuso la mano
                $this->db->exec('UPDATE {p}hand_scores SET closed_hand = 0 WHERE hand_id = ? AND team_id <> ?', [$hand['id'], $teamId]);
            }

            if ($hand['status'] === 'open') {
                $this->closeHandIfComplete($game, $hand);
            } else {
                $this->reevaluateAfterCorrection($game);
            }
            return null;
        });
    }

    /**
     * Annulla l'ultima azione sui punteggi:
     *  - partita finita       → riapre l'ultima mano chiusa e la partita torna in corso
     *  - mano aperta con punti → cancella i punti inseriti
     *  - mano aperta vuota    → la elimina e riapre la mano precedente
     */
    public function undoLastHand(string $code, ?string $token): array
    {
        return $this->mutate($code, $token, function (array $game, ?array $me) {
            $this->requireMaster($me);
            $gid = $game['id'];

            if ($game['status'] === 'finished') {
                $open = $this->openHand($game);
                if ($open) { // non dovrebbe succedere, ma per sicurezza
                    $this->db->exec('DELETE FROM {p}hands WHERE id = ?', [$open['id']]);
                }
                $last = $this->db->one(
                    "SELECT * FROM {p}hands WHERE game_id = ? AND status = 'closed' ORDER BY number DESC LIMIT 1", [$gid]
                );
                if (!$last) {
                    throw ApiError::conflict('nothing_to_undo', 'Niente da annullare');
                }
                $this->db->exec("UPDATE {p}hands SET status = 'open', closed_at = NULL WHERE id = ?", [$last['id']]);
                $this->db->exec(
                    "UPDATE {p}games SET status = 'playing', winner_team_id = NULL, finish_reason = NULL, finished_at = NULL WHERE id = ?",
                    [$gid]
                );
                return null;
            }

            if ($game['status'] !== 'playing') {
                throw ApiError::conflict('not_playing', 'La partita non è in corso');
            }
            $open = $this->openHand($game);
            $scoreCount = (int) $this->db->value('SELECT COUNT(*) FROM {p}hand_scores WHERE hand_id = ?', [$open['id']]);
            if ($scoreCount > 0) {
                $this->db->exec('DELETE FROM {p}hand_scores WHERE hand_id = ?', [$open['id']]);
            } elseif ((int) $open['number'] > 1) {
                $this->db->exec('DELETE FROM {p}hands WHERE id = ?', [$open['id']]);
                $this->db->exec(
                    "UPDATE {p}hands SET status = 'open', closed_at = NULL WHERE game_id = ? AND number = ?",
                    [$gid, (int) $open['number'] - 1]
                );
            } else {
                throw ApiError::conflict('nothing_to_undo', 'Niente da annullare');
            }
            return null;
        });
    }

    /** Corregge chi dà le carte nella mano in corso: da lì la rotazione riparte. */
    public function setDealer(string $code, ?string $token, array $in): array
    {
        $dealerId = Validate::int($in['player_id'] ?? null, 1, PHP_INT_MAX, 'player_id');

        return $this->mutate($code, $token, function (array $game, ?array $me) use ($dealerId) {
            $this->requireMaster($me);
            if ($game['status'] !== 'playing') {
                throw ApiError::conflict('not_playing', 'La partita non è in corso');
            }
            if (!in_array($dealerId, $this->dealerOrder((int) $game['id']), true)) {
                throw ApiError::badRequest('invalid_dealer', 'Il mazziere deve essere un giocatore di una squadra');
            }
            $open = $this->openHand($game);
            if (!$open) {
                throw ApiError::conflict('no_open_hand', 'Nessuna mano aperta');
            }
            $this->db->exec('UPDATE {p}hands SET dealer_player_id = ? WHERE id = ?', [$dealerId, $open['id']]);
            return null;
        });
    }

    /** Chiude la partita subito: vince chi ha più punti (pareggio = nessun vincitore). */
    public function finish(string $code, ?string $token): array
    {
        return $this->mutate($code, $token, function (array $game, ?array $me) {
            $this->requireMaster($me);
            if ($game['status'] !== 'playing') {
                throw ApiError::conflict('not_playing', 'La partita non è in corso');
            }
            // La mano in corso non conta: si elimina con gli eventuali punti parziali
            $this->db->exec("DELETE FROM {p}hands WHERE game_id = ? AND status = 'open'", [$game['id']]);
            $winner = $this->uniqueLeader($this->teamTotals((int) $game['id']));
            $this->db->exec(
                "UPDATE {p}games SET status = 'finished', finish_reason = 'manual', winner_team_id = ?, finished_at = NOW() WHERE id = ?",
                [$winner, $game['id']]
            );
            return null;
        });
    }

    /** Nuova partita con stesse squadre, giocatori e traguardo. I giocatori tengono lo stesso token. */
    public function rematch(string $code, ?string $token): array
    {
        return $this->mutate($code, $token, function (array $game, ?array $me) {
            $this->requireMaster($me);
            if ($game['status'] !== 'finished') {
                throw ApiError::conflict('not_finished', 'La rivincita si fa a partita finita');
            }
            if ($game['rematch_game_id'] !== null) {
                $existing = $this->db->value('SELECT code FROM {p}games WHERE id = ?', [$game['rematch_game_id']]);
                if ($existing) {
                    return ['code' => $existing, 'join_url' => $this->joinUrl($existing)];
                }
            }

            $newCode = $this->newCode();
            $newId = $this->db->insert(
                'INSERT INTO {p}games (code, format, target_score) VALUES (?, ?, ?)',
                [$newCode, $game['format'], $game['target_score']]
            );
            $teamMap = [];
            foreach ($this->db->all('SELECT * FROM {p}teams WHERE game_id = ? ORDER BY position', [$game['id']]) as $t) {
                $teamMap[(int) $t['id']] = $this->db->insert(
                    'INSERT INTO {p}teams (game_id, name, color, size, position) VALUES (?, ?, ?, ?, ?)',
                    [$newId, $t['name'], $t['color'], $t['size'], $t['position']]
                );
            }
            foreach ($this->db->all('SELECT * FROM {p}players WHERE game_id = ? ORDER BY id', [$game['id']]) as $p) {
                $this->db->insert(
                    'INSERT INTO {p}players (game_id, team_id, name, is_master, token_hash) VALUES (?, ?, ?, ?, ?)',
                    [$newId, $p['team_id'] !== null ? $teamMap[(int) $p['team_id']] : null, $p['name'], $p['is_master'], $p['token_hash']]
                );
            }
            $this->db->exec('UPDATE {p}games SET rematch_game_id = ? WHERE id = ?', [$newId, $game['id']]);
            return ['code' => $newCode, 'join_url' => $this->joinUrl($newCode)];
        });
    }

    // =================================================================
    // Stato (polling)
    // =================================================================

    /**
     * Restituisce ['status' => 200|304, 'etag' => string, 'body' => array|null].
     * L'ETag combina la versione della partita e una "finestra" di 15 secondi, così
     * anche il pallino "collegato" dei giocatori si aggiorna senza modifiche alla partita.
     */
    public function state(string $code, ?string $token, ?string $ifNoneMatch): array
    {
        $game = $this->db->one('SELECT * FROM {p}games WHERE code = ?', [$this->normCode($code)]);
        if (!$game) {
            throw ApiError::notFound();
        }
        $me = $token !== null ? $this->playerByToken((int) $game['id'], $token) : null;
        if ($me) {
            $this->db->exec(
                'UPDATE {p}players SET last_seen_at = NOW()
                  WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL ' . self::LAST_SEEN_THROTTLE . ' SECOND)',
                [$me['id']]
            );
        }
        $etag = sprintf('"%d-%d"', $game['version'], intdiv(time(), self::ONLINE_SECONDS));
        if ($ifNoneMatch !== null && trim($ifNoneMatch) === $etag) {
            return ['status' => 304, 'etag' => $etag, 'body' => null];
        }
        return ['status' => 200, 'etag' => $etag, 'body' => $this->buildState($game, $me)];
    }

    private function buildState(array $game, ?array $me): array
    {
        $gid = (int) $game['id'];
        $target = (int) $game['target_score'];

        $teams = $this->db->all('SELECT id, name, color, size, position FROM {p}teams WHERE game_id = ? ORDER BY position', [$gid]);
        $players = $this->db->all(
            'SELECT id, team_id, name, is_master, token_hash IS NOT NULL AS has_device,
                    (last_seen_at IS NOT NULL AND last_seen_at > NOW() - INTERVAL ' . self::ONLINE_SECONDS . ' SECOND) AS online
               FROM {p}players WHERE game_id = ? ORDER BY id',
            [$gid]
        );
        // elapsed_s calcolato dal database: non dipende dall'orologio dei telefoni
        $hands = $this->db->all(
            'SELECT id, number, status, dealer_player_id, GREATEST(0, TIMESTAMPDIFF(SECOND, opened_at, NOW())) AS elapsed_s
               FROM {p}hands WHERE game_id = ? ORDER BY number',
            [$gid]
        );
        $dealerOrder = $this->dealerOrder($gid);
        $scoreRows = $this->db->all(
            'SELECT hs.hand_id, hs.team_id, hs.points, hs.closed_hand, p.name AS entered_by
               FROM {p}hand_scores hs
               JOIN {p}hands h ON h.id = hs.hand_id
               LEFT JOIN {p}players p ON p.id = hs.entered_by
              WHERE h.game_id = ?',
            [$gid]
        );
        $scores = []; // [hand_id][team_id] => row
        foreach ($scoreRows as $r) {
            $scores[(int) $r['hand_id']][(int) $r['team_id']] = $r;
        }

        $teamIds = array_map(fn ($t) => (int) $t['id'], $teams);
        $closed = array_values(array_filter($hands, fn ($h) => $h['status'] === 'closed'));
        $open = array_values(array_filter($hands, fn ($h) => $h['status'] === 'open'))[0] ?? null;

        // Totali progressivi mano per mano
        $totals = array_fill_keys($teamIds, 0);
        $totalsBeforeLast = $totals;
        $history = [];
        foreach ($closed as $i => $h) {
            if ($i === count($closed) - 1) {
                $totalsBeforeLast = $totals;
            }
            $row = [];
            foreach ($teamIds as $tid) {
                $p = isset($scores[(int) $h['id']][$tid]) ? (int) $scores[(int) $h['id']][$tid]['points'] : 0;
                $totals[$tid] += $p;
                $row[(string) $tid] = $p;
            }
            $history[] = ['number' => (int) $h['number'], 'scores' => $row, 'dealer_player_id' => $this->intOrNull($h['dealer_player_id'])];
        }
        $lastHand = $history ? end($history) : null;

        $ranks = $this->ranks($totals, $teamIds);
        $leaderTotal = $totals ? max($totals) : 0;

        $byTeam = [];
        $unassigned = [];
        foreach ($players as $p) {
            $item = [
                'id'         => (int) $p['id'],
                'name'       => $p['name'],
                'is_master'  => (bool) $p['is_master'],
                'has_device' => (bool) $p['has_device'],
                'online'     => (bool) $p['online'],
            ];
            if ($p['team_id'] === null) {
                $unassigned[] = $item;
            } else {
                $byTeam[(int) $p['team_id']][] = $item;
            }
        }

        $teamsOut = [];
        foreach ($teams as $t) {
            $tid = (int) $t['id'];
            $teamsOut[] = [
                'id'            => $tid,
                'name'          => $t['name'],
                'color'         => $t['color'],
                'size'          => (int) $t['size'],
                'total'         => $totals[$tid],
                'rank'          => $ranks[$tid],
                'last_delta'    => $lastHand ? $lastHand['scores'][(string) $tid] : null,
                'gap_to_leader' => $leaderTotal - $totals[$tid],
                'to_target'     => max(0, $target - $totals[$tid]),
                'players'       => $byTeam[$tid] ?? [],
            ];
        }
        // Ordine per classifica (a parità: ordine originale delle squadre)
        usort($teamsOut, fn ($a, $b) => [$a['rank'], array_search($a['id'], $teamIds, true)] <=> [$b['rank'], array_search($b['id'], $teamIds, true)]);

        $currentHand = null;
        if ($open) {
            $cur = [];
            foreach ($teamIds as $tid) {
                $s = $scores[(int) $open['id']][$tid] ?? null;
                $cur[] = [
                    'team_id'     => $tid,
                    'points'      => $s ? (int) $s['points'] : null,
                    'closed_hand' => $s ? (bool) $s['closed_hand'] : false,
                    'entered_by'  => $s['entered_by'] ?? null,
                ];
            }
            $dealer = $this->intOrNull($open['dealer_player_id']);
            $currentHand = [
                'number'                => (int) $open['number'],
                'scores'                => $cur,
                'elapsed_s'             => (int) $open['elapsed_s'],   // secondi da quando la mano è aperta
                'dealer_player_id'      => $dealer,
                'next_dealer_player_id' => $this->nextInOrder($dealerOrder, $dealer),
            ];
        }

        $rematchCode = $game['rematch_game_id'] !== null
            ? $this->db->value('SELECT code FROM {p}games WHERE id = ?', [$game['rematch_game_id']])
            : null;

        return [
            'code'           => $game['code'],
            'version'        => (int) $game['version'],
            'status'         => $game['status'],
            'format'         => $game['format'],
            'target_score'   => $target,
            'finish_reason'  => $game['finish_reason'],
            'join_url'       => $this->joinUrl($game['code']),
            'me'             => $me ? [
                'player_id' => (int) $me['id'],
                'name'      => $me['name'],
                'team_id'   => $me['team_id'] !== null ? (int) $me['team_id'] : null,
                'is_master' => (bool) $me['is_master'],
            ] : null,
            'teams'          => $teamsOut,
            'unassigned'     => $unassigned,
            'dealer_order'   => $dealerOrder,
            'current_hand'   => $currentHand,
            'hands'          => $history,
            'events'         => $this->events($game, $history, $totals, $totalsBeforeLast, $teamIds),
            'winner_team_id' => $game['winner_team_id'] !== null ? (int) $game['winner_team_id'] : null,
            'rematch_code'   => $rematchCode,
        ];
    }

    /** Eventi dell'ultima mano chiusa, per i badge del tabellone. */
    private function events(array $game, array $history, array $totals, array $before, array $teamIds): array
    {
        if (!$history) {
            return [];
        }
        $events = [];
        $last = end($history);
        $n = $last['number'];
        $target = (int) $game['target_score'];

        // Sorpasso in testa
        if (count($history) >= 2) {
            $leaderBefore = $this->uniqueLeader($before);
            $leaderNow = $this->uniqueLeader($totals);
            if ($leaderNow !== null && $leaderNow !== $leaderBefore) {
                $events[] = ['type' => 'overtake', 'team_id' => $leaderNow, 'hand' => $n];
            }
        }

        // Vicini al traguardo
        if ($game['status'] === 'playing') {
            foreach ($teamIds as $tid) {
                $missing = $target - $totals[$tid];
                if ($missing > 0 && $missing <= $target * self::NEAR_TARGET_RATIO) {
                    $events[] = ['type' => 'near_target', 'team_id' => $tid, 'to_target' => $missing];
                }
            }
        }

        // Mano record della partita
        if (count($history) >= 2) {
            $lastMax = max($last['scores']);
            $prevMax = PHP_INT_MIN;
            foreach (array_slice($history, 0, -1) as $h) {
                $prevMax = max($prevMax, max($h['scores']));
            }
            if ($lastMax > $prevMax && $lastMax > 0) {
                foreach ($last['scores'] as $tid => $p) {
                    if ($p === $lastMax) {
                        $events[] = ['type' => 'best_hand', 'team_id' => (int) $tid, 'points' => $p, 'hand' => $n];
                    }
                }
            }
        }
        return $events;
    }

    // =================================================================
    // Regole
    // =================================================================

    /** Se tutte le squadre hanno inserito i punti: chiude la mano, poi vittoria o mano successiva. */
    private function closeHandIfComplete(array $game, array $hand): void
    {
        $teamCount = (int) $this->db->value('SELECT COUNT(*) FROM {p}teams WHERE game_id = ?', [$game['id']]);
        $scoreCount = (int) $this->db->value('SELECT COUNT(*) FROM {p}hand_scores WHERE hand_id = ?', [$hand['id']]);
        if ($scoreCount < $teamCount) {
            return;
        }
        $this->db->exec("UPDATE {p}hands SET status = 'closed', closed_at = NOW() WHERE id = ?", [$hand['id']]);

        $winner = $this->targetWinner($game);
        if ($winner !== null) {
            $this->db->exec(
                "UPDATE {p}games SET status = 'finished', finish_reason = 'target', winner_team_id = ?, finished_at = NOW() WHERE id = ?",
                [$winner, $game['id']]
            );
        } else {
            $this->openNextHand($game);
        }
    }

    /** Dopo la correzione di una mano già chiusa, ricontrolla chi vince. */
    private function reevaluateAfterCorrection(array $game): void
    {
        $gid = (int) $game['id'];
        $winner = $this->targetWinner($game);

        if ($game['status'] === 'playing') {
            // La correzione porta qualcuno oltre il traguardo: chiude se la mano in corso è ancora vuota
            if ($winner !== null) {
                $open = $this->openHand($game);
                $hasScores = $open && (int) $this->db->value('SELECT COUNT(*) FROM {p}hand_scores WHERE hand_id = ?', [$open['id']]) > 0;
                if (!$hasScores) {
                    if ($open) {
                        $this->db->exec('DELETE FROM {p}hands WHERE id = ?', [$open['id']]);
                    }
                    $this->db->exec(
                        "UPDATE {p}games SET status = 'finished', finish_reason = 'target', winner_team_id = ?, finished_at = NOW() WHERE id = ?",
                        [$winner, $gid]
                    );
                }
            }
            return;
        }

        if ($game['status'] === 'finished') {
            if ($game['finish_reason'] === 'manual') {
                $this->db->exec('UPDATE {p}games SET winner_team_id = ? WHERE id = ?', [$this->uniqueLeader($this->teamTotals($gid)), $gid]);
            } elseif ($winner !== null) {
                $this->db->exec('UPDATE {p}games SET winner_team_id = ? WHERE id = ?', [$winner, $gid]);
            } else {
                // Nessuno ha più raggiunto il traguardo: si torna a giocare
                $this->db->exec(
                    "UPDATE {p}games SET status = 'playing', finish_reason = NULL, winner_team_id = NULL, finished_at = NULL WHERE id = ?",
                    [$gid]
                );
                $this->openNextHand($game);
            }
        }
    }

    /** Vince chi ha il totale più alto, se è ≥ traguardo e non è a pari merito. */
    private function targetWinner(array $game): ?int
    {
        $totals = $this->teamTotals((int) $game['id']);
        $leader = $this->uniqueLeader($totals);
        return ($leader !== null && $totals[$leader] >= (int) $game['target_score']) ? $leader : null;
    }

    private function openNextHand(array $game): void
    {
        $gid = (int) $game['id'];
        $last = $this->db->one('SELECT number, dealer_player_id FROM {p}hands WHERE game_id = ? ORDER BY number DESC LIMIT 1', [$gid]);
        $next = $last ? (int) $last['number'] + 1 : 1;
        $dealer = $this->nextInOrder($this->dealerOrder($gid), $last ? $this->intOrNull($last['dealer_player_id']) : null);
        $this->db->insert('INSERT INTO {p}hands (game_id, number, dealer_player_id) VALUES (?, ?, ?)', [$gid, $next, $dealer]);
    }

    /**
     * Ordine in cui gira il mazzo (senso antiorario al tavolo): si alternano le squadre,
     * 1° giocatore di ogni squadra, poi il 2°... Dentro la squadra conta l'ordine di ingresso.
     * Si ricalcola ogni volta, così vale anche se il master sposta qualcuno o entra un giocatore.
     *
     * @return list<int> id dei giocatori
     */
    private function dealerOrder(int $gameId): array
    {
        $rows = $this->db->all(
            'SELECT p.id, p.team_id FROM {p}players p JOIN {p}teams t ON t.id = p.team_id
              WHERE p.game_id = ? ORDER BY t.position, p.id',
            [$gameId]
        );
        $byTeam = [];
        foreach ($rows as $r) {
            $byTeam[(int) $r['team_id']][] = (int) $r['id'];
        }
        $order = [];
        for ($i = 0; $byTeam; $i++) {
            foreach ($byTeam as $tid => $ids) {
                if (isset($ids[$i])) {
                    $order[] = $ids[$i];
                } elseif ($i >= count($ids)) {
                    unset($byTeam[$tid]);
                }
            }
        }
        return $order;
    }

    /** Il giocatore che segue $current nel giro (il primo se $current manca o non è più in squadra). */
    private function nextInOrder(array $order, ?int $current): ?int
    {
        if (!$order) {
            return null;
        }
        $i = $current !== null ? array_search($current, $order, true) : false;
        return $i === false ? $order[0] : $order[($i + 1) % count($order)];
    }

    private function intOrNull(mixed $v): ?int
    {
        return $v === null ? null : (int) $v;
    }

    /** @return array<int,int> team_id => totale (solo mani chiuse) */
    private function teamTotals(int $gameId): array
    {
        $out = [];
        foreach ($this->db->all('SELECT team_id, total FROM {p}v_team_totals WHERE game_id = ? ORDER BY position', [$gameId]) as $r) {
            $out[(int) $r['team_id']] = (int) $r['total'];
        }
        return $out;
    }

    /** Squadra con il totale più alto, oppure null se c'è un pari merito in testa. */
    private function uniqueLeader(array $totals): ?int
    {
        if (!$totals) {
            return null;
        }
        $max = max($totals);
        $leaders = array_keys($totals, $max, true);
        return count($leaders) === 1 ? (int) $leaders[0] : null;
    }

    /** Classifica "sportiva": a pari punti stessa posizione (1, 2, 2, 4). */
    private function ranks(array $totals, array $teamIds): array
    {
        $ranks = [];
        foreach ($teamIds as $tid) {
            $better = 0;
            foreach ($totals as $other) {
                if ($other > $totals[$tid]) {
                    $better++;
                }
            }
            $ranks[$tid] = $better + 1;
        }
        return $ranks;
    }

    // =================================================================
    // Helper
    // =================================================================

    /**
     * Esegue una modifica in transazione con lock sulla partita e incrementa la versione.
     * Se $fn restituisce null, la risposta è lo stato aggiornato della partita.
     */
    private function mutate(string $code, ?string $token, callable $fn): array
    {
        $code = $this->normCode($code);
        $result = $this->db->transaction(function () use ($code, $token, $fn) {
            $game = $this->db->one('SELECT * FROM {p}games WHERE code = ? FOR UPDATE', [$code]);
            if (!$game) {
                throw ApiError::notFound();
            }
            $me = $token !== null ? $this->playerByToken((int) $game['id'], $token) : null;
            $r = $fn($game, $me);
            $this->db->exec('UPDATE {p}games SET version = version + 1 WHERE id = ?', [$game['id']]);
            return $r;
        });
        return $result ?? $this->state($code, $token, null)['body'];
    }

    private function playerByToken(int $gameId, string $token): ?array
    {
        return $this->db->one('SELECT * FROM {p}players WHERE game_id = ? AND token_hash = ?', [$gameId, Auth::hash($token)]);
    }

    private function requireMe(?array $me): void
    {
        if ($me === null) {
            throw ApiError::unauthorized();
        }
    }

    private function requireMaster(?array $me): void
    {
        $this->requireMe($me);
        if (!$me['is_master']) {
            throw ApiError::forbidden('not_master', 'Solo il master può farlo');
        }
    }

    private function findPlayer(array $game, int $playerId): array
    {
        $p = $this->db->one('SELECT * FROM {p}players WHERE id = ? AND game_id = ?', [$playerId, $game['id']]);
        if (!$p) {
            throw ApiError::notFound('player_not_found', 'Giocatore non trovato');
        }
        return $p;
    }

    private function openHand(array $game): ?array
    {
        return $this->db->one("SELECT * FROM {p}hands WHERE game_id = ? AND status = 'open' LIMIT 1", [$game['id']]);
    }

    private function assertTeamHasRoom(array $game, int $teamId): void
    {
        $team = $this->db->one('SELECT id, size FROM {p}teams WHERE id = ? AND game_id = ?', [$teamId, $game['id']]);
        if (!$team) {
            throw ApiError::notFound('team_not_found', 'Squadra non trovata');
        }
        $taken = (int) $this->db->value('SELECT COUNT(*) FROM {p}players WHERE team_id = ?', [$teamId]);
        if ($taken >= (int) $team['size']) {
            throw ApiError::conflict('team_full', 'La squadra è al completo');
        }
    }

    private function newCode(): string
    {
        for ($attempt = 0; $attempt < 30; $attempt++) {
            $code = '';
            for ($i = 0; $i < 4; $i++) {
                $code .= self::CODE_ALPHABET[random_int(0, strlen(self::CODE_ALPHABET) - 1)];
            }
            if (!$this->db->value('SELECT 1 FROM {p}games WHERE code = ?', [$code])) {
                return $code;
            }
        }
        throw new \RuntimeException('Impossibile generare un codice partita libero');
    }

    private function normCode(string $code): string
    {
        return strtoupper($code);
    }

    private function joinUrl(string $code): string
    {
        // Il QR apre l'app direttamente sulla schermata di ingresso: .../pinella/?join=KX7P
        return rtrim((string) ($this->config['base_url'] ?? ''), '/') . '/?join=' . $code;
    }
}
