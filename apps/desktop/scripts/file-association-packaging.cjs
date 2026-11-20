const { mkdirSync, readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { Arch } = require('builder-util');

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`File association registry ${field} must be a non-empty string.`);
  }
  return value;
}

function loadFileAssociationRegistry(desktopRoot) {
  const registryPath = join(desktopRoot, 'resources', 'file-associations.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (registry?.version !== 1 || !Array.isArray(registry.families)) {
    throw new Error('File association registry must use version 1 and contain families.');
  }
  const previews = JSON.parse(
    readFileSync(join(desktopRoot, 'resources', 'external-previews.json'), 'utf8')
  );
  for (const preview of previews.families) {
    registry.families.push({
      ...preview,
      documentDescription: preview.displayName,
      documentIcons: { macos: 'icon.icns', windows: 'DNAForge.exe' },
      macos: {
        contentType: preview.macosTypes[0].id,
        role: 'Viewer',
        ownership: 'imported',
        rank: 'Alternate',
      },
    });
  }
  const extensions = new Set();
  for (const [index, family] of registry.families.entries()) {
    nonEmptyString(family?.id, `families[${index}].id`);
    nonEmptyString(family?.displayName, `families[${index}].displayName`);
    nonEmptyString(family?.documentDescription, `families[${index}].documentDescription`);
    if (!Array.isArray(family?.extensions) || family.extensions.length === 0) {
      throw new Error(`File association registry families[${index}].extensions is required.`);
    }
    for (const extension of family.extensions) {
      if (!/^[a-z0-9]+$/u.test(extension) || extensions.has(extension)) {
        throw new Error(
          `File association registry has invalid or duplicate extension ${extension}.`
        );
      }
      extensions.add(extension);
    }
    nonEmptyString(family?.documentIcons?.macos, `families[${index}].documentIcons.macos`);
    nonEmptyString(family?.documentIcons?.windows, `families[${index}].documentIcons.windows`);
    nonEmptyString(family?.macos?.contentType, `families[${index}].macos.contentType`);
    if (family?.macos?.ownership !== 'exported' && family?.macos?.ownership !== 'imported') {
      throw new Error(
        `File association registry families[${index}].macos.ownership must be exported or imported.`
      );
    }
    nonEmptyString(family?.macos?.role, `families[${index}].macos.role`);
    if (family.macos.rank !== 'Alternate') {
      throw new Error(`File association registry ${family.id} must use Alternate handler rank.`);
    }
    nonEmptyString(family?.windows?.progId, `families[${index}].windows.progId`);
  }
  return registry;
}

function projectMacAssociationMetadata(registry) {
  const declarations = registry.families.flatMap((family) => {
    const types = family.macosTypes ?? [
      {
        id: family.macos.contentType,
        conformsTo: family.macos.conformsTo[0],
      },
    ];
    return types.map((type) => ({
      UTTypeIdentifier: type.id,
      UTTypeDescription: family.documentDescription,
      UTTypeConformsTo: [type.conformsTo],
      UTTypeTagSpecification: {
        'public.filename-extension': type.extensions ?? family.extensions,
        ...(family.macos.mimeTypes?.length ? { 'public.mime-type': family.macos.mimeTypes } : {}),
      },
    }));
  });
  return {
    documentTypes: registry.families.map((family) => ({
      CFBundleTypeName: family.documentDescription,
      CFBundleTypeIconFile: family.documentIcons.macos,
      CFBundleTypeRole: family.macos.role,
      LSHandlerRank: family.macos.rank,
      LSItemContentTypes: family.macosTypes?.map((type) => type.id) ?? [
        family.macos.contentType,
        ...(family.macos.aliases ?? []),
      ],
    })),
    exportedTypes: [],
    importedTypes: declarations,
  };
}

function generateWindowsAssociationInclude(registry) {
  const lines = [
    '; GENERATED from resources/file-associations.json and resources/external-previews.json. Do not edit by hand.',
    '; Run: node scripts/generate-file-association-packaging.cjs',
    '',
    '!macro DNAForgeRegisterFileAssociations',
  ];
  for (const family of registry.families) {
    const progIdPath = `Software\\Classes\\${family.windows.progId}`;
    lines.push(
      `  WriteRegStr HKCU "${progIdPath}" "" "${family.documentDescription}"`,
      `  WriteRegStr HKCU "${progIdPath}\\DefaultIcon" "" '\"$INSTDIR\\${family.documentIcons.windows}\",0'`,
      `  WriteRegStr HKCU "${progIdPath}\\shell\\open\\command" "" '\"$INSTDIR\\DNAForge.exe\" \"%1\"'`
    );
    for (const extension of family.extensions) {
      lines.push(
        `  WriteRegStr HKCU "Software\\Classes\\.${extension}\\OpenWithProgids" "${family.windows.progId}" ""`,
        `  WriteRegStr HKCU "Software\\Classes\\Applications\\DNAForge.exe\\SupportedTypes" ".${extension}" ""`,
        `  WriteRegStr HKCU "Software\\DNAForge\\Capabilities\\FileAssociations" ".${extension}" "${family.windows.progId}"`
      );
    }
  }
  lines.push(
    '  WriteRegStr HKCU "Software\\DNAForge\\Capabilities" "ApplicationName" "DNAForge"',
    '  WriteRegStr HKCU "Software\\DNAForge\\Capabilities" "ApplicationDescription" "Design and inspect biological sequences"',
    '  WriteRegStr HKCU "Software\\RegisteredApplications" "DNAForge" "Software\\DNAForge\\Capabilities"',
    "  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'",
    '!macroend',
    '',
    '!macro DNAForgeUnregisterFileAssociations'
  );
  for (const family of registry.families) {
    for (const extension of family.extensions) {
      lines.push(
        `  DeleteRegValue HKCU "Software\\Classes\\.${extension}\\OpenWithProgids" "${family.windows.progId}"`,
        `  DeleteRegValue HKCU "Software\\Classes\\Applications\\DNAForge.exe\\SupportedTypes" ".${extension}"`,
        `  DeleteRegValue HKCU "Software\\DNAForge\\Capabilities\\FileAssociations" ".${extension}"`
      );
    }
    lines.push(`  DeleteRegKey HKCU "Software\\Classes\\${family.windows.progId}"`);
  }
  lines.push(
    '  DeleteRegValue HKCU "Software\\RegisteredApplications" "DNAForge"',
    '  DeleteRegValue HKCU "Software\\DNAForge\\Capabilities" "ApplicationName"',
    '  DeleteRegValue HKCU "Software\\DNAForge\\Capabilities" "ApplicationDescription"',
    '  DeleteRegKey /ifempty HKCU "Software\\Classes\\Applications\\DNAForge.exe\\SupportedTypes"',
    '  DeleteRegKey /ifempty HKCU "Software\\Classes\\Applications\\DNAForge.exe"',
    '  DeleteRegKey /ifempty HKCU "Software\\DNAForge\\Capabilities\\FileAssociations"',
    '  DeleteRegKey /ifempty HKCU "Software\\DNAForge\\Capabilities"',
    '  DeleteRegKey /ifempty HKCU "Software\\DNAForge"',
    "  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'",
    '!macroend'
  );
  return `${lines.join('\n')}\n`;
}

function injectMacAssociationMetadata(context, registry, run = spawnSync) {
  if (context.electronPlatformName !== 'darwin') return;
  const plistPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Info.plist'
  );
  const projected =
    context.packager.appInfo.productFilename === 'DNAForge'
      ? projectMacAssociationMetadata(registry)
      : { documentTypes: [], exportedTypes: [], importedTypes: [] };
  const mutations = [
    ['CFBundleDocumentTypes', projected.documentTypes],
    ['UTExportedTypeDeclarations', projected.exportedTypes],
    ['UTImportedTypeDeclarations', projected.importedTypes],
  ];
  for (const [key, value] of mutations) {
    const result = run(
      '/usr/bin/plutil',
      ['-replace', key, '-json', JSON.stringify(value), plistPath],
      { encoding: 'utf8' }
    );
    if (result.status !== 0) {
      throw new Error(
        `Failed to inject ${key} into packaged Info.plist: ${String(result.stderr ?? '').trim()}`
      );
    }
  }
}

function buildMacDefaultHandlerHelper(context, desktopRoot, run = spawnSync) {
  if (context.electronPlatformName !== 'darwin') return;
  const rawArch = typeof context.arch === 'number' ? Arch[context.arch] : context.arch;
  const clangArch = rawArch === 'x64' ? 'x86_64' : rawArch;
  if (clangArch !== 'arm64' && clangArch !== 'x86_64') {
    throw new Error(`Unsupported macOS helper architecture: ${String(rawArch)}`);
  }
  const source = join(desktopRoot, 'resources', 'helpers-src', 'dnaforge-file-association.m');
  const output = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Helpers',
    'dnaforge-file-association'
  );
  mkdirSync(dirname(output), { recursive: true });
  const result = run(
    '/usr/bin/xcrun',
    [
      'clang',
      '-fobjc-arc',
      '-fblocks',
      '-mmacosx-version-min=12.0',
      source,
      '-framework',
      'AppKit',
      '-framework',
      'UniformTypeIdentifiers',
      '-arch',
      clangArch,
      '-o',
      output,
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to build macOS file-association helper: ${String(result.stderr ?? '').trim()}`
    );
  }
}

exports.loadFileAssociationRegistry = loadFileAssociationRegistry;
exports.projectMacAssociationMetadata = projectMacAssociationMetadata;
exports.generateWindowsAssociationInclude = generateWindowsAssociationInclude;
exports.injectMacAssociationMetadata = injectMacAssociationMetadata;
exports.buildMacDefaultHandlerHelper = buildMacDefaultHandlerHelper;
