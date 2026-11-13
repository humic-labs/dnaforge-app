import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import CIDAR_RAW from '../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/cidar.json?raw';
import YTK_RAW from '../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/ytk.json?raw';
import { mocloAssemblySchemaOptions, parseMocloKitDefinition } from './moclo-kit-definition';
import {
  loadMocloSchemaCatalog,
  saveMocloKit,
  saveMocloSchema,
  subscribeMocloSchemaCatalog,
} from './moclo-schema-catalog';

function fileSystem(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    exists: async (path: string) =>
      files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`)),
    readDir: async (path: string) =>
      [...files.keys()]
        .filter((key) => key.startsWith(`${path}/`))
        .map((key) => ({ name: key.slice(path.length + 1), isFile: true, isDirectory: false })),
    readTextFile: async (path: string) => {
      if (!files.has(path)) throw new Error('Missing file');
      return files.get(path)!;
    },
    sha256File: async (path: string) =>
      `sha256:${createHash('sha256').update(files.get(path)!).digest('hex')}`,
    writeWorkspaceTextFileAtomic: vi.fn(
      async (input: { path: string; content: string; expectedContentHash?: string }) => {
        if (
          input.expectedContentHash &&
          input.expectedContentHash !==
            createHash('sha256').update(files.get(input.path)!).digest('hex')
        ) {
          throw new Error('Kit file changed before atomic write.');
        }
        files.set(input.path, input.content);
        return { path: input.path, contentHash: 'saved' };
      }
    ),
  };
}

describe('reusable MoClo schema catalog', () => {
  const kitInput = {
    projectRoot: '/project',
    kitId: 'my-kit',
    name: 'My kit',
    description: 'Reviewed reporter parts.',
    expectedKitRevision: 0,
    partTypes: [{ id: 'promoter', label: 'Promoter', roleTerms: [{ label: 'Promoter' }] }],
    members: [{ sequencePackageId: 'package-promoter', partTypeId: 'promoter' }],
  };
  const resolveMembers = vi.fn(async (_root: string, ids: readonly string[]) =>
    ids.map((packageId) => ({ packageId, name: `Managed ${packageId}` }))
  );

  it('creates a kit from managed members without a design or duplicated sequence bytes', async () => {
    const fs = fileSystem({});
    const result = await saveMocloKit(kitInput, fs, resolveMembers);
    const kit = parseMocloKitDefinition(fs.files.get('/project/.forge/moclo-kits/my-kit.json')!);
    expect(result.kitRevision).toBe(1);
    expect(kit.members).toEqual([
      {
        id: 'package-promoter',
        name: 'Managed package-promoter',
        sequencePackageId: 'package-promoter',
        partTypeId: 'promoter',
      },
    ]);
    expect(kit.partTypes).toEqual(kitInput.partTypes);
    expect(kit.recipes).toEqual([]);
    expect(resolveMembers).toHaveBeenLastCalledWith('/project', ['package-promoter']);
  });

  it('saves schemas directly with a kit and preserves them across member-only updates', async () => {
    const fs = fileSystem({});
    const assemblySchemas = parseMocloKitDefinition(CIDAR_RAW).assemblySchemas!;
    await saveMocloKit({ ...kitInput, assemblySchemas }, fs, resolveMembers);
    const read = () =>
      parseMocloKitDefinition(fs.files.get('/project/.forge/moclo-kits/my-kit.json')!);
    expect(read().assemblySchemas).toEqual(assemblySchemas);
    await saveMocloKit({ ...kitInput, expectedKitRevision: 1 }, fs, resolveMembers);
    expect(read().assemblySchemas).toEqual(assemblySchemas);
    const invalid = structuredClone(assemblySchemas);
    invalid[0]!.slots[0]!.outgoingOverhang = 'A';
    await expect(
      saveMocloKit(
        { ...kitInput, expectedKitRevision: 2, assemblySchemas: invalid },
        fs,
        resolveMembers
      )
    ).rejects.toThrow();
    expect(read().revision).toBe(2);
    expect(fs.writeWorkspaceTextFileAtomic).toHaveBeenCalledTimes(2);
  });

  it('updates members and roles without dropping existing members, schemas or recipes', async () => {
    const fs = fileSystem({});
    await saveMocloKit(kitInput, fs, resolveMembers);
    const schema = mocloAssemblySchemaOptions(parseMocloKitDefinition(CIDAR_RAW))[0].schema;
    await saveMocloSchema(
      {
        projectRoot: '/project',
        kitId: 'my-kit',
        expectedKitRevision: 1,
        templateId: 'reporter',
        name: 'Reporter',
        description: 'Reviewed layout',
        schema,
        topology: 'circular',
      },
      fs
    );
    const before = parseMocloKitDefinition(fs.files.get('/project/.forge/moclo-kits/my-kit.json')!);
    await saveMocloKit(
      {
        projectRoot: '/project',
        kitId: 'my-kit',
        expectedKitRevision: 2,
        partTypes: [{ id: 'cds', label: 'CDS', roleTerms: [{ label: 'CDS' }] }],
        members: [{ sequencePackageId: 'package-cds', partTypeId: 'cds' }],
      },
      fs,
      resolveMembers
    );
    const updated = parseMocloKitDefinition(
      fs.files.get('/project/.forge/moclo-kits/my-kit.json')!
    );
    expect(updated.revision).toBe(3);
    expect(updated.members).toHaveLength(2);
    expect(updated.members[0]).toEqual(before.members[0]);
    expect(updated.partTypes).toHaveLength(2);
    expect(updated.assemblySchemas).toEqual(before.assemblySchemas);
    expect(updated.recipes).toEqual(before.recipes);
    await expect(
      saveMocloKit({ ...kitInput, expectedKitRevision: 2 }, fs, resolveMembers)
    ).rejects.toThrow(/changed/i);
    expect(fs.writeWorkspaceTextFileAtomic).toHaveBeenCalledTimes(3);
  });

  it('rejects unresolved or foreign members, raw paths and unknown types before writing', async () => {
    const fs = fileSystem({});
    await expect(saveMocloKit(kitInput, fs, async () => [])).rejects.toThrow(
      /project|unavailable|missing/i
    );
    await expect(
      saveMocloKit(
        { ...kitInput, members: [{ sequencePackageId: 'repo/part/part.gb' }] },
        fs,
        resolveMembers
      )
    ).rejects.toThrow(/path/i);
    await expect(
      saveMocloKit(
        {
          ...kitInput,
          members: [{ sequencePackageId: 'package-promoter', partTypeId: 'invented' }],
        },
        fs,
        resolveMembers
      )
    ).rejects.toThrow(/unknown part type/i);
    expect(fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });

  it('does not overwrite a kit file changed during member resolution', async () => {
    const fs = fileSystem({});
    await saveMocloKit(kitInput, fs, resolveMembers);
    const path = '/project/.forge/moclo-kits/my-kit.json';
    let intervening = '';
    await expect(
      saveMocloKit({ ...kitInput, expectedKitRevision: 1 }, fs, async (root, ids) => {
        const changed = JSON.parse(fs.files.get(path)!);
        changed.description = 'Intervening user edit';
        intervening = JSON.stringify(changed);
        fs.files.set(path, intervening);
        return resolveMembers(root, ids);
      })
    ).rejects.toThrow(/changed before atomic write/);
    expect(fs.files.get(path)).toBe(intervening);
  });

  it('explicitly clears a member role without removing the package or type definition', async () => {
    const fs = fileSystem({});
    await saveMocloKit(kitInput, fs, resolveMembers);
    await saveMocloKit(
      {
        projectRoot: '/project',
        kitId: 'my-kit',
        expectedKitRevision: 1,
        members: [{ sequencePackageId: 'package-promoter', partTypeId: null }],
      },
      fs,
      resolveMembers
    );
    const kit = parseMocloKitDefinition(fs.files.get('/project/.forge/moclo-kits/my-kit.json')!);
    expect(kit.members).toHaveLength(1);
    expect(kit.members[0].partTypeId).toBeUndefined();
    expect(kit.partTypes).toEqual(kitInput.partTypes);
  });

  it('removes only explicitly named members, types and schemas in one revision', async () => {
    const fs = fileSystem({ '/project/sequence-package/source.txt': 'untouched source' });
    const assemblySchemas = parseMocloKitDefinition(CIDAR_RAW).assemblySchemas!;
    await saveMocloKit({ ...kitInput, assemblySchemas }, fs, resolveMembers);
    await saveMocloKit(
      {
        projectRoot: '/project',
        kitId: 'my-kit',
        expectedKitRevision: 1,
        removeMemberPackageIds: ['package-promoter'],
        removePartTypeIds: ['promoter'],
        removeSchemaIds: [assemblySchemas[0].id],
      },
      fs,
      resolveMembers
    );
    const kit = (await loadMocloSchemaCatalog('/project', fs)).definitions.find(
      (k) => k.id === 'my-kit'
    )!;
    expect(kit).toMatchObject({ revision: 2, members: [], partTypes: [], assemblySchemas: [] });
    expect(fs.files.get('/project/sequence-package/source.txt')).toBe('untouched source');
    expect(resolveMembers).toHaveBeenLastCalledWith('/project', []);
    expect(fs.writeWorkspaceTextFileAtomic).toHaveBeenCalledTimes(2);
  });

  it('rejects conflicting, missing or still-referenced removals without writing', async () => {
    const fs = fileSystem({});
    await saveMocloKit(kitInput, fs, resolveMembers);
    const original = fs.files.get('/project/.forge/moclo-kits/my-kit.json');
    for (const edit of [
      { removePartTypeIds: ['promoter'] },
      { removeMemberPackageIds: ['missing-package'] },
      { removeMemberPackageIds: ['package-promoter', 'package-promoter'] },
      { removeMemberPackageIds: ['package-promoter'], members: kitInput.members },
    ]) {
      await expect(
        saveMocloKit(
          { projectRoot: '/project', kitId: 'my-kit', expectedKitRevision: 1, ...edit },
          fs,
          resolveMembers
        )
      ).rejects.toThrow();
      expect(fs.files.get('/project/.forge/moclo-kits/my-kit.json')).toBe(original);
    }
    expect(fs.writeWorkspaceTextFileAtomic).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a removed bundled or recipe-derived schema on reload', async () => {
    for (const raw of [CIDAR_RAW, YTK_RAW]) {
      const original = parseMocloKitDefinition(raw);
      const fs = fileSystem({ [`/project/.forge/moclo-kits/${original.id}.json`]: raw });
      const schemaId = mocloAssemblySchemaOptions(original)[0].schema.origin!.schemaId;
      await saveMocloKit(
        {
          projectRoot: '/project',
          kitId: original.id,
          expectedKitRevision: original.revision,
          removeSchemaIds: [schemaId],
        },
        fs,
        resolveMembers
      );
      const reloaded = (await loadMocloSchemaCatalog('/project', fs)).definitions.find(
        (k) => k.id === original.id
      )!;
      expect(
        mocloAssemblySchemaOptions(reloaded).map((o) => o.schema.origin!.schemaId)
      ).not.toContain(schemaId);
      expect(reloaded.members).toHaveLength(original.members.length);
      expect(reloaded.recipes).toEqual(original.recipes);
    }
  });

  it('migrates version 2 into explicit schema snapshots without rewriting files or revisions', async () => {
    const fs = fileSystem({ '/project/.forge/moclo-kits/ytk.json': YTK_RAW });
    const kit = (await loadMocloSchemaCatalog('/project', fs)).definitions.find(
      (k) => k.id === 'ytk'
    )!;
    expect(kit.formatVersion).toBe(3);
    expect(kit.revision).toBe(1);
    expect(kit.assemblySchemas).toHaveLength(3);
    expect(parseMocloKitDefinition(JSON.stringify(kit))).toEqual(kit);
    expect(fs.files.get('/project/.forge/moclo-kits/ytk.json')).toBe(YTK_RAW);
    expect(fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });

  it('refuses future formats without overwriting the file or substituting a bundled kit', async () => {
    const future = { ...JSON.parse(CIDAR_RAW), formatVersion: 999 };
    const raw = JSON.stringify(future);
    const path = '/project/.forge/moclo-kits/cidar.json';
    const fs = fileSystem({ [path]: raw });
    const catalog = await loadMocloSchemaCatalog('/project', fs);
    expect(catalog.definitions.some((k) => k.id === future.id)).toBe(false);
    expect(catalog.issues[0].message).toMatch(/unsupported.*999/);
    await expect(
      saveMocloKit(
        { projectRoot: '/project', kitId: future.id, expectedKitRevision: 1, name: 'Overwrite' },
        fs,
        resolveMembers
      )
    ).rejects.toThrow(/unsupported/);
    expect(fs.files.get(path)).toBe(raw);
    expect(fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });

  it('supplies the missing CIDAR template to old projects without rewriting their kit', async () => {
    const old = JSON.parse(CIDAR_RAW);
    delete old.assemblySchemas;
    old.revision = 1;
    const original = JSON.stringify(old);
    const fs = fileSystem({ '/project/.forge/moclo-kits/cidar.json': original });
    const catalog = await loadMocloSchemaCatalog('/project', fs);
    const kit = catalog.definitions.find((item) => item.id === old.id)!;
    expect(mocloAssemblySchemaOptions(kit)).toHaveLength(1);
    expect(kit.members).toEqual(old.members);
    expect(fs.files.get('/project/.forge/moclo-kits/cidar.json')).toBe(original);
    expect(fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });

  it('keeps a project template instead of replacing it with the built-in version', async () => {
    const local = JSON.parse(CIDAR_RAW);
    local.assemblySchemas[0].name = 'My approved transcription unit';
    const fs = fileSystem({ '/project/.forge/moclo-kits/cidar.json': JSON.stringify(local) });
    const catalog = await loadMocloSchemaCatalog('/project', fs);
    expect(
      mocloAssemblySchemaOptions(catalog.definitions.find((kit) => kit.id === local.id)!)[0].schema
        .name
    ).toBe('My approved transcription unit');
  });

  it('saves a reviewed template without dropping members or legacy recipe schemas, and reloads it only in its project', async () => {
    const original = parseMocloKitDefinition(YTK_RAW);
    const fs = fileSystem({ '/project/.forge/moclo-kits/ytk.json': YTK_RAW });
    const schema = structuredClone(mocloAssemblySchemaOptions(original)[1].schema);
    const saved = await saveMocloSchema(
      {
        projectRoot: '/project',
        kitId: 'ytk',
        expectedKitRevision: 1,
        templateId: 'reviewed-cassette',
        name: 'Reviewed cassette',
        description: 'A reusable reviewed layout.',
        schema,
        topology: 'circular',
      },
      fs
    );
    expect(saved.schemaId).toBe('ytk:reviewed-cassette');
    const persisted = parseMocloKitDefinition(fs.files.get('/project/.forge/moclo-kits/ytk.json')!);
    expect(persisted.members).toEqual(original.members);
    expect(persisted.recipes).toEqual(original.recipes);
    expect(persisted.revision).toBe(2);
    expect(mocloAssemblySchemaOptions(persisted)).toHaveLength(4);
    expect(fs.writeWorkspaceTextFileAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: '/project',
        mode: 'replace',
        expectedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
    const reloaded = await loadMocloSchemaCatalog('/project', fs);
    expect(
      mocloAssemblySchemaOptions(reloaded.definitions.find((kit) => kit.id === 'ytk')!).some(
        (item) => item.schema.id === saved.schemaId
      )
    ).toBe(true);
    const other = await loadMocloSchemaCatalog('/other', fs);
    expect(
      other.definitions
        .flatMap(mocloAssemblySchemaOptions)
        .some((item) => item.schema.id === saved.schemaId)
    ).toBe(false);
    expect(schema).toEqual(mocloAssemblySchemaOptions(original)[1].schema);
  });

  it('rejects stale kit revisions before writing', async () => {
    const kit = parseMocloKitDefinition(YTK_RAW);
    const fs = fileSystem({ '/project/.forge/moclo-kits/ytk.json': YTK_RAW });
    await expect(
      saveMocloSchema(
        {
          projectRoot: '/project',
          kitId: 'ytk',
          expectedKitRevision: 0,
          templateId: 'new',
          name: 'New',
          description: 'Test',
          schema: mocloAssemblySchemaOptions(kit)[0].schema,
          topology: 'circular',
        },
        fs
      )
    ).rejects.toThrow(/changed/i);
    expect(fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });

  it('does not replace conflicting project kits with a seemingly valid built-in kit', async () => {
    const fs = fileSystem({
      '/project/.forge/moclo-kits/a.json': YTK_RAW,
      '/project/.forge/moclo-kits/b.json': YTK_RAW,
    });
    const catalog = await loadMocloSchemaCatalog('/project', fs);
    expect(catalog.issues).toHaveLength(2);
    expect(catalog.definitions.some((kit) => kit.id === 'ytk')).toBe(false);
  });

  it('creates a custom kit with only a schema and refreshes the owning project after persistence', async () => {
    const fs = fileSystem({});
    const listener = vi.fn();
    const unsubscribe = subscribeMocloSchemaCatalog(listener);
    try {
      const schema = mocloAssemblySchemaOptions(parseMocloKitDefinition(CIDAR_RAW))[0].schema;
      const input = {
        projectRoot: '/project',
        kitId: 'my-kit',
        kitName: 'My kit',
        expectedKitRevision: 0,
        templateId: 'my-unit',
        name: 'My unit',
        description: 'A custom layout.',
        schema,
        topology: 'circular' as const,
      };
      await saveMocloSchema(input, fs);
      expect(listener).toHaveBeenCalledWith('/project');
      const kit = parseMocloKitDefinition(fs.files.get('/project/.forge/moclo-kits/my-kit.json')!);
      expect(kit.members).toEqual([]);
      expect(kit.recipes).toEqual([]);
      expect(kit.assemblySchemas![0].slots).toEqual(schema.slots);
      expect(fs.writeWorkspaceTextFileAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'create', workspaceRoot: '/project' })
      );
    } finally {
      unsubscribe();
    }
  });

  it('rejects invalid overhangs and changed previews before the native write', async () => {
    const fs = fileSystem({});
    const schema = structuredClone(
      mocloAssemblySchemaOptions(parseMocloKitDefinition(CIDAR_RAW))[0].schema
    );
    const input = {
      projectRoot: '/project',
      kitId: 'my-kit',
      kitName: 'My kit',
      expectedKitRevision: 0,
      templateId: 'my-unit',
      name: 'My unit',
      description: 'A custom layout.',
      schema,
      topology: 'circular' as const,
    };
    await expect(
      saveMocloSchema(input, fs, () => {
        throw new Error('Preview changed');
      })
    ).rejects.toThrow('Preview changed');
    schema.slots[0].outgoingOverhang = 'AAA';
    await expect(saveMocloSchema(input, fs)).rejects.toThrow(/invalid|length/i);
    expect(fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });
});
