import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Locate the installed @whiskeysockets/baileys package.
 *
 * Resolution order:
 *   1. explicit `baileysPath` option
 *   2. resolve from the current working directory (user's project)
 *   3. resolve from this plugin's own location (hoisted installs)
 *
 * @param {string} [explicit]
 * @returns {string} absolute path to the baileys package root
 */
export function resolveBaileysPath(explicit) {
  if (explicit) {
    const p = normalizeAndCheck(explicit);
    if (!p) {
      throw new Error(`baileysPath "${explicit}" does not look like a @whiskeysockets/baileys package (WAProto/ or lib/Defaults missing)`);
    }
    return p;
  }

  const attempts = [
    createRequire(join(process.cwd(), 'package.json')),
    createRequire(import.meta.url),
  ];

  for (const req of attempts) {
    try {
      const pkgJson = req.resolve('@whiskeysockets/baileys/package.json');
      const p = normalizeAndCheck(dirname(pkgJson));
      if (p) return p;
    } catch {
      // not resolvable from here, try next
    }
  }

  throw new Error(
    'Could not resolve @whiskeysockets/baileys. Install it in your project or pass { baileysPath: "/path/to/node_modules/@whiskeysockets/baileys" }'
  );
}

function normalizeAndCheck(dir) {
  if (!dir || !existsSync(dir)) return null;
  const hasWAProto = existsSync(join(dir, 'WAProto', 'WAProto.proto')) || existsSync(join(dir, 'WAProto', 'index.js'));
  const hasDefaults = existsSync(join(dir, 'lib', 'Defaults', 'index.js')) || existsSync(join(dir, 'src', 'Defaults', 'index.ts'));
  return hasWAProto && hasDefaults ? dir : null;
}

/** Read the baileys package version string (e.g. "7.0.0-rc14"). */
export function getBaileysPackageVersion(baileysPath) {
  try {
    const pkg = JSON.parse(readFileSync(join(baileysPath, 'package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
