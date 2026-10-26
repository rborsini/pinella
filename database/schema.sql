-- =====================================================================
-- Pinella – schema database MVP
-- MariaDB 10.x / MySQL 8 · charset utf8mb4
--
-- Tutte le tabelle hanno il prefisso "pin_" perché il database è condiviso
-- con Gruzzolo. Se cambi prefisso, cambialo qui (trova/sostituisci "pin_")
-- e in config.php ('table_prefix').
-- =====================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- Partita
-- ---------------------------------------------------------------------
CREATE TABLE pin_games (
    id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    code             CHAR(4)       NOT NULL,                 -- codice da digitare / nel QR, es. KX7P
    format           VARCHAR(20)   NOT NULL,                 -- '1v1' | '2v2' | '3v3' | '2v2v2' | '3x1' | '4x1' | '5x1' | 'custom'
    target_score     INT           NOT NULL,                 -- punti per vincere, es. 1500
    status           ENUM('lobby','playing','suspended','finished') NOT NULL DEFAULT 'lobby',  -- 'suspended': riservato allo storico (ripresa partite)
    finish_reason    ENUM('target','manual') NULL,           -- traguardo raggiunto o chiusa dal master
    version          INT UNSIGNED  NOT NULL DEFAULT 1,       -- +1 a ogni modifica: serve al polling (ETag)
    winner_team_id   INT UNSIGNED  NULL,
    rematch_game_id  INT UNSIGNED  NULL,                     -- partita creata con "Rivincita"
    created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at       DATETIME      NULL,
    finished_at      DATETIME      NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_games_code (code)                          -- i codici si liberano quando la partita viene cancellata
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Squadre (nei formati a singoli (3, 4 o 5) ogni giocatore ha la sua squadra)
-- ---------------------------------------------------------------------
CREATE TABLE pin_teams (
    id          INT UNSIGNED     NOT NULL AUTO_INCREMENT,
    game_id     INT UNSIGNED     NOT NULL,
    name        VARCHAR(40)      NOT NULL,                   -- 'Corallo', 'Turchese'...
    color       CHAR(7)          NOT NULL,                   -- '#FF6B57'
    size        TINYINT UNSIGNED NOT NULL,                   -- giocatori previsti
    position    TINYINT UNSIGNED NOT NULL,                   -- ordine di visualizzazione
    PRIMARY KEY (id),
    KEY ix_teams_game (game_id),
    CONSTRAINT pin_fk_teams_game FOREIGN KEY (game_id) REFERENCES pin_games(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE pin_games
    ADD CONSTRAINT pin_fk_games_winner  FOREIGN KEY (winner_team_id)  REFERENCES pin_teams(id) ON DELETE SET NULL,
    ADD CONSTRAINT pin_fk_games_rematch FOREIGN KEY (rematch_game_id) REFERENCES pin_games(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- Giocatori di una partita
--  - entrati da QR/codice: hanno un token (salvato come hash SHA-256)
--  - aggiunti a mano dal master: token NULL, non possono inserire punti
--  - la rivincita copia i giocatori con lo stesso token: per questo
--    l'unicità del token è per partita, non globale
-- ---------------------------------------------------------------------
CREATE TABLE pin_players (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    game_id      INT UNSIGNED NOT NULL,
    team_id      INT UNSIGNED NULL,                          -- NULL finché non sceglie / non viene sorteggiato
    name         VARCHAR(30)  NOT NULL,
    is_master    TINYINT(1)   NOT NULL DEFAULT 0,
    token_hash   CHAR(64)     NULL,
    joined_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME     NULL,                          -- aggiornato dal polling: mostra chi è collegato
    PRIMARY KEY (id),
    UNIQUE KEY uq_players_game_token (game_id, token_hash),
    KEY ix_players_team (team_id),
    CONSTRAINT pin_fk_players_game FOREIGN KEY (game_id) REFERENCES pin_games(id) ON DELETE CASCADE,
    CONSTRAINT pin_fk_players_team FOREIGN KEY (team_id) REFERENCES pin_teams(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Mani
--  - una sola mano 'open' per partita alla volta
--  - si chiude quando tutte le squadre hanno inserito il punteggio
-- ---------------------------------------------------------------------
CREATE TABLE pin_hands (
    id          INT UNSIGNED      NOT NULL AUTO_INCREMENT,
    game_id     INT UNSIGNED      NOT NULL,
    number      SMALLINT UNSIGNED NOT NULL,                  -- 1, 2, 3...
    status      ENUM('open','closed') NOT NULL DEFAULT 'open',
    dealer_player_id INT UNSIGNED NULL,                      -- chi dà le carte in questa mano
    opened_at   DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at   DATETIME          NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_hands_game_number (game_id, number),
    CONSTRAINT pin_fk_hands_game FOREIGN KEY (game_id) REFERENCES pin_games(id) ON DELETE CASCADE,
    CONSTRAINT pin_fk_hands_dealer FOREIGN KEY (dealer_player_id) REFERENCES pin_players(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Punteggio di una squadra in una mano (può essere negativo)
-- ---------------------------------------------------------------------
CREATE TABLE pin_hand_scores (
    hand_id        INT UNSIGNED NOT NULL,
    team_id        INT UNSIGNED NOT NULL,
    points         INT          NOT NULL,                    -- già comprensivo di eventuale bonus chiusura
    closed_hand    TINYINT(1)   NOT NULL DEFAULT 0,          -- "abbiamo chiuso noi" (per statistiche)
    entered_by     INT UNSIGNED NULL,                        -- players.id
    entered_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (hand_id, team_id),
    KEY ix_hand_scores_team (team_id),
    CONSTRAINT pin_fk_hs_hand   FOREIGN KEY (hand_id)    REFERENCES pin_hands(id)   ON DELETE CASCADE,
    CONSTRAINT pin_fk_hs_team   FOREIGN KEY (team_id)    REFERENCES pin_teams(id)   ON DELETE CASCADE,
    CONSTRAINT pin_fk_hs_player FOREIGN KEY (entered_by) REFERENCES pin_players(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Vista di comodo: totali per squadra (solo mani chiuse)
-- ---------------------------------------------------------------------
CREATE VIEW pin_v_team_totals AS
SELECT  t.game_id,
        t.id                          AS team_id,
        t.name,
        t.color,
        t.position,
        COALESCE(SUM(CASE WHEN h.status = 'closed' THEN hs.points END), 0) AS total
FROM    pin_teams t
LEFT JOIN pin_hand_scores hs ON hs.team_id = t.id
LEFT JOIN pin_hands h        ON h.id = hs.hand_id
GROUP BY t.game_id, t.id, t.name, t.color, t.position;
