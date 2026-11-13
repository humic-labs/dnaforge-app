// @vitest-environment node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { IndexedGenomeDataSource } from '@waypoint/genome-data';
import { expect, it } from 'vitest';
import { puc19IndexedManifest } from '../../../../packages/core/genome-data/src/test-support/indexed-fixtures';
import {
  PreparedReferenceObjectStoreV1,
  type PreparedReferenceObjectRefV1,
} from '../hosted/reference-genomes/object-store';
import {
  createGenomeSessionShell,
  updateGenomeSessionShellFromTabState,
} from './genome-session-shell';
import {
  createAnnotationViewportTile,
  validateAnnotationViewportTileRequest,
} from './genome-annotation-tiles';
import type { GenomeTileRequest } from './indexed-genome';

it('preserves real indexed coding intervals through browser object storage and shared tile construction', async () => {
  const manifest = { ...puc19IndexedManifest(), length: 2686 };
  const refs = new Map<string, PreparedReferenceObjectRefV1>();
  const objects = new Map<string, Uint8Array>();
  for (const path of [manifest.fastaPath, manifest.faiPath, manifest.gffPath!, manifest.tbiPath!]) {
    const bytes = new Uint8Array(await readFile(path));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const objectKey = `objects/sha256/${sha256.slice(0, 2)}/${sha256}`;
    refs.set(path, { objectKey, sha256, byteLength: bytes.byteLength });
    objects.set(`https://references.test/${objectKey}`, bytes);
  }
  const requests: string[] = [];
  const store = new PreparedReferenceObjectStoreV1({
    cacheName: null,
    locate: (key) => `https://references.test/${key}`,
    fetch: (async (url, init) => {
      const bytes = objects.get(String(url));
      if (!bytes) return new Response(null, { status: 404 });
      requests.push(String(url));
      const range = new Headers(init?.headers).get('range');
      if (!range) return new Response(bytes, { status: 200 });
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range)!.map(Number);
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` },
      });
    }) as typeof fetch,
  });
  const reader = new IndexedGenomeDataSource(manifest, {
    openFile: (path) => store.openRange(refs.get(path)!),
  });
  try {
    const shell = createGenomeSessionShell({
      source: { sourcePath: manifest.fastaPath, manifest, intent: { kind: 'reference-single' } },
      resolvedSourcePath: manifest.fastaPath,
      stat: { size: refs.get(manifest.fastaPath)!.byteLength, mtimeMs: 0 },
      now: 0,
    });
    const session = updateGenomeSessionShellFromTabState({
      session: shell,
      tabState: {
        sourcePath: manifest.fastaPath,
        sourceExt: '',
        chrom: manifest.chrom,
        manifest,
        metadata: { length: manifest.length, circular: true },
      },
    });
    const request: GenomeTileRequest = {
      trackId: 'puc19:annotations',
      chrom: 'puc19',
      start: 0,
      end: 2686,
      lod: 1,
      generation: 3,
      fidelity: 'exact',
      byteBudget: 512 * 1024,
      annotationOwner: { start: 0, end: 2686 },
    };
    validateAnnotationViewportTileRequest(session, request);
    const features = await reader.getFeatures('puc19', 0, 2686, 1);
    const tile = createAnnotationViewportTile({
      session,
      request,
      requestId: 'coding-page',
      features,
    });
    expect(tile).toMatchObject({
      state: 'ready',
      generation: 3,
      fidelity: 'exact',
      featureModel: 'resolved-transcript-v2',
      sourceRepresentationComplete: true,
    });
    const coding = tile.features!.filter(
      (feature) => 'cds' in feature && Array.isArray(feature.cds)
    );
    expect(coding.length).toBeGreaterThan(0);
    expect(
      coding.every((feature) =>
        (feature as { cds: Array<{ start: number; end: number }> }).cds.every(
          (part) => part.start >= 1 && part.end <= 2686 && part.end > part.start
        )
      )
    ).toBe(true);
    expect(requests).toContain(`https://references.test/${refs.get(manifest.gffPath!)!.objectKey}`);
    expect(requests).toContain(`https://references.test/${refs.get(manifest.tbiPath!)!.objectKey}`);
    const overBudget = createAnnotationViewportTile({
      session,
      request: { ...request, byteBudget: 1 },
      requestId: 'too-small',
      features,
    });
    expect(overBudget).toMatchObject({ state: 'error', sourceRepresentationComplete: false });
    expect(overBudget.features).toBeUndefined();
    expect(() =>
      validateAnnotationViewportTileRequest(session, { ...request, chrom: 'chr13' })
    ).toThrow('chrom mismatch');
  } finally {
    await reader.close();
  }
});
