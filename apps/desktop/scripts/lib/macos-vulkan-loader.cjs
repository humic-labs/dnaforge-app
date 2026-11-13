const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const lockBytes = fs.readFileSync(require.resolve('../../../../.ci/macos-vulkan-loader.lock.json'));
const lock = JSON.parse(lockBytes);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourcePins = Object.freeze(
  Object.fromEntries(Object.entries(lock.sources).map(([name, entry]) => [name, entry.sha256]))
);
const libraryName = 'libvulkan.1.dylib';
const buildSchema = 'dnaforge.macos-vulkan-loader-build.v1';
const packageSchema = 'dnaforge.macos-vulkan-loader.v1';

function entry(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function regularBytes(file, maxBytes = 64 * 1024 * 1024) {
  const info = entry(file);
  assert.ok(
    info && info.isFile() && !info.isSymbolicLink(),
    `Vulkan input must be a regular file, not a symbolic link: ${file}`
  );
  assert.ok(info.size > 0 && info.size <= maxBytes, `Vulkan input size is invalid: ${file}`);
  return fs.readFileSync(file);
}

function versionNumber(version) {
  assert.match(version ?? '', /^\d{1,4}\.\d{1,3}(?:\.\d{1,3})?$/u, 'Invalid Vulkan Mach-O version');
  const [major, minor, patch = 0] = version.split('.').map(Number);
  assert.ok(
    major <= 65535 && minor <= 255 && patch <= 255,
    'Vulkan Mach-O version is out of range'
  );
  return major * 65536 + minor * 256 + patch;
}

function verifyMachO(bytes, arch, sdk) {
  assert.ok(['x64', 'arm64'].includes(arch), 'Unsupported Vulkan loader architecture');
  assert.ok(
    bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf,
    'Vulkan loader must be a thin 64-bit Mach-O dylib'
  );
  assert.equal(
    bytes.readUInt32LE(4),
    arch === 'x64' ? 0x01000007 : 0x0100000c,
    'Vulkan loader Mach-O architecture differs'
  );
  assert.equal(
    bytes.readUInt32LE(8) & 0x00ffffff,
    arch === 'x64' ? 3 : 0,
    'Vulkan loader Mach-O architecture subtype differs'
  );
  assert.equal(bytes.readUInt32LE(12), 6, 'Vulkan loader Mach-O must be MH_DYLIB');
  const count = bytes.readUInt32LE(16);
  const end = 32 + bytes.readUInt32LE(20);
  assert.ok(
    count > 0 && end <= bytes.length && count * 8 <= end - 32,
    'Vulkan loader Mach-O commands are invalid'
  );
  let offset = 32;
  const versions = [];
  for (let index = 0; index < count; index++) {
    assert.ok(offset + 8 <= end, 'Truncated Vulkan Mach-O command');
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    assert.ok(
      size >= 8 && size % 4 === 0 && offset + size <= end,
      'Invalid Vulkan Mach-O command length'
    );
    if (command === 0x32) {
      assert.ok(size >= 24, 'Truncated Vulkan LC_BUILD_VERSION');
      assert.equal(bytes.readUInt32LE(offset + 8), 1, 'Vulkan loader targets a non-macOS platform');
      versions.push([bytes.readUInt32LE(offset + 12), bytes.readUInt32LE(offset + 16)]);
    } else if (command === 0x24) {
      assert.ok(size >= 16, 'Truncated Vulkan LC_VERSION_MIN_MACOSX');
      versions.push([bytes.readUInt32LE(offset + 8), bytes.readUInt32LE(offset + 12)]);
    }
    offset += size;
  }
  assert.equal(offset, end, 'Vulkan Mach-O command roster differs');
  assert.equal(versions.length, 1, 'Vulkan loader deployment target is missing or ambiguous');
  assert.equal(
    versions[0][0],
    versionNumber(lock.deploymentTarget),
    'Vulkan loader minimum macOS differs from the pinned deployment target'
  );
  assert.equal(
    versions[0][1],
    versionNumber(sdk),
    'Vulkan loader SDK differs from its build receipt'
  );
}

function validateBuild(build, arch) {
  assert.equal(lock.schema, 'dnaforge.macos-vulkan-inputs.v1', 'Invalid Vulkan source lock');
  assert.deepEqual(
    Object.keys(sourcePins).sort(),
    ['headers', 'loader'],
    'Invalid pinned Vulkan input roster'
  );
  for (const value of Object.values(sourcePins))
    assert.match(value, /^[a-f0-9]{64}$/u, 'Invalid pinned Vulkan input digest');
  assert.equal(build.schema, buildSchema, 'Invalid Vulkan loader build schema');
  assert.equal(build.version, lock.version, 'Vulkan loader version differs from the source lock');
  assert.equal(build.arch, arch, 'Vulkan loader build architecture differs');
  assert.equal(
    build.deploymentTarget,
    lock.deploymentTarget,
    'Vulkan loader deployment target differs'
  );
  versionNumber(build.sdk);
  assert.deepEqual(build.inputs, sourcePins, 'Vulkan loader native input digests differ');
  assert.deepEqual(
    Object.keys(build.files ?? {}).sort(),
    ['library', 'license'],
    'Vulkan loader build file roster differs'
  );
  for (const [role, name] of [
    ['library', libraryName],
    ['license', 'LICENSE.txt'],
  ]) {
    const file = build.files[role];
    assert.equal(file.name, name, `Vulkan loader ${role} filename differs`);
    assert.match(file.sha256 ?? '', /^[a-f0-9]{64}$/u, `Vulkan loader ${role} digest is invalid`);
    assert.ok(
      Number.isSafeInteger(file.size) && file.size > 0,
      `Vulkan loader ${role} size is invalid`
    );
  }
  assert.ok(
    Array.isArray(build.dependencies) && build.dependencies.length > 0,
    'Vulkan loader dependencies are missing'
  );
  assert.equal(
    new Set(build.dependencies).size,
    build.dependencies.length,
    'Duplicate Vulkan loader dependency'
  );
  for (const dependency of build.dependencies) {
    assert.ok(
      typeof dependency === 'string' &&
        !/[\0\r\n]/u.test(dependency) &&
        (dependency === '@rpath/libvulkan.1.dylib' ||
          dependency.startsWith('/usr/lib/') ||
          dependency.startsWith('/System/Library/')),
      'Vulkan loader has an unbundled non-system dependency'
    );
  }
}

function identity(options) {
  assert.match(
    options.applicationSourceSha ?? '',
    /^[a-f0-9]{40}$/u,
    'Vulkan packaging application source SHA is required'
  );
  assert.match(
    options.packagingControllerSha ?? '',
    /^[a-f0-9]{40}$/u,
    'Vulkan packaging controller SHA is required'
  );
  assert.match(
    options.recipeSha256 ?? '',
    /^[a-f0-9]{64}$/u,
    'Vulkan packaging recipe digest is required'
  );
}

function manifestFor(options, build, buildReceiptSha256) {
  identity(options);
  return {
    schema: packageSchema,
    phase: 'source-build-before-package-signing',
    version: lock.version,
    arch: options.arch,
    applicationSourceSha: options.applicationSourceSha,
    packagingControllerSha: options.packagingControllerSha,
    recipeSha256: options.recipeSha256,
    sourceLockSha256: digest(lockBytes),
    buildReceiptSha256,
    inputs: sourcePins,
    librarySha256: build.files.library.sha256,
    licenseSha256: build.files.license.sha256,
    build,
  };
}

function packagePaths(appPath) {
  assert.ok(
    typeof appPath === 'string' && path.isAbsolute(appPath),
    'Vulkan staging requires an absolute app path'
  );
  const app = path.resolve(appPath);
  const libraries = path.join(
    app,
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries'
  );
  return {
    app,
    library: path.join(libraries, libraryName),
    alias: path.join(libraries, 'libvulkan.dylib'),
    license: path.join(app, 'Contents/Resources/licenses/vulkan-loader.txt'),
    manifest: path.join(app, 'Contents/Resources/native-vulkan-loader.json'),
  };
}

function verifyParents(app, file) {
  const relative = path.relative(app, path.dirname(file));
  assert.ok(
    relative !== '..' && !relative.startsWith('..' + path.sep),
    'Vulkan staging path escaped the app'
  );
  let directory = app;
  for (const component of ['', ...relative.split(path.sep).filter(Boolean)]) {
    directory = path.join(directory, component);
    const info = entry(directory);
    assert.ok(
      !info || (info.isDirectory() && !info.isSymbolicLink()),
      `Vulkan staging parent must be a real directory: ${directory}`
    );
  }
}

function verifyStagedMacosVulkanLoader(options) {
  const files = packagePaths(options.appPath);
  for (const file of [files.library, files.alias, files.license, files.manifest])
    verifyParents(files.app, file);
  const manifest = JSON.parse(regularBytes(files.manifest, 1024 * 1024));
  validateBuild(manifest.build, options.arch);
  assert.match(
    manifest.buildReceiptSha256 ?? '',
    /^[a-f0-9]{64}$/u,
    'Vulkan build receipt digest is invalid'
  );
  assert.deepEqual(
    manifest,
    manifestFor(options, manifest.build, manifest.buildReceiptSha256),
    'Vulkan staged packaging metadata differs'
  );
  const library = regularBytes(files.library);
  verifyMachO(library, options.arch, manifest.build.sdk);
  const expectedLibrarySha256 = options.expectedSignedLibrarySha256 ?? manifest.librarySha256;
  assert.match(
    expectedLibrarySha256,
    /^[a-f0-9]{64}$/u,
    'Vulkan expected library digest is invalid'
  );
  assert.equal(digest(library), expectedLibrarySha256, 'Vulkan staged library sha256 differs');
  if (!options.expectedSignedLibrarySha256)
    assert.equal(
      library.length,
      manifest.build.files.library.size,
      'Vulkan staged library size differs'
    );
  const alias = entry(files.alias);
  assert.ok(
    alias?.isSymbolicLink() && fs.readlinkSync(files.alias) === libraryName,
    'Vulkan loader alias must be the exact relative symlink'
  );
  const license = regularBytes(files.license, 2 * 1024 * 1024);
  assert.equal(digest(license), manifest.licenseSha256, 'Vulkan staged license checksum differs');
  assert.equal(
    license.length,
    manifest.build.files.license.size,
    'Vulkan staged license size differs'
  );
  return { manifest, librarySha256: digest(library), librarySize: library.length };
}

function stageMacosVulkanLoader(options) {
  const { sourceDir, required = true } = options;
  if (!sourceDir || !entry(sourceDir)) {
    assert.equal(required, false, 'Vulkan loader source directory is missing and required');
    return null;
  }
  assert.ok(
    entry(sourceDir).isDirectory() && !entry(sourceDir).isSymbolicLink(),
    'Vulkan loader source must be a regular directory'
  );
  const rawBuild = regularBytes(path.join(sourceDir, 'vulkan-loader-build.json'), 1024 * 1024);
  const build = JSON.parse(rawBuild);
  validateBuild(build, options.arch);
  const library = regularBytes(path.join(sourceDir, libraryName));
  const license = regularBytes(path.join(sourceDir, 'LICENSE.txt'), 2 * 1024 * 1024);
  for (const [role, bytes] of [
    ['library', library],
    ['license', license],
  ]) {
    assert.equal(bytes.length, build.files[role].size, `Vulkan ${role} input size differs`);
    assert.equal(digest(bytes), build.files[role].sha256, `Vulkan ${role} input checksum differs`);
  }
  verifyMachO(library, options.arch, build.sdk);
  const manifest = manifestFor(options, build, digest(rawBuild));
  const files = packagePaths(options.appPath);
  const writes = [
    [files.library, library, 0o755],
    [files.license, license, 0o644],
    [files.manifest, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 0o644],
  ];
  for (const [file, bytes] of writes) {
    verifyParents(files.app, file);
    if (entry(file))
      assert.ok(
        regularBytes(file).equals(bytes),
        `Refusing to overwrite foreign Vulkan staging file: ${file}`
      );
  }
  verifyParents(files.app, files.alias);
  const alias = entry(files.alias);
  assert.ok(
    !alias || (alias.isSymbolicLink() && fs.readlinkSync(files.alias) === libraryName),
    'Refusing to overwrite foreign Vulkan loader alias'
  );
  for (const [file, bytes, mode] of writes) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!entry(file)) fs.writeFileSync(file, bytes, { flag: 'wx', mode });
  }
  if (!alias) fs.symlinkSync(libraryName, files.alias);
  verifyStagedMacosVulkanLoader(options);
  return manifest;
}

module.exports = { stageMacosVulkanLoader, verifyStagedMacosVulkanLoader };
