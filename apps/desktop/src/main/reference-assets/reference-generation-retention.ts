import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  parseReferenceAssetPublicationV1,
  REFERENCE_ASSET_PUBLICATION_FILE,
} from '../../features/sequence/reference-asset-publication';
import type { ReferenceAssetWriterLease } from './reference-asset-writer-lock';
import { readReferenceVersionHistory } from './installed-hosted-reference';
import {
  isOwnedReferenceGenerationId,
  isScopedReferenceGenerationId,
} from './reference-generation-ownership';

export interface OpenReferenceVersion {
  readonly catalogId: string;
  readonly generationId: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function validVersion(version: OpenReferenceVersion): boolean {
  return (
    SAFE_ID.test(version.catalogId) &&
    SAFE_ID.test(version.generationId) &&
    !['.', '..'].includes(version.catalogId) &&
    !['.', '..'].includes(version.generationId)
  );
}

export class ReferenceGenerationRetention {
  private readonly rendererVersions = new Map<number, readonly OpenReferenceVersion[]>();
  private readonly preparationVersions = new Map<string, OpenReferenceVersion>();
  private readonly openingVersions = new Map<
    number,
    Map<string, { version: OpenReferenceVersion; expires: number }>
  >();
  private readonly leasePath: string;
  private readonly cacheRoot: string;
  private readonly ownedPublicationRoot: string;
  private writeTail = Promise.resolve();
  private collection: Promise<readonly string[]> | null = null;
  private rendererRestored = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly input: {
      readonly cacheRoot: string;
      readonly publicationRoots: readonly string[];
      readonly ownedPublicationRoot?: string;
      readonly catalogIds: readonly string[];
      readonly pinnedVersions?: readonly OpenReferenceVersion[];
      readonly sessionPaths: () => readonly string[];
      readonly onCollected?: (root: string) => void;
      readonly acquireWriterLease?: (familyRoot: string) => Promise<ReferenceAssetWriterLease>;
    }
  ) {
    this.cacheRoot = resolve(input.cacheRoot);
    this.ownedPublicationRoot = resolve(input.ownedPublicationRoot ?? input.cacheRoot);
    this.leasePath = join(
      this.cacheRoot,
      '.reference-generation-leases',
      `${process.pid}-${randomUUID()}.json`
    );
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.collect().catch((error) => console.warn('[reference-retention]', error));
    }, 10_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.collection;
    await this.writeTail;
    await rm(this.leasePath, { force: true });
  }

  async setRendererVersions(
    owner: number,
    versions: readonly OpenReferenceVersion[]
  ): Promise<void> {
    if (versions.length > 256 || !versions.every(validVersion))
      throw new Error('Invalid open reference versions.');
    this.rendererRestored = true;
    this.rendererVersions.set(owner, versions);
    const openings = this.openingVersions.get(owner);
    for (const version of versions) openings?.delete(this.key(version));
    await this.checkpoint();
    void this.collect().catch((error) => console.warn('[reference-retention]', error));
  }

  async pinOpening(owner: number, version: OpenReferenceVersion): Promise<void> {
    if (!validVersion(version)) return;
    let versions = this.openingVersions.get(owner);
    if (!versions) this.openingVersions.set(owner, (versions = new Map()));
    versions.set(this.key(version), { version, expires: Date.now() + 10 * 60_000 });
    await this.checkpoint();
  }

  releaseRenderer(owner: number): void {
    this.rendererVersions.delete(owner);
    this.openingVersions.delete(owner);
    void this.collect().catch((error) => console.warn('[reference-retention]', error));
  }

  async retainPreparation(generationRoot: string): Promise<() => void> {
    const version = this.versionForPath(generationRoot);
    if (!version) return () => undefined;
    const id = randomUUID();
    this.preparationVersions.set(id, version);
    await this.checkpoint();
    return () => {
      this.preparationVersions.delete(id);
      void this.collect().catch((error) => console.warn('[reference-retention]', error));
    };
  }

  checkpoint(): Promise<void> {
    const next = this.writeTail.then(async () => {
      const directory = join(this.cacheRoot, '.reference-generation-leases');
      await mkdir(directory, { recursive: true });
      if (!(await this.plainDirectory(directory)))
        throw new Error('Reference lease directory is not owned by the cache.');
      const temporary = `${this.leasePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          JSON.stringify({ pid: process.pid, versions: this.localVersions() }),
          { flag: 'wx', mode: 0o600 }
        );
        await rename(temporary, this.leasePath);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.writeTail = next.catch(() => undefined);
    return next;
  }

  collect(): Promise<readonly string[]> {
    if (this.collection) return this.collection;
    const pending = this.collectExclusive().finally(() => {
      if (this.collection === pending) this.collection = null;
    });
    this.collection = pending;
    return pending;
  }

  private async collectExclusive(): Promise<readonly string[]> {
    if (!this.rendererRestored) return [];
    await this.checkpoint();
    const deleted: string[] = [];
    const catalogIds = [
      ...new Set([
        ...this.input.catalogIds,
        ...(await readdir(this.cacheRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
          .map((entry) => entry.name),
      ]),
    ];
    for (const catalogId of catalogIds) {
      if (!SAFE_ID.test(catalogId)) continue;
      const familyRoot = join(this.cacheRoot, catalogId);
      const generationParent = join(familyRoot, 'generations');
      if (!(await this.plainDirectory(generationParent))) continue;
      const lease = await this.input.acquireWriterLease?.(familyRoot);
      try {
        const protectedVersions = await this.protectedVersions(catalogIds);
        const ownedAssemblyRoot = join(this.ownedPublicationRoot, catalogId);
        const ownedCurrent = await readFile(
          join(ownedAssemblyRoot, REFERENCE_ASSET_PUBLICATION_FILE),
          'utf8'
        )
          .then((text) => parseReferenceAssetPublicationV1(JSON.parse(text), catalogId))
          .catch(() => null);
        const ownedCurrentRoot = ownedCurrent
          ? join(generationParent, ownedCurrent.publicationId)
          : null;
        const ownedCurrentDefinition =
          ownedCurrentRoot && (await this.plainDirectory(ownedCurrentRoot))
            ? await lstat(join(ownedCurrentRoot, 'prepared-reference-definition.v1.json')).catch(
                () => null
              )
            : null;
        if (!ownedCurrentDefinition?.isFile() || ownedCurrentDefinition.isSymbolicLink()) continue;
        const ownedHistory =
          this.ownedPublicationRoot === this.cacheRoot
            ? new Set(
                (await readReferenceVersionHistory(familyRoot)).map(
                  (version) => version.bundleFingerprint
                )
              )
            : new Set<string>();
        for (const name of await readdir(generationParent)) {
          const version = { catalogId, generationId: name };
          if (!validVersion(version) || protectedVersions.has(this.key(version))) continue;
          const generationRoot = join(generationParent, name);
          if (!(await this.plainDirectory(generationRoot))) continue;
          if (isScopedReferenceGenerationId(name)) {
            if (!isOwnedReferenceGenerationId(name, ownedAssemblyRoot)) continue;
            const definition = await lstat(
              join(generationRoot, 'prepared-reference-definition.v1.json')
            ).catch(() => null);
            if (!definition?.isFile() || definition.isSymbolicLink()) continue;
          } else if (!ownedHistory.has(name)) continue;
          await lease?.assertOwned();
          if ((await this.protectedVersions(catalogIds)).has(this.key(version))) continue;
          await rm(generationRoot, { recursive: true, force: true });
          this.input.onCollected?.(generationRoot);
          deleted.push(generationRoot);
        }
      } finally {
        await lease?.release();
      }
    }
    return deleted;
  }

  private async protectedVersions(catalogIds: readonly string[]): Promise<Set<string>> {
    const protectedVersions = new Set(this.localVersions().map((version) => this.key(version)));
    for (const root of this.input.publicationRoots) {
      for (const catalogId of catalogIds) {
        try {
          const pointer = parseReferenceAssetPublicationV1(
            JSON.parse(
              await readFile(join(root, catalogId, REFERENCE_ASSET_PUBLICATION_FILE), 'utf8')
            ),
            catalogId
          );
          if (pointer)
            protectedVersions.add(this.key({ catalogId, generationId: pointer.publicationId }));
        } catch {}
      }
    }
    const directory = join(this.cacheRoot, '.reference-generation-leases');
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      try {
        const path = join(directory, name);
        const file = await lstat(path);
        if (!file.isFile() || file.isSymbolicLink() || file.size > 1024 * 1024)
          throw new Error('Unreadable reference lease.');
        const lease = JSON.parse(await readFile(path, 'utf8')) as {
          pid: number;
          versions: OpenReferenceVersion[];
        };
        if (
          !Number.isSafeInteger(lease.pid) ||
          lease.pid <= 0 ||
          !Array.isArray(lease.versions) ||
          !lease.versions.every(validVersion)
        )
          throw new Error('Invalid reference lease.');
        try {
          process.kill(lease.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            await rm(path, { force: true });
            continue;
          }
        }
        for (const version of lease.versions) protectedVersions.add(this.key(version));
      } catch {
        for (const catalogId of catalogIds) {
          for (const generationId of await readdir(
            join(this.cacheRoot, catalogId, 'generations')
          ).catch(() => [] as string[]))
            protectedVersions.add(this.key({ catalogId, generationId }));
        }
      }
    }
    return protectedVersions;
  }

  private localVersions(): OpenReferenceVersion[] {
    const versions = [...this.rendererVersions.values()].flatMap((value) => [...value]);
    versions.push(...(this.input.pinnedVersions ?? []).filter(validVersion));
    versions.push(...this.preparationVersions.values());
    for (const openings of this.openingVersions.values())
      for (const [key, opening] of openings) {
        if (opening.expires <= Date.now()) openings.delete(key);
        else versions.push(opening.version);
      }
    for (const path of this.input.sessionPaths()) {
      const version = this.versionForPath(path);
      if (version) versions.push(version);
    }
    return [...new Map(versions.map((version) => [this.key(version), version])).values()];
  }

  private versionForPath(path: string): OpenReferenceVersion | null {
    const parts = relative(this.cacheRoot, resolve(path)).split(sep);
    if (parts[1] !== 'generations') return null;
    const version = { catalogId: parts[0] ?? '', generationId: parts[2] ?? '' };
    return validVersion(version) ? version : null;
  }

  private key(version: OpenReferenceVersion): string {
    return `${version.catalogId}/${version.generationId}`;
  }

  private async plainDirectory(path: string): Promise<boolean> {
    const file = await lstat(path).catch(() => null);
    if (!file?.isDirectory() || file.isSymbolicLink()) return false;
    const canonicalRoot = await realpath(this.cacheRoot);
    return (await realpath(path)) === resolve(canonicalRoot, relative(this.cacheRoot, path));
  }
}
