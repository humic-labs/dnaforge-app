import type { ComparisonSourceCommands } from './comparison-source-commands';
import { createHash, randomUUID } from 'node:crypto';
import { reconcileTrackView } from './reconcile-track-view';
import type Database from 'better-sqlite3';
import { publishTypedSavedText } from './saved-file-publication';
import { mkdir, readdir, readFile, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  canonicalWorkspacePath,
  WorkspaceFilePreconditionError,
  writeWorkspaceTextFileAtomicInMain,
} from './primer-artifact-files';
import { isPathInsideBoundary } from '../shared/path-boundary';
import {
  TRACK_VIEW_SUFFIX,
  parseTrackViewDocument,
  serializeTrackViewDocument,
  trackViewIdSchema,
  validateTrackViewDocument,
  type SavedTrackView,
  type TrackViewDocument,
  type SaveTrackViewRequest,
  type TrackViewList,
} from '../shared/track-view';

export class TrackViewLibrary {
  constructor(
    private readonly root: string,
    private readonly store?: {
      db(): Database.Database;
      blobRoot?: string;
      comparisons?: Pick<ComparisonSourceCommands, 'retain'>;
      contacts?: Pick<ComparisonSourceCommands, 'retain'>;
    }
  ) {}

  private isLibraryPath(path: string): boolean {
    return isAbsolute(path) && isPathInsideBoundary(resolve(path), resolve(this.root));
  }

  private path(id: string): string {
    return join(this.root, `${trackViewIdSchema.parse(id)}${TRACK_VIEW_SUFFIX}`);
  }

  private locationPath(id: string): string {
    return join(this.root, `${trackViewIdSchema.parse(id)}.location.json`);
  }

  private async location(id: string): Promise<{ path: string; workspaceRoot?: string }> {
    try {
      const value: unknown = JSON.parse(await readFile(this.locationPath(id), 'utf8'));
      if (
        !value ||
        typeof value !== 'object' ||
        !('path' in value) ||
        typeof value.path !== 'string' ||
        !isAbsolute(value.path) ||
        !value.path.endsWith(TRACK_VIEW_SUFFIX) ||
        !('workspaceRoot' in value) ||
        typeof value.workspaceRoot !== 'string' ||
        !isAbsolute(value.workspaceRoot)
      ) {
        throw new Error('Invalid saved view location.');
      }
      return { path: value.path, workspaceRoot: value.workspaceRoot };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { path: this.path(id) };
    }
  }

  private async remember(
    id: string,
    location: { path: string; workspaceRoot: string }
  ): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const path = this.locationPath(id);
    const content = JSON.stringify(location) + '\n';
    let previous: string | null = null;
    try {
      previous = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (previous === content) return;
    await writeWorkspaceTextFileAtomicInMain({
      workspaceRoot: this.root,
      path,
      content,
      artifactNoun: 'view location',
      mode: previous === null ? 'create' : 'replace',
      ...(previous === null
        ? {}
        : { expectedContentHash: createHash('sha256').update(previous).digest('hex') }),
    });
  }

  async read(id: string): Promise<SavedTrackView> {
    const byPath = isAbsolute(id);
    let location = byPath ? { path: id, workspaceRoot: dirname(id) } : await this.location(id);
    const { path } = location;
    if (!path.endsWith(TRACK_VIEW_SUFFIX)) throw new Error('Invalid Track view file.');
    const inLibrary = this.isLibraryPath(path);
    if (inLibrary) await canonicalWorkspacePath({ workspaceRoot: this.root, path });
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid Track view file.');
    const bytes = await readFile(path, 'utf8');
    const document = parseTrackViewDocument(bytes);
    if (!byPath && document.id !== id)
      throw new Error('Track view file identity does not match its library entry.');
    let warning: string | undefined;
    if (byPath) {
      try {
        const known = await this.location(document.id);
        if (known.path === path && known.workspaceRoot) location = known;
      } catch {}
      try {
        await this.remember(document.id, {
          path,
          workspaceRoot: location.workspaceRoot ?? dirname(path),
        });
      } catch {
        warning = `The view file at ${path} is available, but its reference sidebar entry could not be updated.`;
      }
    }
    return {
      document,
      path,
      ...(!inLibrary && location.workspaceRoot ? { workspaceRoot: location.workspaceRoot } : {}),
      revision: createHash('sha256').update(bytes).digest('hex'),
      ...(warning ? { warning } : {}),
    };
  }

  async list(): Promise<TrackViewList> {
    await mkdir(this.root, { recursive: true });
    const result: TrackViewList = { views: [], errors: [] };
    const names = (await readdir(this.root)).sort();
    const ids = new Map<string, string>();
    for (const name of names) {
      if (name.endsWith(TRACK_VIEW_SUFFIX)) {
        try {
          const stat = await lstat(join(this.root, name));
          if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
            throw new Error('Invalid Track view file.');
          const document = parseTrackViewDocument(await readFile(join(this.root, name), 'utf8'));
          ids.set(document.id, name);
        } catch (error) {
          result.errors.push({
            name,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (name.endsWith('.location.json')) {
        const id = name.slice(0, -'.location.json'.length);
        if (!ids.has(id)) ids.set(id, name);
      }
    }
    for (const [id, name] of ids) {
      try {
        result.views.push(
          await this.read(name.endsWith(TRACK_VIEW_SUFFIX) ? join(this.root, name) : id)
        );
      } catch (error) {
        result.errors.push({
          name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    result.views.sort((a, b) => b.document.updatedAt.localeCompare(a.document.updatedAt));
    return result;
  }

  private async saveRecoveredCopy(
    draft: TrackViewDocument,
    expectedRevision: string,
    destination: { workspaceRoot: string; path: string }
  ): Promise<SavedTrackView> {
    const { creationRequest: _request, updatedAt, ...fields } = draft;
    const digest = createHash('sha256')
      .update(expectedRevision)
      .update(JSON.stringify(fields))
      .digest('hex');
    const write = async (suffix: string) => {
      const id = `track-view-${suffix}`;
      const path = join(dirname(destination.path), `${id}${TRACK_VIEW_SUFFIX}`);
      const document = {
        ...fields,
        id,
        name: `${draft.name.slice(0, 183)} (recovered copy)`,
        createdAt: updatedAt,
        updatedAt,
      };
      try {
        return await this.save({
          document,
          expectedRevision: null,
          destination: { ...destination, path },
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== 'A track view artifact already exists at that location.'
        )
          throw error;
        const existing = await this.read(path);
        const sameEdit =
          serializeTrackViewDocument({ ...existing.document, createdAt: updatedAt, updatedAt }) ===
          serializeTrackViewDocument(document);
        return sameEdit ? existing : null;
      }
    };
    const saved = (await write(digest)) ?? (await write(randomUUID()));
    if (!saved) throw new Error('A recovered Track view already exists at the copy destination.');
    return { ...saved, reconciliation: 'saved-copy' };
  }

  async save(request: SaveTrackViewRequest): Promise<SavedTrackView> {
    const content = serializeTrackViewDocument(request.document);
    const document = parseTrackViewDocument(content);
    const location = request.destination ?? (await this.location(document.id));
    const { path } = location;
    const inLibrary = this.isLibraryPath(path);
    if (!path.endsWith(TRACK_VIEW_SUFFIX)) throw new Error('Choose a Track view file destination.');
    if (request.expectedRevision !== null && request.destination) {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
        throw new Error('Invalid Track view file.');
      const current = parseTrackViewDocument(await readFile(path, 'utf8'));
      if (current.id !== document.id) throw new Error('This file belongs to another Track view.');
    }
    if (request.expectedRevision !== null && !/^[a-f0-9]{64}$/u.test(request.expectedRevision)) {
      throw new Error('Invalid saved Track view revision.');
    }
    await mkdir(this.root, { recursive: true });
    let result: Awaited<ReturnType<typeof writeWorkspaceTextFileAtomicInMain>>;
    try {
      const db = this.store?.db() ?? (await import('./ipc/database')).getDb();
      const projection = document.comparisonProjection ?? document.contactProjection;
      if (projection) {
        const owner = document.comparisonProjection
          ? this.store?.comparisons
          : this.store?.contacts;
        if (!owner) throw new Error('The saved projection source requires its admitted project.');
        await owner.retain(
          db,
          { project: projection.project, source: projection.source },
          this.store?.blobRoot
        );
      }
      result = await publishTypedSavedText(
        db,
        {
          workspaceRoot: inLibrary ? undefined : location.workspaceRoot,
          entityId: document.id,
          path,
          content,
          expectedSha256: request.expectedRevision,
          blobRoot: this.store?.blobRoot,
        },
        (mark) =>
          writeWorkspaceTextFileAtomicInMain(
            {
              workspaceRoot: location.workspaceRoot ?? this.root,
              path,
              content,
              artifactNoun: 'track view',
              mode: request.expectedRevision === null ? 'create' : 'replace',
              ...(request.expectedRevision === null
                ? {}
                : { expectedContentHash: request.expectedRevision }),
            },
            { durable: true, beforePublish: mark }
          )
      );
    } catch (error) {
      if (
        !(error instanceof WorkspaceFilePreconditionError) ||
        !request.baseDocument ||
        !request.expectedRevision
      )
        throw error;
      const current = await this.read(path);
      if (current.document.id !== document.id)
        throw new Error('This file belongs to another Track view.');
      const destination = { path, workspaceRoot: location.workspaceRoot ?? this.root };
      const baseline = validateTrackViewDocument(request.baseDocument);
      const capturedDigest = createHash('sha256')
        .update(`${JSON.stringify(request.baseDocument, null, 2)}\n`)
        .digest('hex');
      const merged =
        capturedDigest === request.expectedRevision
          ? reconcileTrackView(baseline, document, current.document)
          : null;
      if (merged) {
        try {
          const saved = await this.save({
            document: merged,
            expectedRevision: current.revision,
            destination,
          });
          return { ...saved, reconciliation: 'merged' };
        } catch (retryError) {
          if (!(retryError instanceof WorkspaceFilePreconditionError)) throw retryError;
        }
      }
      return this.saveRecoveredCopy(document, request.expectedRevision, destination);
    }
    let warning = result.cleanupWarning;
    if (location.workspaceRoot) {
      try {
        await this.remember(document.id, { path, workspaceRoot: location.workspaceRoot });
      } catch {
        warning = `The view file was saved at ${path}, but its reference sidebar entry could not be updated.`;
      }
    }
    return {
      document,
      path,
      ...(!inLibrary && location.workspaceRoot ? { workspaceRoot: location.workspaceRoot } : {}),
      revision: result.contentHash,
      ...(warning ? { warning } : {}),
    };
  }
}
