# baileys-proto-updater

A runtime plugin for **[@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) 7.x** (tested with `7.0.0-rc14`) that keeps your installed WhatsApp proto **always up to date** — extracted straight from the live WhatsApp Web bundle (`web.whatsapp.com`), with no third-party repos involved.

```
sw.js → Bootstrap JS (6.4 MB) → AST parsing (@stormofhoney/oak) → WAProto.proto
      → pbjs/pbts + fix-imports → disk patch (with backup) → in-memory hot-swap → event 🎉
```

## What exactly gets patched?

| Target | Details |
|---|---|
| `WAProto/WAProto.proto` | freshly extracted, with a branded header (see below) |
| `WAProto/index.js` | generated via `pbjs -t static-module -w es6` + Baileys' `fix-imports` pipeline |
| `WAProto/index.d.ts` | via `pbts` (disable with `--no-types` / `generateTypes: false`) |
| Handshake version | `lib/Defaults/index.js` (`const version = [2, 3000, …]`), `lib/Utils/generics.js` (`const baileysVersion = …`) and — if present — `baileys-version.json` |
| **Runtime** | the proto namespace is **hot-swapped in memory** (no restart needed for encode/decode), and `DEFAULT_CONNECTION_CONFIG.version` is mutated |

Before the first patch, everything is backed up to `node_modules/@whiskeysockets/baileys/.proto-updater-backup/` → `restore()` brings the original files back.

### Proto header

Every extracted `WAProto.proto` starts with:

```proto
/// WhatsApp VERSION: 2.3000.1056132189
/// MADE WITH LOVE BY: STORM OF HONEY
/// CREATE WITH: https://github.com/stormofhoney/WhatsAppAutoProtoUpdate
/// LAST UPDATE: 1795584000
```

- **`WhatsApp VERSION`** – the *actual* WhatsApp version of the extracted bundle (the single source of truth for the handshake patch in `lib/Defaults` & `lib/Utils/generics`)
- **`LAST UPDATE`** – Unix timestamp (seconds) of the extraction run

## Installation

```bash
npm i baileys-proto-updater        # peer: @whiskeysockets/baileys >=7.0.0-rc14
```

## Usage as a runtime module

```js
import { ProtoUpdater } from 'baileys-proto-updater';

const updater = new ProtoUpdater({
  interval: 6 * 60 * 60 * 1000,   // auto-check every 6 h (default)
  updateVersion: true,            // also patch the handshake version (default: true)
  generateTypes: true,            // rebuild index.d.ts (default: true)
  logger: myPinoLikeLogger,       // optional: { info, warn, error, debug }
});

updater.on('update', (info) => {
  // info: { installed, version, messageCount, hotSwap: { added, updated, removed }, durationMs, ... }
  console.log(`Proto updated → ${info.version.join('.')} (+${info.hotSwap.added} types)`);
});

updater.on('error', (err) => console.error('Proto update failed:', err));

await updater.start();   // immediate check + interval timer
// ...
updater.stop();          // stop the timer
```

### Events

| Event | Payload |
|---|---|
| `checking` | `{ installed, baileysPkg }` |
| `uptodate` | `{ installed, latest }` |
| `update-available` | `{ installed, latest }` (only when `autoUpdate: false`) |
| `extracting` / `extracted` / `generating` / `validated` / `applying` | intermediate state |
| `update` | `{ installed, version, messageCount, updatedFiles, hotSwap, durationMs, … }` |
| `error` | `Error` |

### One-shot (CI/scripts)

```js
import { checkForUpdate, applyUpdate, fetchLatestVersion } from 'baileys-proto-updater';

const latest = await fetchLatestVersion();   // [2, 3000, 1056109635]
const res    = await checkForUpdate();       // check + apply if a newer one exists (no timer)
await applyUpdate();                         // always fully re-extract + apply
```

## CLI

```bash
npx baileys-proto-updater              # check + apply
npx baileys-proto-updater check        # report only (exit 2 = update available)
npx baileys-proto-updater update       # force re-extract
npx baileys-proto-updater status       # installed/newest version + paths
npx baileys-proto-updater restore      # restore the backup
# Flags: --dry-run  --no-version  --no-types  --path <dir>  --json
```

## Security

- **Isolation**: extraction and validation run in child processes (the ~250 MB oak AST and the freshly generated module import never leak into the bot process).
- **Consistency check**: the new proto must have ≥90 % of the previous top-level types *and* pass a `proto.Message` encode/decode roundtrip in the child validation — otherwise **nothing is touched**.
- **Backup + rollback**: every file is first written to `.ppu-tmp` and replaced via `rename`; on any error, everything we touched is copied back from the backup.
- **No downgrade**: updates only happen when the live version is higher (`forceUpdate()` bypasses this).

## Limitations

1. **Restart recommended after an update**: encode/decode keeps working immediately, but module-locally captured constants (e.g. `PROCESSABLE_HISTORY_TYPES` in `lib/Defaults`, the generated types for the TS compiler) are only reloaded on restart. Recommendation: update → reconnect/restart.
2. `lib/Utils/generics.js` → `baileysVersion` is module-private and is only patched on disk (it only affects the fallback path of `fetchLatestBaileysVersion`).
3. The proto source is the WhatsApp Web bundle — changes there (bundle restructuring) can break the AST extraction; the plugin catches this (validation) and leaves the install untouched.
4. No Yarn-PnP support (needs real `node_modules` paths); npm/pnpm/Classic-Yarn are fine.

## API reference (TS)

Types live in `types/index.d.ts`. Full options:

```ts
new ProtoUpdater({
  baileysPath?: string;       // auto-resolve (default)
  interval?: number;          // ms, default 6 h, 0 = off
  autoUpdate?: boolean;       // default true
  updateVersion?: boolean;    // default true
  generateTypes?: boolean;    // default true
  dryRun?: boolean;           // default false
  workerTimeoutMs?: number;   // default 180 000
  logger?: { info, warn, error, debug };
})
```

## How it works (details)

1. **Check**: `GET web.whatsapp.com/sw.js` → `client_revision` → `[2, 3000, rev]`, compared against the version baked into Baileys (read from source, not guessed).
2. **Extract**: a child process loads the Bootstrap JS (URL taken from `sw.js` `importScripts`) and ports 1:1 the extraction logic from Baileys' `proto-extract/` (oak AST → `internalSpec` walk → sorted `.proto`). Includes the `LimitSharing$Trigger` patch.
   The parser is [`@stormofhoney/oak`](https://github.com/stormofhoney/oak) — a 1:1 drop-in replacement for `acorn` + `acorn-walk` in a single package. Since oak is not (yet) on npm, the built package lives as a tarball under `vendor/` and is attached as a `file:` dependency in `package.json`; once `@stormofhoney/oak` exists on the registry, just set `"@stormofhoney/oak": "^0.9.9"` there.
3. **Generate**: identical to `WAProto/GenerateStatics.sh` — `pbjs … -o index.js`, `fix-imports`, `pbjs | pbts -o index.d.ts`.
4. **Validate**: a child process imports the result, checks namespace size, roundtrip, and enums.
5. **Apply**: backup → `.ppu-tmp` writes → `rename` → version regex patches (3 spots).
6. **Hot-swap**: imports the new `WAProto/index.js` (cache-busted), copies the namespace into the object all Baileys modules hold, re-hooks `$root.proto`; the `DEFAULT_CONNECTION_CONFIG.version` array is mutated in place (reference-shared into every socket config).

## License

MIT. Extraction logic ported from `WhiskeySockets/Baileys` (also MIT) — thanks!
