import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectInventoryBenchlingCapture } from './inventory-benchling-source';
import type { InventoryBenchlingCaptureInspection } from './inventory-benchling-types';

const maxBytes = 17 * 1024 * 1024;
const fixture = readFileSync(
  new URL(
    '../../../../test-fixtures/lims-import/benchling-physical/representative-capture.json',
    import.meta.url
  ),
  'utf8'
);
const response = (
  id: string,
  path: string,
  bodyText: string,
  query: Record<string, string> = {}
) => ({
  id,
  request: { method: 'GET', path, query },
  bodyText,
});
const capture = (
  responses = [response('one', '/api/v2/containers/con_one', '{"id":"con_one"}')]
) => ({
  format: 'dnaforge.benchling-physical-capture.v1',
  apiVersion: 'v2',
  namespace: 'benchling:synthetic',
  capturedAt: '2026-11-16T23:00:00.000Z',
  scope: { kind: 'selected-records', description: 'Synthetic selected records only.' },
  responses,
});
const inspect = (responses?: ReturnType<typeof response>[]) =>
  inspectInventoryBenchlingCapture(JSON.stringify(capture(responses)), maxBytes);
const record = (result: InventoryBenchlingCaptureInspection, sourceId: string) => {
  const found = result.records.find((row) => row.sourceId === sourceId);
  expect(found).toBeDefined();
  return found!;
};
const codes = (result: InventoryBenchlingCaptureInspection) =>
  result.issues.map((issue) => issue.code);
const page = (
  id: string,
  cursor: string | null,
  next: unknown = '',
  extra: Record<string, string> = {}
) =>
  response(
    id,
    '/api/v2/boxes/box_one/contents',
    JSON.stringify({ containers: [], nextToken: next }),
    {
      ...extra,
      ...(cursor === null ? {} : { nextToken: cursor }),
    }
  );

describe('Benchling physical capture source inspection', () => {
  it('retains the exact synthetic wrapper and response bodies while exposing physical observations', () => {
    const result = inspectInventoryBenchlingCapture(fixture, maxBytes);
    expect(result.kind).toBe('inspected');
    expect(result.capture?.sourceText).toBe(fixture);
    expect(result.capture?.responses).toHaveLength(12);
    expect(result.capture?.scope.kind).toBe('selected-records');
    expect(result.sourceSha256).toBe(
      'sha256:d6e5539beb9bebd4453d5cf22a97b442c4fb9ea053a4b3691a85af7224a403bb'
    );
    expect(record(result, 'plt_fixed').fields.type).toMatchObject({
      kind: 'present',
      jsonText: '"well_plate"',
    });
    expect(record(result, 'plt_matrix').fields.type).toMatchObject({
      kind: 'present',
      jsonText: '"matrix_plate"',
    });
    expect(result.pagination).toMatchObject([
      { kind: 'linked', linkedResponseIds: ['box-page-1', 'box-page-2'] },
    ]);
    expect(record(result, 'con_empty').fields.contents).toMatchObject({
      kind: 'present',
      jsonText: '[]',
    });
    expect(record(result, 'con_filled').fields.quantity.kind).toBe('conflict');
    expect(record(result, 'con_multiple').fields.contents).toMatchObject({
      kind: 'present',
      jsonText:
        '[{"entity":{"entityType":"dna_sequence","id":"seq_A"}},{"entity":{"entityType":"dna_sequence","id":"seq_B"}}]',
    });
    expect(record(result, 'con_filled').fields.checkoutRecord).toMatchObject({ kind: 'present' });
    expect(result).not.toHaveProperty('commands');
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    const original = JSON.parse(fixture) as ReturnType<typeof capture>;
    for (const item of result.capture!.responses)
      expect(item.bodyText).toBe(original.responses.find((row) => row.id === item.id)?.bodyText);
  });

  it('preserves unsafe integers, signed zero, decimals and huge exponents before any conversion', () => {
    const result = inspect([
      response(
        'one',
        '/api/v2/containers/con_one',
        '{"id":"con_one","quantity":{"value":9007199254740993,"units":"cells"},"volume":{"value":1.2300e+2,"units":"mg"},"extra":{"a/b~c":[-0,1e400]}}'
      ),
    ]);
    expect(result.kind).toBe('inspected');
    expect(result.capture?.responses[0].numberLexemes).toEqual([
      { pointer: '/extra/a~1b~0c/0', lexeme: '-0' },
      { pointer: '/extra/a~1b~0c/1', lexeme: '1e400' },
      { pointer: '/quantity/value', lexeme: '9007199254740993' },
      { pointer: '/volume/value', lexeme: '1.2300e+2' },
    ]);
    expect(record(result, 'con_one').fields.quantity).toMatchObject({
      kind: 'present',
      jsonText: '{"units":"cells","value":9007199254740993}',
    });
    expect(record(result, 'con_one').fields.extra).toMatchObject({
      kind: 'present',
      jsonText: '{"a/b~c":[-0,1e400]}',
    });
  });

  it('distinguishes fields omitted everywhere from null, zero and empty contents', () => {
    const result = inspect([
      response(
        'one',
        '/api/v2/containers/con_one',
        '{"id":"con_one","quantity":{"value":0,"units":null},"contents":[],"parentStorageId":null}'
      ),
    ]);
    const fields = record(result, 'con_one').fields;
    expect(fields.parentStorageId).toMatchObject({
      kind: 'null',
      observations: [{ kind: 'null', pointer: '/parentStorageId' }],
    });
    expect(fields.quantity).toMatchObject({
      kind: 'present',
      jsonText: '{"units":null,"value":0}',
    });
    expect(fields.contents).toMatchObject({ kind: 'present', jsonText: '[]' });
    expect(fields.volume).toMatchObject({
      kind: 'omitted',
      observations: [{ kind: 'omitted', pointer: '/volume' }],
    });
    expect(fields.gridPosition.kind).toBe('omitted');
  });

  it('keeps omitted observations when another response supplies a value', () => {
    const result = inspect([
      response('partial', '/api/v2/containers/con_one', '{"id":"con_one"}'),
      response(
        'full',
        '/api/v2/containers/con_one',
        '{"id":"con_one","parentStorageId":"box_one"}'
      ),
    ]);
    expect(record(result, 'con_one').fields.parentStorageId).toEqual({
      kind: 'present',
      jsonText: '"box_one"',
      observations: [
        { kind: 'present', responseId: 'full', pointer: '/parentStorageId', jsonText: '"box_one"' },
        { kind: 'omitted', responseId: 'partial', pointer: '/parentStorageId' },
      ],
    });
  });

  it('does not choose between null and present or between numerically different source tokens', () => {
    const result = inspect([
      response(
        'a',
        '/api/v2/containers/con_one',
        '{"id":"con_one","parentStorageId":null,"quantity":{"value":1.0}}'
      ),
      response(
        'b',
        '/api/v2/containers/con_one',
        '{"id":"con_one","parentStorageId":"box_one","quantity":{"value":1}}'
      ),
    ]);
    expect(record(result, 'con_one').fields.parentStorageId.kind).toBe('conflict');
    expect(record(result, 'con_one').fields.quantity.kind).toBe('conflict');
    expect(
      result.issues.filter((issue) => issue.code === 'BENCHLING_OBSERVATIONS_DIFFER')
    ).toHaveLength(2);
    expect(result.issues.every((issue) => issue.severity === 'needs-resolution')).toBe(true);
  });

  it('canonicalizes object property order without rounding source numeric tokens', () => {
    const result = inspect([
      response(
        'a',
        '/api/v2/containers/con_one',
        '{"id":"con_one","quantity":{"value":1.2300,"units":"uL"}}'
      ),
      response(
        'b',
        '/api/v2/containers/con_one',
        '{"quantity":{"units":"uL","value":1.2300},"id":"con_one"}'
      ),
    ]);
    expect(record(result, 'con_one').fields.quantity.kind).toBe('present');
    expect(result.issues).toEqual([]);
  });

  it('derives kind from the endpoint and checks the exact body ID without a prefix heuristic', () => {
    const result = inspect([
      response('capture-id', '/api/v2/containers/loc_unusual', '{"id":"loc_unusual"}'),
    ]);
    expect(result.records[0]).toMatchObject({ kind: 'container', sourceId: 'loc_unusual' });
    expect(result.records[0].observations).toEqual([{ responseId: 'capture-id', pointer: '' }]);
    expect(
      codes(inspect([response('a', '/api/v2/containers/con_one', '{"id":"con_two"}')]))
    ).toContain('BENCHLING_RESPONSE_ID_MISMATCH');
    const missing = inspect([
      response('a', '/api/v2/containers/con_one', '{"name":"Partial response"}'),
    ]);
    expect(missing.kind).toBe('inspected');
    expect(codes(missing)).toContain('BENCHLING_RESPONSE_ID_OMITTED');
    expect(record(missing, 'con_one').fields.id.kind).toBe('omitted');
  });

  it('discovers direct well objects with exact plate keys and retains inaccessible entries', () => {
    const result = inspect([
      response(
        'plate',
        '/api/v2/plates/plt_one',
        '{"id":"plt_one","type":"well_plate","wells":{"A/1~":{"id":"con_well","contents":[]},"B1":{},"B2":null}}'
      ),
    ]);
    expect(result.placements).toEqual([
      {
        kind: 'plate-well',
        responseId: 'plate',
        pointer: '/wells/A~11~0',
        containerId: 'con_well',
        plateId: 'plt_one',
        position: 'A/1~',
      },
    ]);
    expect(record(result, 'con_well').fields.quantity).toMatchObject({
      kind: 'omitted',
      observations: [{ pointer: '/wells/A~11~0/quantity' }],
    });
    expect(codes(result).filter((code) => code === 'BENCHLING_WELL_ID_UNRESOLVED')).toHaveLength(2);
    expect(record(result, 'plt_one').fields.wells.kind).toBe('present');
  });

  it('keeps box membership, grid number and grid position as separate observations', () => {
    const result = inspect([
      response(
        'box',
        '/api/v2/boxes/box_one/contents',
        '{"containers":[{"id":"con_one","gridPosition":"A01","gridNumber":1.00}],"nextToken":""}'
      ),
    ]);
    expect(result.placements).toMatchObject([
      {
        kind: 'box-position',
        containerId: 'con_one',
        boxId: 'box_one',
        gridPosition: { kind: 'present', jsonText: '"A01"' },
        gridNumber: { kind: 'present', jsonText: '1.00' },
      },
    ]);
    expect(record(result, 'con_one').fields.parentStorageId.kind).toBe('omitted');
    expect(result.pagination[0].kind).toBe('linked');
  });

  it('does not invent grid placement from a generic container parent', () => {
    const result = inspect([
      response('a', '/api/v2/containers/con_one', '{"id":"con_one","parentStorageId":"box_one"}'),
    ]);
    expect(result.placements).toEqual([]);
    expect(record(result, 'con_one').fields.gridPosition.kind).toBe('omitted');
  });

  it('surfaces the same container claimed in two plate wells even with identical container facts', () => {
    const result = inspect([
      response(
        'plate',
        '/api/v2/plates/plt_one',
        '{"id":"plt_one","wells":{"A1":{"id":"con_one"},"A2":{"id":"con_one"}}}'
      ),
    ]);
    expect(record(result, 'con_one').fields.id.kind).toBe('present');
    expect(codes(result)).toContain('BENCHLING_PLACEMENTS_DIFFER');
    expect(result.placements).toHaveLength(2);
    expect(result.placements.map((claim) => claim.kind === 'plate-well' && claim.position)).toEqual(
      ['A1', 'A2']
    );
  });

  it('surfaces distinct captured box memberships and positions without selecting a location', () => {
    const result = inspect([
      response(
        'box-a',
        '/api/v2/boxes/box_a/contents',
        '{"containers":[{"id":"con_one","gridPosition":"A1"}],"nextToken":""}'
      ),
      response(
        'box-b',
        '/api/v2/boxes/box_b/contents',
        '{"containers":[{"id":"con_one","gridPosition":"A2"}],"nextToken":""}'
      ),
    ]);
    expect(codes(result)).toContain('BENCHLING_PLACEMENTS_DIFFER');
    expect(result.placements).toHaveLength(2);
    expect(record(result, 'con_one').fields.parentStorageId.kind).toBe('omitted');
  });

  it.each([null, 'loc_other'])(
    'surfaces explicit parent %s disagreement with box membership',
    (parent) => {
      const result = inspect([
        response(
          'box',
          '/api/v2/boxes/box_one/contents',
          '{"containers":[{"id":"con_one","gridPosition":"A1"}],"nextToken":""}'
        ),
        response(
          'item',
          '/api/v2/containers/con_one',
          JSON.stringify({ id: 'con_one', parentStorageId: parent })
        ),
      ]);
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: 'BENCHLING_MEMBERSHIP_PARENT_DIFFERS',
          responseId: 'item',
          bodyPointer: '/parentStorageId',
        })
      );
      expect(result.placements).toHaveLength(1);
    }
  );

  it('does not call an omitted parent contradictory or erase it through matching membership', () => {
    const result = inspect([
      response(
        'box',
        '/api/v2/boxes/box_one/contents',
        '{"containers":[{"id":"con_one","gridPosition":"A1"}],"nextToken":""}'
      ),
      response(
        'item',
        '/api/v2/containers/con_one',
        '{"id":"con_one","parentStorageId":"box_one"}'
      ),
    ]);
    expect(codes(result)).not.toContain('BENCHLING_MEMBERSHIP_PARENT_DIFFERS');
    expect(record(result, 'con_one').fields.parentStorageId.observations).toContainEqual({
      kind: 'omitted',
      responseId: 'box',
      pointer: '/containers/0/parentStorageId',
    });
  });

  it('does not infer layout, thermal control or qualification from freezer and plate names', () => {
    const result = inspect([
      response(
        'a',
        '/api/v2/locations/loc_one',
        '{"id":"loc_one","name":"-80 96-well freezer","totalCapacity":null}'
      ),
    ]);
    expect(record(result, 'loc_one').fields.totalCapacity.kind).toBe('null');
    expect(result).not.toHaveProperty('layout');
    expect(result).not.toHaveProperty('thermalControl');
    expect(result).not.toHaveProperty('authority');
  });

  it('retains an own __proto__ field without changing object prototypes', () => {
    const result = inspect([
      response('a', '/api/v2/containers/con_one', '{"id":"con_one","__proto__":{"polluted":true}}'),
    ]);
    expect(Object.hasOwn(record(result, 'con_one').fields, '__proto__')).toBe(true);
    expect(record(result, 'con_one').fields.__proto__).toMatchObject({
      kind: 'present',
      jsonText: '{"polluted":true}',
    });
    expect({}).not.toHaveProperty('polluted');
  });

  it('makes record, field, page and issue projections independent of response order', () => {
    const parsed = JSON.parse(fixture) as ReturnType<typeof capture>;
    const a = inspectInventoryBenchlingCapture(fixture, maxBytes);
    const b = inspectInventoryBenchlingCapture(
      JSON.stringify({ ...parsed, responses: [...parsed.responses].reverse() }),
      maxBytes
    );
    expect(b.sourceSha256).not.toBe(a.sourceSha256);
    expect(b.records).toEqual(a.records);
    expect(b.placements).toEqual(a.placements);
    expect(b.pagination).toEqual(a.pagination);
    expect(b.issues).toEqual(a.issues);
  });

  it.each([
    '/api/v3/containers/con_one',
    '/api/v2/containers',
    '/api/v2/schemas/box-schemas/schema_one',
    '/api/v2/containers/con_one/contents',
    '/api/v2/containers/con_one?returning=id',
    'https://example.benchling.com/api/v2/containers/con_one',
    '/api/v2/containers/%63on_one',
  ])('refuses an unsupported or non-relative endpoint %s', (path) => {
    const result = inspect([response('a', path, '{"id":"con_one"}')]);
    expect(result.kind).toBe('blocked');
    expect(codes(result)).toContain('BENCHLING_ENDPOINT_UNSUPPORTED');
    expect(result.records).toEqual([]);
  });

  it.each(['box-schemas', 'plate-schemas'])('supports the documented %s path', (resource) => {
    const result = inspect([
      response('a', `/api/v2/${resource}/sch_one`, '{"id":"sch_one","height":2,"width":3}'),
    ]);
    expect(result.kind).toBe('inspected');
    expect(result.records[0].kind).toBe(resource === 'box-schemas' ? 'box-schema' : 'plate-schema');
  });

  it.each([
    { api_key: 'not-a-real-secret' },
    { Authorization: 'not-a-real-secret' },
    { nextToken: 'not-allowed-on-item-get' },
    { returning: 'id\nname' },
  ] as Record<string, string>[])('refuses unsupported/authentication query fields', (query) => {
    expect(
      codes(inspect([response('a', '/api/v2/containers/con_one', '{"id":"con_one"}', query)]))
    ).toContain('BENCHLING_QUERY_UNSUPPORTED');
  });

  it.each(['0', '101', '01', '1.0', '-1'])('refuses noncanonical box pageSize %s', (pageSize) => {
    expect(codes(inspect([page('a', null, '', { pageSize })]))).toContain(
      'BENCHLING_QUERY_UNSUPPORTED'
    );
  });

  it('refuses duplicate decoded keys in the wrapper and in exact response bodies', () => {
    const wrapper = JSON.stringify(capture()).replace(
      '"apiVersion":"v2"',
      '"apiVersion":"v2","apiVersion":"v2"'
    );
    expect(codes(inspectInventoryBenchlingCapture(wrapper, maxBytes))).toContain(
      'BENCHLING_CAPTURE_JSON_INVALID'
    );
    const result = inspect([
      response(
        'a',
        '/api/v2/containers/con_one',
        '{"id":"con_one","quantity":{"value":1,"\\u0076alue":2}}'
      ),
    ]);
    expect(codes(result)).toContain('BENCHLING_BODY_JSON_INVALID');
  });

  it('refuses duplicate response IDs even when their bodies are identical', () => {
    const result = inspect([
      response('a', '/api/v2/containers/con_one', '{"id":"con_one"}'),
      response('a', '/api/v2/containers/con_one', '{"id":"con_one"}'),
    ]);
    expect(result.kind).toBe('blocked');
    expect(codes(result)).toContain('BENCHLING_RESPONSE_ID_DUPLICATED');
  });

  it.each(['[]', 'null', '1', '{"id":"con_one",}', '{"id":"con_one","v":NaN}'])(
    'refuses non-object or malformed response %s',
    (body) => {
      expect(inspect([response('a', '/api/v2/containers/con_one', body)]).kind).toBe('blocked');
    }
  );

  it('refuses excess nesting before projecting source records', () => {
    const body = `{"id":"con_one","x":${'['.repeat(40)}0${']'.repeat(40)}}`;
    expect(codes(inspect([response('a', '/api/v2/containers/con_one', body)]))).toContain(
      'BENCHLING_BODY_JSON_INVALID'
    );
  });

  it('refuses invalid UTF-8 source text and decoded body text', () => {
    const malformed = `${JSON.stringify(capture())}\ud800`;
    expect(codes(inspectInventoryBenchlingCapture(malformed, maxBytes))).toContain(
      'BENCHLING_CAPTURE_UTF8_INVALID'
    );
    expect(codes(inspect([response('a', '/api/v2/containers/con_one', '\ud800')]))).toContain(
      'BENCHLING_BODY_UTF8_INVALID'
    );
  });

  it('refuses unknown wrapper keys and a claimed tenant-wide completeness scope', () => {
    const a = { ...capture(), authorization: 'not-a-real-secret' };
    const b = { ...capture(), scope: { kind: 'whole-tenant', description: 'Unproved claim' } };
    expect(inspectInventoryBenchlingCapture(JSON.stringify(a), maxBytes).kind).toBe('blocked');
    expect(inspectInventoryBenchlingCapture(JSON.stringify(b), maxBytes).kind).toBe('blocked');
  });

  it('refuses invalid timestamps and unsupported versions', () => {
    for (const patch of [
      { capturedAt: '2026-02-30T00:00:00.000Z' },
      { capturedAt: '2026-11-16T23:00:00Z' },
      { apiVersion: 'v3' },
      { format: 'benchling-csv' },
    ])
      expect(
        inspectInventoryBenchlingCapture(JSON.stringify({ ...capture(), ...patch }), maxBytes).kind
      ).toBe('blocked');
  });

  it('enforces input and amplified output byte limits without returning partial source records', () => {
    const source = JSON.stringify(capture());
    expect(codes(inspectInventoryBenchlingCapture(source, source.length - 1))).toContain(
      'BENCHLING_CAPTURE_SIZE_INVALID'
    );
    const output = inspectInventoryBenchlingCapture(source, source.length + 1);
    expect(codes(output)).toEqual(['BENCHLING_INSPECTION_TOO_LARGE']);
    expect(output.capture).toBeNull();
    expect(output.records).toEqual([]);
    expect(codes(inspectInventoryBenchlingCapture(source, maxBytes + 1))).toContain(
      'BENCHLING_CAPTURE_SIZE_INVALID'
    );
  });

  it('bounds unioned fields before expanding disjoint repeated observations', () => {
    const parts = Array.from({ length: 3 }, (_, n) =>
      response(
        `r${n}`,
        '/api/v2/containers/con_one',
        JSON.stringify({
          id: 'con_one',
          ...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`extra-${n}-${i}`, i])),
        })
      )
    );
    const result = inspect(parts);
    expect(codes(result)).toEqual(['BENCHLING_PROJECTION_LIMIT']);
    expect(result.records).toEqual([]);
    expect(result.capture).toBeNull();
  });

  it('bounds field-observation cells before projecting repeated source snapshots', () => {
    const body = JSON.stringify({
      containers: Array.from({ length: 5000 }, () => ({ id: 'con_one' })),
      nextToken: '',
    });
    const result = inspect([response('a', '/api/v2/boxes/box_one/contents', body)]);
    expect(codes(result)).toEqual(['BENCHLING_PROJECTION_LIMIT']);
    expect(result.records).toEqual([]);
    expect(result.placements).toEqual([]);
  });

  it('bounds source field names and plate position keys before pointer fanout', () => {
    const field = inspect([
      response(
        'a',
        '/api/v2/containers/con_one',
        JSON.stringify({ id: 'con_one', ['x'.repeat(513)]: 1 })
      ),
    ]);
    expect(codes(field)).toEqual(['BENCHLING_OBSERVATION_LIMIT']);
    const well = inspect([
      response(
        'a',
        '/api/v2/plates/plt_one',
        JSON.stringify({ id: 'plt_one', wells: { ['x'.repeat(513)]: { id: 'con_one' } } })
      ),
    ]);
    expect(codes(well)).toEqual(['BENCHLING_POSITION_LIMIT']);
    expect(well.records).toEqual([]);
  });

  it('bounds numeric token allocation before projecting a single large numeric array', () => {
    const body = `{"id":"con_one","rawNumbers":[${Array(100_001).fill('0').join(',')}]}`;
    const result = inspect([
      response('valid-first', '/api/v2/containers/con_first', '{"id":"con_first"}'),
      response('excess-numbers', '/api/v2/containers/con_one', body),
    ]);
    expect(result.kind).toBe('blocked');
    expect(result.capture).toBeNull();
    expect(result.records).toEqual([]);
    expect(result.placements).toEqual([]);
    expect(result.pagination).toEqual([]);
    expect(result.issues).toEqual([
      {
        severity: 'invalid',
        code: 'BENCHLING_NUMBER_LIMIT',
        pointer: '/responses/1/bodyText',
        responseId: 'excess-numbers',
        bodyPointer: '',
        message:
          'The complete capture exceeds 100000 numeric tokens. No partial inspection is returned.',
      },
    ]);
  });

  it('shares the numeric token budget across captured response pages', () => {
    const numericPage = (count: number, next: string) =>
      `{"containers":[],"nextToken":${JSON.stringify(next)},"rawNumbers":[${Array(count).fill('0').join(',')}]}`;
    const result = inspect([
      response('first', '/api/v2/boxes/box_one/contents', numericPage(60_000, 'next')),
      response('second', '/api/v2/boxes/box_one/contents', numericPage(40_001, ''), {
        nextToken: 'next',
      }),
      response('must-not-project', '/api/v2/containers/con_one', '{"id":"con_one"}'),
    ]);
    expect(codes(result)).toEqual(['BENCHLING_NUMBER_LIMIT']);
    expect(result.issues[0].responseId).toBe('second');
    expect(result.capture).toBeNull();
    expect(result.records).toEqual([]);
    expect(result.pagination).toEqual([]);
  });

  it('accepts exactly the aggregate numeric budget and a later response containing no numbers', () => {
    const numericBody = (id: string, count: number) =>
      `{"id":${JSON.stringify(id)},"rawNumbers":[${Array(count).fill('0').join(',')}]}`;
    const result = inspect([
      response('first', '/api/v2/containers/con_first', numericBody('con_first', 60_000)),
      response('second', '/api/v2/containers/con_second', numericBody('con_second', 40_000)),
      response('strings-after-budget', '/api/v2/containers/con_one', '{"id":"con_one"}'),
    ]);
    expect(result.kind).toBe('inspected');
    expect(
      result.capture?.responses.reduce((sum, item) => sum + item.numberLexemes.length, 0)
    ).toBe(100_000);
    expect(result.records).toHaveLength(3);
    expect(result.issues).toEqual([]);
  });
});

describe('Benchling captured page linkage', () => {
  it('links exactly one captured initial request to documented empty-string termination', () => {
    const result = inspect([page('second', 'a', ''), page('first', null, 'a')]);
    expect(result.pagination).toMatchObject([
      { kind: 'linked', linkedResponseIds: ['first', 'second'] },
    ]);
    expect(result.issues).toEqual([]);
  });

  it('distinguishes missing, null and present terminal nextToken', () => {
    const missing = inspect([response('a', '/api/v2/boxes/box_one/contents', '{"containers":[]}')]);
    const nulled = inspect([page('a', null, null)]);
    const terminal = inspect([page('a', null, '')]);
    expect(missing.pagination[0]).toMatchObject({
      kind: 'incomplete',
      pages: [{ nextToken: { kind: 'omitted' } }],
    });
    expect(nulled.pagination[0]).toMatchObject({
      kind: 'incomplete',
      pages: [{ nextToken: { kind: 'null' } }],
    });
    expect(terminal.pagination[0]).toMatchObject({
      kind: 'linked',
      pages: [{ nextToken: { kind: 'present', jsonText: '""' } }],
    });
  });

  it('does not read omitted or null contents as an empty terminal page', () => {
    for (const body of ['{"nextToken":""}', '{"containers":null,"nextToken":""}']) {
      const result = inspect([response('a', '/api/v2/boxes/box_one/contents', body)]);
      expect(result.pagination[0].kind).toBe('incomplete');
      expect(codes(result)).toContain('BENCHLING_PAGE_CONTENTS_UNRESOLVED');
    }
  });

  it('reports a missing successor instead of claiming linked completion', () => {
    const result = inspect([page('first', null, 'missing')]);
    expect(result.pagination[0].kind).toBe('incomplete');
    expect(codes(result)).toContain('BENCHLING_PAGE_SUCCESSOR_MISSING');
  });

  it('reports duplicate cursor responses without choosing a winner', () => {
    const result = inspect([
      page('first', null, 'a'),
      page('second', 'a', ''),
      page('duplicate', 'a', ''),
    ]);
    expect(result.pagination[0].kind).toBe('conflict');
    expect(result.pagination[0].linkedResponseIds).toEqual(['first']);
    expect(codes(result)).toContain('BENCHLING_PAGE_CURSOR_DUPLICATED');
  });

  it('reports missing initial and orphaned pages', () => {
    const result = inspect([page('orphan', 'a', '')]);
    expect(codes(result)).toContain('BENCHLING_PAGE_INITIAL_MISSING');
    expect(codes(result)).toContain('BENCHLING_PAGE_ORPHANED');
    expect(result.pagination[0].linkedResponseIds).toEqual([]);
  });

  it('reports a cycle whether reachable from the initial request or orphaned', () => {
    for (const pages of [
      [page('first', null, 'a'), page('a', 'a', 'b'), page('b', 'b', 'a')],
      [page('a', 'a', 'b'), page('b', 'b', 'a')],
    ]) {
      const result = inspect(pages);
      expect(result.pagination[0].kind).toBe('conflict');
      expect(codes(result)).toContain('BENCHLING_PAGE_CYCLE');
    }
  });

  it('keeps returning and pageSize changes in separate query families', () => {
    for (const [a, b] of [
      [{ returning: 'id' }, { returning: 'id,name' }],
      [{ pageSize: '2' }, { pageSize: '3' }],
    ]) {
      const result = inspect([page('first', null, 'a', a), page('second', 'a', '', b)]);
      expect(result.pagination).toHaveLength(2);
      expect(result.pagination.every((family) => family.kind === 'incomplete')).toBe(true);
      expect(codes(result)).toContain('BENCHLING_PAGE_SUCCESSOR_MISSING');
      expect(codes(result)).toContain('BENCHLING_PAGE_INITIAL_MISSING');
    }
  });
});
