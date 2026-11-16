import {
  JsonNumberLexeme,
  parseUniqueJsonWithNumberLexemes,
  UNIQUE_JSON_NUMBER_LIMIT_MESSAGE,
  type ExactJsonValue,
} from '@waypoint/scientific-objects/unique-json';
import { inventoryTableSha256 } from './inventory-table-binding';
import {
  INVENTORY_BENCHLING_CAPTURE_FORMAT,
  type InventoryBenchlingCapture,
  type InventoryBenchlingCaptureInspection,
  type InventoryBenchlingCaptureIssue,
  type InventoryBenchlingCapturedResponse,
  type InventoryBenchlingField,
  type InventoryBenchlingObservedField,
  type InventoryBenchlingPagination,
  type InventoryBenchlingPaginationPage,
  type InventoryBenchlingPlacementObservation,
  type InventoryBenchlingRecord,
  type InventoryBenchlingRecordKind,
  type InventoryBenchlingSourceReference,
} from './inventory-benchling-types';

type SourceObject = { [key: string]: ExactJsonValue };
type RecordObservation = InventoryBenchlingSourceReference & { value: SourceObject };
type RecordGroup = {
  kind: InventoryBenchlingRecordKind;
  sourceId: string;
  fields: Set<string>;
  observations: RecordObservation[];
};
type CapturedPage = {
  response: InventoryBenchlingCapturedResponse;
  value: SourceObject;
};

const MAX_CAPTURE_BYTES = 17 * 1024 * 1024;
const MAX_RESPONSES = 1024;
const MAX_OBSERVATIONS = 10_000;
const MAX_FIELDS = 256;
const MAX_PROJECTED_CELLS = 100_000;
const MAX_NUMBER_TOKENS = 100_000;
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const escapePointer = (value: string): string => value.replaceAll('~', '~0').replaceAll('/', '~1');
const object = (value: unknown): value is SourceObject =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof JsonNumberLexeme);
const text = (value: unknown, max = 256): value is string =>
  typeof value === 'string' &&
  Boolean(value.trim()) &&
  value.length <= max &&
  !/[\u0000-\u001f]/u.test(value);
const exactKeys = (value: SourceObject, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const utf8 = (value: string): boolean =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    new TextEncoder().encode(value)
  ) === value;
const refOrder = (
  a: InventoryBenchlingSourceReference,
  b: InventoryBenchlingSourceReference
): number => order(a.responseId, b.responseId) || order(a.pointer, b.pointer);

const commonFields = [
  'id',
  'name',
  'barcode',
  'parentStorageId',
  'schema',
  'archiveRecord',
  'createdAt',
  'creator',
  'modifiedAt',
  'projectId',
  'fields',
] as const;
const physicalFields: Record<InventoryBenchlingRecordKind, readonly string[]> = {
  location: [...commonFields, 'totalCapacity', 'occupiedCapacity', 'availableCapacity'],
  box: [...commonFields, 'totalCapacity', 'occupiedCapacity', 'availableCapacity'],
  plate: [
    ...commonFields,
    'type',
    'wells',
    'totalCapacity',
    'occupiedCapacity',
    'availableCapacity',
  ],
  container: [
    ...commonFields,
    'contents',
    'quantity',
    'volume',
    'parentStorageSchema',
    'checkoutRecord',
    'restrictionStatus',
    'restrictedSampleParties',
    'sampleOwners',
    'role',
    'gridPosition',
    'gridNumber',
  ],
  'box-schema': [
    'id',
    'name',
    'type',
    'containerSchema',
    'height',
    'width',
    'archiveRecord',
    'modifiedAt',
  ],
  'plate-schema': [
    'id',
    'name',
    'type',
    'plateType',
    'containerSchema',
    'height',
    'width',
    'archiveRecord',
    'modifiedAt',
  ],
};

function exactJson(value: ExactJsonValue): string {
  if (value instanceof JsonNumberLexeme) return value.lexeme;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(exactJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort(order)
    .map((key) => `${JSON.stringify(key)}:${exactJson(value[key])}`)
    .join(',')}}`;
}

function observed(
  value: SourceObject,
  field: string,
  reference: InventoryBenchlingSourceReference
): InventoryBenchlingObservedField {
  const at = {
    responseId: reference.responseId,
    pointer: `${reference.pointer}/${escapePointer(field)}`,
  };
  if (!Object.hasOwn(value, field)) return { ...at, kind: 'omitted' };
  if (value[field] === null) return { ...at, kind: 'null' };
  return { ...at, kind: 'present', jsonText: exactJson(value[field]) };
}

function mergeField(observations: InventoryBenchlingObservedField[]): InventoryBenchlingField {
  observations.sort(refOrder);
  const alternatives = new Map<string, { kind: 'null' } | { kind: 'present'; jsonText: string }>();
  for (const observation of observations) {
    if (observation.kind === 'omitted') continue;
    const value =
      observation.kind === 'null'
        ? { kind: 'null' as const }
        : { kind: 'present' as const, jsonText: observation.jsonText };
    alternatives.set(value.kind === 'null' ? 'null' : `present:${value.jsonText}`, value);
  }
  const values = [...alternatives].sort(([a], [b]) => order(a, b)).map(([, value]) => value);
  if (values.length === 0) return { kind: 'omitted', observations };
  if (values.length === 1) return { ...values[0], observations };
  return { kind: 'conflict', alternatives: values, observations };
}

function endpoint(
  path: string
): { kind: InventoryBenchlingRecordKind; sourceId: string; contents: boolean } | null {
  const match =
    /^\/api\/v2\/(locations|boxes|plates|containers|box-schemas|plate-schemas)\/([A-Za-z0-9_-]{1,256})(\/contents)?$/u.exec(
      path
    );
  if (!match || (match[3] && match[1] !== 'boxes')) return null;
  const kinds: Record<string, InventoryBenchlingRecordKind> = {
    locations: 'location',
    boxes: 'box',
    plates: 'plate',
    containers: 'container',
    'box-schemas': 'box-schema',
    'plate-schemas': 'plate-schema',
  };
  return { kind: kinds[match[1]], sourceId: match[2], contents: Boolean(match[3]) };
}

function pagination(
  pages: CapturedPage[],
  makeIssue: (
    code: string,
    reference: InventoryBenchlingSourceReference,
    message: string
  ) => InventoryBenchlingCaptureIssue
): InventoryBenchlingPagination[] {
  const families = new Map<string, CapturedPage[]>();
  for (const page of pages) {
    const query = Object.fromEntries(
      Object.entries(page.response.request.query)
        .filter(([key]) => key !== 'nextToken')
        .sort(([a], [b]) => order(a, b))
    );
    const key = JSON.stringify([page.response.request.path, query]);
    const family = families.get(key) ?? [];
    family.push(page);
    families.set(key, family);
  }
  return [...families]
    .sort(([a], [b]) => order(a, b))
    .map(([, family]) => {
      family.sort((a, b) => order(a.response.id, b.response.id));
      const query = Object.fromEntries(
        Object.entries(family[0].response.request.query)
          .filter(([key]) => key !== 'nextToken')
          .sort(([a], [b]) => order(a, b))
      );
      const byCursor = new Map<string, CapturedPage[]>();
      const issues: InventoryBenchlingCaptureIssue[] = [];
      let conflict = false;
      const add = (
        code: string,
        page: CapturedPage,
        pointer: string,
        message: string,
        isConflict = false
      ) => {
        conflict ||= isConflict;
        issues.push(makeIssue(code, { responseId: page.response.id, pointer }, message));
      };
      const pageFacts: InventoryBenchlingPaginationPage[] = family.map((page) => {
        const cursor = page.response.request.query.nextToken ?? '';
        const list = byCursor.get(cursor) ?? [];
        list.push(page);
        byCursor.set(cursor, list);
        const reference = { responseId: page.response.id, pointer: '' };
        const nextToken = observed(page.value, 'nextToken', reference);
        const containers = observed(page.value, 'containers', reference);
        if (typeof page.value.nextToken !== 'string')
          add(
            'BENCHLING_PAGE_NEXT_TOKEN_UNRESOLVED',
            page,
            '/nextToken',
            'An omitted, null or non-string nextToken does not establish the next page or termination.'
          );
        if (!Array.isArray(page.value.containers))
          add(
            'BENCHLING_PAGE_CONTENTS_UNRESOLVED',
            page,
            '/containers',
            'An omitted or null containers field does not establish an empty page.'
          );
        return {
          responseId: page.response.id,
          requestToken: cursor ? { kind: 'cursor', value: cursor } : { kind: 'initial' },
          nextToken,
          containers,
        };
      });
      for (const list of byCursor.values())
        if (list.length > 1)
          for (const page of list)
            add(
              'BENCHLING_PAGE_CURSOR_DUPLICATED',
              page,
              '',
              'More than one captured response uses the same request cursor in this query family.',
              true
            );
      if (!byCursor.has(''))
        add(
          'BENCHLING_PAGE_INITIAL_MISSING',
          family[0],
          '',
          'This query family has no captured initial request.'
        );
      for (const page of family) {
        const next = page.value.nextToken;
        if (typeof next === 'string' && next && !byCursor.has(next))
          add(
            'BENCHLING_PAGE_SUCCESSOR_MISSING',
            page,
            '/nextToken',
            'The nextToken identifies a page not captured in the same path and query family.'
          );
      }
      const linkedResponseIds: string[] = [];
      const reached = new Set<string>();
      let cursor = '';
      while (byCursor.get(cursor)?.length === 1) {
        const page = byCursor.get(cursor)![0];
        if (reached.has(page.response.id)) break;
        reached.add(page.response.id);
        linkedResponseIds.push(page.response.id);
        const next = page.value.nextToken;
        if (typeof next !== 'string' || !next) break;
        cursor = next;
      }
      for (const page of family)
        if (!reached.has(page.response.id))
          add(
            'BENCHLING_PAGE_ORPHANED',
            page,
            '',
            'This captured page is not uniquely reachable from the initial request in its query family.'
          );
      const settled = new Set<string>();
      for (const first of family) {
        if (settled.has(first.response.id)) continue;
        const walking = new Set<string>();
        let page: CapturedPage | undefined = first;
        while (page && !settled.has(page.response.id)) {
          if (walking.has(page.response.id)) {
            add(
              'BENCHLING_PAGE_CYCLE',
              page,
              '/nextToken',
              'Captured page tokens form a cycle.',
              true
            );
            break;
          }
          walking.add(page.response.id);
          const next: ExactJsonValue | undefined = page.value.nextToken;
          const candidates: CapturedPage[] | undefined =
            typeof next === 'string' && next ? byCursor.get(next) : undefined;
          page = candidates?.length === 1 ? candidates[0] : undefined;
        }
        for (const id of walking) settled.add(id);
      }
      issues.sort(
        (a, b) =>
          order(a.responseId ?? '', b.responseId ?? '') ||
          order(a.bodyPointer ?? '', b.bodyPointer ?? '') ||
          order(a.code, b.code)
      );
      return {
        path: family[0].response.request.path,
        query,
        kind: conflict ? 'conflict' : issues.length ? 'incomplete' : 'linked',
        pages: pageFacts,
        linkedResponseIds,
        issues,
      };
    });
}

export function inspectInventoryBenchlingCapture(
  sourceText: string,
  maxBytes: number
): InventoryBenchlingCaptureInspection {
  const issues: InventoryBenchlingCaptureIssue[] = [];
  const records = new Map<string, RecordGroup>();
  const placements: InventoryBenchlingPlacementObservation[] = [];
  const responses: InventoryBenchlingCapturedResponse[] = [];
  const pages: CapturedPage[] = [];
  let sourceSha256: InventoryBenchlingCaptureInspection['sourceSha256'] = null;
  let capture: InventoryBenchlingCapture | null = null;
  let observationCount = 0;
  let projectedCells = 0;
  let remainingNumberTokens = MAX_NUMBER_TOKENS;
  let projectionLimitIssue: InventoryBenchlingCaptureIssue | null = null;
  const add = (
    severity: InventoryBenchlingCaptureIssue['severity'],
    code: string,
    pointer: string,
    message: string,
    reference?: InventoryBenchlingSourceReference
  ): InventoryBenchlingCaptureIssue => {
    const issue = {
      severity,
      code,
      pointer,
      message,
      responseId: reference?.responseId ?? null,
      bodyPointer: reference?.pointer ?? null,
    };
    issues.push(issue);
    return issue;
  };
  const bodyIssue = (
    code: string,
    reference: InventoryBenchlingSourceReference,
    message: string,
    invalid = false
  ) => add(invalid ? 'invalid' : 'needs-resolution', code, '/responses', message, reference);
  const result = (): InventoryBenchlingCaptureInspection => {
    if (projectionLimitIssue)
      return {
        schema: 'dnaforge.inventory-benchling-capture-inspection.v1',
        kind: 'blocked',
        sourceSha256,
        capture: null,
        records: [],
        placements: [],
        pagination: [],
        issues: [projectionLimitIssue],
      };
    const projected: InventoryBenchlingRecord[] = [...records.values()]
      .sort((a, b) => order(a.kind, b.kind) || order(a.sourceId, b.sourceId))
      .map((group) => {
        group.observations.sort(refOrder);
        const fields = Object.fromEntries(
          [...group.fields].sort(order).map((key) => {
            const field = mergeField(
              group.observations.map((observation) => observed(observation.value, key, observation))
            );
            if (field.kind === 'conflict')
              bodyIssue(
                'BENCHLING_OBSERVATIONS_DIFFER',
                {
                  responseId: field.observations[0].responseId,
                  pointer: field.observations[0].pointer,
                },
                'Captured observations of this field differ. No response or page order selects a value.'
              );
            return [key, field];
          })
        );
        return {
          kind: group.kind,
          sourceId: group.sourceId,
          observations: group.observations.map(({ responseId, pointer }) => ({
            responseId,
            pointer,
          })),
          fields,
        };
      });
    placements.sort(
      (a, b) => order(a.containerId, b.containerId) || order(a.kind, b.kind) || refOrder(a, b)
    );
    const memberships = new Map<string, InventoryBenchlingPlacementObservation[]>();
    for (const placement of placements) {
      const list = memberships.get(placement.containerId) ?? [];
      list.push(placement);
      memberships.set(placement.containerId, list);
    }
    for (const [containerId, claims] of memberships) {
      const parents = new Set(
        claims.map((claim) => (claim.kind === 'box-position' ? claim.boxId : claim.plateId))
      );
      const owners = new Set(
        claims.map((claim) =>
          JSON.stringify([claim.kind, claim.kind === 'box-position' ? claim.boxId : claim.plateId])
        )
      );
      const positions = new Set(
        claims.flatMap((claim) => (claim.kind === 'plate-well' ? [claim.position] : []))
      );
      const gridPositions = new Set(
        claims.flatMap((claim) =>
          claim.kind === 'box-position' && claim.gridPosition.kind !== 'omitted'
            ? [
                claim.gridPosition.kind === 'null'
                  ? 'null'
                  : `present:${claim.gridPosition.jsonText}`,
              ]
            : []
        )
      );
      const gridNumbers = new Set(
        claims.flatMap((claim) =>
          claim.kind === 'box-position' && claim.gridNumber.kind !== 'omitted'
            ? [claim.gridNumber.kind === 'null' ? 'null' : `present:${claim.gridNumber.jsonText}`]
            : []
        )
      );
      if (owners.size > 1 || positions.size > 1 || gridPositions.size > 1 || gridNumbers.size > 1)
        bodyIssue(
          'BENCHLING_PLACEMENTS_DIFFER',
          claims[0],
          'The same container has differing captured parent or position claims. Every placement reference is retained; none is selected.'
        );
      const group = records.get(JSON.stringify(['container', containerId]));
      for (const observation of group?.observations ?? []) {
        if (!Object.hasOwn(observation.value, 'parentStorageId')) continue;
        const parent = observation.value.parentStorageId;
        if (typeof parent === 'string' && parents.size === 1 && parents.has(parent)) continue;
        bodyIssue(
          'BENCHLING_MEMBERSHIP_PARENT_DIFFERS',
          { responseId: observation.responseId, pointer: `${observation.pointer}/parentStorageId` },
          'An explicit captured parent value disagrees with the container membership evidence. Omitted parents remain omitted.'
        );
      }
    }
    const pageFacts = pagination(pages, bodyIssue);
    issues.sort(
      (a, b) =>
        order(a.responseId ?? '', b.responseId ?? '') ||
        order(a.bodyPointer ?? a.pointer, b.bodyPointer ?? b.pointer) ||
        order(a.code, b.code)
    );
    return {
      schema: 'dnaforge.inventory-benchling-capture-inspection.v1',
      kind: issues.some((issue) => issue.severity === 'invalid') ? 'blocked' : 'inspected',
      sourceSha256,
      capture,
      records: projected,
      placements,
      pagination: pageFacts,
      issues,
    };
  };
  const observeRecord = (
    kind: InventoryBenchlingRecordKind,
    sourceId: string,
    value: SourceObject,
    reference: InventoryBenchlingSourceReference
  ) => {
    if (projectionLimitIssue) return;
    observationCount += 1;
    const sourceFields = Object.keys(value);
    if (
      observationCount > MAX_OBSERVATIONS ||
      sourceFields.length > MAX_FIELDS ||
      sourceFields.some((field) => field.length > 512)
    ) {
      projectionLimitIssue = bodyIssue(
        'BENCHLING_OBSERVATION_LIMIT',
        reference,
        'The bounded capture supports at most 10000 observations, 256 fields per record and 512 characters per field name.',
        true
      );
      return;
    }
    const key = JSON.stringify([kind, sourceId]);
    const group = records.get(key) ?? {
      kind,
      sourceId,
      fields: new Set(physicalFields[kind]),
      observations: [],
    };
    const before = group.fields.size * group.observations.length;
    for (const field of sourceFields) group.fields.add(field);
    projectedCells += group.fields.size * (group.observations.length + 1) - before;
    if (group.fields.size > MAX_FIELDS || projectedCells > MAX_PROJECTED_CELLS) {
      projectionLimitIssue = bodyIssue(
        'BENCHLING_PROJECTION_LIMIT',
        reference,
        'Merged record fields exceed 256 or the complete projection exceeds 100000 field-observation cells. No partial inspection is returned.',
        true
      );
      return;
    }
    group.observations.push({ ...reference, value });
    records.set(key, group);
  };
  if (
    typeof sourceText !== 'string' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_CAPTURE_BYTES ||
    new TextEncoder().encode(sourceText).byteLength > maxBytes
  ) {
    add(
      'invalid',
      'BENCHLING_CAPTURE_SIZE_INVALID',
      '/sourceText',
      'The exact capture must fit the current inline transport limit, at most 17 MiB.'
    );
    return result();
  }
  sourceSha256 = inventoryTableSha256(sourceText);
  if (!utf8(sourceText)) {
    add(
      'invalid',
      'BENCHLING_CAPTURE_UTF8_INVALID',
      '/sourceText',
      'The exact capture requires valid UTF-8 text.'
    );
    return result();
  }
  let outer: ExactJsonValue;
  try {
    outer = parseUniqueJsonWithNumberLexemes(sourceText, {
      maxDepth: 8,
      maxNumbers: MAX_NUMBER_TOKENS,
    }).value;
  } catch (error) {
    add(
      'invalid',
      'BENCHLING_CAPTURE_JSON_INVALID',
      '/sourceText',
      error instanceof Error ? error.message : 'The capture is not valid unique-key JSON.'
    );
    return result();
  }
  if (
    !object(outer) ||
    !exactKeys(outer, ['format', 'apiVersion', 'namespace', 'capturedAt', 'scope', 'responses']) ||
    outer.format !== INVENTORY_BENCHLING_CAPTURE_FORMAT ||
    outer.apiVersion !== 'v2' ||
    !text(outer.namespace) ||
    !utf8(outer.namespace) ||
    typeof outer.capturedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(outer.capturedAt) ||
    !Number.isFinite(Date.parse(outer.capturedAt)) ||
    new Date(outer.capturedAt).toISOString() !== outer.capturedAt ||
    !object(outer.scope) ||
    !exactKeys(outer.scope, ['kind', 'description']) ||
    outer.scope.kind !== 'selected-records' ||
    !text(outer.scope.description, 2000) ||
    !Array.isArray(outer.responses) ||
    outer.responses.length < 1 ||
    outer.responses.length > MAX_RESPONSES
  ) {
    add(
      'invalid',
      'BENCHLING_CAPTURE_SHAPE_INVALID',
      '/sourceText',
      'Supply the versioned V2 selected-record capture, a namespace, exact UTC timestamp and 1–1024 captured responses.'
    );
    return result();
  }
  const responseIds = new Set<string>();
  for (const [index, raw] of outer.responses.entries()) {
    if (projectionLimitIssue) break;
    const pointer = `/responses/${index}`;
    if (
      !object(raw) ||
      !exactKeys(raw, ['id', 'request', 'bodyText']) ||
      !text(raw.id) ||
      !object(raw.request) ||
      !exactKeys(raw.request, ['method', 'path', 'query']) ||
      raw.request.method !== 'GET' ||
      typeof raw.request.path !== 'string' ||
      !object(raw.request.query) ||
      typeof raw.bodyText !== 'string'
    ) {
      add(
        'invalid',
        'BENCHLING_RESPONSE_SHAPE_INVALID',
        pointer,
        'A captured response requires a distinct ID, GET path/query and exact response body text.'
      );
      continue;
    }
    const reference = { responseId: raw.id, pointer: '' };
    if (responseIds.has(raw.id)) {
      add(
        'invalid',
        'BENCHLING_RESPONSE_ID_DUPLICATED',
        `${pointer}/id`,
        'Capture response IDs must be distinct from one another; they are not entity IDs.',
        reference
      );
      continue;
    }
    responseIds.add(raw.id);
    const route = endpoint(raw.request.path);
    if (!route) {
      add(
        'invalid',
        'BENCHLING_ENDPOINT_UNSUPPORTED',
        `${pointer}/request/path`,
        'Only the documented V2 physical item/schema GET paths and box contents paths are supported.',
        reference
      );
      continue;
    }
    const allowedQuery = route.contents ? ['returning', 'pageSize', 'nextToken'] : ['returning'];
    if (
      Object.entries(raw.request.query).some(
        ([key, value]) =>
          !allowedQuery.includes(key) ||
          typeof value !== 'string' ||
          value.length > 8192 ||
          /[\u0000-\u001f]/u.test(value) ||
          (key === 'pageSize' && !/^(?:[1-9]|[1-9]\d|100)$/u.test(value))
      )
    ) {
      add(
        'invalid',
        'BENCHLING_QUERY_UNSUPPORTED',
        `${pointer}/request/query`,
        'Retain only documented returning, pageSize and pagination query fields; authentication and arbitrary query fields are not capture inputs.',
        reference
      );
      continue;
    }
    if (!utf8(raw.bodyText)) {
      add(
        'invalid',
        'BENCHLING_BODY_UTF8_INVALID',
        `${pointer}/bodyText`,
        'Each retained response body requires valid UTF-8 text.',
        reference
      );
      continue;
    }
    let body: ReturnType<typeof parseUniqueJsonWithNumberLexemes>;
    try {
      body = parseUniqueJsonWithNumberLexemes(raw.bodyText, {
        maxDepth: 32,
        maxNumbers: remainingNumberTokens,
      });
      remainingNumberTokens -= body.numberLexemes.size;
    } catch (error) {
      if (error instanceof Error && error.message === UNIQUE_JSON_NUMBER_LIMIT_MESSAGE) {
        projectionLimitIssue = add(
          'invalid',
          'BENCHLING_NUMBER_LIMIT',
          `${pointer}/bodyText`,
          'The complete capture exceeds 100000 numeric tokens. No partial inspection is returned.',
          reference
        );
        return result();
      }
      add(
        'invalid',
        'BENCHLING_BODY_JSON_INVALID',
        `${pointer}/bodyText`,
        error instanceof Error ? error.message : 'The response body is not valid unique-key JSON.',
        reference
      );
      continue;
    }
    if (!object(body.value)) {
      bodyIssue(
        'BENCHLING_BODY_SHAPE_INVALID',
        reference,
        'The documented physical response body is an object.',
        true
      );
      continue;
    }
    const response: InventoryBenchlingCapturedResponse = {
      id: raw.id,
      request: {
        method: 'GET',
        path: raw.request.path,
        query: Object.fromEntries(
          Object.entries(raw.request.query).sort(([a], [b]) => order(a, b))
        ) as Record<string, string>,
      },
      bodyText: raw.bodyText,
      bodySha256: inventoryTableSha256(raw.bodyText),
      numberLexemes: [...body.numberLexemes]
        .sort(([a], [b]) => order(a, b))
        .map(([pointer, lexeme]) => ({ pointer, lexeme })),
    };
    responses.push(response);
    const value = body.value;
    if (route.contents) {
      pages.push({ response, value });
      if (
        Object.hasOwn(value, 'containers') &&
        value.containers !== null &&
        !Array.isArray(value.containers)
      ) {
        bodyIssue(
          'BENCHLING_BOX_CONTENTS_INVALID',
          { responseId: raw.id, pointer: '/containers' },
          'Captured containers must be an array when present and non-null.',
          true
        );
        continue;
      }
      if (Array.isArray(value.containers))
        for (const [rowIndex, container] of value.containers.entries()) {
          if (projectionLimitIssue) break;
          const at = { responseId: raw.id, pointer: `/containers/${rowIndex}` };
          if (!object(container) || !text(container.id)) {
            bodyIssue(
              'BENCHLING_CONTAINER_ID_UNRESOLVED',
              at,
              'A captured box member without an accessible string ID cannot acquire a physical identity.'
            );
            continue;
          }
          observeRecord('container', container.id, container, at);
          placements.push({
            ...at,
            kind: 'box-position',
            containerId: container.id,
            boxId: route.sourceId,
            gridPosition: observed(container, 'gridPosition', at),
            gridNumber: observed(container, 'gridNumber', at),
          });
        }
      continue;
    }
    if (Object.hasOwn(value, 'id') && value.id !== route.sourceId) {
      bodyIssue(
        'BENCHLING_RESPONSE_ID_MISMATCH',
        { responseId: raw.id, pointer: '/id' },
        'The captured response ID must exactly match the requested source item ID.',
        true
      );
      continue;
    }
    if (!Object.hasOwn(value, 'id'))
      bodyIssue(
        'BENCHLING_RESPONSE_ID_OMITTED',
        { responseId: raw.id, pointer: '/id' },
        'The request names an item, but its captured response omits ID confirmation.'
      );
    observeRecord(route.kind, route.sourceId, value, reference);
    if (route.kind === 'plate' && Object.hasOwn(value, 'wells')) {
      if (!object(value.wells)) {
        bodyIssue(
          'BENCHLING_PLATE_WELLS_UNRESOLVED',
          { responseId: raw.id, pointer: '/wells' },
          'An absent, null or unsupported wells value cannot establish empty or occupied wells.'
        );
        continue;
      }
      for (const [position, well] of Object.entries(value.wells)) {
        if (projectionLimitIssue) break;
        if (position.length > 512) {
          projectionLimitIssue = bodyIssue(
            'BENCHLING_POSITION_LIMIT',
            { responseId: raw.id, pointer: '/wells' },
            'Source well position keys are limited to 512 characters.',
            true
          );
          break;
        }
        const at = { responseId: raw.id, pointer: `/wells/${escapePointer(position)}` };
        if (!object(well) || !text(well.id)) {
          bodyIssue(
            'BENCHLING_WELL_ID_UNRESOLVED',
            at,
            'An inaccessible or unidentified well remains raw source evidence; no container identity is invented.'
          );
          continue;
        }
        observeRecord('container', well.id, well, at);
        placements.push({
          ...at,
          kind: 'plate-well',
          containerId: well.id,
          plateId: route.sourceId,
          position,
        });
      }
    }
  }
  capture = {
    format: INVENTORY_BENCHLING_CAPTURE_FORMAT,
    apiVersion: 'v2',
    namespace: outer.namespace,
    capturedAt: outer.capturedAt,
    scope: { kind: 'selected-records', description: outer.scope.description },
    responses: responses.sort((a, b) => order(a.id, b.id)),
    sourceText,
  };
  const inspected = result();
  if (new TextEncoder().encode(JSON.stringify(inspected)).byteLength > maxBytes) {
    return {
      schema: inspected.schema,
      kind: 'blocked',
      sourceSha256,
      capture: null,
      records: [],
      placements: [],
      pagination: [],
      issues: [
        {
          severity: 'invalid',
          code: 'BENCHLING_INSPECTION_TOO_LARGE',
          pointer: '/sourceText',
          responseId: null,
          bodyPointer: null,
          message:
            'The complete inspection exceeds the current inline transport byte limit. Use a smaller explicitly selected capture; no automatic splitting occurs.',
        },
      ],
    };
  }
  return inspected;
}
