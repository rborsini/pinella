<?php
declare(strict_types=1);

namespace Pinella;

/** Token dei giocatori: casuali, mandati nell'header X-Player-Token, salvati solo come hash. */
final class Auth
{
    public static function newToken(): string
    {
        return bin2hex(random_bytes(32));
    }

    public static function hash(string $token): string
    {
        return hash('sha256', $token);
    }

    public static function tokenFromRequest(): ?string
    {
        $t = $_SERVER['HTTP_X_PLAYER_TOKEN'] ?? null;
        return (is_string($t) && preg_match('/^[a-f0-9]{64}$/', $t)) ? $t : null;
    }
}
