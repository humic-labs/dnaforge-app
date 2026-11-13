const { createRequire } = require('node:module');
const { join } = require('node:path');

const qosClasses = new Map([
  [0, 'unspecified'],
  [9, 'background'],
  [17, 'utility'],
  [21, 'default'],
  [25, 'userInitiated'],
  [33, 'userInteractive'],
]);
const minimumClasses = { userInitiated: 25, userInteractive: 33 };
let native;

function loadNative() {
  if (native) return native;
  const requireNative = createRequire(join(__dirname, 'thread-scheduling.cjs'));
  const library = requireNative('koffi').load('/usr/lib/system/libsystem_pthread.dylib');
  const getRequestedQos = library.func('unsigned int qos_class_self(void)');
  const setRequestedQos = library.func(
    'int pthread_set_qos_class_self_np(unsigned int qos_class, int relative_priority)'
  );
  const getThreadId = library.func(
    'int pthread_threadid_np(void *thread, _Out_ uint64_t *thread_id)'
  );
  native = {
    getRequestedQos,
    setRequestedQos,
    getNativeThreadId() {
      const bytes = Buffer.alloc(8);
      const code = getThreadId(null, bytes);
      if (code !== 0) {
        throw Object.assign(new Error('native_thread_id_unavailable'), { code });
      }
      return bytes.readBigUInt64LE().toString();
    },
  };
  return native;
}

function context(runtime) {
  return {
    platform: runtime.platform ?? process.platform,
    pid: runtime.pid ?? process.pid,
    loadNative: runtime.loadNative ?? loadNative,
  };
}

function emptyObservation(runtime) {
  return {
    status: runtime.platform === 'darwin' ? 'unavailable' : 'unsupported',
    platform: runtime.platform,
    pid: runtime.pid,
    nativeThreadId: null,
    requestedQos: null,
    requestedClass: null,
  };
}

function observe(runtime, controls) {
  const requestedQos = controls.getRequestedQos();
  const requestedClass = qosClasses.get(requestedQos) ?? null;
  const nativeThreadId = controls.getNativeThreadId();
  if (!/^[1-9]\d*$/u.test(nativeThreadId)) throw new Error('invalid_native_thread_id');
  return {
    status: requestedClass === null ? 'unavailable' : 'observed',
    platform: runtime.platform,
    pid: runtime.pid,
    nativeThreadId,
    requestedQos,
    requestedClass,
    ...(requestedClass === null ? { reason: 'unrecognized_requested_qos' } : {}),
  };
}

function unavailable(observation, error) {
  return {
    ...observation,
    status: 'unavailable',
    reason: error instanceof Error ? error.message : String(error),
    ...(Number.isInteger(error?.code) ? { errorCode: error.code } : {}),
  };
}

function readCurrentThreadScheduling(options = {}) {
  const runtime = context(options);
  const observation = emptyObservation(runtime);
  if (runtime.platform !== 'darwin') return observation;
  try {
    return observe(runtime, runtime.loadNative());
  } catch (error) {
    return unavailable(observation, error);
  }
}

function preferCurrentThread(minimum, options = {}) {
  const minimumQos = minimumClasses[minimum];
  if (minimumQos === undefined) throw new Error('unsupported_scheduling_minimum');
  const runtime = context(options);
  let observation = {
    ...emptyObservation(runtime),
    minimumClass: minimum,
    minimumQos,
    previousRequestedQos: null,
    changed: false,
  };
  if (runtime.platform !== 'darwin') return observation;
  try {
    const controls = runtime.loadNative();
    const before = observe(runtime, controls);
    observation = {
      ...observation,
      ...before,
      previousRequestedQos: before.requestedQos,
    };
    if (before.status !== 'observed') return observation;
    if (before.requestedQos >= minimumQos) return { ...observation, status: 'requested' };
    const code = controls.setRequestedQos(minimumQos, 0);
    if (code !== 0) {
      return {
        ...observation,
        status: 'unavailable',
        reason: 'qos_request_refused',
        errorCode: code,
      };
    }
    const after = observe(runtime, controls);
    observation = {
      ...observation,
      ...after,
      changed: after.requestedQos !== before.requestedQos,
    };
    if (after.status !== 'observed') return observation;
    return after.requestedQos >= minimumQos
      ? { ...observation, status: 'requested' }
      : { ...observation, status: 'unavailable', reason: 'requested_qos_below_minimum' };
  } catch (error) {
    return unavailable(observation, error);
  }
}

module.exports = { readCurrentThreadScheduling, preferCurrentThread };
