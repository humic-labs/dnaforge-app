import { defineAction, createActionError } from '../define-action-stub/define-action.ts';
import type { ActionHandle } from '../define-action-stub/types.ts';
import type { EntityKind, EntityRef } from '../descriptor/common.ts';

interface SequenceRenameInput {
  sequenceId: string;
  newName: string;
}

export const sequenceRenameAction: ActionHandle<
  SequenceRenameInput,
  { sequenceId: string; name: string; revision: number }
> = defineAction<SequenceRenameInput, { sequenceId: string; name: string; revision: number }>({
  name: 'sequence.rename',
  runtime: 'renderer',
  effects: ['mutating'],
  actionClass: 'modify',
  parseInput: (raw) => {
    if (
      raw == null ||
      typeof raw !== 'object' ||
      typeof (raw as { sequenceId?: unknown }).sequenceId !== 'string' ||
      typeof (raw as { newName?: unknown }).newName !== 'string'
    ) {
      throw createActionError(
        'BAD_INPUT',
        'sequence.rename requires { sequenceId: string, newName: string }.'
      );
    }
    const { sequenceId, newName } = raw as SequenceRenameInput;
    if (newName.length === 0) {
      throw createActionError('BAD_INPUT', 'newName must be non-empty.');
    }
    return { sequenceId, newName };
  },
  reads: (input) => [sequenceEntity(input.sequenceId)],
  writes: (input) => [sequenceEntity(input.sequenceId)],
  handler: (input, ctx) => {
    const ref = sequenceEntity(input.sequenceId);
    const current = (ctx.store.snapshot(ref) as { name?: string } | undefined) ?? {};
    const next = { ...current, name: input.newName };
    const revision = ctx.store.writeSnapshot(ref, next);
    return { sequenceId: input.sequenceId, name: input.newName, revision };
  },
});

interface DesignRenameInput {
  designId: string;
  newName: string;
}

export const designRenameAction: ActionHandle<
  DesignRenameInput,
  { designId: string; name: string; revision: number }
> = defineAction<DesignRenameInput, { designId: string; name: string; revision: number }>({
  name: 'design.rename',
  runtime: 'renderer',
  effects: ['mutating'],
  actionClass: 'modify',
  parseInput: (raw) => {
    const obj = requireObject(raw, 'design.rename');
    const designId = requireString(obj, 'designId', 'design.rename');
    const newName = requireString(obj, 'newName', 'design.rename');
    if (newName.length === 0) {
      throw createActionError('BAD_INPUT', 'newName must be non-empty.');
    }
    return { designId, newName };
  },
  reads: (input) => [entity('design', input.designId)],
  writes: (input) => [entity('design', input.designId)],
  handler: (input, ctx) => {
    const ref = entity('design', input.designId);
    const current = (ctx.store.snapshot(ref) as { name?: string } | undefined) ?? {};
    const revision = ctx.store.writeSnapshot(ref, { ...current, name: input.newName });
    return { designId: input.designId, name: input.newName, revision };
  },
});

interface PageUpdateTitleInput {
  pageId: string;
  title: string;
}

export const pageUpdateTitleAction: ActionHandle<
  PageUpdateTitleInput,
  { pageId: string; title: string; revision: number }
> = defineAction<PageUpdateTitleInput, { pageId: string; title: string; revision: number }>({
  name: 'page.updateTitle',
  runtime: 'renderer',
  effects: ['mutating'],
  actionClass: 'modify',
  parseInput: (raw) => {
    const obj = requireObject(raw, 'page.updateTitle');
    const pageId = requireString(obj, 'pageId', 'page.updateTitle');
    const title = requireString(obj, 'title', 'page.updateTitle');
    if (title.length === 0) {
      throw createActionError('BAD_INPUT', 'title must be non-empty.');
    }
    return { pageId, title };
  },
  reads: (input) => [entity('page', input.pageId)],
  writes: (input) => [entity('page', input.pageId)],
  handler: (input, ctx) => {
    const ref = entity('page', input.pageId);
    const current = (ctx.store.snapshot(ref) as { title?: string } | undefined) ?? {};
    const revision = ctx.store.writeSnapshot(ref, { ...current, title: input.title });
    return { pageId: input.pageId, title: input.title, revision };
  },
});

interface StructureSetStyleInput {
  structureId: string;
  style: string;
}

export const structureSetStyleAction: ActionHandle<
  StructureSetStyleInput,
  { structureId: string; style: string; revision: number }
> = defineAction<StructureSetStyleInput, { structureId: string; style: string; revision: number }>({
  name: 'structure.setStyle',
  runtime: 'renderer',
  effects: ['mutating', 'ui-bound'],
  actionClass: 'modify',
  parseInput: (raw) => {
    const obj = requireObject(raw, 'structure.setStyle');
    const structureId = requireString(obj, 'structureId', 'structure.setStyle');
    const style = requireString(obj, 'style', 'structure.setStyle');
    if (style.length === 0) {
      throw createActionError('BAD_INPUT', 'style must be non-empty.');
    }
    return { structureId, style };
  },
  reads: (input) => [entity('structure', input.structureId)],
  writes: (input) => [entity('structure', input.structureId)],
  handler: (input, ctx) => {
    const ref = entity('structure', input.structureId);
    const current = (ctx.store.snapshot(ref) as { style?: string } | undefined) ?? {};
    const revision = ctx.store.writeSnapshot(ref, { ...current, style: input.style });
    return { structureId: input.structureId, style: input.style, revision };
  },
});

interface PcrAmplifyInput {
  templateSequenceId: string;
  forwardPrimerId: string;
  reversePrimerId: string;
  productId: string;
}

export const pcrAmplifyAction: ActionHandle<PcrAmplifyInput, { productId: string }> = defineAction<
  PcrAmplifyInput,
  { productId: string }
>({
  name: 'sequence.pcrAmplify',
  runtime: 'sidecar',
  effects: ['mutating'],
  actionClass: 'modify',
  parseInput: (raw) => {
    const obj = (raw ?? {}) as Record<string, unknown>;
    for (const field of ['templateSequenceId', 'forwardPrimerId', 'reversePrimerId', 'productId']) {
      if (typeof obj[field] !== 'string') {
        throw createActionError('BAD_INPUT', `sequence.pcrAmplify requires string field ${field}.`);
      }
    }
    return obj as unknown as PcrAmplifyInput;
  },
  reads: (input) => [
    sequenceEntity(input.templateSequenceId),
    sequenceEntity(input.forwardPrimerId),
    sequenceEntity(input.reversePrimerId),
  ],
  writes: (input) => [sequenceEntity(input.productId)],
  handler: (input, ctx) => {
    const product = sequenceEntity(input.productId);
    ctx.store.writeSnapshot(product, {
      length: 1234,
      template: input.templateSequenceId,
    });
    ctx.provenance.attach({
      derivedEntity: product,
      derivationKind: 'pcr',
      actionName: 'sequence.pcrAmplify',
      attachedAt: 1,
      sources: [
        {
          entity: sequenceEntity(input.templateSequenceId),
          role: 'template',
        },
        {
          entity: sequenceEntity(input.forwardPrimerId),
          role: 'primer',
        },
        {
          entity: sequenceEntity(input.reversePrimerId),
          role: 'primer',
        },
      ],
    });
    return { productId: input.productId };
  },
});

interface SequenceMutateInput {
  parentSequenceId: string;
  variantSequenceId: string;
  mutationLabel: string;
}

export const sequenceMutateAction: ActionHandle<
  SequenceMutateInput,
  { variantSequenceId: string; mutationLabel: string; revision: number }
> = defineAction<
  SequenceMutateInput,
  { variantSequenceId: string; mutationLabel: string; revision: number }
>({
  name: 'sequence.mutate',
  runtime: 'renderer',
  effects: ['mutating'],
  actionClass: 'modify',
  parseInput: (raw) => {
    const obj = requireObject(raw, 'sequence.mutate');
    const parentSequenceId = requireString(obj, 'parentSequenceId', 'sequence.mutate');
    const variantSequenceId = requireString(obj, 'variantSequenceId', 'sequence.mutate');
    const mutationLabel = requireString(obj, 'mutationLabel', 'sequence.mutate');
    if (mutationLabel.length === 0) {
      throw createActionError('BAD_INPUT', 'mutationLabel must be non-empty.');
    }
    return { parentSequenceId, variantSequenceId, mutationLabel };
  },
  reads: (input) => [sequenceEntity(input.parentSequenceId)],
  writes: (input) => [sequenceEntity(input.variantSequenceId)],
  handler: (input, ctx) => {
    const variant = sequenceEntity(input.variantSequenceId);
    const revision = ctx.store.writeSnapshot(variant, {
      parentSequenceId: input.parentSequenceId,
      mutationLabel: input.mutationLabel,
    });
    ctx.provenance.attach({
      derivedEntity: variant,
      derivationKind: 'mutation',
      actionName: 'sequence.mutate',
      attachedAt: 2,
      sources: [
        {
          entity: sequenceEntity(input.parentSequenceId),
          role: 'parent',
        },
      ],
    });
    return {
      variantSequenceId: input.variantSequenceId,
      mutationLabel: input.mutationLabel,
      revision,
    };
  },
});

function requireObject(raw: unknown, actionName: string): Record<string, unknown> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw createActionError('BAD_INPUT', `${actionName} requires an object input.`);
  }
  return raw as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string, actionName: string): string {
  if (typeof obj[field] !== 'string') {
    throw createActionError('BAD_INPUT', `${actionName} requires string field ${field}.`);
  }
  return obj[field];
}

function sequenceEntity(id: string): EntityRef {
  return entity('sequence', id);
}

function entity(kind: EntityKind, id: string): EntityRef {
  return { kind, id };
}
