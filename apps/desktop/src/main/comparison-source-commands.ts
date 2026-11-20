import type Database from 'better-sqlite3';
import { retainTrackProjectionSource } from './retain-track-projection-source';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { buildGenomeComparisonLayout, parseGenomeComparisonPaf } from '@waypoint/genome-data';
import {
  MAX_COMPARISON_SOURCE_BYTES,
  comparisonSourceProjectionId,
  comparisonSourceReadRequestSchema,
  comparisonSourceWindowRequestSchema,
  type ComparisonSourceReadResult,
  type ComparisonSourceWindowResult,
} from '../shared/comparison-source';
import {
  readComparisonSourceWindow,
  type ComparisonWindowDependencies,
} from './comparison-source-window';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import { canonicalWorkspacePath } from './primer-artifact-files';

interface Dependencies {
  resolveProject(project: string): Promise<string>;
  captureReadable(root: string): (() => void) | Promise<() => void>;
  readonly references?: ComparisonWindowDependencies;
}

export class ComparisonSourceCommands {
  private readonly layouts = new Map<
    string,
    {
      stamp: string;
      value: ComparisonSourceReadResult;
      layout: ReturnType<typeof buildGenomeComparisonLayout>;
    }
  >();

  constructor(private readonly dependencies: Dependencies) {}

  async retain(db: Database.Database, input: unknown, blobRoot?: string): Promise<void> {
    const request = comparisonSourceReadRequestSchema.parse(input);
    return retainTrackProjectionSource(
      db,
      {
        project: request.project,
        entityId: comparisonSourceProjectionId(request.source),
        sha256: request.source.sha256,
      },
      this.dependencies,
      (root) => this.read({ project: root, source: request.source }),
      blobRoot
    );
  }

  async read(input: unknown): Promise<ComparisonSourceReadResult> {
    const request = comparisonSourceReadRequestSchema.parse(input);
    const root = await this.dependencies.resolveProject(request.project);
    if (!isAbsolute(root)) {
      throw new Error('The comparison source project must have an absolute canonical root.');
    }
    const assertCurrent = await this.dependencies.captureReadable(root);
    assertCurrent();
    const canonical = await canonicalWorkspacePath({
      workspaceRoot: root,
      path: resolve(root, request.source.path),
      artifactNoun: 'comparison source',
    });
    if (canonical.root !== root) {
      throw new Error('The comparison source project root must be canonical.');
    }
    assertCurrent();
    const before = await stat(canonical.candidate);
    const stamp = JSON.stringify([
      before.dev,
      before.ino,
      before.size,
      before.mtimeMs,
      before.ctimeMs,
    ]);
    const key = JSON.stringify([root, request.source]);
    const cached = this.layouts.get(key);
    if (cached?.stamp === stamp) {
      assertCurrent();
      return cached.value;
    }
    const bytes = await readFileBoundedFromHandle(canonical.candidate, MAX_COMPARISON_SOURCE_BYTES);
    const revision = createHash('sha256').update(bytes).digest('hex');
    if (revision !== request.source.sha256) {
      throw new Error('The comparison source fingerprint does not match the saved descriptor.');
    }
    const source = request.source;
    const comparison = parseGenomeComparisonPaf(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      {
        target: { id: source.targetReference.id, length: source.targetReference.length },
        query: { id: source.queryReference.id, length: source.queryReference.length },
        primaryOnly: false,
        minimumAlignmentColumns: 0,
      }
    );
    if (comparison.blocks.length === 0) {
      throw new Error('The comparison source must contain exact gapped alignment blocks.');
    }
    const after = await stat(canonical.candidate);
    if (stamp !== JSON.stringify([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs]))
      throw new Error('The comparison source changed during its bounded read.');
    assertCurrent();
    const value = {
      comparison,
      projectionId: comparisonSourceProjectionId(source),
      label: `${source.targetReference.label ?? source.targetReference.chrom} ↔ ${source.queryReference.label ?? source.queryReference.chrom}`,
      revision,
      path: canonical.candidate,
    };
    if (this.layouts.size >= 4) this.layouts.delete(this.layouts.keys().next().value!);
    this.layouts.set(key, { stamp, value, layout: buildGenomeComparisonLayout(comparison.blocks) });
    return value;
  }

  async readWindow(input: unknown): Promise<ComparisonSourceWindowResult> {
    const request = comparisonSourceWindowRequestSchema.parse(input);
    const value = await this.read({ project: request.project, source: request.source });
    const root = await this.dependencies.resolveProject(request.project);
    const assertCurrent = await this.dependencies.captureReadable(root);
    assertCurrent();
    const key = JSON.stringify([root, request.source]);
    const cached = this.layouts.get(key);
    if (!cached || cached.value !== value)
      throw new Error(
        'The comparison source changed before its window read. Retry the complete request.'
      );
    if (!this.dependencies.references)
      throw new Error('Prepared comparison sources require the native reference owner.');
    const result = await readComparisonSourceWindow(
      request,
      cached.layout,
      this.dependencies.references,
      assertCurrent
    );
    const current = await this.read({ project: request.project, source: request.source });
    if (current.path !== value.path)
      throw new Error('The comparison source project changed during its window read.');
    assertCurrent();
    return result;
  }
}
