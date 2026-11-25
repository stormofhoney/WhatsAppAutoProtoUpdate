#!/usr/bin/env node
/**
 * baileys-proto-updater CLI
 *
 *   baileys-proto-updater                check + apply if a newer WA proto exists
 *   baileys-proto-updater check          report only (exit 0 = up to date, 2 = update available)
 *   baileys-proto-updater update         force full re-extract + apply
 *   baileys-proto-updater restore        restore the pre-update backup
 *   baileys-proto-updater status         show installed version / paths
 *
 * Flags: --dry-run  --no-version  --no-types  --path <dir>  --json  --help
 */
import { ProtoUpdater, fetchLatestVersion } from '../src/index.js';
import { getCurrentVersion, formatVersion } from '../src/version.js';
import { getBaileysPackageVersion } from '../src/resolve.js';

const COMMANDS = new Set(['check', 'update', 'apply', 'restore', 'status', 'help']);
const VALUE_FLAGS = new Set(['--path', '--interval']);

/** Parse argv: first non-flag token that is not a flag VALUE is the command. */
function parseArgs(argv) {
  const out = { cmd: null, flags: new Set(), values: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) {
        const v = argv[i + 1];
        if (v !== undefined && !v.startsWith('--')) {
          out.values.set(a, v);
          i++;
        } else {
          out.flags.add(a); // missing value – surfaced later
        }
      } else {
        out.flags.add(a);
      }
    } else if (out.cmd === null && COMMANDS.has(a)) {
      out.cmd = a;
    } else if (out.cmd === null && !a.startsWith('-')) {
      // unknown positional – keep as command so errors are explicit
      out.cmd = a;
    }
    // further positionals ignored
  }
  if (!out.cmd) out.cmd = 'apply';
  return out;
}

const { cmd, flags: has, values } = parseArgs(process.argv.slice(2));
const jsonMode = has.has('--json');

function help() {
  return `baileys-proto-updater – fresh WhatsApp protos for Baileys, straight from web.whatsapp.com

Usage:
  baileys-proto-updater [apply]     check and apply if a newer WA proto exists
  baileys-proto-updater check       report only (exit 0 = up to date, 2 = update available)
  baileys-proto-updater update      force re-extract + apply even if versions match
  baileys-proto-updater restore     restore files from the pre-update backup
  baileys-proto-updater status      show installed/latest version and paths

Flags:
  --path <dir>    explicit path to node_modules/@whiskeysockets/baileys
  --dry-run       extract + validate, write nothing to disk
  --no-version    keep the handshake version untouched (proto only)
  --no-types      skip index.d.ts generation
  --json          machine-readable output
  --help          this text

Exit codes: 0 = ok/up-to-date · 1 = error · 2 = update available (check only)
`;
}

async function main() {
  if (has.has('--help') || has.has('-h') || cmd === 'help') {
    process.stdout.write(help());
    return 0;
  }
  if (has.has('--path') && !values.get('--path')) {
    console.error('[error] --path requires a value');
    return 1;
  }

  const opts = {
    baileysPath: values.get('--path'),
    interval: 0,
    dryRun: has.has('--dry-run'),
    updateVersion: !has.has('--no-version'),
    generateTypes: !has.has('--no-types'),
  };

  // `check` must never write: disable autoUpdate so #cycle only reports.
  const updater = new ProtoUpdater({ ...opts, autoUpdate: cmd !== 'check' });

  if (cmd === 'status') {
    const path = updater.baileysPath;
    const out = {
      baileysPath: path,
      baileys: getBaileysPackageVersion(path),
      installedWA: formatVersion(getCurrentVersion(path)),
    };
    try {
      out.latestWA = formatVersion(await fetchLatestVersion());
    } catch (e) {
      out.latestWA = `error: ${e.message}`;
    }
    if (jsonMode) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`baileys:    ${out.baileys}`);
      console.log(`path:       ${out.baileysPath}`);
      console.log(`installed:  WA ${out.installedWA}`);
      console.log(`latest:     WA ${out.latestWA}`);
    }
    return 0;
  }

  if (cmd === 'restore') {
    const res = updater.restore();
    if (jsonMode) console.log(JSON.stringify(res, null, 2));
    else console.log(`restored ${res.restoredFiles.length} files – restart your bot to unload in-memory state`);
    return res.restoredFiles.length > 0 ? 0 : 1;
  }

  if (cmd === 'check') {
    const res = await updater.checkNow(false);
    if (jsonMode) console.log(JSON.stringify(res, null, 2));
    else if (res.updateAvailable) {
      console.log(`update available: WA ${formatVersion(res.installed)} → ${formatVersion(res.latest)}`);
    } else {
      console.log(`up to date: WA ${formatVersion(res.installed)}`);
    }
    return res.updateAvailable ? 2 : 0;
  }

  // apply (default) / update
  const res = await updater.checkNow(cmd === 'update');
  if (jsonMode) console.log(JSON.stringify(res, null, 2));
  else if (res.applied) {
    console.log(`\n✔ updated ${formatVersion(res.installed)} → ${formatVersion(res.version)}`);
    console.log(`  ${res.messageCount} messages extracted in ${res.durationMs}ms`);
    console.log(`  hot-swap: +${res.hotSwap.added} / ~${res.hotSwap.updated} / -${res.hotSwap.removed} types (${res.hotSwap.totalKeys} total)`);
    if (opts.dryRun) console.log('  (dry-run: disk untouched)');
    else console.log('  restart recommended so TypeScript types & module-level captures pick everything up');
  } else if (res.updateAvailable && res.dryRun) {
    console.log(`dry-run: would update WA ${formatVersion(res.installed)} → ${formatVersion(res.latest)} (${res.messageCount} messages)`);
  } else {
    console.log(`up to date: WA ${formatVersion(res.installed)}`);
  }
  // apply/update: 0 = success (applied or already current); check keeps 2 = available
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[error]', err.message);
    process.exit(1);
  });
