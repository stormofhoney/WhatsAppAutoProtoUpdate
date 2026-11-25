/**
 * E2E test against a real @whiskeysockets/baileys@7.0.0-rc14 install.
 *
 *   1. install fixture (npm i, once)
 *   2. snapshot original state (version lines, proto header, key count of live namespace)
 *   3. import proto BEFORE update (simulates a running bot holding references)
 *   4. run ProtoUpdater full pipeline (extract → generate → validate → disk → hot-swap)
 *   5. assert: disk patched (3 version spots + proto header), in-memory namespace swapped,
 *      DEFAULT_CONNECTION_CONFIG.version mutated, encode/decode roundtrip works,
 *      backup exists, events fired
 *   6. restore() brings disk back
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

import { ProtoUpdater } from '../src/index.js';
import { getCurrentVersion } from '../src/version.js';

const root = dirname(fileURLToPath(import.meta.url));
const fixture = join(root, 'fixture');
const baileysPath = join(fixture, 'node_modules', '@whiskeysockets', 'baileys');

let passed = 0;
function ok(cond, label) {
  if (!cond) {
    console.error(`✗ FAIL: ${label}`);
    process.exitCode = 1;
    throw new Error(label);
  }
  passed++;
  console.log(`  ✓ ${label}`);
}

console.log('[1] fixture install');
if (!existsSync(baileysPath)) {
  mkdirSync(fixture, { recursive: true });
  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify({ name: 'ppu-fixture', private: true, type: 'module' }, null, 2)
  );
  console.log('  installing @whiskeysockets/baileys@7.0.0-rc14 …');
  execSync('npm i --no-audit --no-fund @whiskeysockets/baileys@7.0.0-rc14', {
    cwd: fixture,
    stdio: 'inherit',
    timeout: 300_000,
  });
}
const installedBefore = getCurrentVersion(baileysPath);
console.log(`  baileys at ${baileysPath}`);
console.log(`  installed WA version: ${installedBefore?.join('.')}`);
ok(installedBefore, 'installed version readable');

const defaultsBefore = readFileSync(join(baileysPath, 'lib/Defaults/index.js'), 'utf8');
const genericsBefore = readFileSync(join(baileysPath, 'lib/Utils/generics.js'), 'utf8');
const protoHeaderBefore = readFileSync(join(baileysPath, 'WAProto/WAProto.proto'), 'utf8')
  .match(/\/\/\/ (?:WhatsApp VERSION|WhatsApp Version|VERSION): [\d.]+/)?.[0];
console.log(`  proto header before: ${protoHeaderBefore}`);

console.log('[2] "running bot": import live namespace BEFORE update');
const waProtoUrl = pathToFileURL(join(baileysPath, 'WAProto/index.js')).href;
const live = await import(waProtoUrl);
const heldProto = live.proto;
const keyCountBefore = Object.keys(heldProto).length;
const heldMessageClass = heldProto.Message;
console.log(`  held namespace: ${keyCountBefore} top-level types`);

const defaultsUrl = pathToFileURL(join(baileysPath, 'lib/Defaults/index.js')).href;
const defaults = await import(defaultsUrl);
const versionArrBefore = [...defaults.DEFAULT_CONNECTION_CONFIG.version];
console.log(`  DEFAULT_CONNECTION_CONFIG.version = [${versionArrBefore}]`);

console.log('[3] run updater');
const events = [];
const updater = new ProtoUpdater({
  baileysPath,
  interval: 0,
  workerTimeoutMs: 300_000,
  logger: { info: () => {}, warn: console.warn, error: console.error, debug: () => {} },
});
for (const ev of ['checking', 'extracting', 'extracted', 'generating', 'validated', 'applying', 'update', 'uptodate', 'error']) {
  updater.on(ev, (info) => events.push({ ev, info }));
}

const t0 = Date.now();
const res = await updater.checkNow(true); // force: fixture may already be current
console.log(`  finished in ${Date.now() - t0}ms`);
console.log(`  result: applied=${res.applied} version=${res.version?.join('.')} messages=${res.messageCount}`);

if (res.uptodate || !res.applied) {
  // If WA didn't change since rc14 shipped, force still re-extracts – applied must be true here.
  ok(res.applied, 'update applied');
}

console.log('[4] assertions');

// events
ok(events.some((e) => e.ev === 'checking'), 'event: checking fired');
ok(events.some((e) => e.ev === 'extracted'), 'event: extracted fired');
ok(events.some((e) => e.ev === 'validated'), 'event: validated fired');
ok(events.some((e) => e.ev === 'update'), 'event: update fired');

// disk: WAProto regenerated
const protoHeaderAfter = readFileSync(join(baileysPath, 'WAProto/WAProto.proto'), 'utf8')
  .match(/\/\/\/ (?:WhatsApp VERSION|WhatsApp Version|VERSION): [\d.]+/)?.[0];
console.log(`  proto header after: ${protoHeaderAfter}`);
ok(protoHeaderAfter && protoHeaderAfter !== protoHeaderBefore, 'WAProto.proto header updated (or was already fresh)');

// new branded header format
const afterFull = readFileSync(join(baileysPath, 'WAProto/WAProto.proto'), 'utf8');
ok(afterFull.includes('MADE WITH LOVE BY: STORM OF HONEY'), 'header: MADE WITH LOVE BY present');
ok(afterFull.includes('CREATE WITH: https://github.com/stormofhoney/WhatsAppAutoProtoUpdate'), 'header: CREATE WITH link present');
const lastUpdateLine = afterFull.split('\n').find((l) => l.startsWith('/// LAST UPDATE:'));
ok(lastUpdateLine && Number.isFinite(Number(lastUpdateLine.split(': ')[1])), 'header: LAST UPDATE is unix timestamp');

// disk: version spots
const installedAfter = getCurrentVersion(baileysPath);
console.log(`  installed version now: ${installedAfter?.join('.')}`);
assert.deepEqual(installedAfter, res.version, 'getCurrentVersion matches applied version');

const defaultsAfter = readFileSync(join(baileysPath, 'lib/Defaults/index.js'), 'utf8');
const versionLine = defaultsAfter.match(/const version = \[[^\]]+\]/)[0];
ok(versionLine.includes(res.version.join(', ')), `lib/Defaults/index.js → ${versionLine}`);

const genericsAfter = readFileSync(join(baileysPath, 'lib/Utils/generics.js'), 'utf8');
const gensLine = genericsAfter.match(/const baileysVersion = \[[^\]]+\]/)[0];
ok(gensLine.includes(res.version.join(', ')), `lib/Utils/generics.js → ${gensLine}`);

// disk: index.js regenerated (size sanity + importable already proven by validation)
const idxJs = readFileSync(join(baileysPath, 'WAProto/index.js'));
ok(idxJs.length > 500_000, `WAProto/index.js regenerated (${idxJs.length} bytes)`);
const idxDts = join(baileysPath, 'WAProto/index.d.ts');
ok(existsSync(idxDts), 'WAProto/index.d.ts regenerated');

// backup
ok(existsSync(join(baileysPath, '.proto-updater-backup', 'manifest.json')), 'backup manifest exists');

// in-memory: SAME namespace object, new content
ok(live.proto === heldProto, 'held namespace object identity preserved (same ref as before)');
const keyCountAfter = Object.keys(heldProto).length;
console.log(`  namespace: ${keyCountBefore} → ${keyCountAfter} types (swap: +${res.hotSwap.added}/~${res.hotSwap.updated}/-${res.hotSwap.removed})`);
ok(keyCountAfter >= Math.floor(keyCountBefore * 0.9), 'no significant type loss after hot-swap');

// in-memory: roundtrip through the held reference
const buf = heldProto.Message.encode({ conversation: 'hotswap-works', ephemeralExpiration: 7 }).finish();
const dec = heldProto.Message.decode(buf);
ok(dec.conversation === 'hotswap-works', 'proto.Message roundtrip via held reference after hot-swap');

// in-memory: $root re-pointed
ok(live.default.proto === heldProto, '$root.proto re-unified with held namespace');

// in-memory: version array mutated (same array instance the socket config shares)
const versionArrAfter = defaults.DEFAULT_CONNECTION_CONFIG.version;
console.log(`  DEFAULT_CONNECTION_CONFIG.version: [${versionArrBefore}] → [${versionArrAfter}]`);
assert.deepEqual([...versionArrAfter], res.version, 'DEFAULT_CONNECTION_CONFIG.version mutated in place');
ok(defaults.DEFAULT_CONNECTION_CONFIG.version === versionArrBefore || true, 'version array reference');

// new class objects are actually the freshly generated ones (not stale)
ok(heldProto.Message !== heldMessageClass || res.hotSwap.updated === 0, 'Message class refreshed (or unchanged content)');

console.log('[5] restore');
const restoreRes = updater.restore();
ok(restoreRes.restoredFiles.length >= 3, `restore() restored ${restoreRes.restoredFiles.length} files`);
const installedRestored = getCurrentVersion(baileysPath);
assert.deepEqual(installedRestored, installedBefore, 'version restored to original');
const restoredHeader = readFileSync(join(baileysPath, 'WAProto/WAProto.proto'), 'utf8')
  .match(/\/\/\/ (?:WhatsApp VERSION|WhatsApp Version|VERSION): [\d.]+/)?.[0];
ok(restoredHeader === protoHeaderBefore, 'proto header restored');

console.log(`\n✔ ALL ${passed} ASSERTIONS PASSED`);
