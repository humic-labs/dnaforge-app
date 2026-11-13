const { createRequire } = require('node:module');

const SECURITY_FRAMEWORK = '/System/Library/Frameworks/Security.framework/Security';

function disableKeychainInteraction({
  platform = process.platform,
  enabled = true,
  loadNative = createRequire(__filename),
} = {}) {
  if (!enabled || platform !== 'darwin') return null;

  const security = loadNative('koffi').load(SECURITY_FRAMEWORK);
  const setAllowed = security.func('int32_t SecKeychainSetUserInteractionAllowed(uint8_t state)');
  const getAllowed = security.func(
    'int32_t SecKeychainGetUserInteractionAllowed(_Out_ uint8_t *state)'
  );
  const setStatus = setAllowed(0);
  if (setStatus !== 0) throw new Error(`KEYCHAIN_NONINTERACTIVE_POLICY_FAILED:set:${setStatus}`);

  const state = Buffer.from([1]);
  const getStatus = getAllowed(state);
  if (getStatus !== 0 || state[0] !== 0)
    throw new Error(`KEYCHAIN_NONINTERACTIVE_POLICY_FAILED:verify:${getStatus}:${state[0]}`);

  return { pid: process.pid, userInteractionAllowed: false, setStatus, getStatus };
}

module.exports = { disableKeychainInteraction };
