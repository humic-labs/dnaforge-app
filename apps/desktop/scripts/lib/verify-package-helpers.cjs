'use strict';


const fs = require('fs');
const { createHash } = require('crypto');
const { builtinModules } = require('module');
const path = require('path');


const REQUIRED_ASAR_PACKAGES = Object.freeze(['entities']);
const PACKAGED_MAIN_ENTRY = 'out/main/index.js';
const PACKAGE_COMPOSITION_LIMITS = Object.freeze({
  totalBytes: 240 * 1024 * 1024,
  outBytes: 160 * 1024 * 1024,
});
const INSTALLED_PACKAGE_COMPOSITION_LIMITS = Object.freeze({
  darwin: Object.freeze({
    totalBytes: 1500 * 1024 * 1024,
    binaryBytes: 850 * 1024 * 1024,
    asarUnpackedBytes: 125 * 1024 * 1024,
    electronRuntimeBytes: 350 * 1024 * 1024,
    sampleWorkspaceBytes: 70 * 1024 * 1024,
    trackBytes: 8 * 1024 * 1024,
  }),
  win32: Object.freeze({
    totalBytes: 1650 * 1024 * 1024,
    binaryBytes: 900 * 1024 * 1024,
    asarUnpackedBytes: 150 * 1024 * 1024,
    electronRuntimeBytes: 350 * 1024 * 1024,
    sampleWorkspaceBytes: 70 * 1024 * 1024,
    trackBytes: 8 * 1024 * 1024,
  }),
});

function isThirdPartySourceMap(filePath) {
  return filePath.startsWith('node_modules/') && filePath.endsWith('.map');
}

function isDependencyDevelopmentPayload(filePath) {
  return (
    /(?:^|\/)node_modules\/(?:cytoscape-fcose|gifuct-js)\/demo\//u.test(filePath) ||
    /(?:^|\/)node_modules\/tus-js-client\/dist\/browser-test-bundle\.js$/u.test(filePath) ||
    /(?:^|\/)node_modules\/better-sqlite3\/(?:deps|src)\//u.test(filePath)
  );
}

function isRendererDependencySource(filePath) {
  return (
    filePath.startsWith('node_modules/molstar/') || filePath.startsWith('node_modules/pixi.js/')
  );
}

function isCompilerOutput(filePath) {
  return (
    (filePath.startsWith('out/') && filePath.endsWith('.tsbuildinfo')) ||
    filePath === 'out/cargo-target' ||
    filePath.startsWith('out/cargo-target/') ||
    (/^out\/.*\/(?:deps|build|incremental)\//u.test(filePath) &&
      /\.(?:rlib|rmeta|d)$/u.test(filePath))
  );
}

function isBrowserTestBuild(filePath) {
  return filePath === 'out/browser-e2e' || filePath.startsWith('out/browser-e2e/');
}

function isTestModuleGraph(filePath) {
  return filePath === 'out/module-graph' || filePath.startsWith('out/module-graph/');
}

function isPreviousLocalBuild(filePath) {
  return filePath === 'dist-electron' || filePath.startsWith('dist-electron/');
}

function packageCompositionCategory(filePath) {
  if (filePath.startsWith('out/main/')) return 'out/main';
  if (filePath.startsWith('out/renderer/')) return 'out/renderer';
  if (filePath.startsWith('out/cargo-target/')) return 'out/cargo-target';
  if (filePath.startsWith('out/')) return 'out/other';
  if (filePath.startsWith('node_modules/')) return 'node_modules';
  if (filePath.startsWith('public/')) return 'public';
  return filePath.includes('/') ? filePath.split('/')[0] : 'root';
}

function packageCompositionReceipt(rawHeader) {
  const header = rawHeader?.header ?? rawHeader;
  if (!header || typeof header !== 'object' || !header.files || typeof header.files !== 'object') {
    throw new Error('asar header is missing its file tree');
  }

  const files = [];
  const visit = (node, parentPath) => {
    const children = node?.files;
    if (!children || typeof children !== 'object') return;
    for (const name of Object.keys(children).sort()) {
      const child = children[name];
      const filePath = parentPath ? `${parentPath}/${name}` : name;
      if (child?.files && typeof child.files === 'object') {
        visit(child, filePath);
      } else if (Number.isSafeInteger(child?.size) && child.size >= 0) {
        files.push({
          path: filePath,
          bytes: child.size,
          offset: typeof child.offset === 'string' ? child.offset : null,
          unpacked: child.unpacked === true,
        });
      }
    }
  };
  visit(header, '');

  const packedFiles = [];
  const storedRanges = new Set();
  for (const file of files) {
    if (file.unpacked) continue;
    const storageIdentity =
      file.offset === null ? `path:${file.path}` : `${file.offset}:${file.bytes}`;
    if (storedRanges.has(storageIdentity)) continue;
    storedRanges.add(storageIdentity);
    packedFiles.push(file);
  }

  const categories = new Map();
  for (const file of packedFiles) {
    const name = packageCompositionCategory(file.path);
    const current = categories.get(name) ?? { name, bytes: 0, fileCount: 0 };
    current.bytes += file.bytes;
    current.fileCount += 1;
    categories.set(name, current);
  }
  const compareSizeThenName = (left, right) =>
    right.bytes - left.bytes || left.name.localeCompare(right.name);
  const forbiddenEntries = files
    .map((file) => file.path)
    .filter(
      (filePath) =>
        isCompilerOutput(filePath) ||
        isBrowserTestBuild(filePath) ||
        isTestModuleGraph(filePath) ||
        isPreviousLocalBuild(filePath) ||
        isThirdPartySourceMap(filePath) ||
        isDependencyDevelopmentPayload(filePath) ||
        isRendererDependencySource(filePath)
    )
    .sort();

  return {
    schema: 1,
    totalBytes: packedFiles.reduce((total, file) => total + file.bytes, 0),
    fileCount: packedFiles.length,
    categories: [...categories.values()].sort(compareSizeThenName),
    largestFiles: [...packedFiles]
      .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
      .slice(0, 20)
      .map(({ path: filePath, bytes, unpacked }) => ({ path: filePath, bytes, unpacked })),
    forbiddenEntries,
  };
}

function packageCompositionProblems(receipt) {
  const problems = [];
  const forbiddenEntries = receipt?.forbiddenEntries ?? [];
  const compilerEntries = forbiddenEntries.filter(isCompilerOutput);
  const browserTestEntries = forbiddenEntries.filter(isBrowserTestBuild);
  const moduleGraphEntries = forbiddenEntries.filter(isTestModuleGraph);
  const previousBuildEntries = forbiddenEntries.filter(isPreviousLocalBuild);
  const sourceMapEntries = forbiddenEntries.filter(isThirdPartySourceMap);
  const dependencyDevelopmentEntries = forbiddenEntries.filter(isDependencyDevelopmentPayload);
  const rendererDependencyEntries = forbiddenEntries.filter(
    (filePath) => isRendererDependencySource(filePath) && !isThirdPartySourceMap(filePath)
  );
  if (compilerEntries.length > 0) {
    problems.push(
      `app.asar contains forbidden compiler output: ${compilerEntries[0]}` +
        (compilerEntries.length > 1 ? ` (+${compilerEntries.length - 1} more entries)` : '')
    );
  }
  if (previousBuildEntries.length > 0) {
    problems.push(`app.asar contains a previous local build: ${previousBuildEntries[0]}`);
  }
  if (browserTestEntries.length > 0) {
    problems.push(`app.asar contains forbidden browser-test output: ${browserTestEntries[0]}`);
  }
  if (moduleGraphEntries.length > 0) {
    problems.push(`app.asar contains the test build module graph: ${moduleGraphEntries[0]}`);
  }
  if (sourceMapEntries.length > 0) {
    problems.push(
      `app.asar contains forbidden third-party source map: ${sourceMapEntries[0]}` +
        (sourceMapEntries.length > 1 ? ` (+${sourceMapEntries.length - 1} more entries)` : '')
    );
  }
  if (rendererDependencyEntries.length > 0) {
    const additionalEntryCount = rendererDependencyEntries.length - 1;
    problems.push(
      `app.asar contains forbidden renderer dependency source tree: ${rendererDependencyEntries[0]}` +
        (additionalEntryCount > 0
          ? ` (+${additionalEntryCount} more ${additionalEntryCount === 1 ? 'entry' : 'entries'})`
          : '')
    );
  }
  if (dependencyDevelopmentEntries.length > 0) {
    const additionalEntryCount = dependencyDevelopmentEntries.length - 1;
    problems.push(
      `app.asar contains forbidden dependency development payload: ${dependencyDevelopmentEntries[0]}` +
        (additionalEntryCount > 0 ? ` (+${additionalEntryCount} more entries)` : '')
    );
  }
  if (!Number.isSafeInteger(receipt?.totalBytes) || receipt.totalBytes < 0) {
    problems.push('app.asar composition receipt has an invalid total byte count');
    return problems;
  }
  const formatMiB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  const archiveBytes = Number.isSafeInteger(receipt.archiveBytes)
    ? receipt.archiveBytes
    : receipt.totalBytes;
  if (archiveBytes > PACKAGE_COMPOSITION_LIMITS.totalBytes) {
    problems.push(
      `app.asar is ${formatMiB(archiveBytes)}; the reviewed ceiling is ` +
        formatMiB(PACKAGE_COMPOSITION_LIMITS.totalBytes)
    );
  }
  const outBytes = (receipt.categories ?? [])
    .filter((category) => category?.name === 'out' || category?.name?.startsWith('out/'))
    .reduce(
      (total, category) => total + (Number.isSafeInteger(category.bytes) ? category.bytes : 0),
      0
    );
  if (outBytes > PACKAGE_COMPOSITION_LIMITS.outBytes) {
    problems.push(
      `app.asar out/** is ${formatMiB(outBytes)}; the reviewed ceiling is ` +
        formatMiB(PACKAGE_COMPOSITION_LIMITS.outBytes)
    );
  }
  return problems;
}

function installedPackageCompositionCategory(filePath) {
  const macResourcesPrefix = 'Contents/Resources/';
  const windowsResourcesPrefix = 'resources/';
  let resourcePath = null;
  if (filePath.startsWith(macResourcesPrefix)) {
    resourcePath = filePath.slice(macResourcesPrefix.length);
  } else if (filePath.startsWith(windowsResourcesPrefix)) {
    resourcePath = filePath.slice(windowsResourcesPrefix.length);
  }

  if (resourcePath !== null) {
    if (resourcePath === 'app.asar') return 'resources/app.asar';
    if (resourcePath === 'app.asar.unpacked' || resourcePath.startsWith('app.asar.unpacked/')) {
      return 'resources/app.asar.unpacked';
    }
    if (resourcePath.startsWith('binaries/codex-app-server/')) {
      return 'resources/binaries/codex-app-server';
    }
    if (/^binaries\/waypoint-api-(?:aarch64|x86_64)-/u.test(resourcePath)) {
      return 'resources/binaries/sidecar';
    }
    if (resourcePath.startsWith('binaries/opendataloader-pdf/')) {
      return 'resources/binaries/opendataloader-pdf';
    }
    if (resourcePath === 'binaries' || resourcePath.startsWith('binaries/')) {
      return 'resources/binaries/other';
    }
    if (resourcePath === 'sample-workspaces' || resourcePath.startsWith('sample-workspaces/')) {
      return 'resources/sample-workspaces';
    }
    if (resourcePath === 'tracks' || resourcePath.startsWith('tracks/')) {
      return 'resources/tracks';
    }
    return 'resources/other';
  }

  if (
    filePath.startsWith('Contents/Helpers/') ||
    filePath === 'Contents/Helpers' ||
    filePath.startsWith('Helpers/') ||
    filePath === 'Helpers'
  ) {
    return 'native-helpers';
  }
  return 'electron-runtime';
}

const PRIMER3_RUNTIME_DATA_FILES = new Set([
  'src/libprimer3/ABOUT.txt',
  'src/libprimer3/LICENSE.txt',
  'src/libprimer3/gpl-2.0.txt',
  'src/libprimer3/humrep_and_simple.txt',
]);

function isForbiddenPrimer3SidecarPayload(filePath) {
  const match =
    /^(?:Contents\/Resources|resources)\/binaries\/waypoint-api-[^/]+\/primer3\/(.+)$/u.exec(
      filePath
    );
  if (!match) return false;

  const primer3Path = match[1];
  if (/^(?:p3helpers|thermoanalysis)\.(?:dll|dylib|pyd|so)$/u.test(primer3Path)) {
    return false;
  }
  if (primer3Path.startsWith('src/libprimer3/primer3_config/')) return false;
  return !PRIMER3_RUNTIME_DATA_FILES.has(primer3Path);
}

const APPROVED_ELECTRON_LOCALES = new Set(['en', 'en-US']);

function packagedElectronLocale(filePath) {
  const macMatch =
    /^(?:Contents\/Resources|Contents\/Frameworks\/Electron Framework\.framework\/Versions\/A\/Resources)\/([^/]+)\.lproj\/.+$/u.exec(
      filePath
    );
  if (macMatch) return macMatch[1];

  const nonMacMatch = /^locales\/([^/]+)\.pak$/u.exec(filePath);
  return nonMacMatch ? nonMacMatch[1] : null;
}

function isForbiddenElectronLocale(filePath) {
  const locale = packagedElectronLocale(filePath);
  return locale !== null && !APPROVED_ELECTRON_LOCALES.has(locale);
}

function installedPackageCompositionReceipt(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('installed package inventory must be an array');
  }

  const normalizedEntries = [];
  const seenPaths = new Set();
  for (const entry of entries) {
    const filePath = entry?.path;
    if (
      typeof filePath !== 'string' ||
      filePath.length === 0 ||
      filePath.startsWith('/') ||
      filePath.includes('\\') ||
      path.posix.normalize(filePath) !== filePath ||
      filePath === '.'
    ) {
      throw new Error(`installed package contains an invalid relative path: ${String(filePath)}`);
    }
    if (seenPaths.has(filePath)) {
      throw new Error(`installed package contains a duplicate path: ${filePath}`);
    }
    seenPaths.add(filePath);

    const bytes = entry?.bytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`installed package contains an invalid byte count: ${filePath}`);
    }
    const kind = entry?.kind ?? 'file';
    if (kind !== 'file' && kind !== 'symlink') {
      throw new Error(`installed package contains an unsupported entry type: ${filePath}`);
    }
    normalizedEntries.push({ path: filePath, bytes, kind });
  }

  const categories = new Map();
  for (const entry of normalizedEntries) {
    const name = installedPackageCompositionCategory(entry.path);
    const current = categories.get(name) ?? { name, bytes: 0, fileCount: 0 };
    current.bytes += entry.bytes;
    current.fileCount += 1;
    categories.set(name, current);
  }
  const compareSizeThenName = (left, right) =>
    right.bytes - left.bytes || left.name.localeCompare(right.name);

  return {
    schema: 1,
    totalBytes: normalizedEntries.reduce((total, entry) => total + entry.bytes, 0),
    fileCount: normalizedEntries.length,
    symlinkCount: normalizedEntries.filter((entry) => entry.kind === 'symlink').length,
    categories: [...categories.values()].sort(compareSizeThenName),
    largestFiles: [...normalizedEntries]
      .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
      .slice(0, 20),
    forbiddenEntries: normalizedEntries
      .map((entry) => entry.path)
      .filter(isForbiddenPrimer3SidecarPayload)
      .sort(),
    forbiddenElectronLocaleEntries: normalizedEntries
      .map((entry) => entry.path)
      .filter(isForbiddenElectronLocale)
      .sort(),
  };
}

function installedPackageCompositionProblems(receipt, platform) {
  const problems = [];
  const limits = INSTALLED_PACKAGE_COMPOSITION_LIMITS[platform];
  if (!limits) {
    return [`installed package composition has an unsupported platform: ${String(platform)}`];
  }
  if (!Number.isSafeInteger(receipt?.totalBytes) || receipt.totalBytes < 0) {
    return ['installed package composition receipt has an invalid total byte count'];
  }
  const forbiddenEntries = receipt?.forbiddenEntries ?? [];
  if (forbiddenEntries.length > 0) {
    const additionalEntryCount = forbiddenEntries.length - 1;
    problems.push(
      `installed sidecar contains forbidden Primer3 build payload: ${forbiddenEntries[0]}` +
        (additionalEntryCount > 0
          ? ` (+${additionalEntryCount} more ${additionalEntryCount === 1 ? 'entry' : 'entries'})`
          : '')
    );
  }
  const forbiddenElectronLocaleEntries = receipt?.forbiddenElectronLocaleEntries ?? [];
  if (forbiddenElectronLocaleEntries.length > 0) {
    const additionalEntryCount = forbiddenElectronLocaleEntries.length - 1;
    problems.push(
      `installed application contains unsupported Electron locale: ${forbiddenElectronLocaleEntries[0]}` +
        (additionalEntryCount > 0
          ? ` (+${additionalEntryCount} more ${additionalEntryCount === 1 ? 'entry' : 'entries'})`
          : '')
    );
  }
  const formatMiB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  const addLimitProblem = (label, bytes, limit) => {
    if (bytes > limit) {
      const subject = label ? `installed application ${label}` : 'installed application';
      problems.push(
        `${subject} is ${formatMiB(bytes)}; the reviewed ceiling is ${formatMiB(limit)}`
      );
    }
  };
  const categoryBytes = (predicate) =>
    (receipt.categories ?? [])
      .filter((category) => predicate(category?.name))
      .reduce(
        (total, category) => total + (Number.isSafeInteger(category.bytes) ? category.bytes : 0),
        0
      );

  addLimitProblem('', receipt.totalBytes, limits.totalBytes);
  addLimitProblem(
    'resources/binaries/**',
    categoryBytes((name) => name?.startsWith('resources/binaries/')),
    limits.binaryBytes
  );
  addLimitProblem(
    'resources/app.asar.unpacked',
    categoryBytes((name) => name === 'resources/app.asar.unpacked'),
    limits.asarUnpackedBytes
  );
  addLimitProblem(
    'electron-runtime',
    categoryBytes((name) => name === 'electron-runtime'),
    limits.electronRuntimeBytes
  );
  addLimitProblem(
    'resources/sample-workspaces',
    categoryBytes((name) => name === 'resources/sample-workspaces'),
    limits.sampleWorkspaceBytes
  );
  addLimitProblem(
    'resources/tracks',
    categoryBytes((name) => name === 'resources/tracks'),
    limits.trackBytes
  );
  return problems;
}

function isImportMetaUrl(node) {
  const ts = require('typescript');
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'url' &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === 'meta'
  );
}

function isImportMetaDirname(node) {
  const ts = require('typescript');
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'dirname' &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === 'meta'
  );
}

function isImportMetaDirnameJoin(node) {
  const ts = require('typescript');
  const callee = node.expression;
  const isJoin =
    (ts.isIdentifier(callee) && callee.text === 'join') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'join');
  return isJoin && node.arguments.length === 2 && isImportMetaDirname(node.arguments[0]);
}

function isJavaScriptLikeUrl(value) {
  return /\.(?:cjs|mjs|js)(?:[?#]|$)/u.test(value);
}

function literalMainJavaScriptReferences(sourcePath, sourceText) {
  const ts = require('typescript');
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    throw new Error(
      `main-process JavaScript could not be parsed at ${sourcePath}: ` +
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    );
  }

  const references = [];
  const addLiteral = (node, label, kind) => {
    if (!node || !ts.isStringLiteralLike(node)) {
      throw new Error(`${sourcePath} contains a non-literal ${label}`);
    }
    references.push({ specifier: node.text, kind });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        addLiteral(node.moduleSpecifier, 'static module reference', 'module');
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      addLiteral(node.arguments[0], 'dynamic import', 'module');
    } else if (ts.isCallExpression(node) && isImportMetaDirnameJoin(node)) {
      const target = node.arguments[1];
      if (ts.isStringLiteralLike(target) && /\.js$/u.test(target.text)) {
        const text = target.text.startsWith('.') ? target.text : `./${target.text}`;
        const resolved = path.posix.normalize(
          path.posix.join(path.posix.dirname(sourcePath), text)
        );
        if (resolved.startsWith('out/main/')) references.push({ specifier: text, kind: 'module' });
      }
    } else if (ts.isNewExpression(node)) {
      const isDirectUrl = ts.isIdentifier(node.expression) && node.expression.text === 'URL';
      const firstArgument = node.arguments?.[0];
      const literalValue =
        firstArgument && ts.isStringLiteralLike(firstArgument) ? firstArgument.text : null;
      const isJavaScriptReference = literalValue !== null && isJavaScriptLikeUrl(literalValue);
      if (isDirectUrl && node.arguments?.length === 2 && isImportMetaUrl(node.arguments[1])) {
        addLiteral(firstArgument, 'import.meta.url reference', 'url');
      } else if (isJavaScriptReference) {
        throw new Error(`${sourcePath} contains an unsupported JavaScript URL reference`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function verifyMainJavaScriptGraph({ packageMain, files }) {
  if (packageMain !== PACKAGED_MAIN_ENTRY) {
    throw new Error(
      `package.json main must be exactly ${PACKAGED_MAIN_ENTRY}; found ${JSON.stringify(packageMain)}`
    );
  }
  if (!Array.isArray(files)) throw new Error('main-process JavaScript inventory is invalid');

  const inventory = new Map();
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      /[\\\0?#%]/u.test(file.path) ||
      file.path !== path.posix.normalize(file.path) ||
      !file.path.startsWith('out/main/') ||
      !file.path.endsWith('.js')
    ) {
      throw new Error(`invalid main-process JavaScript path: ${JSON.stringify(file?.path)}`);
    }
    if (inventory.has(file.path)) {
      throw new Error(`duplicate main-process JavaScript path: ${file.path}`);
    }
    inventory.set(
      file.path,
      Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content)
    );
  }
  if (!inventory.has(PACKAGED_MAIN_ENTRY)) {
    throw new Error(`package.json main does not exist in the package: ${PACKAGED_MAIN_ENTRY}`);
  }

  const reachable = new Set();
  const pending = [PACKAGED_MAIN_ENTRY];
  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (reachable.has(currentPath)) continue;
    reachable.add(currentPath);
    const content = inventory.get(currentPath);
    if (!content) throw new Error(`referenced main-process JavaScript is missing: ${currentPath}`);

    const references = literalMainJavaScriptReferences(currentPath, content.toString('utf8'));
    for (const { specifier: reference, kind } of references) {
      const isRelative = reference.startsWith('./') || reference.startsWith('../');
      const isNodeBuiltin =
        reference.startsWith('node:') && builtinModules.includes(reference.slice('node:'.length));
      const isForbiddenModuleShape =
        reference.startsWith('.') ||
        reference.startsWith('/') ||
        reference.startsWith('\\') ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference) ||
        /^[A-Za-z]:[\\/]/u.test(reference) ||
        reference.includes('\\');
      if (isRelative) {
        if (/[\\\0?#%]/u.test(reference) || !reference.endsWith('.js')) {
          throw new Error(
            `${currentPath} contains an invalid local JavaScript reference: ${reference}`
          );
        }
      } else {
        if (
          (kind === 'module' && isForbiddenModuleShape && !isNodeBuiltin) ||
          (kind === 'url' && isJavaScriptLikeUrl(reference))
        ) {
          throw new Error(
            `${currentPath} contains a forbidden non-relative JavaScript reference: ${reference}`
          );
        }
        continue;
      }
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(currentPath), reference)
      );
      if (!resolved.startsWith('out/main/')) {
        throw new Error(`${currentPath} references JavaScript outside out/main: ${reference}`);
      }
      if (!inventory.has(resolved)) {
        throw new Error(`${currentPath} references missing main-process JavaScript: ${reference}`);
      }
      pending.push(resolved);
    }
  }

  const orphanPaths = [...inventory.keys()].filter((filePath) => !reachable.has(filePath)).sort();
  if (orphanPaths.length > 0) {
    throw new Error(
      `package contains unreferenced main-process JavaScript: ${orphanPaths.join(', ')}`
    );
  }

  const paths = [...reachable].sort();
  const buffers = paths.map((filePath) => inventory.get(filePath));
  return {
    buffer: Buffer.concat(buffers.flatMap((buffer) => [buffer, Buffer.from('\n')])),
    entryBuffer: inventory.get(PACKAGED_MAIN_ENTRY),
    paths,
    sizeBytes: buffers.reduce((total, buffer) => total + buffer.length, 0),
  };
}

function requiredAsarPackageProblems(packageNames) {
  return REQUIRED_ASAR_PACKAGES.filter((packageName) => !packageNames.has(packageName)).map(
    (packageName) => `required runtime package is missing from app.asar: ${packageName}`
  );
}

function asarPackageInventoryPolicy(packageNames, baselinePackageNames) {
  const blockingProblems = requiredAsarPackageProblems(packageNames);
  if (baselinePackageNames === null) {
    return { blockingProblems, informationalRemovals: [] };
  }

  const requiredPackages = new Set(REQUIRED_ASAR_PACKAGES);
  const informationalRemovals = [...baselinePackageNames]
    .filter((packageName) => !packageNames.has(packageName) && !requiredPackages.has(packageName))
    .sort();
  return { blockingProblems, informationalRemovals };
}


function filterBinaryEntries(entries) {
  return entries.filter(
    (e) =>
      (typeof e.isFile === 'function' && e.isFile()) ||
      (typeof e.isSymbolicLink === 'function' && e.isSymbolicLink()) ||
      (typeof e.isDirectory === 'function' && e.isDirectory())
  );
}

function findSidecarEntry(filteredEntries) {
  return filteredEntries.find(
    (e) =>
      e.name.startsWith('waypoint-api-') && typeof e.isDirectory === 'function' && e.isDirectory()
  );
}

function sidecarBundleProblem(entries, expectedName) {
  const matches = entries.filter((entry) => entry.name.startsWith('waypoint-api-'));
  if (matches.length !== 1 || matches[0].name !== expectedName) {
    return (
      `expected exactly one target sidecar directory (${expectedName}); found: ` +
      (matches.map((entry) => entry.name).join(', ') || '<none>')
    );
  }
  const [entry] = matches;
  if (typeof entry.isDirectory !== 'function' || !entry.isDirectory()) {
    return `${expectedName} is not a standalone sidecar directory`;
  }
  return null;
}

function findMissingToolPrefixes(filteredEntries, expectedPrefixes) {
  const names = filteredEntries.map((e) => e.name);
  return expectedPrefixes.filter((prefix) => !names.some((name) => name.startsWith(prefix)));
}

function mcpStdioProbeProblem(probe) {
  if (probe.error) {
    return `could not execute packaged sidecar --mcp-stdio: ${probe.error.message}`;
  }
  const output = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  if (probe.status !== 0) {
    return (
      `packaged sidecar --mcp-stdio exited with status ${String(probe.status)}` +
      (output.trim() ? `: ${output.trim()}` : '')
    );
  }
  if ((probe.stdout || '').length > 0) {
    return (
      'packaged sidecar --mcp-stdio wrote to stdout before receiving a request' +
      `: ${JSON.stringify(probe.stdout)}`
    );
  }
  return null;
}

function helperPlatformSuffix(platform, arch) {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'aarch64')) {
    return 'aarch64-apple-darwin';
  }
  if (platform === 'darwin' && (arch === 'x64' || arch === 'x86_64')) {
    return 'x86_64-apple-darwin';
  }
  if (platform === 'linux' && (arch === 'x64' || arch === 'x86_64')) {
    return 'x86_64-unknown-linux-musl';
  }
  if (platform === 'linux' && (arch === 'arm64' || arch === 'aarch64')) {
    return 'aarch64-unknown-linux-musl';
  }
  if (platform === 'win32' && (arch === 'x64' || arch === 'x86_64' || arch === 'amd64')) {
    return 'x86_64-pc-windows-msvc';
  }
  throw new Error(`Unsupported helper platform: ${platform}/${arch}`);
}

function helperExecutableName(helper, platform, arch) {
  const extension = platform === 'win32' ? '.exe' : '';
  return `${helper}-${helperPlatformSuffix(platform, arch)}${extension}`;
}

function helperInstallNeedsFsync(platform) {
  return platform !== 'win32';
}

function asarEntryPath(_platform, ...segments) {
  const entryPath = _platform === 'win32' ? path.win32 : path.posix;
  return entryPath.join(...segments);
}

function resolveAsarEntryPath(archiveEntries, expectedEntry) {
  const canonicalExpected = expectedEntry.replace(/^[\\/]+/, '').replace(/\\/g, '/');
  const match = archiveEntries.find((entry) => {
    const canonicalEntry = entry.replace(/^[\\/]+/, '').replace(/\\/g, '/');
    return canonicalEntry === canonicalExpected;
  });

  if (!match) {
    throw new Error(`"${canonicalExpected}" was not listed in this archive`);
  }

  return match.replace(/^[\\/]+/, '');
}

const RELEASE_BUILD_STAMP = 'DNAFORGE_RELEASE_BUILD=1::SCHEMA_MIGRATION_AUTHORITY_V1::END';
const RELEASE_B_HOSTED_PREFIX = 'DNAFORGE_RELEASE_B_HOSTED=1::HOSTED_GATEWAY_ORIGIN=';
const RELEASE_B_HOSTED_SUFFIX = '::HOSTED_GATEWAY_AUTHORITY_V1::END';
const QUALIFICATION_EPHEMERAL_AUTH_PREFIX = 'DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH=';
const QUALIFICATION_EPHEMERAL_AUTH_SUFFIX = '::QUALIFICATION_EPHEMERAL_AUTH_V1::END';
const RELEASE_B_HOSTED_VALIDATOR_LITERAL = String.raw`/^DNAFORGE_RELEASE_B_HOSTED=1::HOSTED_GATEWAY_ORIGIN=https:\/\/[^/\s]+::HOSTED_GATEWAY_AUTHORITY_V1::END$/u`;

function withoutHostedValidatorRegexLiterals(text) {
  const ts = require('typescript');
  const sourceFile = ts.createSourceFile(
    'packaged-main-authority.ts',
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS
  );
  const ranges = [];
  const visit = (node) => {
    if (
      ts.isRegularExpressionLiteral(node) &&
      node.getText(sourceFile) === RELEASE_B_HOSTED_VALIDATOR_LITERAL
    ) {
      ranges.push([node.getStart(sourceFile), node.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (ranges.length === 0) return text;

  const parts = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    parts.push(text.slice(cursor, start), ' '.repeat(end - start));
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

const PACKAGE_IDENTITIES = Object.freeze({
  stable: Object.freeze({
    appId: 'com.dnaforge.desktop',
    bundleName: 'DNAForge.app',
    productName: 'DNAForge',
    executableName: 'DNAForge',
    packageName: '@waypoint/desktop',
    updaterCacheDirName: '@waypointdesktop-updater',
  }),
  validation: Object.freeze({
    appId: 'com.dnaforge.desktop.validation',
    bundleName: 'DNAForge Validation.app',
    productName: 'DNAForge Validation',
    executableName: 'DNAForge Validation',
    packageName: 'dnaforge-validation',
    updaterCacheDirName: 'dnaforge-validation-updater',
  }),
});

const STABLE_URL_TYPES = Object.freeze([
  Object.freeze({
    CFBundleTypeRole: 'Editor',
    CFBundleURLName: 'DNAForge Sign-in',
    CFBundleURLSchemes: Object.freeze(['dnaforge', 'dnaforge-beta']),
  }),
]);

function installedAppIdentityProblems(input) {
  const expected = PACKAGE_IDENTITIES[input.identity];
  if (!expected) throw new Error(`Unsupported packaged identity: ${String(input.identity)}`);
  if (input.platform !== 'darwin' && input.platform !== 'win32') {
    throw new Error(`Unsupported packaged platform: ${String(input.platform)}`);
  }

  const problems = [];
  const exact = (label, actual, wanted) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      problems.push(`${label} must be ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
    }
  };

  const metadata = input.packageMetadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    problems.push('app.asar package.json must be a JSON object');
  } else {
    exact('app.asar package name', metadata.name, expected.packageName);
    exact('app.asar productName', metadata.productName, expected.productName);
    exact('app.asar package version', metadata.version, input.expectedVersion);
  }

  const updateConfig = input.updateConfig;
  if (!updateConfig || typeof updateConfig !== 'object' || Array.isArray(updateConfig)) {
    problems.push('app-update.yml must be a YAML mapping');
  } else {
    exact('app-update.yml provider', updateConfig.provider, 'github');
    exact('app-update.yml owner', updateConfig.owner, 'humic-labs');
    exact('app-update.yml repo', updateConfig.repo, 'dnaforge');
    exact('app-update.yml releaseType', updateConfig.releaseType, 'draft');
    exact('app-update.yml private', updateConfig.private, true);
    exact(
      'app-update.yml updaterCacheDirName',
      updateConfig.updaterCacheDirName,
      expected.updaterCacheDirName
    );
    if (input.platform === 'win32') {
      exact('app-update.yml publisherName', updateConfig.publisherName, [
        'C=US, S=California, L=San Francisco, O=Humic Labs Inc., CN=Humic Labs Inc.',
      ]);
    }
  }

  if (input.platform === 'win32') {
    exact('Windows executable name', input.executableName, `${expected.executableName}.exe`);
    return problems;
  }

  exact(`${input.identity} bundle name`, path.basename(input.appRoot), expected.bundleName);
  const plist = input.plist;
  if (!plist || typeof plist !== 'object' || Array.isArray(plist)) {
    problems.push('Info.plist must decode to a mapping');
    return problems;
  }
  exact('Info.plist CFBundleIdentifier', plist.CFBundleIdentifier, expected.appId);
  exact('Info.plist CFBundleName', plist.CFBundleName, expected.productName);
  exact('Info.plist CFBundleDisplayName', plist.CFBundleDisplayName, expected.productName);
  exact('Info.plist CFBundleExecutable', plist.CFBundleExecutable, expected.executableName);
  exact('Info.plist CFBundlePackageType', plist.CFBundlePackageType, 'APPL');
  exact('Info.plist CFBundleIconFile', plist.CFBundleIconFile, 'icon.icns');
  exact(
    'Info.plist CFBundleShortVersionString',
    plist.CFBundleShortVersionString,
    input.expectedVersion
  );
  exact('Info.plist CFBundleVersion', plist.CFBundleVersion, input.expectedVersion);

  if (input.identity === 'stable') {
    exact('Info.plist CFBundleURLTypes', plist.CFBundleURLTypes, STABLE_URL_TYPES);
  } else if (
    plist.CFBundleURLTypes !== undefined &&
    (!Array.isArray(plist.CFBundleURLTypes) || plist.CFBundleURLTypes.length !== 0)
  ) {
    problems.push('validation app must not register stable URL protocols');
  }

  if (!Number.isSafeInteger(input.packagedIconSize) || input.packagedIconSize <= 0) {
    problems.push('packaged icon.icns must exist and be non-empty');
  }
  if (!/^[0-9a-f]{64}$/.test(input.packagedIconSha256 ?? '')) {
    problems.push('packaged icon.icns SHA-256 is invalid');
  } else if (!/^[0-9a-f]{64}$/.test(input.expectedIconSha256 ?? '')) {
    problems.push('canonical stable icon.icns SHA-256 is invalid');
  } else if (input.identity === 'stable' && input.packagedIconSha256 !== input.expectedIconSha256) {
    problems.push(
      `packaged icon.icns SHA-256 ${input.packagedIconSha256} does not match stable icon ${input.expectedIconSha256}`
    );
  } else if (
    input.identity === 'validation' &&
    input.packagedIconSha256 === input.expectedIconSha256
  ) {
    problems.push('validation icon.icns must differ from the stable production icon');
  }

  return problems;
}

function verifyUpdateFeedAuthority(mainBundle, expectedAuthority) {
  const text = mainBundle.toString();
  const matches = [...text.matchAll(/const UPDATE_FEED_BASE = "([^"]*)";/gu)].map(
    (match) => match[1]
  );
  if (matches.length !== 1) {
    return {
      ok: false,
      feedBase: null,
      message: 'packaged main bundle must carry exactly one updater feed authority',
    };
  }
  const [feedBase] = matches;
  if (!feedBase) {
    return {
      ok: false,
      feedBase,
      message: 'packaged updater feed authority is empty',
    };
  }
  const expectedBases = Array.isArray(expectedAuthority)
    ? [...expectedAuthority]
    : [expectedAuthority];
  const expectedBase = expectedBases[0];
  if (feedBase !== expectedBase) {
    return {
      ok: false,
      feedBase,
      message: `packaged updater feed authority ${feedBase} does not match expected ${expectedBase}`,
    };
  }
  if (!Array.isArray(expectedAuthority)) {
    return {
      ok: true,
      feedBase,
      message: `updater feed authority is pinned to ${feedBase}`,
    };
  }
  if (
    expectedBases.length < 1 ||
    expectedBases.some((base) => typeof base !== 'string' || base.length === 0) ||
    new Set(expectedBases).size !== expectedBases.length
  ) {
    return {
      ok: false,
      feedBase,
      feedBases: null,
      message: 'expected updater authority contract must contain at least one unique origin',
    };
  }

  const authorityPayloads = [
    ...text.matchAll(/DNAFORGE_UPDATE_AUTHORITIES=([A-Za-z0-9_-]+)::UPDATE_AUTHORITY_V2::END/gu),
  ].map((match) => match[1]);
  if (authorityPayloads.length !== 1) {
    return {
      ok: false,
      feedBase,
      feedBases: null,
      message:
        'packaged main bundle must carry exactly one sealed ordered updater authority marker',
    };
  }
  let feedBases;
  const encodedAuthorities = authorityPayloads[0];
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(encodedAuthorities)) {
      throw new Error('non-base64url payload');
    }
    const authorityBytes = Buffer.from(encodedAuthorities, 'base64url');
    if (authorityBytes.toString('base64url') !== encodedAuthorities) {
      throw new Error('non-canonical base64url payload');
    }
    feedBases = JSON.parse(authorityBytes.toString('utf8'));
  } catch {
    return {
      ok: false,
      feedBase,
      feedBases: null,
      message: 'packaged updater authority marker is not canonical base64url JSON',
    };
  }
  if (
    !Array.isArray(feedBases) ||
    feedBases.length < 1 ||
    feedBases.some((base) => typeof base !== 'string' || base.length === 0) ||
    new Set(feedBases).size !== feedBases.length
  ) {
    return {
      ok: false,
      feedBase,
      feedBases: Array.isArray(feedBases) ? feedBases : null,
      message: 'packaged updater authority list must contain at least one unique origin',
    };
  }
  if (feedBase !== feedBases[0]) {
    return {
      ok: false,
      feedBase,
      feedBases,
      message: `packaged updater compatibility primary ${feedBase} does not match ordered primary ${feedBases[0]}`,
    };
  }
  if (JSON.stringify(feedBases) !== JSON.stringify(expectedBases)) {
    return {
      ok: false,
      feedBase,
      feedBases,
      message:
        `packaged updater authorities ${feedBases.join(', ')} do not match expected order ` +
        expectedBases.join(', '),
    };
  }
  return {
    ok: true,
    feedBase,
    feedBases,
    message: `updater feed authorities are pinned in order to ${feedBases.join(', ')}`,
  };
}

function verifySourceCommitStamp(mainBundle, expectedCommit = null) {
  const text = mainBundle.toString();
  const matches = [
    ...text.matchAll(/DNAFORGE_SOURCE_COMMIT=([0-9a-f]{40})::SOURCE_COMMIT_PROVENANCE_V1::END/gu),
  ].map((match) => match[1]);
  const uniqueMatches = [...new Set(matches)];
  if (uniqueMatches.length !== 1) {
    return {
      ok: false,
      sourceCommit: null,
      message: `packaged main bundle must carry one unique source commit stamp; found ${uniqueMatches.length}`,
    };
  }
  const sourceCommit = uniqueMatches[0];
  if (expectedCommit !== null && sourceCommit !== expectedCommit) {
    return {
      ok: false,
      sourceCommit,
      message: `packaged source commit ${sourceCommit} does not match expected ${expectedCommit}`,
    };
  }
  return { ok: true, sourceCommit, message: `source commit ${sourceCommit} is embedded` };
}

function verifyReleaseBuildStamp(mainBundle, requireReleaseStamp) {
  const present = mainBundle.toString().includes(RELEASE_BUILD_STAMP);
  if (requireReleaseStamp && !present) {
    return {
      ok: false,
      present,
      message: `release artifact is missing ${RELEASE_BUILD_STAMP}`,
    };
  }
  if (!requireReleaseStamp && present) {
    return {
      ok: false,
      present,
      message: `local artifact unexpectedly contains ${RELEASE_BUILD_STAMP}`,
    };
  }
  return {
    ok: true,
    present,
    message: requireReleaseStamp
      ? 'release-only database migration stamp is present'
      : 'release-only database migration stamp is absent',
  };
}

function canonicalHttpsOrigin(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null;
  }
  return url.origin;
}

function hostedGatewayExpectationFromEnv(env) {
  const flag = env.DNAFORGE_RELEASE_B_HOSTED;
  if (flag === undefined || flag === '' || flag === '0') return null;
  if (flag !== '1') {
    throw new Error('DNAFORGE_RELEASE_B_HOSTED must be exactly 1 or 0');
  }
  const gatewayOrigin = canonicalHttpsOrigin(env.DNAFORGE_HOSTED_AI_GATEWAY_URL);
  if (!gatewayOrigin) {
    throw new Error(
      'DNAFORGE_HOSTED_AI_GATEWAY_URL must be one canonical HTTPS origin when Release B Hosted is enabled'
    );
  }
  return gatewayOrigin;
}

function verifyHostedGatewayAuthority(mainBundle, expectedGatewayOrigin) {
  const text = withoutHostedValidatorRegexLiterals(mainBundle.toString());
  const expression = new RegExp(
    `${RELEASE_B_HOSTED_PREFIX}([^"'\\s]+?)${RELEASE_B_HOSTED_SUFFIX.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    )}`,
    'g'
  );
  const matches = [...text.matchAll(expression)];
  const prefixCount = text.split(RELEASE_B_HOSTED_PREFIX).length - 1;
  const containsPrefix = prefixCount > 0;

  if (expectedGatewayOrigin === null) {
    if (!containsPrefix) {
      return {
        ok: true,
        enabled: false,
        gatewayOrigin: null,
        message: 'Release A contains no active Hosted gateway authority',
      };
    }
    const embedded = matches.length === 1 ? canonicalHttpsOrigin(matches[0][1]) : null;
    return {
      ok: false,
      enabled: true,
      gatewayOrigin: embedded,
      message: 'Release A unexpectedly contains an active Hosted gateway authority',
    };
  }

  const expected = canonicalHttpsOrigin(expectedGatewayOrigin);
  if (!expected || expected !== expectedGatewayOrigin) {
    return {
      ok: false,
      enabled: containsPrefix,
      gatewayOrigin: null,
      message: `expected Hosted gateway is not one canonical HTTPS origin: ${expectedGatewayOrigin}`,
    };
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      enabled: containsPrefix,
      gatewayOrigin: null,
      message: `Release B must contain exactly one complete Hosted gateway authority; found ${matches.length}`,
    };
  }
  if (prefixCount !== 1) {
    return {
      ok: false,
      enabled: containsPrefix,
      gatewayOrigin: null,
      message: `Release B contains ${prefixCount} Hosted authority prefixes but exactly one is permitted`,
    };
  }
  const embedded = canonicalHttpsOrigin(matches[0][1]);
  if (!embedded || embedded !== matches[0][1]) {
    return {
      ok: false,
      enabled: true,
      gatewayOrigin: embedded,
      message: 'Release B contains a malformed Hosted gateway authority',
    };
  }
  if (embedded !== expected) {
    return {
      ok: false,
      enabled: true,
      gatewayOrigin: embedded,
      message: `Release B Hosted gateway ${embedded} does not match expected ${expected}`,
    };
  }
  return {
    ok: true,
    enabled: true,
    gatewayOrigin: embedded,
    message: `Release B Hosted gateway authority is pinned to ${embedded}`,
  };
}

function verifyHostedGatewayGraphAuthority(mainGraphBundle, expectedGatewayOrigin) {
  const text = withoutHostedValidatorRegexLiterals(mainGraphBundle.toString());
  const expression = new RegExp(
    `${RELEASE_B_HOSTED_PREFIX}([^"'\\s]+?)${RELEASE_B_HOSTED_SUFFIX.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    )}`,
    'g'
  );
  const matches = [...text.matchAll(expression)];
  const prefixCount = text.split(RELEASE_B_HOSTED_PREFIX).length - 1;
  const expected = canonicalHttpsOrigin(expectedGatewayOrigin);
  if (!expected || expected !== expectedGatewayOrigin) {
    return {
      ok: false,
      enabled: prefixCount > 0,
      gatewayOrigin: null,
      message: `expected Hosted gateway is not one canonical HTTPS origin: ${expectedGatewayOrigin}`,
    };
  }
  if (matches.length === 0 || matches.length !== prefixCount) {
    return {
      ok: false,
      enabled: prefixCount > 0,
      gatewayOrigin: null,
      message:
        'Release B reachable graph must contain only complete Hosted gateway authorities; ' +
        `found ${matches.length} complete and ${prefixCount} prefix value(s)`,
    };
  }
  const values = matches.map((match) => match[1]);
  if (values.some((value) => canonicalHttpsOrigin(value) !== value)) {
    return {
      ok: false,
      enabled: true,
      gatewayOrigin: null,
      message: 'Release B reachable graph contains a malformed Hosted gateway authority',
    };
  }
  const uniqueValues = [...new Set(values)];
  if (uniqueValues.length !== 1 || uniqueValues[0] !== expected) {
    return {
      ok: false,
      enabled: true,
      gatewayOrigin: uniqueValues.length === 1 ? uniqueValues[0] : null,
      message: 'Release B reachable graph contains conflicting Hosted gateway authority',
    };
  }
  return {
    ok: true,
    enabled: true,
    gatewayOrigin: expected,
    message: `Release B reachable Hosted authority is consistent with ${expected}`,
  };
}

function verifyQualificationEphemeralAuth(mainBundle, expectedSourceCommit, mode = 'forbidden') {
  const text = mainBundle.toString();
  const expression = new RegExp(
    `${QUALIFICATION_EPHEMERAL_AUTH_PREFIX}([0-9a-f]{40})${QUALIFICATION_EPHEMERAL_AUTH_SUFFIX}`,
    'g'
  );
  const matches = [...text.matchAll(expression)];
  if (mode !== 'required' && mode !== 'forbidden') {
    return {
      ok: false,
      enabled: matches.length > 0,
      sourceCommit: matches.length === 1 ? matches[0][1] : null,
      message: 'qualification ephemeral auth verifier mode must be required or forbidden',
    };
  }
  if (mode === 'forbidden') {
    return {
      ok: matches.length === 0,
      enabled: matches.length > 0,
      sourceCommit: matches.length === 1 ? matches[0][1] : null,
      message:
        matches.length === 0
          ? 'package contains no qualification ephemeral auth authority'
          : `ordinary package must not contain qualification ephemeral auth authority; found ${matches.length}`,
    };
  }
  if (matches.length !== 1 || !/^[0-9a-f]{40}$/u.test(expectedSourceCommit ?? '')) {
    return {
      ok: false,
      enabled: matches.length > 0,
      sourceCommit: matches.length === 1 ? matches[0][1] : null,
      message: `package must contain exactly one qualification ephemeral auth authority; found ${matches.length}`,
    };
  }
  const sourceCommit = matches[0][1];
  if (sourceCommit !== expectedSourceCommit) {
    return {
      ok: false,
      enabled: true,
      sourceCommit,
      message: 'qualification ephemeral auth does not match packaged source commit',
    };
  }
  return {
    ok: true,
    enabled: true,
    sourceCommit,
    message: 'qualification ephemeral auth matches packaged source commit',
  };
}

const PACKAGED_AUTH_PREFIX = 'DNAFORGE_PACKAGED_AUTH=';
const PACKAGED_AUTH_SUFFIX = '::DESKTOP_AUTH_AUTHORITY_V1::END';
const RELEASE_A_AUTH_ORIGIN = 'https://dnaforge.com';
const RELEASE_A_HOSTED_MAIN_DISABLED_MARKER = 'DNAFORGE_RELEASE_A_HOSTED_MAIN:disabled';
const RELEASE_A_HOSTED_MAIN_ENABLED_MARKER = 'DNAFORGE_RELEASE_A_HOSTED_MAIN:enabled';
const RELEASE_A_HOSTED_GATEWAY_EMPTY_MARKER = 'DNAFORGE_RELEASE_A_HOSTED_GATEWAY:empty';
const RELEASE_A_HOSTED_GATEWAY_CONFIGURED_MARKER = 'DNAFORGE_RELEASE_A_HOSTED_GATEWAY:configured';
const RELEASE_A_HOSTED_RENDERER_DISABLED_MARKER = 'DNAFORGE_RELEASE_A_HOSTED_RENDERER:disabled';
const RELEASE_A_HOSTED_RENDERER_ENABLED_MARKER = 'DNAFORGE_RELEASE_A_HOSTED_RENDERER:enabled';
const RELEASE_A_HOSTED_RENDERER_IDENTIFIERS = ['dnaforge-hosted-auto', 'dnaforge-hosted-deep'];

function verifyPackagedAuthAuthority(mainBundle, expectedGatewayOrigin) {
  const text = mainBundle.toString();
  const expression = new RegExp(
    `${PACKAGED_AUTH_PREFIX}(release-a|release-b)::ORIGIN=([^"'\\s]+?)${PACKAGED_AUTH_SUFFIX.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    )}`,
    'g'
  );
  const matches = [...text.matchAll(expression)];
  const uniqueMatches = [
    ...new Map(matches.map((match) => [`${match[1]}\0${match[2]}`, match])).values(),
  ];
  if (uniqueMatches.length !== 1) {
    return {
      ok: false,
      kind: null,
      origin: null,
      message: `main bundle must contain one unique packaged auth authority; found ${uniqueMatches.length}`,
    };
  }
  const kind = uniqueMatches[0][1];
  const origin = canonicalHttpsOrigin(uniqueMatches[0][2]);
  if (!origin || origin !== uniqueMatches[0][2]) {
    return {
      ok: false,
      kind,
      origin,
      message: 'packaged auth authority contains a malformed origin',
    };
  }
  if (expectedGatewayOrigin === null) {
    if (kind !== 'release-a' || origin !== RELEASE_A_AUTH_ORIGIN) {
      return {
        ok: false,
        kind,
        origin,
        message: 'Release A packaged auth must use the canonical DNAForge web origin',
      };
    }
    return {
      ok: true,
      kind,
      origin,
      message: `Release A packaged auth is pinned to ${origin}`,
    };
  }
  const expected = canonicalHttpsOrigin(expectedGatewayOrigin);
  if (
    !expected ||
    expected !== expectedGatewayOrigin ||
    kind !== 'release-b' ||
    origin !== expected
  ) {
    return {
      ok: false,
      kind,
      origin,
      message: `Release B packaged auth must use the exact Hosted gateway ${expectedGatewayOrigin}`,
    };
  }
  return {
    ok: true,
    kind,
    origin,
    message: `Release B packaged auth proxy is pinned to ${origin}`,
  };
}

function releaseAAuthBundleProblems(input) {
  const problems = [];
  const main = input.mainBundle.toString();
  const authAuthority = verifyPackagedAuthAuthority(main, null);
  if (!authAuthority.ok) problems.push(authAuthority.message);
  if (!main.includes(RELEASE_A_HOSTED_MAIN_DISABLED_MARKER)) {
    problems.push('main bundle is missing the Release A Hosted-disabled marker');
  }
  if (main.includes(RELEASE_A_HOSTED_MAIN_ENABLED_MARKER)) {
    problems.push('Hosted main marker is enabled in a Release A artifact');
  }
  if (!main.includes(RELEASE_A_HOSTED_GATEWAY_EMPTY_MARKER)) {
    problems.push('main bundle is missing the Release A empty Hosted-gateway marker');
  }
  if (main.includes(RELEASE_A_HOSTED_GATEWAY_CONFIGURED_MARKER)) {
    problems.push('Hosted gateway is configured in a Release A artifact');
  }
  for (const gatewayUrl of input.forbiddenHostedGatewayUrls ?? []) {
    const normalized = gatewayUrl?.trim().replace(/\/+$/, '');
    if (normalized && main.includes(normalized)) {
      problems.push('main bundle contains the configured Hosted gateway URL');
    }
  }

  if (input.rendererBundles !== undefined) {
    const renderer = input.rendererBundles.map((bundle) => bundle.toString()).join('\n');
    if (!renderer.includes(RELEASE_A_HOSTED_RENDERER_DISABLED_MARKER)) {
      problems.push('renderer bundle is missing the Release A Hosted-disabled marker');
    }
    if (renderer.includes(RELEASE_A_HOSTED_RENDERER_ENABLED_MARKER)) {
      problems.push('Hosted renderer marker is enabled in a Release A artifact');
    }
    for (const identifier of RELEASE_A_HOSTED_RENDERER_IDENTIFIERS) {
      if (renderer.includes(identifier)) {
        problems.push(`renderer bundle advertises Hosted identifier ${identifier}`);
      }
    }
  }
  return problems;
}

function releaseBHostedBundleProblems(input) {
  const problems = [];
  const main = input.mainBundle.toString();
  const authAuthority = verifyPackagedAuthAuthority(main, input.expectedGatewayOrigin);
  if (!authAuthority.ok) problems.push(authAuthority.message);
  if (!main.includes(RELEASE_A_HOSTED_MAIN_ENABLED_MARKER)) {
    problems.push('main bundle is missing the Release B Hosted-enabled marker');
  }
  if (main.includes(RELEASE_A_HOSTED_MAIN_DISABLED_MARKER)) {
    problems.push('Hosted main marker is disabled in a Release B artifact');
  }
  if (!main.includes(RELEASE_A_HOSTED_GATEWAY_CONFIGURED_MARKER)) {
    problems.push('main bundle is missing the Release B configured-gateway marker');
  }
  if (main.includes(RELEASE_A_HOSTED_GATEWAY_EMPTY_MARKER)) {
    problems.push('Hosted gateway marker is empty in a Release B artifact');
  }

  if (input.rendererBundles !== undefined) {
    const renderer = input.rendererBundles.map((bundle) => bundle.toString()).join('\n');
    if (!renderer.includes(RELEASE_A_HOSTED_RENDERER_ENABLED_MARKER)) {
      problems.push('renderer bundle is missing the Release B Hosted-enabled marker');
    }
    if (renderer.includes(RELEASE_A_HOSTED_RENDERER_DISABLED_MARKER)) {
      problems.push('Hosted renderer marker is disabled in a Release B artifact');
    }
    for (const identifier of RELEASE_A_HOSTED_RENDERER_IDENTIFIERS) {
      if (!renderer.includes(identifier)) {
        problems.push(`renderer bundle is missing Hosted identifier ${identifier}`);
      }
    }
  }
  return problems;
}

function codexAppServerBinaryPath(resourcesDir, target) {
  const binaryName = path.basename(target.codexBinaryPathInPackage);
  return path.join(resourcesDir, 'binaries', 'codex-app-server', target.triple, 'bin', binaryName);
}

function codexAppServerStagedResourcePath(resourcesDir, target, resource) {
  const packagePrefix = `vendor/${target.triple}/`;
  if (!resource.pathInPackage.startsWith(packagePrefix)) {
    throw new Error(
      `Codex App Server resource path is outside ${packagePrefix}: ${resource.pathInPackage}`
    );
  }
  const targetRoot = path.resolve(resourcesDir, 'binaries', 'codex-app-server', target.triple);
  const codexRoot = path.resolve(resourcesDir, 'binaries', 'codex-app-server');
  const targetRelative = path.relative(codexRoot, targetRoot);
  if (
    targetRelative === '..' ||
    targetRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(targetRelative)
  ) {
    throw new Error(`Codex App Server target path escapes its resource root: ${target.triple}`);
  }
  const stagedPath = path.resolve(targetRoot, resource.pathInPackage.slice(packagePrefix.length));
  const stagedRelative = path.relative(targetRoot, stagedPath);
  if (
    stagedRelative === '..' ||
    stagedRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(stagedRelative)
  ) {
    throw new Error(
      `Codex App Server resource path escapes ${packagePrefix}: ${resource.pathInPackage}`
    );
  }
  return stagedPath;
}

function listRelativeFiles(root, dir = root) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).split(path.sep).join('/'));
    } else {
      files.push(`${path.relative(root, absolute).split(path.sep).join('/')} (non-file)`);
    }
  }
  return files.sort();
}

function sha256FileSync(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function codexAppServerIntegrityProblem({
  platform,
  arch,
  resourcesDir,
  manifest,
  windowsExecutableSignatureProblem,
}) {
  const target =
    manifest && manifest.supportedTargets && manifest.supportedTargets[`${platform}-${arch}`];
  if (!target) {
    return `Codex App Server is not listed in the manifest for ${platform}-${arch}`;
  }

  if (!target.verified) {
    return `Codex App Server target ${platform}-${arch} is not verified in this manifest`;
  }

  if (!Array.isArray(target.resources) || target.resources.length === 0) {
    return `Codex App Server target ${platform}-${arch} has no immutable resource inventory`;
  }

  const codexRoot = path.join(resourcesDir, 'binaries', 'codex-app-server');
  if (!fs.existsSync(codexRoot)) {
    return `Codex App Server resource root is missing: ${codexRoot}`;
  }

  const expectedFiles = [];
  for (const resource of target.resources) {
    if (
      typeof resource.pathInPackage !== 'string' ||
      !/^[0-9a-f]{64}$/.test(resource.sha256) ||
      typeof resource.executable !== 'boolean'
    ) {
      return `Codex App Server target ${platform}-${arch} has an invalid resource entry`;
    }
    let stagedPath;
    try {
      stagedPath = codexAppServerStagedResourcePath(resourcesDir, target, resource);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    expectedFiles.push(path.relative(codexRoot, stagedPath).split(path.sep).join('/'));
    if (!fs.existsSync(stagedPath)) {
      return `Codex App Server resource is missing: ${stagedPath}`;
    }
    const realCodexRoot = fs.realpathSync(codexRoot);
    const realStagedPath = fs.realpathSync(stagedPath);
    const realRelative = path.relative(realCodexRoot, realStagedPath);
    if (
      realRelative === '..' ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    ) {
      return `Codex App Server resource resolves outside its resource root: ${stagedPath}`;
    }
    const stat = fs.lstatSync(stagedPath);
    if (!stat.isFile()) {
      return `Codex App Server resource is not a regular file: ${stagedPath}`;
    }
    if (resource.executable) {
      const prefix = fs.readFileSync(stagedPath).slice(0, 1024);
      const integrityProblem = packagedHelperIntegrityProblem(stat, prefix, platform);
      if (integrityProblem) {
        return `Codex App Server executable at ${stagedPath} ${integrityProblem}`;
      }
    }
    const actual = sha256FileSync(stagedPath);
    if (actual !== resource.sha256) {
      if (
        platform === 'win32' &&
        resource.executable &&
        typeof windowsExecutableSignatureProblem === 'function'
      ) {
        const signatureProblem = windowsExecutableSignatureProblem(stagedPath);
        if (!signatureProblem) continue;
        return (
          `Codex App Server resource digest mismatch at ${stagedPath}: ` +
          `expected ${resource.sha256}, got ${actual}; ` +
          `Authenticode proof failed: ${signatureProblem}`
        );
      }
      return (
        `Codex App Server resource digest mismatch at ${stagedPath}: ` +
        `expected ${resource.sha256}, got ${actual}`
      );
    }
  }

  if (!manifest.license || !Array.isArray(manifest.license.files)) {
    return 'Codex App Server manifest has no license inventory';
  }
  for (const license of manifest.license.files) {
    const stagedPath = path.join(codexRoot, path.basename(license.path));
    expectedFiles.push(path.relative(codexRoot, stagedPath).split(path.sep).join('/'));
    if (!fs.existsSync(stagedPath)) {
      return `Codex App Server license file is missing: ${stagedPath}`;
    }
    const actual = sha256FileSync(stagedPath);
    if (actual !== license.sha256) {
      return `Codex App Server license digest mismatch at ${stagedPath}`;
    }
  }

  const actualFiles = listRelativeFiles(codexRoot);
  expectedFiles.sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    return (
      'Codex App Server staged inventory mismatch: ' +
      `expected ${expectedFiles.join(', ')}, got ${actualFiles.join(', ')}`
    );
  }

  return null;
}

const GIT_LFS_POINTER_MAX_BYTES = 1024;
const GIT_LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1';

function packagedHelperIntegrityProblem(stat, prefix, platform = process.platform) {
  if (!stat.isFile()) {
    return 'is not a regular file';
  }

  const prefixText = Buffer.isBuffer(prefix) ? prefix.toString('utf8') : String(prefix);
  if (stat.size <= GIT_LFS_POINTER_MAX_BYTES) {
    if (prefixText.startsWith(GIT_LFS_POINTER_HEADER)) {
      return 'is a Git LFS pointer, not a compiled executable';
    }
    return `is only ${stat.size} bytes (Git LFS pointer-sized), not a compiled executable`;
  }

  if (platform !== 'win32' && (stat.mode & 0o111) === 0) {
    return 'is not executable';
  }

  return null;
}

const NATIVE_COVERAGE_CONTRACT_SCHEMA = 'dnaforge.native-coverage-contract.v1';
const NATIVE_COVERAGE_CONTRACT_KEYS = ['cacheContract', 'engineIdentity', 'schema'];
const NATIVE_COVERAGE_ENGINE_IDENTITY = /^dna-coverage:schema-([1-9][0-9]*):sha256-([0-9a-f]{64})$/;

function parseNativeCoverageContractProbe(output, label) {
  let value;
  try {
    value = JSON.parse(String(output).trim());
  } catch (error) {
    throw new Error(
      `${label} did not emit valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} did not emit a JSON object`);
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(NATIVE_COVERAGE_CONTRACT_KEYS)) {
    throw new Error(`${label} emitted unexpected fields: ${keys.join(', ') || '(none)'}`);
  }
  if (value.schema !== NATIVE_COVERAGE_CONTRACT_SCHEMA) {
    throw new Error(`${label} emitted unsupported schema ${JSON.stringify(value.schema)}`);
  }
  if (typeof value.cacheContract !== 'string' || value.cacheContract.length === 0) {
    throw new Error(`${label} emitted an empty cache contract`);
  }
  if (
    typeof value.engineIdentity !== 'string' ||
    !NATIVE_COVERAGE_ENGINE_IDENTITY.test(value.engineIdentity)
  ) {
    throw new Error(
      `${label} emitted an invalid coverage-engine identity ${JSON.stringify(value.engineIdentity)}`
    );
  }
  return {
    schema: value.schema,
    cacheContract: value.cacheContract,
    engineIdentity: value.engineIdentity,
  };
}

function nativeCoverageContractProblem({
  sourceContract,
  packagedContract,
  packagedHelperSha256,
  packagedHelperSchema,
}) {
  if (!/^[0-9a-f]{64}$/.test(packagedHelperSha256)) {
    return `packaged helper SHA-256 is invalid: ${JSON.stringify(packagedHelperSha256)}`;
  }
  if (!Number.isSafeInteger(packagedHelperSchema) || packagedHelperSchema < 1) {
    return `packaged helper schema is invalid: ${JSON.stringify(packagedHelperSchema)}`;
  }
  if (sourceContract.schema !== packagedContract.schema) {
    return `frozen sidecar schema ${packagedContract.schema} differs from source ${sourceContract.schema}`;
  }
  if (sourceContract.cacheContract !== packagedContract.cacheContract) {
    return (
      `frozen sidecar cache contract ${packagedContract.cacheContract} differs from ` +
      `source ${sourceContract.cacheContract}`
    );
  }
  if (sourceContract.engineIdentity !== packagedContract.engineIdentity) {
    return (
      `frozen sidecar engine identity ${packagedContract.engineIdentity} differs from ` +
      `source ${sourceContract.engineIdentity}`
    );
  }
  const match = NATIVE_COVERAGE_ENGINE_IDENTITY.exec(packagedContract.engineIdentity);
  if (!match) {
    return `frozen sidecar engine identity is invalid: ${packagedContract.engineIdentity}`;
  }
  const reportedSchema = Number(match[1]);
  const reportedSha256 = match[2];
  if (reportedSchema !== packagedHelperSchema) {
    return (
      `frozen sidecar engine schema ${reportedSchema} differs from packaged helper ` +
      `schema ${packagedHelperSchema}`
    );
  }
  if (reportedSha256 !== packagedHelperSha256) {
    return (
      `frozen sidecar helper SHA-256 ${reportedSha256} differs from actual signed ` +
      `packaged helper ${packagedHelperSha256}`
    );
  }
  return null;
}

function verifyBuiltMainGraph(desktopRoot) {
  const outMain = path.join(desktopRoot, 'out', 'main');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        files.push({
          path: path.relative(desktopRoot, full).split(path.sep).join('/'),
          content: fs.readFileSync(full),
        });
      }
    }
  };
  walk(outMain);
  return verifyMainJavaScriptGraph({ packageMain: PACKAGED_MAIN_ENTRY, files });
}

if (require.main === module && process.argv[2] === '--main-graph') {
  const desktopRoot = path.resolve(process.argv[3] || path.join(__dirname, '..', '..'));
  try {
    const graph = verifyBuiltMainGraph(desktopRoot);
    console.log(`[main-graph] OK: ${graph.paths.length} main-process files, all reachable`);
  } catch (error) {
    console.error(`::error::[main-graph] ${error.message}`);
    console.error(
      'Every packaged installer would fail verify-package on this. See  for the last case.'
    );
    process.exit(1);
  }
}

module.exports = {
  verifyBuiltMainGraph,
  installedPackageCompositionReceipt,
  installedPackageCompositionProblems,
  packageCompositionReceipt,
  packageCompositionProblems,
  verifyMainJavaScriptGraph,
  requiredAsarPackageProblems,
  asarPackageInventoryPolicy,
  filterBinaryEntries,
  findSidecarEntry,
  sidecarBundleProblem,
  findMissingToolPrefixes,
  mcpStdioProbeProblem,
  helperPlatformSuffix,
  helperExecutableName,
  helperInstallNeedsFsync,
  asarEntryPath,
  resolveAsarEntryPath,
  verifyReleaseBuildStamp,
  verifySourceCommitStamp,
  verifyUpdateFeedAuthority,
  installedAppIdentityProblems,
  verifyHostedGatewayAuthority,
  verifyHostedGatewayGraphAuthority,
  verifyQualificationEphemeralAuth,
  verifyPackagedAuthAuthority,
  hostedGatewayExpectationFromEnv,
  releaseAAuthBundleProblems,
  releaseBHostedBundleProblems,
  packagedHelperIntegrityProblem,
  parseNativeCoverageContractProbe,
  nativeCoverageContractProblem,
  codexAppServerIntegrityProblem,
  codexAppServerBinaryPath,
};
