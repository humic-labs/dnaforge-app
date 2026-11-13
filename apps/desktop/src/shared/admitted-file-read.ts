export interface AdmittedTextFileReadRequest {
  path: string;
  projectRoots: readonly string[];
  grantedFiles: readonly string[];
  maxBytes?: number;
}

export interface AdmittedReadPathAdmission {
  projectRoots: readonly string[];
  grantedFiles: readonly string[];
}
