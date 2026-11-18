import { z } from 'zod';
import {
  protocolCreateSchema,
  protocolStartRunSchema,
  protocolCreationInspectSchema,
  protocolPackageReadSchema,
  protocolPackageListSchema,
  protocolPackageSaveSchema,
  protocolEditDeclarationsSchema,
  protocolRecordRunValuesSchema,
} from './protocol-packages';

export const protocolDocumentAgentRequestSchema = z
  .object({
    operation: z.discriminatedUnion('kind', [
      protocolCreateSchema.extend({ kind: z.literal('create-protocol') }).strict(),
      protocolStartRunSchema.extend({ kind: z.literal('start-run') }).strict(),
      protocolCreationInspectSchema.extend({ kind: z.literal('inspect-creation') }).strict(),
      protocolCreationInspectSchema.extend({ kind: z.literal('recover-creation') }).strict(),
      protocolPackageReadSchema.extend({ kind: z.literal('read-package') }).strict(),
      protocolPackageReadSchema.extend({ kind: z.literal('read-saved-protocol') }).strict(),
      protocolPackageListSchema
        .omit({ kind: true })
        .extend({
          kind: z.literal('list-packages'),
          packageKind: z.enum(['protocol', 'protocol-run']),
        })
        .strict(),
      protocolPackageSaveSchema.extend({ kind: z.literal('save-package') }).strict(),
      protocolEditDeclarationsSchema
        .extend({ kind: z.literal('edit-protocol-declarations') })
        .strict(),
      protocolRecordRunValuesSchema.extend({ kind: z.literal('record-run-values') }).strict(),
    ]),
  })
  .strict();

export function protocolOperationCapabilities(
  kind: string
): readonly ('read-workspace' | 'write-workspace' | 'create-entity')[] {
  if (kind === 'create-protocol' || kind === 'start-run' || kind === 'recover-creation')
    return ['read-workspace', 'write-workspace', 'create-entity'];
  if (
    kind === 'save-package' ||
    kind === 'edit-protocol-declarations' ||
    kind === 'record-run-values'
  )
    return ['read-workspace', 'write-workspace'];
  return ['read-workspace'];
}
