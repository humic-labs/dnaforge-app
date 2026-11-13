import { z } from 'zod';
import { isAbsolutePathLike } from './path-boundary';
import { inferCatalogFileKind } from './catalog-file-kind';

export function isFastaKindSourcePath(path: string): boolean {
  return inferCatalogFileKind(path) === 'fasta' || /\.fas$/iu.test(path);
}

export const FASTA_KIND_DECLARATION_EVENT = 'native.fasta-kind-declaration.v1';
export const fastaKindSchema = z.enum(['sequence', 'protein']);
export type FastaKind = z.infer<typeof fastaKindSchema>;

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => isAbsolutePathLike(value) && !value.includes('\0'));
export const fastaKindInspectionSchema = z
  .object({
    path: absolutePath,
    workspaceRoot: absolutePath,
  })
  .strict();
export type FastaKindInspection = z.infer<typeof fastaKindInspectionSchema>;
export const fastaKindClassificationSchema = fastaKindInspectionSchema
  .extend({
    kind: fastaKindSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type FastaKindClassification = z.infer<typeof fastaKindClassificationSchema>;

export interface FastaKindSourceWitness {
  path: string;
  workspaceRoot: string;
  entityId: string;
  bindingId: string;
  objectUuid: string | null;
  sourceFingerprint: string;
  revision: string;
}
export type DeclaredFastaKindAuthority = FastaKindSourceWitness & {
  status: 'declared';
  kind: FastaKind;
  authority: 'native-declaration' | 'canonical-source';
};
export type FastaKindAuthority =
  | DeclaredFastaKindAuthority
  | (FastaKindSourceWitness & {
      status: 'legacy-compatible' | 'needs-classification';
      storedKind: FastaKind;
      legacyReadView: FastaKind;
      readOnly: true;
    });

export type FastaKindReadAuthority =
  | Omit<DeclaredFastaKindAuthority, 'sourceFingerprint' | 'revision'>
  | Omit<Extract<FastaKindAuthority, { readOnly: true }>, 'sourceFingerprint' | 'revision'>;
