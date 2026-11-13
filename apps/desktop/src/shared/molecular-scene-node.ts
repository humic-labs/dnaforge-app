export type MolecularProfileNode = {
  ref?: string;
  kind: string;
  params?: Record<string, unknown>;
  custom?: Record<string, unknown>;
  children?: MolecularProfileNode[];
};
