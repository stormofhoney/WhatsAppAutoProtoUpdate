/**
 * ProtoUpdater – runtime module that keeps an installed
 * @whiskeysockets/baileys fresh:
 *
 *   check  →  extract (child process, AST parse of the WA Web bundle)
 *          →  generate (pbjs/pbts + fix-imports)
 *          →  validate (isolated child process)
 *          →  apply to disk (backup + version patch + rollback safety)
 *          →  hot-swap in memory (proto namespace + handshake version)
 *          →  emit 'update'
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBaileysPath, getBaileysPackageVersion } from './resolve.js';
import { getCurrentVersion, compareVersions, formatVersion } from './version.js';
import { generateWaProto } from './generate.js';
import { applyToDisk, restoreBackup } from './patch.js';
import { loadHeldProto, hotSwapProto, hotSwapVersion } from './hotswap.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXTRACT_WORKER = join(here, '..', 'workers', 'extract.mjs');
const VALIDATE_WORKER = join(here, '..', 'workers', 'validate.mjs');

const defaultLogger = {
  info: (...a) => console.log('[proto-updater]', ...a),
  warn: (...a) => console.warn('[proto-updater]', ...a),
  error: (...a) => console.error('[proto-updater]', ...a),
  debug: () => {},
};

/** Fetch the live WhatsApp Web client revision from sw.js (cheap check). */
export async function fetchLatestVersion() {
  const res = await fetch('https://web.whatsapp.com/sw.js', {
    headers: {
      'sec-fetch-site': 'none',
      'user-agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`GET sw.js -> HTTP ${res.status}`);
  const text = await res.text();
  const m =
    text.match(/client_revision\\":([\d.]+),/) ||
    text.match(/client_revision\\?":\s*([\d.]+)/) ||
    text.match(/client_revision[^0-9]{0,6}([\d.]+)/);
  if (!m) throw new Error('could not find client_revision in sw.js');
  const rev = Math.trunc(Number(m[1]));
  if (!Number.isFinite(rev)) throw new Error(`bad client_revision: ${m[1]}`);
  return /** @type {[number, number, number]} */ ([2, 3000, rev]);
}

function runWorker(script, args, { timeoutMs = 180_000, maxHeapMB = 1024, logger } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${maxHeapMB}`, script, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${script} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      if (logger) {
        for (const line of d.toString().split('\n')) {
          if (line.trim()) logger.debug('[worker]', line);
        }
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          const lastLine = stdout.trim().split('\n').pop();
          resolve(JSON.parse(lastLine));
        } catch {
          reject(new Error(`worker produced no JSON result\nstderr: ${stderr.slice(-2000)}`));
        }
      } else {
        reject(new Error(`${script} exited ${code}\n${stderr.slice(-4000)}`));
      }
    });
  });
}

export class ProtoUpdater extends EventEmitter {
  #opts;
  #logger;
  #path = null;
  #timer = null;
  #busy = false;
  #stopped = true;

  /**
   * @param {object} [options]
   * @param {string} [options.baileysPath]      explicit path to the baileys package
   * @param {number} [options.interval]         auto-check interval in ms (default 6h, 0 = off)
   * @param {boolean} [options.autoUpdate]      apply automatically when newer (default true)
   * @param {boolean} [options.updateVersion]   also patch the handshake version (default true)
   * @param {boolean} [options.generateTypes]   rebuild WAProto/index.d.ts (default true)
   * @param {boolean} [options.dryRun]          report only, touch nothing (default false)
   * @param {object} [options.logger]           { info, warn, error, debug }
   * @param {number} [options.workerTimeoutMs]  extract/validate timeout (default 180s)
   */
  constructor(options = {}) {
    super();
    this.#opts = {
      baileysPath: options.baileysPath,
      interval: options.interval === undefined ? 6 * 60 * 60 * 1000 : options.interval,
      autoUpdate: options.autoUpdate !== false,
      updateVersion: options.updateVersion !== false,
      generateTypes: options.generateTypes !== false,
      dryRun: !!options.dryRun,
      workerTimeoutMs: options.workerTimeoutMs ?? 180_000,
    };
    this.#logger = options.logger ?? defaultLogger;
  }

  /** Resolved package root (lazily, so the plugin can be constructed pre-install). */
  get baileysPath() {
    if (!this.#path) this.#path = resolveBaileysPath(this.#opts.baileysPath);
    return this.#path;
  }

  /** Start the interval timer and run one immediate check. */
  async start() {
    this.#stopped = false;
    const first = await this.checkNow().catch((err) => {
      this.emit('error', err);
      return { error: err };
    });
    if (this.#opts.interval > 0) {
      this.#timer = setInterval(() => {
        this.checkNow().catch((err) => this.emit('error', err));
      }, this.#opts.interval);
      this.#timer.unref?.();
    }
    return first;
  }

  stop() {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * One check cycle. Returns:
   *   { updateAvailable: false, installed, latest }
   *   { updateAvailable: true,  applied: true|false(dry), installed, latest, ... }
   */
  async checkNow(force = false) {
    if (this.#busy) return { busy: true };
    this.#busy = true;
    try {
      return await this.#cycle(force);
    } finally {
      this.#busy = false;
    }
  }

  /** Force a full re-extract + re-apply even if versions match. */
  async forceUpdate() {
    return this.checkNow(true);
  }

  async #cycle(force) {
    const t0 = Date.now();
    const path = this.baileysPath;
    const installed = getCurrentVersion(path);
    const baileysPkg = getBaileysPackageVersion(path);

    this.emit('checking', { installed, baileysPkg });
    this.#logger.info(`checking (baileys ${baileysPkg}, installed WA ${formatVersion(installed)})`);

    const latest = await fetchLatestVersion();
    const cmp = installed ? compareVersions(latest, installed) : 1;

    if (!force && installed && cmp <= 0) {
      this.emit('uptodate', { installed, latest });
      this.#logger.info(`up to date (WA ${formatVersion(installed)})`);
      return { updateAvailable: false, installed, latest };
    }

    if (!this.#opts.autoUpdate && !force) {
      this.emit('update-available', { installed, latest });
      return { updateAvailable: true, applied: false, installed, latest };
    }

    if (this.#opts.dryRun) {
      this.#logger.info(`dry-run: would update ${formatVersion(installed)} → ${formatVersion(latest)} (extracting to verify)`);
      const probe = await this.#extractAndGenerate(path, { validate: true });
      try {
        const result = {
          updateAvailable: true,
          applied: false,
          dryRun: true,
          installed,
          latest,
          protoVersion: probe.protoVersion,
          messageCount: probe.messageCount,
          files: ['WAProto/WAProto.proto', 'WAProto/index.js', 'WAProto/index.d.ts'],
        };
        this.emit('dry-run', result);
        return result;
      } finally {
        rmSync(probe.workDir, { recursive: true, force: true });
      }
    }

    // ── full pipeline ──────────────────────────────────────────────
    this.#logger.info(`update ${formatVersion(installed)} → ${formatVersion(latest)}: extracting…`);
    this.emit('extracting', { installed, latest });

    const held = await loadHeldProto(path); // ensure consumers' namespace is the one we'll swap
    const probe = await this.#extractAndGenerate(path, { validate: true, previousKeyCount: Object.keys(held.proto).length });
    try {
      // version to bake in = version of the extracted bundle (single source of truth)
      const newVersion = probe.versionTuple;
      if (compareVersions(newVersion, latest) !== 0) {
        this.#logger.warn(`extracted bundle revision ${formatVersion(newVersion)} differs from sw.js ${formatVersion(latest)} – using extracted`);
      }

      this.emit('applying', { version: newVersion });
      const disk = applyToDisk({
        baileysPath: path,
        protoFile: probe.protoFile,
        indexJs: probe.indexJs,
        indexDts: probe.indexDts,
        version: newVersion,
        updateVersion: this.#opts.updateVersion,
      });

      const swap = await hotSwapProto(path, held);
      const verSwap = this.#opts.updateVersion
        ? await hotSwapVersion(path, newVersion)
        : { defaultsConfig: false, genericsFallback: 'disabled' };

      const durationMs = Date.now() - t0;
      const info = {
        updateAvailable: true,
        applied: true,
        installed,
        latest,
        version: newVersion,
        protoVersion: probe.protoVersion,
        messageCount: probe.messageCount,
        updatedFiles: disk.updatedFiles,
        hotSwap: swap,
        versionHotSwap: verSwap,
        durationMs,
      };
      this.#logger.info(
        `✔ updated WA ${formatVersion(installed)} → ${formatVersion(newVersion)} ` +
          `(+${swap.added} types, ~${durationMs}ms) – restart recommended for full type coverage`
      );
      this.emit('update', info);
      return info;
    } finally {
      rmSync(probe.workDir, { recursive: true, force: true });
    }
  }

  /**
   * extract → generate → (validate in isolated child).
   * Returns file paths INCLUDING `workDir`; the CALLER must rmSync(workDir)
   * (finally) after it no longer needs the files – applyToDisk copies out of it.
   */
  async #extractAndGenerate(path, { validate = true, previousKeyCount = 0 } = {}) {
    // Work dir INSIDE the baileys package: module resolution for the generated
    // index.js (import "protobufjs/minimal.js") then walks exactly the same
    // node_modules chain as it will after the final move into WAProto/.
    const workDir = mkdtempSync(join(path, '.ppu-'));
    try {
      // 1. extract (child process: isolates ~250MB oak AST from the bot)
      const protoFile = join(workDir, 'WAProto.proto');
      const ext = await runWorker(EXTRACT_WORKER, ['--out', protoFile], {
        timeoutMs: this.#opts.workerTimeoutMs,
        logger: this.#logger,
      });
      this.emit('extracted', ext);

      const protoVersionMatch = readFileSync(protoFile, 'utf8').match(
        /\/\/\/ WhatsApp VERSION: (\d+)\.(\d+)\.(\d+)/
      );
      if (!protoVersionMatch) throw new Error('extracted proto has no version header');
      const versionTuple = /** @type {[number,number,number]} */ (
        [+protoVersionMatch[1], +protoVersionMatch[2], +protoVersionMatch[3]]
      );

      // 2. generate index.js (+ index.d.ts)
      this.emit('generating', { version: versionTuple });
      const gen = await generateWaProto(protoFile, workDir, { types: this.#opts.generateTypes });

      // 3. validate in an isolated child process – its protobufjs singleton
      //    never leaks into the running bot
      if (validate) {
        const val = await runWorker(VALIDATE_WORKER, [gen.jsOut], {
          timeoutMs: 60_000,
          logger: this.#logger,
        });
        if (!val.ok) throw new Error(`generated module failed validation: ${val.error}`);
        if (previousKeyCount > 0 && val.keyCount < Math.floor(previousKeyCount * 0.9)) {
          throw new Error(
            `new proto has only ${val.keyCount} top-level types vs ${previousKeyCount} installed ` +
              '(≥10% loss) – extraction likely broken, aborting before touching disk'
          );
        }
        this.emit('validated', val);
      }

      return {
        workDir,
        protoFile,
        indexJs: gen.jsOut,
        indexDts: gen.dtsOut,
        protoVersion: ext.version,
        versionTuple,
        messageCount: ext.messageCount,
        keyCount: undefined,
      };
    } catch (err) {
      // failure before the caller ever sees workDir → clean up here
      rmSync(workDir, { recursive: true, force: true });
      throw err;
    }
  }

  /** Restore the pristine backup taken before the first update. */
  restore() {
    const res = restoreBackup(this.baileysPath);
    this.#logger.info(`restored ${res.restoredFiles.length} files from backup – restart to unload in-memory state`);
    this.emit('restored', res);
    return res;
  }
}

/** Convenience factory. */
export function createProtoUpdater(options) {
  return new ProtoUpdater(options);
}

/** One-shot check without keeping a timer (useful in scripts/CI). */
export async function checkForUpdate(options = {}) {
  const u = new ProtoUpdater({ ...options, interval: 0 });
  const res = await u.checkNow(options.force === true);
  return res;
}

/** One-shot full update. */
export async function applyUpdate(options = {}) {
  const u = new ProtoUpdater({ ...options, interval: 0 });
  const res = await u.checkNow(true);
  return res;
}
