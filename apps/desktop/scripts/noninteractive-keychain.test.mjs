import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { disableKeychainInteraction } = require('../src/main/noninteractive-keychain.cjs');
const { isAgentLaunch, backgroundWindowRequested } = require('./background-window-policy.cjs');

test('shared agent marker reaches desktop authorization policy for every CLI', () => {
  assert.equal(isAgentLaunch({ DNAFORGE_AGENT_EXECUTION: '1' }), true);
  assert.equal(backgroundWindowRequested({ DNAFORGE_AGENT_EXECUTION: '1' }), true);
  assert.equal(isAgentLaunch({ DNAFORGE_AGENT_EXECUTION: '0' }), false);
  assert.equal(isAgentLaunch({}), false);
  assert.equal(
    backgroundWindowRequested({ DNAFORGE_AGENT_EXECUTION: '1', DNAFORGE_FOREGROUND_WINDOW: '1' }),
    false
  );
});

function fixture({ setStatus = 0, getStatus = 0, interactionAllowed = 0 } = {}) {
  const calls = [];
  const loadNative = (name) => {
    calls.push(['module', name]);
    return {
      load(path) {
        calls.push(['library', path]);
        return {
          func(signature) {
            if (signature.includes('SetUserInteractionAllowed')) {
              return (state) => {
                calls.push(['set', state]);
                return setStatus;
              };
            }
            assert.match(signature, /GetUserInteractionAllowed/u);
            return (state) => {
              calls.push(['verify']);
              state[0] = interactionAllowed;
              return getStatus;
            };
          },
        };
      },
    };
  };
  return { calls, loadNative };
}

test('disables native Keychain interaction and verifies the process policy', () => {
  const f = fixture();
  assert.deepEqual(disableKeychainInteraction({ platform: 'darwin', loadNative: f.loadNative }), {
    pid: process.pid,
    userInteractionAllowed: false,
    setStatus: 0,
    getStatus: 0,
  });
  assert.deepEqual(f.calls, [
    ['module', 'koffi'],
    ['library', '/System/Library/Frameworks/Security.framework/Security'],
    ['set', 0],
    ['verify'],
  ]);
});

test('fails closed when native policy cannot be set', () => {
  const f = fixture({ setStatus: -50 });
  assert.throws(
    () => disableKeychainInteraction({ platform: 'darwin', loadNative: f.loadNative }),
    /KEYCHAIN_NONINTERACTIVE_POLICY_FAILED:set:-50/u
  );
  assert.equal(
    f.calls.some(([name]) => name === 'verify'),
    false
  );
});

test('fails closed when verification fails or interaction is still enabled', () => {
  for (const result of [{ getStatus: -50 }, { interactionAllowed: 1 }]) {
    const f = fixture(result);
    assert.throws(
      () => disableKeychainInteraction({ platform: 'darwin', loadNative: f.loadNative }),
      /KEYCHAIN_NONINTERACTIVE_POLICY_FAILED:verify/u
    );
  }
});

test('never proceeds if the native bridge is unavailable', () => {
  assert.throws(
    () =>
      disableKeychainInteraction({
        platform: 'darwin',
        loadNative() {
          throw new Error('native bridge unavailable');
        },
      }),
    /native bridge unavailable/u
  );
});

test('does not load native code when the policy does not apply', () => {
  const f = fixture();
  for (const input of [
    { platform: 'darwin', enabled: false },
    { platform: 'linux' },
    { platform: 'win32' },
  ])
    assert.equal(disableKeychainInteraction({ ...input, loadNative: f.loadNative }), null);
  assert.deepEqual(f.calls, []);
});

test('native development entry installs the policy before importing the application', () => {
  const entry = readFileSync(new URL('./lib/dev-app-entry.mjs', import.meta.url), 'utf8');
  const runtime = readFileSync(new URL('./dev-app-runtime.cjs', import.meta.url), 'utf8');
  assert.match(runtime, /'noninteractive-keychain\.cjs'/u);
  assert(
    entry.indexOf('const authorization = disableKeychainInteraction(') <
      entry.indexOf('await import(')
  );
  assert.match(
    entry,
    /loadNative: createRequire\(resolve\(configuration\.appDirectory, 'package\.json'\)\)/u
  );
});

test('main bootstrap installs the policy before configuring or loading the product', () => {
  const entry = readFileSync(new URL('../src/main/bootstrap.ts', import.meta.url), 'utf8');
  const policy = entry.indexOf('disableKeychainInteraction({');
  assert(policy > 0 && policy < entry.indexOf('configureElectronBeforeReady();'));
  assert(policy < entry.indexOf("await import('./index')"));
  assert.match(entry, /enabled:\s*!app\.isPackaged\s*\|\|\s*isBackgroundWindowMode\(\)/u);
});
