export const REF_TOKEN_PATTERN =
  /\[\[ref:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/;

export function isReferenceCreationTool(name: string | null | undefined): boolean {
  return (
    name === 'create_reference' ||
    name === 'create_notebook_reference' ||
    name === 'create_notebook' ||
    name === 'update_notebook' ||
    name === 'mol_save_view' ||
    name === 'mol_save_to_notebook'
  );
}
