import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentExtensionStore } from './extension-store';
import { selectManagedSkills } from '../../shared/agent-capability-controls';
import type {
  CommittedSkillObservation,
  SkillMutationObservationContext,
  SkillReceiptPublisher,
} from './skill-observation-contract';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const origin = {
  consentScope: '10000000-0000-4000-8000-000000000001',
  contextId: '10000000-0000-4000-8000-000000000002',
  processId: '10000000-0000-4000-8000-000000000003',
  classification: 'synthetic' as const,
};
const observation: SkillMutationObservationContext = {
  operationId: '20000000-0000-4000-8000-000000000001',
  eventId: '20000000-0000-4000-8000-000000000002',
  returnEventId: '20000000-0000-4000-8000-000000000003',
  origin,
};
const input = {
  name: 'synthetic-audit',
  description: 'Synthetic acceptance only.',
  instructions: 'SYNTHETIC PRIVATE BODY',
  provider: 'all' as const,
  scope: 'workspace' as const,
  workspacePath: '/synthetic/workspace',
  enabled: true,
};
async function fixture(publisher?: SkillReceiptPublisher) {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-skill-observation-'));
  roots.push(root);
  const filePath = join(root, 'extensions.json');
  const idGenerator = vi.fn(() => 'private-native-skill-1');
  let clock = 50;
  const options = {
    filePath,
    skillsRoot: join(root, 'skills'),
    now: () => clock++,
    idGenerator,
    skillReceiptPublisher: publisher,
  };
  return { root, filePath, options, idGenerator, store: new AgentExtensionStore(options) };
}
describe('Skills actual manifest transaction and bounded recovery', () => {
  it('commits native data and a private-bound receipt in the existing manifest and restores both on cold reopen', async () => {
    const reads: CommittedSkillObservation[] = [];
    const publish = vi.fn((read) => {
      const receipt = read();
      if (receipt) reads.push(receipt);
      return true;
    });
    const f = await fixture(publish);
    const saved = await f.store.saveSkill(input, observation);
    expect(f.idGenerator).toHaveBeenCalledOnce();
    expect(saved.id).toBe('private-native-skill-1');
    const native = JSON.parse(await readFile(f.filePath, 'utf8'));
    expect(native.skillOperationReceipt.binding).toEqual({
      kind: 'skill',
      id: saved.id,
      updatedAt: 50,
    });
    expect(reads[0]).toMatchObject({
      origin,
      atMs: 50,
      properties: {
        skills_result: 'manifest_committed',
        skills_installed: 'installed',
        skills_stored_enablement: 'enabled',
        skills_effective_enablement: 'not_attested',
        skills_task_reuse: 'not_attested',
      },
    });
    expect(JSON.stringify(reads[0]!.properties)).not.toMatch(
      /private-native|SYNTHETIC PRIVATE|synthetic-audit|workspace\//u
    );
    expect(await readFile(join(saved.directoryPath, 'SKILL.md'), 'utf8')).toContain(
      input.instructions
    );
    const reopened = new AgentExtensionStore(f.options);
    const inventory = await reopened.list({ workspacePath: input.workspacePath });
    expect(inventory.skills).toEqual([saved]);
    expect(inventory).not.toHaveProperty('skillOperationReceipt');
    expect(publish).toHaveBeenCalledTimes(2);
    expect(reads[1]).toEqual(reads[0]);
    expect(f.idGenerator).toHaveBeenCalledOnce();
  });
  it('retries only optional receipt admission during an existing read, preserving exact native bytes and occurrence clock', async () => {
    let accepted = false;
    const receipts: Array<CommittedSkillObservation | null> = [];
    const publish = vi.fn((read) => {
      receipts.push(read());
      return accepted;
    });
    const f = await fixture(publish);
    await f.store.saveSkill(input, observation);
    const bytes = await readFile(f.filePath, 'utf8');
    const before = publish.mock.calls.length;
    accepted = true;
    await f.store.list({ workspacePath: input.workspacePath });
    await f.store.list({ workspacePath: input.workspacePath });
    expect(publish).toHaveBeenCalledTimes(before + 1);
    expect(await readFile(f.filePath, 'utf8')).toBe(bytes);
    expect(receipts[1]).toEqual(receipts[0]);
    expect(f.idGenerator).toHaveBeenCalledOnce();
  });
  it('contains publisher failure after a real commit without losing the primary native result', async () => {
    const f = await fixture(() => {
      throw new Error('synthetic optional publisher failure');
    });
    const saved = await f.store.saveSkill(input, observation);
    expect((await f.store.list({ workspacePath: input.workspacePath })).skills).toEqual([saved]);
    expect(await readFile(join(saved.directoryPath, 'SKILL.md'), 'utf8')).toContain(
      input.instructions
    );
    expect(f.idGenerator).toHaveBeenCalledOnce();
  });
  it('does not attach delivery-time identity to consent-off mutations and clears an older receipt on the next unobserved skill mutation', async () => {
    const publish = vi.fn(() => true);
    const f = await fixture(publish);
    const saved = await f.store.saveSkill(input, observation);
    await f.store.setSkillEnabled({ id: saved.id, enabled: false }, null);
    expect(JSON.parse(await readFile(f.filePath, 'utf8'))).not.toHaveProperty(
      'skillOperationReceipt'
    );
    const inventory = await new AgentExtensionStore(f.options).list({
      workspacePath: input.workspacePath,
    });
    expect(inventory.skills[0]!.enabled).toBe(false);
    expect(publish).toHaveBeenCalledOnce();
  });
  it('rereads the current file and refuses stale private target binding without breaking product inventory', async () => {
    let reader: (() => CommittedSkillObservation | null) | undefined;
    const f = await fixture((read) => {
      reader = read;
      expect(read()).not.toBeNull();
      return false;
    });
    await f.store.saveSkill(input, observation);
    const native = JSON.parse(await readFile(f.filePath, 'utf8'));
    native.skills[0].updatedAt = 999;
    await writeFile(f.filePath, JSON.stringify(native));
    expect(reader!()).toBeNull();
    const reopened = new AgentExtensionStore({ ...f.options, skillReceiptPublisher: undefined });
    expect((await reopened.list({ workspacePath: input.workspacePath })).skills[0]!.updatedAt).toBe(
      999
    );
    native.skillOperationReceipt.properties.skills_host = '/private/dynamic';
    await writeFile(f.filePath, JSON.stringify(native));
    expect((await reopened.list({ workspacePath: input.workspacePath })).skills).toHaveLength(1);
    expect(reader!()).toBeNull();
  });
  it('preserves catalog update identity, content, supporting files and disabled enablement over restart', async () => {
    const observations: CommittedSkillObservation[] = [];
    const f = await fixture((read) => {
      const r = read();
      if (r) observations.push(r);
      return true;
    });
    const sourcePath = join(f.root, 'source');
    await mkdir(join(sourcePath, 'references'), { recursive: true });
    const document =
      '---\nname: synthetic-audit\ndescription: Synthetic acceptance only.\n---\n\nOLD SYNTHETIC BODY\n';
    await writeFile(join(sourcePath, 'SKILL.md'), document);
    await writeFile(join(sourcePath, 'references/check.md'), 'CONTROLLED SUPPORT');
    const source = {
      packId: 'fixture',
      packName: 'Fixture',
      publisher: 'Synthetic',
      repositoryUrl: 'https://github.com/dnaforge-e2e/skills',
      skillPath: 'skills/synthetic-audit',
      revision: 'a'.repeat(40),
      version: '1',
      license: 'MIT',
      additionalLicenses: [],
      compatibility: null,
    };
    const first = await f.store.installCatalogSkill(
      {
        sourcePath,
        provider: 'all',
        scope: 'workspace',
        workspacePath: input.workspacePath,
        source,
        contentDigest: 'a'.repeat(64),
      },
      observation
    );
    await f.store.setSkillEnabled({ id: first.id, enabled: false });
    await writeFile(join(sourcePath, 'SKILL.md'), document.replace('OLD', 'NEW'));
    const nextContext = {
      ...observation,
      operationId: '30000000-0000-4000-8000-000000000001',
      eventId: '30000000-0000-4000-8000-000000000002',
    };
    const updated = await f.store.installCatalogSkill(
      {
        sourcePath,
        provider: 'all',
        scope: 'workspace',
        workspacePath: input.workspacePath,
        source: { ...source, revision: 'b'.repeat(40) },
        contentDigest: 'b'.repeat(64),
      },
      nextContext
    );
    expect(updated.id).toBe(first.id);
    expect(updated.enabled).toBe(false);
    expect(f.idGenerator).toHaveBeenCalledOnce();
    expect(observations.at(-1)!.properties).toMatchObject({
      skills_action: 'update',
      skills_source: 'catalog',
      skills_host: 'all',
      skills_scope: 'workspace',
      skills_stored_enablement: 'disabled',
      skills_effective_enablement: 'not_attested',
    });
    const cold = await new AgentExtensionStore(f.options).list({
      workspacePath: input.workspacePath,
    });
    expect(cold.skills).toEqual([updated]);
    expect(await readFile(join(updated.directoryPath, 'SKILL.md'), 'utf8')).toBe(
      document.replace('OLD', 'NEW')
    );
    expect(await readFile(join(updated.directoryPath, 'references/check.md'), 'utf8')).toBe(
      'CONTROLLED SUPPORT'
    );
  });
  it('keeps the actual disabled workspace winner ahead of enabled global fallback over a cold reopen', async () => {
    const f = await fixture();
    let id = 0;
    const store = new AgentExtensionStore({ ...f.options, idGenerator: () => `native-${++id}` });
    const global = await store.saveSkill({
      ...input,
      scope: 'global',
      workspacePath: null,
      enabled: true,
    });
    const local = await store.saveSkill({ ...input, enabled: false });
    const cold = await new AgentExtensionStore(f.options).list({
      workspacePath: input.workspacePath,
    });
    expect(selectManagedSkills(cold.skills, 'codex-sdk', input.workspacePath)).toEqual([local]);
    expect(selectManagedSkills(cold.skills, 'codex-sdk', '/other')).toEqual([global]);
    expect(
      selectManagedSkills(cold.skills, 'codex-sdk', input.workspacePath).filter(
        (row) => row.enabled
      )
    ).toEqual([]);
  });

  it('does not consume the injected product clock or identifier generator for absence-only observation metadata', async () => {
    const f = await fixture(() => false);
    const now = vi.fn(() => 50);
    const store = new AgentExtensionStore({ ...f.options, now });
    const saved = await store.saveSkill(input);
    expect(now).toHaveBeenCalledOnce();
    await store.removeSkill(saved.id, observation);
    expect(now).toHaveBeenCalledOnce();
    expect(f.idGenerator).toHaveBeenCalledOnce();
    const removal = JSON.parse(await readFile(f.filePath, 'utf8')).skillOperationReceipt;
    expect(removal).toMatchObject({
      binding: { kind: 'skill_absent', id: saved.id },
      properties: { skills_action: 'remove', skills_occurrence_clock: 'native_domain' },
    });
    const policy = {
      provider: 'codex-sdk' as const,
      nativeId: 'private-native-policy-skill',
      scope: 'workspace' as const,
      workspacePath: input.workspacePath,
    };
    await store.setProviderSkillPolicy({ ...policy, enabled: false });
    expect(now).toHaveBeenCalledTimes(2);
    await store.removeProviderSkillPolicy(policy, {
      ...observation,
      eventId: '40000000-0000-4000-8000-000000000002',
    });
    expect(now).toHaveBeenCalledTimes(2);
    expect(f.idGenerator).toHaveBeenCalledOnce();
    expect(
      JSON.parse(await readFile(f.filePath, 'utf8')).skillOperationReceipt.properties
    ).toMatchObject({
      skills_action: 'inherit',
      skills_source: 'provider_native',
      skills_stored_enablement: 'not_attested',
      skills_effective_enablement: 'not_attested',
    });
  });
});
