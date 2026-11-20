import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [bundle, helper, ...files] = process.argv.slice(2);
if (process.platform !== 'darwin' || !bundle || !helper || files.length === 0) {
  throw new Error(
    'Usage on macOS: node verify-macos-file-associations.mjs <bundle.app> <helper> <files...>'
  );
}
const app = realpathSync(bundle);
const identity = execFileSync(
  '/usr/bin/plutil',
  ['-extract', 'CFBundleIdentifier', 'raw', join(app, 'Contents', 'Info.plist')],
  { encoding: 'utf8' }
).trim();
const rows = files.map((file) => {
  const state = JSON.parse(
    execFileSync(resolve(helper), ['inspect-file', realpathSync(file)], { encoding: 'utf8' })
  );
  return {
    file: resolve(file),
    ...state,
    candidate: state.candidates.some(
      (candidate) => candidate.bundleId === identity && realpathSync(candidate.path) === app
    ),
  };
});
console.log(JSON.stringify({ app, identity, rows }, null, 2));
assert.ok(
  rows.every((row) => row.ok && row.candidate),
  'The supplied application must be a registered candidate for every actual file.'
);
