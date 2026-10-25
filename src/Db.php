<?php
declare(strict_types=1);

namespace Pinella;

use PDO;

/**
 * Piccolo wrapper su PDO: connessione pigra, query preparate, transazioni.
 * Nelle query il segnaposto {p} viene sostituito dal prefisso delle tabelle (default "pin_"),
 * così Pinella può condividere il database con altre app (es. Gruzzolo).
 */
final class Db
{
    private ?PDO $pdo = null;
    private readonly string $prefix;

    public function __construct(private readonly array $cfg)
    {
        $prefix = $cfg['table_prefix'] ?? 'pin_';
        if (!preg_match('/^[a-z0-9_]{0,16}$/', $prefix)) {
            throw new \InvalidArgumentException('table_prefix non valido: solo lettere minuscole, cifre e _');
        }
        $this->prefix = $prefix;
    }

    /** Sostituisce {p} con il prefisso delle tabelle. */
    private function sql(string $sql): string
    {
        return str_replace('{p}', $this->prefix, $sql);
    }

    public function pdo(): PDO
    {
        if ($this->pdo === null) {
            $dsn = sprintf('mysql:host=%s;dbname=%s;charset=utf8mb4', $this->cfg['host'], $this->cfg['name']);
            $this->pdo = new PDO($dsn, $this->cfg['user'], $this->cfg['password'], [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]);
            $this->pdo->exec("SET time_zone = '+00:00'");
        }
        return $this->pdo;
    }

    public function one(string $sql, array $params = []): ?array
    {
        $st = $this->pdo()->prepare($this->sql($sql));
        $st->execute($params);
        $row = $st->fetch();
        return $row === false ? null : $row;
    }

    public function all(string $sql, array $params = []): array
    {
        $st = $this->pdo()->prepare($this->sql($sql));
        $st->execute($params);
        return $st->fetchAll();
    }

    public function value(string $sql, array $params = []): mixed
    {
        $st = $this->pdo()->prepare($this->sql($sql));
        $st->execute($params);
        $v = $st->fetchColumn();
        return $v === false ? null : $v;
    }

    public function exec(string $sql, array $params = []): int
    {
        $st = $this->pdo()->prepare($this->sql($sql));
        $st->execute($params);
        return $st->rowCount();
    }

    public function insert(string $sql, array $params = []): int
    {
        $this->exec($sql, $params);
        return (int) $this->pdo()->lastInsertId();
    }

    /** Esegue $fn in una transazione; rollback automatico su eccezione. */
    public function transaction(callable $fn): mixed
    {
        $pdo = $this->pdo();
        $pdo->beginTransaction();
        try {
            $result = $fn();
            $pdo->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }
}
