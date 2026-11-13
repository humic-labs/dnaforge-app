import { describe, expect, it } from 'vitest';

import type { DBEntityReference } from '../../../../db/entity-references';
import {
  bindPersistedMolecularDocumentReferences,
  buildInlineTextDocument,
  projectPersistedInlineTextDocument,
} from './document';
import {
  molecularDocumentReferenceHref,
  molecularDocumentReferenceRecord,
} from '../../../../shared/molecular-document-reference';

const sequenceUrl = 'dnaforge-chat://entity/sequence/Research%20Workspace/constructs/pUC19.gb';

describe('inline reference document', () => {
  it('claims a linked document backing row while preserving the exact named-view destination', () => {
    const target = {
      kind: 'molecular-document' as const,
      version: 1 as const,
      projectId: 'project-a',
      documentId: 'b5b7a4d4-9908-4925-befd-c0198e503645',
      revisionId: 'b5b7a4d4-9908-4925-befd-c0198e503646',
      revisionSha256: 'a'.repeat(64),
      viewId: 'view:fractions',
    };
    const { viewId: _viewId, ...documentTarget } = target;
    const backing = molecularDocumentReferenceRecord(
      documentTarget,
      'Saved fractions',
      'b5b7a4d4-9908-4925-befd-c0198e503647'
    );
    const before = JSON.stringify(backing);
    const source = `[Read evidence](${molecularDocumentReferenceHref(target)})`;
    const projected = projectPersistedInlineTextDocument(
      source,
      [backing.id],
      new Map([[backing.id, backing]])
    );
    expect(projected.parts[0].state).toMatchObject({
      status: 'resolved',
      referenceId: backing.id,
      reference: {
        id: backing.id,
        entity_type: 'molecular-document',
        display_label: 'Read evidence',
        data: JSON.stringify(target),
      },
    });
    expect(projected.parts[0].declaration).toEqual({
      kind: 'molecular-document',
      document: target,
    });
    expect(JSON.stringify(backing)).toBe(before);
    for (const mismatch of [
      { ...backing, entity_type: 'structure' },
      molecularDocumentReferenceRecord(
        { ...target, viewId: 'other-view' },
        'Other view',
        backing.id
      ),
      molecularDocumentReferenceRecord(
        { ...documentTarget, revisionSha256: 'b'.repeat(64) },
        'Other revision',
        backing.id
      ),
      molecularDocumentReferenceRecord(
        { ...documentTarget, projectId: 'other-project' },
        'Other project',
        backing.id
      ),
      { ...backing, status: 'unresolved' },
    ]) {
      expect(
        projectPersistedInlineTextDocument(source, [backing.id], new Map([[backing.id, mismatch]]))
          .parts[0].state
      ).not.toHaveProperty('referenceId');
    }
  });

  it('rehydrates a document chip with its exact linked native reference rather than a legacy revision alias', () => {
    const target = {
      kind: 'molecular-document' as const,
      version: 1 as const,
      projectId: 'project-a',
      documentId: 'b5b7a4d4-9908-4925-befd-c0198e503645',
      revisionId: 'b5b7a4d4-9908-4925-befd-c0198e503646',
      revisionSha256: 'a'.repeat(64),
      viewId: 'view:fractions',
    };
    const native = molecularDocumentReferenceRecord(
      target,
      'Saved fractions',
      'b5b7a4d4-9908-4925-befd-c0198e503647'
    );
    const legacy = { ...native, id: target.revisionId, entity_type: 'structure' };
    const source = `[Read evidence](${molecularDocumentReferenceHref(target)})`;
    const references = new Map([
      [native.id, native],
      [legacy.id, legacy],
    ]);
    const live = projectPersistedInlineTextDocument(source, [], new Map());
    const bound = bindPersistedMolecularDocumentReferences(live, [native.id], references);
    expect(bound.parts[0].state).toMatchObject({ referenceId: native.id });
    expect(bound.source).toBe(live.source);
    expect(bound.parts[0].sourceRange).toEqual(live.parts[0].sourceRange);
    expect(bindPersistedMolecularDocumentReferences(bound, [native.id], references)).toBe(bound);
    const invalid = {
      ...live,
      parts: live.parts.map((part) => ({
        ...part,
        state: { status: 'invalid' as const, code: 'outside-workspace' as const },
      })),
    };
    expect(bindPersistedMolecularDocumentReferences(invalid, [native.id], references)).toBe(
      invalid
    );
    expect(
      projectPersistedInlineTextDocument(source, [native.id], references).parts[0]
    ).toMatchObject({
      state: {
        status: 'resolved',
        referenceId: native.id,
        reference: {
          id: native.id,
          entity_type: 'molecular-document',
          display_label: 'Read evidence',
        },
      },
    });
    for (const linked of [[], [legacy.id]]) {
      const part = projectPersistedInlineTextDocument(source, linked, references).parts[0];
      expect(part.state).not.toHaveProperty('referenceId');
      expect(part.state).toMatchObject({
        status: 'resolved',
        reference: { entity_type: 'molecular-document' },
      });
    }
    const otherView = molecularDocumentReferenceRecord(
      { ...target, viewId: 'other' },
      'Other',
      native.id
    );
    expect(
      projectPersistedInlineTextDocument(
        source,
        [otherView.id],
        new Map([[otherView.id, otherView]])
      ).parts[0].state
    ).not.toHaveProperty('referenceId');
  });

  it('finds complete declarations at exact CommonMark source ranges', () => {
    const source = `Open [pUC19](${sequenceUrl}) and continue.`;
    const document = buildInlineTextDocument(source, { streaming: true });

    expect(document.renderSource).toBe(source);
    expect(document.parts).toEqual([
      expect.objectContaining({
        key: expect.any(String),
        label: 'pUC19',
        sourceRange: {
          start: source.indexOf('[pUC19]'),
          end: source.indexOf(')') + 1,
        },
        declaration: {
          kind: 'path-entity',
          entityType: 'sequence',
          root: 'Research Workspace',
          segments: ['constructs', 'pUC19.gb'],
        },
        state: { status: 'pending' },
      }),
    ]);
  });

  it('conceals every incomplete URI prefix after the private scheme becomes visible', () => {
    const complete = `[pUC19](${sequenceUrl})`;
    const schemeStart = complete.indexOf('dnaforge-chat://') + 'dnaforge-chat://'.length;

    for (let end = schemeStart; end < complete.length; end += 1) {
      const prefix = complete.slice(0, end);
      const document = buildInlineTextDocument(prefix, { streaming: true });
      expect(document.renderSource, `prefix ending at ${end}`).toBe('pUC19');
      expect(document.renderSource).not.toContain('dnaforge-chat://');
    }
  });

  it('does not interpret private syntax inside inline or fenced code', () => {
    const inline = buildInlineTextDocument(`\`[pUC19](${sequenceUrl})\``, {
      streaming: true,
    });
    const fenced = buildInlineTextDocument(`~~~text\n[pUC19](${sequenceUrl})\n~~~`, {
      streaming: true,
    });

    expect(inline.parts).toEqual([]);
    expect(inline.renderSource).toBe('`pUC19`');
    expect(fenced.parts).toEqual([]);
    expect(fenced.renderSource).toBe('~~~text\npUC19\n~~~');
  });

  it('keeps a complete declaration interactive while concealing a later incomplete tail', () => {
    const complete = `[pUC19](${sequenceUrl})`;
    const source = `${complete} then [GFP](dnaforge-chat://ent`;
    const document = buildInlineTextDocument(source, { streaming: true });

    expect(document.parts).toHaveLength(1);
    expect(document.renderSource).toBe(`${complete} then GFP`);
    expect(
      document.renderSource.slice(
        document.parts[0]!.sourceRange.start,
        document.parts[0]!.sourceRange.end
      )
    ).toBe(complete);
  });

  it('reports part ranges against the scrubbed render source', () => {
    const declaration = `[pUC19](${sequenceUrl})`;
    const source = `\`dnaforge-chat://private/transport\` then ${declaration}`;
    const document = buildInlineTextDocument(source, { streaming: false });

    expect(document.parts).toHaveLength(1);
    expect(document.renderSource).not.toContain('dnaforge-chat://private');
    const renderStart = document.renderSource.indexOf(declaration);
    const renderEnd = renderStart + declaration.length;
    expect(document.parts[0]!.key).toBe(`inline-reference-${renderStart}-${renderEnd}`);
    expect(document.renderSource.slice(renderStart, renderEnd)).toBe(declaration);
    expect(
      source.slice(document.parts[0]!.sourceRange.start, document.parts[0]!.sourceRange.end)
    ).toBe(declaration);
  });

  it('limits one message to eight actionable declarations', () => {
    const source = Array.from(
      { length: 10 },
      (_, index) => `[pUC19-${index}](${sequenceUrl})`
    ).join(' ');

    expect(buildInlineTextDocument(source, { streaming: false }).parts).toHaveLength(8);
  });

  it('leaves ordinary custom links and malformed declarations inert', () => {
    const source = [
      '[ordinary](workspace://root/file.gb)',
      '[traversal](dnaforge-chat://workspace/root/..)',
      '[rich **label**](dnaforge-chat://workspace/root/file.gb)',
    ].join(' ');

    expect(buildInlineTextDocument(source, { streaming: false }).parts).toEqual([]);
    expect(buildInlineTextDocument(source, { streaming: false }).renderSource).not.toContain(
      'dnaforge-chat://'
    );
  });

  it('requires the exact message join before replaying an entity node as interactive', () => {
    const id = '5887a64e-1234-4678-9abc-def012345678';
    const reference: DBEntityReference = {
      id,
      entity_type: 'sequence',
      display_label: 'pUC19.gb',
      locator: 'git://Research Workspace/constructs/pUC19.gb',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      workspace_scope: 'scope-a',
      created_at: 1,
      updated_at: 1,
    };
    const source = `Open [pUC19](dnaforge-chat://reference/${id}).`;

    expect(
      projectPersistedInlineTextDocument(source, [], new Map([[id, reference]])).parts[0]
    ).toMatchObject({ state: { status: 'pending' } });
    expect(projectPersistedInlineTextDocument(source, [id], new Map()).parts[0]).toMatchObject({
      state: { status: 'pending' },
    });
    expect(
      projectPersistedInlineTextDocument(source, [id], new Map([[id, reference]])).parts[0]
    ).toMatchObject({
      state: { status: 'resolved', referenceId: id, reference },
    });
  });

  it('leaves every entity node inert unless nodes, ordered joins, and rows match one-to-one', () => {
    const firstId = '5887a64e-1234-4678-9abc-def012345678';
    const secondId = '6887a64e-1234-4678-9abc-def012345678';
    const reference = (id: string, label: string): DBEntityReference => ({
      id,
      entity_type: 'sequence',
      display_label: label,
      locator: `git://Research Workspace/constructs/${label}`,
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      workspace_scope: 'scope-a',
      created_at: 1,
      updated_at: 1,
    });
    const references = new Map([
      [firstId, reference(firstId, 'first.gb')],
      [secondId, reference(secondId, 'second.gb')],
    ]);
    const source =
      `[first](dnaforge-chat://reference/${firstId}) ` +
      `[second](dnaforge-chat://reference/${secondId})`;

    expect(
      projectPersistedInlineTextDocument(source, [secondId, firstId], references).parts.map(
        (part) => part.state.status
      )
    ).toEqual(['pending', 'pending']);
    expect(
      projectPersistedInlineTextDocument(source, [firstId], references).parts.map(
        (part) => part.state.status
      )
    ).toEqual(['pending', 'pending']);
    expect(
      projectPersistedInlineTextDocument(
        source,
        [firstId, secondId, firstId],
        references
      ).parts.map((part) => part.state.status)
    ).toEqual(['pending', 'pending']);
    expect(
      projectPersistedInlineTextDocument(
        source,
        [firstId, secondId],
        new Map([[firstId, references.get(firstId)!]])
      ).parts.map((part) => part.state.status)
    ).toEqual(['pending', 'pending']);

    const duplicateSource =
      `[first](dnaforge-chat://reference/${firstId}) ` +
      `[again](dnaforge-chat://reference/${firstId})`;
    expect(
      projectPersistedInlineTextDocument(duplicateSource, [firstId], references).parts.map(
        (part) => part.state.status
      )
    ).toEqual(['pending', 'pending']);
  });

  it('replays a canonical workspace path for click-time containment validation', () => {
    const source =
      'See [results](dnaforge-chat://workspace/Research%20Workspace/results/alignment-01).';
    expect(projectPersistedInlineTextDocument(source, [], new Map()).parts[0]).toMatchObject({
      declaration: { kind: 'workspace-path' },
      state: { status: 'resolved', canonicalLabel: 'alignment-01' },
    });
  });

  it('replays one interactive entity when persisted prose also names its workspace target', () => {
    const id = '5887a64e-1234-4678-9abc-def012345678';
    const reference: DBEntityReference = {
      id,
      entity_type: 'sequence',
      display_label: 'pUC19.gb',
      locator: 'git://Research Workspace/constructs/pUC19.gb',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      workspace_scope: 'scope-a',
      created_at: 1,
      updated_at: 1,
    };
    const source =
      `[entity](dnaforge-chat://reference/${id}) ` +
      '[path](dnaforge-chat://workspace/Research%20Workspace/constructs/pUC19.gb)';

    const projected = projectPersistedInlineTextDocument(source, [id], new Map([[id, reference]]));

    expect(projected.parts.map((part) => part.state.status)).toEqual([
      'resolved',
      'suppressed-duplicate',
    ]);
    expect(projected.parts[0]?.state).toMatchObject({ canonicalLabel: 'pUC19' });
    expect(projected.parts[1]?.state).toMatchObject({ canonicalLabel: 'pUC19' });
  });
});
