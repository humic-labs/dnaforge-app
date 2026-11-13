import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

import { SYNTHETIC_INVALID_STRAIN_TEXT, SYNTHETIC_STRAIN_TEXT } from './native-record-fixtures';

export type SyntheticZipEntry = {
  path: string;
  bytes?: Uint8Array | string;
  compression?: 'stored' | 'deflate';
  unixMode?: number;
  corruptCentralCrc?: boolean;
};

export type SyntheticZipFixture = {
  bytes: Uint8Array;
  sha256: `sha256:${string}`;
  sizeBytes: number;
  declaredUncompressedBytes: number;
};

export type NestedFolderTreeCanonicalItem = Readonly<{
  canonicalPath: string;
  sourceObjectId: string;
  sourceKind: 'notebook_entry' | 'sequence' | 'protein';
}>;

export type NestedFolderTreeNativeExportFixture = Readonly<{
  archive: SyntheticZipFixture;
  rootFolderName: string;
  canonicalItems: readonly NestedFolderTreeCanonicalItem[];
  expectedUniqueStableIds: readonly string[];
  expectedFolderPaths: readonly string[];
  expectedMembershipPairs: readonly string[];
  expectedGrandchildPath: string;
  expectedGrandchildParentPath: string;
  attachmentPath: string;
  supportPath: string;
}>;

export function buildNestedFolderTreeNativeExportFixture(): NestedFolderTreeNativeExportFixture {
  const rootFolderName = 'Selected Root';
  const canonicalItems = [
    canonicalItem(
      `${rootFolderName}/Root notebook (etr_TREEROOT).html`,
      'etr_TREEROOT',
      'notebook_entry'
    ),
    canonicalItem(
      `${rootFolderName}/Alpha/Alpha DNA (seq_TREEALPHA).gb`,
      'seq_TREEALPHA',
      'sequence'
    ),
    canonicalItem(
      `${rootFolderName}/Alpha/Shared DNA (seq_TREESHARED).gb`,
      'seq_TREESHARED',
      'sequence'
    ),
    canonicalItem(
      `${rootFolderName}/Alpha/Grandchild/Grandchild DNA (seq_TREEGRAND).gb`,
      'seq_TREEGRAND',
      'sequence'
    ),
    canonicalItem(
      `${rootFolderName}/Beta/Beta notebook (etr_TREEBETA).html`,
      'etr_TREEBETA',
      'notebook_entry'
    ),
    canonicalItem(
      `${rootFolderName}/Beta/Shared DNA (seq_TREESHARED).gb`,
      'seq_TREESHARED',
      'sequence'
    ),
    canonicalItem(
      `${rootFolderName}/Gamma/Gamma protein (prtn_TREEGAMMA).fasta`,
      'prtn_TREEGAMMA',
      'protein'
    ),
    canonicalItem(
      `${rootFolderName}/Delta/Delta DNA (seq_TREEDELTA).gb`,
      'seq_TREEDELTA',
      'sequence'
    ),
    canonicalItem(
      `${rootFolderName}/Delta/Empty DNA (seq_TREEEMPTY).gb`,
      'seq_TREEEMPTY',
      'sequence'
    ),
    canonicalItem(
      `${rootFolderName}/Epsilon/Epsilon notebook (etr_TREEEPSILON).html`,
      'etr_TREEEPSILON',
      'notebook_entry'
    ),
    canonicalItem(
      `${rootFolderName}/Registry/Shared synthetic strain (bfi_STRAINAA).txt`,
      'bfi_STRAINAA',
      'notebook_entry'
    ),
    canonicalItem(
      `${rootFolderName}/Registry/Metadata only (bfi_UNKNOWNX).txt`,
      'bfi_UNKNOWNX',
      'notebook_entry'
    ),
  ] as const;
  const attachmentPath = `${rootFolderName}/Root notebook (etr_TREEROOT) attachment.png`;
  const supportPath = `${rootFolderName}/export-notes.txt`;
  const entries: SyntheticZipEntry[] = canonicalItems.map((item) => ({
    path: item.canonicalPath,
    bytes: canonicalObjectBytes(item),
  }));
  entries.push(
    { path: attachmentPath, bytes: 'inert synthetic attachment bytes' },
    { path: supportPath, bytes: 'Synthetic non-canonical support file.' }
  );
  return Object.freeze({
    archive: buildSyntheticNativeExportZip(entries),
    rootFolderName,
    canonicalItems: Object.freeze([...canonicalItems]),
    expectedUniqueStableIds: Object.freeze([
      'bfi_STRAINAA',
      'bfi_UNKNOWNX',
      'etr_TREEBETA',
      'etr_TREEEPSILON',
      'etr_TREEROOT',
      'prtn_TREEGAMMA',
      'seq_TREEALPHA',
      'seq_TREEDELTA',
      'seq_TREEEMPTY',
      'seq_TREEGRAND',
      'seq_TREESHARED',
    ]),
    expectedFolderPaths: Object.freeze([
      rootFolderName,
      `${rootFolderName}/Alpha`,
      `${rootFolderName}/Alpha/Grandchild`,
      `${rootFolderName}/Beta`,
      `${rootFolderName}/Delta`,
      `${rootFolderName}/Epsilon`,
      `${rootFolderName}/Gamma`,
      `${rootFolderName}/Registry`,
    ]),
    expectedMembershipPairs: Object.freeze([
      `bfi_STRAINAA\0${rootFolderName}/Registry`,
      `bfi_UNKNOWNX\0${rootFolderName}/Registry`,
      `etr_TREEBETA\0${rootFolderName}/Beta`,
      `etr_TREEEPSILON\0${rootFolderName}/Epsilon`,
      `etr_TREEROOT\0${rootFolderName}`,
      `prtn_TREEGAMMA\0${rootFolderName}/Gamma`,
      `seq_TREEALPHA\0${rootFolderName}/Alpha`,
      `seq_TREEDELTA\0${rootFolderName}/Delta`,
      `seq_TREEEMPTY\0${rootFolderName}/Delta`,
      `seq_TREEGRAND\0${rootFolderName}/Alpha/Grandchild`,
      `seq_TREESHARED\0${rootFolderName}/Alpha`,
      `seq_TREESHARED\0${rootFolderName}/Beta`,
    ]),
    expectedGrandchildPath: `${rootFolderName}/Alpha/Grandchild`,
    expectedGrandchildParentPath: `${rootFolderName}/Alpha`,
    attachmentPath,
    supportPath,
  });
}

export function buildSyntheticNativeExportZip(
  entries: readonly SyntheticZipEntry[]
): SyntheticZipFixture {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  let declaredUncompressedBytes = 0;

  for (const fixture of entries) {
    const name = Buffer.from(fixture.path, 'utf8');
    const raw =
      typeof fixture.bytes === 'string'
        ? Buffer.from(fixture.bytes, 'utf8')
        : Buffer.from(fixture.bytes ?? new Uint8Array());
    const method = fixture.compression === 'stored' ? 0 : 8;
    const compressed = method === 0 ? raw : deflateRawSync(raw);
    const crc = crc32(raw);
    const flags = 0x0800;
    const mode = fixture.unixMode ?? (fixture.path.endsWith('/') ? 0o040755 : 0o100644);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(raw.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(fixture.corruptCentralCrc ? (crc ^ 0xffffffff) >>> 0 : crc, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(raw.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.byteLength + name.byteLength + compressed.byteLength;
    declaredUncompressedBytes += raw.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);
  const bytes = Buffer.concat([...localParts, centralDirectory, end]);
  return {
    bytes: Uint8Array.from(bytes),
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    sizeBytes: bytes.byteLength,
    declaredUncompressedBytes,
  };
}

function canonicalItem(
  canonicalPath: string,
  sourceObjectId: string,
  sourceKind: NestedFolderTreeCanonicalItem['sourceKind']
): NestedFolderTreeCanonicalItem {
  return Object.freeze({ canonicalPath, sourceObjectId, sourceKind });
}

function canonicalObjectBytes(item: NestedFolderTreeCanonicalItem): string {
  if (item.sourceObjectId === 'bfi_STRAINAA') return SYNTHETIC_STRAIN_TEXT;
  if (item.sourceObjectId === 'bfi_UNKNOWNX') return SYNTHETIC_INVALID_STRAIN_TEXT;
  if (item.sourceKind === 'notebook_entry') {
    return `<!doctype html><html><body><h1>${canonicalHumanTitle(item)}</h1></body></html>`;
  }
  if (item.sourceKind === 'protein') {
    return `>${item.sourceObjectId} ${canonicalHumanTitle(item)}\nMKWVTF\n`;
  }
  if (item.sourceObjectId === 'seq_TREEEMPTY') {
    return 'This Benchling DNA record has no parseable native sequence.\n';
  }
  return (
    `LOCUS       ${item.sourceObjectId.padEnd(20)} 8 bp    DNA     linear\n` +
    `DEFINITION  ${item.sourceObjectId}.\n` +
    'ORIGIN\n' +
    '        1 acgtacgt\n' +
    '//\n'
  );
}

function canonicalHumanTitle(item: NestedFolderTreeCanonicalItem): string {
  const fileName = item.canonicalPath.split('/').at(-1) ?? item.sourceObjectId;
  return fileName.replace(/\s+\([^()]+\)\.[^.]+$/u, '');
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
