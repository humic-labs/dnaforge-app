import { createHmac } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { app } from 'electron';

import {
  LOCAL_INDEXED_TRACK_AUTHORITY_CONTRACT,
  type LocalIndexedTrackAuthorityReceipt,
  type LocalIndexedTrackAuthorityRequest,
} from '../shared/local-indexed-track-authority';
import { getDb } from './ipc/database';
import { sidecarSessionAuthority } from './sidecar-session-runtime';
import { findKnownWorkspaceRoot } from './workspace-sync-mutation-lease';
import { isDisposableScenarioProfileAuthorized } from './scenario-profile';
import { isScenarioMutationRequested } from '../shared/scenario-mutation';

const AUTHORITY_SETTING_KEY = 'local_indexed_track_authority.v1';
const MAX_AUTHORIZED_PATHS = 2_048;
const DEV_SCENARIO_BIGWIG_FIXTURE_SUFFIXES = new Set([
  'test-fixtures/indexed/danRer11/pownall-figure-4n/AGS001841.bw',
  'test-fixtures/indexed/danRer11/pownall-figure-4n/AGS002438.bw',
  'test-fixtures/indexed/danRer11/pownall-figure-4n/AGS002440.bw',
  'test-fixtures/indexed/danRer11/pownall-figure-4n/SIS000084.bw',
]);

interface StoredAuthorityRegistry {
  readonly contract: typeof LOCAL_INDEXED_TRACK_AUTHORITY_CONTRACT;
  readonly paths: ReadonlyArray<string>;
}

interface InspectedPath {
  readonly canonicalPath: string;
  readonly isFile: boolean;
}

interface RegistryOptions {
  readonly load: () => string | null;
  readonly save: (value: string) => void;
  readonly currentSessionToken: () => string;
  readonly inspectPath?: (path: string) => InspectedPath;
  readonly workspaceRootFor?: (canonicalPath: string) => string | null;
}

export class LocalIndexedTrackAuthorityRegistry {
  private readonly paths = new Map<string, true>();
  private loaded = false;

  constructor(private readonly options: RegistryOptions) {}

  registerSelectedPaths(paths: ReadonlyArray<string>): void {
    this.load();
    let changed = false;
    for (const path of paths) {
      const inspected = this.inspect(path);
      if (!inspected.isFile) continue;
      this.touch(inspected.canonicalPath);
      changed = true;
    }
    if (changed) this.persist();
  }

  registerEphemeralPaths(paths: ReadonlyArray<string>): void {
    this.load();
    for (const path of paths) {
      const inspected = this.inspect(path);
      if (inspected.isFile) this.touch(inspected.canonicalPath);
    }
  }

  resolveSelectedFilePath(path: string): string {
    this.load();
    const candidate = this.inspect(path);
    if (!candidate.isFile || !this.paths.has(candidate.canonicalPath)) {
      throw new Error('The file was not granted by DNAForge.');
    }
    return candidate.canonicalPath;
  }

  issue(request: LocalIndexedTrackAuthorityRequest): LocalIndexedTrackAuthorityReceipt {
    this.load();
    const candidate = this.inspect(request.path);
    if (!candidate.isFile) {
      throw new Error('The selected indexed genomic source is not a regular file.');
    }

    if (request.relatedManifestPath) {
      const manifest = this.inspect(request.relatedManifestPath);
      if (!this.paths.has(manifest.canonicalPath) || !isTrackManifestPath(manifest.canonicalPath)) {
        throw new Error('The workflow manifest was not selected through the native file picker.');
      }
      if (!isCanonicalChild(manifest.canonicalPath, candidate.canonicalPath)) {
        throw new Error('The workflow output resolves outside the selected manifest directory.');
      }
      this.touch(candidate.canonicalPath);
      this.persist();
    }

    if (request.workspaceGrounded && !this.paths.has(candidate.canonicalPath)) {
      const root = this.options.workspaceRootFor?.(candidate.canonicalPath) ?? null;
      if (!root) {
        throw new Error('This local indexed track is outside every active project.');
      }
      this.touch(candidate.canonicalPath);
    }

    if (!this.paths.has(candidate.canonicalPath)) {
      throw new Error('Select this local indexed track through the DNAForge file picker first.');
    }

    const authority = createHmac('sha256', this.options.currentSessionToken())
      .update(authorityPayload(candidate.canonicalPath), 'utf8')
      .digest('hex');
    return { canonicalPath: candidate.canonicalPath, authority };
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string | null = null;
    try {
      raw = this.options.load();
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredAuthorityRegistry>;
      if (
        parsed.contract !== LOCAL_INDEXED_TRACK_AUTHORITY_CONTRACT ||
        !Array.isArray(parsed.paths)
      ) {
        return;
      }
      for (const path of parsed.paths.slice(-MAX_AUTHORIZED_PATHS)) {
        if (typeof path === 'string' && path.length > 0) this.touch(path);
      }
    } catch {}
  }

  private inspect(path: string): InspectedPath {
    if (!path || path.length > 8_192) throw new Error('The selected local path is invalid.');
    if (this.options.inspectPath) return this.options.inspectPath(path);
    const canonicalPath = realpathSync.native(path);
    return { canonicalPath, isFile: statSync(canonicalPath).isFile() };
  }

  private touch(path: string): void {
    this.paths.delete(path);
    this.paths.set(path, true);
    while (this.paths.size > MAX_AUTHORIZED_PATHS) {
      const oldest = this.paths.keys().next().value as string | undefined;
      if (!oldest) break;
      this.paths.delete(oldest);
    }
  }

  private persist(): void {
    const value: StoredAuthorityRegistry = {
      contract: LOCAL_INDEXED_TRACK_AUTHORITY_CONTRACT,
      paths: [...this.paths.keys()],
    };
    this.options.save(JSON.stringify(value));
  }
}

function authorityPayload(canonicalPath: string): string {
  return `${LOCAL_INDEXED_TRACK_AUTHORITY_CONTRACT}\u0000${canonicalPath}`;
}

function isTrackManifestPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.dnaforge-track.json') || lower.endsWith('.dnaforge-tracks.json');
}

function isCanonicalChild(manifestPath: string, candidatePath: string): boolean {
  const manifestDirectory = normalizePath(dirname(manifestPath));
  const candidate = normalizePath(candidatePath);
  const windowsStyle = /^[a-z]:\//i.test(manifestDirectory);
  const boundary = windowsStyle ? manifestDirectory.toLocaleLowerCase('en-US') : manifestDirectory;
  const comparable = windowsStyle ? candidate.toLocaleLowerCase('en-US') : candidate;
  return comparable.startsWith(`${boundary}/`);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

const productionRegistry = new LocalIndexedTrackAuthorityRegistry({
  load: () => {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(AUTHORITY_SETTING_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  },
  save: (value) => {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(AUTHORITY_SETTING_KEY, value, Date.now());
  },
  currentSessionToken: () => sidecarSessionAuthority.currentToken(),
  workspaceRootFor: (canonicalPath) => findKnownWorkspaceRoot(getDb(), canonicalPath),
});

export function registerSelectedLocalIndexedTrackPaths(paths: ReadonlyArray<string>): void {
  productionRegistry.registerSelectedPaths(paths);
}

export function resolveSelectedLocalFilePath(path: string): string {
  return productionRegistry.resolveSelectedFilePath(path);
}

export function issueLocalIndexedTrackAuthority(
  request: LocalIndexedTrackAuthorityRequest
): LocalIndexedTrackAuthorityReceipt {
  if (request.devScenarioFixture) {
    const allowed = isAllowedDevScenarioIndexedTrackFixture(request.path, {
      scenarioMutationAllowed: isScenarioMutationAllowed(),
      isPackaged: app.isPackaged,
    });
    if (!allowed) {
      throw new Error('The requested local track is not an authorized dev-scenario fixture.');
    }
    productionRegistry.registerEphemeralPaths([request.path]);
  }
  return productionRegistry.issue(request);
}

function isScenarioMutationAllowed(): boolean {
  return (
    isScenarioMutationRequested(process.argv, process.env) &&
    isDisposableScenarioProfileAuthorized(app.getPath('userData'))
  );
}

export function isAllowedDevScenarioIndexedTrackFixture(
  path: string,
  runtime: { scenarioMutationAllowed: boolean; isPackaged: boolean }
): boolean {
  if (!runtime.scenarioMutationAllowed || runtime.isPackaged) return false;
  const normalized = normalizePath(path);
  return [...DEV_SCENARIO_BIGWIG_FIXTURE_SUFFIXES].some(
    (suffix) => normalized === suffix || normalized.endsWith(`/${suffix}`)
  );
}
