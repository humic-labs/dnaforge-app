// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ENTITY_REFERENCE_ROUTES,
  REFERENCE_ENTITY_TYPES,
  UNKNOWN_ENTITY_REFERENCE_ROUTE,
  entityReferenceRoute,
} from './entity-reference-routes';
import { PROJECT_REFERENCE_ENTITY_TYPES } from '../../../db/project-reference-search';

const srcRoot = new URL('../../../', import.meta.url);
const embedDefinitions = readdirSync(new URL('features/page/embeds/', srcRoot), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => `features/page/embeds/${entry.name}/definition.ts`)
  .filter((path) => {
    try {
      readFileSync(new URL(path, srcRoot));
      return true;
    } catch {
      return false;
    }
  });
const OPEN_ENTITY_SENDERS = [
  ...embedDefinitions,
  'features/page/embeds/sequence/Picker.tsx',
  'features/page/editor/components/MentionMenu.tsx',
  'features/page/editor/components/MentionChip.tsx',
  'features/page/editor/native-entity-links.ts',
  'features/page/editor/lib/search.ts',
  'features/scientific-document/ScientificDocumentTab.tsx',
  'features/proteins/components/ProteinSequenceTab.tsx',
];

function senderEntityTypes(): Set<string> {
  const types = new Set<string>();
  for (const path of OPEN_ENTITY_SENDERS) {
    const source = readFileSync(new URL(path, srcRoot), 'utf8');
    for (const match of source.matchAll(/entityType:\s*'([a-z0-9-]+)'/g)) types.add(match[1]);
    for (const match of source.matchAll(/attrs\.entityType\s*:\s*'([a-z0-9-]+)'/g))
      types.add(match[1]);
  }
  return types;
}

describe('entity reference routing table', () => {
  it('has exactly one route for every listed entity type', () => {
    expect(Object.keys(ENTITY_REFERENCE_ROUTES).sort()).toEqual([...REFERENCE_ENTITY_TYPES].sort());
    for (const type of REFERENCE_ENTITY_TYPES) {
      expect(entityReferenceRoute(type), type).toBe(ENTITY_REFERENCE_ROUTES[type]);
    }
  });

  it('routes every entity type that an open-entity sender emits', () => {
    const emitted = senderEntityTypes();
    expect([...emitted]).toEqual(
      expect.arrayContaining([
        'primer',
        'page',
        'sequence',
        'native-catalog',
        'native-catalog-exact',
      ])
    );
    const missing = [...emitted].filter(
      (type) => !(REFERENCE_ENTITY_TYPES as readonly string[]).includes(type)
    );
    expect(missing, 'add a route to ENTITY_REFERENCE_ROUTES for each sender entity type').toEqual(
      []
    );
  });

  it('sends unknown and missing entity types to the unsupported fallback', () => {
    for (const type of [
      'antibody',
      'notebook',
      'structure3d',
      'toString',
      '__proto__',
      '',
      null,
      undefined,
    ]) {
      expect(entityReferenceRoute(type), String(type)).toBe(UNKNOWN_ENTITY_REFERENCE_ROUTE);
    }
    expect(UNKNOWN_ENTITY_REFERENCE_ROUTE).toEqual({
      matchesContentHash: true,
      matchesPath: 'always',
      containedOpen: 'sequence',
      revealsPackageRoot: false,
    });
  });

  it('keeps each entity type on its established path', () => {
    const shape = (type: (typeof REFERENCE_ENTITY_TYPES)[number]) => {
      const route = entityReferenceRoute(type);
      return {
        beforeLocation: Boolean(route.beforeLocation),
        byId: Boolean(route.byId),
        matchesContentHash: route.matchesContentHash,
        matchesPath: route.matchesPath,
        containedOpen: route.containedOpen,
        revealsPackageRoot: route.revealsPackageRoot,
      };
    };
    const located = { matchesContentHash: true, matchesPath: 'always', containedOpen: 'sequence' };
    expect(Object.fromEntries(REFERENCE_ENTITY_TYPES.map((type) => [type, shape(type)]))).toEqual({
      'registry-entity': {
        ...located,
        beforeLocation: true,
        byId: false,
        revealsPackageRoot: false,
      },
      'registry-oligo': {
        ...located,
        beforeLocation: true,
        byId: false,
        revealsPackageRoot: false,
      },
      primer: { ...located, beforeLocation: true, byId: false, revealsPackageRoot: false },
      'native-catalog': {
        ...located,
        beforeLocation: true,
        byId: false,
        revealsPackageRoot: false,
      },
      'native-catalog-exact': {
        ...located,
        beforeLocation: true,
        byId: false,
        revealsPackageRoot: false,
      },
      page: {
        beforeLocation: false,
        byId: true,
        matchesContentHash: false,
        matchesPath: 'reveal-only',
        containedOpen: 'notebook',
        revealsPackageRoot: false,
      },
      registry: { ...located, beforeLocation: true, byId: false, revealsPackageRoot: false },
      sequence: { ...located, beforeLocation: false, byId: true, revealsPackageRoot: true },
      ...Object.fromEntries(
        PROJECT_REFERENCE_ENTITY_TYPES.map((type) => [
          type,
          {
            ...located,
            beforeLocation: false,
            byId: true,
            containedOpen: 'file',
            revealsPackageRoot: false,
          },
        ])
      ),
    });
  });
});
