export const UNTITLED_PRIMER_NAME = 'Untitled Primer';
export const UNTITLED_DNA_OLIGO_NAME = 'Untitled DNA Oligo';
export const UNTITLED_RNA_OLIGO_NAME = 'Untitled RNA Oligo';

export function primerDraftDisplayName(name: string, kindLabel = 'Primer'): string {
  return name.trim() || `Untitled ${kindLabel}`;
}
