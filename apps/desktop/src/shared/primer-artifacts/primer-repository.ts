export function primerFromProjectionRow(row: DbPrimerRow): Primer {
  return {
    id: row.id,
    catalogNumber: row.catalog_number,
    name: row.name,
    sequence: row.sequence,
    length: row.length,
    tm: row.tm,
    gcPercent: row.gc_percent,
    origin: (row.origin as Primer['origin']) ?? 'manual',
    originDetails: row.origin_details ? JSON.parse(row.origin_details) : null,
    status: (row.status as Primer['status']) ?? 'designed',
    vendor: row.vendor,
    orderDate: row.order_date,
    application: row.application as Primer['application'],
    scale: row.scale,
    purification: row.purification,
    modifications: row.modifications,
    stockLocation: row.stock_location,
    concentration: row.concentration,
    notes: row.notes,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export async function readPrimerById(
  database: Pick<ArtifactIO['db'], 'select'>,
  id: string
): Promise<Primer | null> {
  const rows = await database.select<DbPrimerRow[]>('SELECT * FROM primers WHERE id = ? LIMIT 1', [
    id,
  ]);
  return rows[0] ? primerFromProjectionRow(rows[0]) : null;
}
import type { CatalogNumberAllocator } from '../artifact-operation-ports';
import type { ArtifactIO } from '../artifact-io';
import { calculateGcContent } from '../primer-thermodynamics/tm-calculator';
import type { PrimerTmCalculationService } from '../primer-tm-contract';
import { validatePrimerSequence } from './primer-validation';

import type { SqliteIpcValue } from '../sqlite-ipc';
import type {
  CreatePrimerInput,
  CreateBindingInput,
  UpdatePrimerInput,
  SearchPrimersInput,
  Primer,
  PrimerBinding,
  BoundPrimer,
  DbPrimerRow,
  DbBoundPrimerRow,
  DeleteResult,
  ImportBatchResult,
} from './types';
export interface PrimerRepositoryDependencies {
  database: Pick<ArtifactIO['db'], 'select' | 'execute'>;
  primerTmCalculationService: PrimerTmCalculationService;
  generateCatalogNumber: CatalogNumberAllocator;
}
export function createPrimerRepository(dependencies: PrimerRepositoryDependencies) {
  const { primerTmCalculationService, generateCatalogNumber } = dependencies;
  const UNVERIFIED_LEGACY_TM_MESSAGE =
    'Selected Tm provider could not verify this primer; no legacy row was written.';

  async function calculateVerifiedLegacyTm(sequence: string): Promise<number> {
    const result = await primerTmCalculationService.calculate(sequence);
    if (result.status === 'fallback') throw new Error(UNVERIFIED_LEGACY_TM_MESSAGE);
    return result.valueC;
  }

  function generateId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  async function _insertPrimerRow(
    db: Pick<ArtifactIO['db'], 'select' | 'execute'>,
    params: {
      id: string;
      catalogNumber: string;
      name: string;
      sequence: string;
      length: number;
      tm: number;
      gc: number;
      origin: string;
      originDetailsJson: string | null;
      application: string | null;
      notes: string | null;
      workspaceId: number | null;
      now: number;
    }
  ): Promise<void> {
    await db.execute(
      `INSERT INTO primers (id, catalog_number, name, sequence, length, tm, gc_percent,
      origin, origin_details, status, application, notes, workspace_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.id,
        params.catalogNumber,
        params.name,
        params.sequence,
        params.length,
        params.tm,
        params.gc,
        params.origin,
        params.originDetailsJson,
        'designed',
        params.application,
        params.notes,
        params.workspaceId,
        params.now,
        params.now,
      ]
    );
  }

  async function createPrimer(input: CreatePrimerInput): Promise<Primer> {
    const db = dependencies.database;

    const validation = validatePrimerSequence(input.sequence);
    if (!validation.valid) {
      throw new Error(
        `Invalid primer sequence: ${validation.errors?.map((e) => e.reason ?? `${e.char} at position ${e.position}`).join(', ')}`
      );
    }

    const sequence = validation.trimmed ?? input.sequence.trim();
    const length = sequence.length;
    const tm = await calculateVerifiedLegacyTm(sequence);
    const gc = calculateGcContent(sequence);
    const id = generateId();
    const catalogNumber = await generateCatalogNumber(input.workspaceId ?? 0);
    const now = Date.now();
    const origin = input.origin ?? 'manual';
    const originDetailsJson = input.originDetails ? JSON.stringify(input.originDetails) : null;
    const needsBinding = input.bindingSequenceId != null;

    const rowParams = {
      id,
      catalogNumber,
      name: input.name,
      sequence,
      length,
      tm,
      gc,
      origin,
      originDetailsJson,
      application: input.application ?? null,
      notes: input.notes ?? null,
      workspaceId: input.workspaceId ?? null,
      now,
    };

    if (needsBinding) {
      await db.execute('BEGIN TRANSACTION', []);
      try {
        await _insertPrimerRow(db, rowParams);
        await createBinding({
          primerId: id,
          sequenceId: input.bindingSequenceId!,
          bindingStart: input.bindingStart ?? 0,
          bindingEnd: input.bindingEnd ?? length,
          strand: input.bindingStrand ?? 1,
        });
        await db.execute('COMMIT', []);
      } catch (err) {
        await db.execute('ROLLBACK', []);
        throw err;
      }
    } else {
      await _insertPrimerRow(db, rowParams);
    }

    return {
      id,
      catalogNumber,
      name: input.name,
      sequence,
      length,
      tm,
      gcPercent: gc,
      origin,
      originDetails: input.originDetails ?? null,
      status: 'designed',
      vendor: null,
      orderDate: null,
      application: (input.application as Primer['application']) ?? null,
      scale: null,
      purification: null,
      modifications: null,
      stockLocation: null,
      concentration: null,
      notes: input.notes ?? null,
      workspaceId: input.workspaceId ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async function updatePrimer(input: UpdatePrimerInput): Promise<Primer | null> {
    const db = dependencies.database;

    const rows = await db.select<DbPrimerRow[]>(`SELECT * FROM primers WHERE id = ?`, [input.id]);
    if (rows.length === 0) return null;

    const existing = rows[0];
    if (
      existing.origin_details &&
      JSON.parse(existing.origin_details)?.authority === 'primer_artifact'
    )
      throw new Error('Open the primer file and save its changes there.');
    const now = Date.now();

    const sequenceChanged = input.sequence != null && input.sequence !== existing.sequence;
    let newSequence = input.sequence ?? existing.sequence;
    let newTm = existing.tm;
    let newGc = existing.gc_percent;
    let newLength = existing.length;

    if (sequenceChanged) {
      const validation = validatePrimerSequence(input.sequence!);
      if (!validation.valid) {
        throw new Error(`Invalid primer sequence`);
      }
      newSequence = validation.trimmed ?? input.sequence!;
      newTm = await calculateVerifiedLegacyTm(newSequence);
      newGc = calculateGcContent(newSequence);
      newLength = newSequence.length;
    }

    const updated = {
      name: input.name ?? existing.name,
      sequence: newSequence,
      length: newLength,
      tm: newTm,
      gc_percent: newGc,
      status: input.status ?? existing.status,
      vendor: input.vendor !== undefined ? input.vendor : existing.vendor,
      order_date: input.orderDate !== undefined ? input.orderDate : existing.order_date,
      application: input.application !== undefined ? input.application : existing.application,
      scale: input.scale !== undefined ? input.scale : existing.scale,
      purification: input.purification !== undefined ? input.purification : existing.purification,
      modifications:
        input.modifications !== undefined ? input.modifications : existing.modifications,
      stock_location:
        input.stockLocation !== undefined ? input.stockLocation : existing.stock_location,
      concentration:
        input.concentration !== undefined ? input.concentration : existing.concentration,
      notes: input.notes !== undefined ? input.notes : existing.notes,
    };

    await db.execute(
      `UPDATE primers SET name = ?, sequence = ?, length = ?, tm = ?, gc_percent = ?,
      status = ?, vendor = ?, order_date = ?, application = ?,
      scale = ?, purification = ?, modifications = ?, stock_location = ?, concentration = ?,
      notes = ?, updated_at = ? WHERE id = ?`,
      [
        updated.name,
        updated.sequence,
        updated.length,
        updated.tm,
        updated.gc_percent,
        updated.status,
        updated.vendor,
        updated.order_date,
        updated.application,
        updated.scale,
        updated.purification,
        updated.modifications,
        updated.stock_location,
        updated.concentration,
        updated.notes,
        now,
        input.id,
      ]
    );

    return {
      ...primerFromProjectionRow(existing),
      name: updated.name,
      sequence: updated.sequence,
      length: updated.length,
      tm: updated.tm,
      gcPercent: updated.gc_percent,
      status: updated.status as Primer['status'],
      vendor: updated.vendor,
      orderDate: updated.order_date,
      application: updated.application as Primer['application'],
      scale: updated.scale,
      purification: updated.purification,
      modifications: updated.modifications,
      stockLocation: updated.stock_location,
      concentration: updated.concentration,
      notes: updated.notes,
      updatedAt: now,
    };
  }

  async function deletePrimer(id: string): Promise<DeleteResult> {
    const db = dependencies.database;
    const rows = await db.select<DbPrimerRow[]>('SELECT * FROM primers WHERE id = ?', [id]);
    if (
      rows[0]?.origin_details &&
      JSON.parse(rows[0].origin_details)?.authority === 'primer_artifact'
    )
      throw new Error('Delete the primer file from its project to retain its history.');
    const result = await db.execute(`DELETE FROM primers WHERE id = ?`, [id]);

    if (result.changes === 0) {
      return { deleted: false, reason: 'not_found' };
    }
    return { deleted: true };
  }

  async function searchPrimers(input: SearchPrimersInput): Promise<Primer[]> {
    const db = dependencies.database;
    const conditions: string[] = [];
    const params: SqliteIpcValue[] = [];

    if (input.query) {
      conditions.push(`(name LIKE ? OR sequence LIKE ?)`);
      params.push(`%${input.query}%`, `%${input.query}%`);
    }
    if (input.status) {
      conditions.push(`status = ?`);
      params.push(input.status);
    }
    if (input.application) {
      conditions.push(`application = ?`);
      params.push(input.application);
    }

    let sql = `SELECT * FROM primers`;
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    sql += ` ORDER BY created_at DESC`;

    if (input.limit != null) {
      sql += ` LIMIT ? OFFSET ?`;
      params.push(input.limit, input.offset ?? 0);
    }

    const rows = await db.select<DbPrimerRow[]>(sql, params);
    return rows.map(primerFromProjectionRow);
  }

  async function getPrimerById(id: string): Promise<Primer | null> {
    return readPrimerById(dependencies.database, id);
  }

  async function createBinding(input: CreateBindingInput): Promise<PrimerBinding> {
    const db = dependencies.database;
    const id = generateId();
    const now = Date.now();
    const source = input.source ?? 'manual';

    await db.execute(
      `INSERT INTO primer_bindings (id, primer_id, sequence_id, binding_start, binding_end, strand, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.primerId,
        input.sequenceId,
        input.bindingStart,
        input.bindingEnd,
        input.strand,
        source,
        now,
        now,
      ]
    );

    return {
      id,
      primerId: input.primerId,
      sequenceId: input.sequenceId,
      bindingStart: input.bindingStart,
      bindingEnd: input.bindingEnd,
      strand: input.strand,
      source,
      createdAt: now,
      updatedAt: now,
    };
  }

  async function persistOwnedPrimerBinding(
    input: CreateBindingInput & { bindingId: string }
  ): Promise<PrimerBinding> {
    const now = Date.now();
    const result = await dependencies.database.execute(
      `INSERT INTO primer_bindings
       (id, primer_id, sequence_id, binding_start, binding_end, strand, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         binding_start = excluded.binding_start, binding_end = excluded.binding_end,
         strand = excluded.strand, updated_at = excluded.updated_at
       WHERE primer_bindings.primer_id = excluded.primer_id
         AND primer_bindings.sequence_id = excluded.sequence_id`,
      [
        input.bindingId,
        input.primerId,
        input.sequenceId,
        input.bindingStart,
        input.bindingEnd,
        input.strand,
        now,
        now,
      ]
    );
    if (result.changes !== 1) {
      throw new Error('The copied primer binding ID belongs to another attachment.');
    }
    const rows = await dependencies.database.select<
      {
        id: string;
        primer_id: string;
        sequence_id: number;
        binding_start: number;
        binding_end: number;
        strand: number;
        source: string;
        created_at: number;
        updated_at: number;
      }[]
    >('SELECT * FROM primer_bindings WHERE id = ?', [input.bindingId]);
    const row = rows[0];
    if (!row) throw new Error('The copied primer attachment was not persisted.');
    return {
      id: row.id,
      primerId: row.primer_id,
      sequenceId: row.sequence_id,
      bindingStart: row.binding_start,
      bindingEnd: row.binding_end,
      strand: row.strand,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async function listBoundPrimers(sequenceId: number): Promise<BoundPrimer[]> {
    const db = dependencies.database;
    const rows = await db.select<DbBoundPrimerRow[]>(
      `SELECT p.*, pb.id as binding_id, pb.binding_start, pb.binding_end,
            pb.strand, pb.source, pb.created_at as binding_created_at,
            pb.updated_at as binding_updated_at
     FROM primer_bindings pb
     JOIN primers p ON pb.primer_id = p.id
     WHERE pb.sequence_id = ?
     ORDER BY pb.binding_start`,
      [sequenceId]
    );
    return rows.map((row) => ({
      ...primerFromProjectionRow(row),
      binding: {
        id: row.binding_id,
        primerId: row.id,
        sequenceId,
        bindingStart: row.binding_start,
        bindingEnd: row.binding_end,
        strand: row.strand,
        source: row.source,
        createdAt: row.binding_created_at,
        updatedAt: row.binding_updated_at,
      },
    }));
  }

  async function importBatch(primers: CreatePrimerInput[]): Promise<ImportBatchResult> {
    const tmConcurrency = 4;
    const db = dependencies.database;
    const errors: Array<{ index: number; reason: string }> = [];
    let imported = 0;
    let duplicates = 0;
    const seenSequences = new Set<string>();

    type ValidatedImport = {
      index: number;
      primer: CreatePrimerInput;
      sequence: string;
    };
    type PreparedImport = ValidatedImport & {
      tm: number;
    };
    type TmOutcome =
      | { ok: true; item: PreparedImport }
      | { ok: false; index: number; reason: string };

    const validated: ValidatedImport[] = [];
    for (let i = 0; i < primers.length; i++) {
      const primer = primers[i];
      const validation = validatePrimerSequence(primer.sequence);
      if (!validation.valid) {
        errors.push({
          index: i,
          reason: `invalid sequence: ${validation.errors?.map((e) => e.reason ?? e.char).join(', ')}`,
        });
        continue;
      }

      const normalizedSeq = primer.sequence.trim().toUpperCase();
      if (seenSequences.has(normalizedSeq)) {
        duplicates++;
        continue;
      }
      seenSequences.add(normalizedSeq);

      const sequence = validation.trimmed ?? primer.sequence.trim();
      validated.push({ index: i, primer, sequence });
    }

    if (validated.length === 0) return { imported, errors, duplicates };

    const calculator = primerTmCalculationService.createCalculator({
      onProviderError: (error) =>
        console.warn('[primer-import] Selected Tm provider unavailable.', error),
    });
    const outcomes = new Array<TmOutcome>(validated.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < validated.length) {
        const outcomeIndex = nextIndex++;
        const item = validated[outcomeIndex];
        try {
          const result = await calculator.compute(item.sequence);
          if (result.pendingNebVerification) {
            throw new Error(UNVERIFIED_LEGACY_TM_MESSAGE);
          }
          outcomes[outcomeIndex] = { ok: true, item: { ...item, tm: result.tm } };
        } catch (error) {
          outcomes[outcomeIndex] = {
            ok: false,
            index: item.index,
            reason: error instanceof Error ? error.message : 'Tm calculation failed',
          };
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(tmConcurrency, validated.length) }, () => worker())
    );

    const prepared: PreparedImport[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) prepared.push(outcome.item);
      else errors.push({ index: outcome.index, reason: outcome.reason });
    }
    errors.sort((left, right) => left.index - right.index);

    if (prepared.length === 0) return { imported, errors, duplicates };

    await db.execute('BEGIN TRANSACTION', []);
    try {
      for (const item of prepared) {
        try {
          const id = generateId();
          const catNum = await generateCatalogNumber(item.primer.workspaceId ?? 0);
          const now = Date.now();
          await _insertPrimerRow(db, {
            id,
            catalogNumber: catNum,
            name: item.primer.name,
            sequence: item.sequence,
            length: item.sequence.length,
            tm: item.tm,
            gc: calculateGcContent(item.sequence),
            origin: item.primer.origin ?? 'manual',
            originDetailsJson: item.primer.originDetails
              ? JSON.stringify(item.primer.originDetails)
              : null,
            application: item.primer.application ?? null,
            notes: item.primer.notes ?? null,
            workspaceId: item.primer.workspaceId ?? null,
            now,
          });
          imported++;
        } catch (error) {
          errors.push({
            index: item.index,
            reason: error instanceof Error ? error.message : 'unknown error',
          });
        }
      }
      await db.execute('COMMIT', []);
    } catch (err) {
      await db.execute('ROLLBACK', []);
      throw err;
    }

    errors.sort((left, right) => left.index - right.index);
    return { imported, errors, duplicates };
  }
  return {
    createPrimer,
    updatePrimer,
    deletePrimer,
    searchPrimers,
    getPrimerById,
    createBinding,
    persistOwnedPrimerBinding,
    listBoundPrimers,
    importBatch,
  };
}
