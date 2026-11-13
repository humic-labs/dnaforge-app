const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, statSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join, resolve } = require('node:path');

function buildSequenceWheel(options = {}) {
  if (process.platform !== 'darwin') return null;
  const desktop = resolve(__dirname, '..');
  const arch = process.env.ARCH || process.arch;
  if (!['arm64', 'x64'].includes(arch))
    throw Error(`Unsupported native wheel architecture: ${arch}`);
  const source = options.testOutput
    ? resolve(desktop, '../../e2e/electron/fixtures/native-wheel-input.mm')
    : join(desktop, 'native/sequence-wheel.mm');
  const output =
    options.testOutput || join(desktop, 'resources/binaries', `sequence-wheel-${arch}.node`);
  if (
    existsSync(output) &&
    statSync(output).mtimeMs >= Math.max(statSync(source).mtimeMs, statSync(__filename).mtimeMs)
  )
    return output;
  const cache = join(homedir(), 'Library/Caches/node-gyp');
  const headers = join(cache, process.versions.node, 'include/node');
  if (!existsSync(join(headers, 'node_api.h')))
    execFileSync(
      process.execPath,
      [
        require.resolve('node-gyp/bin/node-gyp.js'),
        'install',
        '--target',
        process.versions.node,
        '--devdir',
        cache,
      ],
      { stdio: 'inherit' }
    );
  mkdirSync(dirname(output), { recursive: true });
  execFileSync(
    'clang++',
    [
      '-std=c++17',
      '-fobjc-arc',
      '-DNAPI_VERSION=8',
      '-bundle',
      '-undefined',
      'dynamic_lookup',
      '-arch',
      arch === 'x64' ? 'x86_64' : arch,
      '-mmacosx-version-min=11.0',
      '-I',
      headers,
      '-framework',
      'AppKit',
      source,
      '-o',
      output,
    ],
    { stdio: 'inherit' }
  );
  return output;
}

module.exports = { buildSequenceWheel };
if (require.main === module) {
  const index = process.argv.indexOf('--test-output');
  console.log(
    buildSequenceWheel(index >= 0 ? { testOutput: resolve(process.argv[index + 1]) } : {})
  );
}
