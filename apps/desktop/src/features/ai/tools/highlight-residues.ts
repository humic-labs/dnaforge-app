import { resultTool, toolSuccess, toolFailure } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';

import { useStructure3dStore } from '../../page/public/embeds/structure3d/store';
import {
  AGENT_HIGHLIGHT_GROUP_ID_PREFIX,
  type ChainSelection,
  type HighlightGroup,
} from '../../page/public/embeds/structure3d/types';

const regionSchema = z
  .object({
    start: z.number().int().min(1),
    end: z.number().int().min(1),
  })
  .strict()
  .refine((region) => region.end >= region.start, {
    message: 'end must be greater than or equal to start',
    path: ['end'],
  });

const chainSelectionSchema = z
  .object({
    chain: z.string().min(1).max(100),
    compId: z.string().min(1).max(20).optional(),
    baseChain: z.string().min(1).max(100).optional(),
    labelAsymId: z.string().min(1).max(100).optional(),
    authAsymId: z.string().min(1).max(100).optional(),
    entityId: z.string().min(1).max(100).optional(),
    operator: z.string().min(1).max(100).optional(),
    regions: z.array(regionSchema).min(1).max(100),
  })
  .strict();

export const highlightResiduesSchema = z
  .object({
    structureViewId: z.string().min(1).max(500).optional(),
    bindingId: z.string().min(1).max(500).optional(),
    structureRef: z.string().min(1).max(500).optional(),
    chain: z.string().min(1).max(100).optional(),
    compId: z.string().min(1).max(20).optional(),
    regions: z.array(regionSchema).min(1).max(100).optional(),
    selections: z.array(chainSelectionSchema).min(1).max(50).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a six-digit hex value')
      .optional(),
    label: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const targetCount = [input.structureViewId, input.bindingId, input.structureRef].filter(
      Boolean
    ).length;
    if (targetCount > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide at most one of structureViewId, bindingId, or legacy structureRef.',
      });
    }
    const hasSingleShape =
      input.chain !== undefined || input.compId !== undefined || input.regions !== undefined;
    const hasMultiShape = input.selections !== undefined;
    if (hasSingleShape && hasMultiShape) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide chain + regions OR selections, not both.',
      });
      return;
    }
    if (!hasSingleShape && !hasMultiShape) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide chain + regions or a selections array.',
      });
      return;
    }
    if (hasSingleShape && (!input.chain || !input.regions)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'chain and regions must be provided together.',
      });
    }
  });

type HighlightResiduesInput = z.infer<typeof highlightResiduesSchema>;

function inputStructureRef(input: HighlightResiduesInput): string | undefined {
  return input.structureViewId ?? input.bindingId ?? input.structureRef;
}

function structureStateTarget(input: HighlightResiduesInput): Record<string, string> {
  if (input.structureViewId) return { structureViewId: input.structureViewId };
  if (input.bindingId) return { bindingId: input.bindingId };
  if (input.structureRef) return { viewerId: input.structureRef };
  return {};
}

type RuntimeRange = { start: number; end: number };
type RuntimeChain = {
  chainId: string;
  baseChain?: string | null;
  labelAsymId?: string | null;
  authAsymId?: string | null;
  entityId?: string | null;
  operator?: string | null;
  residueRanges: RuntimeRange[];
};
type RuntimeLigand = {
  name: string;
  chainId: string;
  position: number;
  baseChain?: string | null;
  labelAsymId?: string | null;
  authAsymId?: string | null;
  entityId?: string | null;
  operator?: string | null;
};
type RuntimeStructure = {
  registrationId?: string;
  structureId: string;
  structureViewId?: string;
  bindingId?: string | null;
  viewerId: string;
  viewerStatus: string;
  chains: RuntimeChain[];
  ligands: RuntimeLigand[];
};

export interface HighlightResiduesDependencies {
  getStructureState: (args: unknown) => Promise<unknown>;
}

const defaultDependencies: HighlightResiduesDependencies = {
  getStructureState: async (args) =>
    (await import('../../agent-bridge/public/structure-tools')).handleMolGetState(args),
};

function normalizedSelections(
  input: HighlightResiduesInput
): z.infer<typeof chainSelectionSchema>[] {
  if (input.selections) return input.selections;
  return [
    {
      chain: input.chain!,
      ...(input.compId ? { compId: input.compId } : {}),
      regions: input.regions!,
    },
  ];
}

function runtimeStructures(value: unknown): RuntimeStructure[] {
  if (!value || typeof value !== 'object') return [];
  const structures = (value as { structures?: unknown }).structures;
  if (!Array.isArray(structures)) return [];
  return structures
    .filter(
      (item): item is RuntimeStructure =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as RuntimeStructure).structureId === 'string' &&
        typeof (item as RuntimeStructure).viewerId === 'string' &&
        Array.isArray((item as RuntimeStructure).chains)
    )
    .map((item) => ({
      ...item,
      ligands: Array.isArray(item.ligands) ? item.ligands : [],
    }));
}

function regionIsPresent(region: RuntimeRange, available: readonly RuntimeRange[]): boolean {
  return available.some(
    (candidate) => candidate.start <= region.start && candidate.end >= region.end
  );
}

function matchingChain(
  selection: z.infer<typeof chainSelectionSchema>,
  chains: readonly RuntimeChain[]
): RuntimeChain | undefined {
  return chains.find(
    (chain) =>
      chain.chainId === selection.chain &&
      (!selection.baseChain || chain.baseChain === selection.baseChain) &&
      (!selection.labelAsymId || chain.labelAsymId === selection.labelAsymId) &&
      (!selection.authAsymId || chain.authAsymId === selection.authAsymId) &&
      (!selection.entityId || chain.entityId === selection.entityId) &&
      (!selection.operator || chain.operator === selection.operator)
  );
}

function matchingLigands(
  selection: z.infer<typeof chainSelectionSchema>,
  ligands: readonly RuntimeLigand[]
): RuntimeLigand[] {
  return ligands.filter(
    (ligand) =>
      ligand.name === selection.compId &&
      ligand.chainId === selection.chain &&
      (!selection.baseChain || ligand.baseChain === selection.baseChain) &&
      (!selection.labelAsymId || ligand.labelAsymId === selection.labelAsymId) &&
      (!selection.authAsymId || ligand.authAsymId === selection.authAsymId) &&
      (!selection.entityId || ligand.entityId === selection.entityId) &&
      (!selection.operator || ligand.operator === selection.operator)
  );
}

function highlightFailure<T extends { code: string; retriable: boolean; reason: string }>(data: T) {
  return {
    ...toolFailure({
      code: data.code,
      error: `Residue highlighting failed: ${data.reason}.`,
      retriable: data.retriable,
      stateChanged: false,
      partialEffects: [],
    }),
    ...data,
  };
}

function noStructure(structureRef: string | undefined) {
  return highlightFailure({
    highlighted: false as const,
    code: 'NO_STRUCTURE' as const,
    reason: 'no-structure' as const,
    retriable: true,
    ...(structureRef ? { structureRef } : {}),
  });
}

   
                                                                             
                                                                             
                                                                     
   
export function createHighlightResiduesTool(
  dependencies: HighlightResiduesDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Highlight exact auth_seq_id residue ranges in the live 3D structure viewer. ' +
      'Use only for an explicit show/locate/highlight request. Supports disjoint and multi-chain ' +
      'selections and returns explicit no-structure/not-ready/stale-selection failures.',
    inputSchema: highlightResiduesSchema,
    execute: async (input: HighlightResiduesInput) => {
      const requestedStructureRef = inputStructureRef(input);
      let snapshot: unknown;
      try {
        snapshot = await dependencies.getStructureState({
          ...structureStateTarget(input),
          detail: 'full',
        });
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code: unknown }).code)
            : '';
        if (code === 'VIEWER_NOT_FOUND') return noStructure(requestedStructureRef);
        return highlightFailure({
          highlighted: false as const,
          code: 'STRUCTURE_NOT_READY' as const,
          reason: 'structure-not-ready' as const,
          retriable: true,
        });
      }

      const allStructures = runtimeStructures(snapshot);
      const candidates = requestedStructureRef
        ? allStructures.filter(
            (structure) =>
              structure.registrationId === requestedStructureRef ||
              structure.structureId === requestedStructureRef ||
              structure.structureViewId === requestedStructureRef ||
              structure.bindingId === requestedStructureRef ||
              structure.viewerId === requestedStructureRef
          )
        : allStructures;
      if (candidates.length === 0) return noStructure(requestedStructureRef);
      if (candidates.length > 1) {
        return highlightFailure({
          highlighted: false as const,
          code: 'AMBIGUOUS_STRUCTURE' as const,
          reason: 'ambiguous-structure' as const,
          retriable: false,
          candidates: candidates.map(({ structureId, structureViewId, bindingId, viewerId }) => ({
            structureId,
            structureViewId,
            bindingId,
            viewerId,
          })),
        });
      }

      const structure = candidates[0];
      if (
        structure.viewerStatus !== 'active' ||
        (structure.chains.length === 0 && structure.ligands.length === 0)
      ) {
        return highlightFailure({
          highlighted: false as const,
          code: 'STRUCTURE_NOT_READY' as const,
          reason: 'structure-not-ready' as const,
          retriable: true,
          structureRef: requestedStructureRef ?? structure.structureId,
        });
      }

      const selections = normalizedSelections(input);
      const staleSelections = selections.flatMap((selection) => {
        if (selection.compId) {
          const available = matchingLigands(selection, structure.ligands).map((ligand) => ({
            start: ligand.position,
            end: ligand.position,
          }));
          const missing = selection.regions.filter((region) => !regionIsPresent(region, available));
          return missing.length > 0
            ? [{ chain: selection.chain, compId: selection.compId, regions: missing }]
            : [];
        }
        const chain = matchingChain(selection, structure.chains);
        if (!chain) return [{ chain: selection.chain, regions: selection.regions }];
        const missing = selection.regions.filter(
          (region) => !regionIsPresent(region, chain.residueRanges)
        );
        return missing.length > 0 ? [{ chain: selection.chain, regions: missing }] : [];
      });
      if (staleSelections.length > 0) {
        return highlightFailure({
          highlighted: false as const,
          code: 'STALE_SELECTION' as const,
          reason: 'stale-selection' as const,
          retriable: false,
          structureRef: requestedStructureRef ?? structure.structureId,
          staleSelections,
        });
      }

      const store = useStructure3dStore.getState();
      const registrationId =
        structure.registrationId ?? structure.structureViewId ?? structure.structureId;
      const entry = store.expandedStructures[registrationId];
      if (!entry) return noStructure(requestedStructureRef ?? structure.structureId);
      const groupSelections: ChainSelection[] = selections.map((selection) => ({
        chain: selection.chain,
        ...(selection.compId ? { compId: selection.compId } : {}),
        ...(selection.baseChain ? { baseChain: selection.baseChain } : {}),
        ...(selection.labelAsymId ? { labelAsymId: selection.labelAsymId } : {}),
        ...(selection.authAsymId ? { authAsymId: selection.authAsymId } : {}),
        ...(selection.entityId ? { entityId: selection.entityId } : {}),
        ...(selection.operator ? { operator: selection.operator } : {}),
        ranges: selection.regions.map((region) => [region.start, region.end]),
      }));
      const group: HighlightGroup = {
        id: `${AGENT_HIGHLIGHT_GROUP_ID_PREFIX}${
          structure.bindingId ?? structure.structureViewId ?? registrationId
        }`,
        label: input.label ?? 'Agent highlight',
        color: input.color ?? '#ff6699',
        visible: true,
        selections: groupSelections,
      };
      const existing = (entry.data.highlightGroups ?? []).filter(
        (candidate) => !candidate.id.startsWith(AGENT_HIGHLIGHT_GROUP_ID_PREFIX)
      );
      try {
        store.updateStructureData(registrationId, {
          ...entry.data,
          highlightGroups: [...existing, group],
        });
      } catch (error) {
        return toolFailure({
          code: 'HIGHLIGHT_UPDATE_FAILED',
          error: error instanceof Error ? error.message : String(error),
          retriable: false,
          stateChanged: 'unknown',
          partialEffects: [],
        });
      }

      const residueCount = selections.reduce(
        (count, selection) =>
          count +
          selection.regions.reduce(
            (subtotal, region) => subtotal + region.end - region.start + 1,
            0
          ),
        0
      );
      return toolSuccess({
        highlighted: true as const,
        structureRef: requestedStructureRef ?? structure.structureId,
        structureId: structure.structureId,
        structureViewId: structure.structureViewId ?? null,
        bindingId: structure.bindingId ?? null,
        viewerId: structure.viewerId,
        residueCount,
        selections,
      });
    },
  });
}
