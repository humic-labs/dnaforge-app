import { parseDelimitedRows } from '@waypoint/scientific-objects/delimited-rows';
import { parseUniqueJson } from '@waypoint/scientific-objects/unique-json';
import { inventoryRecordIdExists } from './inventory-configuration';
import { inventoryStackItems } from './inventory-layout';
import { inventoryReceiveSourceKey } from './inventory-receive-source';
import { applyInventoryCommandBatch } from './inventory-state';
import {
  inventoryTableBindingKey,
  inventoryTableCanonicalJson,
  inventoryTableSha256,
} from './inventory-table-binding';
import type { InventoryTableIssue, InventoryTableTarget } from './inventory-table-types';
import {
  createInventoryState,
  MAX_INVENTORY_BATCH_COMMANDS,
  MAX_INVENTORY_STORAGE_SLOTS,
  type InventoryCommand,
  type InventoryExecutionContext,
  type InventoryLayout,
  type InventoryState,
  type InventoryStoragePlacement,
  type InventoryTransition,
} from './inventory-types';
import { parseInventoryExecutionContext, parseInventoryState } from './inventory-validation';
import {
  INVENTORY_HIERARCHY_COLUMNS,
  type InventoryHierarchyApplication,
  type InventoryHierarchyBinding,
  type InventoryHierarchyChoices,
  type InventoryHierarchyFields,
  type InventoryHierarchyPreview,
  type InventoryHierarchyPreviewInput,
  type InventoryHierarchyRowPreview,
} from './inventory-hierarchy-types';

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const key = inventoryReceiveSourceKey;
const issue = (code: string, pointer: string, message: string): InventoryTableIssue => ({
  code,
  pointer,
  message,
});
const canonical = inventoryTableCanonicalJson;
const positive = (value: string): number | null =>
  /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}
export function inventoryHierarchyStorageId(
  target: Pick<InventoryTableTarget, 'projectId' | 'inventoryId'>,
  namespace: string,
  sourceId: string
): string {
  return `hierarchy-storage:${inventoryTableSha256(JSON.stringify(['dnaforge.inventory-hierarchy.v1', target.projectId, target.inventoryId, namespace, sourceId])).slice(7)}`;
}
function choicesIssues(options: InventoryHierarchyChoices): InventoryTableIssue[] {
  if (!exact(options, ['namespace', 'delimiter', 'parents', 'skips']))
    return [
      issue(
        'HIERARCHY_OPTIONS_INVALID',
        '/options',
        'Supply exactly namespace, delimiter, parents and skips.'
      ),
    ];
  const issues: InventoryTableIssue[] = [];
  if (!key(options.namespace))
    issues.push(
      issue(
        'HIERARCHY_NAMESPACE_INVALID',
        '/options/namespace',
        'Supply an exact nonblank source namespace of at most 256 characters.'
      )
    );
  if (options.delimiter !== ',' && options.delimiter !== '\t')
    issues.push(
      issue('HIERARCHY_DELIMITER_INVALID', '/options/delimiter', 'Choose comma or tab explicitly.')
    );
  for (const name of ['parents', 'skips'] as const) {
    const values = options[name];
    if (!Array.isArray(values)) {
      issues.push(
        issue(
          'HIERARCHY_OPTIONS_INVALID',
          `/options/${name}`,
          'Supply an explicit resolution list.'
        )
      );
      continue;
    }
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      const id = name === 'parents' ? value?.key : value?.sourceId;
      const valid =
        name === 'parents'
          ? exact(value, ['key', 'storageId']) && key(value.storageId)
          : exact(value, ['sourceId', 'reason']) &&
            typeof value.reason === 'string' &&
            Boolean(value.reason.trim()) &&
            value.reason.length <= 2000 &&
            !value.reason.includes('\0');
      if (!valid || !key(id))
        issues.push(
          issue(
            'HIERARCHY_RESOLUTION_INVALID',
            `/options/${name}/${index}`,
            'Parent mappings need exact identifiers; skips require an explicit reason.'
          )
        );
      else if (seen.has(id))
        issues.push(
          issue(
            'HIERARCHY_RESOLUTION_DUPLICATE',
            `/options/${name}/${index}`,
            'An exact resolution key repeats.'
          )
        );
      else seen.add(id);
    }
  }
  return issues;
}
function layout(fields: InventoryHierarchyFields): InventoryLayout | null {
  if (
    fields.layout_kind === 'named' &&
    fields.rows === '' &&
    fields.columns === '' &&
    fields.capacity === ''
  ) {
    let positions: unknown;
    try {
      positions = parseUniqueJson(fields.positions);
    } catch {
      return null;
    }
    if (
      !Array.isArray(positions) ||
      !positions.length ||
      positions.length > MAX_INVENTORY_STORAGE_SLOTS ||
      positions.some(
        (value) =>
          typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')
      ) ||
      new Set(positions).size !== positions.length
    )
      return null;
    return { kind: 'named', slots: positions };
  }
  if (
    ['grid', 'removable-tube', 'fixed-well'].includes(fields.layout_kind) &&
    fields.positions === '' &&
    fields.capacity === ''
  ) {
    const rows = positive(fields.rows),
      columns = positive(fields.columns);
    if (rows === null || columns === null || rows * columns > MAX_INVENTORY_STORAGE_SLOTS)
      return null;
    return { kind: fields.layout_kind as 'grid' | 'removable-tube' | 'fixed-well', rows, columns };
  }
  if (
    fields.layout_kind === 'stack' &&
    fields.positions === '' &&
    fields.rows === '' &&
    fields.columns === ''
  ) {
    const capacity = positive(fields.capacity);
    if (capacity === null || capacity > MAX_INVENTORY_STORAGE_SLOTS) return null;
    return { kind: 'stack', capacity, removal: 'top-only' };
  }
  return null;
}
interface Node {
  index: number;
  sourceId: string;
  fields: InventoryHierarchyFields;
  layout: InventoryLayout | null;
  storageId: string;
  destination: InventoryStoragePlacement | null;
  binding: InventoryHierarchyBinding | null;
  skipped: string | null;
  unchanged: boolean;
  issues: InventoryTableIssue[];
}

export function inventoryHierarchyPreview(
  state: InventoryState | null,
  input: InventoryHierarchyPreviewInput
): InventoryHierarchyPreview {
  const sourceText = typeof input.sourceText === 'string' ? input.sourceText : '';
  const sourceSha256 = inventoryTableSha256(sourceText);
  const issues: InventoryTableIssue[] = [];
  const rows: InventoryHierarchyRowPreview[] = [];
  const parentKeys = new Set<string>();
  const commands: InventoryCommand[] = [];
  const bindingAdditions = Object.create(null) as Record<string, InventoryHierarchyBinding>;
  const facts = () => ({
    schema: 'dnaforge.inventory-hierarchy-preview.v1' as const,
    sourceSha256,
    target: { ...input.target },
    parentKeys: [...parentKeys].sort(order),
    rows,
  });
  const blocked = (): InventoryHierarchyPreview => ({
    ...facts(),
    kind: 'blocked',
    issues,
    commands: [],
    bindingAdditions: {},
    options: null,
    planDigest: null,
  });
  if (
    typeof input.sourceText !== 'string' ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 1 ||
    new TextEncoder().encode(sourceText).byteLength > input.maxBytes
  )
    issues.push(
      issue(
        'HIERARCHY_SOURCE_TOO_LARGE',
        '/sourceText',
        'The exact source must fit the inline native transport byte bound.'
      )
    );
  if (
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      new TextEncoder().encode(sourceText)
    ) !== sourceText
  )
    issues.push(
      issue(
        'HIERARCHY_SOURCE_UTF8_INVALID',
        '/sourceText',
        'The source must contain valid UTF-8 text.'
      )
    );
  issues.push(...choicesIssues(input.options));
  let previous: InventoryState;
  let context: InventoryExecutionContext;
  try {
    previous = state === null ? createInventoryState() : parseInventoryState(state);
    context = parseInventoryExecutionContext({
      at: input.asOf,
      principal: input.principal,
      authority: input.authority,
    });
    if (
      !key(input.target.projectId) ||
      !key(input.target.inventoryId) ||
      input.target.present !== (state !== null) ||
      input.target.revision !== previous.revision
    )
      issues.push(
        issue(
          'HIERARCHY_TARGET_CHANGED',
          '/target',
          'The exact target scope, presence and revision must match the inspected inventory.'
        )
      );
    if (context.at < previous.lastRecordedAt)
      issues.push(
        issue(
          'CLOCK_REGRESSION',
          '/target',
          'The trusted timestamp precedes the inventory clock floor.'
        )
      );
  } catch (error) {
    issues.push(
      issue(
        'HIERARCHY_TARGET_INVALID',
        '/target',
        error instanceof Error ? error.message : 'Invalid target or execution context.'
      )
    );
    return blocked();
  }
  if (issues.length) return blocked();
  const parsed = parseDelimitedRows(
    sourceText.startsWith('\uFEFF') ? sourceText.slice(1) : sourceText,
    input.options.delimiter
  );
  if (!parsed.ok) {
    issues.push(issue('HIERARCHY_PARSE_INVALID', '/sourceText', parsed.error));
    return blocked();
  }
  const [headers, ...records] = parsed.rows;
  if (
    !headers ||
    headers.length !== INVENTORY_HIERARCHY_COLUMNS.length ||
    new Set(headers).size !== headers.length ||
    INVENTORY_HIERARCHY_COLUMNS.some((column) => !headers.includes(column))
  ) {
    issues.push(
      issue(
        'HIERARCHY_HEADERS_INVALID',
        '/sourceText',
        `Use each declared column exactly once: ${INVENTORY_HIERARCHY_COLUMNS.join(', ')}.`
      )
    );
    return blocked();
  }
  const parents = new Map(input.options.parents.map((parent) => [parent.key, parent.storageId]));
  const skips = new Map(input.options.skips.map((skip) => [skip.sourceId, skip.reason]));
  const ids = new Set<string>();
  const nodes = new Map<string, Node>();
  for (const [index, record] of records.entries()) {
    const pointer = `/rows/${index + 2}`;
    const fields =
      record.length === headers.length
        ? (Object.fromEntries(
            headers.map((column, i) => [column, record[i]])
          ) as unknown as InventoryHierarchyFields)
        : null;
    const sourceId = fields?.source_id ?? null;
    const rowIssues: InventoryTableIssue[] = [];
    if (!fields)
      rowIssues.push(
        issue(
          'HIERARCHY_ROW_WIDTH_INVALID',
          pointer,
          'Every row must contain exactly the declared number of fields.'
        )
      );
    if (!key(sourceId))
      rowIssues.push(
        issue(
          'HIERARCHY_SOURCE_ID_INVALID',
          `${pointer}/source_id`,
          'Supply an exact stable source identity.'
        )
      );
    else if (ids.has(sourceId))
      rowIssues.push(
        issue(
          'HIERARCHY_SOURCE_ID_DUPLICATE',
          `${pointer}/source_id`,
          'An exact source identity repeats.'
        )
      );
    else ids.add(sourceId);
    if (!fields || !key(sourceId) || rowIssues.length) {
      rows.push({
        index: index + 2,
        sourceId,
        fields,
        kind: 'blocked',
        storageId: null,
        layout: null,
        destination: null,
        reason: null,
        issues: rowIssues,
      });
      issues.push(...rowIssues);
      continue;
    }
    const bindingKey = inventoryTableBindingKey(input.options.namespace, sourceId);
    const binding = Object.hasOwn(previous.hierarchyBindings, bindingKey)
      ? previous.hierarchyBindings[bindingKey]
      : null;
    const node: Node = {
      index: index + 2,
      sourceId,
      fields,
      layout: null,
      storageId:
        binding?.storageId ??
        inventoryHierarchyStorageId(input.target, input.options.namespace, sourceId),
      destination: null,
      binding,
      skipped: skips.get(sourceId) ?? null,
      unchanged: false,
      issues: rowIssues,
    };
    nodes.set(sourceId, node);
    if (node.skipped !== null) continue;
    if (!fields.name.trim() || fields.name.length > 512 || fields.name.includes('\0'))
      rowIssues.push(
        issue(
          'HIERARCHY_NAME_INVALID',
          `${pointer}/name`,
          'Supply a nonblank name of at most 512 characters.'
        )
      );
    node.layout = layout(fields);
    if (!node.layout)
      rowIssues.push(
        issue(
          'HIERARCHY_LAYOUT_INVALID',
          `${pointer}/layout_kind`,
          'Declare a complete named, grid, removable-tube, fixed-well or stack layout; leave unrelated layout fields blank.'
        )
      );
    if (fields.parent_kind === 'root') {
      if (fields.parent_key !== '' || fields.slot !== '')
        rowIssues.push(
          issue(
            'HIERARCHY_PARENT_INVALID',
            pointer,
            'Root storage requires blank parent_key and slot.'
          )
        );
      else node.destination = { kind: 'root' };
    } else if (fields.parent_kind === 'source' || fields.parent_kind === 'existing') {
      if (
        !key(fields.parent_key) ||
        !fields.slot.trim() ||
        fields.slot.length > 512 ||
        fields.slot.includes('\0')
      )
        rowIssues.push(
          issue(
            'HIERARCHY_PARENT_INVALID',
            pointer,
            'A parent requires an exact reference key and explicit position.'
          )
        );
      if (fields.parent_kind === 'existing') parentKeys.add(fields.parent_key);
    } else
      rowIssues.push(
        issue(
          'HIERARCHY_PARENT_INVALID',
          `${pointer}/parent_kind`,
          'Choose root, source or existing explicitly.'
        )
      );
  }
  for (const parent of input.options.parents)
    if (!parentKeys.has(parent.key))
      issues.push(
        issue(
          'HIERARCHY_RESOLUTION_UNUSED',
          '/options/parents',
          'A parent mapping does not occur in a non-skipped source row.'
        )
      );
  for (const skip of input.options.skips)
    if (!ids.has(skip.sourceId))
      issues.push(
        issue('HIERARCHY_SKIP_UNKNOWN', '/options/skips', 'A skip does not identify a source row.')
      );
  for (const node of nodes.values()) {
    if (node.skipped !== null || node.fields.parent_kind === 'root') continue;
    const fields = node.fields;
    let parentId: string | null = null;
    if (fields.parent_kind === 'existing') {
      parentId = parents.get(fields.parent_key) ?? null;
      if (!parentId || !Object.hasOwn(previous.storage, parentId))
        node.issues.push(
          issue(
            'HIERARCHY_PARENT_UNRESOLVED',
            `/rows/${node.index}/parent_key`,
            'Resolve this key to existing inventory storage.'
          )
        );
    } else if (fields.parent_kind === 'source') {
      const parent = nodes.get(fields.parent_key);
      if (!parent || (parent.skipped !== null && !parent.binding))
        node.issues.push(
          issue(
            'HIERARCHY_PARENT_UNRESOLVED',
            `/rows/${node.index}/parent_key`,
            'The source parent must occur in this table and cannot be skipped before it is bound.'
          )
        );
      else parentId = parent.storageId;
    }
    if (parentId !== null)
      node.destination = { kind: 'located', storageId: parentId, slotId: fields.slot };
  }
  const visited = new Set<string>();
  for (const start of nodes.values()) {
    const path = new Set<string>();
    let node: Node | undefined = start;
    while (node && node.skipped === null && !visited.has(node.sourceId)) {
      if (path.has(node.sourceId)) {
        node.issues.push(
          issue(
            'CONTAINMENT_CYCLE',
            `/rows/${node.index}/parent_key`,
            'Source parent references contain a cycle.'
          )
        );
        break;
      }
      path.add(node.sourceId);
      node = node.fields.parent_kind === 'source' ? nodes.get(node.fields.parent_key) : undefined;
    }
    for (const id of path) visited.add(id);
  }
  for (const node of nodes.values()) {
    if (node.skipped !== null || !node.binding || !node.destination) continue;
    const hash = inventoryTableSha256(
      canonical({ format: 'dnaforge.inventory-hierarchy-row.v1', fields: node.fields })
    );
    if (
      node.binding.rowSha256 !== hash ||
      canonical(node.binding.destination) !== canonical(node.destination)
    )
      node.issues.push(
        issue(
          'HIERARCHY_SOURCE_CHANGED',
          `/rows/${node.index}`,
          'This bound source row or parent decision changed. Reconcile it explicitly rather than creating or moving storage.'
        )
      );
    else node.unchanged = true;
  }
  const remaining = [...nodes.values()].filter((node) => node.skipped === null && !node.unchanged);
  const created = new Set<string>();
  const layouts = new Map(
    Object.values(previous.storage).map((storage) => [storage.id, storage.layout])
  );
  for (const node of nodes.values())
    if (node.layout && !layouts.has(node.storageId)) layouts.set(node.storageId, node.layout);
  const generatedCount = remaining.reduce(
    (count, node) =>
      count +
      (node.destination?.kind === 'located' &&
      layouts.get(node.destination.storageId)?.kind === 'stack'
        ? 2
        : 1),
    0
  );
  if (generatedCount > MAX_INVENTORY_BATCH_COMMANDS)
    issues.push(
      issue(
        'HIERARCHY_BATCH_TOO_LARGE',
        '/rows',
        `The proposal generates more than ${MAX_INVENTORY_BATCH_COMMANDS} commands. No automatic splitting occurs.`
      )
    );
  const stackCounts = new Map(
    Object.values(previous.storage)
      .filter((storage) => storage.layout.kind === 'stack')
      .map((storage) => [storage.id, inventoryStackItems(previous, storage.id).length])
  );
  while (
    remaining.length &&
    !issues.length &&
    ![...nodes.values()].some((node) => node.issues.length)
  ) {
    const available = remaining
      .filter((node) => {
        if (node.fields.parent_kind !== 'source') return true;
        const parent = nodes.get(node.fields.parent_key)!;
        return parent.unchanged || parent.skipped !== null || created.has(parent.sourceId);
      })
      .sort((a, b) => {
        const stackGroup = (node: Node): readonly [string, number] =>
          node.destination?.kind === 'located' &&
          layouts.get(node.destination.storageId)?.kind === 'stack'
            ? [node.destination.storageId, Number(node.destination.slotId)]
            : [node.storageId, 0];
        const first = stackGroup(a),
          second = stackGroup(b);
        return order(first[0], second[0]) || first[1] - second[1] || order(a.sourceId, b.sourceId);
      });
    const node = available[0];
    if (!node) {
      issues.push(
        issue('CONTAINMENT_CYCLE', '/rows', 'Source parent dependencies cannot be resolved.')
      );
      break;
    }
    remaining.splice(remaining.indexOf(node), 1);
    if (!node.layout || !node.destination) break;
    if (inventoryRecordIdExists(previous, node.storageId)) {
      node.issues.push(
        issue(
          'ID_ALREADY_EXISTS',
          `/rows/${node.index}`,
          'The generated physical identifier already exists without this source binding.'
        )
      );
      break;
    }
    if (
      node.destination.kind === 'located' &&
      layouts.get(node.destination.storageId)?.kind === 'stack'
    ) {
      const ordinal = positive(node.destination.slotId);
      const count = stackCounts.get(node.destination.storageId) ?? 0;
      if (ordinal === null || ordinal !== count + 1) {
        node.issues.push(
          issue(
            'HIERARCHY_STACK_POSITION_INVALID',
            `/rows/${node.index}/slot`,
            'New stack positions must be exact positive ordinals contiguous with the current stack.'
          )
        );
        break;
      }
      commands.push(
        {
          kind: 'create-layout-storage',
          id: node.storageId,
          name: node.fields.name,
          layout: node.layout,
          placement: { kind: 'root' },
        },
        {
          kind: 'push-stack',
          stackId: node.destination.storageId,
          item: { kind: 'storage', id: node.storageId },
        }
      );
      stackCounts.set(node.destination.storageId, count + 1);
    } else
      commands.push({
        kind: 'create-layout-storage',
        id: node.storageId,
        name: node.fields.name,
        layout: node.layout,
        placement: node.destination,
      });
    bindingAdditions[inventoryTableBindingKey(input.options.namespace, node.sourceId)] = {
      namespace: input.options.namespace,
      sourceId: node.sourceId,
      rowSha256: inventoryTableSha256(
        canonical({ format: 'dnaforge.inventory-hierarchy-row.v1', fields: node.fields })
      ),
      storageId: node.storageId,
      destination: node.destination,
    };
    created.add(node.sourceId);
  }
  for (const node of nodes.values()) {
    issues.push(...node.issues);
    rows.push({
      index: node.index,
      sourceId: node.sourceId,
      fields: node.fields,
      kind:
        node.skipped !== null
          ? 'skipped'
          : node.issues.length
            ? 'blocked'
            : node.unchanged
              ? 'unchanged'
              : 'create',
      storageId: node.storageId,
      layout: node.layout,
      destination: node.destination,
      reason: node.skipped,
      issues: node.issues,
    });
  }
  rows.sort((a, b) => a.index - b.index);
  if (commands.length > MAX_INVENTORY_BATCH_COMMANDS)
    issues.push(
      issue(
        'HIERARCHY_BATCH_TOO_LARGE',
        '/rows',
        `The proposal generates more than ${MAX_INVENTORY_BATCH_COMMANDS} commands. No automatic splitting occurs.`
      )
    );
  const options: InventoryHierarchyChoices = {
    namespace: input.options.namespace,
    delimiter: input.options.delimiter,
    parents: [...input.options.parents].sort((a, b) => order(a.key, b.key)),
    skips: [...input.options.skips].sort((a, b) => order(a.sourceId, b.sourceId)),
  };
  if (issues.length) return blocked();
  if (!commands.length)
    return {
      ...facts(),
      kind: 'no-change',
      issues: [],
      commands: [],
      bindingAdditions: {},
      options,
      planDigest: null,
    };
  const transition = applyInventoryCommandBatch(
    previous,
    { expectedRevision: previous.revision, commands },
    context
  );
  if (!transition.ok) {
    issues.push(issue(transition.code, '/rows', transition.message));
    return blocked();
  }
  const planDigest = inventoryTableSha256(
    canonical({
      format: 'dnaforge.inventory-hierarchy-plan.v1',
      sourceSha256,
      target: input.target,
      options,
      commands,
      bindingAdditions,
    })
  );
  return { ...facts(), kind: 'ready', issues: [], commands, bindingAdditions, options, planDigest };
}

export function applyInventoryHierarchy(
  state: InventoryState | null,
  application: InventoryHierarchyApplication,
  context: InventoryExecutionContext,
  maxBytes: number
): InventoryTransition {
  const preview = inventoryHierarchyPreview(state, {
    target: application.target,
    sourceText: application.sourceText,
    options: application.options,
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
    maxBytes,
  });
  if (preview.kind !== 'ready')
    return {
      ok: false,
      code: 'INVALID_INVENTORY_INPUT',
      message:
        preview.kind === 'blocked'
          ? (preview.issues[0]?.message ?? 'The hierarchy proposal is blocked.')
          : 'The hierarchy proposal contains no changes.',
    };
  if (preview.planDigest !== application.expectedPlanDigest)
    return {
      ok: false,
      code: 'INVALID_INVENTORY_INPUT',
      message: 'The source, target or parent decisions changed. Preview the hierarchy again.',
    };
  const previous = state === null ? createInventoryState() : parseInventoryState(state);
  const transition = applyInventoryCommandBatch(
    previous,
    { expectedRevision: previous.revision, commands: preview.commands },
    context
  );
  if (!transition.ok) return transition;
  return {
    ok: true,
    state: {
      ...transition.state,
      hierarchyBindings: Object.assign(
        Object.create(null),
        previous.hierarchyBindings,
        preview.bindingAdditions
      ),
    },
  };
}
