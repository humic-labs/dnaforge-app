// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkspaceSyncFile } from '@waypoint/share-bundle';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: vi.fn() } }));

import { app } from 'electron';
import { buildSequencePackageDocument } from '../db/sequence-package';
import { receiveWorkspaceSyncBlob } from './workspace-sync-blob-cache';
import type { ReconcileResource } from './workspace-sync-reconcile';
import { summarizeReconcileResource } from './workspace-sync-reconcile-comparison';

const root = 'sequences/construct';
const temporaryRoots: string[] = [];

function file(path: string, content: string): WorkspaceSyncFile {
  return {
    id: `file:${path}`,
    relativePath: path,
    name: path.split('/').at(-1)!,
    kind: path.endsWith('.gb')
      ? 'genbank'
      : path.endsWith('/.forge/plasmid.json')
        ? 'assembly-sidecar'
        : 'workspace-resource',
    contentType: 'text/plain',
    content,
    sizeBytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function resource(bases = 'acgtacgt', annotationName = 'reporter'): ReconcileResource {
  const marker = buildSequencePackageDocument({
    id: 'package-stable-id',
    name: 'Construct',
    product: { file: 'construct.gb' },
    members: [
      {
        id: 'trace-stable-id',
        path: 'contents/trace.ab1',
        role: 'data',
        replaceable: false,
        createdAt: '2026-10-05T00:00:00.000Z',
      },
    ],
    updatedAt: '2026-10-05T00:00:00.000Z',
  });
  const product = `LOCUS       construct 8 bp DNA circular\nFEATURES             Location/Qualifiers\n     CDS             1..6\n                     /label="${annotationName}"\nORIGIN\n        1 ${bases}\n//\n`;
  return {
    id: 'seq:package-stable-id',
    kind: 'sequence-package',
    path: root,
    contentHash: 'frozen-package',
    files: [
      file(`${root}/.forge/plasmid.json`, JSON.stringify(marker)),
      file(`${root}/construct.gb`, product),
      file(`${root}/contents/trace.ab1`, 'binary trace bytes'),
    ],
  };
}

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('bounded comparison of exact frozen sequence package bytes', () => {
  it('distinguishes changed bases from changed annotations and exposes stable attachment identity', async () => {
    const before = (await summarizeReconcileResource(resource()))!.sequence!;
    const bases = (await summarizeReconcileResource(resource('ttttacgt')))!.sequence!;
    const annotations = (await summarizeReconcileResource(resource('acgtacgt', 'new reporter')))!
      .sequence!;
    expect(before).toMatchObject({
      productPath: 'construct.gb',
      baseCount: 8,
      topology: 'circular',
      annotationCount: 1,
      attachmentCount: 1,
      inspectionUnavailableReason: null,
    });
    expect(before.annotationNames?.[0]).toContain('reporter (CDS,');
    expect(before.attachments[0]).toMatchObject({
      memberId: 'trace-stable-id',
      path: 'contents/trace.ab1',
    });
    expect(bases.basesSha256).not.toBe(before.basesSha256);
    expect(bases.annotationsSha256).toBe(before.annotationsSha256);
    expect(annotations.basesSha256).toBe(before.basesSha256);
    expect(annotations.annotationsSha256).not.toBe(before.annotationsSha256);
  });

  it('inspects blob-backed immutable bytes, not a placeholder or live working file', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'dnaforge-sequence-comparison-'));
    temporaryRoots.push(userData);
    vi.mocked(app.getPath).mockReturnValue(userData);
    const packageResource = resource();
    for (const entry of packageResource.files) {
      await receiveWorkspaceSyncBlob([Buffer.from(entry.content)], entry);
      entry.encoding = 'blob';
      entry.content = '';
    }
    const summary = (await summarizeReconcileResource(packageResource))!.sequence!;
    expect(summary).toMatchObject({
      baseCount: 8,
      annotationCount: 1,
      inspectionUnavailableReason: null,
    });
  });

  it('does not display unverified bases when bytes differ from the reviewed identity', async () => {
    const packageResource = resource();
    packageResource.files[1]!.content = packageResource.files[1]!.content.replace(
      'acgtacgt',
      'ttttacgt'
    );
    const summary = (await summarizeReconcileResource(packageResource))!.sequence!;
    expect(summary.baseCount).toBeUndefined();
    expect(summary.basesSha256).toBeUndefined();
    expect(summary.inspectionUnavailableReason).toMatch(/exact saved sequence bytes/i);
  });

  it('bounds inline inspection independently from package admission or attachment allowances', async () => {
    const packageResource = resource();
    packageResource.files[1] = {
      ...packageResource.files[1]!,
      content: '',
      encoding: 'blob',
      sizeBytes: 3 * 1024 * 1024,
    };
    const summary = (await summarizeReconcileResource(packageResource))!.sequence!;
    expect(summary.baseCount).toBeUndefined();
    expect(summary.productSha256).toBe(packageResource.files[1]!.sha256);
    expect(summary.inspectionUnavailableReason).toMatch(/too large for inline inspection/i);
  });
});
