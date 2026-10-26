<?php
declare(strict_types=1);

namespace Pinella;

/**
 * Versione di Pinella (semver). Non modificarla a mano:
 *     python3 tools/set_version.py X.Y.Z
 * aggiorna insieme questo file, app.js, index.html e sw.js.
 */
final class Version
{
    public const APP = '0.3.0';
}
