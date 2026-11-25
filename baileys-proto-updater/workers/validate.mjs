/**
 * Validate a freshly generated WAProto/index.js in ISOLATION:
 * import it, roundtrip-encode a known message, count top-level types.
 * Its protobufjs singleton never touches the running bot process.
 *
 * Usage: node validate.mjs /path/to/index.js
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.log(JSON.stringify({ ok: false, error: 'usage: node validate.mjs <index.js>' }));
  process.exit(0);
}

try {
  const mod = await import(pathToFileURL(resolve(target)).href);
  const proto = mod.proto;
  if (!proto || typeof proto !== 'object') {
    throw new Error('no proto namespace exported');
  }

  const keyCount = Object.keys(proto).length;
  if (keyCount < 50) throw new Error(`only ${keyCount} top-level types – extraction looks broken`);

  // roundtrip a message every WA proto build contains
  const M = proto.Message;
  if (typeof M?.encode !== 'function' || typeof M?.decode !== 'function') {
    throw new Error('proto.Message encode/decode missing');
  }
  const buf = M.encode({ ephemeralExpiration: 60, conversation: 'ppu-roundtrip' }).finish();
  const back = M.decode(buf);
  if (back.conversation !== 'ppu-roundtrip') {
    throw new Error(`roundtrip mismatch: ${JSON.stringify(back.conversation)}`);
  }

  // enums must be present too
  if (!proto.HistorySync?.HistorySyncType) {
    throw new Error('proto.HistorySync.HistorySyncType missing');
  }

  console.log(JSON.stringify({ ok: true, keyCount, roundtrip: 'ok' }));
  process.exit(0);
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(0);
}
