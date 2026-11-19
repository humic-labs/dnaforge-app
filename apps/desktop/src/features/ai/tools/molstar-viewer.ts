import { resultTool } from '../../agent-bridge/public/tool-result';
import type * as StructureOperations from '../../agent-bridge/public/structure-tools';
import { z } from 'zod';

import {
  molGetStateSchema,
  molListStructuresSchema,
  molSelectionSchema,
  molSetColorSchema,
  molSetRepresentationSchema,
  molSetSideChainsSchema,
} from '../../agent-bridge/public/structure-tools/contracts';

export {
  molGetStateSchema,
  molListStructuresSchema,
  molSelectionSchema,
  molSetColorSchema,
  molSetRepresentationSchema,
  molSetSideChainsSchema,
};

export interface MolstarViewerToolDependencies {
  listStructures: (input: unknown) => ReturnType<typeof StructureOperations.handleMolListStructures>;
  getState: (input: unknown) => ReturnType<typeof StructureOperations.handleMolGetState>;
  selectResidues: (
    input: unknown
  ) => ReturnType<typeof StructureOperations.handleMolSelectResidues>;
  setRepresentation: (
    input: unknown
  ) => ReturnType<typeof StructureOperations.handleMolSetRepresentation>;
  setColor: (input: unknown) => ReturnType<typeof StructureOperations.handleMolSetColor>;
  setSideChains: (input: unknown) => ReturnType<typeof StructureOperations.handleMolSetSideChains>;
  focus: (input: unknown) => ReturnType<typeof StructureOperations.handleMolFocus>;
}

const defaultDependencies: MolstarViewerToolDependencies = {
  listStructures: async (input) =>
    (await import('../../agent-bridge/public/structure-tools')).handleMolListStructures(input),
  getState: async (input) =>
    (await import('../../agent-bridge/public/structure-tools')).handleMolGetState(input),
  selectResidues: async (input) =>
    (await import('../../agent-bridge/public/structure-tools')).handleMolSelectResidues(input),
  setRepresentation: async (input) =>
    (await import('../../agent-bridge/public/structure-tools')).handleMolSetRepresentation(input),
  setColor: async (input) =>
    (await import('../../agent-bridge/public/structure-tools')).handleMolSetColor(input),
  setSideChains: async (input) =>
    (await import('../../agent-bridge/public/structure-tools')).handleMolSetSideChains(input),
  focus: async (input) =>
    (await import('../../agent-bridge/public/structure-tools')).handleMolFocus(input),
};

export function createMolListStructuresTool(
  dependencies: MolstarViewerToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'List open structure views with their exact IDs, readiness and chain counts. Use detail:"full" for the complete inventory or mol_get_state with chainPage for exact chains in one view.',
    inputSchema: molListStructuresSchema,
    execute: async (input) => dependencies.listStructures(input),
  });
}

export function createMolGetStateTool(
  dependencies: MolstarViewerToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Read live structure status, camera, representation and inventory counts. Use chainPage:{offset,limit} on one exact view for chain identities, connectionQuery for connection evidence, or detail:"full" for native appearance, selected residues and the complete inventory. Prefer structureViewId or bindingId returned by mol_list_structures; legacy viewerId must resolve uniquely.',
    inputSchema: molGetStateSchema,
    execute: async (input: z.infer<typeof molGetStateSchema>) => dependencies.getState(input),
  });
}

export function createMolSelectResiduesTool(
  dependencies: MolstarViewerToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Select residues in one logical Mol* view/binding with a bounded PyMOL-style selection expression. Prefer structureViewId or bindingId; legacy viewerId must resolve uniquely. This changes viewer selection; call only when the user explicitly asks to select residues.',
    inputSchema: molSelectionSchema,
    execute: async (input: z.infer<typeof molSelectionSchema>) =>
      dependencies.selectResidues(input),
  });
}

export function createMolSetRepresentationTool(
  dependencies: MolstarViewerToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Set one logical Mol* view/binding to a supported DNAForge representation recipe. Prefer structureViewId or bindingId; legacy viewerId must resolve uniquely. This changes the visible scene; call only when the user asks for a representation change.',
    inputSchema: molSetRepresentationSchema,
    execute: async (input: z.infer<typeof molSetRepresentationSchema>) =>
      dependencies.setRepresentation(input),
  });
}

export function createMolSetColorTool(
  dependencies: MolstarViewerToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Set the color mode of one logical Mol* view/binding. Prefer structureViewId or bindingId; legacy viewerId must resolve uniquely. This changes the visible scene; call only when the user asks for a color change or a color-encoded analysis view.',
    inputSchema: molSetColorSchema,
    execute: async (input: z.infer<typeof molSetColorSchema>) => dependencies.setColor(input),
  });
}

export function createMolSetSideChainsTool(
  dependencies: MolstarViewerToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Show or hide side-chain sticks for visible backbones or the active selection in one logical Mol* view/binding. Prefer structureViewId or bindingId; legacy viewerId must resolve uniquely. Call only when the user asks to change side-chain visibility.',
    inputSchema: molSetSideChainsSchema,
    execute: async (input: z.infer<typeof molSetSideChainsSchema>) =>
      dependencies.setSideChains(input),
  });
}

export function createMolFocusTool(
  dependencies: MolstarViewerToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Focus one logical Mol* view/binding on residues matched by a bounded PyMOL-style selection expression. Prefer structureViewId or bindingId; legacy viewerId must resolve uniquely. This moves the camera only when nearly all matched atoms belong to visible representations; FOCUS_SELECTION_NOT_RENDERED means you must add missing components with mol_apply_scene first. Call only when the user asks to focus, zoom, locate, or show that target.',
    inputSchema: molSelectionSchema,
    execute: async (input: z.infer<typeof molSelectionSchema>) => dependencies.focus(input),
  });
}
