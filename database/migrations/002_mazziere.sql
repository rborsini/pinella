-- =====================================================================
-- Pinella 0.4.0 – turni del mazziere (issue #4)
--
-- Da eseguire UNA VOLTA in phpMyAdmin sul database che contiene le
-- tabelle pin_*, PRIMA di caricare i file della versione 0.4.0.
-- Le partite esistenti restano valide: le mani già giocate non hanno
-- mazziere e dalla prossima mano la rotazione parte dal primo del giro.
-- =====================================================================

-- Chi dà le carte in ogni mano
ALTER TABLE pin_hands
    ADD COLUMN dealer_player_id INT UNSIGNED NULL AFTER status,
    ADD CONSTRAINT pin_fk_hands_dealer FOREIGN KEY (dealer_player_id) REFERENCES pin_players(id) ON DELETE SET NULL;

-- Stato 'suspended' riservato allo storico delle partite (Rilascio 3):
-- aggiunto ora per non dover modificare di nuovo la tabella più avanti
ALTER TABLE pin_games
    MODIFY status ENUM('lobby','playing','suspended','finished') NOT NULL DEFAULT 'lobby';
