import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION_PATTERNS = [
  // built npm package (primary target: 7.0.0-rc14)
  { file: ['lib/Defaults/index.js', 'src/Defaults/index.ts'], regex: /const version = \[(\d+),\s*(\d+),\s*(\d+)\]/, kind: 'const' },
  { file: ['lib/Utils/generics.js', 'src/Utils/generics.ts'], regex: /const baileysVersion = \[(\d+),\s*(\d+),\s*(\d+)\]/, kind: 'const' },
  // git checkout / source layout
  { file: ['lib/Defaults/baileys-version.json', 'src/Defaults/baileys-version.json'], regex: null, kind: 'json' },
];

/**
 * Read the WhatsApp handshake version currently baked into the installed Baileys.
 * @param {string} baileysPath
 * @returns {[number, number, number] | null}
 */
export function getCurrentVersion(baileysPath) {
  for (const { file, regex, kind } of VERSION_PATTERNS) {
    for (const rel of [].concat(file)) {
      const abs = join(baileysPath, rel);
      if (!existsSync(abs)) continue;
      const content = readFileSync(abs, 'utf8');
      if (kind === 'json') {
        try {
          const v = JSON.parse(content).version;
          if (Array.isArray(v) && v.length === 3) return v.map(Number);
        } catch {
          /* fall through */
        }
      } else {
        const m = content.match(regex);
        if (m) return [+m[1], +m[2], +m[3]];
      }
    }
  }
  return null;
}

/** lexicographic compare of [major, minor, patch] triples */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function formatVersion(v) {
  return v ? v.join('.') : 'unknown';
}
