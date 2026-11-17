import { parseGenBankFull } from '@waypoint/sequence-utils';
import { describe, expect, it } from 'vitest';
import type {
  PackageScratchLease,
  PackageScratchLeaseSet,
} from '../../shared/package-scratch-capability';
import {
  createDefaultSequenceEntityMetadata,
  fromPackageRelative,
  parseSequencePackageDocument,
} from '../../db/sequence-package';
import type { DesignRegion, SequenceDesign } from '../design/types';
import {
  buildAcceptedAssemblyProjectionInput,
  buildAcceptedAssemblyValidationSnapshot,
  buildSourceProvenanceSnapshot,
} from './accepted-canonical';
import {
  isMatchingExistingSequencePackageProduct,
  prepareAcceptedAssemblyFiles,
  resolveAcceptedAssemblyWritePaths,
  writeAcceptedAssemblyFiles,
} from './accepted-writer';

describe('accepted assembly writer', () => {
  it('serializes the accepted product as GenBank and keeps construction metadata in the sidecar', async () => {
    const design = createDesign();
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: design.regions.map((region) =>
        buildSourceProvenanceSnapshot(region, {
          sourceSequenceChecksum: `sha256:${region.id}`,
        })
      ),
    });
    const validationSnapshot = buildAcceptedAssemblyValidationSnapshot({
      designId: design.id,
      designVersion: design.version,
      assemblyMethod: design.assemblyMethod,
      projectionInputChecksum: projectionInput.canonicalDraftChecksum,
      validatedAt: '2026-05-17T01:00:00.000Z',
    });

    const files = await prepareAcceptedAssemblyFiles({
      projectionInput,
      validationSnapshot,
      writeTarget: {
        workspaceFolderId: 'main',
        relativeDirectory: 'assemblies',
        basename: 'accepted-construct',
      },
      workspaceFolders: {
        main: { path: '/workspace/project', name: 'Project' },
      },
      acceptedAt: '2026-05-17T01:01:00.000Z',
      acceptedBy: 'test-user',
      acceptedVersionId: 'accepted-1',
    });

    const root = '/workspace/project/assemblies/accepted-construct';
    expect(files.packageRoot).toBe(root);
    expect(files.productGenBankPath).toBe(`${root}/accepted-construct.gb`);
    expect(files.metaPath).toBe(`${root}/.forge/plasmid.json`);
    expect(files.primerCsvPath).toBe(`${root}/contents/accepted-construct.accepted-1.primers.csv`);
    expect(files.primerFastaPath).toBe(
      `${root}/contents/accepted-construct.accepted-1.primers.fasta`
    );
    expect(files.primerCsvContent).toContain('"left forward","AAAATGC"');
    expect(files.primerFastaContent).toContain('>left forward');
    expect(files.primerFastaContent).toContain('AAAATGC');
    expect(files.productSequenceChecksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(files.primerCsvChecksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(files.primerFastaChecksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(files.sidecarChecksum).toMatch(/^sha256:[a-f0-9]{64}$/);

    const parsedProduct = parseGenBankFull(files.productGenBankContent);
    expect(parsedProduct.sequence.toUpperCase()).toBe(projectionInput.productSequence);
    expect(parsedProduct.circular).toBe(true);
    expect(parsedProduct.annotations).toContainEqual(
      expect.objectContaining({
        name: 'left CDS',
        type: 'CDS',
        start: 1,
        end: 4,
        direction: 1,
      })
    );
    expect(parsedProduct.annotations).toContainEqual(
      expect.objectContaining({
        name: 'right CDS',
        type: 'CDS',
        start: 18,
        end: 21,
        direction: -1,
      })
    );
    expect(parsedProduct.annotations).toContainEqual(
      expect.objectContaining({
        name: 'Spacer spacer-1',
        type: 'misc_feature',
        start: 13,
        end: 15,
      })
    );
    expect(
      parsedProduct.annotations.some(
        (annotation) =>
          annotation.type === 'source_segment' || Boolean(annotation.qualifiers?.assembly_region_id)
      )
    ).toBe(false);

    const packageDoc = JSON.parse(files.sidecarJsonContent);
    expect(packageDoc).toMatchObject({
      schema: 'waypoint.sequence.v1',
      kind: 'sequence',
      name: 'Accepted Construct',
      product: { file: 'accepted-construct.gb', topology: 'circular' },
    });
    expect(packageDoc.id).toBe('construct-1');
    expect(packageDoc.entity).toMatchObject({
      registrationStatus: 'registered',
      fields: {},
    });

    const sidecar = packageDoc.assembly.accepted;
    expect(sidecar).toMatchObject({
      type: 'accepted_assembly',
      schemaVersion: 1,
      acceptedAssemblyVersionId: 'accepted-1',
      lifecycleState: 'written',
      acceptedAt: '2026-05-17T01:01:00.000Z',
      acceptedBy: 'test-user',
      designId: 'design-1',
      construction: {
        method: 'gibson',
        canonicalDraftChecksum: projectionInput.canonicalDraftChecksum,
      },
      validationSnapshot: {
        projectionInputChecksum: projectionInput.canonicalDraftChecksum,
        clean: true,
      },
      artifacts: {
        productGenBankPath: 'accepted-construct.gb',
        sidecarJsonPath: '.forge/plasmid.json',
        primerCsvPath: 'contents/accepted-construct.accepted-1.primers.csv',
        primerFastaPath: 'contents/accepted-construct.accepted-1.primers.fasta',
        primerCsvChecksum: files.primerCsvChecksum,
        primerFastaChecksum: files.primerFastaChecksum,
      },
    });
    expect(files.sidecarJsonContent).not.toContain('/workspace/project');
    expect(sidecar.construction.optimizationFingerprint).toBe(
      projectionInput.optimizationFingerprint
    );
    expect(sidecar.projectionInput.sourceProvenance).toHaveLength(2);
    expect(sidecar.projectionInput.sourceProvenance[0]).toMatchObject({
      regionId: 'left',
      sourceSequenceChecksum: 'sha256:left',
    });
  });

  it('prepares identical managed annotation bytes for an unchanged annotated assembly', async () => {
    const design = createDesign();
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: design.regions.map((region) =>
        buildSourceProvenanceSnapshot(region, { sourceSequenceChecksum: 'sha256:' + region.id })
      ),
    });
    const validationSnapshot = buildAcceptedAssemblyValidationSnapshot({
      designId: design.id,
      designVersion: design.version,
      assemblyMethod: design.assemblyMethod,
      projectionInputChecksum: projectionInput.canonicalDraftChecksum,
      validatedAt: '2026-05-17T01:00:00.000Z',
    });
    const params = {
      projectionInput,
      validationSnapshot,
      writeTarget: {
        workspaceFolderId: 'main',
        relativeDirectory: 'assemblies',
        basename: 'stable',
      },
      workspaceFolders: { main: { path: '/workspace/project', name: 'Project' } },
      productDate: new Date(2026, 4, 17, 12),
    };
    const preview = await prepareAcceptedAssemblyFiles(params);
    const apply = await prepareAcceptedAssemblyFiles(params);
    expect(parseGenBankFull(preview.productGenBankContent).annotations.length).toBeGreaterThan(0);
    expect(preview.productGenBankContent.split('\n')[0]).toContain('17-MAY-2026');
    expect(apply.productGenBankContent).toBe(preview.productGenBankContent);
    expect(apply.productGenBankChecksum).toBe(preview.productGenBankChecksum);
    const changed = await prepareAcceptedAssemblyFiles({
      ...params,
      projectionInput: {
        ...projectionInput,
        productSequence: projectionInput.productSequence.replace('A', 'T'),
      },
    });
    expect(changed.productGenBankChecksum).not.toBe(preview.productGenBankChecksum);
    const otherConstruct = await prepareAcceptedAssemblyFiles({
      ...params,
      packageId: 'other-construct',
    });
    expect(otherConstruct.productGenBankChecksum).not.toBe(preview.productGenBankChecksum);
  });

  it('rejects write targets that escape the selected project folder', () => {
    const workspaceFolders = { main: { path: '/workspace/project', name: 'Project' } };
    expect(() =>
      resolveAcceptedAssemblyWritePaths(
        {
          workspaceFolderId: 'main',
          relativeDirectory: '../outside',
          basename: 'construct',
        },
        workspaceFolders
      )
    ).toThrow(/relativeDirectory/i);
    expect(() =>
      resolveAcceptedAssemblyWritePaths(
        {
          workspaceFolderId: 'main',
          relativeDirectory: 'assemblies',
          basename: '../construct',
        },
        workspaceFolders
      )
    ).toThrow(/basename/i);
    expect(() =>
      resolveAcceptedAssemblyWritePaths(
        {
          workspaceFolderId: 'missing',
          relativeDirectory: 'assemblies',
          basename: 'construct',
        },
        workspaceFolders
      )
    ).toThrow(/project folder/i);
  });

  it('serializes origin-wrapping accepted CDS continuations into the finalized GenBank', async () => {
    const design = createOriginWrappingReverseContinuationDesign();
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: design.regions.map((region) => buildSourceProvenanceSnapshot(region)),
    });
    const files = await prepareAcceptedAssemblyFiles({
      projectionInput,
      validationSnapshot: buildAcceptedAssemblyValidationSnapshot({
        designId: design.id,
        designVersion: design.version,
        assemblyMethod: design.assemblyMethod,
        projectionInputChecksum: projectionInput.canonicalDraftChecksum,
      }),
      writeTarget: {
        workspaceFolderId: 'main',
        relativeDirectory: 'assemblies',
        basename: 'origin-wrap-construct',
      },
      workspaceFolders: {
        main: { path: '/workspace/project', name: 'Project' },
      },
    });

    expect(files.productGenBankContent).toContain('complement(join(1..6,13..15))');
    expect(files.productGenBankContent).not.toContain('_locationString');

    const parsedProduct = parseGenBankFull(files.productGenBankContent);
    expect(parsedProduct.annotations).toContainEqual(
      expect.objectContaining({
        name: 'origin reverse CDS (predicted continuation)',
        type: 'CDS',
        start: 13,
        end: 6,
        direction: -1,
        segments: [
          { start: 13, end: 15 },
          { start: 1, end: 6 },
        ],
      })
    );
  });

  it('mints a package from an absolute GenBank save path', () => {
    const paths = resolveAcceptedAssemblyWritePaths(
      {
        absoluteProductPath: '/custom/output/My construct.gbk',
        overwrite: true,
      },
      {}
    );

    expect(paths).toMatchObject({
      packageRoot: '/custom/output/My-construct',
      productGenBankPath: '/custom/output/My-construct/My-construct.gbk',
      metaPath: '/custom/output/My-construct/.forge/plasmid.json',
      primerCsvPath: '/custom/output/My-construct/contents/My-construct.primers.csv',
      primerFastaPath: '/custom/output/My-construct/contents/My-construct.primers.fasta',
      basename: 'My-construct',
      overwrite: true,
    });
  });

  it('preserves .gbff when minting a package from an absolute save path', () => {
    const paths = resolveAcceptedAssemblyWritePaths(
      {
        absoluteProductPath: '/custom/output/Chromosome IV.gbff',
        overwrite: true,
      },
      {}
    );

    expect(paths).toMatchObject({
      packageRoot: '/custom/output/Chromosome-IV',
      productGenBankPath: '/custom/output/Chromosome-IV/Chromosome-IV.gbff',
      metaPath: '/custom/output/Chromosome-IV/.forge/plasmid.json',
      basename: 'Chromosome-IV',
    });
  });

  it('refuses to clobber an existing package, and stages the whole package before swapping', async () => {
    const design = createDesign();
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: design.regions.map((region) => buildSourceProvenanceSnapshot(region)),
    });
    const files = await prepareAcceptedAssemblyFiles({
      projectionInput,
      validationSnapshot: buildAcceptedAssemblyValidationSnapshot({
        designId: design.id,
        designVersion: design.version,
        assemblyMethod: design.assemblyMethod,
        projectionInputChecksum: projectionInput.canonicalDraftChecksum,
      }),
      writeTarget: {
        workspaceFolderId: 'main',
        relativeDirectory: 'assemblies',
        basename: 'accepted-construct',
      },
      workspaceFolders: {
        main: { path: '/workspace/project', name: 'Project' },
      },
    });

    await expect(
      writeAcceptedAssemblyFiles(files, {
        exists: async (path) => path === files.packageRoot,
        mkdir: async () => {},
        writeTextFile: async () => {},
        rename: async () => {},
      })
    ).rejects.toThrow(/already exists/i);

    const calls: string[] = [];
    await writeAcceptedAssemblyFiles(
      { ...files, overwrite: true },
      {
        exists: async () => false,
        mkdir: async (path) => calls.push(`mkdir:${path}`),
        writeTextFile: async (path, content) => calls.push(`write:${path}:${content.length}`),
        rename: async (from, to) => calls.push(`rename:${from}->${to}`),
      }
    );

    const writes = calls.filter((call) => call.startsWith('write:'));
    expect(writes).toHaveLength(5);
    expect(writes.every((call) => call.includes('.staging-'))).toBe(true);
    const swaps = calls.filter((call) => call.endsWith(`->${files.packageRoot}`));
    expect(swaps).toHaveLength(1);
    expect(swaps[0]).toContain('.staging-');
  });

  it('publishes into an existing workspace root without mutating the root', async () => {
    const design = createDesign();
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: design.regions.map((region) => buildSourceProvenanceSnapshot(region)),
    });
    const projectRoot = '/workspace/project';
    const projectFile = `${projectRoot}/existing.gb`;
    const files = await prepareAcceptedAssemblyFiles({
      projectionInput,
      validationSnapshot: buildAcceptedAssemblyValidationSnapshot({
        designId: design.id,
        designVersion: design.version,
        assemblyMethod: design.assemblyMethod,
        projectionInputChecksum: projectionInput.canonicalDraftChecksum,
      }),
      writeTarget: {
        workspaceFolderId: 'main',
        relativeDirectory: '',
        basename: 'accepted-construct',
      },
      workspaceFolders: { main: { path: projectRoot, name: 'Project' } },
    });
    const disk = virtualPackageDisk({ [projectFile]: 'existing content' });

    await writeAcceptedAssemblyFiles(files, {
      ...disk.ops,
      mkdir: async (path, options) => {
        if (path === projectRoot) throw new Error('PROJECT_FILESYSTEM_AUTHORITY_REQUIRED');
        await disk.ops.mkdir(path, options);
      },
    });

    expect(disk.read(files.productGenBankPath)).toBe(files.productGenBankContent);
    expect(disk.read(files.metaPath)).toBe(files.sidecarJsonContent);
    expect(disk.read(projectFile)).toBe('existing content');
    expect(disk.paths().some((path) => /\.(staging|previous)-/.test(path))).toBe(false);
  });

  it('leaves nothing behind when staging itself fails', async () => {
    const design = createDesign();
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: design.regions.map((region) => buildSourceProvenanceSnapshot(region)),
    });
    const files = await prepareAcceptedAssemblyFiles({
      projectionInput,
      validationSnapshot: buildAcceptedAssemblyValidationSnapshot({
        designId: design.id,
        designVersion: design.version,
        assemblyMethod: design.assemblyMethod,
        projectionInputChecksum: projectionInput.canonicalDraftChecksum,
      }),
      writeTarget: {
        workspaceFolderId: 'main',
        relativeDirectory: 'assemblies',
        basename: 'retryable-construct',
      },
      workspaceFolders: { main: { path: '/workspace/project', name: 'Project' } },
    });

    const renamed: Array<[string, string]> = [];
    const removed: string[] = [];
    const scratch: PackageScratchLeaseSet = {
      staging: {
        path: '/workspace/project/assemblies/.retryable-construct.staging-test',
        cleanupToken: 'staging-token',
      },
      previous: {
        path: '/workspace/project/assemblies/.retryable-construct.previous-test',
        cleanupToken: 'previous-token',
      },
    };
    await expect(
      writeAcceptedAssemblyFiles(files, {
        exists: async () => false,
        mkdir: async () => {},
        writeTextFile: async (path) => {
          if (path.endsWith('.primers.fasta')) throw new Error('simulated write failure');
        },
        rename: async (from, to) => {
          renamed.push([from, to]);
        },
        createScratch: async () => scratch,
        removeScratch: async (lease) => {
          removed.push(lease.path);
        },
        renameScratch: async (_lease, from, to) => {
          renamed.push([from, to]);
        },
      })
    ).rejects.toThrow(/write failure/i);

    expect(renamed.some(([, to]) => to === files.packageRoot)).toBe(false);
    expect(removed).toEqual([scratch.staging.path, scratch.previous.path]);
  });
});

function createDesign(): SequenceDesign {
  const now = new Date('2026-05-17T00:00:00.000Z');
  return {
    id: 'design-1',
    constructId: 'construct-1',
    name: 'Accepted Construct',
    topology: 'circular',
    regions: [
      region('left', 'ATGCATGCATGC', [
        { name: 'left CDS', type: 'CDS', start: 0, end: 4, strand: 'forward' },
      ]),
      region('right', 'GCTAGCTAGCTA', [
        { name: 'right CDS', type: 'CDS', start: 2, end: 6, strand: 'reverse' },
      ]),
    ],
    spacers: [{ id: 'spacer-1', junctionIndex: 0, sequence: 'AAA' }],
    version: 7,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [
      {
        fragmentIndex: 0,
        forward: {
          id: 'left-forward',
          name: 'left forward',
          sequence: 'AAAATGC',
          pbs: { start: 0, end: 4, sequence: 'ATGC' },
          overhang: { length: 3, sequence: 'AAA', tailLength: 3 },
          direction: 'forward',
          fragmentIndex: 0,
          junctionIndex: 1,
          tm: 12,
        },
        reverse: {
          id: 'left-reverse',
          name: 'left reverse',
          sequence: 'TTTGCAT',
          pbs: { start: 8, end: 12, sequence: 'GCAT' },
          overhang: { length: 3, sequence: 'TTT', tailLength: 3 },
          direction: 'reverse',
          fragmentIndex: 0,
          junctionIndex: 0,
          tm: 12,
        },
      },
    ],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createOriginWrappingReverseContinuationDesign(): SequenceDesign {
  const now = new Date('2026-05-17T00:00:00.000Z');
  return {
    id: 'design-origin-reverse-continuation',
    constructId: 'construct-origin-reverse-continuation',
    name: 'Origin Reverse Continuation',
    topology: 'circular',
    regions: [
      {
        id: 'right',
        sourceSequenceId: 'source-right',
        sourceSequenceName: 'Source right',
        sourceStart: 60,
        sourceEnd: 66,
        sequence: 'AAATTT',
        annotations: [],
        sourceAnnotations: [
          {
            name: 'origin reverse CDS',
            type: 'CDS',
            start: 51,
            end: 66,
            strand: 'reverse',
            qualifiers: { codon_start: '1' },
          },
        ],
        sourceType: 'pcr',
      },
      {
        id: 'left',
        sourceSequenceId: 'source-left',
        sourceSequenceName: 'Source left',
        sourceStart: 0,
        sourceEnd: 6,
        sequence: 'GGGCCC',
        annotations: [],
        sourceType: 'pcr',
      },
    ],
    spacers: [{ id: 'spacer-origin', junctionIndex: 1, sequence: 'TTA' }],
    version: 1,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function region(
  id: string,
  sequence: string,
  annotations: DesignRegion['annotations']
): DesignRegion {
  return {
    id,
    sourceSequenceId: `source-${id}`,
    sourceSequenceName: `Source ${id}`,
    sourceStart: 10,
    sourceEnd: 10 + sequence.length,
    sequence,
    annotations,
    sourceType: 'pcr',
  };
}
describe('accepted assembly package layout ', () => {
  const workspaceFolders = { main: { path: '/workspace/project', name: 'Project' } };

  async function preparedFiles(basename: string) {
    const design = createDesign();
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: design.regions.map((region) => buildSourceProvenanceSnapshot(region)),
    });
    return prepareAcceptedAssemblyFiles({
      projectionInput,
      validationSnapshot: buildAcceptedAssemblyValidationSnapshot({
        designId: design.id,
        designVersion: design.version,
        assemblyMethod: design.assemblyMethod,
        projectionInputChecksum: projectionInput.canonicalDraftChecksum,
      }),
      writeTarget: { workspaceFolderId: 'main', relativeDirectory: 'assemblies', basename },
      workspaceFolders,
    });
  }

  function earlierPackage(files: Awaited<ReturnType<typeof preparedFiles>>) {
    const csvPath = `${files.packageRoot}/contents/${files.basename}.primers.csv`;
    const fastaPath = `${files.packageRoot}/contents/${files.basename}.primers.fasta`;
    const previous = JSON.parse(files.sidecarJsonContent) as Record<string, unknown>;
    const assembly = previous.assembly as Record<string, unknown>;
    const accepted = assembly.accepted as Record<string, unknown>;
    const artifacts = accepted.artifacts as Record<string, unknown>;
    accepted.acceptedAssemblyVersionId = 'previous-accepted-version';
    artifacts.primerCsvPath = `contents/${files.basename}.primers.csv`;
    artifacts.primerFastaPath = `contents/${files.basename}.primers.fasta`;
    const members = previous.members as Array<Record<string, unknown>>;
    for (const member of members.filter((entry) => entry.role === 'primer-export')) {
      const format = String(member.path).endsWith('.csv') ? 'csv' : 'fasta';
      member.id = `primer-export:previous-accepted-version:${format}`;
      member.replaceable = true;
      member.path =
        format === 'csv'
          ? `contents/${files.basename}.primers.csv`
          : `contents/${files.basename}.primers.fasta`;
    }
    return {
      marker: JSON.stringify(previous),
      csvPath,
      fastaPath,
    };
  }

  it('resolves a package directory, not four loose siblings', () => {
    const paths = resolveAcceptedAssemblyWritePaths(
      {
        workspaceFolderId: 'main',
        relativeDirectory: 'assemblies',
        basename: 'accepted-construct',
      },
      workspaceFolders
    );

    const root = '/workspace/project/assemblies/accepted-construct';
    expect(paths.packageRoot).toBe(root);
    expect(paths.productGenBankPath).toBe(`${root}/accepted-construct.gb`);
    expect(paths.metaPath).toBe(`${root}/.forge/plasmid.json`);
    expect(paths.primerCsvPath).toBe(`${root}/contents/accepted-construct.primers.csv`);
    expect(paths.primerFastaPath).toBe(`${root}/contents/accepted-construct.primers.fasta`);
    for (const member of [paths.productGenBankPath, paths.metaPath, paths.primerCsvPath]) {
      expect(member.startsWith(`${root}/`)).toBe(true);
    }
  });

  it('mints the package folder from a chosen product filename', () => {
    const paths = resolveAcceptedAssemblyWritePaths(
      { absoluteProductPath: '/custom/output/My-construct.gb', overwrite: true },
      workspaceFolders
    );
    expect(paths.packageRoot).toBe('/custom/output/My-construct');
    expect(paths.productGenBankPath).toBe('/custom/output/My-construct/My-construct.gb');
    expect(paths.metaPath).toBe('/custom/output/My-construct/.forge/plasmid.json');
  });

  it('preserves a non-default GenBank extension on the product inside the package', () => {
    const paths = resolveAcceptedAssemblyWritePaths(
      { absoluteProductPath: '/custom/output/My-construct.genbank', overwrite: true },
      workspaceFolders
    );
    expect(paths.productGenBankPath).toBe('/custom/output/My-construct/My-construct.genbank');
  });

  it('does not leave a duplicate package behind after a successful overwrite', async () => {
    const files = await preparedFiles('leftover-construct');
    const earlier = earlierPackage(files);
    const disk = virtualPackageDisk({
      [files.productGenBankPath]: 'OLD PRODUCT',
      [files.metaPath]: earlier.marker,
      [earlier.csvPath]: 'OLD CSV',
      [earlier.fastaPath]: 'OLD FASTA',
    });

    const published = { ...files, overwrite: true };
    await writeAcceptedAssemblyFiles(published, disk.ops);

    expect(disk.paths().some((path) => /\.(?:staging|previous)-/.test(path))).toBe(false);
  });

  it('reports every legacy generated path moved while overwriting a package', async () => {
    const files = await preparedFiles('legacy-primer-construct');
    const legacyCsvPath = `${files.packageRoot}/primers/${files.basename}.primers.csv`;
    const legacyFastaPath = `${files.packageRoot}/primers/${files.basename}.primers.fasta`;
    const legacy = JSON.parse(files.sidecarJsonContent) as Record<string, unknown>;
    delete legacy.formatVersion;
    delete legacy.members;
    legacy.schema = 'waypoint.plasmid.v1';
    legacy.kind = 'plasmid';
    const assembly = legacy.assembly as Record<string, unknown>;
    const accepted = assembly.accepted as Record<string, unknown>;
    assembly.primers = {
      csv: `primers/${files.basename}.primers.csv`,
      fasta: `primers/${files.basename}.primers.fasta`,
    };
    accepted.artifacts = {
      ...(accepted.artifacts as Record<string, unknown>),
      primerCsvPath: `primers/${files.basename}.primers.csv`,
      primerFastaPath: `primers/${files.basename}.primers.fasta`,
    };
    const disk = virtualPackageDisk({
      [files.productGenBankPath]: 'OLD PRODUCT',
      [files.metaPath]: JSON.stringify(legacy),
      [legacyCsvPath]: 'OLD CSV',
      [legacyFastaPath]: 'OLD FASTA',
    });

    const receipt = await writeAcceptedAssemblyFiles({ ...files, overwrite: true }, disk.ops);

    expect(receipt.migratedPaths).toEqual([
      legacyCsvPath,
      `${files.packageRoot}/contents/${files.basename}.primers.csv`,
      legacyFastaPath,
      `${files.packageRoot}/contents/${files.basename}.primers.fasta`,
    ]);
    expect(disk.read(legacyCsvPath)).toBeUndefined();
    expect(disk.read(legacyFastaPath)).toBeUndefined();
    expect(disk.read(files.primerCsvPath)).toBe(files.primerCsvContent);
    expect(disk.read(files.primerFastaPath)).toBe(files.primerFastaContent);
  });

  it('keeps listed sequencing-read members when re-finalizing', async () => {
    const files = await preparedFiles('reads-construct');
    const earlier = earlierPackage(files);
    const live = JSON.parse(earlier.marker) as {
      members?: Array<Record<string, unknown>>;
    };
    live.members = [
      ...(live.members ?? []),
      {
        id: 'read-1',
        role: 'sequencing-read',
        path: 'contents/clone-1.fasta',
        replaceable: false,
        createdAt: '2026-08-13T00:00:00.000Z',
      },
    ];
    const disk = virtualPackageDisk({
      [files.productGenBankPath]: 'OLD PRODUCT',
      [files.metaPath]: JSON.stringify(live),
      [earlier.csvPath]: 'OLD CSV',
      [earlier.fastaPath]: 'OLD FASTA',
      [`${files.packageRoot}/contents/clone-1.fasta`]: 'CLONE READ',
    });

    await writeAcceptedAssemblyFiles({ ...files, overwrite: true }, disk.ops);

    expect(disk.read(`${files.packageRoot}/contents/clone-1.fasta`)).toBe('CLONE READ');
    const marker = JSON.parse(disk.read(files.metaPath)) as {
      members: Array<{ role: string; path: string }>;
    };
    expect(marker.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'sequencing-read', path: 'contents/clone-1.fasta' }),
      ])
    );
  });

  it('refuses overwrite when live members cannot be loaded', async () => {
    const files = await preparedFiles('reads-construct-blocked');
    const earlier = earlierPackage(files);
    const live = JSON.parse(earlier.marker) as {
      members?: Array<Record<string, unknown>>;
    };
    live.members = [
      ...(live.members ?? []),
      {
        id: 'read-1',
        role: 'sequencing-read',
        path: 'contents/clone-1.fasta',
        replaceable: false,
        createdAt: '2026-08-13T00:00:00.000Z',
      },
    ];
    const disk = virtualPackageDisk({
      [files.productGenBankPath]: 'OLD PRODUCT',
      [files.metaPath]: JSON.stringify(live),
      [earlier.csvPath]: 'OLD CSV',
      [earlier.fastaPath]: 'OLD FASTA',
      [`${files.packageRoot}/contents/clone-1.fasta`]: 'CLONE READ',
    });
    const ops = {
      ...disk.ops,
      writeTextFile: async () => {
        throw new Error('EACCES: cannot write marker');
      },
    };

    await expect(writeAcceptedAssemblyFiles({ ...files, overwrite: true }, ops)).rejects.toThrow(
      /could not load the live package members|EACCES/
    );
    expect(disk.read(`${files.packageRoot}/contents/clone-1.fasta`)).toBe('CLONE READ');
    const marker = JSON.parse(disk.read(files.metaPath)!) as {
      members: Array<{ role: string; path: string }>;
    };
    expect(marker.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'sequencing-read', path: 'contents/clone-1.fasta' }),
      ])
    );
  });

  it('preserves every user-added package member when re-finalizing', async () => {
    const files = await preparedFiles('curated-construct');
    const earlier = earlierPackage(files);
    const disk = virtualPackageDisk({
      [files.productGenBankPath]: 'OLD PRODUCT',
      [files.metaPath]: earlier.marker,
      [earlier.csvPath]: 'OLD CSV',
      [earlier.fastaPath]: 'OLD FASTA',
      [`${files.packageRoot}/assets/gel.png`]: 'IRREPLACEABLE GEL IMAGE',
      [`${files.packageRoot}/notes.txt`]: 'human curation notes',
      [`${files.packageRoot}/primers/manual-order.txt`]: 'manual primer note',
      [`${files.packageRoot}/contents/clone-1.fasta`]: 'CLONE READ',
      [`${files.packageRoot}/.forge/curation.json`]: '{"reviewed":true}',
    });

    const published = { ...files, overwrite: true };
    await writeAcceptedAssemblyFiles(published, disk.ops);

    expect(disk.read(`${files.packageRoot}/assets/gel.png`)).toBe('IRREPLACEABLE GEL IMAGE');
    expect(disk.read(`${files.packageRoot}/notes.txt`)).toBe('human curation notes');
    expect(disk.read(`${files.packageRoot}/primers/manual-order.txt`)).toBe('manual primer note');
    expect(disk.read(`${files.packageRoot}/contents/clone-1.fasta`)).toBe('CLONE READ');
    expect(disk.read(`${files.packageRoot}/.forge/curation.json`)).toBe('{"reviewed":true}');
    expect(disk.read(files.productGenBankPath)).toBe(files.productGenBankContent);
    expect(disk.read(files.metaPath)).toBe(published.sidecarJsonContent);
    const revisions = parseSequencePackageDocument(published.sidecarJsonContent).versionHistory
      .revisions;
    expect(revisions.map((revision) => revision.kind)).toEqual([
      'adopted',
      'assembly-finalization',
    ]);
    expect(
      disk.read(fromPackageRelative(revisions[0].productSnapshot.path, files.packageRoot))
    ).toBe('OLD PRODUCT');
    expect(
      disk.read(fromPackageRelative(revisions[1].productSnapshot.path, files.packageRoot))
    ).toBe(files.productGenBankContent);
    expect(disk.read(files.primerCsvPath)).toBe(files.primerCsvContent);
    expect(disk.read(files.primerFastaPath)).toBe(files.primerFastaContent);
    expect(disk.paths().some((path) => /\.(?:staging|previous)-/.test(path))).toBe(false);
  });

  it('preserves stable identity and unknown top-level metadata when re-finalizing', async () => {
    const design = createDesign();
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: design.regions.map((region) => buildSourceProvenanceSnapshot(region)),
    });
    const input = {
      projectionInput,
      validationSnapshot: buildAcceptedAssemblyValidationSnapshot({
        designId: design.id,
        designVersion: design.version,
        assemblyMethod: design.assemblyMethod,
        projectionInputChecksum: projectionInput.canonicalDraftChecksum,
      }),
      writeTarget: {
        workspaceFolderId: 'main',
        relativeDirectory: 'assemblies',
        basename: 'metadata-construct',
      },
      workspaceFolders,
      acceptedAt: '2026-07-27T00:00:00.000Z',
      acceptedVersionId: 'new-accepted-version',
      packageId: 'stable-package-id',
      existingPackageDocument: {
        schema: 'waypoint.sequence.v1',
        kind: 'plasmid',
        id: 'stable-package-id',
        name: 'Earlier name',
        product: { file: 'metadata-construct.gb' },
        assembly: {
          accepted: { acceptedAssemblyVersionId: 'prior-accepted-version' },
        },
        entity: {
          ...createDefaultSequenceEntityMetadata(),
          schema: {
            ...createDefaultSequenceEntityMetadata().schema,
            schemaId: 'custom-sequence-schema',
            schemaRevisionId: 'custom-sequence-schema-v3',
            displayName: 'Curated construct',
            version: 3,
          },
          registrationStatus: 'unresolved',
        },
        labAudit: { reviewedBy: 'Ada', disposition: 'approved' },
      },
    } as Parameters<typeof prepareAcceptedAssemblyFiles>[0] & {
      existingPackageDocument: Record<string, unknown>;
    };

    const prepared = await prepareAcceptedAssemblyFiles(input);
    const marker = JSON.parse(prepared.sidecarJsonContent) as Record<string, unknown>;

    expect(marker.id).toBe('stable-package-id');
    expect(marker.labAudit).toEqual({ reviewedBy: 'Ada', disposition: 'approved' });
    expect((marker.entity as { registrationStatus: string }).registrationStatus).toBe('unresolved');
    expect(marker.assembly).toBeDefined();
    expect((marker.assembly as { history: unknown[] }).history).toEqual([
      { acceptedAssemblyVersionId: 'prior-accepted-version' },
    ]);
  });

  it('refuses to inherit the identity of a different existing package', async () => {
    const design = createDesign();
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: design.regions.map((item) => buildSourceProvenanceSnapshot(item)),
    });
    await expect(
      prepareAcceptedAssemblyFiles({
        projectionInput,
        validationSnapshot: buildAcceptedAssemblyValidationSnapshot({
          designId: design.id,
          designVersion: design.version,
          assemblyMethod: design.assemblyMethod,
          projectionInputChecksum: projectionInput.canonicalDraftChecksum,
        }),
        writeTarget: {
          workspaceFolderId: 'main',
          relativeDirectory: 'assemblies',
          basename: 'wrong-owner',
        },
        workspaceFolders,
        existingPackageDocument: {
          schema: 'waypoint.sequence.v1',
          kind: 'plasmid',
          id: 'other-construct',
          name: 'Other',
          updatedAt: '2026-08-05T00:00:00.000Z',
          product: { file: 'wrong-owner.gb' },
        },
      })
    ).rejects.toThrow(/different existing package|refusing to replace/i);
  });

  it('refuses to replace a same-named primer file the existing marker never recorded as generated', async () => {
    const files = await preparedFiles('imported-construct');
    const importedMarker = JSON.stringify({
      schema: 'waypoint.sequence.v1',
      kind: 'plasmid',
      id: 'imported-package-id',
      name: 'Imported construct',
      updatedAt: '2026-07-27T00:00:00.000Z',
      product: { file: 'imported-construct.gb' },
    });
    const disk = virtualPackageDisk({
      [files.productGenBankPath]: 'IMPORTED PRODUCT',
      [files.metaPath]: importedMarker,
      [files.primerCsvPath]: 'USER-AUTHORED PRIMER ORDER',
      [`${files.packageRoot}/assets/gel.png`]: 'IRREPLACEABLE GEL IMAGE',
    });
    await expect(
      writeAcceptedAssemblyFiles({ ...files, overwrite: true }, disk.ops)
    ).rejects.toThrow(/primer|recorded|user|refus/i);

    expect(disk.read(files.primerCsvPath)).toBe('USER-AUTHORED PRIMER ORDER');
    expect(disk.read(`${files.packageRoot}/assets/gel.png`)).toBe('IRREPLACEABLE GEL IMAGE');
    expect(disk.read(files.productGenBankPath)).toBe('IMPORTED PRODUCT');
  });

  it('refuses overwrite when the marker does not identify the selected product', async () => {
    const files = await preparedFiles('copied-marker');
    const copiedMarker = JSON.parse(files.sidecarJsonContent) as {
      product: { file: string };
    };
    copiedMarker.product.file = 'Different-plasmid.gb';
    const disk = virtualPackageDisk({
      [files.productGenBankPath]: 'USER PRODUCT',
      [files.metaPath]: `${JSON.stringify(copiedMarker, null, 2)}\n`,
      [`${files.packageRoot}/assets/gel.png`]: 'USER ASSET',
    });
    const before = disk.snapshot();

    await expect(
      writeAcceptedAssemblyFiles({ ...files, overwrite: true }, disk.ops)
    ).rejects.toThrow(/selected product|package record/i);

    expect(disk.snapshot()).toEqual(before);
  });

  it('does not absorb an ordinary parent carrying an invalid or copied marker', async () => {
    const files = await preparedFiles('ordinary-folder');
    const copiedMarker = JSON.parse(files.sidecarJsonContent) as {
      product: { file: string };
    };
    copiedMarker.product.file = 'Somewhere-else.gb';
    const disk = virtualPackageDisk({
      [files.productGenBankPath]: 'USER SEQUENCE',
      [files.metaPath]: `${JSON.stringify(copiedMarker)}\n`,
      [`${files.packageRoot}/notes.txt`]: 'ordinary folder content',
    });

    const parentIsExistingPackage = await isMatchingExistingSequencePackageProduct(
      disk.ops,
      files.packageRoot,
      files.productGenBankPath
    );
    const paths = resolveAcceptedAssemblyWritePaths(
      {
        absoluteProductPath: files.productGenBankPath,
        overwrite: true,
        parentIsExistingPackage,
      },
      workspaceFolders
    );

    expect(parentIsExistingPackage).toBe(false);
    expect(paths.packageRoot).toBe(`${files.packageRoot}/${files.basename}`);
    expect(disk.read(`${files.packageRoot}/notes.txt`)).toBe('ordinary folder content');
  });

  it('an overwrite that fails midway leaves the PREVIOUS package intact', async () => {
    const files = await preparedFiles('retry-construct');
    const earlier = earlierPackage(files);
    const disk = virtualPackageDisk(
      {
        [files.productGenBankPath]: 'OLD PRODUCT',
        [files.metaPath]: earlier.marker,
        [earlier.csvPath]: 'OLD CSV',
        [earlier.fastaPath]: 'OLD FASTA',
        [`${files.packageRoot}/assets/gel.png`]: 'USER ASSET',
      },
      {
        failRename: (from) =>
          from.includes('.staging-') && from.endsWith('.primers.fasta')
            ? new Error('simulated member swap failure')
            : null,
      }
    );
    const before = disk.snapshot();

    await expect(
      writeAcceptedAssemblyFiles({ ...files, overwrite: true }, disk.ops)
    ).rejects.toThrow(/member swap failure/i);

    expect(disk.snapshot()).toEqual(before);
  });

  it('keeps staging and displaced directories HIDDEN from the tree and reconcile', async () => {
    const files = await preparedFiles('hidden-construct');
    const earlier = earlierPackage(files);
    const dirs: string[] = [];
    const disk = virtualPackageDisk({
      [files.productGenBankPath]: 'OLD PRODUCT',
      [files.metaPath]: earlier.marker,
      [earlier.csvPath]: 'OLD CSV',
      [earlier.fastaPath]: 'OLD FASTA',
    });

    await writeAcceptedAssemblyFiles(
      { ...files, overwrite: true },
      {
        ...disk.ops,
        mkdir: async (path, options) => {
          dirs.push(path);
          await disk.ops.mkdir(path, options);
        },
        rename: async (from, to) => {
          dirs.push(from, to);
          await disk.ops.rename(from, to);
        },
      }
    );

    const temporaryRoots = dirs
      .map((path) => path.split('/').filter(Boolean))
      .map((segments) => segments.find((s) => s.includes('.staging-') || s.includes('.previous-')))
      .filter((segment): segment is string => Boolean(segment));

    expect(temporaryRoots.length).toBeGreaterThan(0);
    for (const name of temporaryRoots) {
      expect(name.startsWith('.')).toBe(true);
    }
  });

  it('does not nest a package when the parent is a VERIFIED package', () => {
    const paths = resolveAcceptedAssemblyWritePaths(
      {
        absoluteProductPath: '/out/My-construct/My-construct.gb',
        overwrite: true,
        parentIsExistingPackage: true,
      },
      workspaceFolders
    );
    expect(paths.packageRoot).toBe('/out/My-construct');
    expect(paths.productGenBankPath).toBe('/out/My-construct/My-construct.gb');
  });

  it('reuses a VERIFIED package after only its folder was renamed', () => {
    const paths = resolveAcceptedAssemblyWritePaths(
      {
        absoluteProductPath: '/out/Renamed/Old.gb',
        overwrite: true,
        parentIsExistingPackage: true,
      },
      workspaceFolders
    );

    expect(paths.packageRoot).toBe('/out/Renamed');
    expect(paths.productGenBankPath).toBe('/out/Renamed/Old.gb');
  });

  it('does NOT absorb a same-named parent that was not verified as a package', () => {
    const paths = resolveAcceptedAssemblyWritePaths(
      { absoluteProductPath: '/out/My-construct/My-construct.gb', overwrite: true },
      workspaceFolders
    );
    expect(paths.packageRoot).toBe('/out/My-construct/My-construct');
  });

  it('is idempotent when the user accepts the offered default path', () => {
    const offered = '/out/assemblies/My-construct.gb';
    const first = resolveAcceptedAssemblyWritePaths(
      { absoluteProductPath: offered, overwrite: false },
      workspaceFolders
    );
    const second = resolveAcceptedAssemblyWritePaths(
      { absoluteProductPath: offered, overwrite: true },
      workspaceFolders
    );
    expect(first.packageRoot).toBe('/out/assemblies/My-construct');
    expect(second.packageRoot).toBe(first.packageRoot);
    expect(second.productGenBankPath).toBe(first.productGenBankPath);
  });

  it('still mints a package when the parent is unrelated', () => {
    const paths = resolveAcceptedAssemblyWritePaths(
      { absoluteProductPath: '/out/somewhere/My-construct.gb', overwrite: true },
      workspaceFolders
    );
    expect(paths.packageRoot).toBe('/out/somewhere/My-construct');
  });

  it('still refuses a relative directory that escapes the workspace folder', () => {
    expect(() =>
      resolveAcceptedAssemblyWritePaths(
        { workspaceFolderId: 'main', relativeDirectory: '../outside', basename: 'x' },
        workspaceFolders
      )
    ).toThrow();
  });
});

function virtualPackageDisk(
  initial: Record<string, string>,
  options: {
    failRename?: (from: string, to: string) => Error | null;
  } = {}
): {
  ops: {
    exists(path: string): Promise<boolean>;
    readTextFile(path: string): Promise<string>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    writeTextFile(path: string, content: string): Promise<void>;
    writeWorkspaceTextFileAtomic(input: {
      path: string;
      content: string;
      expectedContentHash: string;
    }): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    createScratch(packageRoot: string): Promise<PackageScratchLeaseSet>;
    removeScratch(lease: PackageScratchLease): Promise<void>;
    renameScratch(lease: PackageScratchLease, from: string, to: string): Promise<void>;
  };
  paths(): string[];
  read(path: string): string | undefined;
  snapshot(): Record<string, string>;
} {
  const files = new Map(Object.entries(initial));
  let scratchCounter = 0;

  function descendants(path: string): Array<[string, string]> {
    const prefix = `${path.replace(/\/+$/, '')}/`;
    return [...files.entries()].filter(([candidate]) => candidate.startsWith(prefix));
  }

  async function renameVirtual(from: string, to: string): Promise<void> {
    const failure = options.failRename?.(from, to);
    if (failure) throw failure;
    const direct = files.get(from);
    if (direct !== undefined) {
      files.delete(from);
      files.set(to, direct);
      return;
    }
    const nested = descendants(from);
    if (nested.length === 0) throw new Error(`ENOENT: ${from}`);
    const fromPrefix = `${from.replace(/\/+$/, '')}/`;
    const toPrefix = `${to.replace(/\/+$/, '')}/`;
    for (const [path] of nested) files.delete(path);
    for (const [path, content] of nested) {
      files.set(`${toPrefix}${path.slice(fromPrefix.length)}`, content);
    }
  }

  return {
    ops: {
      exists: async (path) => files.has(path) || descendants(path).length > 0,
      readTextFile: async (path) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
      mkdir: async () => {},
      writeTextFile: async (path, content) => {
        files.set(path, content);
      },
      writeWorkspaceTextFileAtomic: async (input) => {
        const before = files.get(input.path);
        if (before === undefined) throw new Error(`ENOENT: ${input.path}`);
        const digest = await globalThis.crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(before)
        );
        const actual = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        if (actual !== input.expectedContentHash) throw new Error('marker changed');
        files.set(input.path, input.content);
      },
      rename: renameVirtual,
      createScratch: async (packageRoot) => {
        scratchCounter += 1;
        const slash = packageRoot.lastIndexOf('/');
        const parent = packageRoot.slice(0, slash);
        const rootName = packageRoot.slice(slash + 1);
        return {
          staging: {
            path: `${parent}/.${rootName}.staging-test-${scratchCounter}`,
            cleanupToken: `staging-${scratchCounter}`,
          },
          previous: {
            path: `${parent}/.${rootName}.previous-test-${scratchCounter}`,
            cleanupToken: `previous-${scratchCounter}`,
          },
        };
      },
      removeScratch: async (lease) => {
        files.delete(lease.path);
        for (const [nestedPath] of descendants(lease.path)) files.delete(nestedPath);
      },
      renameScratch: async (_lease, from, to) => renameVirtual(from, to),
    },
    paths: () => [...files.keys()].sort(),
    read: (path) => files.get(path),
    snapshot: () => Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}
