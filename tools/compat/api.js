// The RAGE.MP API as its type definitions describe it (third_party/ragemp,
// @ragempcommunity/types-*), read with the TypeScript compiler:
//
//   const api = load('server');   // 'server' | 'client' | 'cef'
//   api.globals   Map 'mp.players.forEach' -> {kind: 'method'|'prop'|'object', type}
//   api.classes   Map 'PlayerMp' -> Map member -> {kind, declaredIn}
//
// Globals are the properties reachable from `mp` (pools, events, world...), as
// deep as objects go; a property whose type is one of the API's classes (an
// entity, a pool) stops there and points at the class (its members are in
// api.classes, inherited ones included).

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const TYPES_DIR = path.join(__dirname, '..', '..', 'third_party', 'ragemp');
const MAX_DEPTH = 5;

function program(side) {
  const root = path.join(TYPES_DIR, `types-${side}`, 'index.d.ts');
  if (!fs.existsSync(root)) throw new Error(`no RAGE types for ${side}: ${root}`);
  const files = [root];
  // The client keeps mp.game and the natives in files of their own.
  for (const extra of ['game.d.ts', 'natives.d.ts', 'enums.d.ts']) {
    const f = path.join(TYPES_DIR, `types-${side}`, extra);
    if (fs.existsSync(f)) files.push(f);
  }
  return ts.createProgram(files, { noEmit: true, skipLibCheck: true, types: [], lib: ['lib.es2020.d.ts'] });
}

function load(side) {
  const prog = program(side);
  const checker = prog.getTypeChecker();
  const classes = new Map();
  const classNames = new Set();
  const ownFiles = prog.getRootFileNames().map((f) => path.resolve(f));
  const isOurs = (sf) => sf.fileName.startsWith(path.join(TYPES_DIR).replace(/\\/g, '/')) || ownFiles.includes(path.resolve(sf.fileName)) ||
    path.resolve(sf.fileName).startsWith(path.resolve(TYPES_DIR));

  // Classes and interfaces whose name ends in Mp or MpPool (the entities, their pools, events...).
  for (const sf of prog.getSourceFiles()) {
    if (!isOurs(sf)) continue;
    ts.forEachChild(sf, (node) => {
      if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name && /Mp(Pool)?$/.test(node.name.text) && node.name.text !== 'Mp') {
        classNames.add(node.name.text);
      }
    });
  }
  const classOf = (type) => {
    const sym = type.aliasSymbol || type.getSymbol();
    const name = sym && sym.getName();
    return name && classNames.has(name) ? name : null;
  };

  const kindOf = (prop) => {
    const decl = prop.valueDeclaration || (prop.declarations && prop.declarations[0]);
    if (!decl) return 'prop';
    if (ts.isMethodSignature(decl) || ts.isMethodDeclaration(decl)) return 'method';
    if (ts.isGetAccessor(decl) || ts.isSetAccessor(decl)) return 'prop';
    return 'prop';
  };

  for (const sf of prog.getSourceFiles()) {
    if (!isOurs(sf)) continue;
    ts.forEachChild(sf, (node) => {
      if (!(ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) || !node.name || !classNames.has(node.name.text)) return;
      const type = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(node.name));
      const members = classes.get(node.name.text) || new Map();
      for (const prop of checker.getPropertiesOfType(type)) {
        const decl = prop.valueDeclaration || (prop.declarations && prop.declarations[0]);
        const owner = decl && decl.parent && decl.parent.name ? decl.parent.name.text : node.name.text;
        members.set(prop.getName(), { kind: kindOf(prop), declaredIn: owner });
      }
      classes.set(node.name.text, members);
    });
  }

  // Everything reachable from `mp`.
  const globals = new Map();
  let mpSym = null;
  for (const sf of prog.getSourceFiles()) {
    if (!isOurs(sf)) continue;
    ts.forEachChild(sf, (node) => {
      if (ts.isVariableStatement(node))
        for (const d of node.declarationList.declarations) if (d.name.getText(sf) === 'mp') mpSym = checker.getSymbolAtLocation(d.name);
    });
  }
  if (!mpSym) throw new Error(`no mp in the ${side} types`);
  const walk = (type, prefix, depth, seen) => {
    for (const prop of checker.getPropertiesOfType(type)) {
      const name = `${prefix}.${prop.getName()}`;
      const decl = prop.valueDeclaration || (prop.declarations && prop.declarations[0]);
      const ptype = decl ? checker.getTypeOfSymbolAtLocation(prop, decl) : checker.getTypeOfSymbol(prop);
      const cls = classOf(ptype);
      if (kindOf(prop) === 'method' || ptype.getCallSignatures().length) {
        globals.set(name, { kind: 'method' });
      } else if (cls) {
        globals.set(name, { kind: 'object', type: cls });
      } else if (ptype.flags & ts.TypeFlags.Object && depth < MAX_DEPTH && !seen.has(ptype) && checker.getPropertiesOfType(ptype).length) {
        globals.set(name, { kind: 'object' });
        walk(ptype, name, depth + 1, new Set([...seen, ptype]));
      } else {
        globals.set(name, { kind: 'prop' });
      }
    }
  };
  walk(checker.getTypeOfSymbol(mpSym), 'mp', 1, new Set());
  return { side, globals, classes };
}

module.exports = { load, TYPES_DIR };
