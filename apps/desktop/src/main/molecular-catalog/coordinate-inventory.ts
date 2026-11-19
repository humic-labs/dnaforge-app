import { SOFT_WARN_BYTES } from '../../shared/oversized-guard';
import { createHash } from 'node:crypto';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { MmcifFormat, trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import type { Model } from 'molstar/lib/mol-model/structure';
import { Column } from 'molstar/lib/mol-data/db';
import { Task } from 'molstar/lib/mol-task';
import { encodedResidueIdentity, readEncodedPolymerEntity } from '../../shared/encoded-polymer';
import { mapChainResiduesToExpectedSequence } from '../../shared/polymer-residue-mapping';
import {
  canonicalEncodedMolecule,
  type EncodedMolecule,
  type SubmittedEncodedMolecule,
} from '../../shared/encoded-molecule';
import {
  MOLECULAR_CATALOG_MAX_COORDINATE_BYTES,
  MOLECULAR_CATALOG_NORMALIZER_VERSION,
  type MolecularCatalogChain,
  type MolecularCatalogFormat,
  type MolecularCatalogInventory,
  type MolecularCatalogMapping,
} from '../../shared/molecular-catalog';

export interface CoordinateInventoryRequest {
  bytes: Uint8Array;
  purpose?: 'document-preview';
  format: MolecularCatalogFormat;
  molecules?: EncodedMolecule[];
  submitted?: SubmittedEncodedMolecule[];
}
export interface CoordinateInventoryResult {
  inventory: MolecularCatalogInventory;
  mappings: MolecularCatalogMapping[];
}

export async function parseCoordinateInventory(
  request: CoordinateInventoryRequest
): Promise<CoordinateInventoryResult> {
  const { bytes, format } = request;
  const byteLimit =
    request.purpose === 'document-preview'
      ? SOFT_WARN_BYTES
      : MOLECULAR_CATALOG_MAX_COORDINATE_BYTES;
  if (!bytes.byteLength || bytes.byteLength > byteLimit)
    throw new Error(
      `Coordinate bytes are empty or exceed the ${byteLimit / (1024 * 1024)} MiB limit.`
    );
  const text = format === 'bcif' ? null : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const trajectories = [];
  if (format === 'pdb') {
    const parsed = await parsePDB(text!).run();
    if (parsed.isError) throw new Error(parsed.message);
    trajectories.push(await trajectoryFromPDB(parsed.result).run());
  } else {
    const parsed = await (format === 'bcif' ? CIF.parseBinary(bytes) : CIF.parseText(text!)).run();
    if (parsed.isError) throw new Error(parsed.message);
    if (parsed.result.blocks.length > 256)
      throw new Error('The coordinate file has too many data blocks.');
    for (const block of parsed.result.blocks)
      trajectories.push(await trajectoryFromMmCIF(block).run());
  }
  const pdbDeclared = new Map<string, number>();
  if (format === 'pdb') {
    for (const line of text!.split(/\r?\n/)) {
      if (!line.startsWith('SEQRES')) continue;
      const chain = line.slice(11, 12).trim();
      const count = Number(line.slice(13, 17).trim());
      if (
        !Number.isInteger(count) ||
        count < 1 ||
        (pdbDeclared.has(chain) && pdbDeclared.get(chain) !== count)
      )
        throw new Error('The PDB declares inconsistent chain sequence lengths.');
      pdbDeclared.set(chain, count);
    }
  }
  const chains: MolecularCatalogChain[] = [];
  let modelCount = 0;
  let atomCount = 0;
  for (let blockIndex = 0; blockIndex < trajectories.length; blockIndex++) {
    const trajectory = trajectories[blockIndex];
    modelCount += trajectory.frameCount;
    if (modelCount > 256) throw new Error('The coordinate file has too many source models.');
    for (let modelIndex = 0; modelIndex < trajectory.frameCount; modelIndex++) {
      const frame = trajectory.getFrameAtIndex(modelIndex);
      const model = Task.is(frame) ? await frame.run() : frame;
      atomCount += model.atomicHierarchy.atoms._rowCount;
      const inventory = modelChains(model, blockIndex, modelIndex, format, pdbDeclared);
      chains.push(...inventory);
      if (chains.length > 10_000)
        throw new Error('The coordinate file has too many source chains.');
    }
  }
  if (!modelCount || !atomCount)
    throw new Error('The coordinate file contains no atomic structure.');
  if (request.submitted) verifySubmittedCopies(chains, request.submitted);
  const mappings: MolecularCatalogMapping[] = [];
  const requested = (request.molecules ?? []).map(canonicalEncodedMolecule);
  for (const chain of chains) {
    const molecules = new Map<string, EncodedMolecule>();
    for (const molecule of requested) molecules.set(JSON.stringify(molecule), molecule);
    if (
      chain.sequenceEvidence === 'declared' &&
      !chain.unresolved.length &&
      (chain.kind === 'protein' || chain.kind === 'rna' || chain.kind === 'dna') &&
      chain.sequence
    ) {
      const molecule = canonicalEncodedMolecule({ kind: chain.kind, sequence: chain.sequence });
      molecules.set(JSON.stringify(molecule), molecule);
    }
    for (const molecule of request.submitted ?? []) {
      if (chain.kind !== molecule.kind || chain.sequence !== molecule.sequence) continue;
      const identity = canonicalEncodedMolecule(molecule);
      molecules.set(JSON.stringify(identity), identity);
    }
    for (const molecule of molecules.values()) {
      if (chain.kind !== molecule.kind) continue;
      const verifiedRun = Boolean(
        request.submitted?.some(
          (item) => item.kind === molecule.kind && item.sequence === molecule.sequence
        )
      );
      mappings.push(mapMoleculeToChain(chain, molecule, verifiedRun));
    }
  }
  return {
    inventory: {
      version: MOLECULAR_CATALOG_NORMALIZER_VERSION,
      coordinateSha256: createHash('sha256').update(bytes).digest('hex'),
      byteCount: bytes.byteLength,
      blockCount: trajectories.length,
      modelCount,
      chains,
    },
    mappings,
  };
}

function modelChains(
  model: Model,
  blockIndex: number,
  modelIndex: number,
  format: MolecularCatalogFormat,
  pdbDeclared: ReadonlyMap<string, number>
): MolecularCatalogChain[] {
  const hierarchy = model.atomicHierarchy;
  const sources = new Map<
    string,
    { label: string; author: string; entity: string; index: number | null }
  >();
  for (let index = 0; index < hierarchy.chains._rowCount; index++) {
    const label = hierarchy.chains.label_asym_id.value(index);
    const author = hierarchy.chains.auth_asym_id.value(index);
    const entity = hierarchy.chains.label_entity_id.value(index);

    const key = format === 'pdb' ? JSON.stringify([label, author, entity]) : label;
    if (sources.has(key)) throw new Error('Source chain labels are ambiguous within one model.');
    sources.set(key, {
      label,
      author,
      entity,
      index,
    });
  }
  if (format !== 'pdb' && MmcifFormat.is(model.sourceData)) {
    const declared = model.sourceData.data.db.struct_asym;
    for (let row = 0; row < declared._rowCount; row++) {
      const label = declared.id.value(row);
      if (!sources.has(label))
        sources.set(label, {
          label,
          author: '',
          entity: declared.entity_id.value(row),
          index: null,
        });
    }
  }
  return Array.from(sources.values(), (source) => {
    const encoded = readEncodedPolymerEntity(model, source.label, source.entity);
    const entityIndex = model.entities.getEntityIndex(source.entity);
    const nonPolymer =
      entityIndex >= 0 && model.entities.data.type.value(entityIndex) !== 'polymer';
    let declared = false;
    if (format === 'pdb')
      declared = Boolean(encoded && pdbDeclared.get(source.author) === encoded.sequence.length);
    else if (MmcifFormat.is(model.sourceData)) {
      const table = model.sourceData.data.db.entity_poly_seq;
      const positions = new Set<number>();
      for (let row = 0; row < table._rowCount; row++)
        if (table.entity_id.value(row) === source.entity) positions.add(table.num.value(row));
      declared = Boolean(
        encoded && positions.size === encoded.sequence.length && positions.size > 0
      );
    }
    const observedResidues: MolecularCatalogChain['observedResidues'] = [];
    if (source.index !== null) {
      const start = hierarchy.chainAtomSegments.offsets[source.index];
      const end = hierarchy.chainAtomSegments.offsets[source.index + 1];
      const firstResidue = hierarchy.residueAtomSegments.index[start];
      const lastResidue = hierarchy.residueAtomSegments.index[end - 1];
      for (let residue = firstResidue; residue <= lastResidue; residue++) {
        const from = hierarchy.residueAtomSegments.offsets[residue];
        const to = hierarchy.residueAtomSegments.offsets[residue + 1];
        const componentIds = new Set<string>();
        for (let atom = from; atom < to; atom++)
          componentIds.add(hierarchy.atoms.label_comp_id.value(atom));
        const labelSequenceId =
          hierarchy.residues.label_seq_id.valueKind(residue) === Column.ValueKind.Present
            ? hierarchy.residues.label_seq_id.value(residue)
            : null;
        const authorSequenceId =
          hierarchy.residues.auth_seq_id.valueKind(residue) === Column.ValueKind.Present
            ? hierarchy.residues.auth_seq_id.value(residue)
            : null;
        const identities = Array.from(componentIds, (component) =>
          encodedResidueIdentity(model, source.label, labelSequenceId ?? -1, component)
        );
        const first = identities[0];
        const code =
          first &&
          !first.unresolved &&
          identities.every(
            (identity) =>
              identity &&
              !identity.unresolved &&
              identity.code === first.code &&
              identity.category === first.category
          )
            ? first.code
            : null;
        const insertion = hierarchy.residues.pdbx_PDB_ins_code.value(residue);
        observedResidues.push({
          labelSequenceId,
          authorSequenceId,
          insertionCode: insertion === '.' || insertion === '?' ? '' : insertion,
          componentIds: Array.from(componentIds).sort(),
          encodedCode: code,
          atomCount: to - from,
        });
      }
    }
    const unresolved = [...(encoded?.unresolved ?? [])];
    if (encoded && !nonPolymer) {
      const positions = new Map(encoded.positions.map((position, index) => [position, index]));
      for (const residue of observedResidues) {
        const index =
          residue.labelSequenceId === null ? undefined : positions.get(residue.labelSequenceId);
        if (index === undefined || unresolved.some((item) => item.sequenceIndex === index))
          continue;
        if (!residue.encodedCode || residue.encodedCode !== encoded.sequence[index])
          unresolved.push({
            sequenceIndex: index,
            components: residue.componentIds,
            reason: residue.encodedCode
              ? 'Physical components contradict the declared encoded sequence.'
              : 'Physical components have no unambiguous encoded parent.',
          });
      }
    }
    return {
      key: JSON.stringify([blockIndex, modelIndex, source.label, source.author, source.entity]),
      blockIndex,
      modelIndex,
      modelNumber: model.modelNum,
      labelAsymId: source.label,
      authAsymId: source.author,
      entityId: source.entity,
      kind: nonPolymer ? 'non-polymer' : (encoded?.kind ?? 'unknown'),
      sequence: encoded?.sequence ?? null,
      sequenceEvidence: nonPolymer
        ? 'non-polymer'
        : !encoded || unresolved.length
          ? 'unresolved'
          : declared
            ? 'declared'
            : 'observed-only',
      sequencePositions: encoded?.positions ?? [],
      declaredComponents: encoded?.components ?? [],
      unresolved,
      observedResidues,
    };
  });
}

function verifySubmittedCopies(
  chains: MolecularCatalogChain[],
  submitted: SubmittedEncodedMolecule[]
): void {
  const models = new Map<string, MolecularCatalogChain[]>();
  for (const chain of chains) {
    const key = `${chain.blockIndex}:${chain.modelIndex}`;
    const current = models.get(key) ?? [];
    current.push(chain);
    models.set(key, current);
  }
  for (const model of models.values()) {
    const claimed = new Set<string>();
    for (const molecule of submitted) {
      const matching = model.filter(
        (chain) =>
          chain.kind === molecule.kind &&
          chain.sequence === molecule.sequence &&
          !chain.unresolved.length &&
          chain.observedResidues.length > 0
      );
      if (molecule.chainIds) {
        for (const id of molecule.chainIds) {
          const copies = matching.filter(
            (chain) => chain.labelAsymId === id || chain.authAsymId === id
          );
          if (copies.length !== 1 || claimed.has(copies[0].key))
            throw new Error(`The prediction is missing or ambiguously maps submitted chain ${id}.`);
          claimed.add(copies[0].key);
        }
      } else {
        const available = matching.find((chain) => !claimed.has(chain.key));
        if (!available)
          throw new Error('The prediction is missing a submitted encoded molecule copy.');
        claimed.add(available.key);
      }
    }
    if (model.some((chain) => chain.kind !== 'non-polymer' && !claimed.has(chain.key)))
      throw new Error(
        'The prediction contains polymer copies which were not submitted in this run.'
      );
  }
}

function mapMoleculeToChain(
  chain: MolecularCatalogChain,
  molecule: EncodedMolecule,
  verifiedRun: boolean
): MolecularCatalogMapping {
  const base = { molecule, chainKey: chain.key, sequenceLength: molecule.sequence.length };
  if (
    chain.sequence === molecule.sequence &&
    !chain.unresolved.length &&
    (chain.sequenceEvidence === 'declared' || verifiedRun)
  ) {
    const positions = new Map(
      chain.sequencePositions.map((position, index) => [position, index + 1])
    );
    const residues = chain.observedResidues.flatMap((residue, observedResidueIndex) => {
      const sequencePosition =
        residue.labelSequenceId === null ? undefined : positions.get(residue.labelSequenceId);
      return sequencePosition === undefined ? [] : [{ sequencePosition, observedResidueIndex }];
    });
    const mappedCount = new Set(residues.map((residue) => residue.sequencePosition)).size;
    return {
      ...base,
      relationship: 'exact',
      status: mappedCount ? 'mapped' : 'unavailable',
      method: 'encoded-identity-v1',
      residues,
      mappedCount,
      matchCount: mappedCount,
      mismatchCount: 0,
      ...(mappedCount ? {} : { unavailableReason: 'no-coordinates' }),
    };
  }
  if (chain.observedResidues.length * molecule.sequence.length > 4_000_000)
    return {
      ...base,
      relationship: 'unresolved',
      status: 'unavailable',
      method: 'sequence-alignment',
      residues: [],
      mappedCount: 0,
      matchCount: 0,
      mismatchCount: 0,
      unavailableReason: 'too-large',
    };
  const coordinateChain = {
    sequence: chain.observedResidues
      .map((residue) => residue.encodedCode ?? (molecule.kind === 'protein' ? 'X' : 'N'))
      .join(''),
    residues: chain.observedResidues.map((residue, index) => ({
      position: residue.authorSequenceId ?? residue.labelSequenceId ?? index + 1,
      ...(residue.labelSequenceId === null ? {} : { labelSeqId: residue.labelSequenceId }),
      name: residue.encodedCode ?? '',
      name3: residue.componentIds[0] ?? '',
    })),
  };
  const mapped = mapChainResiduesToExpectedSequence(coordinateChain, molecule.sequence);
  if (mapped.status === 'unavailable')
    return {
      ...base,
      relationship: 'unresolved',
      status: 'unavailable',
      method: 'sequence-alignment',
      residues: [],
      mappedCount: 0,
      matchCount: 0,
      mismatchCount: 0,
      unavailableReason: mapped.reason,
    };
  const residues = mapped.residues.flatMap((entry) => {
    const observedResidueIndex = coordinateChain.residues.findIndex(
      (residue) => residue.position === entry.position && residue.labelSeqId === entry.labelSeqId
    );
    return observedResidueIndex < 0
      ? []
      : [{ sequencePosition: entry.residueIndex + 1, observedResidueIndex }];
  });
  return {
    ...base,
    relationship: mapped.mismatchCount ? 'homolog' : 'partial',
    status: residues.length ? 'mapped' : 'unavailable',
    method: mapped.method,
    residues,
    mappedCount: mapped.mappedCount,
    matchCount: mapped.matchCount,
    mismatchCount: mapped.mismatchCount,
    ...(residues.length ? {} : { unavailableReason: 'no-coordinates' }),
  };
}
