export {
  ProtoUpdater,
  createProtoUpdater,
  checkForUpdate,
  applyUpdate,
  fetchLatestVersion,
} from './updater.js';

export { resolveBaileysPath, getBaileysPackageVersion } from './resolve.js';
export { getCurrentVersion, compareVersions, formatVersion } from './version.js';
export { generateWaProto } from './generate.js';
export { applyToDisk, restoreBackup, ensureBackup } from './patch.js';
export { loadHeldProto, hotSwapProto, hotSwapVersion } from './hotswap.js';
