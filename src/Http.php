<?php
declare(strict_types=1);

namespace Pinella;

final class Http
{
    public static function jsonBody(): array
    {
        $raw = file_get_contents('php://input');
        if ($raw === '' || $raw === false) {
            return [];
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            throw ApiError::badRequest('invalid_json', 'Il corpo della richiesta non è un JSON valido');
        }
        return $data;
    }

    public static function send(int $status, ?array $body, array $headers = []): void
    {
        http_response_code($status);
        header('Cache-Control: no-cache');
        foreach ($headers as $k => $v) {
            header("$k: $v");
        }
        if ($body !== null) {
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        }
    }

    public static function cors(?string $origin): void
    {
        if (!$origin) {
            return;
        }
        header("Access-Control-Allow-Origin: $origin");
        header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, X-Player-Token, If-None-Match');
        header('Access-Control-Expose-Headers: ETag');
        header('Vary: Origin');
    }
}
