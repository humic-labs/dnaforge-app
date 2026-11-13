import { describe, expect, it } from 'vitest';
import { computeChecksum, serializeGenBank } from '@waypoint/sequence-utils';
import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  serializeSequencePackageDocument,
} from './sequence-package';
import { composeSequenceRestore } from './sequence-package-restore';
import {
  prepareSequencePackageRevision,
  sequenceReferenceCheckpointId,
  verifySequencePackageSnapshot,
} from './sequence-package-versioning';

function document() {
  return buildSequencePackageDocument({
    id: 'sequence-one',
    name: 'Sequence one',
    product: { file: 'sequence.gb', topology: 'linear' },
  });
}

describe('portable sequence package revisions', () => {
  it('adopts verified legacy bytes before a direct edit and retains both snapshots', async () => {
    const original = document();
    const prepared = await prepareSequencePackageRevision({
      current: original,
      currentProductContent: 'old GenBank bytes',
      next: original,
      nextProductContent: 'new GenBank bytes',
      kind: 'sequence-save',
      operationId: 'operation-one',
      revisionId: 'revision-two',
      adoptedRevisionId: 'revision-one',
    });
    expect(prepared.document.versionHistory.revisions.map((revision) => revision.kind)).toEqual([
      'adopted',
      'sequence-save',
    ]);
    expect(prepared.document.versionHistory.headId).toBe('revision-two');
    expect(prepared.document.versionHistory.revisions[1].parentId).toBe('revision-one');
    expect(prepared.snapshots).toHaveLength(2);
    expect(
      prepared.document.members.filter((member) => member.role === 'sequence-snapshot')
    ).toHaveLength(2);
    await verifySequencePackageSnapshot({
      revision: prepared.document.versionHistory.revisions[0],
      content: 'old GenBank bytes',
    });
    await expect(
      verifySequencePackageSnapshot({
        revision: prepared.document.versionHistory.revisions[0],
        content: 'different bytes',
      })
    ).rejects.toThrow(/integrity/);
  });

  it('refuses an externally changed product rather than publishing a false parent', async () => {
    const original = document();
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: original,
      nextProductContent: 'accepted product',
      kind: 'assembly-finalization',
      operationId: 'finalize-one',
      revisionId: 'revision-one',
    });
    await expect(
      prepareSequencePackageRevision({
        current: first.document,
        currentProductContent: 'externally replaced',
        next: first.document,
        nextProductContent: 'another product',
        kind: 'sequence-save',
        operationId: 'save-two',
        revisionId: 'revision-two',
      })
    ).rejects.toThrow(/no longer match/);
  });

  it('records a metadata-only change without inventing a new DNA snapshot', async () => {
    const original = document();
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: original,
      nextProductContent: 'same product',
      kind: 'assembly-finalization',
      operationId: 'finalize-one',
      revisionId: 'revision-one',
    });
    const changed = buildSequencePackageDocument({
      id: original.id,
      name: 'Renamed',
      product: original.product,
      existing: first.document,
    });
    const second = await prepareSequencePackageRevision({
      current: first.document,
      currentProductContent: 'same product',
      next: changed,
      nextProductContent: 'same product',
      kind: 'metadata-update',
      operationId: 'metadata-two',
      revisionId: 'revision-two',
    });
    expect(second.snapshots).toHaveLength(1);
    expect(
      second.document.members.filter((member) => member.role === 'sequence-snapshot')
    ).toHaveLength(1);
    expect(second.revision.state.name).toBe('Renamed');
    expect(second.revision.productSnapshot).toEqual(first.revision.productSnapshot);
    expect(sequenceReferenceCheckpointId(second.document)).toBe('revision-one');
  });

  it('keeps the tested checkpoint when only GenBank labels or interpretation change', async () => {
    const sequenceChecksum = await computeChecksum('AACC');
    const original = buildSequencePackageDocument({
      id: 'sequence-one',
      name: 'Sequence one',
      product: { file: 'sequence.gb', topology: 'linear', sequenceChecksum },
    });
    const content = (name: string) =>
      serializeGenBank({
        id: original.id,
        name,
        sequence: 'AACC',
        length: 4,
        circular: false,
        annotations: [],
      });
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: original,
      nextProductContent: content('First'),
      kind: 'sequence-save',
      operationId: 'first',
      revisionId: 'first',
    });
    const second = await prepareSequencePackageRevision({
      current: first.document,
      currentProductContent: content('First'),
      next: { ...first.document, name: 'Renamed' },
      nextProductContent: content('Renamed'),
      kind: 'metadata-update',
      operationId: 'second',
      revisionId: 'second',
    });
    expect(second.revision.productSnapshot.sha256).not.toBe(first.revision.productSnapshot.sha256);
    expect(sequenceReferenceCheckpointId(second.document)).toBe('first');
    const restoredCode = await prepareSequencePackageRevision({
      current: second.document,
      currentProductContent: content('Renamed'),
      next: second.document,
      nextProductContent: content('Renamed'),
      kind: 'restore',
      operationId: 'restore-code',
      revisionId: 'third',
      sources: { 'genetic-code': { revisionId: 'first', valueSha256: 'sha256:code' } },
    });
    expect(sequenceReferenceCheckpointId(restoredCode.document)).toBe('first');
  });

  it('advances the tested checkpoint for an identical-DNA assembly acceptance or product Restore', async () => {
    const original = document();
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: original,
      nextProductContent: 'same product',
      kind: 'assembly-finalization',
      operationId: 'finalize-one',
      revisionId: 'revision-one',
    });
    const acceptedAgain = await prepareSequencePackageRevision({
      current: first.document,
      currentProductContent: 'same product',
      next: first.document,
      nextProductContent: 'same product',
      kind: 'assembly-finalization',
      operationId: 'finalize-two',
      revisionId: 'revision-two',
    });
    expect(sequenceReferenceCheckpointId(acceptedAgain.document)).toBe('revision-two');
    const metadataRestore = await prepareSequencePackageRevision({
      current: acceptedAgain.document,
      currentProductContent: 'same product',
      next: acceptedAgain.document,
      nextProductContent: 'same product',
      kind: 'restore',
      operationId: 'restore-name',
      revisionId: 'revision-three',
      sources: { name: { revisionId: 'revision-one', valueSha256: 'sha256:name' } },
    });
    expect(sequenceReferenceCheckpointId(metadataRestore.document)).toBe('revision-two');
    const productRestore = await prepareSequencePackageRevision({
      current: metadataRestore.document,
      currentProductContent: 'same product',
      next: metadataRestore.document,
      nextProductContent: 'same product',
      kind: 'restore',
      operationId: 'restore-product',
      revisionId: 'revision-four',
      sources: { product: { revisionId: 'revision-one', valueSha256: 'sha256:product' } },
    });
    expect(sequenceReferenceCheckpointId(productRestore.document)).toBe('revision-four');
  });

  it('removes a current assembly association without deleting legacy accepted history', async () => {
    const original = document();
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: original,
      nextProductContent: 'same product',
      kind: 'sequence-save',
      operationId: 'before-assembly',
      revisionId: 'before-assembly',
    });
    const legacy = { acceptedAssemblyVersionId: 'legacy-accepted' };
    const current = { acceptedAssemblyVersionId: 'current-accepted' };
    const second = await prepareSequencePackageRevision({
      current: first.document,
      currentProductContent: 'same product',
      next: { ...first.document, assembly: { accepted: current, history: [legacy] } },
      nextProductContent: 'same product',
      kind: 'assembly-finalization',
      operationId: 'accept-assembly',
      revisionId: 'accept-assembly',
    });
    const composed = composeSequenceRestore({
      current: second.document,
      revisions: second.document.versionHistory.revisions,
      selections: [{ itemId: 'assembly', revisionId: 'before-assembly' }],
    });
    expect(composed.blockers).toEqual([]);
    expect(composed.next.assembly?.accepted).toBeUndefined();
    expect(composed.next.assembly?.history).toEqual([legacy]);
    expect(
      parseSequencePackageDocument(serializeSequencePackageDocument(composed.next)).assembly
    ).toEqual({ history: [legacy] });
  });

  it('composes fields and name from different revisions without replacing unselected values', async () => {
    const base = document();
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: { ...base, entity: { ...base.entity, fields: { description: 'Old' } } },
      nextProductContent: 'same product',
      kind: 'sequence-save',
      operationId: 'first',
      revisionId: 'first',
    });
    const second = await prepareSequencePackageRevision({
      current: first.document,
      currentProductContent: 'same product',
      next: { ...first.document, name: 'Second' },
      nextProductContent: 'same product',
      kind: 'metadata-update',
      operationId: 'second',
      revisionId: 'second',
    });
    const third = await prepareSequencePackageRevision({
      current: second.document,
      currentProductContent: 'same product',
      next: {
        ...second.document,
        name: 'Third',
        entity: {
          ...second.document.entity,
          domainStatus: 'reviewed',
          fields: { description: 'Newest' },
        },
      },
      nextProductContent: 'same product',
      kind: 'metadata-update',
      operationId: 'third',
      revisionId: 'third',
    });
    const composed = composeSequenceRestore({
      current: third.document,
      revisions: third.document.versionHistory.revisions,
      selections: [
        { itemId: 'name', revisionId: 'second' },
        { itemId: 'field:description', revisionId: 'first' },
      ],
    });
    expect(composed.blockers).toEqual([]);
    expect(composed.next.name).toBe('Second');
    expect(composed.next.entity.fields.description).toBe('Old');
    expect(composed.next.entity.domainStatus).toBe('reviewed');
    expect(composed.next.id).toBe(base.id);
  });

  it('blocks an older field value that no longer fits the selected schema revision', async () => {
    const base = document();
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: { ...base, entity: { ...base.entity, fields: { description: 'Old text' } } },
      nextProductContent: 'same product',
      kind: 'sequence-save',
      operationId: 'first',
      revisionId: 'first',
    });
    const second = await prepareSequencePackageRevision({
      current: first.document,
      currentProductContent: 'same product',
      next: {
        ...first.document,
        entity: {
          ...first.document.entity,
          schema: {
            ...first.document.entity.schema,
            schemaRevisionId: 'numeric-description-v2',
            version: 3,
            fields: [{ key: 'description', label: 'Description', type: 'number' }],
          },
          fields: { description: 7 },
        },
      },
      nextProductContent: 'same product',
      kind: 'metadata-update',
      operationId: 'second',
      revisionId: 'second',
    });
    const composed = composeSequenceRestore({
      current: second.document,
      revisions: second.document.versionHistory.revisions,
      selections: [{ itemId: 'field:description', revisionId: 'first' }],
    });
    expect(composed.blockers).toEqual([
      expect.stringMatching(/description must be a finite number/),
    ]);
    expect(second.document.entity.fields.description).toBe(7);
  });
});
