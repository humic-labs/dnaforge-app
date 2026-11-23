import { z } from 'zod';
import type { PickerResult } from './types';

const entitySchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string(),
  path: z.string().nullable().optional(),
  contentHash: z.string().nullable().optional(),
  objectUuid: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  registryKind: z.string().nullable().optional(),
});

export function entityPickerResult(value: unknown): PickerResult {
  const entity = entitySchema.parse(value);
  return {
    nodeType: 'mention',
    entityType: entity.type,
    entityId: entity.id,
    label: entity.name,
    path: entity.path ?? null,
    contentHash: entity.contentHash ?? null,
    objectUuid: entity.objectUuid ?? null,
    projectId: entity.projectId ?? null,
    registryKind: entity.registryKind ?? null,
  };
}
