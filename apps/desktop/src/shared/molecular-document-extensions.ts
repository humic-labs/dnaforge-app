import { z } from 'zod';

export class MolecularDocumentCompatibilityError extends Error {
  constructor(
    readonly code:
      | 'MOLECULAR_DOCUMENT_NEWER_FORMAT'
      | 'MOLECULAR_DOCUMENT_MIGRATION_FAILED'
      | 'MOLECULAR_DOCUMENT_INVALID_EXTENSION'
      | 'MOLECULAR_DOCUMENT_UNSUPPORTED_EXTENSION',
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'MolecularDocumentCompatibilityError';
  }
}

export type MolecularExtensionValue =
  | null
  | boolean
  | number
  | string
  | MolecularExtensionValue[]
  | { [key: string]: MolecularExtensionValue };

function isExtensionValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number')
    return (
      Number.isFinite(value) &&
      !Object.is(value, -0) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))
    );
  if (typeof value !== 'object' || ancestors.has(value) || ancestors.size >= 64) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(value);
  if (Array.isArray(value) && keys.some((key, index) => key !== String(index))) return false;
  if (Array.isArray(value) && keys.length !== value.length) return false;
  if (keys.some((key) => !('value' in descriptors[key]))) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((child) => isExtensionValue(child, ancestors));
  ancestors.delete(value);
  return valid;
}

export const molecularExtensionNameSchema = z
  .string()
  .max(200)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u);

export const molecularDocumentExtensionSchema = z
  .object({
    version: z.number().int().positive().safe(),
    data: z
      .custom<
        Record<string, MolecularExtensionValue>
      >((value) => value !== null && typeof value === 'object' && !Array.isArray(value) && isExtensionValue(value), 'Extension data must be a JSON object whose values can be saved without loss.')
      .transform(
        (value) => JSON.parse(JSON.stringify(value)) as Record<string, MolecularExtensionValue>
      ),
  })
  .strict();

export const molecularDocumentExtensionFields = {
  extensions: z.record(molecularExtensionNameSchema, molecularDocumentExtensionSchema).optional(),
  requiredExtensions: z.array(molecularExtensionNameSchema).optional(),
};

export const supportedMolecularDocumentExtensions: Readonly<Record<string, readonly number[]>> =
  Object.freeze({});

export function supportsMolecularDocumentExtension(name: string, version: number): boolean {
  return supportedMolecularDocumentExtensions[name]?.includes(version) ?? false;
}

export type MolecularDocumentExtension = z.infer<typeof molecularDocumentExtensionSchema>;

export function assertMolecularDocumentExtensionsSupported(document: {
  extensions?: Record<string, MolecularDocumentExtension>;
  requiredExtensions?: string[];
}): void {
  const required = document.requiredExtensions ?? [];
  if (new Set(required).size !== required.length)
    throw new MolecularDocumentCompatibilityError(
      'MOLECULAR_DOCUMENT_INVALID_EXTENSION',
      'Essential features must be unique.'
    );
  for (const name of required) {
    const extension = document.extensions?.[name];
    if (!extension)
      throw new MolecularDocumentCompatibilityError(
        'MOLECULAR_DOCUMENT_INVALID_EXTENSION',
        `Missing essential feature ${name}.`
      );
    if (!supportsMolecularDocumentExtension(name, extension.version))
      throw new MolecularDocumentCompatibilityError(
        'MOLECULAR_DOCUMENT_UNSUPPORTED_EXTENSION',
        `${name} version ${extension.version} is required. Open this document in an app that supports that feature.`
      );
  }
}
