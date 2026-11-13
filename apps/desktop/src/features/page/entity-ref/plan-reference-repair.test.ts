// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  planPageReferenceRepair,
  planReferenceRepair,
  repairLookupKey,
  type RepairableMention,
  type RepairCandidate,
} from './plan-reference-repair';

function candidate(overrides: Partial<RepairCandidate> = {}): RepairCandidate {
  return {
    path: 'sequences/E1010m_CD/E1010m_CD.gb',
    contentHash: 'sha256:' + 'a'.repeat(64),
    objectUuid: 'uuid-1',
    entityId: 'ent-1',
    ...overrides,
  };
}

describe('planReferenceRepair', () => {
  it('repairs a legacy chip from a single unambiguous match', () => {
    const plan = planReferenceRepair({
      mentions: [{ entityType: 'sequence', entityId: 'seq_7', label: 'E1010m_CD' }],
      matches: new Map([['E1010m_CD', [candidate()]]]),
    });

    expect(plan.repairs).toEqual([
      {
        index: 0,
        label: 'E1010m_CD',
        attrs: {
          path: 'sequences/E1010m_CD/E1010m_CD.gb',
          contentHash: 'sha256:' + 'a'.repeat(64),
          objectUuid: 'uuid-1',
          entityId: 'ent-1',
        },
      },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('🟥 SKIPS an ambiguous label rather than picking one', () => {
    const plan = planReferenceRepair({
      mentions: [{ entityType: 'sequence', entityId: 'seq_7', label: 'pUC19' }],
      matches: new Map([
        [
          'pUC19',
          [
            candidate({ path: 'kits/pUC19/pUC19.gb', objectUuid: 'uuid-a' }),
            candidate({ path: 'backup/pUC19/pUC19.gb', objectUuid: 'uuid-b' }),
          ],
        ],
      ]),
    });

    expect(plan.repairs).toEqual([]);
    expect(plan.skipped).toEqual([{ index: 0, label: 'pUC19', reason: 'ambiguous' }]);
  });

  it('skips a label the catalog does not know', () => {
    const plan = planReferenceRepair({
      mentions: [{ entityType: 'sequence', entityId: 'seq_7', label: 'deleted-thing' }],
      matches: new Map(),
    });

    expect(plan.repairs).toEqual([]);
    expect(plan.skipped).toEqual([{ index: 0, label: 'deleted-thing', reason: 'not-found' }]);
  });

  it('🟥 NEVER touches a chip that already carries a record', () => {
    const plan = planReferenceRepair({
      mentions: [
        {
          entityType: 'sequence',
          entityId: 'ent-1',
          label: 'E1010m_CD',
          path: 'somewhere/else.gb',
          objectUuid: 'uuid-existing',
        },
      ],
      matches: new Map([['E1010m_CD', [candidate()]]]),
    });

    expect(plan.repairs).toEqual([]);
    expect(plan.skipped).toEqual([{ index: 0, label: 'E1010m_CD', reason: 'already-complete' }]);
  });

  it('treats a chip with a path but NO durable identity as repairable', () => {
    const plan = planReferenceRepair({
      mentions: [
        {
          entityType: 'sequence',
          entityId: null,
          label: 'E1010m_CD',
          path: 'sequences/E1010m_CD.gb',
        },
      ],
      matches: new Map([['E1010m_CD', [candidate()]]]),
    });

    expect(plan.repairs).toHaveLength(1);
    expect(plan.repairs[0].attrs.objectUuid).toBe('uuid-1');
  });

  it('skips a page mention — pages are not files', () => {
    const plan = planReferenceRepair({
      mentions: [{ entityType: 'page', entityId: 'scope::page-1', label: 'Some note' }],
      matches: new Map([['Some note', [candidate()]]]),
    });

    expect(plan.repairs).toEqual([]);
    expect(plan.skipped).toEqual([{ index: 0, label: 'Some note', reason: 'not-a-file-entity' }]);
  });

  it('skips a chip with no label — there is nothing to match on', () => {
    const plan = planReferenceRepair({
      mentions: [{ entityType: 'sequence', entityId: 'seq_7', label: '' }],
      matches: new Map([['', [candidate()]]]),
    });

    expect(plan.skipped).toEqual([{ index: 0, label: '', reason: 'not-found' }]);
  });

  it('🟥 refuses a candidate whose path is not workspace-safe', () => {
    const plan = planReferenceRepair({
      mentions: [{ entityType: 'sequence', entityId: 'seq_7', label: 'E1010m_CD' }],
      matches: new Map([['E1010m_CD', [candidate({ path: '../../etc/passwd' })]]]),
    });

    expect(plan.repairs).toEqual([]);
    expect(plan.skipped).toEqual([{ index: 0, label: 'E1010m_CD', reason: 'unsafe-path' }]);
  });

  it('reports repairs and skips together across a mixed notebook', () => {
    const plan = planReferenceRepair({
      mentions: [
        { entityType: 'sequence', entityId: 'seq_1', label: 'good' },
        { entityType: 'sequence', entityId: 'seq_2', label: 'ambiguous' },
        { entityType: 'sequence', entityId: 'seq_3', label: 'gone' },
      ],
      matches: new Map([
        ['good', [candidate({ path: 'a/good.gb' })]],
        ['ambiguous', [candidate({ path: 'b/x.gb' }), candidate({ path: 'c/x.gb' })]],
      ]),
    });

    expect(plan.repairs.map((r) => r.label)).toEqual(['good']);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['ambiguous', 'not-found']);
  });

  it('is a no-op on an empty notebook', () => {
    const plan = planReferenceRepair({ mentions: [], matches: new Map() });
    expect(plan).toEqual({ repairs: [], skipped: [] });
  });

  describe('lookup key — the legacy path-valued entityId wins over the label', () => {
    it('keys off the legacy path when entityId is a path', () => {
      expect(
        repairLookupKey({
          entityType: 'sequence',
          entityId: 'sequences/kits/moclo-cidar/E1010m_CD.gb',
          label: 'E1010m (mRFP)',
        })
      ).toBe('sequences/kits/moclo-cidar/E1010m_CD.gb');
    });

    it('falls back to the label when entityId is a real opaque id', () => {
      expect(
        repairLookupKey({ entityType: 'sequence', entityId: 'seq_7', label: 'E1010m_CD' })
      ).toBe('E1010m_CD');
    });

    it('falls back to the label for a uuid-shaped entityId', () => {
      expect(
        repairLookupKey({
          entityType: 'sequence',
          entityId: 'fe1c174a-7ff0-4c1a-9e33-0d1f2a3b4c5d',
          label: 'E1010m_CD',
        })
      ).toBe('E1010m_CD');
    });

    it('repairs the REAL shape: display label, path-valued entityId', () => {
      const plan = planReferenceRepair({
        mentions: [
          {
            entityType: 'sequence',
            entityId: 'sequences/kits/moclo-cidar/E1010m_CD.gb',
            label: 'E1010m (mRFP)',
          },
        ],
        matches: new Map([
          [
            'sequences/kits/moclo-cidar/E1010m_CD.gb',
            [
              candidate({
                path: 'sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb',
                objectUuid: '2b44d82f-102d-45ee-b99d-a17ea9c0c09d',
                contentHash: null,
              }),
            ],
          ],
        ]),
      });

      expect(plan.skipped).toEqual([]);
      expect(plan.repairs[0].attrs).toEqual({
        path: 'sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb',
        contentHash: null,
        objectUuid: '2b44d82f-102d-45ee-b99d-a17ea9c0c09d',
        entityId: 'ent-1',
      });
    });

    it('🟥 never writes a git: oid in as a fingerprint', () => {
      const plan = planReferenceRepair({
        mentions: [{ entityType: 'sequence', entityId: 'sequences/a.gb', label: 'A' }],
        matches: new Map([
          [
            'sequences/a.gb',
            [candidate({ path: 'sequences/a/a.gb', contentHash: 'git:25ffcec0' })],
          ],
        ]),
      });

      expect(plan.repairs).toHaveLength(1);
      expect(plan.repairs[0].attrs.contentHash).toBeNull();
    });
  });
});

describe('planPageReferenceRepair — where a referenced notebook entry lives', () => {
  const pageMention = (over: Partial<RepairableMention> = {}): RepairableMention => ({
    entityType: 'page',
    entityId: 'corpus-11-burden-mitigation',
    label: '11 — Burden mitigation',
    path: null,
    ...over,
  });

  it('back-fills the path of the entry it points at', () => {
    const plan = planPageReferenceRepair({
      mentions: [pageMention()],
      matches: new Map([
        ['corpus-11-burden-mitigation', [{ path: 'notebooks/11 — Burden mitigation' }]],
      ]),
    });
    expect(plan.repairs).toEqual([
      { index: 0, label: '11 — Burden mitigation', path: 'notebooks/11 — Burden mitigation' },
    ]);
  });

  it('leaves a reference that already has one alone', () => {
    const plan = planPageReferenceRepair({
      mentions: [pageMention({ path: 'notebooks/somewhere-else' })],
      matches: new Map([['corpus-11-burden-mitigation', [{ path: 'notebooks/11' }]]]),
    });
    expect(plan.repairs).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('already-complete');
  });

  it('refuses when TWO notebooks answer to the same id', () => {
    const plan = planPageReferenceRepair({
      mentions: [pageMention()],
      matches: new Map([
        ['corpus-11-burden-mitigation', [{ path: 'notebooks/a' }, { path: 'notebooks/b' }]],
      ]),
    });
    expect(plan.repairs).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('ambiguous');
  });

  it('refuses a path that escapes the workspace', () => {
    const plan = planPageReferenceRepair({
      mentions: [pageMention()],
      matches: new Map([['corpus-11-burden-mitigation', [{ path: '../../etc/passwd' }]]]),
    });
    expect(plan.repairs).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('unsafe-path');
  });

  it('never rewrites entityId, which must stay portable', () => {
    const plan = planPageReferenceRepair({
      mentions: [pageMention()],
      matches: new Map([['corpus-11-burden-mitigation', [{ path: 'notebooks/11' }]]]),
    });
    expect(Object.keys(plan.repairs[0])).toEqual(['index', 'label', 'path']);
  });

  it('ignores mentions that are not notebook entries', () => {
    const plan = planPageReferenceRepair({
      mentions: [{ entityType: 'sequence', entityId: 'x.gb', label: 'x', path: null }],
      matches: new Map(),
    });
    expect(plan.repairs).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('not-a-file-entity');
  });
});
