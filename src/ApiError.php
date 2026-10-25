<?php
declare(strict_types=1);

namespace Pinella;

/** Errore previsto: diventa una risposta JSON { error, message } con lo status HTTP indicato. */
final class ApiError extends \RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message
    ) {
        parent::__construct($message);
    }

    public static function badRequest(string $code, string $message): self   { return new self(400, $code, $message); }
    public static function unauthorized(): self { return new self(401, 'unauthorized', 'Token mancante o non valido'); }
    public static function forbidden(string $code, string $message): self    { return new self(403, $code, $message); }
    public static function notFound(string $code = 'game_not_found', string $message = 'Partita non trovata'): self { return new self(404, $code, $message); }
    public static function conflict(string $code, string $message): self     { return new self(409, $code, $message); }
}
