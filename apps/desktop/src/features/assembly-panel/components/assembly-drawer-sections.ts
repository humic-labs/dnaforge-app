export const ASSEMBLY_DRAWER_SECTIONS = [
  { id: 'parts', number: 1, label: 'Parts' },
  { id: 'assembly', number: 2, label: 'Assembly' },
  { id: 'export', number: 3, label: 'Finalize and Export' },
] as const;

export type AssemblyDrawerStep = (typeof ASSEMBLY_DRAWER_SECTIONS)[number];
export type AssemblyDrawerStepId = AssemblyDrawerStep['id'];
