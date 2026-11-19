import { platform } from '../../platform';
import type { HandlerFamilyId } from '../../shared/file-associations';
import type { ExternalPreviewReceipt } from '../../shared/file-association-ipc';
import type { DedupPreviewItem } from '../../shared/import-dedup';
import type { ImportFileRequest, ImportFileResult } from '../../shared/workspace-git-types';

export class ImportPackageSession {
  private readonly sources = new Map<
    string,
    Promise<{ receipt: ExternalPreviewReceipt; inputPath: string }>
  >();
  private closed = false;

  async capture(sourcePath: string, familyId: HandlerFamilyId): Promise<string> {
    if (this.closed) throw new Error('This import has closed.');
    const pending = this.sources.get(sourcePath) ?? this.acquire(sourcePath, familyId);
    this.sources.set(sourcePath, pending);
    return (await pending).inputPath;
  }

  private async acquire(sourcePath: string, familyId: HandlerFamilyId) {
    const api = platform().fileAssociations;
    const receipt = await api.openPreview({ sourcePath, familyId });
    try {
      const inputPath = await api.resolvePreviewImportSource({ receipt });
      return { receipt, inputPath };
    } catch (error) {
      await api.releasePreview({ receipt });
      throw error;
    }
  }

  async verifiedInput(path: string): Promise<string> {
    const source = await this.sources.get(path);
    return source
      ? platform().fileAssociations.resolvePreviewImportSource({ receipt: source.receipt })
      : path;
  }

  async previewDedup(request: {
    sourcePaths: string[];
    targetRoot: string;
  }): Promise<DedupPreviewItem[]> {
    const originals = new Map<string, string>();
    for (const path of request.sourcePaths) originals.set(await this.verifiedInput(path), path);
    const results = await platform().workspace.previewImportDedup({
      sourcePaths: [...originals.keys()],
      targetRoot: request.targetRoot,
    });
    return results.map((result) => ({
      ...result,
      sourcePath: originals.get(result.sourcePath) ?? result.sourcePath,
    }));
  }

  async importFile(request: ImportFileRequest): Promise<ImportFileResult> {
    const source = await this.sources.get(request.sourcePath);
    if (!source) return platform().workspace.importFile(request);
    if (request.dedup) {
      return platform().workspace.importFile({
        ...request,
        sourcePath: await this.verifiedInput(request.sourcePath),
      });
    }
    const result = await platform().fileAssociations.savePreview({
      receipt: source.receipt,
      destination: { kind: 'existing-workspace', rootPath: request.targetRoot },
    });
    return {
      destPath: result.destPath,
      relPath: result.relPath,
      committed: result.committed,
      packageProductPaths: result.records.map((record) => record.destPath),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const held = await Promise.allSettled(this.sources.values());
    this.sources.clear();
    await Promise.all(
      held.flatMap((entry) =>
        entry.status === 'fulfilled'
          ? [platform().fileAssociations.releasePreview({ receipt: entry.value.receipt })]
          : []
      )
    );
  }
}
