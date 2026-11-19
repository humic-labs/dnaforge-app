import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildMacDefaultHandlerHelper,
  generateWindowsAssociationInclude,
  injectMacAssociationMetadata,
  loadFileAssociationRegistry,
  projectMacAssociationMetadata,
} from '../file-association-packaging.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '../..');
const registry = loadFileAssociationRegistry(desktopRoot);
const installer = readFileSync(path.join(desktopRoot, 'resources', 'installer.nsh'), 'utf8');
const afterPack = readFileSync(path.join(desktopRoot, 'scripts', 'dedup-dugite.cjs'), 'utf8');
const helperSource = readFileSync(
  path.join(desktopRoot, 'resources', 'helpers-src', 'dnaforge-file-association.m'),
  'utf8'
);

describe(' packaging projections', () => {
  it('projects editor/viewer macOS roles with alternate handler rank and icons', () => {
    const projected = projectMacAssociationMetadata(registry);

    const types = Object.fromEntries(
      projected.documentTypes.map((type) => [type.CFBundleTypeName, type.LSItemContentTypes])
    );
    assert.deepEqual(types['GenBank DNA sequence'], [
      'biosequence.genbank',
      'com.dnaforge.genbank',
    ]);
    assert.deepEqual(types['SnapGene DNA document'], ['com.gslbiotech.dna', 'com.snapgene.dna']);
    assert.deepEqual(types['FASTA sequences'], ['biosequence.fasta']);
    assert.deepEqual(types['Sanger chromatograms'], ['biosequence.abi']);
    assert.deepEqual(types['Molecular structures'], [
      'com.dnaforge.pdb',
      'com.dnaforge.mmcif',
      'com.dnaforge.bcif',
    ]);
    assert.ok(
      projected.documentTypes.every(
        (type) => type.LSHandlerRank === 'Alternate' && type.CFBundleTypeIconFile === 'icon.icns'
      )
    );
    const imported = Object.fromEntries(
      projected.importedTypes.map((type) => [
        type.UTTypeIdentifier,
        type.UTTypeTagSpecification['public.filename-extension'],
      ])
    );
    assert.deepEqual(imported['com.gslbiotech.dna'], ['dna']);
    assert.deepEqual(imported['biosequence.genbank'], ['gb', 'gbk', 'gbff', 'genbank']);
    assert.deepEqual(imported['com.dnaforge.bcif'], ['bcif']);
    assert.deepEqual(imported['com.dnaforge.mmcif'], ['cif', 'mmcif', 'mcif']);
    assert.deepEqual(projected.exportedTypes, []);
  });

  it('generates per-user Windows capabilities without taking the current default', () => {
    const include = generateWindowsAssociationInclude(registry);

    assert.match(include, /!macro DNAForgeRegisterFileAssociations/);
    assert.match(include, /WriteRegStr HKCU "Software\\Classes\\DNAForge\.GenBank"/);
    assert.match(
      include,
      /WriteRegStr HKCU "Software\\Classes\\\.gb\\OpenWithProgids" "DNAForge\.GenBank"/
    );
    assert.match(
      include,
      /WriteRegStr HKCU "Software\\DNAForge\\Capabilities\\FileAssociations" "\.dna" "DNAForge\.SnapGene"/
    );
    assert.match(
      include,
      /WriteRegStr HKCU "Software\\RegisteredApplications" "DNAForge" "Software\\DNAForge\\Capabilities"/
    );
    assert.match(include, /DefaultIcon" "" '\"\$INSTDIR\\DNAForge\.exe\",0'/);
    assert.match(include, /'\"\$INSTDIR\\DNAForge\.exe\" \"%1\"'/);
    assert.doesNotMatch(
      include,
      /WriteRegStr HKCU "Software\\Classes\\\.(?:gb|gbk|gbff|genbank|dna)" ""/
    );
    assert.doesNotMatch(include, /UserChoice/);
  });

  it('removes only DNAForge-owned values during uninstall', () => {
    const include = generateWindowsAssociationInclude(registry);
    const uninstall = include.slice(include.indexOf('!macro DNAForgeUnregisterFileAssociations'));

    assert.match(uninstall, /DeleteRegKey HKCU "Software\\Classes\\DNAForge\.GenBank"/);
    assert.match(
      uninstall,
      /DeleteRegValue HKCU "Software\\Classes\\\.gb\\OpenWithProgids" "DNAForge\.GenBank"/
    );
    assert.match(uninstall, /DeleteRegValue HKCU "Software\\RegisteredApplications" "DNAForge"/);
    assert.match(
      uninstall,
      /DeleteRegValue HKCU "Software\\DNAForge\\Capabilities" "ApplicationName"/
    );
    assert.match(
      uninstall,
      /DeleteRegValue HKCU "Software\\DNAForge\\Capabilities" "ApplicationDescription"/
    );
    assert.doesNotMatch(
      uninstall,
      /DeleteRegKey HKCU "Software\\Classes\\\.(?:gb|gbk|gbff|genbank|dna)"/
    );
    assert.doesNotMatch(uninstall, /UserChoice/);
  });

  it('keeps the checked-in NSIS projection equal to the registry generator', () => {
    const checkedIn = readFileSync(
      path.join(desktopRoot, 'resources', 'file-associations.generated.nsh'),
      'utf8'
    );
    assert.equal(checkedIn, generateWindowsAssociationInclude(registry));
  });

  it('wires install and uninstall hooks to the generated association macros', () => {
    assert.match(installer, /!include "file-associations\.generated\.nsh"/);
    assert.match(
      installer,
      /!macro customInstall[\s\S]*!insertmacro DNAForgeRegisterFileAssociations/
    );
    assert.match(
      installer,
      /!macro customUnInstall[\s\S]*!insertmacro DNAForgeUnregisterFileAssociations/
    );
  });

  it('injects all macOS registry projections before signing', () => {
    const calls = [];
    injectMacAssociationMetadata(
      {
        electronPlatformName: 'darwin',
        appOutDir: '/tmp/dnaforge-package',
        packager: { appInfo: { productFilename: 'DNAForge' } },
      },
      registry,
      (command, args) => {
        calls.push({ command, args });
        return { status: 0, stderr: '' };
      }
    );

    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.command === '/usr/bin/plutil'));
    assert.deepEqual(
      calls.map((call) => call.args.slice(0, 2)),
      [
        ['-replace', 'CFBundleDocumentTypes'],
        ['-replace', 'UTExportedTypeDeclarations'],
        ['-replace', 'UTImportedTypeDeclarations'],
      ]
    );
    assert.ok(
      calls.every(
        (call) => call.args.at(-1) === '/tmp/dnaforge-package/DNAForge.app/Contents/Info.plist'
      )
    );
    assert.match(afterPack, /injectMacAssociationMetadata\(context, associationRegistry\)/);
  });

  it('keeps a separate validation build out of Open With and the default settings', () => {
    const values = [];
    injectMacAssociationMetadata(
      {
        electronPlatformName: 'darwin',
        appOutDir: '/tmp/build',
        packager: { appInfo: { productFilename: 'DNAForge Validation' } },
      },
      registry,
      (_command, args) => {
        values.push(JSON.parse(args[3]));
        return { status: 0 };
      }
    );
    assert.deepEqual(values, [[], [], []]);
    for (const macro of [
      'DNAForgeRegisterFileAssociations',
      'DNAForgeUnregisterFileAssociations',
    ]) {
      assert.ok(
        installer.includes('!if "${PRODUCT_NAME}" == "DNAForge"\n    !insertmacro ' + macro)
      );
    }
  });

  it('builds the macOS 12 NSWorkspace helper into Contents/Helpers before signing', () => {
    const calls = [];
    buildMacDefaultHandlerHelper(
      {
        electronPlatformName: 'darwin',
        appOutDir: '/tmp/dnaforge-package',
        arch: 'arm64',
        packager: { appInfo: { productFilename: 'DNAForge' } },
      },
      desktopRoot,
      (command, args) => {
        calls.push({ command, args });
        return { status: 0, stderr: '' };
      }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/usr/bin/xcrun');
    assert.ok(calls[0].args.includes('-mmacosx-version-min=12.0'));
    assert.ok(calls[0].args.includes('-framework'));
    assert.ok(calls[0].args.includes('UniformTypeIdentifiers'));
    assert.ok(calls[0].args.includes('-arch'));
    assert.ok(calls[0].args.includes('arm64'));
    assert.equal(
      calls[0].args.at(-1),
      '/tmp/dnaforge-package/DNAForge.app/Contents/Helpers/dnaforge-file-association'
    );
    assert.match(helperSource, /URLForApplicationToOpenContentType:/);
    assert.match(helperSource, /setDefaultApplicationAtURL:.*toOpenContentType:/s);
    assert.match(afterPack, /buildMacDefaultHandlerHelper\(context/);
  });
});
