import { EventEmitter } from 'node:events';

export type WAVersion = [number, number, number];

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export interface ProtoUpdaterOptions {
  /** Explicit path to the @whiskeysockets/baileys package (default: auto-resolve). */
  baileysPath?: string;
  /** Auto-check interval in ms. Default 6h. 0 disables the timer. */
  interval?: number;
  /** Apply an update automatically when found (default true). If false, only the `update-available` event fires. */
  autoUpdate?: boolean;
  /** Also rewrite the handshake version `const version = [2, 3000, …]` (default true). */
  updateVersion?: boolean;
  /** Also rebuild WAProto/index.d.ts (~9s extra; default true). */
  generateTypes?: boolean;
  /** Extract + generate + validate, but never touch disk or memory (default false). */
  dryRun?: boolean;
  /** Timeout for the extract/validate child processes in ms (default 180 000). */
  workerTimeoutMs?: number;
  logger?: Logger;
}

export interface CheckResultBase {
  updateAvailable: boolean;
  installed: WAVersion | null;
  latest: WAVersion;
  busy?: boolean;
}

export interface UpToDateResult extends CheckResultBase {
  updateAvailable: false;
}

export interface UpdateResult extends CheckResultBase {
  updateAvailable: true;
  /** true when files were written (false when autoUpdate=false or dryRun). */
  applied: boolean;
  dryRun?: boolean;
  /** Version extracted from the bundle (= baked into proto header & handshake). */
  version?: WAVersion;
  protoVersion?: string;
  messageCount?: number;
  updatedFiles?: string[];
  hotSwap?: { added: number; removed: number; updated: number; totalKeys: number };
  versionHotSwap?: { defaultsConfig: boolean; genericsFallback: string };
  durationMs?: number;
}

export type CheckResult = UpToDateResult | UpdateResult;

export interface ExtractSummary {
  ok: true;
  version: string;
  out: string;
  messageCount: number;
  enumCount: number;
  bytes: number;
}

export interface ValidateSummary {
  ok: boolean;
  keyCount?: number;
  roundtrip?: string;
  error?: string;
}

export interface UpdateEventInfo extends UpdateResult {
  updateAvailable: true;
  applied: true;
}

export declare class ProtoUpdater extends EventEmitter {
  constructor(options?: ProtoUpdaterOptions);

  /** Resolved absolute path of the baileys package. */
  readonly baileysPath: string;

  /** Start interval + run one immediate check. */
  start(): Promise<CheckResult | { error: Error }>;
  /** Stop the interval timer. */
  stop(): void;

  /** One check cycle: compare versions, extract+apply when newer. */
  checkNow(force?: boolean): Promise<CheckResult>;
  /** Force a full re-extract + re-apply regardless of version comparison. */
  forceUpdate(): Promise<CheckResult>;

  /** Restore the pristine backup taken before the first update. */
  restore(): { restoredFiles: string[] };

  on(event: 'checking', listener: (info: { installed: WAVersion | null; baileysPkg: string }) => void): this;
  on(event: 'uptodate', listener: (info: { installed: WAVersion | null; latest: WAVersion }) => void): this;
  on(event: 'update-available', listener: (info: { installed: WAVersion | null; latest: WAVersion }) => void): this;
  on(event: 'extracting' | 'applying' | 'generating', listener: (info: Record<string, unknown>) => void): this;
  on(event: 'extracted', listener: (info: ExtractSummary) => void): this;
  on(event: 'validated', listener: (info: ValidateSummary) => void): this;
  on(event: 'update', listener: (info: UpdateEventInfo) => void): this;
  on(event: 'dry-run', listener: (info: UpdateResult) => void): this;
  on(event: 'restored', listener: (info: { restoredFiles: string[] }) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export declare function createProtoUpdater(options?: ProtoUpdaterOptions): ProtoUpdater;

/** One-shot check without a timer: extracts + applies automatically when a newer version exists (`force` re-extracts even then). */
export declare function checkForUpdate(options?: ProtoUpdaterOptions & { force?: boolean }): Promise<CheckResult>;

/** One-shot full update: always re-extracts and applies, regardless of the version comparison. */
export declare function applyUpdate(options?: ProtoUpdaterOptions): Promise<CheckResult>;

/** Fetch [2, 3000, clientRevision] from web.whatsapp.com/sw.js. */
export declare function fetchLatestVersion(): Promise<WAVersion>;

export declare function resolveBaileysPath(explicit?: string): string;
export declare function getBaileysPackageVersion(baileysPath: string): string;
export declare function getCurrentVersion(baileysPath: string): WAVersion | null;
export declare function compareVersions(a: WAVersion, b: WAVersion): -1 | 0 | 1;
export declare function formatVersion(v: WAVersion | null): string;

export declare function generateWaProto(
  protoPath: string,
  outDir: string,
  opts?: { types?: boolean }
): Promise<{ jsOut: string; dtsOut: string | null; jsSize: number }>;

export declare function applyToDisk(args: {
  baileysPath: string;
  protoFile: string;
  indexJs: string;
  indexDts: string | null;
  version: WAVersion;
  updateVersion?: boolean;
}): { updatedFiles: string[]; versionUpdated: boolean };

export declare function restoreBackup(baileysPath: string): { restoredFiles: string[] };
export declare function ensureBackup(baileysPath: string): string;

export declare function loadHeldProto(
  baileysPath: string
): Promise<{ proto: Record<string, unknown>; $root: unknown; module: unknown }>;

export declare function hotSwapProto(
  baileysPath: string,
  held: { proto: Record<string, unknown>; $root: unknown }
): Promise<{ added: number; removed: number; updated: number; totalKeys: number }>;

export declare function hotSwapVersion(
  baileysPath: string,
  version: WAVersion
): Promise<{ defaultsConfig: boolean; genericsFallback: string }>;
