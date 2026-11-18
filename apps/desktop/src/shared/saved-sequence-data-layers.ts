import { z } from 'zod';
import {
  sequenceDataLayerIdSchema,
  sequenceDataLayerPresentationSchema,
  type PublishedSequenceDataLayer,
  type SequenceDataLayerViewSelection,
} from './sequence-data-layer';

export const savedSequenceDataLayersSchema = z
  .object({
    project: z.string().min(1).max(4096),
    targetDocumentId: z.string().min(1).max(512),
    selectedLayerId: sequenceDataLayerIdSchema.nullable(),
    visibleLayerIds: z.array(sequenceDataLayerIdSchema).max(64),
    layers: z
      .array(
        z
          .object({
            id: sequenceDataLayerIdSchema,
            revision: z.string().regex(/^[a-f0-9]{64}$/u),
            presentation: sequenceDataLayerPresentationSchema,
          })
          .strict()
      )
      .max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set(value.layers.map((layer) => layer.id));
    if (
      ids.size !== value.layers.length ||
      new Set(value.visibleLayerIds).size !== value.visibleLayerIds.length ||
      value.visibleLayerIds.some((id) => !ids.has(id)) ||
      (value.selectedLayerId !== null && !ids.has(value.selectedLayerId))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Saved layer selections need unique retained source versions.',
      });
  });

export type SavedSequenceDataLayers = z.infer<typeof savedSequenceDataLayersSchema>;

export function sequenceDataLayerSelectionFromSaved(
  saved?: SavedSequenceDataLayers
): SequenceDataLayerViewSelection | undefined {
  return saved
    ? {
        project: saved.project,
        layerId: saved.selectedLayerId,
        visibleLayerIds: saved.visibleLayerIds,
        presentationByLayerId: Object.fromEntries(
          saved.layers.map((layer) => [layer.id, layer.presentation])
        ),
      }
    : undefined;
}

export function captureSavedSequenceDataLayers(
  targetDocumentId: string,
  selection: SequenceDataLayerViewSelection | undefined,
  loadedLayers: readonly PublishedSequenceDataLayer[] | null,
  pinnedRevisions?: Readonly<Record<string, string>>
): SavedSequenceDataLayers | undefined {
  if (!selection) return undefined;
  if (!loadedLayers) throw new Error('The data layer sources are still opening.');
  const visibleLayerIds =
    selection.visibleLayerIds ?? (selection.layerId ? [selection.layerId] : []);
  const ids = [
    ...new Set([
      ...visibleLayerIds,
      ...(selection.layerId ? [selection.layerId] : []),
      ...Object.keys(selection.presentationByLayerId ?? {}),
    ]),
  ];
  return savedSequenceDataLayersSchema.parse({
    project: selection.project,
    targetDocumentId,
    selectedLayerId: selection.layerId,
    visibleLayerIds,
    layers: ids.map((id) => {
      const source = loadedLayers.find((layer) => layer.document.id === id);
      if (!source || source.document.target.documentId !== targetDocumentId)
        throw new Error('A selected data layer source is unavailable.');
      if (pinnedRevisions?.[id] && pinnedRevisions[id] !== source.revision)
        throw new Error('The saved data layer source revision has changed.');
      return {
        id,
        revision: source.revision,
        presentation: selection.presentationByLayerId?.[id] ?? source.document.presentation,
      };
    }),
  });
}
