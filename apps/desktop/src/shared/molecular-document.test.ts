import { describe, expect, it } from 'vitest';
import {
  getCurrentMolecularSnapshot,
  parseMolecularDocument,
  serializeMolecularDocument,
  validateMolecularDocumentCoordinates,
} from './molecular-document';
import { coordinateDigest } from './molecular-view';
import { molecularDocumentFixture } from '../test/fixtures/molecular-documents';
import legacyV1 from '../test/fixtures/molecular-document-v1.json';
const firstId = '22222222-2222-4222-8222-222222222222';

describe('native molecular document contract', () => {
  it('upgrades an unchanged v1 file without changing its identities, scientific results or source', () => {
    const original = JSON.stringify(legacyV1);
    const migrated = parseMolecularDocument(original);
    expect(migrated.schema).toBe('dnaforge.molecular-document.v2');
    expect(migrated.id).toBe(legacyV1.id);
    expect(migrated.currentReferenceId).toBe(legacyV1.currentReferenceId);
    expect(migrated.history.map((entry) => entry.referenceId)).toEqual(
      legacyV1.history.map((entry) => entry.referenceId)
    );
    const saved = JSON.parse(serializeMolecularDocument(migrated));
    expect(saved.history).toEqual(legacyV1.history);
    expect(saved.coordinateAssets).toEqual(legacyV1.coordinateAssets);
    expect(parseMolecularDocument(serializeMolecularDocument(migrated))).toEqual(migrated);
    expect(JSON.stringify(legacyV1)).toBe(original);
  });

  it('retains unfamiliar optional feature data across an ordinary document edit and round trip', () => {
    const stored = {
      ...legacyV1,
      schema: 'dnaforge.molecular-document.v2',
      extensions: {
        'org.example.contact-annotations': {
          version: 3,
          data: {
            documentId: legacyV1.id,
            viewReferenceId: legacyV1.currentReferenceId,
            futureFields: { contacts: [{ residues: [108, 109], label: 'Keep me' }], enabled: true },
          },
        },
      },
    };
    const opened = parseMolecularDocument(JSON.stringify(stored));
    const saved = JSON.parse(serializeMolecularDocument({ ...opened, name: 'Renamed document' }));
    expect(saved.name).toBe('Renamed document');
    expect(saved.extensions).toEqual(stored.extensions);
    expect(saved.history).toEqual(stored.history);
    expect(saved.coordinateAssets).toEqual(stored.coordinateAssets);
  });

  it('refuses a newer core format and unknown essential features with specific compatibility errors', () => {
    expect(() =>
      parseMolecularDocument(
        JSON.stringify({ ...legacyV1, schema: 'dnaforge.molecular-document.v99' })
      )
    ).toThrow(/MOLECULAR_DOCUMENT_NEWER_FORMAT/);
    expect(() =>
      parseMolecularDocument(
        JSON.stringify({
          ...legacyV1,
          schema: 'dnaforge.molecular-document.v2',
          extensions: { 'org.example.required-feature': { version: 1, data: {} } },
          requiredExtensions: ['org.example.required-feature'],
        })
      )
    ).toThrow(/MOLECULAR_DOCUMENT_UNSUPPORTED_EXTENSION.*org\.example\.required-feature/);
  });

  it('rejects extension name collisions, absent essential payloads and data that cannot round trip', async () => {
    const document = await molecularDocumentFixture();
    expect(() =>
      serializeMolecularDocument({
        ...document,
        extensions: { unscoped: { version: 1, data: {} } },
      })
    ).toThrow();
    expect(() =>
      serializeMolecularDocument({ ...document, requiredExtensions: ['org.example.absent'] })
    ).toThrow();
    for (const value of [undefined, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        serializeMolecularDocument({
          ...document,
          extensions: { 'org.example.invalid-data': { version: 1, data: { value } } },
        })
      ).toThrow();
  });

  it('pools coordinate bytes while preserving every exact result and current identity', async () => {
    const document = await molecularDocumentFixture();
    const bytes = serializeMolecularDocument(document);
    const stored = JSON.parse(bytes);
    const digest = document.history[0].snapshot.coordinates.sha256;
    expect(Object.keys(stored.coordinateAssets)).toEqual([digest]);
    expect(stored.history[0].snapshot.coordinates).toEqual({ format: 'pdb', sha256: digest });
    expect(stored.history[1].snapshot.coordinates).not.toHaveProperty('text');
    const restored = parseMolecularDocument(bytes);
    expect(restored).toEqual(document);
    expect(getCurrentMolecularSnapshot(restored)).toEqual(document.history[1].snapshot);
    await expect(validateMolecularDocumentCoordinates(restored)).resolves.toBeUndefined();
  });

  it('pools repeated comparison assets without changing their names, provenance or scenes', async () => {
    const document = await molecularDocumentFixture();
    const second = document.history[1];
    const snapshot = second.snapshot;
    const otherText = 'HEADER    another exact structure\nEND\n';
    second.snapshot = {
      ...snapshot,
      version: 2,
      scene: JSON.stringify({
        kind: 'single',
        root: {
          kind: 'root',
          children: [
            { kind: 'download', params: { url: 'structure.pdb' }, children: [] },
            { kind: 'download', params: { url: 'asset-2.cif' }, children: [] },
          ],
        },
      }),
      primarySourceReferenceId: firstId,
      pinnedAssets: [
        {
          name: 'asset-2.cif',
          label: 'Comparison source',
          sourceReferenceId: firstId,
          format: 'cif',
          text: otherText,
          sha256: await coordinateDigest(otherText),
        },
      ],
    };
    const bytes = serializeMolecularDocument(document);
    expect(Object.keys(JSON.parse(bytes).coordinateAssets)).toHaveLength(2);
    expect(parseMolecularDocument(bytes)).toEqual(document);
  });

  it('rejects missing assets, changed pinned bytes, duplicate result IDs and an absent current result', async () => {
    const document = await molecularDocumentFixture();
    const stored = JSON.parse(serializeMolecularDocument(document));
    const digest = document.history[0].snapshot.coordinates.sha256;
    delete stored.coordinateAssets[digest];
    expect(() => parseMolecularDocument(JSON.stringify(stored))).toThrow(/coordinate|asset/i);
    stored.coordinateAssets[digest] = 'different bytes';
    await expect(
      validateMolecularDocumentCoordinates(parseMolecularDocument(JSON.stringify(stored)))
    ).rejects.toThrow(/digest|coordinate/i);
    expect(() =>
      serializeMolecularDocument({
        ...document,
        history: [document.history[0], document.history[0]],
      })
    ).toThrow(/result|reference|current/i);
    expect(() =>
      serializeMolecularDocument({
        ...document,
        currentReferenceId: '44444444-4444-4444-8444-444444444444',
      })
    ).toThrow(/current/i);
  });
});
