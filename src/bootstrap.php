<?php
declare(strict_types=1);

// Carica le classi Pinella\* da src/ e restituisce la configurazione.

if (!defined('PINELLA_ROOT')) {
    define('PINELLA_ROOT', dirname(__DIR__));
}

spl_autoload_register(static function (string $class): void {
    $prefix = 'Pinella\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }
    $file = __DIR__ . '/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    if (is_file($file)) {
        require $file;
    }
});

$configFile = PINELLA_ROOT . '/config/config.php';
if (!is_file($configFile)) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'config_missing', 'message' => 'Copia config/config.example.php in config/config.php']);
    exit;
}

return require $configFile;
