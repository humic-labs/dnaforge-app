import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { RegisteredProjectAuthority } from './registered-project-authority';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';

const rootsSchema = z.array(z.string().min(1).max(4096).refine(isAbsolute)).max(128);

export class NativeDocumentWorkspaces {
  private observedWritable = new Set<string>();
  private observedReadable = new Set<string>();
  private readonly authority: RegisteredProjectAuthority;

  constructor(options: { authority: RegisteredProjectAuthority }) {
    this.authority = options.authority;
  }

  roots(): readonly string[] {
    return this.authority
      .list()
      .filter((project) => !project.pinned)
      .map((project) => project.path);
  }

  readableRoots(): readonly string[] {
    return this.authority.list().map((project) => project.path);
  }

  access(root: string): { readOnly: boolean } | null {
    const project = this.authority.resolve(root);
    return project ? { readOnly: project.pinned } : null;
  }

  observedRoots(): readonly string[] {
    return [...this.observedWritable];
  }

  observedReadableRoots(): readonly string[] {
    return [...this.observedReadable];
  }

  async replaceRoots(
    roots: readonly string[],
    stillCurrent: () => boolean = () => true,
    readableRoots: readonly string[] = roots
  ): Promise<boolean> {
    const submitted = rootsSchema.parse(roots);
    const submittedReadable = rootsSchema.parse(readableRoots);
    const projects = this.authority.list();
    if (!stillCurrent()) return false;
    const observedReadable = new Set(submittedReadable.map(workspaceMutationRootIdentity));
    const observedWritable = new Set(submitted.map(workspaceMutationRootIdentity));
    this.observedWritable = new Set(
      projects
        .filter((project) => !project.pinned && observedWritable.has(project.path))
        .map((project) => project.path)
    );
    this.observedReadable = new Set(
      projects
        .filter((project) => observedReadable.has(project.path))
        .map((project) => project.path)
    );
    return true;
  }

  captureReadable(root: string): () => void {
    const project = this.authority.resolve(root);
    if (!project) throw new Error('The registered project is not readable.');
    return this.authority.capture(project.projectId);
  }

  capture(root: string): () => void {
    const project = this.authority.resolve(root);
    if (!project) throw new Error('The registered project is not writable.');
    return this.authority.capture(project.projectId, true);
  }
}
