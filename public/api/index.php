<?php
declare(strict_types=1);

/*
 * Pinella – front controller delle API.
 * Tutte le richieste /api/* arrivano qui (vedi .htaccess).
 *
 * PINELLA_ROOT è la cartella che contiene src/ e config/. Si cerca, in ordine:
 *   1. repository di sviluppo:        <repo>/public/api/index.php   → <repo>/src
 *   2. fuori dalla cartella pubblica: /home/<utente>/pinella-app/src  (consigliato)
 *   3. dentro la sottocartella, protetta da .htaccess: public_html/pinella/_app/src
 *      (se l'FTP del piano gratuito non permette di salire sopra public_html)
 */
$candidates = [
    dirname(__DIR__, 2),               // 1. <repo>
    dirname(__DIR__, 3) . '/pinella-app', // 2. /home/<utente>/pinella-app  (da public_html/pinella/api)
    dirname(__DIR__) . '/_app',        // 3. public_html/pinella/_app
];
$root = null;
foreach ($candidates as $c) {
    if (is_file($c . '/src/GameService.php')) { $root = $c; break; }
}
if ($root === null) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"error":"app_missing","message":"Cartella src/ non trovata: vedi README, sezione deploy"}';
    exit;
}
define('PINELLA_ROOT', $root);

use Pinella\{ApiError, Auth, Db, GameService, Http, Version};

$config = require PINELLA_ROOT . '/src/bootstrap.php';

// Pinella vive nello stesso dominio di Gruzzolo: le API non usano cookie e
// rispondono solo JSON, senza poter essere incorporate o interpretate come pagine.
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
header('X-Frame-Options: DENY');
// Versione del server: la PWA la confronta con la propria e propone di ricaricare
header('X-Pinella-Version: ' . Version::APP);
Http::cors($config['cors_origin'] ?? null);
$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'OPTIONS') {
    Http::send(204, null);
    exit;
}

// Percorso dopo "/api", es. "/games/KX7P/state"
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$pos = strpos($uri, '/api');
$path = rtrim($pos === false ? $uri : substr($uri, $pos + 4), '/') ?: '/';

$C = '(?<code>[A-Za-z0-9]{4})';
$routes = [
    ['GET',    '#^/health$#',                                              'health'],
    ['POST',   '#^/games$#',                                               'create'],
    ['GET',    "#^/games/$C$#",                                            'summary'],
    ['POST',   "#^/games/$C/players$#",                                    'join'],
    ['POST',   "#^/games/$C/players/manual$#",                             'addManual'],
    ['PATCH',  "#^/games/$C/players/(?<id>\d+)$#",                         'movePlayer'],
    ['DELETE', "#^/games/$C/players/(?<id>\d+)$#",                         'removePlayer'],
    ['POST',   "#^/games/$C/shuffle$#",                                    'shuffle'],
    ['POST',   "#^/games/$C/start$#",                                      'start'],
    ['GET',    "#^/games/$C/state$#",                                      'state'],
    ['PUT',    "#^/games/$C/hands/(?<hand>current|\d+)/scores/(?<team>\d+)$#", 'putScore'],
    ['DELETE', "#^/games/$C/hands/last$#",                                 'undoLast'],
    ['POST',   "#^/games/$C/finish$#",                                     'finish'],
    ['POST',   "#^/games/$C/rematch$#",                                    'rematch'],
];

try {
    $action = null;
    $m = [];
    $pathMatched = false;
    foreach ($routes as [$verb, $regex, $name]) {
        if (preg_match($regex, $path, $m)) {
            $pathMatched = true;
            if ($verb === $method) {
                $action = $name;
                break;
            }
        }
    }
    if ($action === null) {
        throw $pathMatched
            ? new ApiError(405, 'method_not_allowed', 'Metodo non permesso')
            : ApiError::notFound('route_not_found', 'Endpoint inesistente');
    }

    $svc = new GameService(new Db($config['db']), $config);
    $token = Auth::tokenFromRequest();
    $code = $m['code'] ?? '';

    switch ($action) {
        case 'health':
            Http::send(200, ['ok' => true, 'version' => Version::APP, 'time' => gmdate('c')]);
            break;
        case 'create':
            Http::send(201, $svc->createGame(Http::jsonBody()));
            break;
        case 'summary':
            Http::send(200, $svc->publicSummary($code));
            break;
        case 'join':
            Http::send(201, $svc->join($code, Http::jsonBody()));
            break;
        case 'addManual':
            Http::send(201, $svc->addManualPlayer($code, $token, Http::jsonBody()));
            break;
        case 'movePlayer':
            Http::send(200, $svc->movePlayer($code, $token, (int) $m['id'], Http::jsonBody()));
            break;
        case 'removePlayer':
            Http::send(200, $svc->removePlayer($code, $token, (int) $m['id']));
            break;
        case 'shuffle':
            Http::send(200, $svc->shuffle($code, $token));
            break;
        case 'start':
            Http::send(200, $svc->start($code, $token));
            break;
        case 'state':
            $r = $svc->state($code, $token, $_SERVER['HTTP_IF_NONE_MATCH'] ?? null);
            Http::send($r['status'], $r['body'], ['ETag' => $r['etag']]);
            break;
        case 'putScore':
            Http::send(200, $svc->putScore($code, $token, $m['hand'], (int) $m['team'], Http::jsonBody()));
            break;
        case 'undoLast':
            Http::send(200, $svc->undoLastHand($code, $token));
            break;
        case 'finish':
            Http::send(200, $svc->finish($code, $token));
            break;
        case 'rematch':
            Http::send(201, $svc->rematch($code, $token));
            break;
    }
} catch (ApiError $e) {
    Http::send($e->status, ['error' => $e->errorCode, 'message' => $e->getMessage()]);
} catch (\Throwable $e) {
    error_log('[pinella] ' . $e);
    Http::send(500, [
        'error'   => 'server_error',
        'message' => !empty($config['debug']) ? $e->getMessage() : 'Errore interno',
    ]);
}
