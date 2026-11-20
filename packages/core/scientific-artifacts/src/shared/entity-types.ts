export const ENTITY_TYPE_ICON_KINDS = [
  'molecular-document',
  'notebook',
  'sequence',
  'annotation',
  'alignment',
  'primer',
  'design',
  'protein',
  'strain',
  'record',
  'structure',
  'genome',
  'chat',
  'folder',
  'text',
  'table',
] as const;
export type EntityTypeIconKind = (typeof ENTITY_TYPE_ICON_KINDS)[number];

interface EntityTypeDefinition {
  label: string;
  plural: string;
  iconKind: EntityTypeIconKind;
  terms?: readonly string[];
  registrySeedLabel?: string;
  catalogType?: 'sequence' | 'primer';
}

function entityType(
  label: string,
  plural: string,
  iconKind: EntityTypeIconKind,
  options?: Pick<EntityTypeDefinition, 'terms' | 'registrySeedLabel' | 'catalogType'>
): EntityTypeDefinition {
  return { label, plural, iconKind, ...options };
}

const registryTypes = {
  sequence: entityType('Sequence', 'Sequences', 'sequence', {
    registrySeedLabel: 'DNA sequence',
    catalogType: 'sequence',
  }),
  oligo: entityType('DNA Oligo', 'DNA oligos', 'primer', { catalogType: 'primer' }),
  rna_oligo: entityType('RNA Oligo', 'RNA oligos', 'primer', { catalogType: 'primer' }),
  plasmid: entityType('Plasmid', 'Plasmids', 'sequence', { catalogType: 'sequence' }),
  genome: entityType('Genome', 'Genomes', 'genome', { catalogType: 'sequence' }),
  chromosome: entityType('Chromosome', 'Chromosomes', 'genome', { catalogType: 'sequence' }),
  strain: entityType('Strain', 'Strains', 'strain'),
  organism: entityType('Organism', 'Organisms', 'record'),
  protein: entityType('Protein', 'Proteins', 'protein'),
  dna_sequence: entityType('DNA sequence', 'DNA sequences', 'sequence', {
    catalogType: 'sequence',
  }),
  rna_sequence: entityType('RNA sequence', 'RNA sequences', 'sequence', {
    catalogType: 'sequence',
  }),
  guide_rna: entityType('Guide RNA', 'Guide RNAs', 'record'),
  allele: entityType('Allele', 'Alleles', 'record'),
  locus: entityType('Locus', 'Loci', 'record'),
  part: entityType('Part', 'Parts', 'record'),
  fragment: entityType('Fragment', 'Fragments', 'record'),
  marker: entityType('Marker', 'Markers', 'record'),
  external_ref: entityType('External reference', 'External references', 'record'),
  notebook: entityType('Notebook', 'Notebooks', 'notebook', {
    registrySeedLabel: 'Notebook entry',
    terms: ['page', 'pages'],
  }),
  'track-view': entityType('Track view', 'Track views', 'genome'),
  'molecular-document': entityType(
    'Molecular document',
    'Molecular documents',
    'molecular-document',
    {
      registrySeedLabel: 'Molecular visualization',
    }
  ),
};

export type LimsEntityKind = keyof typeof registryTypes;
export const LIMS_ENTITY_KINDS = Object.freeze(
  Object.keys(registryTypes) as [LimsEntityKind, ...LimsEntityKind[]]
);

const entityTypes = {
  ...registryTypes,
  primer: entityType('Primer', 'Primers', 'primer'),
  design: entityType('Design', 'Designs', 'design'),
  alignment: entityType('Alignment', 'Alignments', 'alignment'),
  trace: entityType('Trace', 'Traces', 'record'),
  report: entityType('Report', 'Reports', 'text'),
  construct: entityType('Construct', 'Constructs', 'sequence'),
  sample: entityType('Sample', 'Samples', 'record'),
  record: entityType('Record', 'Records', 'record'),
  selection: entityType('Selection', 'Selections', 'annotation'),
  structure: entityType('Structure', 'Structures', 'structure'),
  protocol: entityType('Protocol', 'Protocols', 'record'),
  protocol_run: entityType('Protocol run', 'Protocol runs', 'record'),
  file: entityType('File', 'Files', 'text'),
  folder: entityType('Folder', 'Folders', 'folder'),
  table: entityType('Table', 'Tables', 'table'),
  annotation: entityType('Annotation', 'Annotations', 'annotation'),
  sequence_region: entityType('Sequence region', 'Sequence regions', 'annotation'),
};

export const CATALOG_ENTITY_TYPES = [
  'track-view',
  'molecular-document',
  'sequence',
  'primer',
  'notebook',
  'design',
  'alignment',
  'trace',
  'report',
  'construct',
  'sample',
  'record',
  'selection',
  'structure',
  'protein',
  'protocol',
  'protocol_run',
  'file',
  'folder',
] as const satisfies readonly (keyof typeof entityTypes)[];
export type CatalogEntityType = (typeof CATALOG_ENTITY_TYPES)[number];
export const LINKABLE_CATALOG_ENTITY_TYPES = CATALOG_ENTITY_TYPES.filter(
  (type) => type !== 'folder'
);

const aliases = {
  page: 'notebook',
  'page-link': 'notebook',
  directory: 'folder',
  text: 'file',
} as const satisfies Record<string, keyof typeof entityTypes>;

function canonicalKind(kind: string): string {
  return Object.hasOwn(aliases, kind) ? aliases[kind as keyof typeof aliases] : kind;
}

function definitionOf(raw: string): EntityTypeDefinition | undefined {
  const kind = canonicalKind(raw);
  return Object.hasOwn(entityTypes, kind)
    ? entityTypes[kind as keyof typeof entityTypes]
    : undefined;
}

export function entityKindLabel(kind: string): string {
  return (
    definitionOf(kind)?.label ?? kind.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
  );
}

export function entityKindPluralLabel(kind: string): string {
  return definitionOf(kind)?.plural ?? `${entityKindLabel(kind)}s`;
}

export function entityTypeIconKind(kind: string): EntityTypeIconKind | null {
  return definitionOf(kind)?.iconKind ?? null;
}

export function entityKindNoun(kind: string, plural = false): string {
  const type = definitionOf(kind);
  if (!type) return kind;
  return (plural ? type.plural : type.label).replace(/\b[A-Z][a-z]+\b/g, (word) =>
    word.toLowerCase()
  );
}

export function schemaEntityTypeLabel(
  schema: { displayName: string; builtin: boolean } & ({ name: string } | { entityKind: string })
): string {
  const name = 'name' in schema ? schema.name : schema.entityKind;
  return schema.builtin && Object.hasOwn(registryTypes, name)
    ? registryTypes[name as LimsEntityKind].label
    : schema.displayName;
}

export function deterministicSchemaId(kind: string, name: string): string {
  return `schema-${kind}-${name.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

export function persistedSchemaEntityTypeLabel(snapshot: {
  schemaId: string;
  name: string;
  displayName: string;
}): string {
  return schemaEntityTypeLabel({
    ...snapshot,
    builtin: snapshot.schemaId === deterministicSchemaId('entity', snapshot.name),
  });
}

export function builtinEntitySchemaIdentity<K extends LimsEntityKind>(name: K) {
  const type = registryTypes[name];
  return {
    name,
    kind: 'entity' as const,
    displayName: type.registrySeedLabel ?? type.label,
    builtin: true as const,
  };
}

interface NamedEntityTypeInput {
  type: string;
  registryKind?: string | null;
  schemaId?: string | null;
  schemaBuiltin?: boolean | number | null;
  representationKind?: string | null;
}

export const TABULAR_DATA_EXTENSIONS: ReadonlySet<string> = new Set(['csv', 'tsv', 'xlsx', 'xls']);

export function isTabularRepresentationKind(kind: string | null | undefined): boolean {
  return kind === 'table-document' || TABULAR_DATA_EXTENSIONS.has(kind?.toLowerCase() ?? '');
}

export function resolveNamedEntityType(input: NamedEntityTypeInput): string {
  if (input.schemaId && (input.schemaBuiltin === 0 || input.schemaBuiltin === false))
    return `schema:${input.schemaId}`;

  let kind = input.type;
  if (kind === 'registry' || kind === 'record') kind = input.registryKind || 'record';
  else if (input.registryKind && definitionOf(input.registryKind)?.catalogType === kind)
    kind = input.registryKind;
  kind = canonicalKind(kind);
  if (kind === 'file' && isTabularRepresentationKind(input.representationKind)) kind = 'table';
  if (kind === 'structure') kind = 'file';
  return `type:${kind}`;
}

interface NamedEntityTypePresentation {
  label: string;
  kindLabel: string;
  terms: readonly string[];
  iconKind: EntityTypeIconKind;
}

export function namedEntityTypePresentation(
  key: string,
  schemaName?: string | null,
  schemaLabel?: string | null
): NamedEntityTypePresentation {
  if (key.startsWith('schema:')) {
    const label = schemaLabel || schemaName || 'Record';
    return {
      label,
      kindLabel: label,
      terms: schemaName ? [schemaName, label] : [label],
      iconKind: entityTypeIconKind(schemaName ?? '') ?? 'record',
    };
  }
  const kind = key.slice('type:'.length);
  const type = definitionOf(kind);
  const kindLabel = entityKindLabel(kind);
  const label = entityKindPluralLabel(kind);
  return {
    label,
    kindLabel,
    terms: [kind, kindLabel, label, ...(type?.terms ?? [])],
    iconKind: type?.iconKind ?? 'record',
  };
}

export const PRIMER_ROLE_PRESENTATION = {
  key: 'role:primer',
  label: 'Primer',
  terms: ['primer', 'primers'],
  iconKind: 'primer',
} as const;

export function isPrimerEntity(
  type: string,
  registryKind: string | null,
  use: string | null
): boolean {
  if (type === 'primer' && !registryKind) return true;
  const kind = resolveNamedEntityType({ type, registryKind });
  return use === 'primer' && (kind === 'type:oligo' || kind === 'type:rna_oligo');
}
