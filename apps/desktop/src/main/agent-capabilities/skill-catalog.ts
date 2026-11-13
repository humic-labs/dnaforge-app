import type { SkillMutationObservationContext } from './skill-observation-contract';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { parse as parseYaml } from 'yaml';

import type {
  AgentSkillCatalogEntry,
  AgentSkillCatalogInstallRequest,
  AgentSkillCatalogInstallResult,
  AgentSkillCatalogReviewResult,
  AgentSkillCatalogSnapshot,
  AgentSkillAdditionalLicense,
  AgentSkillPackSummary,
} from '../../shared/agent-capability-controls';
import type { AgentTransport } from '../../shared/agent-runtime-ipc';
import type { AgentExtensionStore } from './extension-store';
import {
  BUNDLED_SKILL_CATALOG_SEEDS,
  type BundledSkillCatalogSeed,
} from './skill-catalog-seed.generated';

const MAX_SKILL_FILES = 500;
const MAX_SKILL_BYTES = 25 * 1024 * 1024;
const MAX_CATALOG_RESPONSE_BYTES = 10 * 1024 * 1024;
const CATALOG_REQUEST_TIMEOUT_MS = 15_000;
const REVIEW_TOKEN_LIFETIME_MS = 10 * 60 * 1000;
const PACK_SNAPSHOT_CACHE_MS = 60 * 60 * 1000;
const MAX_RETAINED_SNAPSHOTS = 32;
const MAX_RETAINED_REVIEWS = 64;
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const REVISION = /^[a-f0-9]{40}$/;
const SAFE_PACK_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SAFE_REPOSITORY_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const BUNDLED_TREE_ENTRY =
  /^(?<mode>[0-7]{6}) (?<type>blob) (?<sha>[a-f0-9]{40}) +(?<size>\d+)\t(?<path>[\s\S]+)$/u;

interface AgentSkillPackDefinitionBase {
  id: string;
  name: string;
  publisher: string;
  description: string;
  trust: 'publisher' | 'community';
  repositoryLicense: string | null;
  licenseNotice?: string;
}

export type AgentSkillPackDefinition = AgentSkillPackDefinitionBase &
  (
    | {
        delivery: 'dnaforge';
        repositoryOwner: string;
        repositoryName: string;
        ref: string;
        skillsRoot: string;
      }
    | {
        delivery: 'provider-native';
        provider: AgentTransport;
        sourceUrl: string;
      }
  );

export type DnaforgeSkillPackDefinition = Extract<
  AgentSkillPackDefinition,
  { delivery: 'dnaforge' }
>;

export const CURATED_BIOLOGY_SKILL_PACKS: readonly AgentSkillPackDefinition[] = [
  {
    id: 'k-dense-scientific-agent-skills',
    name: 'Scientific Agent Skills',
    publisher: 'K-Dense AI',
    description:
      'A broad scientific collection covering bioinformatics, genomics, proteins, chemistry, medicine, and research workflows.',
    repositoryOwner: 'K-Dense-AI',
    repositoryName: 'scientific-agent-skills',
    ref: 'main',
    skillsRoot: 'skills',
    delivery: 'dnaforge',
    trust: 'publisher',
    repositoryLicense: 'MIT',
    licenseNotice: 'A skill can declare additional terms for its own bundled models or datasets.',
  },
  {
    id: 'clawbio',
    name: 'ClawBio',
    publisher: 'ClawBio',
    description:
      'Bioinformatics-native skills and runnable workflows for genomics, multi-omics, pharmacogenomics, and reproducible analysis.',
    repositoryOwner: 'ClawBio',
    repositoryName: 'ClawBio',
    ref: 'main',
    skillsRoot: 'skills',
    delivery: 'dnaforge',
    trust: 'publisher',
    repositoryLicense: 'MIT',
    licenseNotice:
      'A skill can override the repository license, and its models or datasets can declare separate terms.',
  },
  {
    id: 'bioconductor-ai-agent-skills',
    name: 'Bioconductor AI Agent Skills',
    publisher: 'Bioconductor',
    description:
      'Agent-neutral workflows for R, Bioconductor package development, and bioinformatics analysis.',
    repositoryOwner: 'Bioconductor',
    repositoryName: 'ai-agent-skills',
    ref: 'devel',
    skillsRoot: 'skills',
    delivery: 'dnaforge',
    trust: 'publisher',
    repositoryLicense: 'MIT',
  },
] as const;

interface GitTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

interface CatalogSkillInternal extends AgentSkillCatalogEntry {
  entries: GitTreeEntry[];
}

interface CatalogSnapshotInternal {
  public: AgentSkillCatalogSnapshot;
  source: DnaforgeSkillPackDefinition;
  skills: Map<string, CatalogSkillInternal>;
}

interface ParsedCatalogSeed {
  revision: string;
  skillCount: number;
  entries: GitTreeEntry[];
}

interface ReviewedSkillInternal {
  expiresAt: number;
  snapshot: CatalogSnapshotInternal;
  skill: CatalogSkillInternal;
  name: string;
  description: string;
  version: string | null;
  license: string;
  additionalLicenses: AgentSkillAdditionalLicense[];
  compatibility: string | null;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must be between 1 and ${maxLength} characters.`);
  }
  return normalized;
}

function optionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  return requiredText(value, label, maxLength);
}

function additionalLicenseLabel(key: string): string {
  const words = key
    .replace(/_license$/u, '')
    .split('_')
    .filter(Boolean)
    .join(' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} license`;
}

function parseAdditionalLicenses(
  metadata: Record<string, unknown>,
  extra: Record<string, unknown>
): AgentSkillAdditionalLicense[] {
  const candidates = new Map<string, unknown>();
  for (const [key, value] of [...Object.entries(metadata), ...Object.entries(extra)]) {
    if (/^[a-z][a-z0-9_]*_license$/u.test(key)) candidates.set(key, value);
  }
  if (candidates.size > 16) {
    throw new Error('The selected skill declares too many license fields.');
  }
  return [...candidates.entries()].flatMap(([key, value]) => {
    const label = additionalLicenseLabel(key);
    const license = optionalText(value, label, 240);
    return license ? [{ key, label, value: license }] : [];
  });
}

function validatePack(pack: AgentSkillPackDefinition): AgentSkillPackDefinition {
  if (
    !SAFE_PACK_ID.test(pack.id) ||
    (pack.delivery === 'dnaforge' &&
      (!SAFE_REPOSITORY_PART.test(pack.repositoryOwner) ||
        !SAFE_REPOSITORY_PART.test(pack.repositoryName) ||
        !pack.ref ||
        pack.ref.length > 160 ||
        (pack.skillsRoot !== '' &&
          pack.skillsRoot.split('/').some((segment) => !SAFE_REPOSITORY_PART.test(segment))))) ||
    (pack.delivery === 'provider-native' &&
      (() => {
        try {
          return new URL(pack.sourceUrl).protocol !== 'https:';
        } catch {
          return true;
        }
      })())
  ) {
    throw new Error('Skill pack definition is invalid.');
  }
  requiredText(pack.name, 'Skill pack name', 160);
  requiredText(pack.publisher, 'Skill pack publisher', 160);
  requiredText(pack.description, 'Skill pack description', 800);
  return pack;
}

function packSummary(pack: AgentSkillPackDefinition): AgentSkillPackSummary {
  return {
    id: pack.id,
    name: pack.name,
    publisher: pack.publisher,
    description: pack.description,
    repositoryUrl:
      pack.delivery === 'dnaforge'
        ? `https://github.com/${pack.repositoryOwner}/${pack.repositoryName}`
        : pack.sourceUrl,
    delivery: pack.delivery,
    provider: pack.delivery === 'provider-native' ? pack.provider : null,
    trust: pack.trust,
    repositoryLicense: pack.repositoryLicense,
    licenseNotice: pack.licenseNotice ?? null,
  };
}

function skillRootForDefinition(
  pack: DnaforgeSkillPackDefinition,
  definitionPath: string
): string | null {
  const prefix = pack.skillsRoot ? `${pack.skillsRoot}/` : '';
  if (!definitionPath.startsWith(prefix) || !definitionPath.endsWith('/SKILL.md')) return null;
  const relativePath = definitionPath.slice(prefix.length, -'/SKILL.md'.length);
  if (!relativePath || relativePath.includes('/') || !SKILL_NAME.test(relativePath)) return null;
  return `${prefix}${relativePath}`;
}

function isSafeRepositoryPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
  );
}

function hasExecutableContent(path: string, mode: string): boolean {
  const normalized = path.toLowerCase();
  return (
    mode === '100755' ||
    normalized.includes('/scripts/') ||
    /\.(?:bash|command|exe|js|mjs|py|rb|sh|ts)$/u.test(normalized)
  );
}

function encodedPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function parseSkillDocument(raw: string): {
  name: string;
  description: string;
  version: string | null;
  license: string | null;
  additionalLicenses: AgentSkillAdditionalLicense[];
  compatibility: string | null;
  allowedTools: string | null;
} {
  const normalized = raw.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(normalized);
  if (!match) throw new Error('The selected skill has no valid SKILL.md frontmatter block.');
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch {
    throw new Error('The selected skill has invalid SKILL.md YAML.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The selected skill has invalid SKILL.md metadata.');
  }
  const metadata = parsed as Record<string, unknown>;
  const extra =
    metadata.metadata && typeof metadata.metadata === 'object' && !Array.isArray(metadata.metadata)
      ? (metadata.metadata as Record<string, unknown>)
      : {};
  return {
    name: requiredText(metadata.name, 'Skill name', 64).toLowerCase(),
    description: requiredText(metadata.description, 'Skill description', 1024),
    version: optionalText(extra.version ?? metadata.version, 'Skill version', 80),
    license: optionalText(metadata.license, 'Skill license', 240),
    additionalLicenses: parseAdditionalLicenses(metadata, extra),
    compatibility: optionalText(metadata.compatibility, 'Skill compatibility', 500),
    allowedTools: optionalText(metadata['allowed-tools'], 'Skill allowed tools', 1000),
  };
}

async function responseBytes(
  response: Response,
  label: string,
  limits: { maxBytes: number; signal: AbortSignal }
): Promise<Uint8Array> {
  const cancelBody = () => {
    void response.body?.cancel().catch(() => undefined);
  };
  if (!response.ok) {
    cancelBody();
    throw new Error(`${label} failed with HTTP ${response.status}.`);
  }
  const declaredBytes = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > limits.maxBytes) {
    cancelBody();
    throw new Error(`${label} response is too large.`);
  }
  if (!response.body) {
    limits.signal.throwIfAborted();
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  limits.signal.addEventListener('abort', cancelReader, { once: true });
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    if (limits.signal.aborted) cancelReader();
    for (;;) {
      limits.signal.throwIfAborted();
      const chunk = await reader.read();
      limits.signal.throwIfAborted();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > limits.maxBytes) throw new Error(`${label} response is too large.`);
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    cancelReader();
    throw error;
  } finally {
    limits.signal.removeEventListener('abort', cancelReader);
    reader.releaseLock();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The skill catalog operation failed.';
}

function parseBundledSeed(seed: BundledSkillCatalogSeed): ParsedCatalogSeed {
  if (!SAFE_PACK_ID.test(seed.packId) || !REVISION.test(seed.revision)) {
    throw new Error('The bundled skill catalog has invalid source metadata.');
  }
  if (!Number.isInteger(seed.skillCount) || seed.skillCount <= 0 || seed.skillCount > 10_000) {
    throw new Error('The bundled skill catalog has an invalid skill count.');
  }
  if (!seed.entries || seed.entries.length > 10 * 1024 * 1024) {
    throw new Error('The bundled skill catalog is empty or too large.');
  }
  const entries = seed.entries.split('\0').map((record): GitTreeEntry => {
    const match = BUNDLED_TREE_ENTRY.exec(record);
    if (!match?.groups) throw new Error('The bundled skill catalog has an invalid tree entry.');
    const size = Number(match.groups.size);
    if (!Number.isSafeInteger(size) || size < 0 || !isSafeRepositoryPath(match.groups.path)) {
      throw new Error('The bundled skill catalog has an unsafe tree entry.');
    }
    return {
      path: match.groups.path,
      mode: match.groups.mode,
      type: match.groups.type,
      sha: match.groups.sha,
      size,
    };
  });
  return { revision: seed.revision, skillCount: seed.skillCount, entries };
}

export class AgentSkillCatalogService {
  private readonly extensionStore: Pick<AgentExtensionStore, 'installCatalogSkill'>;
  private readonly stagingRoot: string;
  private readonly removeStagingDirectory: (path: string) => Promise<void>;
  private readonly sources: Map<string, AgentSkillPackDefinition>;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly tokenGenerator: () => string;
  private readonly seeds: Map<string, ParsedCatalogSeed>;
  private readonly snapshots = new Map<string, CatalogSnapshotInternal>();
  private readonly latestSnapshotByPack = new Map<string, string>();
  private readonly reviews = new Map<string, ReviewedSkillInternal>();

  private pruneRetainedState(): void {
    for (const [token, review] of this.reviews) {
      if (review.expiresAt < this.now()) this.reviews.delete(token);
    }
    while (this.snapshots.size > MAX_RETAINED_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (!oldest) break;
      this.snapshots.delete(oldest);
    }
    while (this.reviews.size > MAX_RETAINED_REVIEWS) {
      const oldest = this.reviews.keys().next().value as string | undefined;
      if (!oldest) break;
      this.reviews.delete(oldest);
    }
  }

  constructor(options: {
    extensionStore: Pick<AgentExtensionStore, 'installCatalogSkill'>;
    stagingRoot: string;
    removeStagingDirectory?: (path: string) => Promise<void>;
    sources?: readonly AgentSkillPackDefinition[];
    fetch?: Fetcher;
    now?: () => number;
    idGenerator?: () => string;
    tokenGenerator?: () => string;
    seeds?: readonly BundledSkillCatalogSeed[];
  }) {
    this.extensionStore = options.extensionStore;
    this.stagingRoot = options.stagingRoot;
    this.removeStagingDirectory =
      options.removeStagingDirectory ?? ((path) => rm(path, { recursive: true, force: true }));
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.tokenGenerator = options.tokenGenerator ?? randomUUID;
    const sources = (options.sources ?? CURATED_BIOLOGY_SKILL_PACKS).map(validatePack);
    this.sources = new Map(sources.map((source) => [source.id, source]));
    const seeds = options.seeds ?? (options.sources ? [] : BUNDLED_SKILL_CATALOG_SEEDS);
    this.seeds = new Map(
      seeds.map((seed) => {
        const parsed = parseBundledSeed(seed);
        return [seed.packId, parsed];
      })
    );
  }

  listPacks(): AgentSkillPackSummary[] {
    return [...this.sources.values()].map(packSummary);
  }

  private async fetchJson(url: string, label: string): Promise<Record<string, unknown>> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.github.com') {
      throw new Error('Skill catalog requests must use the approved GitHub API host.');
    }
    const signal = AbortSignal.timeout(CATALOG_REQUEST_TIMEOUT_MS);
    const response = await this.fetcher(url, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const bytes = await responseBytes(response, label, {
      maxBytes: MAX_CATALOG_RESPONSE_BYTES,
      signal,
    });
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label} returned an invalid response.`);
    }
    return value as Record<string, unknown>;
  }

  private createSnapshot(
    source: DnaforgeSkillPackDefinition,
    revision: string,
    entries: GitTreeEntry[],
    expectedSkillCount?: number
  ): AgentSkillCatalogSnapshot {
    if (!REVISION.test(revision)) throw new Error('Skill source returned an invalid revision.');
    const roots = entries.flatMap((entry) => {
      const root = skillRootForDefinition(source, entry.path);
      return root ? [root] : [];
    });
    const skills = new Map<string, CatalogSkillInternal>();
    for (const root of [...new Set(roots)].sort()) {
      const skillEntries = entries.filter(
        (entry) => entry.path === root || entry.path.startsWith(`${root}/`)
      );
      const blobs = skillEntries.filter((entry) => entry.type !== 'tree');
      const byteCount = blobs.reduce((total, entry) => {
        const size = entry.size;
        return total + (typeof size === 'number' && Number.isInteger(size) && size >= 0 ? size : 0);
      }, 0);
      const skill: CatalogSkillInternal = {
        id: root,
        name: basename(root),
        fileCount: blobs.length,
        byteCount,
        hasScripts: blobs.some((entry) => hasExecutableContent(entry.path, entry.mode)),
        entries: skillEntries,
      };
      skills.set(skill.id, skill);
    }
    if (expectedSkillCount !== undefined && skills.size !== expectedSkillCount) {
      throw new Error('The bundled skill catalog does not match its declared skill count.');
    }
    const snapshotId = this.idGenerator();
    const publicSnapshot: AgentSkillCatalogSnapshot = {
      schemaVersion: 1,
      snapshotId,
      packId: source.id,
      revision,
      capturedAt: this.now(),
      skills: [...skills.values()].map(({ entries: _entries, ...skill }) => skill),
    };
    this.snapshots.set(snapshotId, { public: publicSnapshot, source, skills });
    this.latestSnapshotByPack.set(source.id, snapshotId);
    this.pruneRetainedState();
    return publicSnapshot;
  }

  async browsePack(input: {
    packId: string;
    forceRefresh?: boolean;
  }): Promise<AgentSkillCatalogSnapshot> {
    const source = this.sources.get(input.packId);
    if (!source) throw new Error('This skill pack is not in the DNAForge catalog.');
    if (source.delivery !== 'dnaforge') {
      throw new Error('Manage this provider-owned pack in its CLI section.');
    }
    if (!input.forceRefresh) {
      const cachedSnapshotId = this.latestSnapshotByPack.get(source.id);
      const cachedSnapshot = cachedSnapshotId ? this.snapshots.get(cachedSnapshotId) : null;
      if (
        cachedSnapshot &&
        this.now() - cachedSnapshot.public.capturedAt < PACK_SNAPSHOT_CACHE_MS
      ) {
        return cachedSnapshot.public;
      }
    }
    try {
      const base = `https://api.github.com/repos/${source.repositoryOwner}/${source.repositoryName}`;
      const commit = await this.fetchJson(
        `${base}/commits/${encodeURIComponent(source.ref)}`,
        'Skill source revision'
      );
      const revision = requiredText(commit.sha, 'Skill source revision', 40).toLowerCase();
      if (!REVISION.test(revision)) throw new Error('Skill source returned an invalid revision.');
      const tree = await this.fetchJson(
        `${base}/git/trees/${revision}?recursive=1`,
        'Skill source tree'
      );
      if (tree.truncated === true) {
        throw new Error(
          'DNAForge could not obtain the complete source tree, so no partial catalog was shown.'
        );
      }
      if (!Array.isArray(tree.tree)) throw new Error('Skill source returned an invalid tree.');
      const entries: GitTreeEntry[] = tree.tree.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const entry = value as Record<string, unknown>;
        return typeof entry.path === 'string' &&
          typeof entry.mode === 'string' &&
          typeof entry.type === 'string' &&
          typeof entry.sha === 'string'
          ? [
              {
                path: entry.path,
                mode: entry.mode,
                type: entry.type,
                sha: entry.sha,
                ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
              },
            ]
          : [];
      });
      return this.createSnapshot(source, revision, entries);
    } catch (error) {
      const seed = this.seeds.get(source.id);
      if (!seed) throw error;
      return this.createSnapshot(source, seed.revision, seed.entries, seed.skillCount);
    }
  }

  private validateSkillEntries(skill: CatalogSkillInternal): GitTreeEntry[] {
    const entries = skill.entries.filter((entry) => entry.type !== 'tree');
    if (entries.length === 0 || entries.length > MAX_SKILL_FILES) {
      throw new Error('The selected skill exceeds the 500-file review limit.');
    }
    let byteCount = 0;
    for (const entry of entries) {
      if (!isSafeRepositoryPath(entry.path))
        throw new Error('The selected skill has an unsafe path.');
      if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
        if (entry.mode === '120000')
          throw new Error('Online skills cannot contain symbolic links.');
        throw new Error('Online skills may contain only ordinary files and directories.');
      }
      const size = entry.size;
      if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
        throw new Error('The selected skill has an invalid file size.');
      }
      byteCount += size;
      if (byteCount > MAX_SKILL_BYTES) {
        throw new Error('The selected skill exceeds the 25 MB review limit.');
      }
    }
    return entries;
  }

  private rawUrl(snapshot: CatalogSnapshotInternal, path: string): string {
    const { source } = snapshot;
    return `https://raw.githubusercontent.com/${source.repositoryOwner}/${source.repositoryName}/${snapshot.public.revision}/${encodedPath(path)}`;
  }

  private async fetchRaw(snapshot: CatalogSnapshotInternal, path: string): Promise<Uint8Array> {
    const url = this.rawUrl(snapshot, path);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'raw.githubusercontent.com') {
      throw new Error('Skill files must use the approved GitHub content host.');
    }
    const signal = AbortSignal.timeout(CATALOG_REQUEST_TIMEOUT_MS);
    return responseBytes(
      await this.fetcher(url, { method: 'GET', redirect: 'error', signal }),
      `Skill file ${path}`,
      { maxBytes: MAX_SKILL_BYTES, signal }
    );
  }

  async reviewSkill(input: {
    snapshotId: string;
    skillId: string;
  }): Promise<AgentSkillCatalogReviewResult> {
    try {
      const snapshot = this.snapshots.get(input.snapshotId);
      const skill = snapshot?.skills.get(input.skillId);
      if (!snapshot || !skill) throw new Error('Refresh this skill pack before reviewing it.');
      const entries = this.validateSkillEntries(skill);
      const definition = entries.find((entry) => entry.path === `${skill.id}/SKILL.md`);
      if (!definition) throw new Error('The selected skill has no SKILL.md file.');
      const bytes = await this.fetchRaw(snapshot, definition.path);
      if (bytes.byteLength !== definition.size) {
        throw new Error('The selected skill changed while it was being reviewed.');
      }
      const document = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parsed = parseSkillDocument(document);
      if (!SKILL_NAME.test(parsed.name) || parsed.name !== skill.name) {
        throw new Error('The SKILL.md name does not match its source directory.');
      }
      const license = parsed.license ?? snapshot.source.repositoryLicense;
      const installable = license !== null;
      const reviewToken = this.tokenGenerator();
      if (installable && license) {
        this.reviews.set(reviewToken, {
          expiresAt: this.now() + REVIEW_TOKEN_LIFETIME_MS,
          snapshot,
          skill,
          name: parsed.name,
          description: parsed.description,
          version: parsed.version,
          license,
          additionalLicenses: parsed.additionalLicenses,
          compatibility: parsed.compatibility,
        });
        this.pruneRetainedState();
      }
      return {
        ok: true,
        reviewToken,
        skill: {
          ...packSummary(snapshot.source),
          packId: snapshot.source.id,
          packName: snapshot.source.name,
          skillId: skill.id,
          name: parsed.name,
          description: parsed.description,
          revision: snapshot.public.revision,
          version: parsed.version,
          license,
          additionalLicenses: parsed.additionalLicenses,
          compatibility: parsed.compatibility,
          allowedTools: parsed.allowedTools,
          fileCount: skill.fileCount,
          byteCount: skill.byteCount,
          hasScripts: skill.hasScripts,
          installable,
          installBlockReason: installable ? null : 'missing-license',
          delivery: snapshot.source.delivery,
          provider: null,
          document,
          files: entries
            .map((entry) => ({
              path: relative(skill.id, entry.path),
              byteCount: entry.size ?? 0,
            }))
            .sort((left, right) => left.path.toLowerCase().localeCompare(right.path.toLowerCase())),
        },
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async installSkill(
    input: AgentSkillCatalogInstallRequest,
    observation?: SkillMutationObservationContext | null
  ): Promise<AgentSkillCatalogInstallResult> {
    this.pruneRetainedState();
    const reviewed = this.reviews.get(input.reviewToken);
    if (!reviewed || reviewed.expiresAt < this.now()) {
      this.reviews.delete(input.reviewToken);
      return { ok: false, error: 'Review this skill again before installing it.' };
    }
    this.reviews.delete(input.reviewToken);
    if (input.scope === 'workspace' && !input.workspacePath) {
      return { ok: false, error: 'Choose a workspace before installing a workspace skill.' };
    }
    let stagingDirectory: string | null = null;
    let stage: 'review' | 'staging' | 'download' | 'commit' = 'review';
    let outcome: AgentSkillCatalogInstallResult;
    try {
      const entries = this.validateSkillEntries(reviewed.skill);
      stage = 'staging';
      await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
      stagingDirectory = await mkdtemp(join(this.stagingRoot, 'skill-'));
      const digest = createHash('sha256');
      for (const entry of entries.sort((left, right) => left.path.localeCompare(right.path))) {
        const relativePath = relative(reviewed.skill.id, entry.path);
        if (!relativePath || relativePath.startsWith('..') || !isSafeRepositoryPath(relativePath)) {
          throw new Error('The selected skill has an unsafe file path.');
        }
        stage = 'download';
        const bytes = await this.fetchRaw(reviewed.snapshot, entry.path);
        if (bytes.byteLength !== entry.size) {
          throw new Error('The selected skill changed while it was being downloaded.');
        }
        const target = resolve(stagingDirectory, relativePath);
        const relativeTarget = relative(stagingDirectory, target);
        if (!relativeTarget || relativeTarget.startsWith('..')) {
          throw new Error('The selected skill has an unsafe file path.');
        }
        stage = 'staging';
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
        digest.update(relativePath).update('\0').update(bytes).update('\0');
      }
      stage = 'commit';
      const persistInput: Parameters<AgentExtensionStore['installCatalogSkill']>[0] = {
        sourcePath: stagingDirectory,
        provider: input.provider,
        scope: input.scope,
        workspacePath: input.scope === 'global' ? null : input.workspacePath,
        source: {
          packId: reviewed.snapshot.source.id,
          packName: reviewed.snapshot.source.name,
          publisher: reviewed.snapshot.source.publisher,
          repositoryUrl: packSummary(reviewed.snapshot.source).repositoryUrl,
          skillPath: reviewed.skill.id,
          revision: reviewed.snapshot.public.revision,
          version: reviewed.version,
          license: reviewed.license,
          additionalLicenses: reviewed.additionalLicenses,
          compatibility: reviewed.compatibility,
        },
        contentDigest: digest.digest('hex'),
      };
      const installed = await (observation
        ? this.extensionStore.installCatalogSkill(persistInput, observation)
        : this.extensionStore.installCatalogSkill(persistInput));
      outcome = { ok: true, skillId: installed.id };
    } catch (error) {
      outcome = { ok: false, error: errorMessage(error), stage };
    }
    if (stagingDirectory) {
      try {
        await this.removeStagingDirectory(stagingDirectory);
      } catch {
        outcome = { ...outcome, cleanupIncomplete: true };
      }
    }

    return outcome;
  }
}
