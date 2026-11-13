import { readFileSync } from 'node:fs';
import {
  decodeSkillObservation,
  prepareSkillObservation,
  type CommittedSkillObservation,
  type SkillMutationObservationContext,
  type SkillMutationFacts,
  type SkillReceiptPublisher,
} from './skill-observation-contract';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type {
  AgentManagedCommand as ManagedAgentCommand,
  AgentManagedCommandSaveRequest as SaveManagedAgentCommand,
  AgentManagedCommandScope as ManagedCommandScope,
  AgentManagedProvider as ManagedAgentProvider,
  AgentManagedSkill as ManagedAgentSkill,
  AgentManagedSkillEnabledRequest as ManagedAgentSkillEnabledRequest,
  AgentManagedSkillImportRequest as ImportManagedAgentSkill,
  AgentManagedSkillSaveRequest as SaveManagedAgentSkill,
  AgentManagedSkillScope as ManagedSkillScope,
  AgentManagedSkillSource as ManagedSkillSource,
  AgentProviderSkillPolicyScope,
  AgentSkillAdditionalLicense,
} from '../../shared/agent-capability-controls';

interface ExtensionManifest {
  schemaVersion: 3;
  commands: ManagedAgentCommand[];
  skills: ManagedAgentSkill[];
  providerSkillPolicies: ProviderSkillPolicy[];

  skillOperationReceipt?: CommittedSkillObservation;
}

export interface ProviderSkillPolicy {
  id: string;
  provider: Exclude<ManagedAgentProvider, 'all'>;
  nativeId: string;
  scope: AgentProviderSkillPolicyScope;
  workspacePath: string | null;
  enabled: boolean;
  updatedAt: number;
}

export interface InstallCatalogSkillInput {
  sourcePath: string;
  provider: ManagedAgentProvider;
  scope: ManagedSkillScope;
  workspacePath: string | null;
  source: ManagedSkillSource;
  contentDigest: string;
}

const PROVIDERS = new Set<ManagedAgentProvider>([
  'all',
  'claude-agent-sdk',
  'codex-sdk',
  'grok-acp',
]);
const COMMAND_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SKILL_FILES = 500;
const MAX_SKILL_BYTES = 25 * 1024 * 1024;

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must be between 1 and ${maxLength} characters.`);
  }
  return normalized;
}

function validateCommand(value: unknown): ManagedAgentCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent extension store is corrupt.');
  }
  const input = value as Record<string, unknown>;
  const id = requiredText(input.id, 'Command id', 128);
  const name = requiredText(input.name, 'Command name', 64).toLowerCase();
  const provider = input.provider as ManagedAgentProvider;
  const scope = input.scope as ManagedCommandScope;
  if (!SAFE_ID.test(id) || !COMMAND_NAME.test(name) || !PROVIDERS.has(provider)) {
    throw new Error('Agent extension store is corrupt.');
  }
  if (scope !== 'global' && scope !== 'workspace') {
    throw new Error('Agent extension store is corrupt.');
  }
  const workspacePath = input.workspacePath;
  if (
    (scope === 'workspace' && (typeof workspacePath !== 'string' || !workspacePath)) ||
    (scope === 'global' && workspacePath !== null)
  ) {
    throw new Error('Agent extension store is corrupt.');
  }
  if (
    typeof input.createdAt !== 'number' ||
    !Number.isFinite(input.createdAt) ||
    typeof input.updatedAt !== 'number' ||
    !Number.isFinite(input.updatedAt)
  ) {
    throw new Error('Agent extension store is corrupt.');
  }
  return {
    id,
    name,
    description: requiredText(input.description, 'Command description', 240),
    instructions: requiredText(input.instructions, 'Command instructions', 12_000),
    provider,
    scope,
    workspacePath: workspacePath as string | null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function optionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  return requiredText(value, label, maxLength);
}

function validateAdditionalLicenses(value: unknown): AgentSkillAdditionalLicense[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error('Agent extension store is corrupt.');
  }
  const licenses = value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Agent extension store is corrupt.');
    }
    const input = candidate as Record<string, unknown>;
    const key = requiredText(input.key, 'Additional license key', 64);
    if (!/^[a-z][a-z0-9_]*_license$/u.test(key)) {
      throw new Error('Agent extension store is corrupt.');
    }
    return {
      key,
      label: requiredText(input.label, 'Additional license label', 80),
      value: requiredText(input.value, 'Additional license value', 240),
    };
  });
  if (new Set(licenses.map(({ key }) => key)).size !== licenses.length) {
    throw new Error('Agent extension store is corrupt.');
  }
  return licenses;
}

function validateSkillSource(value: unknown): ManagedSkillSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent extension store is corrupt.');
  }
  const input = value as Record<string, unknown>;
  const repositoryUrl = requiredText(input.repositoryUrl, 'Skill repository URL', 500);
  let repository: URL;
  try {
    repository = new URL(repositoryUrl);
  } catch {
    throw new Error('Agent extension store is corrupt.');
  }
  const skillPath = requiredText(input.skillPath, 'Skill source path', 500);
  if (
    repository.protocol !== 'https:' ||
    repository.hostname !== 'github.com' ||
    repository.username ||
    repository.password ||
    isAbsolute(skillPath) ||
    skillPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Agent extension store is corrupt.');
  }
  const revision = requiredText(input.revision, 'Skill source revision', 40).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Agent extension store is corrupt.');
  return {
    packId: requiredText(input.packId, 'Skill pack id', 128),
    packName: requiredText(input.packName, 'Skill pack name', 160),
    publisher: requiredText(input.publisher, 'Skill publisher', 160),
    repositoryUrl: repository.toString().replace(/\/$/, ''),
    skillPath,
    revision,
    version: optionalText(input.version, 'Skill version', 80),
    license: requiredText(input.license, 'Skill license', 240),
    additionalLicenses: validateAdditionalLicenses(input.additionalLicenses),
    compatibility: optionalText(input.compatibility, 'Skill compatibility', 500),
  };
}

function validateSkill(value: unknown, legacy = false): ManagedAgentSkill {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent extension store is corrupt.');
  }
  const input = value as Record<string, unknown>;
  const id = requiredText(input.id, 'Skill id', 128);
  const name = requiredText(input.name, 'Skill name', 64).toLowerCase();
  const provider = input.provider as ManagedAgentProvider;
  const scope = input.scope as ManagedSkillScope;
  const workspacePath = input.workspacePath;
  const directoryPath = input.directoryPath;
  const origin = input.origin === undefined ? (legacy ? 'local' : null) : input.origin;
  const source = input.source === undefined ? (legacy ? null : undefined) : input.source;
  const contentDigest =
    input.contentDigest === undefined ? (legacy ? null : undefined) : input.contentDigest;
  if (
    !SAFE_ID.test(id) ||
    !COMMAND_NAME.test(name) ||
    !PROVIDERS.has(provider) ||
    (scope !== 'global' && scope !== 'workspace') ||
    typeof directoryPath !== 'string' ||
    !isAbsolute(directoryPath) ||
    typeof input.enabled !== 'boolean' ||
    typeof input.hasSupportingFiles !== 'boolean' ||
    (origin !== 'local' && origin !== 'catalog') ||
    (origin === 'local' && source !== null) ||
    (origin === 'catalog' && (!source || typeof source !== 'object')) ||
    (contentDigest !== null && (typeof contentDigest !== 'string' || !SHA256.test(contentDigest)))
  ) {
    throw new Error('Agent extension store is corrupt.');
  }
  if (
    (scope === 'workspace' && (typeof workspacePath !== 'string' || !workspacePath)) ||
    (scope === 'global' && workspacePath !== null)
  ) {
    throw new Error('Agent extension store is corrupt.');
  }
  if (
    typeof input.createdAt !== 'number' ||
    !Number.isFinite(input.createdAt) ||
    typeof input.updatedAt !== 'number' ||
    !Number.isFinite(input.updatedAt)
  ) {
    throw new Error('Agent extension store is corrupt.');
  }
  return {
    id,
    name,
    description: requiredText(input.description, 'Skill description', 1024),
    instructions: requiredText(input.instructions, 'Skill instructions', 100_000),
    provider,
    scope,
    workspacePath: workspacePath as string | null,
    directoryPath,
    enabled: input.enabled,
    hasSupportingFiles: input.hasSupportingFiles,
    origin,
    source: origin === 'catalog' ? validateSkillSource(source) : null,
    contentDigest: contentDigest as string | null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function validateProviderSkillPolicy(value: unknown): ProviderSkillPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent extension store is corrupt.');
  }
  const input = value as Record<string, unknown>;
  const provider = input.provider as ProviderSkillPolicy['provider'];
  const scope = input.scope as AgentProviderSkillPolicyScope;
  const workspacePath = input.workspacePath;
  const nativeId = requiredText(input.nativeId, 'Provider skill id', 160);
  if (
    !SAFE_ID.test(requiredText(input.id, 'Provider skill policy id', 128)) ||
    !PROVIDERS.has(provider) ||
    input.provider === 'all' ||
    !SAFE_NATIVE_ID.test(nativeId) ||
    nativeId.includes('..') ||
    (scope !== 'global' && scope !== 'workspace') ||
    typeof input.enabled !== 'boolean' ||
    typeof input.updatedAt !== 'number' ||
    !Number.isFinite(input.updatedAt) ||
    (scope === 'global' && workspacePath !== null) ||
    (scope === 'workspace' && (typeof workspacePath !== 'string' || !workspacePath))
  ) {
    throw new Error('Agent extension store is corrupt.');
  }
  return {
    id: input.id as string,
    provider,
    nativeId,
    scope,
    workspacePath: workspacePath as string | null,
    enabled: input.enabled,
    updatedAt: input.updatedAt,
  };
}

function validateManifest(value: unknown): ExtensionManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent extension store is corrupt.');
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.commands)) {
    throw new Error('Agent extension store is corrupt.');
  }
  const commands = input.commands.map(validateCommand);
  const legacy = input.schemaVersion === 1 || input.schemaVersion === 2;
  const skills =
    input.schemaVersion === 1
      ? []
      : (input.schemaVersion === 2 || input.schemaVersion === 3) && Array.isArray(input.skills)
        ? input.skills.map((skill) => validateSkill(skill, legacy))
        : null;
  if (!skills) throw new Error('Agent extension store is corrupt.');
  const providerSkillPolicies = legacy
    ? []
    : input.schemaVersion === 3 && Array.isArray(input.providerSkillPolicies)
      ? input.providerSkillPolicies.map(validateProviderSkillPolicy)
      : null;
  if (!providerSkillPolicies) throw new Error('Agent extension store is corrupt.');
  if (new Set(commands.map((command) => command.id)).size !== commands.length) {
    throw new Error('Agent extension store is corrupt.');
  }
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length) {
    throw new Error('Agent extension store is corrupt.');
  }
  if (
    new Set(providerSkillPolicies.map((policy) => policy.id)).size !== providerSkillPolicies.length
  ) {
    throw new Error('Agent extension store is corrupt.');
  }
  const receipt = decodeSkillObservation(input.skillOperationReceipt);
  return {
    schemaVersion: 3,
    commands,
    skills,
    providerSkillPolicies,
    ...(receipt ? { skillOperationReceipt: receipt } : {}),
  };
}

function parseSkillDocument(raw: string): {
  name: string;
  description: string;
  instructions: string;
} {
  const normalized = raw.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/u.exec(normalized);
  if (!match) {
    throw new Error('The selected folder does not contain a valid SKILL.md frontmatter block.');
  }
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1]);
  } catch {
    throw new Error('The selected SKILL.md frontmatter is invalid YAML.');
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error('The selected SKILL.md frontmatter is invalid.');
  }
  const metadata = frontmatter as Record<string, unknown>;
  return {
    name: requiredText(metadata.name, 'Skill name', 64).toLowerCase(),
    description: requiredText(metadata.description, 'Skill description', 1024),
    instructions: requiredText(match[2], 'Skill instructions', 100_000),
  };
}

function skillDocument(
  skill: Pick<ManagedAgentSkill, 'name' | 'description' | 'instructions'>
): string {
  return `---\n${stringifyYaml({ name: skill.name, description: skill.description }).trim()}\n---\n\n${skill.instructions.trim()}\n`;
}

async function inspectSkillTree(root: string): Promise<{ fileCount: number; byteCount: number }> {
  let fileCount = 0;
  let byteCount = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) throw new Error('Skill folders cannot contain symbolic links.');
      if (stats.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!stats.isFile()) throw new Error('Skill folders may contain only files and directories.');
      fileCount += 1;
      byteCount += stats.size;
      if (fileCount > MAX_SKILL_FILES || byteCount > MAX_SKILL_BYTES) {
        throw new Error('Skill folder exceeds the 500-file or 25 MB import limit.');
      }
    }
  };
  await visit(root);
  return { fileCount, byteCount };
}

function skillMutationFacts(
  skill: ManagedAgentSkill,
  action: SkillMutationFacts['action']
): SkillMutationFacts {
  return {
    action,
    atMs: skill.updatedAt,
    host: skill.provider,
    scope: skill.scope,
    source: skill.origin,
    installed: 'installed',
    storedEnablement: skill.enabled ? 'enabled' : 'disabled',
    binding: { kind: 'skill', id: skill.id, updatedAt: skill.updatedAt },
  };
}

export class AgentExtensionStore {
  private readonly filePath: string;
  private readonly skillsRoot: string;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly skillReceiptPublisher?: SkillReceiptPublisher;
  private admittedSkillReceiptId: string | null = null;
  private mutation: Promise<void> = Promise.resolve();

  constructor(options: {
    filePath: string;
    skillsRoot?: string;
    now?: () => number;
    idGenerator?: () => string;
    skillReceiptPublisher?: SkillReceiptPublisher;
  }) {
    this.filePath = resolve(options.filePath);
    this.skillsRoot = resolve(options.skillsRoot ?? join(dirname(options.filePath), 'skills'));
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.skillReceiptPublisher = options.skillReceiptPublisher;
  }

  private async read(): Promise<ExtensionManifest> {
    try {
      const manifest = validateManifest(JSON.parse(await readFile(this.filePath, 'utf8')));
      for (const skill of manifest.skills) {
        const relativePath = relative(this.skillsRoot, resolve(skill.directoryPath));
        if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
          throw new Error('Agent extension store is corrupt.');
        }
      }
      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 3, commands: [], skills: [], providerSkillPolicies: [] };
      }
      if (error instanceof SyntaxError) throw new Error('Agent extension store is corrupt.');
      throw error;
    }
  }

  private async write(
    manifest: ExtensionManifest,
    observation?: SkillMutationObservationContext | null,
    facts?: () => SkillMutationFacts
  ): Promise<void> {
    let next = manifest;
    if (facts) {
      let receipt: CommittedSkillObservation | null = null;
      try {
        receipt = prepareSkillObservation(observation, facts());
      } catch (ignoredError) {
        void ignoredError;
      }
      next = { ...manifest, skillOperationReceipt: receipt ?? undefined };
    }
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporaryPath, this.filePath);
      this.publishSkillObservation(next.skillOperationReceipt?.eventId);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private readCommittedSkillObservation(): CommittedSkillObservation | null {
    try {
      const manifest = validateManifest(JSON.parse(readFileSync(this.filePath, 'utf8')));
      const receipt = manifest.skillOperationReceipt;
      if (!receipt) return null;
      const binding = receipt.binding;
      if (binding.kind === 'skill' || binding.kind === 'policy') {
        const row =
          binding.kind === 'skill'
            ? manifest.skills.find((skill) => skill.id === binding.id)
            : manifest.providerSkillPolicies.find((policy) => policy.id === binding.id);
        if (
          !row ||
          row.updatedAt !== binding.updatedAt ||
          row.provider !== receipt.properties.skills_host ||
          row.scope !== receipt.properties.skills_scope ||
          (row.enabled ? 'enabled' : 'disabled') !== receipt.properties.skills_stored_enablement
        )
          return null;
      } else {
        const rows =
          binding.kind === 'skill_absent' ? manifest.skills : manifest.providerSkillPolicies;
        if (rows.some((row) => row.id === binding.id)) return null;
      }
      return receipt;
    } catch {
      return null;
    }
  }

  private publishSkillObservation(eventId?: string): void {
    if (!eventId || eventId === this.admittedSkillReceiptId || !this.skillReceiptPublisher) return;
    try {
      const admitted = this.skillReceiptPublisher(() => {
        const receipt = this.readCommittedSkillObservation();
        return receipt?.eventId === eventId ? receipt : null;
      });

      if (admitted === true) this.admittedSkillReceiptId = eventId;
    } catch (ignoredError) {
      void ignoredError;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async list(input: {
    workspacePath: string | null;
  }): Promise<{ commands: ManagedAgentCommand[]; skills: ManagedAgentSkill[] }> {
    const manifest = await this.read();
    this.publishSkillObservation(manifest.skillOperationReceipt?.eventId);
    return {
      commands: manifest.commands.filter(
        (command) =>
          command.scope === 'global' ||
          (input.workspacePath !== null && command.workspacePath === input.workspacePath)
      ),
      skills: manifest.skills.filter(
        (skill) =>
          skill.scope === 'global' ||
          (input.workspacePath !== null && skill.workspacePath === input.workspacePath)
      ),
    };
  }

  saveCommand(input: SaveManagedAgentCommand): Promise<ManagedAgentCommand> {
    return this.serialize(async () => {
      const manifest = await this.read();
      const existing = input.id
        ? manifest.commands.find((command) => command.id === input.id)
        : undefined;
      if (input.id && !existing) throw new Error('This custom command no longer exists.');
      const now = this.now();
      const command = validateCommand({
        ...input,
        id: existing?.id ?? this.idGenerator(),
        name: input.name.toLowerCase(),
        workspacePath: input.scope === 'global' ? null : input.workspacePath,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      const collision = manifest.commands.find(
        (candidate) =>
          candidate.id !== command.id &&
          candidate.name === command.name &&
          candidate.provider === command.provider &&
          candidate.scope === command.scope &&
          candidate.workspacePath === command.workspacePath
      );
      if (collision) throw new Error('A custom command with this name already exists here.');
      manifest.commands = [
        ...manifest.commands.filter((candidate) => candidate.id !== command.id),
        command,
      ];
      await this.write(manifest);
      return command;
    });
  }

  removeCommand(id: string): Promise<void> {
    return this.serialize(async () => {
      const manifest = await this.read();
      const next = manifest.commands.filter((command) => command.id !== id);
      if (next.length === manifest.commands.length) {
        throw new Error('This custom command no longer exists.');
      }
      await this.write({ ...manifest, commands: next });
    });
  }

  saveSkill(
    input: SaveManagedAgentSkill,
    observation?: SkillMutationObservationContext | null
  ): Promise<ManagedAgentSkill> {
    return this.serialize(async () => {
      const manifest = await this.read();
      const existing = input.id
        ? manifest.skills.find((skill) => skill.id === input.id)
        : undefined;
      if (input.id && !existing) throw new Error('This skill no longer exists.');
      if (existing?.origin === 'catalog') {
        throw new Error('Catalog skills must be updated from their source or duplicated locally.');
      }
      const now = this.now();
      const id = existing?.id ?? this.idGenerator();
      const directoryPath = existing?.directoryPath ?? join(this.skillsRoot, id);
      const skill = validateSkill({
        ...input,
        provider: input.provider,
        id,
        name: input.name.toLowerCase(),
        workspacePath: input.scope === 'global' ? null : input.workspacePath,
        directoryPath,
        hasSupportingFiles: existing?.hasSupportingFiles ?? false,
        origin: 'local',
        source: null,
        contentDigest: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      const collision = manifest.skills.find(
        (candidate) =>
          candidate.id !== skill.id &&
          candidate.name === skill.name &&
          candidate.provider === skill.provider &&
          candidate.scope === skill.scope &&
          candidate.workspacePath === skill.workspacePath
      );
      if (collision) throw new Error('A skill with this name already exists here.');
      await mkdir(directoryPath, { recursive: true, mode: 0o700 });
      await writeFile(join(directoryPath, 'SKILL.md'), skillDocument(skill), {
        encoding: 'utf8',
        mode: 0o600,
      });
      manifest.skills = [
        ...manifest.skills.filter((candidate) => candidate.id !== skill.id),
        skill,
      ];
      await this.write(manifest, observation, () =>
        skillMutationFacts(skill, existing ? 'update' : 'install')
      );
      return skill;
    });
  }

  importSkill(
    input: ImportManagedAgentSkill,
    observation?: SkillMutationObservationContext | null
  ): Promise<ManagedAgentSkill> {
    return this.serialize(async () => {
      if (!isAbsolute(input.sourcePath)) throw new Error('Skill import path must be absolute.');
      const definitionPath = join(input.sourcePath, 'SKILL.md');
      const parsed = parseSkillDocument(await readFile(definitionPath, 'utf8'));
      if (!COMMAND_NAME.test(parsed.name)) {
        throw new Error('Skill name must use lowercase letters, numbers, and hyphens.');
      }
      const tree = await inspectSkillTree(input.sourcePath);
      const manifest = await this.read();
      if (
        manifest.skills.some(
          (candidate) =>
            candidate.name === parsed.name &&
            candidate.provider === input.provider &&
            candidate.scope === input.scope &&
            candidate.workspacePath === (input.scope === 'global' ? null : input.workspacePath)
        )
      ) {
        throw new Error('A skill with this name already exists here.');
      }
      const id = this.idGenerator();
      const directoryPath = join(this.skillsRoot, id);
      const now = this.now();
      const skill = validateSkill({
        ...parsed,
        id,
        provider: input.provider,
        scope: input.scope,
        workspacePath: input.scope === 'global' ? null : input.workspacePath,
        directoryPath,
        enabled: true,
        hasSupportingFiles: tree.fileCount > 1,
        origin: 'local',
        source: null,
        contentDigest: null,
        createdAt: now,
        updatedAt: now,
      });
      await mkdir(this.skillsRoot, { recursive: true, mode: 0o700 });
      try {
        await cp(input.sourcePath, directoryPath, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        await this.write({ ...manifest, skills: [...manifest.skills, skill] }, observation, () =>
          skillMutationFacts(skill, 'import')
        );
      } catch (error) {
        await rm(directoryPath, { recursive: true, force: true });
        throw error;
      }
      return skill;
    });
  }

  installCatalogSkill(
    input: InstallCatalogSkillInput,
    observation?: SkillMutationObservationContext | null
  ): Promise<ManagedAgentSkill> {
    return this.serialize(async () => {
      if (!isAbsolute(input.sourcePath)) throw new Error('Skill staging path must be absolute.');
      if (!SHA256.test(input.contentDigest)) throw new Error('Skill content digest is invalid.');
      const definitionPath = join(input.sourcePath, 'SKILL.md');
      const parsed = parseSkillDocument(await readFile(definitionPath, 'utf8'));
      if (!COMMAND_NAME.test(parsed.name)) {
        throw new Error('Skill name must use lowercase letters, numbers, and hyphens.');
      }
      const tree = await inspectSkillTree(input.sourcePath);
      const source = validateSkillSource(input.source);
      const manifest = await this.read();
      const workspacePath = input.scope === 'global' ? null : input.workspacePath;
      const existing = manifest.skills.find(
        (candidate) =>
          candidate.origin === 'catalog' &&
          candidate.source?.packId === source.packId &&
          candidate.source.skillPath === source.skillPath &&
          candidate.provider === input.provider &&
          candidate.scope === input.scope &&
          candidate.workspacePath === workspacePath
      );
      const collision = manifest.skills.find(
        (candidate) =>
          candidate.id !== existing?.id &&
          candidate.name === parsed.name &&
          candidate.provider === input.provider &&
          candidate.scope === input.scope &&
          candidate.workspacePath === workspacePath
      );
      if (collision) {
        throw new Error('A different skill with this name already exists here.');
      }
      const now = this.now();
      const id = existing?.id ?? this.idGenerator();
      const directoryPath = existing?.directoryPath ?? join(this.skillsRoot, id);
      const skill = validateSkill({
        ...parsed,
        id,
        provider: input.provider,
        scope: input.scope,
        workspacePath,
        directoryPath,
        enabled: existing?.enabled ?? true,
        hasSupportingFiles: tree.fileCount > 1,
        origin: 'catalog',
        source,
        contentDigest: input.contentDigest,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      await mkdir(this.skillsRoot, { recursive: true, mode: 0o700 });
      if (!existing) {
        try {
          await cp(input.sourcePath, directoryPath, {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
          await this.write({ ...manifest, skills: [...manifest.skills, skill] }, observation, () =>
            skillMutationFacts(skill, 'install')
          );
        } catch (error) {
          await rm(directoryPath, { recursive: true, force: true });
          throw error;
        }
        return skill;
      }

      const replacementPath = join(this.skillsRoot, `.${id}.${randomUUID()}.new`);
      const backupPath = join(this.skillsRoot, `.${id}.${randomUUID()}.old`);
      let movedExisting = false;
      try {
        await cp(input.sourcePath, replacementPath, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        await rename(directoryPath, backupPath);
        movedExisting = true;
        await rename(replacementPath, directoryPath);
        await this.write(
          {
            ...manifest,
            skills: manifest.skills.map((candidate) =>
              candidate.id === skill.id ? skill : candidate
            ),
          },
          observation,
          () => skillMutationFacts(skill, 'update')
        );
        await rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
        return skill;
      } catch (error) {
        await rm(replacementPath, { recursive: true, force: true });
        if (movedExisting) {
          await rm(directoryPath, { recursive: true, force: true });
          await rename(backupPath, directoryPath).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  setProviderSkillPolicy(
    input: {
      provider: ProviderSkillPolicy['provider'];
      nativeId: string;
      scope: AgentProviderSkillPolicyScope;
      workspacePath: string | null;
      enabled: boolean;
    },
    observation?: SkillMutationObservationContext | null
  ): Promise<ProviderSkillPolicy> {
    return this.serialize(async () => {
      const manifest = await this.read();
      const workspacePath = input.scope === 'global' ? null : input.workspacePath;
      const existing = manifest.providerSkillPolicies.find(
        (candidate) =>
          candidate.provider === input.provider &&
          candidate.nativeId === input.nativeId &&
          candidate.scope === input.scope &&
          candidate.workspacePath === workspacePath
      );
      const policyId = `policy_${createHash('sha256')
        .update(input.provider)
        .update('\0')
        .update(input.nativeId)
        .update('\0')
        .update(input.scope)
        .update('\0')
        .update(workspacePath ?? '')
        .digest('hex')
        .slice(0, 32)}`;
      const policy = validateProviderSkillPolicy({
        ...input,
        id: existing?.id ?? policyId,
        workspacePath,
        updatedAt: this.now(),
      });
      await this.write(
        {
          ...manifest,
          providerSkillPolicies: [
            ...manifest.providerSkillPolicies.filter((candidate) => candidate.id !== policy.id),
            policy,
          ],
        },
        observation,
        () => ({
          action: policy.enabled ? 'enable' : 'disable',
          atMs: policy.updatedAt,
          host: policy.provider,
          scope: policy.scope,
          source: 'provider_native',
          storedEnablement: policy.enabled ? 'enabled' : 'disabled',
          binding: { kind: 'policy', id: policy.id, updatedAt: policy.updatedAt },
        })
      );
      return policy;
    });
  }

  removeProviderSkillPolicy(
    input: {
      provider: ProviderSkillPolicy['provider'];
      nativeId: string;
      scope: AgentProviderSkillPolicyScope;
      workspacePath: string | null;
    },
    observation?: SkillMutationObservationContext | null
  ): Promise<void> {
    return this.serialize(async () => {
      const provider = input.provider;
      const nativeId = requiredText(input.nativeId, 'Provider skill id', 160);
      const scope = input.scope;
      const workspacePath = scope === 'global' ? null : input.workspacePath;
      if (!PROVIDERS.has(provider) || !SAFE_NATIVE_ID.test(nativeId)) {
        throw new Error('Provider skill policy is invalid.');
      }
      if (
        (scope !== 'global' && scope !== 'workspace') ||
        (scope === 'workspace' && (typeof workspacePath !== 'string' || !isAbsolute(workspacePath)))
      ) {
        throw new Error('Provider skill policy scope is invalid.');
      }
      const manifest = await this.read();
      const remaining = manifest.providerSkillPolicies.filter(
        (candidate) =>
          !(
            candidate.provider === provider &&
            candidate.nativeId === nativeId &&
            candidate.scope === scope &&
            candidate.workspacePath === workspacePath
          )
      );
      if (remaining.length === manifest.providerSkillPolicies.length) return;
      await this.write({ ...manifest, providerSkillPolicies: remaining }, observation, () => {
        const removed = manifest.providerSkillPolicies.find(
          (candidate) =>
            candidate.provider === provider &&
            candidate.nativeId === nativeId &&
            candidate.scope === scope &&
            candidate.workspacePath === workspacePath
        );
        return {
          action: 'inherit',
          atMs: Date.now(),
          host: provider,
          scope,
          source: 'provider_native',
          binding: { kind: 'policy_absent', id: removed?.id ?? '' },
        };
      });
    });
  }

  async listProviderSkillPolicies(input: {
    workspacePath: string | null;
  }): Promise<ProviderSkillPolicy[]> {
    const manifest = await this.read();
    return manifest.providerSkillPolicies.filter(
      (policy) =>
        policy.scope === 'global' ||
        (input.workspacePath !== null && policy.workspacePath === input.workspacePath)
    );
  }

  async resolveProviderSkillPolicy(input: {
    provider: ProviderSkillPolicy['provider'];
    nativeId: string;
    workspacePath: string | null;
  }): Promise<ProviderSkillPolicy | null> {
    const policies = await this.listProviderSkillPolicies({ workspacePath: input.workspacePath });
    const matches = policies.filter(
      (policy) => policy.provider === input.provider && policy.nativeId === input.nativeId
    );
    return (
      matches.find(
        (policy) => policy.scope === 'workspace' && policy.workspacePath === input.workspacePath
      ) ??
      matches.find((policy) => policy.scope === 'global') ??
      null
    );
  }

  setSkillEnabled(
    input: ManagedAgentSkillEnabledRequest,
    observation?: SkillMutationObservationContext | null
  ): Promise<ManagedAgentSkill> {
    return this.serialize(async () => {
      const manifest = await this.read();
      const existing = manifest.skills.find((skill) => skill.id === input.id);
      if (!existing) throw new Error('This skill no longer exists.');
      const skill = validateSkill({ ...existing, enabled: input.enabled, updatedAt: this.now() });
      await this.write(
        {
          ...manifest,
          skills: manifest.skills.map((candidate) =>
            candidate.id === skill.id ? skill : candidate
          ),
        },
        observation,
        () => skillMutationFacts(skill, skill.enabled ? 'enable' : 'disable')
      );
      return skill;
    });
  }

  removeSkill(id: string, observation?: SkillMutationObservationContext | null): Promise<void> {
    return this.serialize(async () => {
      const manifest = await this.read();
      const skill = manifest.skills.find((candidate) => candidate.id === id);
      if (!skill) throw new Error('This skill no longer exists.');
      if (dirname(resolve(skill.directoryPath)) !== resolve(this.skillsRoot)) {
        throw new Error('Agent extension store is corrupt.');
      }
      await this.write(
        {
          ...manifest,
          skills: manifest.skills.filter((candidate) => candidate.id !== id),
        },
        observation,
        () => ({
          action: 'remove',
          atMs: Date.now(),
          host: skill.provider,
          scope: skill.scope,
          source: skill.origin,
          binding: { kind: 'skill_absent', id: skill.id },
        })
      );
      await rm(skill.directoryPath, { recursive: true, force: true });
    });
  }
}
