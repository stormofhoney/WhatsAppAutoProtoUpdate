/**
 * In-memory hot-swap of a freshly patched Baileys install.
 *
 * Mechanics:
 *   - WAProto/index.js exports `proto` (namespace object) and `$root`.
 *     Every Baileys module holds a reference to that SAME object, and all
 *     consumers access members dynamically (`proto.Foo.encode(...)`) at call time.
 *   - The generated module registers itself on the protobufjs singleton
 *     `$protobuf.roots["default"]`, so importing the new file re-assigns
 *     `$root.proto` to a fresh namespace.
 *   - We therefore: import the new module (cache-busted), copy every key of the
 *     new namespace ONTO the held namespace (delete removed keys), then point
 *     `$root.proto` back at the held namespace. One coherent world again.
 *
 *   JS scheduling guarantees no user code (ws messages, timers) runs between
 *   the new module's evaluation and our sync: the import promise continuation
 *   is a microtask, macrotasks can't interleave.
 *
 *   - Handshake version: `DEFAULT_CONNECTION_CONFIG.version` is an array shared
 *     by reference into every socket config – mutate it in place.
 *     (Only affects configs that don't override `version` themselves.)
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @param {string} baileysPath
 * @returns {Promise<{ proto: object, $root: object, module: object }>}
 */
export async function loadHeldProto(baileysPath) {
  const fileUrl = pathToFileURL(join(baileysPath, 'WAProto/index.js')).href;
  const mod = await import(fileUrl);
  if (!mod.proto || typeof mod.proto !== 'object') {
    throw new Error('loaded WAProto/index.js but no proto namespace found');
  }
  return { proto: mod.proto, $root: mod.default, module: mod };
}

/**
 * Import the (already disk-patched) WAProto with a cache-busting query and
 * merge its namespace into the namespace existing consumers hold.
 *
 * @param {string} baileysPath
 * @param {{ held: { proto: object, $root: object } }} held
 * @returns {Promise<{ added: number, removed: number, updated: number, totalKeys: number }>}
 */
export async function hotSwapProto(baileysPath, held) {
  const fileUrl = pathToFileURL(join(baileysPath, 'WAProto/index.js')).href;
  const bustUrl = `${fileUrl}?ppu=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const newMod = await import(bustUrl);
  const newProto = newMod.proto;
  if (!newProto || typeof newProto !== 'object') {
    throw new Error('hot-swap import produced no proto namespace');
  }

  const oldProto = held.proto;
  let added = 0;
  let removed = 0;
  let updated = 0;

  for (const k of Object.keys(oldProto)) {
    if (!(k in newProto)) {
      delete oldProto[k];
      removed++;
    }
  }
  for (const k of Object.keys(newProto)) {
    if (!(k in oldProto)) {
      oldProto[k] = newProto[k];
      added++;
    } else if (oldProto[k] !== newProto[k]) {
      oldProto[k] = newProto[k];
      updated++;
    }
  }

  // re-unify: shared $root must point at the namespace consumers hold
  if (held.$root) {
    held.$root.proto = oldProto;
  }

  // sanity: encode/decode must work through the held namespace
  if (typeof oldProto.Message?.encode !== 'function' || typeof oldProto.Message?.decode !== 'function') {
    throw new Error('hot-swap sanity check failed: proto.Message.encode/decode missing after swap');
  }

  return { added, removed, updated, totalKeys: Object.keys(oldProto).length };
}

/**
 * Mutate the handshake version array in memory (all three locations that are
 * reachable without re-evaluating Baileys modules).
 *
 * @param {string} baileysPath
 * @param {[number, number, number]} version
 * @returns {Promise<{ defaultsConfig: boolean, genericsFallback: string }>}
 */
export async function hotSwapVersion(baileysPath, version) {
  const result = { defaultsConfig: false, genericsFallback: 'not-reachable' };

  // 1. DEFAULT_CONNECTION_CONFIG.version – shared array, mutate in place
  try {
    const defaultsUrl = pathToFileURL(join(baileysPath, 'lib/Defaults/index.js')).href;
    const defaults = await import(defaultsUrl);
    const arr = defaults.DEFAULT_CONNECTION_CONFIG?.version;
    if (Array.isArray(arr)) {
      arr[0] = version[0];
      arr[1] = version[1];
      arr[2] = version[2];
      result.defaultsConfig = true;
    }
  } catch (err) {
    result.genericsFallback = `defaults import failed: ${err.message}`;
  }

  // 2. lib/Utils/generics.js `baileysVersion` is module-private – only patched
  //    on disk (affects the rare fallback path of fetchLatestBaileysVersion
  //    after the next restart). Nothing sane to do in-memory here.
  return result;
}
