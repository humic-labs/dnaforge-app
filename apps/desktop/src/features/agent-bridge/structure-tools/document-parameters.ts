import { MVSTreeSchema } from 'molstar/lib/extensions/mvs/tree/mvs/mvs-tree';
import {
  paramsValidationIssues,
  type ParamsSchema,
} from 'molstar/lib/extensions/mvs/tree/generic/params-schema';
import { canonicalJson } from '../../../shared/canonical-json';
import { coordinateDigest } from '../../../shared/molecular-view';
import { assignStructureRefsInRoot } from '../../page/public/embeds/structure3d/molstar/molViewSpecStructureIdentity';

type Codec = {
  name: string;
  _tag?: string;
  value?: unknown;
  keys?: Record<string, unknown>;
  props?: Record<string, Codec>;
  types?: Codec[];
  type?: Codec;
  domain?: Codec;
  codomain?: Codec;
};
type Node = {
  kind: string;
  ref?: string;
  params?: Record<string, unknown>;
  custom?: Record<string, unknown>;
  children?: Node[];
};
type Parameter = {
  path: string;
  nodeKind: string;
  nodeRef?: string;
  viewId?: string;
  name: string;
  value?: unknown;
  required: boolean;
  default?: unknown;
  description: string;
  valueSchema: Record<string, unknown>;
};
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);

function valueSchema(type: Codec, depth = 0): Record<string, unknown> {
  if (depth > 12) return { 'x-molstar-type': type.name };
  const child = (value: Codec) => valueSchema(value, depth + 1);
  switch (type._tag) {
    case 'StringType':
      return { type: 'string' };
    case 'NumberType':
      return { type: 'number' };
    case 'BooleanType':
      return { type: 'boolean' };
    case 'NullType':
      return { type: 'null' };
    case 'LiteralType':
      return { const: type.value };
    case 'KeyofType':
      return { enum: Object.keys(type.keys ?? {}) };
    case 'ArrayType':
      return { type: 'array', items: child(type.type!) };
    case 'TupleType':
      return {
        type: 'array',
        prefixItems: type.types!.map(child),
        items: false,
        minItems: type.types!.length,
        maxItems: type.types!.length,
      };
    case 'UnionType':
      return { anyOf: type.types!.map(child) };
    case 'IntersectionType':
      return { allOf: type.types!.map(child) };
    case 'InterfaceType':
      return {
        type: 'object',
        properties: Object.fromEntries(Object.entries(type.props!).map(([k, v]) => [k, child(v)])),
        required: Object.keys(type.props!),
      };
    case 'PartialType':
      return {
        type: 'object',
        properties: Object.fromEntries(Object.entries(type.props!).map(([k, v]) => [k, child(v)])),
      };
    case 'DictionaryType':
      return { type: 'object', additionalProperties: child(type.codomain!) };
    default:
      return { 'x-molstar-type': type.name };
  }
}

function schemaFor(node: Node): ParamsSchema {
  const schema = (MVSTreeSchema.nodes as Record<string, { params: ParamsSchema }>)[node.kind]
    ?.params;
  if (!schema) throw Error(`Unsupported molecular document node kind: ${node.kind}`);
  return schema;
}

function fieldsFor(node: Node) {
  const schema = schemaFor(node);
  if (schema.type === 'simple') return schema.fields;
  const selected = node.params?.[schema.discriminator];
  if (typeof selected !== 'string' || !Object.prototype.hasOwnProperty.call(schema.cases, selected))
    throw Error(`The ${node.kind} node has an invalid parameter discriminator.`);
  return schema.cases[selected].fields;
}

function walk(
  scene: Record<string, unknown>,
  visit: (node: Node, path: string, viewId?: string) => void
) {
  const root = (node: Node, path: string, viewId?: string) => {
    visit(node, path, viewId);
    node.children?.forEach((child, index) => root(child, `${path}/children/${index}`, viewId));
  };
  if (scene.kind === 'multiple')
    (scene.snapshots as Array<{ root: Node; metadata?: { key?: string } }>).forEach((view, index) =>
      root(view.root, `/snapshots/${index}/root`, view.metadata?.key)
    );
  else root(scene.root as Node, '/root', (scene.metadata as { key?: string } | undefined)?.key);
}

export async function molecularSceneDigest(scene: string): Promise<string> {
  return coordinateDigest(canonicalJson(JSON.parse(scene)));
}

function molecularColorValue(node: Node) {
  const {
    dnaforge_selection_id: _selectionId,
    dnaforge_legend_generated: _legendGenerated,
    ...custom
  } = node.custom ?? {};
  return { ...node, custom };
}

export function retainsMolecularDataColors(before: string, after: string): boolean {
  const colors = (scene: string) => {
    const values: unknown[] = [];
    walk(JSON.parse(scene), (node, path) => {
      if (node.kind.startsWith('color')) {
        values.push({ path, ...molecularColorValue(node) });
      }
    });
    return canonicalJson(values);
  };
  return colors(before) === colors(after);
}

export async function rebaseMolecularDataParameters(
  baseScene: string,
  currentScene: string,
  edits: ReadonlyArray<{ path: string; value: unknown }>,
  compiledScene?: string
): Promise<string> {
  const normalize = (scene: string) => {
    const document = JSON.parse(scene);
    const roots =
      document.kind === 'multiple'
        ? document.snapshots.map((snapshot: { root: Node }) => snapshot.root)
        : [document.root];
    for (const root of roots) assignStructureRefsInRoot(root);
    return document;
  };
  const baseDocument = normalize(baseScene),
    currentDocument = normalize(currentScene);
  const baseNodes = new Map<string, Node>(),
    currentNodes = new Map<string, Node>();
  walk(baseDocument, (node, path) => baseNodes.set(path, node));
  walk(currentDocument, (node, path) => currentNodes.set(path, node));
  const applicable: Array<{ path: string; value: unknown }> = [];
  for (const edit of edits) {
    const path = edit.path.slice(0, edit.path.lastIndexOf('/params/'));
    const current = currentNodes.get(path);
    if (current?.kind === 'camera') continue;
    let ancestor = path;
    while (ancestor) {
      const base = baseNodes.get(ancestor),
        live = currentNodes.get(ancestor);
      if (
        !base ||
        !live ||
        base.kind !== live.kind ||
        base.ref !== live.ref ||
        canonicalJson(base.params ?? {}) !== canonicalJson(live.params ?? {})
      )
        throw Error(
          'The retained data-layer baseline disagrees with this parameter target. Reapply the data variation before editing it.'
        );
      const parent = ancestor.lastIndexOf('/children/');
      ancestor = parent < 0 ? '' : ancestor.slice(0, parent);
    }
    applicable.push(edit);
  }
  const normalizedBase = JSON.stringify(baseDocument);
  if (compiledScene) {
    if (!retainsMolecularDataColors(currentScene, compiledScene))
      throw Error('The parameter edit changed data-owned colors.');
    const compiled = normalize(compiledScene),
      compiledNodes = new Map<string, Node>();
    walk(compiled, (node, path) => compiledNodes.set(path, node));
    const owned = new Set<string>();
    const colorValue = (node: Node) => canonicalJson(molecularColorValue(node));
    for (const [path, current] of currentNodes) {
      if (current.kind !== 'representation') continue;
      const base = baseNodes.get(path);
      if (base?.kind !== 'representation')
        throw Error('The retained data representation identity is unavailable.');
      const baseline = base.children ?? [],
        children = current.children ?? [];
      if (
        baseline.length > children.length ||
        baseline.some((node, index) => colorValue(node) !== colorValue(children[index]))
      )
        throw Error('The retained data appearance baseline disagrees with its document.');
      for (let index = baseline.length; index < children.length; index++) {
        const child = children[index],
          key = `${path}/children/${index}`,
          next = compiledNodes.get(key);
        if (child.kind !== 'color' || !next || colorValue(child) !== colorValue(next))
          throw Error('The data-owned colors cannot be separated from this parameter edit.');
        owned.add(key);
      }
    }
    const strip = (node: Node, path: string) => {
      if (node.children)
        node.children = node.children.flatMap((child, index) => {
          const key = `${path}/children/${index}`;
          if (owned.has(key)) return [];
          strip(child, key);
          return [child];
        });
    };
    if (compiled.kind === 'multiple')
      compiled.snapshots.forEach((snapshot: { root: Node }, index: number) =>
        strip(snapshot.root, `/snapshots/${index}/root`)
      );
    else strip(compiled.root, '/root');
    return JSON.stringify(compiled);
  }
  return applicable.length
    ? editMolecularDocumentParameters(
        normalizedBase,
        await molecularSceneDigest(normalizedBase),
        applicable
      )
    : normalizedBase;
}

export function requireAppliedMolecularParameterEdits(
  scene: string,
  edits: ReadonlyArray<{ path: string; value: unknown }>
): void {
  const document = JSON.parse(scene);
  for (const edit of edits) {
    const actual = edit.path
      .split('/')
      .filter(Boolean)
      .reduce((node, key) => node?.[key], document);
    if (canonicalJson(actual) !== canonicalJson(edit.value))
      throw Object.assign(
        new Error(
          `The document construction policy overrides ${edit.path}. Use the documented presentation override for that field. The document was not modified.`
        ),
        { code: 'MVS_PARAMETER_POLICY_CONFLICT' }
      );
  }
}

export async function inspectMolecularDocumentParameters(
  scene: string,
  options: { offset?: number; limit?: number } = {}
) {
  const parameters: Parameter[] = [];
  walk(JSON.parse(scene), (node, path, viewId) => {
    for (const [name, field] of Object.entries(fieldsFor(node))) {
      if (unsafe.has(name)) continue;
      parameters.push({
        path: `${path}/params/${name}`,
        nodeKind: node.kind,
        nodeRef: node.ref,
        viewId,
        name,
        value: node.params?.[name],
        required: field.required,
        ...(!field.required ? { default: field.default } : {}),
        description: field.description,
        valueSchema: valueSchema(field.type),
      });
    }
    const schema = schemaFor(node);
    if (schema.type === 'union')
      parameters.push({
        path: `${path}/params/${schema.discriminator}`,
        nodeKind: node.kind,
        nodeRef: node.ref,
        viewId,
        name: schema.discriminator,
        value: node.params?.[schema.discriminator],
        required: true,
        description: schema.discriminatorDescription,
        valueSchema: { enum: Object.keys(schema.cases) },
      });
  });
  const offset = options.offset ?? 0,
    limit = options.limit ?? 64;
  return {
    schema: 'dnaforge.molecular-document-parameters.v1',
    sceneSha256: await molecularSceneDigest(scene),
    valueSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    validation:
      'Installed MolViewSpec validators are authoritative, including x-molstar-type constraints.',
    parameters: parameters.slice(offset, offset + limit),
    total: parameters.length,
    nextOffset: offset + limit < parameters.length ? offset + limit : null,
    write: {
      tool: 'mol_apply_scene',
      fields: ['parameterEdits', 'expectedSceneSha256'],
      atomic: true,
      effectiveValueContract:
        'Requested values are checked after construction policy validation. Overridden values fail before rendering; read renderProfileGuidance for explicit presentation overrides.',
    },
    dataColor: {
      tool: 'mol_data',
      operations: ['inspect', 'publish', 'apply'],
      retains: [
        'original-records',
        'coordinate-mapping',
        'exact-revisions',
        'scales',
        'missing-values',
        'legends',
      ],
    },
  };
}

export async function editMolecularDocumentParameters(
  scene: string,
  expectedSceneSha256: string,
  edits: ReadonlyArray<{ path: string; value: unknown }>
): Promise<string> {
  if ((await molecularSceneDigest(scene)) !== expectedSceneSha256)
    throw Error('The molecular document parameters changed. Inspect them again before editing.');
  const document = JSON.parse(scene);
  const nodes = new Map<string, Node>();
  walk(document, (node, path) => nodes.set(path, node));
  const seen = new Set<string>();
  for (const edit of edits) {
    const match = /^(.*)\/params\/([^/]+)$/.exec(edit.path);
    if (!match || unsafe.has(match[2]) || seen.has(edit.path))
      throw Error('Invalid or duplicate molecular parameter path.');
    const node = nodes.get(match[1]);
    if (!node) throw Error('The molecular parameter node does not exist.');
    const schema = schemaFor(node);
    if (
      !Object.prototype.hasOwnProperty.call(fieldsFor(node), match[2]) &&
      !(schema.type === 'union' && schema.discriminator === match[2])
    )
      throw Error('The molecular parameter is not supported by this node.');
    seen.add(edit.path);
    node.params = { ...node.params, [match[2]]: structuredClone(edit.value) };
  }
  for (const node of nodes.values()) {
    const issues = paramsValidationIssues(schemaFor(node), node.params ?? {}, { noExtra: true });
    if (issues) throw Error(`Invalid ${node.kind} parameters: ${issues.join(' ')}`);
  }
  return JSON.stringify(document);
}
