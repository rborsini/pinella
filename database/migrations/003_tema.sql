-- =====================================================================
-- Pinella 0.8.0 – stile grafico della partita (issue #17)
--
-- Da eseguire UNA VOLTA in phpMyAdmin sul database che contiene le
-- tabelle pin_*, PRIMA di caricare i file della versione 0.8.0.
-- Le partite esistenti prendono lo stile "classico" (quello di sempre).
-- =====================================================================

ALTER TABLE pin_games
    ADD COLUMN theme VARCHAR(20) NOT NULL DEFAULT 'classico' AFTER target_score;
