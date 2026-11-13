import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const IPC_CONTRACT_REGISTRY = 'apps/desktop/src/shared/ipc/contracts.ts';
const CONTRACT_DIRECTORY = 'apps/desktop/src/shared/ipc';
const REGISTRY_EXPORT = 'ipcContracts';
const BUILDERS = new Set(['invoke', 'invokeGeneric', 'send', 'reply', 'event']);
const CHAIN_METHODS = new Set([
  'channel',
  'prefix',
  'conditionallyExposed',
  'withDefault',
  'projected',
]);

function fail(file, node, message) {
  const where = node
    ? `${file}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`
    : file;
  throw new Error(`IPC-CONTRACTS ${where} ${message}`);
}

function parse(repoRoot, file) {
  const text = readFileSync(path.join(repoRoot, file), 'utf8');
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function unwrap(node) {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function variableInitializer(tree, name) {
  for (const statement of tree.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer && unwrap(declaration.initializer);
      }
    }
  }
  return undefined;
}

function importedFile(tree, file, name) {
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    if (!bindings.elements.some((element) => element.name.text === name)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.'))
      fail(file, statement, `imports ${name} from a non-relative path`);
    const resolved = path.posix.join(path.posix.dirname(file), specifier);
    return resolved.endsWith('.ts') ? resolved : `${resolved}.ts`;
  }
  return fail(file, undefined, `does not import contract ${name} by name`);
}

function literalText(file, node, what) {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  return fail(file, node, `${what} must be a string literal`);
}

function propertyKey(file, property) {
  if (!ts.isPropertyAssignment(property)) {
    return fail(file, property, 'contract methods must be plain property assignments');
  }
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    return property.name.text;
  return fail(file, property, 'contract method names must be literal');
}

function readMethod(file, group, name, initializer) {
  let node = unwrap(initializer);
  let channelOverride;
  let conditional = false;
  while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const step = node.expression.name.text;
    if (!CHAIN_METHODS.has(step)) fail(file, node, `unknown contract builder step .${step}()`);
    if (step === 'channel' || step === 'prefix') {
      if (channelOverride !== undefined) fail(file, node, `${name} sets its channel twice`);
      channelOverride = literalText(file, node.arguments[0], `${name} .${step}()`);
    }
    if (step === 'conditionallyExposed') conditional = true;
    node = unwrap(node.expression.expression);
  }
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
    return fail(file, node, `${name} is not a contract builder call`);
  }
  const builder = node.expression.text;
  if (!BUILDERS.has(builder)) fail(file, node, `${name} uses unknown builder ${builder}()`);
  const kind = builder === 'invokeGeneric' ? 'invoke' : builder;
  const channel = channelOverride ?? (kind === 'reply' ? `${group}:${name}:` : `${group}:${name}`);
  const line = node.getSourceFile().getLineAndCharacterOfPosition(initializer.getStart()).line + 1;
  return { name, kind, channel, conditional, line };
}

function readGroup(repoRoot, file, exportName) {
  const tree = parse(repoRoot, file);
  const call = variableInitializer(tree, exportName);
  if (
    !call ||
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== 'defineGroup'
  ) {
    return fail(file, call, `${exportName} must be initialized by defineGroup(...)`);
  }
  const group = literalText(file, call.arguments[0], 'the group name');
  const table = call.arguments[1] && unwrap(call.arguments[1]);
  if (!table || !ts.isObjectLiteralExpression(table)) {
    return fail(file, call, `${group} methods must be an object literal`);
  }
  let mount = 'group';
  const options = call.arguments[2] && unwrap(call.arguments[2]);
  if (options) {
    if (!ts.isObjectLiteralExpression(options)) fail(file, options, 'options must be literal');
    for (const property of options.properties) {
      if (propertyKey(file, property) !== 'mount') fail(file, property, 'unknown group option');
      mount = literalText(file, property.initializer, 'mount');
    }
  }
  const methods = table.properties.map((property) =>
    readMethod(file, group, propertyKey(file, property), property.initializer)
  );
  const line = tree.getLineAndCharacterOfPosition(call.getStart()).line + 1;
  return { group, mount, exportName, file, line, methods };
}

export function readIpcContractGroups(repoRoot) {
  if (!existsSync(path.join(repoRoot, IPC_CONTRACT_REGISTRY))) return [];
  const registry = parse(repoRoot, IPC_CONTRACT_REGISTRY);
  const list = variableInitializer(registry, REGISTRY_EXPORT);
  if (!list || !ts.isArrayLiteralExpression(list)) {
    return fail(IPC_CONTRACT_REGISTRY, list, `${REGISTRY_EXPORT} must be an array literal`);
  }
  const groups = list.elements.map((element) => {
    if (!ts.isIdentifier(element)) {
      return fail(IPC_CONTRACT_REGISTRY, element, 'registry entries must be imported names');
    }
    const file = importedFile(registry, IPC_CONTRACT_REGISTRY, element.text);
    return readGroup(repoRoot, file, element.text);
  });

  const registered = new Set(groups.map(({ file }) => file));
  const unregistered = readdirSync(path.join(repoRoot, CONTRACT_DIRECTORY))
    .filter((name) => name.endsWith('.contract.ts'))
    .map((name) => `${CONTRACT_DIRECTORY}/${name}`)
    .filter((file) => !registered.has(file));
  if (unregistered.length > 0) {
    fail(IPC_CONTRACT_REGISTRY, undefined, `does not list ${unregistered.join(', ')}`);
  }

  const owners = new Map();
  for (const { group, file, methods } of groups) {
    for (const { channel } of methods) {
      if (owners.has(channel)) {
        fail(file, undefined, `channel ${channel} is already owned by ${owners.get(channel)}`);
      }
      owners.set(channel, `${group} (${file})`);
    }
  }
  const methodOwners = new Map();
  for (const { group, file, methods } of groups) {
    for (const { name } of methods) {
      const key = `${group}.${name}`;
      if (methodOwners.has(key)) {
        fail(
          file,
          undefined,
          `${key} is already declared by ${methodOwners.get(key)}; contracts that share a group must declare disjoint methods`
        );
      }
      methodOwners.set(key, file);
    }
  }
  for (const { group, file, methods } of groups) {
    for (const { name, kind, channel: prefix } of methods.filter(({ kind }) => kind === 'reply')) {
      const shadowed = [...owners.keys()].find(
        (channel) => channel !== prefix && channel.startsWith(prefix)
      );
      if (shadowed) {
        fail(file, undefined, `${group}.${name} reply prefix ${prefix} also matches ${shadowed}`);
      }
    }
  }
  return groups;
}

export function contractChannelOwnership(groups) {
  const owners = new Map();
  const replyPrefixes = [];
  for (const { group, file, methods } of groups) {
    for (const { name, kind, channel } of methods) {
      const owner = { group, method: name, kind, file };
      if (kind === 'reply') replyPrefixes.push({ prefix: channel, owner });
      else owners.set(channel, owner);
    }
  }
  return {
    ownerOf(channel) {
      return (
        owners.get(channel) ?? replyPrefixes.find(({ prefix }) => channel.startsWith(prefix))?.owner
      );
    },
    channels: [...owners.keys()],
  };
}

export function contractOwnershipMessage(channel, owner) {
  return `${channel} belongs to the ${owner.group} IPC contract (${owner.file}); register it with handleGroup and call it through the contract client instead of a raw channel`;
}

export function withoutContractChannels(lists, groups) {
  const ownership = contractChannelOwnership(groups);
  const violations = new Set();
  const filtered = Object.fromEntries(
    Object.entries(lists).map(([name, channels]) => [
      name,
      channels.filter((channel) => {
        const owner = ownership.ownerOf(channel);
        if (!owner) return true;
        if (owner.kind !== 'event') violations.add(contractOwnershipMessage(channel, owner));
        return false;
      }),
    ])
  );
  if (violations.size > 0) {
    throw new Error(`ARCH-IPC raw use of contract-owned channels:\n${[...violations].join('\n')}`);
  }
  return filtered;
}
