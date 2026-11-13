import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { writeWorkspaceTextFileAtomicInMain } from './primer-artifact-files';
import {
  TRACK_VIEW_SUFFIX,
  parseTrackViewDocument,
  serializeTrackViewDocument,
  trackViewIdSchema,
  type SavedTrackView,
  type SaveTrackViewRequest,
  type TrackViewList,
} from '../shared/track-view';

export class TrackViewLibrary {
  constructor(private readonly root: string) {}

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
      ...location,
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

  async save(request: SaveTrackViewRequest): Promise<SavedTrackView> {
    const content = serializeTrackViewDocument(request.document);
    const document = parseTrackViewDocument(content);
    const location = request.destination ?? (await this.location(document.id));
    const { path } = location;
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
    const result = await writeWorkspaceTextFileAtomicInMain({
      workspaceRoot: location.workspaceRoot ?? this.root,
      path,
      content,
      artifactNoun: 'track view',
      mode: request.expectedRevision === null ? 'create' : 'replace',
      ...(request.expectedRevision === null
        ? {}
        : { expectedContentHash: request.expectedRevision }),
    });
    let warning = result.cleanupWarning;
    if (location.workspaceRoot) {
      try {
        await this.remember(document.id, { path, workspaceRoot: location.workspaceRoot });
      } catch {
        warning = `The view file was saved at ${path}, but its reference sidebar entry could not be updated.`;
      }
    }
    return { document, ...location, revision: result.contentHash, ...(warning ? { warning } : {}) };
  }
}
