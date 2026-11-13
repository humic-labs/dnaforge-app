import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findMocloKitStage,
  loadMocloKitDefinitionInventory,
  loadMocloKitDefinitions,
  parseMocloKitDefinition,
  resolveMocloKitMembership,
  schemaForMocloStage,
  mocloAssemblySchemaOptions,
  MOCLO_KIT_FORMAT_VERSION,
} from './moclo-kit-definition';
import {
  cidarMocloRedFluorescentTu,
  CIDAR_MOCLO_RED_TU_DESIGN_ID,
} from '../../test/scenarios/assembly-real-pipeline';

const YTK_DEFINITION_PATH = resolve(
  __dirname,
  '../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/ytk.json'
);
const CIDAR_DEFINITION_PATH = resolve(
  __dirname,
  '../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/cidar.json'
);
const SAMPLE_WORKSPACE_PATH = resolve(
  __dirname,
  '../../../resources/sample-workspaces/standard-samples/workspace'
);

function sequencePackageIds(directory: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    const metadataPath = join(path, '.forge', 'plasmid.json');
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { id?: string };
      if (typeof metadata.id === 'string' && metadata.id) {
        found.set(metadata.id, [...(found.get(metadata.id) ?? []), path]);
      }
    } catch {
      for (const [id, paths] of sequencePackageIds(path)) {
        found.set(id, [...(found.get(id) ?? []), ...paths]);
      }
    }
  }
  return found;
}

function ytkDefinition() {
  return parseMocloKitDefinition(readFileSync(YTK_DEFINITION_PATH, 'utf8'), YTK_DEFINITION_PATH);
}

function cidarDefinition() {
  return parseMocloKitDefinition(
    readFileSync(CIDAR_DEFINITION_PATH, 'utf8'),
    CIDAR_DEFINITION_PATH
  );
}

describe('MoClo kit definition contract', () => {
  it('offers CIDAR independently of recipes and matches every real digest junction', () => {
    const options = mocloAssemblySchemaOptions(cidarDefinition());
    expect(options).toHaveLength(1);
    const design = cidarMocloRedFluorescentTu().designs!.designs[CIDAR_MOCLO_RED_TU_DESIGN_ID];
    expect(options[0].schema.slots.map((slot) => slot.outgoingOverhang)).toEqual(
      design.goldenGateJunctions!.map((junction) => junction.overhang)
    );
    expect(options[0].schema.origin).toMatchObject({ kitId: 'moclo-cidar' });
  });
  it('keeps valid kits in the inventory but makes strict consumers reject partial definitions', async () => {
    const valid = readFileSync(YTK_DEFINITION_PATH, 'utf8');
    const fs = {
      exists: async () => true,
      readDir: async () => [
        { name: 'broken.json', isDirectory: false, isFile: true },
        { name: 'ytk.json', isDirectory: false, isFile: true },
      ],
      readTextFile: async (path: string) => (path.endsWith('/ytk.json') ? valid : '{broken'),
    };

    await expect(loadMocloKitDefinitionInventory('/project', fs)).resolves.toEqual({
      definitions: [expect.objectContaining({ id: 'ytk' })],
      issues: [expect.objectContaining({ source: expect.stringContaining('broken.json') })],
    });
    await expect(loadMocloKitDefinitions('/project', fs)).rejects.toThrow(/not valid JSON/i);
  });

  it('rejects every duplicate kit identity instead of selecting one by filename order', async () => {
    const valid = readFileSync(YTK_DEFINITION_PATH, 'utf8');
    const fs = {
      exists: async () => true,
      readDir: async () => [
        { name: 'a.json', isDirectory: false, isFile: true },
        { name: 'b.json', isDirectory: false, isFile: true },
      ],
      readTextFile: async () => valid,
    };

    await expect(loadMocloKitDefinitions('/project', fs)).rejects.toThrow(/duplicate kit id/i);
  });

  it('loads CIDAR as a 91-member kit without inventing part types or recipes', () => {
    const definition = cidarDefinition();

    expect(definition).toMatchObject({
      id: 'moclo-cidar',
      name: 'CIDAR MoClo',
      partTypes: [],
      recipes: [],
    });
    expect(definition.members).toHaveLength(91);
    expect(new Set(definition.members.map((member) => member.sequencePackageId)).size).toBe(91);
    expect(
      resolveMocloKitMembership([definition], {
        packageId: 'sample-7981ffa1',
      })
    ).toMatchObject({
      kit: { id: 'moclo-cidar', name: 'CIDAR MoClo' },
      member: { name: 'B0034m_BC' },
      partType: null,
      roleEvidence: [],
    });
  });

  it('loads the real 96-member YTK corpus and its ordered three-stage recipe', () => {
    const definition = ytkDefinition();

    expect(definition.id).toBe('ytk');
    expect(definition.members).toHaveLength(96);
    expect(new Set(definition.members.map((member) => member.sequencePackageId)).size).toBe(96);
    expect(definition.recipes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ytk-multigene-device',
          stages: [
            expect.objectContaining({ id: 'cassette-vector', enzyme: 'BsaI' }),
            expect.objectContaining({ id: 'expression-cassette', enzyme: 'BsaI' }),
            expect.objectContaining({ id: 'multigene-device', enzyme: 'BsmBI' }),
          ],
        }),
      ])
    );
  });

  it('binds every declared kit member to exactly one shipped sequence package', () => {
    const packages = sequencePackageIds(join(SAMPLE_WORKSPACE_PATH, 'sequences'));
    const invalid = [cidarDefinition(), ytkDefinition()].flatMap((definition) =>
      definition.members.flatMap((member) => {
        const paths = packages.get(member.sequencePackageId) ?? [];
        return paths.length === 1
          ? []
          : [
              `${definition.id}:${member.id} -> ${member.sequencePackageId} (${paths.length} matches)`,
            ];
      })
    );

    expect(invalid).toEqual([]);
  });

  it('projects one stage into the same Golden Gate schema used by the assembly UI and agent tools', () => {
    const definition = ytkDefinition();
    const stage = findMocloKitStage(definition, 'ytk-multigene-device', 'cassette-vector');

    expect(schemaForMocloStage(definition, stage)).toMatchObject({
      id: 'ytk:ytk-multigene-device:cassette-vector',
      name: 'Cassette vector',
      revision: 1,
      origin: {
        type: 'kit',
        kitId: 'ytk',
        kitName: 'Yeast Toolkit (YTK)',
        schemaId: 'ytk-multigene-device:cassette-vector',
      },
      enzyme: 'BsaI',
      slots: [
        expect.objectContaining({ id: 'type-1', outgoingOverhang: 'AACG' }),
        expect.objectContaining({ id: 'type-234r', outgoingOverhang: 'GCTG' }),
        expect.objectContaining({ id: 'type-5', outgoingOverhang: 'TACA' }),
        expect.objectContaining({ id: 'type-6', outgoingOverhang: 'GAGT' }),
        expect.objectContaining({ id: 'type-7', outgoingOverhang: 'CCGA' }),
        expect.objectContaining({ id: 'type-8a', outgoingOverhang: 'CAAT' }),
        expect.objectContaining({ id: 'type-8b', outgoingOverhang: 'CCCT' }),
      ],
    });
  });

  it('resolves kit membership only by stable managed-package identity', () => {
    const definition = ytkDefinition();
    const member = definition.members.find((candidate) => candidate.name === 'pYTK009');
    expect(member).toBeDefined();

    expect(
      resolveMocloKitMembership([definition], {
        packageId: member?.sequencePackageId ?? '',
      })
    ).toMatchObject({
      kit: { id: 'ytk', name: 'Yeast Toolkit (YTK)' },
      member: { name: 'pYTK009', partTypeId: 'ytk:2' },
    });
  });

  it('allows membership-only kits without inventing a biological part type or recipe', () => {
    const definition = parseMocloKitDefinition(
      JSON.stringify({
        schema: 'dnaforge.moclo-kit',
        formatVersion: 2,
        id: 'membership-only',
        name: 'Membership-only kit',
        revision: 1,
        description: 'A repository set with no declared ontology or assembly workflow.',
        citations: [],
        partTypes: [],
        members: [
          {
            id: 'member-1',
            name: 'Member 1',
            sequencePackageId: 'sequence-package-1',
          },
        ],
        recipes: [],
      })
    );

    expect(definition.members[0]?.partTypeId).toBeUndefined();
    expect(
      resolveMocloKitMembership([definition], {
        packageId: 'sequence-package-1',
      })
    ).toMatchObject({
      kit: { id: 'membership-only', name: 'Membership-only kit' },
      partType: null,
      roleEvidence: [],
    });
  });

  it('rejects raw sequence paths and legacy catalog identities in a current manifest', () => {
    const definition = ytkDefinition();
    const member = definition.members[0];
    expect(member).toBeDefined();

    expect(() =>
      parseMocloKitDefinition(
        JSON.stringify({
          ...definition,
          members: [
            {
              ...member,
              sequencePackageId: 'sequences/pYTK001/pYTK001.gb',
            },
          ],
        }),
        'path-shaped.json'
      )
    ).toThrow(/stable package ID, never a path/i);

    expect(() =>
      parseMocloKitDefinition(
        JSON.stringify({
          ...definition,
          members: [
            {
              id: member?.id,
              name: member?.name,
              sequenceEntityId: member?.sequencePackageId,
              workspacePath: 'sequences/pYTK001/pYTK001.gb',
            },
          ],
        }),
        'legacy.json'
      )
    ).toThrow(/managed sequence package.*never.*project path/i);
  });

  it('fails closed on unknown format versions and dangling stage-output references', () => {
    const definition = ytkDefinition();
    expect(() =>
      parseMocloKitDefinition(
        JSON.stringify({ ...definition, formatVersion: MOCLO_KIT_FORMAT_VERSION + 1 }),
        'future.json'
      )
    ).toThrow(/unsupported.*format version/i);

    const broken = structuredClone(definition);
    broken.recipes[0].stages[2].slots[0].input = {
      kind: 'stage-output',
      stageId: 'missing-stage',
    };
    expect(() => parseMocloKitDefinition(JSON.stringify(broken), 'broken.json')).toThrow(
      /missing-stage/
    );
  });
});
