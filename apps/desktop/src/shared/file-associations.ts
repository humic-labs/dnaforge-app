import externalPreviews from '../../resources/external-previews.json';
import registryJson from '../../resources/file-associations.json';

export type FileAssociationFamilyId = 'genbank' | 'snapgene';
export type FileAssociationCapability = 'editor' | 'viewer';
export type MacDocumentRole = 'Editor' | 'Viewer';
export type MacHandlerRank = 'Alternate';

export const QUICK_LOOK_PACKAGE_STORE_DIRECTORY = 'quick-look-packages';

export interface FileAssociationFamily {
  readonly id: FileAssociationFamilyId;
  readonly displayName: string;
  readonly documentDescription: string;
  readonly extensions: readonly string[];
  readonly capability: FileAssociationCapability;
  readonly parser: 'genbank' | 'snapgene';
  readonly documentIcons: {
    readonly macos: string;
    readonly windows: string;
  };
  readonly macos: {
    readonly contentType: string;
    readonly aliases: readonly string[];
    readonly ownership: 'exported' | 'imported';
    readonly conformsTo: readonly string[];
    readonly mimeTypes: readonly string[];
    readonly role: MacDocumentRole;
    readonly rank: MacHandlerRank;
  };
  readonly windows: {
    readonly progId: string;
  };
}

interface FileAssociationRegistry {
  readonly version: 1;
  readonly families: readonly FileAssociationFamily[];
}

const FAMILY_IDS = new Set<FileAssociationFamilyId>(['genbank', 'snapgene']);
const EXTENSION_PATTERN = /^[a-z0-9]+$/u;

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`File association registry ${field} must be a non-empty string.`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`File association registry ${field} must be a non-empty string array.`);
  }
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`));
}

function parseFamily(value: unknown, index: number): FileAssociationFamily {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`File association registry families[${index}] must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const id = requireString(record.id, `families[${index}].id`);
  if (!FAMILY_IDS.has(id as FileAssociationFamilyId)) {
    throw new Error(`File association registry has unknown family id ${id}.`);
  }
  const capability = requireString(record.capability, `families[${index}].capability`);
  if (capability !== 'editor' && capability !== 'viewer') {
    throw new Error(`File association registry ${id} has invalid capability ${capability}.`);
  }
  const parser = requireString(record.parser, `families[${index}].parser`);
  if (parser !== 'genbank' && parser !== 'snapgene') {
    throw new Error(`File association registry ${id} has invalid parser ${parser}.`);
  }
  const extensions = requireStringArray(record.extensions, `families[${index}].extensions`);
  for (const extension of extensions) {
    if (!EXTENSION_PATTERN.test(extension) || extension !== extension.toLowerCase()) {
      throw new Error(`File association registry ${id} has invalid extension ${extension}.`);
    }
  }
  const icons = record.documentIcons;
  const macos = record.macos;
  const windows = record.windows;
  if (typeof icons !== 'object' || icons === null) {
    throw new Error(`File association registry ${id}.documentIcons must be an object.`);
  }
  if (typeof macos !== 'object' || macos === null) {
    throw new Error(`File association registry ${id}.macos must be an object.`);
  }
  if (typeof windows !== 'object' || windows === null) {
    throw new Error(`File association registry ${id}.windows must be an object.`);
  }
  const iconRecord = icons as Record<string, unknown>;
  const macRecord = macos as Record<string, unknown>;
  const windowsRecord = windows as Record<string, unknown>;
  const role = requireString(macRecord.role, `families[${index}].macos.role`);
  if (role !== 'Editor' && role !== 'Viewer') {
    throw new Error(`File association registry ${id} has invalid macOS role ${role}.`);
  }
  const rank = requireString(macRecord.rank, `families[${index}].macos.rank`);
  if (rank !== 'Alternate') {
    throw new Error(`File association registry ${id} must use Alternate handler rank.`);
  }
  const ownership = requireString(macRecord.ownership, `families[${index}].macos.ownership`);
  if (ownership !== 'exported' && ownership !== 'imported') {
    throw new Error(`File association registry ${id} has invalid macOS ownership ${ownership}.`);
  }

  return {
    id: id as FileAssociationFamilyId,
    displayName: requireString(record.displayName, `families[${index}].displayName`),
    documentDescription: requireString(
      record.documentDescription,
      `families[${index}].documentDescription`
    ),
    extensions,
    capability,
    parser,
    documentIcons: {
      macos: requireString(iconRecord.macos, `families[${index}].documentIcons.macos`),
      windows: requireString(iconRecord.windows, `families[${index}].documentIcons.windows`),
    },
    macos: {
      contentType: requireString(macRecord.contentType, `families[${index}].macos.contentType`),
      aliases: requireStringArray(macRecord.aliases, `families[${index}].macos.aliases`),
      ownership,
      conformsTo: requireStringArray(macRecord.conformsTo, `families[${index}].macos.conformsTo`),
      mimeTypes: Array.isArray(macRecord.mimeTypes)
        ? macRecord.mimeTypes.map((entry, mimeIndex) =>
            requireString(entry, `families[${index}].macos.mimeTypes[${mimeIndex}]`)
          )
        : [],
      role,
      rank,
    },
    windows: {
      progId: requireString(windowsRecord.progId, `families[${index}].windows.progId`),
    },
  };
}

function parseRegistry(value: unknown): FileAssociationRegistry {
  if (typeof value !== 'object' || value === null) {
    throw new Error('File association registry must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.families)) {
    throw new Error('File association registry must use version 1 and contain families.');
  }
  const families = record.families.map(parseFamily);
  const ids = new Set(families.map((family) => family.id));
  if (ids.size !== families.length || ids.size !== FAMILY_IDS.size) {
    throw new Error('File association registry must contain each known family exactly once.');
  }
  const extensions = families.flatMap((family) => family.extensions);
  if (new Set(extensions).size !== extensions.length) {
    throw new Error('File association registry extensions must be unique across families.');
  }
  return { version: 1, families };
}

const REGISTRY = parseRegistry(registryJson);

export const FILE_ASSOCIATION_FAMILIES = REGISTRY.families;

const FAMILIES_BY_ID = new Map(
  FILE_ASSOCIATION_FAMILIES.map((family) => [family.id, family] as const)
);
const FAMILIES_BY_EXTENSION = new Map(
  FILE_ASSOCIATION_FAMILIES.flatMap((family) =>
    family.extensions.map((extension) => [extension, family] as const)
  )
);

export function fileAssociationFamily(id: FileAssociationFamilyId): FileAssociationFamily {
  const family = FAMILIES_BY_ID.get(id);
  if (!family) throw new Error(`Unknown file association family: ${id}`);
  return family;
}

export function associationFamilyForPath(path: string): FileAssociationFamily | null {
  const name = path.replace(/\\/gu, '/').split('/').pop() ?? '';
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === name.length - 1) return null;
  return FAMILIES_BY_EXTENSION.get(name.slice(lastDot + 1).toLowerCase()) ?? null;
}

export type HandlerFamilyId = FileAssociationFamilyId | 'fasta' | 'structure' | 'chromatogram';

export interface HandlerFamily {
  readonly id: HandlerFamilyId;
  readonly displayName: string;
  readonly extensions: readonly string[];
  readonly windows: { readonly progId: string };
  readonly macTypeIds: readonly string[];
}

export const HANDLER_FAMILIES: readonly HandlerFamily[] = [
  ...FILE_ASSOCIATION_FAMILIES.map((family) => ({
    ...family,
    macTypeIds: [family.macos.contentType, ...family.macos.aliases],
  })),
  ...externalPreviews.families.map((family): HandlerFamily => {
    if (family.id !== 'fasta' && family.id !== 'structure' && family.id !== 'chromatogram') {
      throw new Error(`Unknown external preview family: ${family.id}`);
    }
    return { ...family, id: family.id, macTypeIds: family.macosTypes.map((type) => type.id) };
  }),
];

export function handlerFamily(id: unknown): HandlerFamily {
  const family = HANDLER_FAMILIES.find((entry) => entry.id === id);
  if (!family) throw new Error('Unknown file association family.');
  return family;
}
