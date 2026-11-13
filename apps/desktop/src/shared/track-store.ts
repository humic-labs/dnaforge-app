import { z } from 'zod';

export const TRACK_META_SCHEMA = 'dnaforge.track-meta.v1' as const;
export const TRACK_CURRENT_SCHEMA = 'dnaforge.track-current.v1' as const;
export const TRACK_STORE_DIRECTORY = 'tracks' as const;
export const TRACK_META_FILE = 'meta.json' as const;
export const TRACK_CURRENT_FILE = 'current.json' as const;

export const TRACK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const ASSEMBLY_ACCESSION_PATTERN = /^[A-Za-z]{1,6}_?[A-Za-z]{0,4}[0-9]+\.[0-9]+$/;
export const TRACK_VERSION_PATTERN = /^[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])$/i;

export type TrackSlugProblem = 'empty' | 'pattern' | 'reserved-name';

export function trackSlugProblem(value: string): TrackSlugProblem | null {
  if (value.length === 0) return 'empty';
  if (!TRACK_SLUG_PATTERN.test(value)) return 'pattern';
  if (WINDOWS_RESERVED_NAME.test(value)) return 'reserved-name';
  return null;
}

export function describeTrackSlugProblem(problem: TrackSlugProblem): string {
  switch (problem) {
    case 'empty':
      return 'A track name is required.';
    case 'pattern':
      return 'A track name uses lowercase letters, digits and hyphens, starts with a letter or digit, and is at most 48 characters.';
    case 'reserved-name':
      return 'That name is reserved by Windows and cannot be a directory.';
  }
}

const trackSlug = z.string().refine((value) => trackSlugProblem(value) === null, {
  message: 'invalid track name',
});

const residencySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('managed') }),
  z.object({ kind: z.literal('linked'), path: z.string().min(1) }),
  z.object({ kind: z.literal('remote'), url: z.string().url() }),
]);

export const TRACK_FILE_FORMATS = ['gff3', 'bed', 'bigwig', 'bam'] as const;
export type TrackFileFormat = (typeof TRACK_FILE_FORMATS)[number];

const provenanceInputSchema = z.object({
  url: z.string().optional(),
  path: z.string().optional(),
  sha256: z.string().regex(SHA256_PATTERN).optional(),
  bytes: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
});

const trackMetaSchema = z.object({
  schema: z.literal(TRACK_META_SCHEMA),
  track: trackSlug,
  version: z.string().regex(TRACK_VERSION_PATTERN),
  assembly: z.object({
    accession: z.string().regex(ASSEMBLY_ACCESSION_PATTERN),
    lengthBp: z.number().int().positive(),
    aliases: z.array(z.string().min(1)).optional(),
  }),
  file: z.object({
    name: z.string().min(1),
    format: z.enum(TRACK_FILE_FORMATS),
    sha256: z.string().regex(SHA256_PATTERN),
    byteLength: z.number().int().nonnegative(),
  }),
  residency: residencySchema,
  kinds: z.array(z.string().min(1)).min(1),
  label: z.string().min(1),
  evidence: z.string().min(1),
  license: z.object({
    spdx: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    attribution: z.string().min(1),
    evidenceUrl: z.string().optional(),
    note: z.string().optional(),
  }),
  citation: z.string().optional(),
  url: z.string().optional(),
  doi: z.string().optional(),
  datasetVersion: z.string().optional(),
  liftedFrom: z.string().optional(),
  provenance: z
    .object({
      producedBy: z
        .object({
          tool: z.string().min(1),
          version: z.string().optional(),
          command: z.string().optional(),
        })
        .optional(),
      inputs: z.array(provenanceInputSchema).optional(),
      derivedFrom: z.array(z.string().min(1)).optional(),
      notes: z.array(z.string()).optional(),
    })
    .optional(),
});

const trackCurrentSchema = z.object({
  schema: z.literal(TRACK_CURRENT_SCHEMA),
  version: z.string().regex(TRACK_VERSION_PATTERN),
  selectedAt: z.string().datetime({ offset: true }).optional(),
  reason: z.string().max(500).optional(),
});

export type TrackMeta = z.infer<typeof trackMetaSchema>;
export type TrackCurrent = z.infer<typeof trackCurrentSchema>;
export type TrackResidency = z.infer<typeof residencySchema>;

export function parseTrackMeta(value: unknown): TrackMeta {
  return trackMetaSchema.parse(value);
}

export function parseTrackCurrent(value: unknown): TrackCurrent {
  return trackCurrentSchema.parse(value);
}

export interface TrackRef {
  readonly accession: string;
  readonly track: string;
  readonly version?: string;
}

export interface TrackListing {
  readonly accession: string;
  readonly track: string;
  readonly current: TrackCurrent | null;
  readonly meta: TrackMeta | null;
  readonly versions: readonly string[];
  readonly problems: readonly string[];
}

export interface TrackFileText {
  readonly meta: TrackMeta;
  readonly path: string;
  readonly text: string;
}

export interface TrackStoreBridge {
  root(): Promise<string>;
  listAssemblies(): Promise<readonly string[]>;
  listTracks(accession: string): Promise<readonly TrackListing[]>;
  readMeta(ref: TrackRef): Promise<TrackMeta>;
  readTrackFile(ref: TrackRef): Promise<TrackFileText>;
  refresh(): Promise<{ seeded: number }>;
}
