import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { canonicalJson } from '../../shared/canonical-json';
import {
  freezeComputeRequest,
  providerReportedComputeRequestSchema,
} from '../../shared/compute-request';
import {
  canonicalEncodedMolecule,
  encodedMoleculeIdentityPayload,
  submittedEncodedMolecules,
} from '../../shared/encoded-molecule';
import {
  molecularCatalogListSchema,
  molecularCatalogRegisterSchema,
  MOLECULAR_CATALOG_MAX_COORDINATE_BYTES,
  MOLECULAR_CATALOG_NORMALIZER_VERSION,
  type MolecularCatalogAPI,
  type MolecularCatalogChain,
  type MolecularCatalogFormat,
  type MolecularCatalogLoaded,
  type MolecularCatalogMapping,
  type MolecularCatalogMatch,
  type MolecularCatalogObservation,
  type MolecularCatalogRegisterInput,
  type MolecularCatalogPredictionRequest,
  type MolecularCatalogRequestEvidence,
} from '../../shared/molecular-catalog';
import type { ComputeJobRegistry } from '../compute/jobs';
import { canonicalWorkspacePath } from '../primer-artifact-files';
import {
  MOLECULAR_DOCUMENT_SUFFIX,
  MOLECULAR_DOCUMENT_MAX_BYTES,
  getCurrentMolecularSnapshot,
  parseMolecularDocument,
} from '../../shared/molecular-document';
import { inventoryCoordinatesInWorker } from './inventory-worker';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const moleculeId = (value: MolecularCatalogMapping['molecule']) =>
  digest(encodedMoleculeIdentityPayload(value));
const chainId = (coordinateId: string, key: string) =>
  digest(JSON.stringify([coordinateId, MOLECULAR_CATALOG_NORMALIZER_VERSION, key]));
interface CoordinateRow {
  id: string;
  format: MolecularCatalogFormat;
  sha256: string;
  byte_count: number;
  bytes: Buffer;
  inventory_counts_json: string;
}
interface ObservationRow {
  id: string;
  coordinate_id: string;
  source_kind: MolecularCatalogObservation['sourceKind'];
  label: string;
  origin_json: string;
  run_json: string | null;
  metrics_json: string;
  provenance_json: string;
  created_at: number;
  format: MolecularCatalogFormat;
  sha256: string;
  byte_count: number;
}

export class MolecularCatalogService implements MolecularCatalogAPI {
  constructor(
    private readonly db: () => Database.Database,
    private readonly jobs: ComputeJobRegistry
  ) {}

  async register(raw: MolecularCatalogRegisterInput): Promise<MolecularCatalogMatch> {
    const input = molecularCatalogRegisterSchema.parse(raw);
    if (!this.db().prepare('SELECT 1 FROM workspaces WHERE path = ?').get(input.workspaceRoot))
      throw new Error('Register the coordinate file from an open workspace.');
    const path = await canonicalWorkspacePath({
      workspaceRoot: input.workspaceRoot,
      path: resolve(input.workspaceRoot, input.filePath),
      artifactNoun: 'coordinate',
    });
    const extension = extname(path.candidate).toLowerCase();
    const packaged = path.candidate.toLowerCase().endsWith(MOLECULAR_DOCUMENT_SUFFIX);
    const declaredFormat =
      input.format ??
      (extension === '.pdb'
        ? 'pdb'
        : extension === '.bcif'
          ? 'bcif'
          : ['.cif', '.mmcif'].includes(extension)
            ? 'cif'
            : null);
    if (!declaredFormat && !packaged)
      throw new Error('Specify pdb, cif, or bcif for this coordinate file.');
    const handle = await open(path.candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    let generation: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
    try {
      generation = await handle.stat();
      const maxBytes = packaged
        ? MOLECULAR_DOCUMENT_MAX_BYTES
        : MOLECULAR_CATALOG_MAX_COORDINATE_BYTES;
      if (!generation.size || generation.size > maxBytes)
        throw new Error(
          packaged
            ? 'Molecular documents must be between 1 byte and 128 MiB.'
            : 'Coordinate files must be between 1 byte and 64 MiB.'
        );

      bytes = Buffer.alloc(generation.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) throw new Error('Coordinate file changed during its read.');
        offset += read.bytesRead;
      }
      assertGeneration(generation, await handle.stat());
    } finally {
      await handle.close();
    }
    const coordinates = packaged
      ? getCurrentMolecularSnapshot(parseMolecularDocument(bytes.toString('utf8'))).coordinates
      : null;
    if (coordinates)
      bytes = Buffer.from(coordinates.text, coordinates.format === 'bcif' ? 'base64' : 'utf8');
    const format = coordinates?.format ?? declaredFormat;
    if (!format) throw new Error('Specify pdb, cif, or bcif for this coordinate file.');
    const sha256 = digest(bytes);
    const coordinateId = digest(JSON.stringify(['coordinate-v1', format, sha256]));
    let run: MolecularCatalogObservation['run'] = null;
    let metrics: Record<string, unknown> = {};
    let provenance: Record<string, string> = {};
    let predictionRequest: MolecularCatalogPredictionRequest | undefined;
    let submitted;
    if (input.source.kind === 'prediction') {
      const verified = await this.jobs.readCompletedResult(input.source.jobRecordId);
      const { job, result } = verified;
      if (job.workspaceRoot !== input.workspaceRoot)
        throw new Error('The output file does not belong to this compute run workspace.');
      const outputKey = input.source.outputKey;
      const outputs = result.files.filter(
        (file) =>
          (!outputKey || file.name === outputKey) &&
          typeof file.content === 'string' &&
          digest(Buffer.from(file.content, 'utf8')) === sha256
      );
      if (outputs.length !== 1)
        throw new Error('These coordinate bytes do not uniquely match the provider result.');
      submitted = submittedEncodedMolecules(job.settings);
      if (job.provider === 'boltz' && !Array.isArray(job.settings.entities))
        submitted = submitted.map((item) => ({ ...item, chainIds: item.chainIds ?? ['A'] }));
      run = {
        jobRecordId: job.id,
        provider: job.provider,
        remoteId: job.remoteId!,
        toolId: job.toolId,
        settingsHash: job.settingsHash,
        settingsDigest: digest(canonicalJson(job.settings)),
        settings: job.settings,
        createdAt: job.createdAt,
        outputKey: outputs[0].name,
      };
      metrics = result.metrics ?? {};
      provenance = result.provenance;
      if (verified.request && result.provider_request != null) {
        predictionRequest = {
          client: verified.request,
          provider: providerReportedComputeRequestSchema.parse(result.provider_request),
        };
      }
    }
    const parsed = await inventoryCoordinatesInWorker({
      bytes,
      format,
      molecules: input.molecules,
      submitted,
    });
    if (parsed.inventory.coordinateSha256 !== sha256)
      throw new Error('Coordinate inventory does not match the original bytes.');
    assertGeneration(generation!, await stat(path.candidate));
    const origin = {
      workspaceRoot: input.workspaceRoot,
      filePath: path.candidate,
      ...(input.source.kind === 'import' && input.source.uri ? { uri: input.source.uri } : {}),
    };
    const sourceKey = run
      ? canonicalJson(['prediction', run.jobRecordId, run.outputKey])
      : canonicalJson(['import', origin.workspaceRoot, origin.filePath, coordinateId]);
    const id = digest(sourceKey);
    const now = Date.now();
    const database = this.db();
    database.transaction(() => {
      const prior = database
        .prepare(
          'SELECT coordinate_id, run_json FROM molecular_catalog_observations WHERE source_key = ?'
        )
        .get(sourceKey) as { coordinate_id: string; run_json: string | null } | undefined;
      if (
        prior &&
        (prior.coordinate_id !== coordinateId ||
          prior.run_json !== (run ? canonicalJson(run) : null))
      )
        throw new Error(
          'This result changed after registration. The original observation is preserved.'
        );
      const existing = database
        .prepare('SELECT bytes FROM molecular_catalog_coordinates WHERE id = ?')
        .get(coordinateId) as { bytes: Buffer } | undefined;
      if (existing && !existing.bytes.equals(bytes))
        throw new Error('Coordinate digest collision or storage corruption.');
      const { blockCount, modelCount } = parsed.inventory;
      database
        .prepare(
          'INSERT OR IGNORE INTO molecular_catalog_coordinates (id,format,sha256,byte_count,bytes,inventory_counts_json,created_at) VALUES (?,?,?,?,?,?,?)'
        )
        .run(
          coordinateId,
          format,
          sha256,
          bytes.length,
          bytes,
          canonicalJson({ blockCount, modelCount }),
          now
        );
      database
        .prepare(
          'INSERT OR IGNORE INTO molecular_catalog_observations (id,coordinate_id,source_key,source_kind,label,origin_json,run_json,metrics_json,provenance_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          id,
          coordinateId,
          sourceKey,
          run ? 'prediction' : 'import',
          input.label ?? basename(path.candidate),
          canonicalJson(origin),
          run ? canonicalJson(run) : null,
          canonicalJson(metrics),
          canonicalJson(provenance),
          now
        );
      if (predictionRequest) {
        const receiptJson = canonicalJson(predictionRequest);
        const priorReceipt = database
          .prepare(
            'SELECT receipt_json FROM molecular_catalog_prediction_requests WHERE observation_id = ?'
          )
          .get(id) as { receipt_json: string } | undefined;
        if (priorReceipt && priorReceipt.receipt_json !== receiptJson)
          throw new Error(
            'The provider request evidence changed. The original receipt is preserved.'
          );
        database
          .prepare(
            'INSERT OR IGNORE INTO molecular_catalog_prediction_requests (observation_id,client_sha256,provider_sha256,model,model_version,receipt_json,created_at) VALUES (?,?,?,?,?,?,?)'
          )
          .run(
            id,
            digest(canonicalJson(predictionRequest.client)),
            digest(canonicalJson(predictionRequest.provider)),
            predictionRequest.provider.model,
            predictionRequest.provider.version,
            receiptJson,
            now
          );
      }
      for (const chain of parsed.inventory.chains) {
        const key = chainId(coordinateId, chain.key);
        const encoded = canonicalJson(chain);
        const old = database
          .prepare('SELECT inventory_json FROM molecular_catalog_chains WHERE id = ?')
          .get(key) as { inventory_json: string } | undefined;
        if (old && old.inventory_json !== encoded)
          throw new Error('The coordinate inventory changed without a normalizer version change.');
        database
          .prepare(
            'INSERT OR IGNORE INTO molecular_catalog_chains (id,coordinate_id,normalizer_version,chain_key,inventory_json) VALUES (?,?,?,?,?)'
          )
          .run(key, coordinateId, MOLECULAR_CATALOG_NORMALIZER_VERSION, chain.key, encoded);
      }
      for (const mapping of parsed.mappings) {
        const molecule = canonicalEncodedMolecule(mapping.molecule);
        const identity = moleculeId(molecule);
        const key = chainId(coordinateId, mapping.chainKey);
        const encoded = canonicalJson(mapping);
        database
          .prepare(
            'INSERT OR IGNORE INTO molecular_catalog_molecules (id,identity_version,kind,sequence,created_at) VALUES (?,1,?,?,?)'
          )
          .run(identity, molecule.kind, molecule.sequence, now);
        const old = database
          .prepare(
            'SELECT mapping_json FROM molecular_catalog_mappings WHERE observation_id = ? AND molecule_id = ? AND chain_id = ? AND algorithm_version = 1'
          )
          .get(id, identity, key) as { mapping_json: string } | undefined;
        if (old && old.mapping_json !== encoded)
          throw new Error('This mapping changed without an algorithm version change.');
        database
          .prepare(
            'INSERT OR IGNORE INTO molecular_catalog_mappings (observation_id,molecule_id,chain_id,algorithm_version,relationship,status,mapping_json) VALUES (?,?,?,1,?,?,?)'
          )
          .run(id, identity, key, mapping.relationship, mapping.status, encoded);
      }
    })();
    return this.match(
      id,
      input.molecules?.length === 1 ? moleculeId(input.molecules[0]) : undefined
    );
  }

  async list(raw: Parameters<MolecularCatalogAPI['list']>[0]): Promise<MolecularCatalogMatch[]> {
    const input = molecularCatalogListSchema.parse(raw);
    const identity = input.molecule ? moleculeId(input.molecule) : undefined;
    const filters: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.observationId) {
      filters.push('o.id = ?');
      parameters.push(input.observationId);
    }
    if (identity) {
      filters.push(
        'EXISTS (SELECT 1 FROM molecular_catalog_mappings m WHERE m.observation_id = o.id AND m.molecule_id = ?)'
      );
      parameters.push(identity);
    }
    if (input.jobRecordId) {
      filters.push("json_extract(o.run_json, '$.jobRecordId') = ?");
      parameters.push(input.jobRecordId);
    }
    for (const [value, column] of [
      [input.requestHash, 'client_sha256'],
      [input.providerRequestHash, 'provider_sha256'],
    ] as const) {
      if (value) {
        filters.push(
          `EXISTS (SELECT 1 FROM molecular_catalog_prediction_requests r WHERE r.observation_id = o.id AND r.${column} = ?)`
        );
        parameters.push(value);
      }
    }
    const rows = this.db()
      .prepare(
        `SELECT o.id FROM molecular_catalog_observations o
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY o.created_at DESC, o.id LIMIT ?`
      )
      .all(...parameters, input.limit) as { id: string }[];
    return rows.map((row) => this.match(row.id, identity));
  }

  async load(id: string): Promise<MolecularCatalogLoaded> {
    const observation = this.observation(id);
    const coordinates = this.db()
      .prepare('SELECT * FROM molecular_catalog_coordinates WHERE id = ?')
      .get(observation.coordinateId) as CoordinateRow;
    if (
      coordinates.bytes.length !== coordinates.byte_count ||
      digest(coordinates.bytes) !== coordinates.sha256
    )
      throw new Error('The saved coordinate bytes failed their integrity check.');
    const chains = this.chains(observation.coordinateId);
    const mappings = this.db()
      .prepare(
        'SELECT mapping_json FROM molecular_catalog_mappings WHERE observation_id = ? AND algorithm_version = 1'
      )
      .all(id) as { mapping_json: string }[];
    return {
      observation,
      bytes: new Uint8Array(coordinates.bytes),
      inventory: {
        version: MOLECULAR_CATALOG_NORMALIZER_VERSION,
        coordinateSha256: coordinates.sha256,
        byteCount: coordinates.byte_count,
        ...JSON.parse(coordinates.inventory_counts_json),
        chains,
      },
      mappings: mappings.map((row) => JSON.parse(row.mapping_json) as MolecularCatalogMapping),
      ...(observation.requestEvidence
        ? { predictionRequest: this.predictionRequest(id, observation.requestEvidence) }
        : {}),
    };
  }

  private observation(id: string): MolecularCatalogObservation {
    const row = this.db()
      .prepare(
        `SELECT o.*, c.format, c.sha256, c.byte_count FROM molecular_catalog_observations o
      JOIN molecular_catalog_coordinates c ON c.id = o.coordinate_id WHERE o.id = ?`
      )
      .get(id) as ObservationRow | undefined;
    if (!row) throw new Error('This saved structure observation was not found.');
    const receipt = this.db()
      .prepare(
        'SELECT client_sha256, provider_sha256, model, model_version FROM molecular_catalog_prediction_requests WHERE observation_id = ?'
      )
      .get(id) as
      | { client_sha256: string; provider_sha256: string; model: string; model_version: string }
      | undefined;
    return {
      id: row.id,
      coordinateId: row.coordinate_id,
      coordinateSha256: row.sha256,
      byteCount: row.byte_count,
      format: row.format,
      sourceKind: row.source_kind,
      label: row.label,
      origin: JSON.parse(row.origin_json),
      run: row.run_json ? JSON.parse(row.run_json) : null,
      metrics: JSON.parse(row.metrics_json),
      provenance: JSON.parse(row.provenance_json),
      ...(receipt
        ? {
            requestEvidence: {
              clientSha256: receipt.client_sha256,
              providerSha256: receipt.provider_sha256,
              model: receipt.model,
              version: receipt.model_version,
            },
          }
        : {}),
      createdAt: row.created_at,
    };
  }

  private predictionRequest(
    id: string,
    evidence: MolecularCatalogRequestEvidence
  ): MolecularCatalogPredictionRequest {
    const row = this.db()
      .prepare(
        'SELECT receipt_json FROM molecular_catalog_prediction_requests WHERE observation_id = ?'
      )
      .get(id) as { receipt_json: string };
    const raw = JSON.parse(row.receipt_json) as MolecularCatalogPredictionRequest;
    const client = freezeComputeRequest(
      raw.client.provider,
      raw.client.toolId,
      raw.client.settings,
      raw.client.files
    );
    const provider = providerReportedComputeRequestSchema.parse(raw.provider);
    if (
      raw.client.schemaVersion !== 1 ||
      digest(canonicalJson(client)) !== evidence.clientSha256 ||
      digest(canonicalJson(provider)) !== evidence.providerSha256 ||
      provider.model !== evidence.model ||
      provider.version !== evidence.version
    )
      throw new Error('The retained prediction request failed its integrity check.');
    return { client, provider };
  }

  private chains(coordinateId: string): MolecularCatalogChain[] {
    return (
      this.db()
        .prepare(
          'SELECT inventory_json FROM molecular_catalog_chains WHERE coordinate_id = ? AND normalizer_version = ? ORDER BY chain_key'
        )
        .all(coordinateId, MOLECULAR_CATALOG_NORMALIZER_VERSION) as { inventory_json: string }[]
    ).map((row) => JSON.parse(row.inventory_json) as MolecularCatalogChain);
  }

  private match(id: string, identity?: string): MolecularCatalogMatch {
    const observation = this.observation(id);
    const run = observation.run
      ? (({ settings: _settings, ...summary }) => summary)(observation.run)
      : null;
    const rows = this.db()
      .prepare(
        `SELECT ch.chain_key, m.mapping_json FROM molecular_catalog_mappings m
      JOIN molecular_catalog_chains ch ON ch.id = m.chain_id WHERE m.observation_id = ? AND m.algorithm_version = 1 ${identity ? 'AND m.molecule_id = ?' : ''}`
      )
      .all(...(identity ? [id, identity] : [id])) as { chain_key: string; mapping_json: string }[];
    const mappings = new Map(
      rows.map((row) => [row.chain_key, JSON.parse(row.mapping_json) as MolecularCatalogMapping])
    );
    return {
      observation: { ...observation, run },
      chains: this.chains(observation.coordinateId)
        .filter((chain) => !identity || mappings.has(chain.key))
        .map((chain) => {
          const mapping = mappings.get(chain.key);
          return {
            key: chain.key,
            blockIndex: chain.blockIndex,
            modelIndex: chain.modelIndex,
            modelNumber: chain.modelNumber,
            labelAsymId: chain.labelAsymId,
            authAsymId: chain.authAsymId,
            entityId: chain.entityId,
            kind: chain.kind,
            sequenceEvidence: chain.sequenceEvidence,
            sequenceLength: chain.sequence?.length ?? 0,
            observedResidueCount: chain.observedResidues.length,
            unresolvedCount: chain.unresolved.length,
            relationship: mapping?.relationship ?? null,
            mappedCount: mapping?.mappedCount ?? 0,
            matchCount: mapping?.matchCount ?? 0,
            mismatchCount: mapping?.mismatchCount ?? 0,
          };
        }),
    };
  }
}

function assertGeneration(
  before: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  after: typeof before
): void {
  if (
    ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(
      (key) => before[key as keyof typeof before] !== after[key as keyof typeof after]
    )
  )
    throw new Error('The coordinate file changed while it was being registered.');
}
