import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_PORTABLE_SEQUENCE_PACKAGE_FORMAT_VERSION,
  parseSequencePackageAdmissionDescriptor,
  validateSequencePackageAdmission,
} from './sequence-package-admission';
import type { WorkspaceSyncManifestV1 } from './workspace-sync-manifest';

const markerPath = 'project/vector/.forge/plasmid.json';
const productPath = 'project/vector/vector.gb';
const genbank =
  'LOCUS       vector 4 bp DNA circular\nFEATURES             Location/Qualifiers\nORIGIN\n        1 acgt\n//\n';
const digest = (content: string | Uint8Array) => createHash('sha256').update(content).digest('hex');
const marker = () => ({
  schema: 'waypoint.sequence.v1',
  kind: 'sequence',
  formatVersion: 4,
  id: 'legacy-stable-id',
  name: 'vector',
  product: { file: 'vector.gb', topology: 'circular' },
  members: [],
});

function fixture(value: unknown = marker(), extras: Record<string, string> = {}) {
  const packageBytes = new Map<string, Uint8Array>(
    Object.entries({
      [markerPath]: JSON.stringify(value),
      [productPath]: genbank,
      ...extras,
    }).map(([path, content]) => [path, new TextEncoder().encode(content)])
  );
  const manifest: WorkspaceSyncManifestV1 = {
    schemaVersion: 1,
    files: [...packageBytes].map(([path, bytes]) => ({
      path,
      contentSha256: digest(bytes),
      sizeBytes: bytes.byteLength,
      contentType: 'application/octet-stream',
    })),
  };
  return { manifest, packageBytes };
}

describe('shared complete sequence package admission', () => {
  it.each([
    ['case-folded nested authority', 'project/vector', 'Project/vector/nested'],
    ['Unicode-folded nested authority', 'ss', 'ß/nested'],
  ])('rejects %s even with distinct IDs and exact verified bytes', (_label, outer, nested) => {
    const packageBytes = new Map<string, Uint8Array>();
    for (const [index, root] of [outer, nested].entries()) {
      packageBytes.set(
        `${root}/.forge/plasmid.json`,
        new TextEncoder().encode(JSON.stringify({ ...marker(), id: `package-${index}` }))
      );
      packageBytes.set(`${root}/vector.gb`, new TextEncoder().encode(genbank));
    }
    const files = [...packageBytes].map(([path, bytes]) => ({
      path,
      contentSha256: digest(bytes),
      sizeBytes: bytes.byteLength,
    }));
    expect(validateSequencePackageAdmission({ manifest: { files }, packageBytes })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: 'invalid-tree' })]),
    });
  });

  it('admits opaque legacy IDs and preserves exact input bytes', () => {
    const input = fixture();
    const before = [...input.packageBytes].map(([path, bytes]) => [path, [...bytes]]);
    expect(validateSequencePackageAdmission(input)).toMatchObject({
      ok: true,
      packages: [{ packageId: 'legacy-stable-id', root: 'project/vector', productPath }],
    });
    expect([...input.packageBytes].map(([path, bytes]) => [path, [...bytes]])).toEqual(before);
  });

  it('admits current format 8 without rewriting its package-owned history', () => {
    const retained = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          '../../../../apps/desktop/src/db/__fixtures__/sequence-packages/v7-user-attachment/.forge/plasmid.json'
        ),
        'utf8'
      )
    );
    const current = {
      ...retained,
      formatVersion: 8,
      product: marker().product,
      members: [],
      userAttachments: {},
    };
    const input = fixture(current);
    const before = [...input.packageBytes].map(([path, bytes]) => [path, [...bytes]]);
    expect(validateSequencePackageAdmission(input)).toMatchObject({ ok: true });
    expect([...input.packageBytes].map(([path, bytes]) => [path, [...bytes]])).toEqual(before);
  });

  it('refuses an invalid history head in an otherwise valid current package', () => {
    const retained = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          '../../../../apps/desktop/src/db/__fixtures__/sequence-packages/v7-user-attachment/.forge/plasmid.json'
        ),
        'utf8'
      )
    );
    expect(
      validateSequencePackageAdmission(
        fixture({
          ...retained,
          formatVersion: 8,
          product: marker().product,
          members: [],
          userAttachments: {},
          versionHistory: { ...retained.versionHistory, headId: 'missing-revision' },
        })
      )
    ).toMatchObject({ ok: false });
  });

  it('exposes stable member identity without requiring product bytes', () => {
    expect(
      parseSequencePackageAdmissionDescriptor(
        {
          ...marker(),
          members: [{ id: 'member-stable', role: 'custom-role', path: 'contents/read.ab1' }],
        },
        markerPath
      )
    ).toMatchObject({
      ok: true,
      descriptor: {
        productPath,
        members: [
          {
            memberId: 'member-stable',
            role: 'custom-role',
            path: 'project/vector/contents/read.ab1',
          },
        ],
      },
    });
  });

  it.each([
    ['missing identity', { ...marker(), id: '' }],
    ['array-coerced schema', { ...marker(), schema: ['waypoint.sequence.v1'] }],
    ['array-coerced kind', { ...marker(), kind: ['sequence'] }],
    [
      'future format',
      { ...marker(), formatVersion: MAX_PORTABLE_SEQUENCE_PACKAGE_FORMAT_VERSION + 1 },
    ],
    ['nested product', { ...marker(), product: { file: 'contents/vector.gb' } }],
    ['invalid topology', { ...marker(), product: { file: 'vector.gb', topology: 'unknown' } }],
    [
      'duplicate member IDs',
      {
        ...marker(),
        members: [
          { id: 'member', role: 'user', path: 'contents/a.txt' },
          { id: ' member ', role: 'user', path: 'contents/b.txt' },
        ],
      },
    ],
    [
      'escaping member',
      { ...marker(), members: [{ id: 'member', role: 'user', path: '../other.txt' }] },
    ],
    ['malformed current metadata', { ...marker(), formatVersion: 6, entity: {} }],
  ])('rejects %s', (_label, value) => {
    expect(validateSequencePackageAdmission(fixture(value))).toMatchObject({ ok: false });
  });

  it('rejects a missing or privacy-excluded required member', () => {
    const input = fixture({
      ...marker(),
      members: [{ id: 'read-1', role: 'sequencing-read', path: 'contents/private.bam' }],
    });
    expect(validateSequencePackageAdmission(input)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: 'missing-member',
          path: 'project/vector/contents/private.bam',
          message: expect.stringContaining('private-raw-data'),
        }),
      ]),
    });
  });

  it('does not admit privacy-excluded bytes even when every required member is present', () => {
    const path = 'project/vector/contents/private.bam';
    expect(
      validateSequencePackageAdmission(
        fixture(
          {
            ...marker(),
            members: [{ id: 'read-1', role: 'sequencing-read', path: 'contents/private.bam' }],
          },
          { [path]: 'private bytes' }
        )
      )
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: 'policy-excluded', path })]),
    });
  });

  it('does not require attachment bytes after their immutable manifest identity is verified', () => {
    const input = fixture(
      { ...marker(), members: [{ id: 'read-1', role: 'user', path: 'contents/data.bin' }] },
      { 'project/vector/contents/data.bin': 'large opaque bytes' }
    );
    input.packageBytes.delete('project/vector/contents/data.bin');
    expect(validateSequencePackageAdmission(input)).toMatchObject({ ok: true });
  });

  it('rejects two package roots with the same embedded ID', () => {
    const input = fixture(marker(), {
      'project/copy/.forge/plasmid.json': JSON.stringify(marker()),
      'project/copy/vector.gb': genbank,
    });
    expect(validateSequencePackageAdmission(input)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: 'duplicate-package-id' })]),
    });
  });

  it.each([
    ['malformed GenBank', 'not a sequence'],
    ['two products in one file', genbank + genbank],
    ['incomplete GenBank', genbank.replace('//\n', '')],
    ['LOCUS length mismatch', genbank.replace('4 bp', '8 bp')],
    ['malformed LOCUS header', genbank.replace('vector 4 bp DNA circular', 'broken header')],
    ['orphan record terminator', `${genbank}//\n`],
  ])('rejects %s from the actual stored product bytes', (_label, product) => {
    expect(
      validateSequencePackageAdmission(fixture(marker(), { [productPath]: product }))
    ).toMatchObject({
      ok: false,
    });
  });

  it('rejects stale topology/checksums and unverified supplied bytes', () => {
    const input = fixture({
      ...marker(),
      product: {
        file: 'vector.gb',
        topology: 'linear',
        genBankChecksum: `sha256:${'a'.repeat(64)}`,
      },
    });
    expect(validateSequencePackageAdmission(input)).toMatchObject({ ok: false });
    const wrongBytes = fixture();
    wrongBytes.packageBytes.set(
      productPath,
      new TextEncoder().encode(genbank.replace('acgt', 'aaaa'))
    );
    expect(validateSequencePackageAdmission(wrongBytes)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: 'blob-mismatch' })]),
    });
  });

  it('requires a valid LOCUS length even when the marker does not declare topology', () => {
    expect(
      validateSequencePackageAdmission(
        fixture(
          { ...marker(), product: { file: 'vector.gb' } },
          { [productPath]: genbank.replace('vector 4 bp DNA circular', 'broken header') }
        )
      )
    ).toMatchObject({ ok: false });
  });

  it('accepts an intentionally empty editable sequence, not a truncated one', () => {
    const empty = genbank.replace('4 bp', '0 bp').replace('        1 acgt\n', '');
    expect(
      validateSequencePackageAdmission(fixture(marker(), { [productPath]: empty }))
    ).toMatchObject({
      ok: true,
    });
  });

  it('honors the accepted uppercase sequence checksum with the lowercase GenBank writer', () => {
    expect(
      validateSequencePackageAdmission(
        fixture({
          ...marker(),
          product: {
            file: 'vector.gb',
            topology: 'circular',
            sequenceChecksum: `sha256:${digest('ACGT')}`,
            genBankChecksum: `sha256:${digest(genbank)}`,
          },
        })
      )
    ).toMatchObject({ ok: true });
  });

  it.each(['pending', 'complete'])('admits only a completed metadata transaction (%s)', (state) => {
    const path = 'project/vector/.forge/sequence-metadata-transaction.json';
    const input = fixture(marker(), {
      [path]: JSON.stringify({
        schema: 'waypoint.sequence-metadata-transaction.v1',
        packageId: marker().id,
        state,
      }),
    });
    expect(validateSequencePackageAdmission(input)).toMatchObject({ ok: state === 'complete' });
    input.packageBytes.delete(path);
    expect(validateSequencePackageAdmission(input)).toMatchObject({ ok: false });
  });

  it('admits every retained desktop migration fixture without rewriting it', () => {
    const root = resolve(
      import.meta.dirname,
      '../../../../apps/desktop/src/db/__fixtures__/sequence-packages'
    );
    for (const name of readdirSync(root)) {
      const packageBytes = new Map<string, Uint8Array>();
      const walk = (directory: string, relative: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = `${relative}/${entry.name}`;
          if (entry.isDirectory()) walk(resolve(directory, entry.name), path);
          else if (entry.name !== 'migration-expect.json') {
            packageBytes.set(path, readFileSync(resolve(directory, entry.name)));
          }
        }
      };
      walk(resolve(root, name), name);
      const manifest: WorkspaceSyncManifestV1 = {
        schemaVersion: 1,
        files: [...packageBytes].map(([path, bytes]) => ({
          path,
          contentSha256: digest(bytes),
          sizeBytes: bytes.byteLength,
          contentType: 'application/octet-stream',
        })),
      };
      expect(validateSequencePackageAdmission({ manifest, packageBytes }), name).toMatchObject({
        ok: true,
      });
    }
  });
});
