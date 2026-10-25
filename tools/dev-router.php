<?php
// Router per il server di sviluppo integrato di PHP (non legge .htaccess).
// Avvio, dalla cartella del progetto:
//   php -S localhost:8080 -t public tools/dev-router.php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (str_starts_with($path, '/api')) {
    require __DIR__ . '/../public/api/index.php';
    return true;
}
return false; // file statici serviti normalmente
