import { isAbsolute } from 'node:path';
import { z } from 'zod';

const rootsSchema = z.array(z.string().min(1).max(4096).refine(isAbsolute)).max(128);

export class NativeDocumentWorkspaces {
  private readonly resolveRoot: (path: string) => Promise<string>;
  private enrolled = new Map<string, object>();
  private readable = new Map<string, object>();
  private readonly resolveReadableRoot: (path: string) => Promise<string>;
  private request = 0;

  constructor(options: {
    resolveRoot(path: string): Promise<string>;
    resolveReadableRoot?(path: string): Promise<string>;
  }) {
    this.resolveRoot = options.resolveRoot;
    this.resolveReadableRoot = options.resolveReadableRoot ?? options.resolveRoot;
  }

  roots(): readonly string[] {
    return [...this.enrolled.keys()];
  }

  readableRoots(): readonly string[] {
    return [...this.readable.keys()];
  }

  async replaceRoots(
    roots: readonly string[],
    stillCurrent: () => boolean = () => true,
    readableRoots: readonly string[] = roots
  ): Promise<boolean> {
    const submitted = rootsSchema.parse(roots);
    const request = ++this.request;
    const submittedReadable = rootsSchema.parse(readableRoots);
    const [resolved, resolvedReadable] = await Promise.all([
      Promise.all(submitted.map((root) => this.resolveRoot(root))),
      Promise.all(submittedReadable.map((root) => this.resolveReadableRoot(root))),
    ]);
    if (request !== this.request || !stillCurrent()) return false;
    const canonical = rootsSchema.parse(resolved);
    const canonicalReadable = rootsSchema.parse(resolvedReadable);
    this.readable = new Map(
      canonicalReadable.map((root) => [root, this.readable.get(root) ?? Object.freeze({})])
    );
    this.enrolled = new Map(
      canonical.map((root) => [root, this.enrolled.get(root) ?? Object.freeze({})])
    );
    return true;
  }

  captureReadable(root: string): () => void {
    const permit = this.readable.get(root);
    if (!permit) throw new Error('The document workspace is not enrolled for reading.');
    return () => {
      if (this.readable.get(root) !== permit)
        throw new Error('The readable document workspace enrollment changed.');
    };
  }

  capture(root: string): () => void {
    const permit = this.enrolled.get(root);
    if (!permit) throw new Error('The document workspace is not enrolled with this native owner.');
    return () => {
      if (this.enrolled.get(root) !== permit) {
        throw new Error('The document workspace enrollment changed before publication.');
      }
    };
  }
}
