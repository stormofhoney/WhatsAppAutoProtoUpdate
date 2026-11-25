# baileys-proto-updater

Runtime-Plugin für **[@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) 7.x** (getestet mit `7.0.0-rc14`),
das deine installierte WhatsApp-Proto **immer auf dem neuesten Stand** hält – extrahiert direkt aus dem
live WhatsApp-Web-Bundle (`web.whatsapp.com`), ohne Dritt-Repos.

```
sw.js → Bootstrap-JS (6,4 MB) → AST-Parsing (@stormofhoney/oak) → WAProto.proto
      → pbjs/pbts + fix-imports → Disk-Patch (mit Backup) → In-Memory-Hot-Swap → Event 🎉
```

## Was genau wird gepatcht?

| Ziel | Details |
|---|---|
| `WAProto/WAProto.proto` | frisch extrahiert mit gebrandetem Header (siehe unten) |
| `WAProto/index.js` | generiert via `pbjs -t static-module -w es6` + Baileys' `fix-imports`-Pipeline |
| `WAProto/index.d.ts` | via `pbts` (abschaltbar mit `--no-types` / `generateTypes: false`) |
| Handshake-Version | `lib/Defaults/index.js` (`const version = [2, 3000, …]`), `lib/Utils/generics.js` (`const baileysVersion = …`) und – falls vorhanden – `baileys-version.json` |
| **Laufzeit** | Proto-Namespace wird **in-memory geswappt** (kein Restart nötig für Encode/Decode), `DEFAULT_CONNECTION_CONFIG.version` wird mutiert |

Vor dem ersten Patch wird alles nach `node_modules/@whiskeysockets/baileys/.proto-updater-backup/`
gesichert → `restore()` bringt die Originaldateien zurück.

### Proto-Header

Jede extrahierte `WAProto.proto` beginnt mit:

```proto
/// WhatsApp VERSION: 2.3000.1056132189
/// MADE WITH LOVE BY: STORM OF HONEY
/// CREATE WITH: https://github.com/stormofhoney/WhatsAppAutoProtoUpdate
/// LAST UPDATE: 1795584000
```

- **`WhatsApp VERSION`** – die *tatsächliche* WhatsApp-Version des extrahierten Bundles
  (einzige Quelle für den Handshake-Patch in `lib/Defaults` & `lib/Utils/generics`)
- **`LAST UPDATE`** – Unix-Timestamp (Sekunden) des Extraktionslaufs

## Installation

```bash
npm i baileys-proto-updater        # peer: @whiskeysockets/baileys >=7.0.0-rc14
```

## Nutzung als Runtime-Modul

```js
import { ProtoUpdater } from 'baileys-proto-updater';

const updater = new ProtoUpdater({
  interval: 6 * 60 * 60 * 1000,   // alle 6 h automatisch prüfen (Standard)
  updateVersion: true,            // Handshake-Version mitziehen (Standard: true)
  generateTypes: true,            // index.d.ts neu bauen (Standard: true)
  logger: myPinoLikeLogger,       // optional: { info, warn, error, debug }
});

updater.on('update', (info) => {
  // info: { installed, version, messageCount, hotSwap: { added, updated, removed }, durationMs, ... }
  console.log(`Proto aktualisiert → ${info.version.join('.')} (+${info.hotSwap.added} Typen)`);
});

updater.on('error', (err) => console.error('Proto-Update fehlgeschlagen:', err));

await updater.start();   // sofortiger Check + Intervall-Timer
// ...
updater.stop();          // Timer stoppen
```

### Events

| Event | Payload |
|---|---|
| `checking` | `{ installed, baileysPkg }` |
| `uptodate` | `{ installed, latest }` |
| `update-available` | `{ installed, latest }` (nur bei `autoUpdate: false`) |
| `extracting` / `extracted` / `generating` / `validated` / `applying` | Zwischenstände |
| `update` | `{ installed, version, messageCount, updatedFiles, hotSwap, durationMs, … }` |
| `error` | `Error` |

### One-Shot (CI/Scripts)

```js
import { checkForUpdate, applyUpdate, fetchLatestVersion } from 'baileys-proto-updater';

const latest = await fetchLatestVersion();   // [2, 3000, 1056109635]
const res    = await checkForUpdate();       // prüfen + anwenden falls neuer (kein Timer)
await applyUpdate();                         // immer vollständig neu extrahieren + anwenden
```

## CLI

```bash
npx baileys-proto-updater              # prüfen + anwenden
npx baileys-proto-updater check        # nur prüfen (Exit 2 = Update verfügbar)
npx baileys-proto-updater update       # erzwingt Re-Extract
npx baileys-proto-updater status       # installiert/neueste Version + Pfade
npx baileys-proto-updater restore      # Backup zurückspielen
# Flags: --dry-run  --no-version  --no-types  --path <dir>  --json
```

## Sicherheit

- **Isolation**: Extraktion und Validierung laufen in Child-Processen (oak-AST ~250 MB Ram
  und der frisch generierte Modul-Import lecken nie in den Bot-Prozess).
- **Konsistenz-Check**: neue Proto muss ≥90 % der bisherigen Top-Level-Typen haben + Message-Roundtrip
  (`proto.Message` encode/decode) in der Child-Validation bestehen – sonst **wird nichts angerührt**.
- **Backup + Rollback**: jede Datei wird zuerst `.ppu-tmp` geschrieben und per `rename` ersetzt;
  bei Fehlern werden alle angefassten Dateien aus dem Backup zurückkopiert.
- **Kein Downgrade**: wird nur aktualisiert, wenn die Live-Version höher ist (`forceUpdate()` umgeht das).

## Einschränkungen

1. **Restart-Empfehlung nach Update**: Encode/Decode läuft sofort weiter, aber modul-lokal
   eingefangene Konstanten (z. B. `PROCESSABLE_HISTORY_TYPES` in `lib/Defaults`, generierte
   Typen für TS-Compiler) werden erst beim Neustart neu geladen. Empfehlung: Update → Neuverbindung/Restart.
2. `lib/Utils/generics.js` → `baileysVersion` ist modul-privat und wird nur auf Disk gepatcht
   (betrifft ausschließlich den Fallback-Fall von `fetchLatestBaileysVersion`).
3. Die Proto-Quelle ist das WhatsApp-Web-Bundle – Änderungen dort (Bundle-Umbau) können das
   AST-Extraction brechen; das Plugin fängt das ab (Validation) und lässt die Installation unangetastet.
4. Kein Yarn-PnP-Support (braucht echte `node_modules`-Pfade); npm/pnpm/Classic-Yarn OK.

## API-Referenz (TS)

Typen liegen unter `types/index.d.ts`. Vollständige Optionen:

```ts
new ProtoUpdater({
  baileysPath?: string;       // Auto-Resolve (Standard)
  interval?: number;          // ms, Standard 6 h, 0 = aus
  autoUpdate?: boolean;       // Standard true
  updateVersion?: boolean;    // Standard true
  generateTypes?: boolean;    // Standard true
  dryRun?: boolean;           // Standard false
  workerTimeoutMs?: number;   // Standard 180 000
  logger?: { info, warn, error, debug };
})
```

## Wie es funktioniert (Details)

1. **Check**: `GET web.whatsapp.com/sw.js` → `client_revision` → `[2, 3000, rev]` vergleichen mit
   der in Baileys eingebauten Version (quelltext-ggelesen, nicht geraten).
2. **Extract**: Child-Process lädt das Bootstrap-JS (URL aus `sw.js` `importScripts`) und portet
   1:1 die Extraktions-Logik aus Baileys' `proto-extract/` (oak-AST → `internalSpec`-Walk →
   sortiertes `.proto`). `LimitSharing$Trigger`-Patch inklusive.
   Parser ist [`@stormofhoney/oak`](https://github.com/stormofhoney/oak) – der 1:1-Drop-in für
   `acorn` + `acorn-walk` in einer Package. Da oak (noch) nicht auf npm liegt, liegt das
   gebaute Paket als Tarball unter `vendor/` und hängt als `file:`-Dependency am
   `package.json`; sobald `@stormofhoney/oak` registry-seitig existiert, genügt dort
   `"@stormofhoney/oak": "^0.9.9"` einzutragen.
3. **Generate**: identisch zu `WAProto/GenerateStatics.sh` – `pbjs … -o index.js`, `fix-imports`,
   `pbjs | pbts -o index.d.ts`.
4. **Validate**: Kindprozess importiert das Ergebnis, prüft Namespace-Größe, Roundtrip, Enums.
5. **Apply**: Backup → `.ppu-tmp`-Writes → `rename` → Versions-Regex-Patches (3 Stellen).
6. **Hot-Swap**: importiert die neue `WAProto/index.js` (cache-busted), kopiert den Namespace
   in das Objekt, das alle Baileys-Module halten, `$root.proto` wird neu ausgehängt;
   `DEFAULT_CONNECTION_CONFIG.version`-Array wird in-place mutiert (Ref-geteilt in jeden Socket-Config).

## Lizenz

MIT. Extraktions-Logik portiert aus `WhiskeySockets/Baileys` (ebenfalls MIT) – danke!
