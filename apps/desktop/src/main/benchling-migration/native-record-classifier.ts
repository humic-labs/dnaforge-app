import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import type { SourceObject } from '../../shared/benchling-migration';
import {
  isExactProviderStableId,
  providerObjectClassForStableId,
  providerObjectReferenceKey,
  type ProviderObjectClass,
} from '../../shared/provider-object-reference';

export const BENCHLING_NATIVE_RECORD_CLASSIFIER_VERSION =
  'benchling-native-record-classifier.v1' as const;

export type NativeRecordRawAccess = Readonly<{
  archivePartId: string;
  entryPath: string;
}>;

export type BenchlingStrainField = Readonly<{
  label: string;
  value: string;
  position: number;
}>;

export type BenchlingStrainContent = Readonly<{
  kind: 'benchling_strain';
  displayName: string;
  fields: readonly BenchlingStrainField[];
  sha256: string;
  sizeBytes: number;
  rawAccess: NativeRecordRawAccess;
}>;

export type GenBankSourceField = Readonly<{
  label: string;
  value: string;
  position: number;
  lines: readonly string[];
}>;

export type ZeroBaseGenBankMetadata = Readonly<{
  locus: Readonly<{
    raw: string;
    name: string;
    declaredLength: 0;
    moleculeType: 'DNA' | 'RNA';
    topology: 'linear' | 'circular';
    date?: string;
  }>;
  definition?: string;
  accession?: string;
  version?: string;
  keywords: readonly string[];
  source?: string;
  comments: readonly string[];
  sourceFields: readonly GenBankSourceField[];
}>;

export type BenchlingNeedsSequenceContent = Readonly<{
  kind: 'dna_sequence_needs_sequence';
  moleculeType: 'DNA';
  bases: '';
  topology: 'linear' | 'circular';
  annotations: readonly [];
  genbankMetadata: ZeroBaseGenBankMetadata;
  sha256: string;
  sizeBytes: number;
  rawAccess: NativeRecordRawAccess;
}>;

type ClassificationBase<
  TClassification extends string,
  TNativeKind extends string,
  TContent,
> = Readonly<{
  classification: TClassification;
  sourceObjectId: string;
  stableId: string;
  providerObjectClass: ProviderObjectClass | null;
  originalSourceType: string;
  normalizedNativeKind: TNativeKind;
  rawAccess: NativeRecordRawAccess;
  rawSha256: string;
  rawSizeBytes: number;
  parsedContent: TContent;
  converterId: string;
  converterVersion: typeof BENCHLING_NATIVE_RECORD_CLASSIFIER_VERSION;
}>;

export type NativeRecordClassification =
  | ClassificationBase<'ordinary_native', 'ordinary_native', null>
  | ClassificationBase<'benchling_strain', 'benchling_strain', BenchlingStrainContent>
  | ClassificationBase<
      'dna_sequence_needs_sequence',
      'dna_sequence_needs_sequence',
      BenchlingNeedsSequenceContent
    >
  | (ClassificationBase<'unsupported', 'unsupported', null> & Readonly<{ reason: string }>);

export type NativeRecordClassifierInput = Readonly<{
  sourceObject: SourceObject;
  rawText: string;
  rawSha256: string;
  rawSizeBytes: number;
  rawAccess: NativeRecordRawAccess;
}>;

const VERIFIED_STRAIN_LAYOUT_HASHES = new Set([
  '04e890e3380d5669ef35a4845a86cbd4bd9dc10e52874a557d3b4bf9899e041e',
  '185bc98013dffb9560f4a32c6ca899108802fa49d0feb1e43c25d84faadd20c6',
  '1ba87340c5863c37ad0e05d454ce5bec829f076ec53ef758f5870bae7f765bda',
  '22625430c5e38d9b3d393094f5e1b176375f3f2628374731c20c33484289802f',
  '28088cbd899f771c2acb07021283269c9de5264e0a8d1338e597347c90a86d77',
  '29821c94939c94c63c347ab77c651ee91d141e14d419706a97866a426275fe11',
  '3c96775176c8eab5f6f2c8228fcc5444db23e243e1468378a99bb673be4a7f29',
  '3d1ba2a6f0fe0252a1b5c0ddf5e14939bc5450ca84fbc3cf89c528ea229b7ec0',
  '47428dd96b54d64c7a24700f504b9523b675649503908e47b57ca1574a29131a',
  '49ba19984c574b2cbfb024cf588c93c51fe1667dd3bbad1f1256ef4797bb2ce1',
  '564f52be63e3c5963be4221160b3998a13f58df65c8f569da404fdc1c6b3e958',
  '796debcd33dbf2c5310f6ee166c4d254bc50abfb33ed9c2a287a273973e427d6',
  '843f2e2bf60bbd8ad5b3d184188f0b443d5b9ea5e2420a0d742d18e1a0c69103',
  '8483e977af2d2a0b8a499bd128c35140de2bb2c1c732e56c0c3649455df6a320',
  '8c36e83afa6e872b8070c93dc74394dd064ccf38cbb7a4e18f0339be0a20f2ce',
  '8f0c982f87fc33d591a4cf9ac4c23b777d93c212e877102762285824e57a925a',
  '90b1636b0785f4c3be5d02538efff885d86dfe6a9e2c87a63104b3b242b00017',
  '99218ecbd2a5d17c5837a73606fe0cff9fd56437696dfc4236131b8fa86b8285',
  'a26b8904bf09d557ebbfabbb12fdb0dbbfb5a21890f249ac7bdd8ea28dc516ec',
  'aa5eea16e14057e2ba42fa991cd2d9057402636483efa591640f1a38c3ddf52e',
  'aeb0b622a313c1537f5c355be5ca9e890c64f21ed165413ee19ad46aed4bf50a',
  'b92f79689498c4c1a6a8afd062b8cf0185d083871a7479bf240c0f8f689797b4',
  'd02f8992ae856b46777472e72bc37c637f43d966f543b3870cbfc57fec10c110',
  'db76ea2086c8b134b8db369029f8b933a74185d56ab7e3b244c34877ea3d2c45',
  'dd8ce11617a6f9c32011f485f2912b7d80ef1b112c92ecbc6a9588e0c96b6617',
  'e47ac8387bd875be482ab38208e021d80a02820c33703c27daa18f359d9df629',
  'e53943acb68a68cf72b4a87c0a9e7166a323d59b5fb801f4219ce61d6c8f3514',
  'e7824481fc9e9f84dd601deb494a4ff215f19f7e102c85d4892ee0546c126fa9',
  'f2a46ee08d38c85ca2bdd7bef1fabfd8a7e55d2dde912228c7acbb996814ebf2',
  'b0502b2a54d6c9159b061e72b5f34e48162bd27f2986c8a7e5e65f866c816cb1',
  '841a395785c5b393e6812ba2da7d6cd9bc085e2ac7edab5005d2e535e15894af',
]);

export function classifyNativeRecord(
  input: NativeRecordClassifierInput
): NativeRecordClassification {
  const providerObjectClass = providerObjectClassForStableId(input.sourceObject.stableId);
  const base = classificationBase(input, providerObjectClass);

  if (isStrainCandidate(input.sourceObject, providerObjectClass)) {
    const parsed = parseVerifiedStrain(input.rawText);
    if (!parsed.ok) {
      return {
        ...base,
        classification: 'unsupported',
        normalizedNativeKind: 'unsupported',
        parsedContent: null,
        converterId: 'benchling-unsupported-record',
        reason: parsed.reason,
      };
    }
    return {
      ...base,
      classification: 'benchling_strain',
      normalizedNativeKind: 'benchling_strain',
      converterId: 'benchling-strain-v1',
      parsedContent: {
        kind: 'benchling_strain',
        displayName: parsed.displayName,
        fields: parsed.fields,
        sha256: input.rawSha256,
        sizeBytes: input.rawSizeBytes,
        rawAccess: input.rawAccess,
      },
    };
  }

  if (isSequenceCandidate(input.sourceObject, providerObjectClass)) {
    const parsed = parseZeroBaseGenBank(input.rawText);
    if (parsed.kind === 'zero_base') {
      return {
        ...base,
        classification: 'dna_sequence_needs_sequence',
        normalizedNativeKind: 'dna_sequence_needs_sequence',
        converterId: 'benchling-dna-needs-sequence-v1',
        parsedContent: {
          kind: 'dna_sequence_needs_sequence',
          moleculeType: 'DNA',
          bases: '',
          topology: parsed.metadata.locus.topology,
          annotations: [],
          genbankMetadata: parsed.metadata,
          sha256: input.rawSha256,
          sizeBytes: input.rawSizeBytes,
          rawAccess: input.rawAccess,
        },
      };
    }
    if (parsed.kind === 'invalid_zero_base_candidate') {
      return {
        ...base,
        classification: 'unsupported',
        normalizedNativeKind: 'unsupported',
        parsedContent: null,
        converterId: 'benchling-unsupported-record',
        reason: parsed.reason,
      };
    }
  }

  return {
    ...base,
    classification: 'ordinary_native',
    normalizedNativeKind: 'ordinary_native',
    parsedContent: null,
    converterId: 'benchling-existing-native',
  };
}

export function providerIdentityDestinationObjectId(sourceObject: SourceObject): string | null {
  const stableObjectId = sourceObject.stableId;
  if (!isExactProviderStableId(stableObjectId)) return null;
  const objectClass = providerObjectClassForStableId(stableObjectId);
  if (!objectClass) return null;
  const prefix = destinationPrefix(sourceObject, objectClass);
  const digest = sha256(
    providerObjectReferenceKey({ provider: 'benchling', stableObjectId, objectClass })
  ).slice(0, 24);
  return `${prefix}-${digest}`;
}

function classificationBase(
  input: NativeRecordClassifierInput,
  providerObjectClass: ProviderObjectClass | null
) {
  return {
    sourceObjectId: input.sourceObject.id,
    stableId: input.sourceObject.stableId,
    providerObjectClass,
    originalSourceType: input.sourceObject.sourceType,
    rawAccess: input.rawAccess,
    rawSha256: input.rawSha256,
    rawSizeBytes: input.rawSizeBytes,
    converterVersion: BENCHLING_NATIVE_RECORD_CLASSIFIER_VERSION,
  } as const;
}

function isStrainCandidate(
  sourceObject: SourceObject,
  objectClass: ProviderObjectClass | null
): boolean {
  if (
    !isExactProviderStableId(sourceObject.stableId) ||
    !sourceObject.stableId.startsWith('bfi_')
  ) {
    return false;
  }
  if (objectClass !== 'registry_entity' || !sourceObject.sourcePath) return false;
  return pathCarriesStableId(sourceObject.sourcePath, sourceObject.stableId, '.txt');
}

function isSequenceCandidate(
  sourceObject: SourceObject,
  objectClass: ProviderObjectClass | null
): boolean {
  if (
    !isExactProviderStableId(sourceObject.stableId) ||
    !sourceObject.stableId.startsWith('seq_')
  ) {
    return false;
  }
  if (objectClass !== 'sequence' || !sourceObject.sourcePath) return false;
  if (!/\.(?:gb|gbk|genbank)$/iu.test(sourceObject.sourcePath)) return false;
  return pathCarriesStableId(
    sourceObject.sourcePath,
    sourceObject.stableId,
    path.extname(sourceObject.sourcePath)
  );
}

function pathCarriesStableId(entryPath: string, stableId: string, extension: string): boolean {
  const filename = path.posix.basename(entryPath);
  return filename.endsWith(`(${stableId})${extension}`);
}

export function hasVerifiedStrainLayout(text: string): boolean {
  return parseVerifiedStrain(text).ok;
}

function parseVerifiedStrain(
  text: string
):
  | { ok: true; displayName: string; fields: readonly BenchlingStrainField[] }
  | { ok: false; reason: string } {
  if (text.includes('\0')) return { ok: false, reason: 'Strain source contains a NUL byte.' };
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentLine === -1) return { ok: false, reason: 'Strain source has no display name.' };
  const displayName = lines[firstContentLine]?.trim() ?? '';
  const fields: BenchlingStrainField[] = [];
  for (let lineIndex = firstContentLine + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) {
      return { ok: false, reason: 'Strain source contains a non-field line.' };
    }
    const label = line.slice(0, separator).trim();
    if (label.length === 0) return { ok: false, reason: 'Strain source contains an empty label.' };
    const rawValue = line.slice(separator + 1);
    fields.push({
      label,
      value: rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue,
      position: fields.length,
    });
  }
  if (fields.length === 0) return { ok: false, reason: 'Strain source has no fields.' };
  const layoutHash = sha256(JSON.stringify(fields.map(({ label }) => label)));
  if (!VERIFIED_STRAIN_LAYOUT_HASHES.has(layoutHash)) {
    return { ok: false, reason: 'Strain source field layout is outside the audited family.' };
  }
  return { ok: true, displayName, fields };
}

type ZeroBaseParseResult =
  | { kind: 'ordinary' }
  | { kind: 'invalid_zero_base_candidate'; reason: string }
  | { kind: 'zero_base'; metadata: ZeroBaseGenBankMetadata };

function parseZeroBaseGenBank(text: string): ZeroBaseParseResult {
  const declaredLengthMatch = /^LOCUS\s+.*?\s+(\d+)\s+bp\b/imu.exec(text);
  if (!declaredLengthMatch || Number(declaredLengthMatch[1]) !== 0) return { kind: 'ordinary' };
  try {
    const parsed = parseGenBankFull(text);
    const origin = /^ORIGIN\s*$([\s\S]*?)^\/\/\s*$/imu.exec(text);
    if (!origin) {
      return { kind: 'invalid_zero_base_candidate', reason: 'Zero-base GenBank has no ORIGIN.' };
    }
    const originBases = origin[1]?.replace(/[\s\d]/gu, '') ?? '';
    if (parsed.sequence.length !== 0 || originBases.length !== 0) {
      return {
        kind: 'invalid_zero_base_candidate',
        reason: 'Zero-length GenBank contains sequence bases.',
      };
    }
    if (parsed.annotations.length !== 0 || zeroBaseGenBankHasFeatureBody(text)) {
      return {
        kind: 'invalid_zero_base_candidate',
        reason: 'Zero-base GenBank contains features.',
      };
    }
    return { kind: 'zero_base', metadata: zeroBaseMetadata(text, parsed) };
  } catch {
    return {
      kind: 'invalid_zero_base_candidate',
      reason: 'Zero-base GenBank did not pass the canonical parser.',
    };
  }
}

function zeroBaseGenBankHasFeatureBody(text: string): boolean {
  const match = /^FEATURES[^\n]*(?:\n|$)([\s\S]*?)^ORIGIN\s*$/imu.exec(text);
  if (!match) return false;
  return (match[1] ?? '').split(/\r?\n/gu).some((line) => line.trim().length > 0);
}

function zeroBaseMetadata(
  text: string,
  parsed: ReturnType<typeof parseGenBankFull>
): ZeroBaseGenBankMetadata {
  const fields = parseGenBankSourceFields(text);
  const locus = fields.find(({ label }) => label === 'LOCUS');
  if (!locus) throw new Error('Zero-base GenBank has no LOCUS field.');
  const locusDate = /\b\d{2}-[A-Z]{3}-\d{4}\b/u.exec(locus.value)?.[0];
  const moleculeType = /\bRNA\b/iu.test(locus.value) ? 'RNA' : 'DNA';
  const topology = /\bcircular\b/iu.test(locus.value) || parsed.circular ? 'circular' : 'linear';
  const firstValue = (label: string) => fields.find((field) => field.label === label)?.value;
  const keywordValue = firstValue('KEYWORDS');
  return {
    locus: {
      raw: locus.value,
      name: parsed.name,
      declaredLength: 0,
      moleculeType,
      topology,
      ...(locusDate ? { date: locusDate } : {}),
    },
    ...(firstValue('DEFINITION') !== undefined ? { definition: firstValue('DEFINITION') } : {}),
    ...(firstValue('ACCESSION') !== undefined ? { accession: firstValue('ACCESSION') } : {}),
    ...(firstValue('VERSION') !== undefined ? { version: firstValue('VERSION') } : {}),
    keywords:
      keywordValue === undefined || keywordValue === '.' || keywordValue.length === 0
        ? []
        : keywordValue
            .replace(/\.$/u, '')
            .split(';')
            .map((value) => value.trim())
            .filter(Boolean),
    ...(firstValue('SOURCE') !== undefined ? { source: firstValue('SOURCE') } : {}),
    comments: fields.filter(({ label }) => label === 'COMMENT').map(({ value }) => value),
    sourceFields: fields,
  };
}

function parseGenBankSourceFields(text: string): GenBankSourceField[] {
  const header = text.split(/^ORIGIN\s*$/imu, 1)[0] ?? '';
  const fields: Array<{ label: string; lines: string[] }> = [];
  for (const line of header.replace(/\r\n?/gu, '\n').split('\n')) {
    if (!line) continue;
    const label = line.slice(0, 12).trim();
    const value = line.slice(12);
    if (label.length > 0) {
      fields.push({ label, lines: [value.trimEnd()] });
      continue;
    }
    const current = fields.at(-1);
    if (current) current.lines.push(value.trimEnd());
  }
  return fields.map((field, position) => ({
    label: field.label,
    value: field.lines
      .map((line) => line.trimStart())
      .join(' ')
      .trimEnd(),
    position,
    lines: field.lines,
  }));
}

function destinationPrefix(sourceObject: SourceObject, objectClass: ProviderObjectClass): string {
  const content = sourceObject.content;
  if (
    normalizeSourceType(sourceObject.sourceType) === 'strain' ||
    (isRecord(content) && content.kind === 'benchling_strain')
  ) {
    return 'strain';
  }
  switch (objectClass) {
    case 'sequence':
      return 'sequence';
    case 'protein':
      return 'protein';
    case 'notebook':
      return 'notebook';
    case 'protocol':
      return 'protocol';
    case 'registry_entity':
    case 'other':
      return 'file';
  }
}

function normalizeSourceType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
