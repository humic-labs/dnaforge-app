import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import type { MVSNode } from 'molstar/lib/extensions/mvs/tree/mvs/mvs-tree';
import { Task } from 'molstar/lib/mol-task';
import { binaryCoordinateBytes } from './binary-coordinates';
import {
  assertMolViewSpecSnapshotIndex,
  MolViewSpecSceneError,
  molViewSpecPrimaryResourceName,
  validateMolViewSpecScene,
} from './mol-view-spec-scene';
import {
  MOLECULAR_DOCUMENT_MAX_BYTES,
  parseMolecularDocument,
  validateMolecularDocumentCoordinates,
  type MolecularDocument,
} from './molecular-document';
import type { MolecularView } from './molecular-view';

type Coordinates = MolecularView['coordinates'];
type ModelSelection = { blockIndex?: number; blockHeader?: string; modelIndex?: number };

async function openCoordinateSource(coordinates: Coordinates) {
  if (coordinates.format === 'pdb') {
    const source = await parsePDB(coordinates.text).run();
    if (source.isError) throw new Error(source.message);
    const trajectory = await trajectoryFromPDB(source.result).run();
    return async (selection?: ModelSelection) => {
      if (selection?.blockIndex || selection?.blockHeader)
        throw new Error('PDB coordinates have one data block.');
      return { trajectory, modelIndex: selection?.modelIndex ?? 0 };
    };
  }
  const source = await (
    coordinates.format === 'bcif'
      ? CIF.parseBinary(binaryCoordinateBytes(coordinates.text))
      : CIF.parseText(coordinates.text)
  ).run();
  if (source.isError) throw new Error(source.message);
  const blocks = source.result.blocks;
  const trajectories = new Map<(typeof blocks)[number], ReturnType<typeof readCifTrajectory>>();
  async function readCifTrajectory(block: (typeof blocks)[number]) {
    return trajectoryFromMmCIF(block).run();
  }
  return async (selection?: ModelSelection) => {
    const block = selection?.blockHeader
      ? blocks.find(({ header }) => header === selection.blockHeader)
      : blocks[selection?.blockIndex ?? 0];
    if (!block) throw new Error('The requested coordinate data block is missing.');
    if (!trajectories.has(block)) trajectories.set(block, readCifTrajectory(block));
    const trajectory = await trajectories.get(block)!;
    return { trajectory, modelIndex: selection?.modelIndex ?? 0 };
  };
}

export async function readMolecularDocumentContent(
  bytes: string,
  byteLength = new TextEncoder().encode(bytes).byteLength
): Promise<MolecularDocument> {
  if (byteLength > MOLECULAR_DOCUMENT_MAX_BYTES)
    throw new Error('The molecular document exceeds the file size limit.');
  const document = parseMolecularDocument(bytes);
  await validateMolecularDocumentForOpen(document);
  return document;
}

export async function validateMolecularDocumentForOpen(document: MolecularDocument): Promise<void> {
  await validateMolecularDocumentCoordinates(document);
  const sources = new Map<string, ReturnType<typeof openCoordinateSource>>();
  async function verifyModel(coordinates: Coordinates, choice?: ModelSelection) {
    const key = `${coordinates.format}:${coordinates.sha256}`;
    try {
      if (!sources.has(key)) sources.set(key, openCoordinateSource(coordinates));
      const read = await sources.get(key)!;
      const { trajectory, modelIndex } = await read(choice);
      if (modelIndex < 0 || modelIndex >= trajectory.frameCount)
        throw new Error('The requested coordinate model is missing.');
      const frame = trajectory.getFrameAtIndex(modelIndex);
      const model = Task.is(frame) ? await frame.run() : frame;
      if (!model?.atomicHierarchy.atoms._rowCount)
        throw new Error('The requested model has no atomic structure.');
    } catch (error) {
      throw new MolViewSpecSceneError(
        'MVS_INVALID_COORDINATES',
        `The saved coordinates could not be loaded. ${error instanceof Error ? error.message : ''}`.trim()
      );
    }
  }
  for (const { snapshot } of document.history) {
    const names = new Map([
      [molViewSpecPrimaryResourceName(snapshot.coordinates.format), snapshot.coordinates],
    ]);
    for (const asset of snapshot.version === 2 ? snapshot.pinnedAssets : []) {
      if (names.has(asset.name) || !asset.name.endsWith(`.${asset.format}`))
        throw new MolViewSpecSceneError('MVS_UNSUPPORTED_RESOURCE', 'Invalid pinned asset name.');
      names.set(asset.name, asset);
    }
    const scene = validateMolViewSpecScene(snapshot.scene, [...names.keys()]);
    assertMolViewSpecSnapshotIndex(scene, snapshot.initialSnapshotIndex ?? 0);
    await verifyModel(snapshot.coordinates);
    async function checkScene(node: MVSNode, source?: Coordinates): Promise<boolean> {
      let hasModel = false;
      if (node.kind === 'download') source = names.get(node.params.url);
      if (
        node.kind === 'parse' &&
        source &&
        node.params.format !== (source.format === 'cif' ? 'mmcif' : source.format)
      )
        throw new MolViewSpecSceneError(
          'MVS_UNSUPPORTED_RESOURCE',
          'The saved scene requests a different format from its pinned coordinates.'
        );
      if (node.kind === 'structure' && source) {
        await verifyModel(source, {
          blockIndex: node.params.block_index,
          blockHeader: node.params.block_header ?? undefined,
          modelIndex: node.params.model_index,
        });
        hasModel = true;
      }
      if ('children' in node)
        for (const child of node.children ?? []) {
          if (await checkScene(child, source)) hasModel = true;
        }
      return hasModel;
    }
    const roots =
      scene.kind === 'multiple' ? scene.snapshots.map((view) => view.root) : [scene.root];
    for (const root of roots) {
      if (!(await checkScene(root)))
        throw new MolViewSpecSceneError(
          'MVS_INVALID_SCENE',
          'The saved view has no structure to show.'
        );
    }
  }
}
