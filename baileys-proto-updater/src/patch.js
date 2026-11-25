/**
 * Apply an extracted+generated WAProto to an installed Baileys package on disk.
 *
 * - backs up originals to <baileys>/.proto-updater-backup/ (first time only)
 * - replaces WAProto/WAProto.proto, WAProto/index.js, WAProto/index.d.ts
 * - rewrites the handshake version in all locations that exist:
 *     lib/Defaults/index.js | src/Defaults/index.ts      (const version = [...])
 *     lib/Utils/generics.js | src/Utils/generics.ts      (const baileysVersion = [...])
 *     lib|src/Defaults/baileys-version.json              ({"version":[...]})
 * - full rollback on any failure
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getCurrentVersion } from './version.js';

const WA_FILES = [
  ['WAProto/WAProto.proto', 'WAProto/WAProto.proto'],
  ['WAProto/index.js', 'WAProto/index.js'],
  ['WAProto/index.d.ts', 'WAProto/index.d.ts'],
];

const VERSION_TARGETS = [
  { rel: 'lib/Defaults/index.js', kind: 'const', re: /(const version = \[)(\d+),\s*(\d+),\s*(\d+)(\])/ },
  { rel: 'src/Defaults/index.ts', kind: 'const', re: /(const version = \[)(\d+),\s*(\d+),\s*(\d+)(\])/ },
  { rel: 'lib/Utils/generics.js', kind: 'const', re: /(const baileysVersion = \[)(\d+),\s*(\d+),\s*(\d+)(\])/ },
  { rel: 'src/Utils/generics.ts', kind: 'const', re: /(const baileysVersion = \[)(\d+),\s*(\d+),\s*(\d+)(\])/ },
  { rel: 'lib/Defaults/baileys-version.json', kind: 'json' },
  { rel: 'src/Defaults/baileys-version.json', kind: 'json' },
];

const BACKUP_DIR_NAME = '.proto-updater-backup';

export function backupDir(baileysPath) {
  return join(baileysPath, BACKUP_DIR_NAME);
}

/** Copy pristine originals aside (once). Subsequent updates keep the first backup. */
export function ensureBackup(baileysPath) {
  const bdir = backupDir(baileysPath);
  if (existsSync(join(bdir, 'manifest.json'))) return bdir;
  mkdirSync(bdir, { recursive: true });
  const manifest = { backedUpAt: new Date().toISOString(), files: [] };
  for (const [rel] of WA_FILES) {
    const abs = join(baileysPath, rel);
    if (existsSync(abs)) {
      const dest = join(bdir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(abs, dest);
      manifest.files.push(rel);
    }
  }
  for (const { rel } of VERSION_TARGETS) {
    const abs = join(baileysPath, rel);
    if (existsSync(abs)) {
      const dest = join(bdir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(abs, dest);
      manifest.files.push(rel);
    }
  }
  writeFileSync(join(bdir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return bdir;
}

function patchVersionContent(rel, content, version) {
  for (const t of VERSION_TARGETS) {
    if (t.rel !== rel) continue;
    if (t.kind === 'json') {
      try {
        const obj = JSON.parse(content);
        obj.version = version;
        return JSON.stringify(obj, null, 2) + '\n';
      } catch {
        return content;
      }
    }
    if (!t.re.test(content)) {
      throw new Error(`version pattern not found in ${rel}`);
    }
    return content.replace(t.re, `$1${version[0]}, ${version[1]}, ${version[2]}$5`);
  }
  return content;
}

/**
 * @param {object} p
 * @param {string} p.baileysPath
 * @param {string} p.protoFile      generated WAProto.proto
 * @param {string} p.indexJs        generated index.js
 * @param {string|null} p.indexDts  generated index.d.ts
 * @param {[number,number,number]} p.version  new handshake version
 * @param {boolean} [p.updateVersion]
 */
export function applyToDisk({ baileysPath, protoFile, indexJs, indexDts, version, updateVersion = true }) {
  ensureBackup(baileysPath);

  const staged = []; // [{abs, tmp}] for rollback
  const written = [];

  try {
    // 1. WAProto files (write .tmp first, then rename – near-atomic per file)
    const jobs = [
      [protoFile, join(baileysPath, 'WAProto/WAProto.proto')],
      [indexJs, join(baileysPath, 'WAProto/index.js')],
    ];
    if (indexDts) jobs.push([indexDts, join(baileysPath, 'WAProto/index.d.ts')]);

    for (const [src, dest] of jobs) {
      const tmp = `${dest}.ppu-tmp`;
      cpSync(src, tmp);
      staged.push({ tmp, dest, hadOriginal: existsSync(dest) });
    }

    // 2. version patching (content-level, before any rename)
    const versionJobs = [];
    if (updateVersion) {
      for (const { rel } of VERSION_TARGETS) {
        const abs = join(baileysPath, rel);
        if (!existsSync(abs)) continue;
        const newContent = patchVersionContent(rel, readFileSync(abs, 'utf8'), version);
        const tmp = `${abs}.ppu-tmp`;
        writeFileSync(tmp, newContent);
        staged.push({ tmp, dest: abs, hadOriginal: true });
        versionJobs.push(abs);
      }
      if (versionJobs.length === 0) {
        throw new Error('updateVersion=true but no version files found in baileys package');
      }
    }

    // 3. commit: rename all tmps over the originals
    for (const { tmp, dest } of staged) {
      renameSync(tmp, dest);
      written.push(dest);
    }

    return { updatedFiles: written, versionUpdated: updateVersion };
  } catch (err) {
    // rollback: restore from backup everything we touched
    rollback(baileysPath, staged.map((s) => s.dest));
    // clean stray tmps
    for (const s of staged) {
      if (existsSync(s.tmp)) rmSync(s.tmp, { force: true });
    }
    throw new Error(`apply failed, rolled back: ${err.message}`);
  }
}

function rollback(baileysPath, dests) {
  const bdir = backupDir(baileysPath);
  for (const dest of dests) {
    const rel = dest.slice(baileysPath.length + 1);
    const bak = join(bdir, rel);
    try {
      if (existsSync(bak)) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(bak, dest);
      }
    } catch {
      /* best effort */
    }
  }
}

/** Restore pristine files from the backup (CLI `restore`). */
export function restoreBackup(baileysPath) {
  const bdir = backupDir(baileysPath);
  const manifestPath = join(bdir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('no backup found – nothing to restore');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const restored = [];
  for (const rel of manifest.files) {
    const src = join(bdir, rel);
    const dest = join(baileysPath, rel);
    if (existsSync(src)) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      restored.push(dest);
    }
  }
  return { restoredFiles: restored };
}
