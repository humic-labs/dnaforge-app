import type Database from 'better-sqlite3';
import { retainTrackProjectionSource } from './retain-track-projection-source';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import {
  MAX_CONTACT_SOURCE_BYTES,
  contactSourceDocumentSchema,
  contactSourceReadRequestSchema,
  projectContactSource,
  type ContactSourceReadResult,
} from '../shared/contact-source';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import { canonicalWorkspacePath } from './primer-artifact-files';

interface Dependencies {
  resolveProject(project: string): Promise<string>;
  captureReadable(root: string): (() => void) | Promise<() => void>;
}

export class ContactSourceCommands {
  constructor(private readonly dependencies: Dependencies) {}

  async retain(db: Database.Database, input: unknown, blobRoot?: string): Promise<void> {
    const request = contactSourceReadRequestSchema.parse(input);
    return retainTrackProjectionSource(
      db,
      {
        project: request.project,
        entityId: 'contact:' + request.source.sha256,
        sha256: request.source.sha256,
      },
      this.dependencies,
      (root) => this.read({ project: root, source: request.source }),
      blobRoot
    );
  }

  async read(input: unknown): Promise<ContactSourceReadResult> {
    const request = contactSourceReadRequestSchema.parse(input);
    const root = await this.dependencies.resolveProject(request.project);
    if (!isAbsolute(root)) {
      throw new Error('The contact source project must have an absolute canonical root.');
    }
    const assertCurrent = await this.dependencies.captureReadable(root);
    assertCurrent();
    const canonical = await canonicalWorkspacePath({
      workspaceRoot: root,
      path: resolve(root, request.source.path),
      artifactNoun: 'contact source',
    });
    if (canonical.root !== root) {
      throw new Error('The contact source project root must be canonical.');
    }
    assertCurrent();
    const bytes = await readFileBoundedFromHandle(canonical.candidate, MAX_CONTACT_SOURCE_BYTES);
    const revision = createHash('sha256').update(bytes).digest('hex');
    if (revision !== request.source.sha256) {
      throw new Error('The contact source fingerprint does not match the saved descriptor.');
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const document = contactSourceDocumentSchema.parse(JSON.parse(content));
    const projection = projectContactSource(document, request.source);
    assertCurrent();
    return {
      projection,
      label: document.label,
      unit: document.unit,
      revision,
      path: canonical.candidate,
    };
  }
}
