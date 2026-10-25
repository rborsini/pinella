<?php
// Copia questo file in config.php e inserisci i dati del database.
// config.php non deve essere raggiungibile dal web e non va su Git.

return [
    'db' => [
        'host'         => 'localhost',
        'name'         => 'nomedb_gruzzolo',   // lo stesso database di Gruzzolo
        'user'         => 'utente_db',
        'password'     => 'cambiami',
        // Prefisso delle tabelle di Pinella: il database è condiviso con Gruzzolo.
        // Deve coincidere con quello usato in database/schema.sql.
        'table_prefix' => 'pin_',
    ],

    // Indirizzo pubblico di Pinella, senza "/" finale: serve per il link del QR
    'base_url' => 'https://gruzzolo.netsons.org/pinella',

    // Solo per sviluppo: origine ammessa per chiamate da un altro dominio (es. 'http://localhost:5173').
    // In produzione frontend e API stanno sullo stesso dominio: lascia null.
    'cors_origin' => null,

    // true = mostra il dettaglio degli errori 500 nella risposta. In produzione: false.
    'debug' => false,
];
