import { FORGE_PACKAGE_MARKER_DIR } from './forge-package-path';
import { NOTEBOOK_PACKAGE_META_NAME } from '../db/notebook-package';
import { SEQUENCE_PACKAGE_META_ALIASES } from '../db/sequence-package';
import {
  PROTOCOL_PACKAGE_META_NAME,
  PROTOCOL_RUN_PACKAGE_META_NAME,
  type ScientificPackageKind,
} from './scientific-package';

export type DocumentPackageKind = 'notebook' | 'sequence' | ScientificPackageKind;
export interface DocumentPackage {
  kind: DocumentPackageKind;
  metadataPath: string;
}
export interface DocumentPackageIo {
  exists(path: string): Promise<boolean>;
  readDir(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>>;
}

function childPath(parent: string, name: string): string {
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/u, '')}${separator}${name}`;
}

export async function detectDocumentPackage(
  directory: string,
  io: DocumentPackageIo
): Promise<DocumentPackage | undefined> {
  const markerDirectory = childPath(directory, FORGE_PACKAGE_MARKER_DIR);
  if (!(await io.exists(markerDirectory))) return undefined;
  const entries = (await io.readDir(markerDirectory)).filter((entry) => entry.isFile);
  const families: Array<[DocumentPackageKind, readonly string[]]> = [
    ['notebook', [NOTEBOOK_PACKAGE_META_NAME]],
    ['sequence', SEQUENCE_PACKAGE_META_ALIASES],
    ['protocol', [PROTOCOL_PACKAGE_META_NAME]],
    ['protocol-run', [PROTOCOL_RUN_PACKAGE_META_NAME]],
  ];
  for (const [kind, names] of families) {
    const marker = entries.find((entry) =>
      names.some((name) => name.toLowerCase() === entry.name.toLowerCase())
    );
    if (marker) return { kind, metadataPath: childPath(markerDirectory, marker.name) };
  }
  return undefined;
}
