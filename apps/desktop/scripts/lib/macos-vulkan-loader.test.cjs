const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const applicationSourceSha = 'a'.repeat(40);
const packagingControllerSha = 'b'.repeat(40);
const recipeSha256 = 'c'.repeat(64);

function dylib(arch) {
  const bytes = Buffer.alloc(72);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4);
  bytes.writeUInt32LE(arch === 'x64' ? 3 : 0, 8);
  bytes.writeUInt32LE(6, 12);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x32, 32);
  bytes.writeUInt32LE(24, 36);
  bytes.writeUInt32LE(1, 40);
  bytes.writeUInt32LE(13 << 16, 44);
  bytes.writeUInt32LE((26 << 16) | (2 << 8), 48);
  return bytes;
}

function inputs(root, arch, lock) {
  fs.mkdirSync(root, { recursive: true });
  const library = dylib(arch);
  const license = Buffer.from('Vulkan Loader\nApache License 2.0\n');
  fs.writeFileSync(path.join(root, 'libvulkan.1.dylib'), library);
  fs.writeFileSync(path.join(root, 'LICENSE.txt'), license);
  const receipt = {
    schema: 'dnaforge.macos-vulkan-loader-build.v1',
    version: lock.version,
    arch,
    deploymentTarget: lock.deploymentTarget,
    sdk: '26.2',
    inputs: Object.fromEntries(
      Object.entries(lock.sources).map(([name, value]) => [name, value.sha256])
    ),
    files: {
      library: { name: 'libvulkan.1.dylib', sha256: sha256(library), size: library.length },
      license: { name: 'LICENSE.txt', sha256: sha256(license), size: license.length },
    },
    dependencies: ['@rpath/libvulkan.1.dylib', '/usr/lib/libSystem.B.dylib'],
  };
  fs.writeFileSync(path.join(root, 'vulkan-loader-build.json'), JSON.stringify(receipt));
  return { library, license, receipt };
}

test('macOS packaging stages the verified Vulkan loader before signing', () => {
  const { stageMacosVulkanLoader } = require('./macos-vulkan-loader.cjs');
  const lock = require('../../../../.ci/macos-vulkan-loader.lock.json');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vulkan-stage-'));
  try {
    const appPath = path.join(scratch, 'DNAForge.app');
    const libraries = path.join(
      appPath,
      'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries'
    );
    fs.mkdirSync(libraries, { recursive: true });
    const driver = Buffer.from('unchanged bundled SwiftShader driver');
    fs.writeFileSync(path.join(libraries, 'libvk_swiftshader.dylib'), driver);
    const sourceDir = path.join(scratch, 'x64-input');
    const fixture = inputs(sourceDir, 'x64', lock);
    const options = {
      appPath,
      arch: 'x64',
      sourceDir,
      applicationSourceSha,
      packagingControllerSha,
      recipeSha256,
      required: true,
    };
    const staged = stageMacosVulkanLoader(options);
    const libraryPath = path.join(libraries, 'libvulkan.1.dylib');
    const alias = path.join(libraries, 'libvulkan.dylib');
    assert.deepEqual(fs.readFileSync(libraryPath), fixture.library);
    assert.equal(fs.readlinkSync(alias), 'libvulkan.1.dylib');
    assert.deepEqual(fs.readFileSync(alias), fixture.library);
    assert.deepEqual(fs.readFileSync(path.join(libraries, 'libvk_swiftshader.dylib')), driver);
    assert.deepEqual(
      fs.readFileSync(path.join(appPath, 'Contents/Resources/licenses/vulkan-loader.txt')),
      fixture.license
    );
    const manifestPath = path.join(appPath, 'Contents/Resources/native-vulkan-loader.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.applicationSourceSha, applicationSourceSha);
    assert.equal(manifest.packagingControllerSha, packagingControllerSha);
    assert.equal(manifest.recipeSha256, recipeSha256);
    assert.equal(manifest.librarySha256, sha256(fixture.library));
    assert.equal(manifest.arch, 'x64');
    assert.deepEqual(stageMacosVulkanLoader(options), staged);
    fs.appendFileSync(path.join(sourceDir, 'libvulkan.1.dylib'), 'tampered');
    assert.throws(() => stageMacosVulkanLoader(options), /checksum|digest|sha.?256|length|size/i);
    assert.deepEqual(fs.readFileSync(libraryPath), fixture.library);
    const wrongArch = path.join(scratch, 'arm64-input');
    inputs(wrongArch, 'arm64', lock);
    assert.throws(
      () => stageMacosVulkanLoader({ ...options, sourceDir: wrongArch }),
      /architecture|arch/i
    );
    const linked = path.join(scratch, 'linked-input');
    inputs(linked, 'x64', lock);
    fs.unlinkSync(path.join(linked, 'libvulkan.1.dylib'));
    fs.symlinkSync(libraryPath, path.join(linked, 'libvulkan.1.dylib'));
    assert.throws(
      () => stageMacosVulkanLoader({ ...options, sourceDir: linked }),
      /symbolic|symlink|regular/i
    );
    assert.throws(
      () => stageMacosVulkanLoader({ ...options, sourceDir: undefined }),
      /missing|required|source/i
    );
    assert.equal(
      stageMacosVulkanLoader({ ...options, sourceDir: undefined, required: false }),
      null
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
