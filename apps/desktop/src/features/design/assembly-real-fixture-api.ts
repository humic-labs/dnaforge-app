import {
  findCutSites,
  sortCutSitesByPosition,
  type AnnotatedSequence,
  type RestrictionEnzyme,
} from '@waypoint/sequence-utils';
import enzymeData from '../../../public/data/rebase/merged-enzymes.json';
import type { AssemblyStoreAdapter } from '../assembly/public/dispatcher';
import { createAssemblyDispatcher } from '../assembly/public/dispatcher';
import { assemblyCommands } from '../assembly/public/commands';
import {
  computeVirtualDigest,
  type VirtualDigestFragment,
} from '../assembly-panel/public/hooks/useVirtualDigest';
import { fragmentToRegion } from '../assembly-panel/public/utils/fragmentToRegion';
import { computeDraftAssembly } from './algorithms/draft-assembly';
import type {
  AssemblyMethod,
  DesignRegion,
  DesignSpacer,
  GoldenGateEnzyme,
  SequenceDesign,
} from './types';

export type SequenceFixture = {
  id: string;
  label: string;
  source: string;
  parsed: AnnotatedSequence;
};

const ENZYMES = new Map<string, RestrictionEnzyme>(
  (enzymeData.enzymes as RestrictionEnzyme[]).map((enzyme) => [enzyme.name, enzyme])
);

export function createAssemblyFixtureApi<TFixtures extends Record<string, SequenceFixture>>(
  fixtures: TFixtures
) {
  return {
    fixtures,
    digest: digestFixture,
    draft: computeDraftAssembly,
    design: makeCircularDesign,
    pcrRegion: makePcrRegion,
    pcrRegionAroundFirstSite,
    rdRegion: makeRdRegion,
    goldenGateRdRegion: makeGoldenGateRdRegion,
    realSpacer: makeRealSpacer,
    resectRd: withRdResection,
    regionFromDigestFragment: fragmentToDesignRegion,
    findDigestWithDuplicateOverhangs,
    validate: validateDesign,
  };
}

export function normalizeFixture(fixture: SequenceFixture): SequenceFixture {
  return {
    ...fixture,
    parsed: {
      ...fixture.parsed,
      sequence: fixture.parsed.sequence.toUpperCase(),
      length: fixture.parsed.sequence.length,
    },
  };
}

function makeCircularDesign(
  regions: DesignRegion[],
  options: {
    assemblyMethod: AssemblyMethod;
    spacers?: DesignSpacer[];
    goldenGateEnzyme?: GoldenGateEnzyme;
  }
): SequenceDesign {
  const now = new Date('2026-04-27T00:00:00.000Z');
  return {
    id: `design-${options.assemblyMethod}-circular`,
    name: 'Real fixture assembly matrix',
    topology: 'circular',
    regions: clone(regions),
    spacers: clone(options.spacers ?? []),
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: options.assemblyMethod,
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig:
      options.assemblyMethod === 'goldengate'
        ? { enzyme: options.goldenGateEnzyme ?? 'BsaI' }
        : undefined,
    goldenGateJunctions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makePcrRegion(
  fixture: SequenceFixture,
  id: string,
  start: number,
  length: number
): DesignRegion {
  const sequence = sliceCircular(fixture.parsed.sequence, start, length);
  return {
    id,
    sourceSequenceId: fixture.id,
    sourceSequenceName: fixture.label,
    sourceStart: start,
    sourceEnd: start + length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

function makeRealSpacer(
  fixture: SequenceFixture,
  start: number,
  length: number,
  junctionIndex: number
): DesignSpacer {
  return {
    id: `spacer-${fixture.id}-${start}-${length}`,
    junctionIndex,
    sequence: sliceCircular(fixture.parsed.sequence, start, length),
    name: `${fixture.label} ${start}-${start + length}`,
  };
}

function pcrRegionAroundFirstSite(
  fixture: SequenceFixture,
  enzymeName: GoldenGateEnzyme,
  id: string,
  length: number
): DesignRegion {
  const enzyme = getEnzyme(enzymeName);
  const site = sortCutSitesByPosition(findCutSites(fixture.parsed.sequence, enzyme))[0];
  if (!site) {
    throw new Error(`${fixture.source} has no ${enzymeName} site`);
  }
  const start = Math.max(0, site.recognitionStart - Math.floor(length / 2));
  return makePcrRegion(fixture, id, start, length);
}

function makeRdRegion(
  fixture: SequenceFixture,
  enzymeName: string,
  id: string,
  options: {
    minLength?: number;
    noWrap?: boolean;
    fragmentOrdinal?: number;
  } = {}
): { region: DesignRegion; fragment: VirtualDigestFragment } {
  const digest = digestFixture(fixture, enzymeName);
  const candidates = digest.result.fragments.filter((fragment) => {
    if (options.noWrap && fragment.wrapsOrigin) return false;
    if (options.minLength && fragment.length < options.minLength) return false;
    return true;
  });
  const fragment = candidates[options.fragmentOrdinal ?? 0];
  if (!fragment) {
    throw new Error(`${fixture.source} has no usable ${enzymeName} RD fragment for ${id}`);
  }
  return {
    region: fragmentToDesignRegion(fixture, digest.enzyme, fragment, digest.result.fragments, id),
    fragment,
  };
}

function makeGoldenGateRdRegion(
  fixture: SequenceFixture,
  enzymeName: GoldenGateEnzyme,
  id: string,
  options: {
    ggType?: VirtualDigestFragment['ggType'];
    minLength?: number;
  } = {}
): { region: DesignRegion; fragment: VirtualDigestFragment } {
  const digest = digestFixture(fixture, enzymeName);
  const fragment = digest.result.fragments.find((candidate) => {
    if (options.ggType && candidate.ggType !== options.ggType) return false;
    if (options.minLength && candidate.length < options.minLength) return false;
    return true;
  });
  if (!fragment) {
    throw new Error(`${fixture.source} has no ${enzymeName} ${options.ggType ?? ''} fragment`);
  }
  return {
    region: fragmentToDesignRegion(fixture, digest.enzyme, fragment, digest.result.fragments, id),
    fragment,
  };
}

function digestFixture(fixture: SequenceFixture, enzymeName: string) {
  const enzyme = getEnzyme(enzymeName);
  const result = computeVirtualDigest(
    fixture.parsed.sequence,
    enzyme,
    fixture.parsed.annotations.map((annotation) => ({
      name: annotation.name,
      start: Math.max(0, annotation.start - 1),
      end: annotation.end,
    }))
  );
  if (result.fragments.length < 1) {
    throw new Error(`${fixture.source} has no ${enzymeName} digest fragments`);
  }
  return { fixture, enzyme, result };
}

function fragmentToDesignRegion(
  fixture: SequenceFixture,
  enzyme: RestrictionEnzyme,
  fragment: VirtualDigestFragment,
  allFragments: VirtualDigestFragment[],
  id = `${fixture.id}-${enzyme.name}-fragment-${fragment.index}`
): DesignRegion {
  return {
    id,
    ...fragmentToRegion({
      fragment,
      sourceSequence: fixture.parsed.sequence,
      sourceSequenceId: fixture.id,
      sourceSequenceName: fixture.label,
      overhangLength: allFragments.length > 0 ? fragment.upstream.sequence.length : 0,
      enzymeName: enzyme.name,
      sourceAnnotations: fixture.parsed.annotations.map((annotation) => ({
        name: annotation.name,
        type: annotation.type,
        start: Math.max(0, annotation.start - 1),
        end: annotation.end,
        strand:
          annotation.direction === 1
            ? ('forward' as const)
            : annotation.direction === -1
              ? ('reverse' as const)
              : ('none' as const),
        color: annotation.color,
      })),
      allFragments,
    }),
  };
}

function withRdResection(region: DesignRegion, upstream: number, downstream: number): DesignRegion {
  return {
    ...clone(region),
    rdEnds: {
      upstream: region.rdEnds?.upstream
        ? { ...region.rdEnds.upstream, nebuilderResectionBases: upstream }
        : undefined,
      downstream: region.rdEnds?.downstream
        ? { ...region.rdEnds.downstream, nebuilderResectionBases: downstream }
        : undefined,
    },
  };
}

function findDigestWithDuplicateOverhangs(
  fixtures: SequenceFixture[],
  enzymeName: GoldenGateEnzyme
) {
  for (const fixture of fixtures) {
    const digest = digestFixture(fixture, enzymeName);
    const counts = new Map<string, number>();
    for (const fragment of digest.result.fragments) {
      for (const overhang of [fragment.upstream.sequence, fragment.downstream.sequence]) {
        counts.set(overhang, (counts.get(overhang) ?? 0) + 1);
      }
    }
    if ([...counts.values()].some((count) => count > 2)) {
      return {
        fixture,
        enzyme: digest.enzyme,
        fragments: digest.result.fragments,
      };
    }
  }
  throw new Error(`no real ${enzymeName} digest with duplicate overhangs found`);
}

async function validateDesign(design: SequenceDesign): Promise<{
  result: Awaited<ReturnType<ReturnType<typeof createAssemblyDispatcher>['dispatch']>['result']>;
  design: SequenceDesign;
}> {
  const harness = createDispatcherHarness(design);
  const result = await harness.dispatcher.dispatch(assemblyCommands.validate(design.id)).result;
  return {
    result,
    design: harness.state.designs[design.id],
  };
}

function createDispatcherHarness(design: SequenceDesign): {
  dispatcher: ReturnType<typeof createAssemblyDispatcher>;
  state: { designs: Record<string, SequenceDesign>; pendingDispatchId: string | null };
} {
  const state = {
    designs: { [design.id]: clone(design) },
    pendingDispatchId: null as string | null,
  };
  const adapter: AssemblyStoreAdapter = {
    getDesign: (designId) => state.designs[designId],
    updateDesign: (designId, updater) => {
      state.designs[designId] = updater(state.designs[designId]);
    },
    setPendingDispatchId: (dispatchId) => {
      state.pendingDispatchId = dispatchId;
    },
  };
  return { dispatcher: createAssemblyDispatcher(adapter), state };
}

function getEnzyme(name: string): RestrictionEnzyme {
  const enzyme = ENZYMES.get(name);
  if (!enzyme) {
    throw new Error(`missing enzyme definition for ${name}`);
  }
  return enzyme;
}

function sliceCircular(sequence: string, start: number, length: number): string {
  let result = '';
  for (let offset = 0; offset < length; offset++) {
    result += sequence[(start + offset) % sequence.length];
  }
  return result;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
