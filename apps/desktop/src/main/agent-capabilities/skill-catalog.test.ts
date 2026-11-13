import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentExtensionStore } from './extension-store';
import {
  AgentSkillCatalogService,
  CURATED_BIOLOGY_SKILL_PACKS,
  type AgentSkillPackDefinition,
} from './skill-catalog';
import { BUNDLED_SKILL_CATALOG_SEEDS } from './skill-catalog-seed.generated';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const REVISION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const fixturePack: AgentSkillPackDefinition = {
  id: 'fixture-biology',
  name: 'Fixture Biology',
  publisher: 'Fixture Lab',
  description: 'Biology skills used to prove dynamic catalog discovery.',
  repositoryOwner: 'fixture-lab',
  repositoryName: 'biology-skills',
  ref: 'main',
  skillsRoot: 'skills',
  delivery: 'dnaforge',
  trust: 'community',
  repositoryLicense: null,
};

const providerPack: AgentSkillPackDefinition = {
  id: 'provider-life-sciences',
  name: 'Provider Life Sciences',
  publisher: 'Fixture Provider',
  description: 'A provider-owned fixture used to prove the management boundary.',
  delivery: 'provider-native',
  provider: 'codex-sdk',
  sourceUrl: 'https://example.com/provider-life-sciences',
  trust: 'publisher',
  repositoryLicense: null,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sourceResponse(value: string, status = 200): Response {
  return new Response(value, { status, headers: { 'content-type': 'text/plain' } });
}

function fixtureFetch(options?: {
  truncated?: boolean;
  symlink?: boolean;
  oversized?: boolean;
  unsafePath?: boolean;
  omitLicense?: boolean;
}) {
  const skill = [
    '---',
    'name: crispr-guide-audit',
    'description: Audit CRISPR guide candidates before ordering.',
    ...(options?.omitLicense ? [] : ['license: MIT']),
    'compatibility: Requires a workspace containing candidate guide sequences.',
    'metadata:',
    '  version: "1.4.0"',
    '  author: Fixture Lab',
    '  model_license: CC-BY-NC-SA-4.0',
    'allowed-tools: Read Bash(bowtie:*)',
    '---',
    '',
    '# CRISPR guide audit',
    '',
    'Read references/checklist.md and report off-target assumptions.',
    '',
  ].join('\n');
  const checklist = 'Check PAM compatibility and likely off-target sites.\n';
  const script = '#!/usr/bin/env bash\nprintf "fixture only\\n"\n';
  const entries = [
    {
      path: 'skills/crispr-guide-audit/SKILL.md',
      mode: '100644',
      type: 'blob',
      sha: 'skill-blob',
      size: options?.oversized ? 25 * 1024 * 1024 + 1 : Buffer.byteLength(skill),
    },
    {
      path: options?.unsafePath
        ? 'skills/crispr-guide-audit/references/../escape.md'
        : 'skills/crispr-guide-audit/references/checklist.md',
      mode: '100644',
      type: 'blob',
      sha: 'reference-blob',
      size: Buffer.byteLength(checklist),
    },
    {
      path: 'skills/crispr-guide-audit/scripts/check.sh',
      mode: options?.symlink ? '120000' : '100755',
      type: 'blob',
      sha: 'script-blob',
      size: Buffer.byteLength(script),
    },
    {
      path: 'skills/future-protein-workflow/SKILL.md',
      mode: '100644',
      type: 'blob',
      sha: 'future-blob',
      size: 120,
    },
  ];
  return async (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/commits/main')) return json({ sha: REVISION });
    if (url.includes(`/git/trees/${REVISION}?recursive=1`)) {
      return json({ sha: REVISION, truncated: options?.truncated ?? false, tree: entries });
    }
    if (url.endsWith('/skills/crispr-guide-audit/SKILL.md')) return sourceResponse(skill);
    if (url.endsWith('/skills/crispr-guide-audit/references/checklist.md')) {
      return sourceResponse(checklist);
    }
    if (url.endsWith('/skills/crispr-guide-audit/scripts/check.sh')) {
      return sourceResponse(script);
    }
    return sourceResponse('not found', 404);
  };
}

async function service(options?: {
  truncated?: boolean;
  symlink?: boolean;
  oversized?: boolean;
  unsafePath?: boolean;
  omitLicense?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-skill-catalog-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const extensionStore = new AgentExtensionStore({
    filePath: join(root, 'extensions.json'),
    skillsRoot: join(root, 'skills'),
    now: () => 100,
    idGenerator: () => 'catalog-skill-1',
  });
  return {
    root,
    extensionStore,
    catalog: new AgentSkillCatalogService({
      extensionStore,
      stagingRoot: join(root, 'staging'),
      sources: [fixturePack],
      fetch: fixtureFetch(options),
      now: () => 100,
      idGenerator: () => 'catalog-snapshot-1',
      tokenGenerator: () => 'review-token-1',
    }),
  };
}

type CatalogFetcher = NonNullable<
  ConstructorParameters<typeof AgentSkillCatalogService>[0]['fetch']
>;

async function boundedCatalog(fetch: CatalogFetcher, curated = false) {
  const { root, extensionStore } = await service();
  return new AgentSkillCatalogService({
    extensionStore,
    stagingRoot: join(root, 'bounded-staging'),
    ...(curated ? {} : { sources: [fixturePack] }),
    fetch,
  });
}

describe('catalog request bounds', () => {
  const metadataLimit = 10 * 1024 * 1024;

  it('applies the project deadline to blocked headers and preserves the original abort cause', async () => {
    const controller = new AbortController();
    const cause = new DOMException('Synthetic request deadline', 'TimeoutError');
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const catalog = await boundedCatalog(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return new Promise<Response>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
          once: true,
        });
        queueMicrotask(() => controller.abort(cause));
      });
    });
    await expect(catalog.browsePack({ packId: fixturePack.id })).rejects.toBe(cause);
    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  it('cancels a blocked body on deadline without awaiting an uncooperative cancel promise', async () => {
    const controller = new AbortController();
    const cause = new DOMException('Synthetic body deadline', 'TimeoutError');
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const catalog = await boundedCatalog(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(target) {
            if (!sent) {
              sent = true;
              target.enqueue(new TextEncoder().encode('{'));
            } else controller.abort(cause);
          },
          cancel,
        })
      );
    });
    let outcome: unknown = null;
    const request = catalog.browsePack({ packId: fixturePack.id }).catch((error: unknown) => {
      outcome = error;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outcome).toBe(cause);
    expect(cancel).toHaveBeenCalledTimes(1);
    await request;
  });

  it('enforces actual streamed bytes despite a low declared length before full-body buffering', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
    const cancel = vi.fn();
    let response: Response | undefined;
    let buffered: ReturnType<typeof vi.spyOn> | undefined;
    const catalog = await boundedCatalog(async () => {
      let sent = 0;
      response = new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(target) {
              if (sent++ === 0) target.enqueue(new Uint8Array(metadataLimit).fill(32));
              else if (sent === 2) target.enqueue(new Uint8Array([32]));
              else target.close();
            },
            cancel,
          },
          { highWaterMark: 0 }
        ),
        { headers: { 'content-length': '1' } }
      );
      buffered = vi.spyOn(response, 'arrayBuffer');
      return response;
    });
    await expect(catalog.browsePack({ packId: fixturePack.id })).rejects.toThrow(
      'response is too large'
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(buffered).not.toHaveBeenCalled();
    expect(response?.body?.locked).toBe(false);
  });

  it('rejects an oversized declared body before reading it and preserves bundled fallback', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
    const cancel = vi.fn();
    let buffered: ReturnType<typeof vi.spyOn> | undefined;
    const catalog = await boundedCatalog(async () => {
      const response = new Response('oversized synthetic body', {
        headers: { 'content-length': String(metadataLimit + 1) },
      });
      if (!response.body) throw new Error('Synthetic response body unavailable');
      vi.spyOn(response.body, 'cancel').mockImplementation(async () => {
        cancel();
      });
      buffered = vi.spyOn(response, 'arrayBuffer');
      return response;
    }, true);
    const pack = CURATED_BIOLOGY_SKILL_PACKS[0];
    const snapshot = await catalog.browsePack({ packId: pack.id });
    expect(snapshot.packId).toBe(pack.id);
    expect(snapshot.revision).toBe(
      BUNDLED_SKILL_CATALOG_SEEDS.find((seed) => seed.packId === pack.id)?.revision
    );
    expect(snapshot.skills.length).toBeGreaterThan(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(buffered).not.toHaveBeenCalled();
  });

  it('accepts exactly the original metadata limit with unchanged public request fields', async () => {
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => new AbortController().signal);
    const upstream = fixtureFetch();
    const catalog = await boundedCatalog(async (input, init) => {
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toEqual({
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      });
      if (String(input).endsWith('/commits/main')) {
        const value = JSON.stringify({ sha: REVISION });
        return new Response(value + ' '.repeat(metadataLimit - Buffer.byteLength(value)));
      }
      return upstream(input);
    });
    const snapshot = await catalog.browsePack({ packId: fixturePack.id });
    expect(snapshot.skills.map((skill) => skill.name)).toContain('crispr-guide-audit');
    expect(timeout.mock.calls).toEqual([[15_000], [15_000]]);
  });

  it('keeps raw skill files above 10 MiB within the original 25 MiB accepted contract', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
    const definition =
      '---\nname: large-skill\ndescription: Synthetic large skill fixture.\nlicense: MIT\n---\n' +
      'x'.repeat(11 * 1024 * 1024);
    const catalog = await boundedCatalog(async (input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (String(input).endsWith('/commits/main')) return json({ sha: REVISION });
      if (String(input).includes('/git/trees/'))
        return json({
          tree: [
            {
              path: 'skills/large-skill/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'large-skill-blob',
              size: Buffer.byteLength(definition),
            },
          ],
          truncated: false,
        });
      return sourceResponse(definition);
    });
    const snapshot = await catalog.browsePack({ packId: fixturePack.id });
    const review = await catalog.reviewSkill({
      snapshotId: snapshot.snapshotId,
      skillId: 'skills/large-skill',
    });
    expect(review).toMatchObject({ ok: true, skill: { name: 'large-skill', license: 'MIT' } });
  });

  it('preserves successful null-body bytes and the existing metadata JSON failure', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
    const catalog = await boundedCatalog(async () => new Response(null));
    await expect(catalog.browsePack({ packId: fixturePack.id })).rejects.toThrow(SyntaxError);
  });

  it('retains the exact bundled revision after a metadata deadline without installing anything', async () => {
    const controller = new AbortController();
    const cause = new DOMException('Synthetic metadata deadline', 'TimeoutError');
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const catalog = await boundedCatalog(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return new Promise<Response>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
          once: true,
        });
        queueMicrotask(() => controller.abort(cause));
      });
    }, true);
    const pack = CURATED_BIOLOGY_SKILL_PACKS[0];
    const snapshot = await catalog.browsePack({ packId: pack.id });
    expect(snapshot.revision).toBe(
      BUNDLED_SKILL_CATALOG_SEEDS.find((seed) => seed.packId === pack.id)?.revision
    );
    expect(timeout).toHaveBeenCalledWith(15_000);
  });
});

describe('biology skill catalog', () => {
  it('consumes a reviewed token on a real controlled file-fetch failure and requires a fresh review before retry', async () => {
    const { root, extensionStore } = await service();
    const fetcher = fixtureFetch();
    let fail = false;
    let tokens = 0;
    const catalog = new AgentSkillCatalogService({
      extensionStore,
      stagingRoot: join(root, 'retry-staging'),
      sources: [fixturePack],
      tokenGenerator: () => `fresh-${++tokens}`,
      fetch: async (input) =>
        fail && String(input).endsWith('/references/checklist.md')
          ? sourceResponse('synthetic unavailable', 503)
          : fetcher(input),
    });
    const snapshot = await catalog.browsePack({ packId: fixturePack.id });
    const review = await catalog.reviewSkill({
      snapshotId: snapshot.snapshotId,
      skillId: 'skills/crispr-guide-audit',
    });
    if (!review.ok) throw new Error(review.error);
    fail = true;
    const request = {
      reviewToken: review.reviewToken,
      provider: 'all' as const,
      scope: 'global' as const,
      workspacePath: null,
    };
    expect(await catalog.installSkill(request)).toMatchObject({ ok: false, stage: 'download' });
    expect((await extensionStore.list({ workspacePath: null })).skills).toEqual([]);
    expect(await catalog.installSkill(request)).toEqual({
      ok: false,
      error: 'Review this skill again before installing it.',
    });
    fail = false;
    const fresh = await catalog.reviewSkill({
      snapshotId: snapshot.snapshotId,
      skillId: 'skills/crispr-guide-audit',
    });
    if (!fresh.ok) throw new Error(fresh.error);
    expect(fresh.reviewToken).not.toBe(review.reviewToken);
    expect(await catalog.installSkill({ ...request, reviewToken: fresh.reviewToken })).toEqual({
      ok: true,
      skillId: 'catalog-skill-1',
    });
    const [installed] = (await extensionStore.list({ workspacePath: null })).skills;
    expect(await readFile(join(installed.directoryPath, 'references/checklist.md'), 'utf8')).toBe(
      'Check PAM compatibility and likely off-target sites.\n'
    );
  });

  it('preserves token consumption and prior data after a real staging-directory refusal', async () => {
    const { root, extensionStore } = await service();
    const staging = join(root, 'blocked-staging');
    await writeFile(staging, 'synthetic blocker');
    let token = 0;
    const catalog = new AgentSkillCatalogService({
      extensionStore,
      stagingRoot: staging,
      sources: [fixturePack],
      fetch: fixtureFetch(),
      tokenGenerator: () => `staging-${++token}`,
    });
    const snapshot = await catalog.browsePack({ packId: fixturePack.id });
    const review = await catalog.reviewSkill({
      snapshotId: snapshot.snapshotId,
      skillId: 'skills/crispr-guide-audit',
    });
    if (!review.ok) throw new Error(review.error);
    const request = {
      reviewToken: review.reviewToken,
      provider: 'all' as const,
      scope: 'global' as const,
      workspacePath: null,
    };
    expect(await catalog.installSkill(request)).toMatchObject({ ok: false, stage: 'staging' });
    expect(await readFile(staging, 'utf8')).toBe('synthetic blocker');
    expect(await catalog.installSkill(request)).toMatchObject({
      ok: false,
      error: 'Review this skill again before installing it.',
    });
    await rm(staging);
    const fresh = await catalog.reviewSkill({
      snapshotId: snapshot.snapshotId,
      skillId: 'skills/crispr-guide-audit',
    });
    if (!fresh.ok) throw new Error(fresh.error);
    expect(
      await catalog.installSkill({ ...request, reviewToken: fresh.reviewToken })
    ).toMatchObject({ ok: true });
  });

  it('expires old authority and never admits the same token twice during a held native download', async () => {
    const { root, extensionStore } = await service();
    let clock = 100;
    let token = 0;
    let held = false;
    let release!: () => void;
    const gate = new Promise<void>((yes) => {
      release = yes;
    });
    let entered!: () => void;
    const started = new Promise<void>((yes) => {
      entered = yes;
    });
    const fetcher = fixtureFetch();
    const catalog = new AgentSkillCatalogService({
      extensionStore,
      stagingRoot: join(root, 'held-staging'),
      sources: [fixturePack],
      now: () => clock,
      tokenGenerator: () => `expiry-${++token}`,
      fetch: async (input) => {
        if (held && String(input).endsWith('/SKILL.md')) {
          entered();
          await gate;
        }
        return fetcher(input);
      },
    });
    const snapshot = await catalog.browsePack({ packId: fixturePack.id });
    const old = await catalog.reviewSkill({
      snapshotId: snapshot.snapshotId,
      skillId: 'skills/crispr-guide-audit',
    });
    if (!old.ok) throw new Error(old.error);
    clock += 600_001;
    const request = {
      reviewToken: old.reviewToken,
      provider: 'all' as const,
      scope: 'global' as const,
      workspacePath: null,
    };
    expect(await catalog.installSkill(request)).toMatchObject({
      ok: false,
      error: 'Review this skill again before installing it.',
    });
    const fresh = await catalog.reviewSkill({
      snapshotId: snapshot.snapshotId,
      skillId: 'skills/crispr-guide-audit',
    });
    if (!fresh.ok) throw new Error(fresh.error);
    held = true;
    const pending = catalog.installSkill({ ...request, reviewToken: fresh.reviewToken });
    await started;
    try {
      expect(
        await catalog.installSkill({ ...request, reviewToken: fresh.reviewToken })
      ).toMatchObject({ ok: false, error: 'Review this skill again before installing it.' });
    } finally {
      release();
    }
    expect(await pending).toMatchObject({ ok: true });
    expect((await extensionStore.list({ workspacePath: null })).skills).toHaveLength(1);
  });

  it('keeps a committed native receipt when cleanup fails and retains the staging evidence', async () => {
    const { root, extensionStore } = await service();
    let retained = '';
    const catalog = new AgentSkillCatalogService({
      extensionStore,
      stagingRoot: join(root, 'cleanup-staging'),
      sources: [fixturePack],
      fetch: fixtureFetch(),
      removeStagingDirectory: async (path) => {
        retained = path;
        throw new Error('Synthetic cleanup refusal');
      },
    });
    const snapshot = await catalog.browsePack({ packId: fixturePack.id });
    const review = await catalog.reviewSkill({
      snapshotId: snapshot.snapshotId,
      skillId: 'skills/crispr-guide-audit',
    });
    if (!review.ok) throw new Error(review.error);
    expect(
      await catalog.installSkill({
        reviewToken: review.reviewToken,
        provider: 'all',
        scope: 'global',
        workspacePath: null,
      })
    ).toEqual({ ok: true, skillId: 'catalog-skill-1', cleanupIncomplete: true });
    expect((await extensionStore.list({ workspacePath: null })).skills).toHaveLength(1);
    expect(await readFile(join(retained, 'references/checklist.md'), 'utf8')).toContain(
      'Check PAM compatibility'
    );
  });

  it('preserves a real colliding local installation and manifest when the catalog commit is refused', async () => {
    const { root, extensionStore, catalog } = await service();
    await extensionStore.saveSkill({
      name: 'crispr-guide-audit',
      description: 'Local synthetic review',
      instructions: 'Retained local body',
      provider: 'all',
      scope: 'global',
      workspacePath: null,
      enabled: false,
    });
    const before = await readFile(join(root, 'extensions.json'), 'utf8');
    const existing = (await extensionStore.list({ workspacePath: null })).skills;
    const snapshot = await catalog.browsePack({ packId: fixturePack.id });
    const review = await catalog.reviewSkill({
      snapshotId: snapshot.snapshotId,
      skillId: 'skills/crispr-guide-audit',
    });
    if (!review.ok) throw new Error(review.error);
    expect(
      await catalog.installSkill({
        reviewToken: review.reviewToken,
        provider: 'all',
        scope: 'global',
        workspacePath: null,
      })
    ).toMatchObject({
      ok: false,
      stage: 'commit',
      error: 'A different skill with this name already exists here.',
    });
    expect(await readFile(join(root, 'extensions.json'), 'utf8')).toBe(before);
    expect((await extensionStore.list({ workspacePath: null })).skills).toEqual(existing);
  });

  it('ships source definitions without hard-coding their individual skills', () => {
    expect(CURATED_BIOLOGY_SKILL_PACKS.map((pack) => pack.id)).toEqual([
      'k-dense-scientific-agent-skills',
      'clawbio',
      'bioconductor-ai-agent-skills',
    ]);
    expect(CURATED_BIOLOGY_SKILL_PACKS.every((pack) => !('skills' in pack))).toBe(true);
    expect(CURATED_BIOLOGY_SKILL_PACKS.every((pack) => pack.delivery === 'dnaforge')).toBe(true);
    expect(CURATED_BIOLOGY_SKILL_PACKS[0]).toMatchObject({
      skillsRoot: 'skills',
      repositoryLicense: 'MIT',
    });
  });

  it('routes provider-owned packs to their CLI without inventing a downloadable repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-provider-skill-catalog-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const catalog = new AgentSkillCatalogService({
      extensionStore: new AgentExtensionStore({
        filePath: join(root, 'extensions.json'),
        skillsRoot: join(root, 'skills'),
      }),
      stagingRoot: join(root, 'staging'),
      sources: [providerPack],
    });

    const lifeSciences = catalog.listPacks().find((pack) => pack.id === 'provider-life-sciences');
    expect(lifeSciences).toMatchObject({
      name: 'Provider Life Sciences',
      provider: 'codex-sdk',
      repositoryUrl: 'https://example.com/provider-life-sciences',
    });
    await expect(catalog.browsePack({ packId: 'provider-life-sciences' })).rejects.toThrow(
      'Manage this provider-owned pack in its CLI section.'
    );
  });

  it('discovers future skills from an immutable upstream tree and reviews exact contents', async () => {
    const { catalog } = await service();
    const snapshot = await catalog.browsePack({ packId: fixturePack.id });

    expect(snapshot).toMatchObject({
      snapshotId: 'catalog-snapshot-1',
      packId: fixturePack.id,
      revision: REVISION,
      skills: [
        expect.objectContaining({
          id: 'skills/crispr-guide-audit',
          name: 'crispr-guide-audit',
        }),
        expect.objectContaining({
          id: 'skills/future-protein-workflow',
          name: 'future-protein-workflow',
        }),
      ],
    });

    const review = await catalog.reviewSkill({
      snapshotId: snapshot.snapshotId,
      skillId: 'skills/crispr-guide-audit',
    });
    expect(review).toMatchObject({
      ok: true,
      reviewToken: 'review-token-1',
      skill: {
        name: 'crispr-guide-audit',
        description: 'Audit CRISPR guide candidates before ordering.',
        version: '1.4.0',
        license: 'MIT',
        additionalLicenses: [
          {
            key: 'model_license',
            label: 'Model license',
            value: 'CC-BY-NC-SA-4.0',
          },
        ],
        compatibility: 'Requires a workspace containing candidate guide sequences.',
        allowedTools: 'Read Bash(bowtie:*)',
        revision: REVISION,
        fileCount: 3,
        hasScripts: true,
        installable: true,
        document: expect.stringContaining(
          '# CRISPR guide audit\n\nRead references/checklist.md and report off-target assumptions.'
        ),
        files: [
          expect.objectContaining({ path: 'references/checklist.md' }),
          expect.objectContaining({ path: 'scripts/check.sh' }),
          expect.objectContaining({ path: 'SKILL.md' }),
        ],
      },
    });
  });

  it('reuses a recent pack snapshot until an explicit refresh instead of exhausting GitHub requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-skill-catalog-cache-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const upstream = fixtureFetch();
    let requestCount = 0;
    const catalog = new AgentSkillCatalogService({
      extensionStore: new AgentExtensionStore({
        filePath: join(root, 'extensions.json'),
        skillsRoot: join(root, 'skills'),
      }),
      stagingRoot: join(root, 'staging'),
      sources: [fixturePack],
      fetch: async (input) => {
        requestCount += 1;
        return upstream(input);
      },
      now: () => 100,
      idGenerator: () => `catalog-snapshot-${requestCount}`,
    });

    const first = await catalog.browsePack({ packId: fixturePack.id });
    const second = await catalog.browsePack({ packId: fixturePack.id });
    expect(second).toEqual(first);
    expect(requestCount).toBe(2);

    await catalog.browsePack({ packId: fixturePack.id, forceRefresh: true });
    expect(requestCount).toBe(4);
  });

  it('falls back to the bundled curated snapshot when GitHub rejects anonymous API requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-skill-catalog-seed-fallback-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    let requestCount = 0;
    const catalog = new AgentSkillCatalogService({
      extensionStore: new AgentExtensionStore({
        filePath: join(root, 'extensions.json'),
        skillsRoot: join(root, 'skills'),
      }),
      stagingRoot: join(root, 'staging'),
      fetch: async () => {
        requestCount += 1;
        return json(
          {
            message: 'API rate limit exceeded',
          },
          403
        );
      },
    });

    const snapshots = await Promise.all(
      CURATED_BIOLOGY_SKILL_PACKS.map((pack) => catalog.browsePack({ packId: pack.id }))
    );
    expect(snapshots.map((snapshot) => snapshot.packId)).toEqual(
      CURATED_BIOLOGY_SKILL_PACKS.map((pack) => pack.id)
    );
    expect(snapshots.every((snapshot) => /^[a-f0-9]{40}$/u.test(snapshot.revision))).toBe(true);
    expect(snapshots.every((snapshot) => snapshot.skills.length > 0)).toBe(true);
    expect(snapshots.flatMap((snapshot) => snapshot.skills).length).toBeGreaterThan(200);
    expect(
      snapshots.every((snapshot) =>
        snapshot.skills.every((skill) => skill.id.startsWith('skills/'))
      )
    ).toBe(true);
    expect(requestCount).toBe(CURATED_BIOLOGY_SKILL_PACKS.length);
  });

  it('requires a current review token and installs the reviewed revision with provenance', async () => {
    const { catalog, extensionStore } = await service();
    const snapshot = await catalog.browsePack({ packId: fixturePack.id });
    const unreviewed = await catalog.installSkill({
      reviewToken: 'not-reviewed',
      provider: 'all',
      scope: 'global',
      workspacePath: null,
    });
    expect(unreviewed).toEqual({
      ok: false,
      error: 'Review this skill again before installing it.',
    });

    const review = await catalog.reviewSkill({
      snapshotId: snapshot.snapshotId,
      skillId: 'skills/crispr-guide-audit',
    });
    if (!review.ok) throw new Error(review.error);
    expect((await extensionStore.list({ workspacePath: null })).skills).toEqual([]);

    const installed = await catalog.installSkill({
      reviewToken: review.reviewToken,
      provider: 'all',
      scope: 'global',
      workspacePath: null,
    });
    expect(installed).toEqual({ ok: true, skillId: 'catalog-skill-1' });
    const [skill] = (await extensionStore.list({ workspacePath: null })).skills;
    expect(skill).toMatchObject({
      id: 'catalog-skill-1',
      name: 'crispr-guide-audit',
      origin: 'catalog',
      source: {
        packId: fixturePack.id,
        publisher: 'Fixture Lab',
        repositoryUrl: 'https://github.com/fixture-lab/biology-skills',
        skillPath: 'skills/crispr-guide-audit',
        revision: REVISION,
        version: '1.4.0',
        license: 'MIT',
        additionalLicenses: [
          {
            key: 'model_license',
            label: 'Model license',
            value: 'CC-BY-NC-SA-4.0',
          },
        ],
      },
    });
    expect(await readFile(join(skill.directoryPath, 'references', 'checklist.md'), 'utf8')).toBe(
      'Check PAM compatibility and likely off-target sites.\n'
    );
  });

  it('rejects a truncated source tree before exposing a partial catalog', async () => {
    const { catalog } = await service({ truncated: true });
    await expect(catalog.browsePack({ packId: fixturePack.id })).rejects.toThrow(
      'complete source tree'
    );
  });

  it('refuses app-owned installation when neither the skill nor repository declares a license', async () => {
    const { catalog } = await service({ omitLicense: true });
    const snapshot = await catalog.browsePack({ packId: fixturePack.id });
    const review = await catalog.reviewSkill({
      snapshotId: snapshot.snapshotId,
      skillId: 'skills/crispr-guide-audit',
    });
    expect(review).toMatchObject({
      ok: true,
      skill: {
        license: null,
        installable: false,
        installBlockReason: 'missing-license',
      },
    });
    if (!review.ok) throw new Error(review.error);
    await expect(
      catalog.installSkill({
        reviewToken: review.reviewToken,
        provider: 'all',
        scope: 'global',
        workspacePath: null,
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Review this skill again before installing it.',
    });
  });

  it('rejects stale snapshots and unsafe repository paths before fetching skill files', async () => {
    const { catalog } = await service({ unsafePath: true });
    await expect(
      catalog.reviewSkill({
        snapshotId: 'missing-snapshot',
        skillId: 'skills/crispr-guide-audit',
      })
    ).resolves.toEqual({ ok: false, error: 'Refresh this skill pack before reviewing it.' });

    const snapshot = await catalog.browsePack({ packId: fixturePack.id });
    const review = await catalog.reviewSkill({
      snapshotId: snapshot.snapshotId,
      skillId: 'skills/crispr-guide-audit',
    });
    expect(review).toMatchObject({ ok: false });
    if (!review.ok) expect(review.error).toContain('unsafe path');
  });

  it.each([
    ['symbolic link', { symlink: true }, 'symbolic links'],
    ['oversized skill', { oversized: true }, '25 MB'],
  ])('rejects a %s during review before installation', async (_label, options, expected) => {
    const { catalog } = await service(options);
    const snapshot = await catalog.browsePack({ packId: fixturePack.id });
    const review = await catalog.reviewSkill({
      snapshotId: snapshot.snapshotId,
      skillId: 'skills/crispr-guide-audit',
    });
    expect(review).toMatchObject({ ok: false });
    if (!review.ok) expect(review.error).toContain(expected);
  });
});
