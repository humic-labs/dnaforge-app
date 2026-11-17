import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { parseGenomeComparisonPaf } from '@waypoint/genome-data';
import {
  MAX_COMPARISON_SOURCE_BYTES,
  comparisonSourceProjectionId,
  comparisonSourceReadRequestSchema,
  type ComparisonSourceReadResult,
} from '../shared/comparison-source';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import { canonicalWorkspacePath } from './primer-artifact-files';

interface Dependencies {
  resolveProject(project: string): Promise<string>;
  captureReadable(root: string): (() => void) | Promise<() => void>;
}

export class ComparisonSourceCommands {
  constructor(private readonly dependencies: Dependencies) {}

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
    assertCurrent();
    return {
      comparison,
      projectionId: comparisonSourceProjectionId(source),
      label: `${source.targetReference.label ?? source.targetReference.chrom} ↔ ${source.queryReference.label ?? source.queryReference.chrom}`,
      revision,
      path: canonical.candidate,
    };
  }
}
