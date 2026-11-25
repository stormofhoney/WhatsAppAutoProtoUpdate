/**
 * Extract worker – ported from WhiskeySockets/Baileys proto-extract/index.js (MIT).
 *
 * Differences from upstream:
 *   - ESM + global fetch instead of request-promise-native
 *   - result is written as JSON to --out (machine readable) instead of hard-coded path
 *   - everything else (AST walk, naming, stringification) is kept byte-for-byte
 *     equivalent so output matches `WAProto/WAProto.proto` from upstream.
 *
 * Usage: node workers/extract.mjs --out /tmp/extracted/WAProto.proto
 */
import * as oak from '@stormofhoney/oak';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
    if (outIdx === -1 || !args[outIdx + 1]) {
  console.error('usage: node extract.mjs --out <file>');
  process.exit(2);
}
const outPath = args[outIdx + 1];

let whatsAppVersion = 'latest';

const addPrefix = (lines, prefix) => lines.map((line) => prefix + line);

const extractAllExpressions = (node) => {
  const expressions = [node];
  const exp = node.expression;
  if (exp) {
    expressions.push(exp);
  }
  if (node?.expression?.arguments?.length) {
    for (const arg of node?.expression?.arguments) {
      if (arg?.body?.body?.length) {
        for (const exp of arg?.body.body) {
          expressions.push(...extractAllExpressions(exp));
        }
      }
    }
  }
  if (node?.body?.body?.length) {
    for (const exp of node?.body.body) {
      if (exp.expression) {
        expressions.push(...extractAllExpressions(exp.expression));
      }
    }
  }

  if (node.expression?.expressions?.length) {
    for (const exp of node.expression.expressions) {
      expressions.push(...extractAllExpressions(exp));
    }
  }

  return expressions;
};

async function fetchText(url, extraHeaders = {}) {
  // NB: header names are lower-cased here – mixing 'Sec-Fetch-Site' and
  // 'sec-fetch-site' in one record makes undici append both values
  // ("same-origin, none") and web.whatsapp.com answers HTTP 400.
  const headers = {
    'user-agent':
      'Mozilla/5.0 (X11; Linux x86_64; rv:100.0) Gecko/20100101 Firefox/100.0',
    'sec-fetch-dest': 'script',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'same-origin',
    referer: 'https://web.whatsapp.com/',
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.5',
    ...Object.fromEntries(
      Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])
    ),
  };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

async function findAppModules() {
  const baseURL = 'https://web.whatsapp.com';
  const serviceworker = await fetchText(`${baseURL}/sw.js`, {
    'sec-fetch-site': 'none',
    'User-Agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const versions = [
    ...serviceworker.matchAll(/client_revision\\":([\d.]+),/g),
  ].map((r) => r[1]);
  const version = versions[0];
  if (!version) throw new Error('could not find client_revision in sw.js');
  process.stderr.write(`[extract] current version: 2.3000.${version}\n`);

  const waVersion = `2.3000.${version}`;
  whatsAppVersion = waVersion;

  let bootstrapQRURL = '';
  const clearString = serviceworker.replaceAll('/*BTDS*/', '');
  const URLScript = clearString.match(/(?<=importScripts\(["'])(.*?)(?=["']\);)/g);
  if (!URLScript?.length) throw new Error('could not find importScripts URL in sw.js');
  bootstrapQRURL = new URL(URLScript[0].replaceAll('\\', '')).href;

  process.stderr.write(`[extract] source JS: ${bootstrapQRURL}\n`);
  const qrData = await fetchText(bootstrapQRURL);

  // This one list of types is so long that it's split into two JavaScript declarations.
  // The module finder below can't handle it, so just patch it manually here.
  const patchedQrData = qrData.replaceAll(
    'LimitSharing$Trigger',
    'LimitSharing$TriggerType'
  );

  const qrModules = oak.parse(patchedQrData, { ecmaVersion: 'latest' }).body;

  const result = qrModules.filter((m) => {
    const expressions = extractAllExpressions(m);
    return expressions?.find((e) => {
      return e?.left?.property?.name === 'internalSpec';
    });
  });
  process.stderr.write(`[extract] found ${result.length} proto modules\n`);
  return result;
}

const unspecName = (name) => (name.endsWith('Spec') ? name.slice(0, -4) : name);
const unnestName = (name) => name.split('$').slice(-1)[0];
const getNesting = (name) => name.split('$').slice(0, -1).join('$');
const makeRenameFunc = () => (name) => {
  name = unspecName(name);
  return name;
};

const modules = await findAppModules();

// find aliases of cross references between the wanted modules
const modulesInfo = {};
const moduleIndentationMap = {};
modules.forEach((module) => {
  const moduleName = module.expression.arguments[0].value;
  modulesInfo[moduleName] = { crossRefs: [] };
  oak.simple(module, {
    AssignmentExpression(node) {
      if (
        node &&
        node?.right?.type == 'CallExpression' &&
        node?.right?.arguments?.length == 1 &&
        node?.right?.arguments[0].type !== 'ObjectExpression'
      ) {
        modulesInfo[moduleName].crossRefs.push({
          alias: node.left.name,
          module: node.right.arguments[0].value,
        });
      }
    },
  });
});

// find all identifiers and, for enums, their array of values
for (const mod of modules) {
  const modInfo = modulesInfo[mod.expression.arguments[0].value];
  const rename = makeRenameFunc(mod.expression.arguments[0].value);

  const assignments = [];
  oak.simple(mod, {
    AssignmentExpression(node) {
      const left = node.left;
      if (
        left.property?.name &&
        left.property?.name !== 'internalSpec' &&
        left.property?.name !== 'internalDefaults' &&
        left.property?.name !== 'name'
      ) {
        assignments.push(left);
      }
    },
  });

  const makeBlankIdent = (a) => {
    const key = rename(a?.property?.name);
    const indentation = getNesting(key);
    const value = { name: key };

    moduleIndentationMap[key] = moduleIndentationMap[key] || {};
    moduleIndentationMap[key].indentation = indentation;

    if (indentation.length) {
      moduleIndentationMap[indentation] =
        moduleIndentationMap[indentation] || {};
      moduleIndentationMap[indentation].members =
        moduleIndentationMap[indentation].members || new Set();
      moduleIndentationMap[indentation].members.add(key);
    }

    return [key, value];
  };

  modInfo.identifiers = Object.fromEntries(
    assignments.map(makeBlankIdent).reverse()
  );
  const enumAliases = {};
  // enums are defined directly, and both enums and messages get a one-letter alias
  oak.ancestor(mod, {
    Property(node, anc) {
      const fatherNode = anc[anc.length - 3];
      const fatherFather = anc[anc.length - 4];
      if (
        fatherNode?.type === 'AssignmentExpression' &&
        fatherNode?.left?.property?.name == 'internalSpec' &&
        fatherNode?.right?.properties.length
      ) {
        const values = fatherNode?.right?.properties.map((p) => ({
          name: p.key.name,
          id: p.value.value,
        }));
        const nameAlias = fatherNode?.left?.name;
        enumAliases[nameAlias] = values;
      } else if (node?.key && node?.key?.name && fatherNode.arguments?.length > 0) {
        const values = fatherNode.arguments?.[0]?.properties.map((p) => ({
          name: p.key.name,
          id: p.value.value,
        }));
        const nameAlias = fatherFather?.left?.name || fatherFather.id.name;
        enumAliases[nameAlias] = values;
      }
    },
  });
  oak.simple(mod, {
    AssignmentExpression(node) {
      if (
        node.left.type === 'MemberExpression' &&
        modInfo.identifiers?.[rename(node.left.property.name)]
      ) {
        const ident = modInfo.identifiers[rename(node.left.property.name)];
        ident.alias = node.right.name;
        ident.enumValues = enumAliases[ident.alias];
      }
    },
  });
}

// find the contents for all protobuf messages
for (const mod of modules) {
  const modInfo = modulesInfo[mod.expression.arguments[0].value];
  const rename = makeRenameFunc(mod.expression.arguments[0].value);
  const findByAliasInIdentifier = (obj, alias) => {
    return Object.values(obj).find((item) => item.alias === alias);
  };

  // message specifications are stored in a "internalSpec" attribute of the respective identifier alias
  oak.simple(mod, {
    AssignmentExpression(node) {
      if (
        node.left.type === 'MemberExpression' &&
        node.left.property.name === 'internalSpec' &&
        node.right.type === 'ObjectExpression'
      ) {
        const targetIdent = Object.values(modInfo.identifiers).find(
          (v) => v.alias === node.left.object.name
        );
        if (!targetIdent) {
          process.stderr.write(
            `[extract] warning: message specification for unknown identifier alias: ${node.left.object.name}\n`
          );
          return;
        }

        // partition spec properties by normal members and constraints (like "__oneofs__") which will be processed afterwards
        const constraints = [];
        let members = [];
        for (const p of node.right.properties) {
          p.key.name = p.key.type === 'Identifier' ? p.key.name : p.key.value;
          const arr =
            p.key.name.substr(0, 2) === '__' ? constraints : members;
          arr.push(p);
        }

        members = members.map(({ key: { name }, value: { elements } }) => {
          let type;
          const flags = [];
          const unwrapBinaryOr = (n) =>
            n.type === 'BinaryExpression' && n.operator === '|'
              ? [].concat(unwrapBinaryOr(n.left), unwrapBinaryOr(n.right))
              : [n];

          // find type and flags
          unwrapBinaryOr(elements[1]).forEach((m) => {
            if (
              m.type === 'MemberExpression' &&
              m.object.type === 'MemberExpression'
            ) {
              if (m.object.property.name === 'TYPES') {
                type = m.property.name.toLowerCase();
                if (type == 'map') {
                  let typeStr = 'map<';
                  if (elements[2]?.type === 'ArrayExpression') {
                    const subElements = elements[2].elements;
                    subElements.forEach((element, index) => {
                      if (element?.property?.name) {
                        typeStr += element?.property?.name?.toLowerCase();
                      } else {
                        const ref = findByAliasInIdentifier(
                          modInfo.identifiers,
                          element.name
                        );
                        typeStr += ref.name;
                      }
                      if (index < subElements.length - 1) {
                        typeStr += ', ';
                      }
                    });
                    typeStr += '>';
                    type = typeStr;
                  }
                }
              } else if (m.object.property.name === 'FLAGS') {
                const flag = m.property.name.toLowerCase();
                // proto3 has no `required` – newer protobufjs (≥7.5) rejects it
                // during parse. Map to `optional`: same presence semantics as the
                // rest of the upstream WAProto.proto (which labels everything
                // `optional`). Wire format is unaffected.
                flags.push(flag === 'required' ? 'optional' : flag);
              }
            }
          });

          // determine cross reference name from alias if this member has type "message" or "enum"
          if (type === 'message' || type === 'enum') {
            const currLoc = ` from member '${name}' of message ${targetIdent.name}'`;
            if (elements[2].type === 'Identifier') {
              type = Object.values(modInfo.identifiers).find(
                (v) => v.alias === elements[2].name
              )?.name;
              if (!type) {
                process.stderr.write(
                  `[extract] warning: unable to find reference of alias '${elements[2].name}'` +
                    currLoc +
                    '\n'
                );
              }
            } else if (elements[2].type === 'MemberExpression') {
              let crossRef = modInfo.crossRefs.find(
                (r) =>
                  r.alias === elements[2]?.object?.name ||
                  elements[2]?.object?.left?.name ||
                  elements[2]?.object?.callee?.name
              );
              if (
                elements[1]?.property?.name === 'ENUM' &&
                elements[2]?.property?.name?.includes('Type')
              ) {
                type = rename(elements[2]?.property?.name);
              } else if (elements[2]?.property?.name.includes('Spec')) {
                type = rename(elements[2].property.name);
              } else if (
                crossRef &&
                crossRef.module !== '$InternalEnum' &&
                modulesInfo[crossRef.module].identifiers[
                  rename(elements[2].property.name)
                ]
              ) {
                type = rename(elements[2].property.name);
              } else {
                process.stderr.write(
                  `[extract] warning: unable to find reference of alias to other module '${elements[2].object.name}' or to message ${elements[2].property.name} of this module` +
                    currLoc +
                    '\n'
                );
              }
            }
          }

          return { name, id: elements[0].value, type, flags };
        });

        // resolve constraints for members
        constraints.forEach((c) => {
          if (c.key.name === '__oneofs__' && c.value.type === 'ObjectExpression') {
            const newOneOfs = c.value.properties.map((p) => ({
              name: p.key.name,
              type: '__oneof__',
              members: p.value.elements.map((e) => {
                const idx = members.findIndex((m) => m.name === e.value);
                const member = members[idx];
                members.splice(idx, 1);
                return member;
              }),
            }));
            members.push(...newOneOfs);
          }
        });

        targetIdent.members = members;
      }
    },
  });
}

const decodedProtoMap = {};
const spaceIndent = ' '.repeat(4);
for (const mod of modules) {
  const modInfo = modulesInfo[mod.expression.arguments[0].value];
  const identifiers = Object.values(modInfo?.identifiers);

  // enum stringifying function
  const stringifyEnum = (ident, overrideName = null) =>
    [].concat(
      [`enum ${overrideName || ident.displayName || ident.name} {`],
      addPrefix(
        ident.enumValues.map((v) => `${v.name} = ${v.id};`),
        spaceIndent
      ),
      ['}']
    );

  // message specification member stringifying function
  const stringifyMessageSpecMember = (
    info,
    completeFlags,
    parentName = undefined
  ) => {
    if (info.type === '__oneof__') {
      return [].concat(
        [`oneof ${info.name} {`],
        addPrefix(
          [].concat(
            ...info.members.map((m) => stringifyMessageSpecMember(m, false))
          ),
          spaceIndent
        ),
        ['}']
      );
    } else {
      if (info.flags.includes('packed')) {
        info.flags.splice(info.flags.indexOf('packed'));
        info.packed = ' [packed=true]';
      }
      if (completeFlags && info.flags.length === 0 && !info.type.includes('map')) {
        info.flags.push('optional');
      }

      const ret = [];
      const indentation = moduleIndentationMap[info.type]?.indentation;
      let typeName = unnestName(info.type);
      if (indentation !== parentName && indentation) {
        typeName = `${indentation.replaceAll('$', '.')}.${typeName}`;
      }

      ret.push(
        `${
          info.flags.join(' ') + (info.flags.length === 0 ? '' : ' ')
        }${typeName} ${info.name} = ${info.id}${info.packed || ''};`
      );
      return ret;
    }
  };

  // message specification stringifying function
  const stringifyMessageSpec = (ident) => {
    const members = moduleIndentationMap[ident.name]?.members;
    const result = [];
    result.push(
      `message ${ident.displayName || ident.name} {`,
      ...addPrefix(
        [].concat(
          ...ident.members.map((m) =>
            stringifyMessageSpecMember(m, true, ident.name)
          )
        ),
        spaceIndent
      )
    );

    if (members?.size) {
      const sortedMembers = Array.from(members).sort();
      for (const memberName of sortedMembers) {
        let entity = modInfo.identifiers[memberName];
        if (entity) {
          const displayName = entity.name.slice(ident.name.length + 1);
          entity = { ...entity, displayName };
          result.push(...addPrefix(getEntity(entity), spaceIndent));
        } else {
          process.stderr.write(`[extract] missing nested entity ${memberName}\n`);
        }
      }
    }

    result.push('}');
    result.push('');

    return result;
  };

  const getEntity = (v) => {
    let result;
    if (v.members) {
      result = stringifyMessageSpec(v);
    } else if (v.enumValues?.length) {
      result = stringifyEnum(v);
    } else {
      result = ['// Unknown entity ' + v.name];
    }

    return result;
  };

  const stringifyEntity = (v) => {
    return {
      content: getEntity(v).join('\n'),
      name: v.name,
    };
  };

  for (const value of identifiers) {
    const { name, content } = stringifyEntity(value);
    if (!moduleIndentationMap[name]?.indentation?.length) {
      decodedProtoMap[name] = content;
    }
  }
}

const decodedProto = Object.keys(decodedProtoMap).sort();
const sortedStr = decodedProto.map((d) => decodedProtoMap[d]).join('\n');

const unixSeconds = Math.floor(Date.now() / 1000);
const decodedProtoStr = `syntax = "proto3";\npackage proto;\n\n/// WhatsApp VERSION: ${whatsAppVersion}\n/// MADE WITH LOVE BY: STORM OF HONEY\n/// CREATE WITH: https://github.com/stormofhoney/WhatsAppAutoProtoUpdate\n/// LAST UPDATE: ${unixSeconds}\n\n${sortedStr}`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, decodedProtoStr);

const messageCount = (decodedProtoStr.match(/^message /gm) || []).length;
const enumCount = (decodedProtoStr.match(/^enum /gm) || []).length;

process.stdout.write(
  JSON.stringify({
    ok: true,
    version: whatsAppVersion,
    out: outPath,
    messageCount,
    enumCount,
    bytes: decodedProtoStr.length,
  })
);
