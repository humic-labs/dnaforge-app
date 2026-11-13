export function isMocloMapSchemaStripEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_MOCLO_MAP_SCHEMA_STRIP === 'true';
}
