// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { LimsImportRecord, LimsImportUnresolvedLink } from '../../shared/lims';
import {
  attachStubsToPlan,
  buildProvisionalStubRecords,
  collectUnresolvedEndpoints,
  countCreatableStubs,
} from './import-stub-plan';

function makeRecord(name: string, overrides: Partial<LimsImportRecord> = {}): LimsImportRecord {
  return {
    id: `rec:${name}`,
    action: 'register_entity',
    accepted: true,
    entity: { kind: 'strain', name, fields: {} },
    links: [],
    unresolvedLinks: [],
    source: {},
    ...overrides,
  };
}

function unresolved(label: string, kind?: string): LimsImportUnresolvedLink {
  return {
    label,
    kind,
    type: 'derives_from',
    severity: 'advisory',
    reason: 'parent not found in batch or registry',
  };
}

describe('collectUnresolvedEndpoints', () => {
  it('reads {name: link.label, kind: link.kind ?? "strain"} from each unresolvedLink', () => {
    const records = [
      makeRecord('W1485', {
        unresolvedLinks: [unresolved('MG1655'), unresolved('assembly-A', 'genome')],
      }),
    ];
    expect(collectUnresolvedEndpoints(records)).toEqual([
      { name: 'MG1655', kind: 'strain' },
      { name: 'assembly-A', kind: 'genome' },
    ]);
  });

  it('is DISTINCT by kind + lowercased name across all records', () => {
    const records = [
      makeRecord('a', { unresolvedLinks: [unresolved('MG1655')] }),
      makeRecord('b', { unresolvedLinks: [unresolved('mg1655')] }),
      makeRecord('c', { unresolvedLinks: [unresolved('MG1655', 'genome')] }),
    ];
    expect(collectUnresolvedEndpoints(records)).toEqual([
      { name: 'MG1655', kind: 'strain' },
      { name: 'MG1655', kind: 'genome' },
    ]);
  });

  it('ignores empty/blank labels', () => {
    const records = [makeRecord('a', { unresolvedLinks: [unresolved(''), unresolved('   ')] })];
    expect(collectUnresolvedEndpoints(records)).toEqual([]);
  });

  it('excludes an endpoint whose name matches a record already in the batch', () => {
    const records = [
      makeRecord('MG1655'),
      makeRecord('W1485', { unresolvedLinks: [unresolved('MG1655')] }),
    ];
    const endpoints = collectUnresolvedEndpoints(records);
    expect(endpoints).toEqual([]);
    expect(endpoints.some((e) => e.name.toLowerCase() === 'mg1655')).toBe(false);
  });
});

describe('countCreatableStubs', () => {
  it('equals the distinct endpoint count', () => {
    const records = [
      makeRecord('a', { unresolvedLinks: [unresolved('MG1655'), unresolved('mg1655')] }),
      makeRecord('b', { unresolvedLinks: [unresolved('W3110')] }),
    ];
    const endpoints = collectUnresolvedEndpoints(records);
    expect(countCreatableStubs(endpoints)).toBe(2);
    expect(countCreatableStubs(endpoints)).toBe(endpoints.length);
  });
});

describe('buildProvisionalStubRecords', () => {
  it('builds one provisional register_entity record per endpoint', () => {
    const stubs = buildProvisionalStubRecords([{ name: 'MG1655', kind: 'strain' }]);
    expect(stubs).toHaveLength(1);
    const [stub] = stubs;
    expect(stub.id).toBe('stub:strain:MG1655');
    expect(stub.action).toBe('register_entity');
    expect(stub.accepted).toBe(true);
    expect(stub.entity).toEqual({
      kind: 'strain',
      name: 'MG1655',
      fields: { provisional: true },
    });
    expect(stub.links).toEqual([]);
    expect(stub.unresolvedLinks).toEqual([]);
    expect(stub.errors).toEqual([]);
  });

  it('flags every stub provisional and carries the endpoint kind', () => {
    const stubs = buildProvisionalStubRecords([
      { name: 'assembly-A', kind: 'genome' },
      { name: 'W3110', kind: 'strain' },
    ]);
    expect(stubs.map((s) => s.entity.kind)).toEqual(['genome', 'strain']);
    expect(stubs.every((s) => s.entity.fields.provisional === true)).toBe(true);
  });
});

describe('attachStubsToPlan', () => {
  it('returns stubs FIRST then the original records', () => {
    const records = [makeRecord('W1485', { unresolvedLinks: [unresolved('MG1655')] })];
    const stubs = buildProvisionalStubRecords([{ name: 'MG1655', kind: 'strain' }]);
    const plan = attachStubsToPlan(records, stubs);
    expect(plan.map((r) => r.id)).toEqual(['stub:strain:MG1655', 'rec:W1485']);
  });

  it('dedupes a stub whose name+kind already exists as a real record (reject self-link)', () => {
    const records = [makeRecord('MG1655')];
    const stubs = buildProvisionalStubRecords([
      { name: 'MG1655', kind: 'strain' },
      { name: 'MG1655', kind: 'genome' },
    ]);
    const plan = attachStubsToPlan(records, stubs);
    expect(plan.map((r) => r.id)).toEqual(['stub:genome:MG1655', 'rec:MG1655']);
  });
});
