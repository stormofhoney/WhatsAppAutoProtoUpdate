/**
 * Generate WAProto/index.js + index.d.ts from a .proto file using the same
 * pipeline as Baileys' WAProto/GenerateStatics.sh:
 *
 *   pbjs -t static-module --no-beautify -w es6 --no-bundle --no-delimited --no-verify --no-comments -o index.js WAProto.proto
 *   pbjs ... | pbts --no-comments -o index.d.ts -
 *   node fix-imports.js   (ported below, from Baileys WAProto/fix-imports.js)
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

function resolveBin(name) {
  // protobufjs-cli ships bin/pbjs and bin/pbts
  const cliPkg = require.resolve('protobufjs-cli/package.json');
  return join(dirname(cliPkg), 'bin', name);
}

/**
 * Port of Baileys WAProto/fix-imports.js (operates on the file in place).
 * Kept functionally identical: import fix, protobufjs/minimal.js fix,
 * Long helper injection + toObject long-conversion rewrite.
 */
export function fixImports(filePath) {
  let content = readFileSync(filePath, 'utf8');

  content = content.replace(/import \* as (\$protobuf) from/g, 'import $1 from');
  content = content.replace(/(['"])protobufjs\/minimal(['"])/g, '$1protobufjs/minimal.js$2');

  const marker = 'const $root = $protobuf.roots["default"] || ($protobuf.roots["default"] = {});\n\n';
  const longToStringHelper =
    'function longToString(value, unsigned) {\n' +
    '\tif (typeof value === "string") {\n' +
    '\t\treturn value;\n' +
    '\t}\n' +
    '\tif (typeof value === "number") {\n' +
    '\t\treturn String(value);\n' +
    '\t}\n' +
    '\t// Fast path: convert Long {low, high} directly via native BigInt\n' +
    '\t// BigInt.toString() is a native C++ operation, much faster than Long\'s pure JS division loops\n' +
    '\tif (value && typeof value.low === "number" && typeof value.high === "number") {\n' +
    '\t\tconst lo = BigInt(value.low >>> 0);\n' +
    '\t\tconst hi = BigInt(value.high >>> 0);\n' +
    '\t\tconst combined = (hi << 32n) | lo;\n' +
    '\t\tif (!unsigned && value.high < 0) {\n' +
    '\t\t\treturn (combined - (1n << 64n)).toString();\n' +
    '\t\t}\n' +
    '\t\treturn combined.toString();\n' +
    '\t}\n' +
    '\treturn String(value);\n' +
    '}\n\n';
  const longToNumberHelper =
    'function longToNumber(value, unsigned) {\n' +
    '\tif (typeof value === "string") {\n' +
    '\t\treturn Number(value);\n' +
    '\t}\n' +
    '\tif (typeof value === "number") {\n' +
    '\t\treturn value;\n' +
    '\t}\n' +
    '\t// Fast path: convert Long {low, high} directly via native BigInt\n' +
    '\t// BigInt.toNumber() is much faster than Long\'s pure JS arithmetic\n' +
    '\tif (value && typeof value.low === "number" && typeof value.high === "number") {\n' +
    '\t\tconst lo = BigInt(value.low >>> 0);\n' +
    '\t\tconst hi = BigInt(value.high >>> 0);\n' +
    '\t\tconst combined = (hi << 32n) | lo;\n' +
    '\t\tif (!unsigned && value.high < 0) {\n' +
    '\t\t\treturn Number(combined - (1n << 64n));\n' +
    '\t\t}\n' +
    '\t\treturn Number(combined);\n' +
    '\t}\n' +
    '\treturn Number(value);\n' +
    '}\n\n';

  if (!content.includes('function longToString(')) {
    const markerIndex = content.indexOf(marker);
    if (markerIndex === -1) {
      throw new Error('Unable to inject Long helpers: marker not found in WAProto index output');
    }
    content = content.replace(marker, `${marker}${longToStringHelper}${longToNumberHelper}`);
  } else {
    const longToStringRegex = /function longToString\(value, unsigned\) {\n[\s\S]*?\n}\n\n/;
    const longToNumberRegex = /function longToNumber\(value, unsigned\) {\n[\s\S]*?\n}\n\n/;

    if (!longToStringRegex.test(content) || !longToNumberRegex.test(content)) {
      throw new Error('Unable to update Long helpers: existing definitions not found');
    }
    content = content.replace(longToStringRegex, longToStringHelper);
    content = content.replace(longToNumberRegex, longToNumberHelper);
  }

  const longPattern =
    /([ \t]+d\.(\w+) = )o\.longs === String \? \$util\.Long\.prototype\.toString\.call\(m\.\2\) : o\.longs === Number \? new \$util\.LongBits\(m\.\2\.low >>> 0, m\.\2\.high >>> 0\)\.toNumber\((true)?\) : m\.\2;/g;
  content = content.replace(longPattern, (_match, prefix, field, unsignedFlag) => {
    const unsignedArg = unsignedFlag ? ', true' : '';
    return `${prefix}o.longs === String ? longToString(m.${field}${unsignedArg}) : o.longs === Number ? longToNumber(m.${field}${unsignedArg}) : m.${field};`;
  });

  writeFileSync(filePath, content, 'utf8');
}

/**
 * @param {string} protoPath  path to WAProto.proto
 * @param {string} outDir     directory to receive index.js / index.d.ts
 * @param {{types?: boolean}} [opts]
 */
export async function generateWaProto(protoPath, outDir, opts = {}) {
  const wantTypes = opts.types !== false;
  const node = process.execPath;
  const pbjs = resolveBin('pbjs');
  const pbts = resolveBin('pbts');

  const jsOut = join(outDir, 'index.js');
  const dtsOut = join(outDir, 'index.d.ts');

  const common = [
    '-t', 'static-module', '--no-beautify', '-w', 'es6',
    '--no-bundle', '--no-delimited', '--no-verify', '--no-comments',
  ];

  // stage 1: index.js
  await run(node, [pbjs, ...common, '-o', jsOut, protoPath]);

  // stage 2: fix-imports (same as GenerateStatics.sh step 3)
  fixImports(jsOut);

  // stage 3: index.d.ts via pbjs | pbts (skippable – runtime doesn't need it)
  if (wantTypes) {
    const pbjsProc = spawn(node, [pbjs, ...common, protoPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const pbtsProc = spawn(node, [pbts, '--no-comments', '-o', dtsOut, '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let pbtsErr = '';
    pbtsProc.stderr.on('data', (d) => (pbtsErr += d));
    const done = new Promise((resolve, reject) => {
      pbtsProc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`pbts exited ${code}\n${pbtsErr.slice(-2000)}`))
      );
    });
    pbjsProc.stdout.pipe(pbtsProc.stdin);
    let pbjsErr = '';
    pbjsProc.stderr.on('data', (d) => (pbjsErr += d));
    const pbjsDone = new Promise((resolve, reject) => {
      pbjsProc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`pbjs(for pbts) exited ${code}\n${pbjsErr.slice(-2000)}`))
      );
    });
    await Promise.all([done, pbjsDone]);
  }

  const jsSize = readFileSync(jsOut).length;
  if (jsSize < 500_000) {
    throw new Error(`generated index.js suspiciously small (${jsSize} bytes)`);
  }
  return { jsOut, dtsOut: wantTypes ? dtsOut : null, jsSize };
}
