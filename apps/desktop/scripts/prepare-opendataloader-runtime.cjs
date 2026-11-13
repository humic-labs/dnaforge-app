#!/usr/bin/env node
const { createHash } = require('node:crypto');
const {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { Arch } = require('builder-util');

const DESKTOP_ROOT = resolve(__dirname, '..');
const MANIFEST_PATH = join(DESKTOP_ROOT, 'resources', 'opendataloader-runtime.json');
const MAX_RUNTIME_IMAGE_BYTES = 100_000_000;
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const desktopPackage = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'package.json'), 'utf8'));

function validateRuntimeContract(runtimeManifest, packageManifest) {
  const parser = runtimeManifest?.parser;
  const runtime = runtimeManifest?.runtime;
  const requiredParserStrings = [
    'name',
    'package',
    'version',
    'mode',
    'configuration',
    'contractMarker',
  ];
  for (const key of requiredParserStrings) {
    if (typeof parser?.[key] !== 'string' || parser[key].trim() === '') {
      throw new Error(`OpenDataLoader runtime manifest parser.${key} must be a non-empty string.`);
    }
  }
  if (!/^[0-9a-f]{64}$/u.test(parser.jarSha256)) {
    throw new Error('OpenDataLoader runtime manifest parser.jarSha256 must be a SHA-256 digest.');
  }
  const expectedContractMarker =
    `DNAFORGE_STRUCTURED_PDF_PROVIDER_V1::${parser.name}::${parser.version}` +
    `::${parser.mode}::${parser.configuration}::END`;
  if (parser.contractMarker !== expectedContractMarker) {
    throw new Error('OpenDataLoader parser contractMarker does not match its identity fields.');
  }
  const declaredVersion = packageManifest?.dependencies?.[parser.package];
  if (declaredVersion !== parser.version) {
    throw new Error(
      `OpenDataLoader package drift: manifest requires ${parser.package}@${parser.version}, ` +
        `but apps/desktop/package.json declares ${String(declaredVersion)}.`
    );
  }
  for (const key of ['vendor', 'version', 'versionOutput']) {
    if (typeof runtime?.[key] !== 'string' || runtime[key].trim() === '') {
      throw new Error(`OpenDataLoader runtime manifest runtime.${key} must be a non-empty string.`);
    }
  }
  const image = runtime?.image;
  if (image?.mode !== 'jlink' || image.toolchain !== 'jdk') {
    throw new Error('OpenDataLoader runtime manifest must select a jlink image from a JDK.');
  }
  if (typeof image.javaRelease !== 'string' || !/^[1-9][0-9]*$/u.test(image.javaRelease)) {
    throw new Error('OpenDataLoader runtime manifest image.javaRelease must be a Java major.');
  }
  for (const key of ['moduleRoots', 'resolvedModules', 'options']) {
    const values = image[key];
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((value) => typeof value !== 'string' || value.trim() === '') ||
      new Set(values).size !== values.length
    ) {
      throw new Error(
        `OpenDataLoader runtime manifest image.${key} must be a non-empty unique string list.`
      );
    }
  }
  for (const moduleName of image.moduleRoots) {
    if (!image.resolvedModules.includes(moduleName)) {
      throw new Error(
        `OpenDataLoader runtime root module ${moduleName} is missing from image.resolvedModules.`
      );
    }
  }
  for (const controlledOption of ['--module-path', '--add-modules', '--output']) {
    if (
      image.options.some(
        (option) => option === controlledOption || option.startsWith(`${controlledOption}=`)
      )
    ) {
      throw new Error(
        `OpenDataLoader runtime image.options must not override ${controlledOption}.`
      );
    }
  }
  if (
    !Number.isSafeInteger(image.maxBytes) ||
    image.maxBytes < 1 ||
    image.maxBytes > MAX_RUNTIME_IMAGE_BYTES
  ) {
    throw new Error(
      `OpenDataLoader runtime manifest image.maxBytes must be between 1 and ${MAX_RUNTIME_IMAGE_BYTES}.`
    );
  }
  const targets = Object.entries(runtime.targets ?? {});
  if (targets.length === 0) {
    throw new Error('OpenDataLoader runtime manifest must declare at least one target.');
  }
  for (const [target, artifact] of targets) {
    if (typeof artifact?.url !== 'string' || !artifact.url.startsWith('https://')) {
      throw new Error(`OpenDataLoader runtime target ${target} must use an HTTPS archive URL.`);
    }
    if (!/^[0-9a-f]{64}$/u.test(artifact.sha256 ?? '')) {
      throw new Error(`OpenDataLoader runtime target ${target} must pin an archive SHA-256.`);
    }
  }
}

validateRuntimeContract(manifest, desktopPackage);

function commandLineTarget({
  argv = process.argv,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  const index = argv.indexOf('--target');
  return index >= 0 ? argv[index + 1] : `${platform}-${env.ARCH || arch}`;
}

function builderTarget(context) {
  const targetPlatform = context.electronPlatformName;
  const targetArch = typeof context.arch === 'number' ? Arch[context.arch] : context.arch;
  return `${targetPlatform}-${targetArch}`;
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function findRuntimeHome(root, target) {
  const executable = target.startsWith('win32-') ? 'java.exe' : 'java';
  const isJdkHome = (candidate) =>
    ['java', 'jdeps', 'jlink'].every((tool) =>
      existsSync(runtimeToolPath(candidate, tool, target))
    ) && existsSync(join(candidate, 'jmods'));
  const candidates = [root];
  for (let depth = 0; depth < 4; depth += 1) {
    const next = [];
    for (const candidate of candidates) {
      if (isJdkHome(candidate)) return candidate;
      const macHome = join(candidate, 'Contents', 'Home');
      if (isJdkHome(macHome)) return macHome;
      const entries = readdirSync(candidate, { withFileTypes: true });
      for (const entry of entries) if (entry.isDirectory()) next.push(join(candidate, entry.name));
    }
    candidates.splice(0, candidates.length, ...next);
  }
  throw new Error(
    `Downloaded Temurin JDK archive has no complete toolchain (${executable}, jdeps, jlink, and jmods).`
  );
}

function runtimeToolPath(runtimeHome, tool, target) {
  return join(runtimeHome, 'bin', `${tool}${target.startsWith('win32-') ? '.exe' : ''}`);
}

function runtimeImagePlan({ runtimeHome, destination, jarPath, target, image }) {
  return {
    jdeps: {
      command: runtimeToolPath(runtimeHome, 'jdeps', target),
      args: [
        '--ignore-missing-deps',
        '--multi-release',
        image.javaRelease,
        '--print-module-deps',
        jarPath,
      ],
    },
    jlink: {
      command: runtimeToolPath(runtimeHome, 'jlink', target),
      args: [
        '--module-path',
        join(runtimeHome, 'jmods'),
        '--add-modules',
        image.moduleRoots.join(','),
        ...image.options,
        '--output',
        destination,
      ],
    },
    java: {
      command: runtimeToolPath(destination, 'java', target),
      args: ['--list-modules'],
    },
  };
}

function parseJdepsModules(output) {
  return output
    .trim()
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseJavaModules(output) {
  return output
    .trim()
    .split(/\s+/u)
    .map((entry) => entry.split('@')[0])
    .filter(Boolean);
}

function assertSameModuleSet(actual, expected, label) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(
      `${label} module drift: expected ${expectedSorted.join(', ')}, got ${actualSorted.join(', ')}`
    );
  }
}

function runRuntimeTool(command, args, label) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(0, 2000);
    throw new Error(
      `${label} failed (status ${String(result.status)}): ${result.error?.message || detail}`
    );
  }
  return String(result.stdout || '');
}

const RUNTIME_IDENTITY_KEYS = ['IMPLEMENTOR', 'IMPLEMENTOR_VERSION', 'JAVA_RUNTIME_VERSION'];

function releaseKey(line) {
  return line.split('=')[0].trim();
}

function withRuntimeIdentity(jdkRelease, imageRelease) {
  const present = new Set(imageRelease.split('\n').map(releaseKey));
  const carried = jdkRelease
    .split('\n')
    .filter((line) => RUNTIME_IDENTITY_KEYS.includes(releaseKey(line)))
    .filter((line) => !present.has(releaseKey(line)));
  const have = new Set([...present, ...carried.map(releaseKey)]);
  const missing = RUNTIME_IDENTITY_KEYS.filter((key) => !have.has(key));
  if (missing.length > 0) throw new Error(`Temurin JDK release file lacks ${missing.join(', ')}.`);
  if (carried.length === 0) return imageRelease;
  const base = imageRelease.endsWith('\n') ? imageRelease : `${imageRelease}\n`;
  return `${base}${carried.join('\n')}\n`;
}

function createRuntimeImage({ runtimeHome, destination, jarPath, target, image }) {
  const plan = runtimeImagePlan({ runtimeHome, destination, jarPath, target, image });
  const detectedRoots = parseJdepsModules(
    runRuntimeTool(plan.jdeps.command, plan.jdeps.args, 'Temurin jdeps')
  );
  assertSameModuleSet(detectedRoots, image.moduleRoots, 'OpenDataLoader JAR root');
  runRuntimeTool(plan.jlink.command, plan.jlink.args, 'Temurin jlink');
  const imageReleasePath = join(destination, 'release');
  writeFileSync(
    imageReleasePath,
    withRuntimeIdentity(
      readFileSync(join(runtimeHome, 'release'), 'utf8'),
      readFileSync(imageReleasePath, 'utf8')
    )
  );
  const resolvedModules = parseJavaModules(
    runRuntimeTool(plan.java.command, plan.java.args, 'Temurin minimized runtime')
  );
  assertSameModuleSet(resolvedModules, image.resolvedModules, 'OpenDataLoader runtime');
  return image.resolvedModules;
}

function treeFileBytes(root) {
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink()) return 0;
  if (metadata.isFile()) return metadata.size;
  if (!metadata.isDirectory()) {
    throw new Error(`OpenDataLoader runtime contains an unsupported filesystem entry: ${root}`);
  }
  return readdirSync(root).reduce((total, entry) => total + treeFileBytes(join(root, entry)), 0);
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Temurin download failed with HTTP ${response.status}.`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    require('node:fs').createWriteStream(destination)
  );
}

function pruneOtherParserTargets(root, target) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== target && !entry.name.includes('.staging-')) {
      rmSync(join(root, entry.name), { recursive: true, force: true });
    }
  }
}

function makeTreeOwnerWritable(root) {
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink()) return;
  chmodSync(root, metadata.mode | (metadata.isDirectory() ? 0o300 : 0o200));
  if (!metadata.isDirectory()) return;
  for (const entry of readdirSync(root)) makeTreeOwnerWritable(join(root, entry));
}

function runtimeTreeLinksArePortable(root) {
  const realRoot = realpathSync(root);
  const visit = (current) => {
    for (const entry of readdirSync(current)) {
      const child = join(current, entry);
      const metadata = lstatSync(child);
      if (metadata.isSymbolicLink()) {
        let target;
        try {
          target = realpathSync(child);
        } catch {
          return false;
        }
        const targetRelative = relative(realRoot, target);
        if (
          targetRelative === '..' ||
          targetRelative.startsWith(`..${sep}`) ||
          isAbsolute(targetRelative)
        ) {
          return false;
        }
      } else if (metadata.isDirectory() && !visit(child)) {
        return false;
      } else if (!metadata.isDirectory() && !metadata.isFile()) {
        return false;
      }
    }
    return true;
  };
  return visit(root);
}

async function prepareRuntime(target) {
  const runtime = manifest.runtime.targets[target];
  if (!runtime) throw new Error(`No pinned OpenDataLoader runtime for ${target}.`);
  const image = manifest.runtime.image;

  const parserRoot = join(DESKTOP_ROOT, 'resources', 'binaries', 'opendataloader-pdf');
  const destination = join(parserRoot, target);
  const executable = join(
    destination,
    'runtime',
    'bin',
    target.startsWith('win32-') ? 'java.exe' : 'java'
  );
  const jarDestination = join(destination, 'opendataloader-pdf-cli.jar');
  const receiptPath = join(destination, 'runtime-receipt.json');
  if (
    existsSync(executable) &&
    existsSync(jarDestination) &&
    existsSync(receiptPath) &&
    runtimeTreeLinksArePortable(destination) &&
    hashFile(jarDestination) === manifest.parser.jarSha256
  ) {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (
      receipt.target === target &&
      receipt.parserName === manifest.parser.name &&
      receipt.parserPackage === manifest.parser.package &&
      receipt.parserVersion === manifest.parser.version &&
      receipt.parserJarSha256 === manifest.parser.jarSha256 &&
      receipt.parserMode === manifest.parser.mode &&
      receipt.parserConfiguration === manifest.parser.configuration &&
      receipt.parserContractMarker === manifest.parser.contractMarker &&
      receipt.runtimeVendor === manifest.runtime.vendor &&
      receipt.runtimeVersion === manifest.runtime.version &&
      receipt.runtimeVersionOutput === manifest.runtime.versionOutput &&
      receipt.runtimeImageMode === image.mode &&
      receipt.runtimeToolchainSha256 === runtime.sha256 &&
      JSON.stringify(receipt.runtimeModuleRoots) === JSON.stringify(image.moduleRoots) &&
      JSON.stringify(receipt.runtimeResolvedModules) === JSON.stringify(image.resolvedModules) &&
      JSON.stringify(receipt.runtimeJlinkOptions) === JSON.stringify(image.options) &&
      receipt.runtimeImageBytes === treeFileBytes(join(destination, 'runtime')) &&
      receipt.runtimeImageBytes <= image.maxBytes
    ) {
      makeTreeOwnerWritable(destination);
      pruneOtherParserTargets(parserRoot, target);
      console.log(`[opendataloader] ${target} runtime already prepared`);
      return;
    }
  }

  const staging = `${destination}.staging-${process.pid}`;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const archivePath = join(
      staging,
      runtime.url.endsWith('.zip') ? 'toolchain.zip' : 'toolchain.tar.gz'
    );
    const extractionRoot = join(staging, 'extracted');
    mkdirSync(extractionRoot, { recursive: true });
    console.log(
      `[opendataloader] downloading pinned Temurin JDK ${manifest.runtime.version} for ${target}`
    );
    await download(runtime.url, archivePath);
    const actualToolchainHash = hashFile(archivePath);
    if (actualToolchainHash !== runtime.sha256) {
      throw new Error(
        `Temurin JDK checksum mismatch for ${target}: expected ${runtime.sha256}, got ${actualToolchainHash}.`
      );
    }
    const extraction = spawnSync('tar', ['-xf', archivePath, '-C', extractionRoot], {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (extraction.status !== 0) throw new Error(`Failed to extract Temurin for ${target}.`);
    const runtimeHome = findRuntimeHome(extractionRoot, target);

    const assembled = join(staging, 'assembled');
    mkdirSync(assembled, { recursive: true });
    const packageEntry = require.resolve('@opendataloader/pdf');
    const jarSource = join(dirname(packageEntry), '..', 'lib', 'opendataloader-pdf-cli.jar');
    const actualJarHash = hashFile(jarSource);
    if (actualJarHash !== manifest.parser.jarSha256) {
      throw new Error(
        `OpenDataLoader JAR checksum mismatch: expected ${manifest.parser.jarSha256}, got ${actualJarHash}.`
      );
    }
    const runtimeDestination = join(assembled, 'runtime');
    const resolvedModules = createRuntimeImage({
      runtimeHome,
      destination: runtimeDestination,
      jarPath: jarSource,
      target,
      image,
    });
    makeTreeOwnerWritable(runtimeDestination);
    if (!runtimeTreeLinksArePortable(runtimeDestination)) {
      throw new Error('Minimized OpenDataLoader runtime contains a non-portable symbolic link.');
    }
    const runtimeImageBytes = treeFileBytes(runtimeDestination);
    if (runtimeImageBytes > image.maxBytes) {
      throw new Error(
        `Minimized OpenDataLoader runtime is ${runtimeImageBytes} bytes; budget is ${image.maxBytes}.`
      );
    }
    copyFileSync(jarSource, join(assembled, 'opendataloader-pdf-cli.jar'));
    writeFileSync(
      join(assembled, 'runtime-receipt.json'),
      `${JSON.stringify(
        {
          target,
          parserName: manifest.parser.name,
          parserPackage: manifest.parser.package,
          parserVersion: manifest.parser.version,
          parserJarSha256: manifest.parser.jarSha256,
          parserMode: manifest.parser.mode,
          parserConfiguration: manifest.parser.configuration,
          parserContractMarker: manifest.parser.contractMarker,
          runtimeVendor: manifest.runtime.vendor,
          runtimeVersion: manifest.runtime.version,
          runtimeVersionOutput: manifest.runtime.versionOutput,
          runtimeImageMode: image.mode,
          runtimeToolchainSha256: runtime.sha256,
          runtimeModuleRoots: image.moduleRoots,
          runtimeResolvedModules: resolvedModules,
          runtimeJlinkOptions: image.options,
          runtimeImageBytes,
        },
        null,
        2
      )}\n`
    );
    if (!target.startsWith('win32-')) {
      chmodSync(join(assembled, 'runtime', 'bin', 'java'), 0o755);
    }
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(assembled, destination);
    pruneOtherParserTargets(parserRoot, target);
    console.log(`[opendataloader] prepared ${destination}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

exports.prepareRuntime = prepareRuntime;
exports.commandLineTarget = commandLineTarget;
exports.createRuntimeImage = createRuntimeImage;
exports.parseJavaModules = parseJavaModules;
exports.runtimeImagePlan = runtimeImagePlan;
exports.runtimeTreeLinksArePortable = runtimeTreeLinksArePortable;
exports.treeFileBytes = treeFileBytes;
exports.validateRuntimeContract = validateRuntimeContract;
exports.withRuntimeIdentity = withRuntimeIdentity;
exports.default = async function beforePack(context) {
  await prepareRuntime(builderTarget(context));
};

if (require.main === module) {
  prepareRuntime(commandLineTarget()).catch((error) => {
    console.error(`[opendataloader] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
