import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const manifestFault = vi.hoisted(() => ({ path: '', remaining: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...native,
    rename: async (...args: Parameters<typeof native.rename>) => {
      if (
        String(args[1]) === manifestFault.path &&
        String(args[0]).endsWith('.tmp') &&
        manifestFault.remaining > 0
      ) {
        manifestFault.remaining -= 1;
        throw new Error('Synthetic manifest commit refused');
      }
      return native.rename(...args);
    },
  };
});

import { AgentExtensionStore } from './extension-store';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  manifestFault.path = '';
  manifestFault.remaining = 0;
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture(): Promise<{ root: string; filePath: string; store: AgentExtensionStore }> {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-agent-extensions-'));
  let id = 0;
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, 'extensions.json');
  return {
    root,
    filePath,
    store: new AgentExtensionStore({
      filePath,
      skillsRoot: join(root, 'skills'),
      now: () => 10,
      idGenerator: () => `skill-${++id}`,
    }),
  };
}

describe('AgentExtensionStore', () => {
  it('restores the real prior catalog tree and disabled manifest after a controlled update commit failure', async () => {
    const { root, filePath, store } = await fixture();
    const staging = join(root, 'catalog-source');
    await mkdir(staging);
    const oldDocument =
      '---\nname: synthetic-audit\ndescription: Synthetic audit.\n---\n\nRetained old body\n';
    await writeFile(join(staging, 'SKILL.md'), oldDocument);
    const source = {
      packId: 'fixture',
      packName: 'Fixture',
      publisher: 'DNAForge E2E',
      repositoryUrl: 'https://github.com/dnaforge-e2e/skills',
      skillPath: 'skills/synthetic-audit',
      revision: 'a'.repeat(40),
      version: '1',
      license: 'MIT',
      additionalLicenses: [],
      compatibility: null,
    };
    const original = await store.installCatalogSkill({
      sourcePath: staging,
      provider: 'all',
      scope: 'global',
      workspacePath: null,
      source,
      contentDigest: 'a'.repeat(64),
    });
    await store.setSkillEnabled({ id: original.id, enabled: false });
    const manifest = await readFile(filePath, 'utf8');
    await writeFile(
      join(staging, 'SKILL.md'),
      oldDocument.replace('Retained old body', 'Uncommitted new body')
    );
    manifestFault.path = filePath;
    manifestFault.remaining = 1;
    await expect(
      store.installCatalogSkill({
        sourcePath: staging,
        provider: 'all',
        scope: 'global',
        workspacePath: null,
        source: { ...source, revision: 'b'.repeat(40) },
        contentDigest: 'b'.repeat(64),
      })
    ).rejects.toThrow('Synthetic manifest commit refused');
    expect(await readFile(filePath, 'utf8')).toBe(manifest);
    expect(await readFile(join(original.directoryPath, 'SKILL.md'), 'utf8')).toBe(oldDocument);
    const reopened = new AgentExtensionStore({ filePath, skillsRoot: join(root, 'skills') });
    expect((await reopened.list({ workspacePath: null })).skills).toEqual([
      expect.objectContaining({
        id: original.id,
        enabled: false,
        source: expect.objectContaining({ revision: 'a'.repeat(40) }),
      }),
    ]);
  });

  it('persists commands atomically and applies workspace scope after restart', async () => {
    const { root, filePath, store } = await fixture();
    await store.saveCommand({
      name: 'review-primers',
      description: 'Review a primer pair.',
      instructions: 'Check specificity, melting temperature, and product size.',
      provider: 'codex-sdk',
      scope: 'workspace',
      workspacePath: '/workspace/a',
    });

    const reopened = new AgentExtensionStore({
      filePath,
      skillsRoot: join(root, 'skills'),
      now: () => 20,
    });
    expect(await reopened.list({ workspacePath: '/workspace/a' })).toMatchObject({
      commands: [expect.objectContaining({ name: 'review-primers', updatedAt: 10 })],
    });
    expect((await reopened.list({ workspacePath: '/workspace/b' })).commands).toEqual([]);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ schemaVersion: 3 });
  });

  it('imports a complete skill folder, persists it, and can disable it after restart', async () => {
    const { root, filePath, store } = await fixture();
    const sourcePath = join(root, 'source-skill');
    await mkdir(join(sourcePath, 'references'), { recursive: true });
    await writeFile(
      join(sourcePath, 'SKILL.md'),
      [
        '---',
        'name: primer-review',
        'description: Review a primer pair before ordering.',
        '---',
        '',
        '# Primer review',
        '',
        'Check specificity and melting temperature.',
      ].join('\n'),
      'utf8'
    );
    await writeFile(join(sourcePath, 'references', 'limits.md'), 'Use a 3 C Tm spread.\n', 'utf8');

    const imported = await store.importSkill({
      sourcePath,
      provider: 'grok-acp',
      scope: 'global',
      workspacePath: null,
    });
    expect(imported).toMatchObject({
      id: 'skill-1',
      name: 'primer-review',
      description: 'Review a primer pair before ordering.',
      provider: 'grok-acp',
      enabled: true,
      hasSupportingFiles: true,
      origin: 'local',
      source: null,
    });
    expect(await readFile(join(imported.directoryPath, 'references', 'limits.md'), 'utf8')).toBe(
      'Use a 3 C Tm spread.\n'
    );

    const reopened = new AgentExtensionStore({
      filePath,
      skillsRoot: join(root, 'skills'),
      now: () => 20,
    });
    await reopened.setSkillEnabled({ id: imported.id, enabled: false });
    expect(await reopened.list({ workspacePath: null })).toMatchObject({
      skills: [expect.objectContaining({ name: 'primer-review', enabled: false, updatedAt: 20 })],
    });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ schemaVersion: 3 });
  });

  it('preserves the host association on provider-assigned app skills', async () => {
    const { root, filePath, store } = await fixture();
    const directoryPath = join(root, 'skills', 'legacy-skill');
    await mkdir(directoryPath, { recursive: true });
    await writeFile(join(directoryPath, 'SKILL.md'), 'legacy fixture\n', 'utf8');
    await writeFile(
      filePath,
      `${JSON.stringify({
        schemaVersion: 2,
        commands: [],
        skills: [
          {
            id: 'legacy-skill',
            name: 'legacy-skill',
            description: 'Existing skill from schema two.',
            instructions: 'Keep these instructions.',
            provider: 'codex-sdk',
            scope: 'global',
            workspacePath: null,
            directoryPath,
            enabled: true,
            hasSupportingFiles: false,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      })}\n`,
      'utf8'
    );

    expect(await store.list({ workspacePath: null })).toMatchObject({
      skills: [expect.objectContaining({ origin: 'local', source: null, provider: 'codex-sdk' })],
    });
    await store.setProviderSkillPolicy({
      provider: 'codex-sdk',
      nativeId: 'native-primer-review',
      scope: 'global',
      workspacePath: null,
      enabled: false,
    });
    await store.setProviderSkillPolicy({
      provider: 'codex-sdk',
      nativeId: 'native-primer-review',
      scope: 'workspace',
      workspacePath: '/workspace/a',
      enabled: true,
    });

    expect(
      await store.resolveProviderSkillPolicy({
        provider: 'codex-sdk',
        nativeId: 'native-primer-review',
        workspacePath: '/workspace/a',
      })
    ).toMatchObject({ enabled: true, scope: 'workspace' });
    expect(
      await store.resolveProviderSkillPolicy({
        provider: 'codex-sdk',
        nativeId: 'native-primer-review',
        workspacePath: '/workspace/b',
      })
    ).toMatchObject({ enabled: false, scope: 'global' });
    await store.removeProviderSkillPolicy({
      provider: 'codex-sdk',
      nativeId: 'native-primer-review',
      scope: 'workspace',
      workspacePath: '/workspace/a',
    });
    expect(
      await store.resolveProviderSkillPolicy({
        provider: 'codex-sdk',
        nativeId: 'native-primer-review',
        workspacePath: '/workspace/a',
      })
    ).toMatchObject({ enabled: false, scope: 'global' });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ schemaVersion: 3 });
  });

  it('creates and edits a host-associated skill in the app-owned library', async () => {
    const { store } = await fixture();
    const created = await store.saveSkill({
      name: 'plain-language',
      description: 'Explain technical work clearly.',
      instructions: 'Use plain English and concrete examples.',
      provider: 'claude-agent-sdk',
      scope: 'global',
      workspacePath: null,
      enabled: true,
    });
    await store.saveSkill({
      ...created,
      description: 'Explain scientific work clearly.',
      instructions: 'Use plain English, then give one concrete example.',
    });

    expect(await store.list({ workspacePath: null })).toMatchObject({
      skills: [
        expect.objectContaining({
          name: 'plain-language',
          description: 'Explain scientific work clearly.',
          provider: 'claude-agent-sdk',
        }),
      ],
    });
  });

  it('keeps same-named skills separate when they belong to different hosts', async () => {
    const { store } = await fixture();
    const shared = {
      name: 'sequence-audit',
      description: 'Audit a biological sequence.',
      instructions: 'Inspect every input before reporting.',
      scope: 'global' as const,
      workspacePath: null,
      enabled: true,
    };
    await store.saveSkill({ ...shared, provider: 'codex-sdk' });
    await store.saveSkill({ ...shared, provider: 'claude-agent-sdk' });

    expect((await store.list({ workspacePath: null })).skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'sequence-audit', provider: 'codex-sdk' }),
        expect.objectContaining({ name: 'sequence-audit', provider: 'claude-agent-sdk' }),
      ])
    );
  });

  it('updates a catalog skill atomically without changing its identity or enable state', async () => {
    const { root, store } = await fixture();
    const sourcePath = join(root, 'catalog-stage');
    await mkdir(join(sourcePath, 'references'), { recursive: true });
    await writeFile(
      join(sourcePath, 'SKILL.md'),
      [
        '---',
        'name: crispr-guide-audit',
        'description: Audit CRISPR guides, version one.',
        '---',
        '',
        'Use the version one checklist.',
      ].join('\n'),
      'utf8'
    );
    await writeFile(join(sourcePath, 'references', 'checklist.md'), 'version one\n', 'utf8');
    const source = {
      packId: 'biology-pack',
      packName: 'Biology Pack',
      publisher: 'Fixture Lab',
      repositoryUrl: 'https://github.com/fixture-lab/biology-pack',
      skillPath: 'skills/crispr-guide-audit',
      revision: 'a'.repeat(40),
      version: '1.0.0',
      license: 'MIT',
      additionalLicenses: [],
      compatibility: null,
    };

    const installed = await store.installCatalogSkill({
      sourcePath,
      provider: 'claude-agent-sdk',
      scope: 'global',
      workspacePath: null,
      source,
      contentDigest: '1'.repeat(64),
    });
    await store.setSkillEnabled({ id: installed.id, enabled: false });
    await writeFile(
      join(sourcePath, 'SKILL.md'),
      [
        '---',
        'name: crispr-guide-audit',
        'description: Audit CRISPR guides, version two.',
        '---',
        '',
        'Use the version two checklist.',
      ].join('\n'),
      'utf8'
    );
    await writeFile(join(sourcePath, 'references', 'checklist.md'), 'version two\n', 'utf8');

    const updated = await store.installCatalogSkill({
      sourcePath,
      provider: 'claude-agent-sdk',
      scope: 'global',
      workspacePath: null,
      source: { ...source, revision: 'b'.repeat(40), version: '2.0.0' },
      contentDigest: '2'.repeat(64),
    });

    expect(updated).toMatchObject({
      id: installed.id,
      enabled: false,
      description: 'Audit CRISPR guides, version two.',
      provider: 'claude-agent-sdk',
      contentDigest: '2'.repeat(64),
      source: { revision: 'b'.repeat(40), version: '2.0.0' },
    });
    expect(await readFile(join(updated.directoryPath, 'references', 'checklist.md'), 'utf8')).toBe(
      'version two\n'
    );
  });

  it('removes a managed skill and its app-owned files after confirmation', async () => {
    const { store } = await fixture();
    const skill = await store.saveSkill({
      name: 'plain-language',
      description: 'Explain technical work clearly.',
      instructions: 'Use plain English and concrete examples.',
      provider: 'all',
      scope: 'global',
      workspacePath: null,
      enabled: true,
    });

    await store.removeSkill(skill.id);

    expect((await store.list({ workspacePath: null })).skills).toEqual([]);
    await expect(readFile(join(skill.directoryPath, 'SKILL.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(store.removeSkill(skill.id)).rejects.toThrow('no longer exists');
  });

  it('removes command authority immediately and rejects stale deletion', async () => {
    const { store } = await fixture();
    const command = await store.saveCommand({
      name: 'explain-result',
      description: 'Explain an analysis result.',
      instructions: 'Explain the result in plain English.',
      provider: 'all',
      scope: 'global',
      workspacePath: null,
    });

    await store.removeCommand(command.id);
    expect((await store.list({ workspacePath: null })).commands).toEqual([]);
    await expect(store.removeCommand(command.id)).rejects.toThrow('no longer exists');
  });

  it('fails closed on a corrupt manifest without overwriting it', async () => {
    const { filePath, store } = await fixture();
    await writeFile(filePath, '{"schemaVersion":1,"commands":"not-an-array"}', 'utf8');

    await expect(store.list({ workspacePath: null })).rejects.toThrow('corrupt');
    await expect(
      store.saveCommand({
        name: 'must-not-save',
        description: 'Must not save.',
        instructions: 'Must not save.',
        provider: 'all',
        scope: 'global',
        workspacePath: null,
      })
    ).rejects.toThrow('corrupt');
    expect(await readFile(filePath, 'utf8')).toContain('not-an-array');
  });

  it('rejects a stored skill directory outside the app-owned library', async () => {
    const { filePath, store } = await fixture();
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 3,
        commands: [],
        providerSkillPolicies: [],
        skills: [
          {
            id: 'unsafe-skill',
            name: 'unsafe-skill',
            description: 'This must never own an external path.',
            instructions: 'Do not load this.',
            provider: 'all',
            scope: 'global',
            workspacePath: null,
            directoryPath: '/',
            enabled: true,
            hasSupportingFiles: false,
            origin: 'local',
            source: null,
            contentDigest: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }) + '\n',
      'utf8'
    );

    await expect(store.list({ workspacePath: null })).rejects.toThrow('corrupt');
    await expect(store.removeSkill('unsafe-skill')).rejects.toThrow('corrupt');
  });
});
