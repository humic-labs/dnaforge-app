export type InlineReferenceTargetKind = 'workspace' | 'sequence' | 'structure';
export type InlineReferenceTargetType = 'file' | 'directory' | 'sequence-package';

export interface InlineReferenceWorkspaceRoot {
  name: string;
  path: string;
}

export interface ResolveInlineReferenceTargetRequest {
  roots: InlineReferenceWorkspaceRoot[];
  root: string;
  segments: string[];
  targetKind: InlineReferenceTargetKind;
}

export type InlineReferenceTargetFailureCode =
  | 'invalid-input'
  | 'root-not-found'
  | 'root-ambiguous'
  | 'root-unavailable'
  | 'outside-root'
  | 'target-not-found'
  | 'target-unavailable'
  | 'wrong-kind';

export type ResolveInlineReferenceTargetResult =
  | {
      ok: true;
      path: string;
      rootPath: string;
      canonicalPath: string;
      canonicalRootPath: string;
      relativePath: string;
      targetType: InlineReferenceTargetType;
    }
  | {
      ok: false;
      code: InlineReferenceTargetFailureCode;
    };
