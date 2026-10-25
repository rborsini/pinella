<?php
declare(strict_types=1);

namespace Pinella;

final class Validate
{
    public static function name(mixed $v, string $field, int $max = 30): string
    {
        if (!is_string($v)) {
            throw ApiError::badRequest('invalid_' . $field, "Il campo $field è obbligatorio");
        }
        $v = trim(preg_replace('/[\x00-\x1F\x7F]/u', '', $v) ?? '');
        $len = mb_strlen($v);
        if ($len < 1 || $len > $max) {
            throw ApiError::badRequest('invalid_' . $field, "Il campo $field deve avere da 1 a $max caratteri");
        }
        return $v;
    }

    public static function int(mixed $v, int $min, int $max, string $field): int
    {
        if (is_string($v) && preg_match('/^-?\d+$/', $v)) {
            $v = (int) $v;
        }
        if (!is_int($v) || $v < $min || $v > $max) {
            throw ApiError::badRequest('invalid_' . $field, "Il campo $field deve essere un intero tra $min e $max");
        }
        return $v;
    }

    public static function optionalInt(mixed $v, int $min, int $max, string $field): ?int
    {
        return $v === null ? null : self::int($v, $min, $max, $field);
    }

    public static function color(mixed $v, string $field): string
    {
        if (!is_string($v) || !preg_match('/^#[0-9A-Fa-f]{6}$/', $v)) {
            throw ApiError::badRequest('invalid_' . $field, "Il campo $field deve essere un colore #RRGGBB");
        }
        return strtoupper($v);
    }
}
