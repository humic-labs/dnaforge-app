import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  ready: false,
  readyDuringReporterImport: true,
  persist: vi.fn().mockResolvedValue(true),
  product: vi.fn().mockResolvedValue(undefined),
  exit: vi.fn(),
  quit: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    isReady: () => native.ready,
    getPath: () => '/owned/bootstrap-profile',
    getName: () => 'DNAForge',
    exit: native.exit,
    quit: native.quit,
  },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./early-file-association', () => ({}));
vi.mock('./electron-pre-ready', () => ({ configureElectronBeforeReady: vi.fn() }));
vi.mock('./managed-runtime-launch', () => ({ requestsManagedRuntime: () => false }));
vi.mock('./release-stamp', () => ({
  PACKAGED_SOURCE_COMMIT: 'a'.repeat(40),
  RELEASE_BUILD_IDENTITY: {},
  classifyReleaseBHostedAuthority: () => null,
}));
vi.mock('./qualification-ephemeral-auth', () => ({
  qualifyEphemeralAuthSource: () => null,
  qualifyEphemeralAuthLaunch: () => null,
}));
vi.mock('./qualification-auth-state', () => ({ configureQualificationEphemeralAuth: vi.fn() }));
vi.mock('./qualification-safe-storage', () => ({
  installQualificationSafeStorageGuard: () => null,
}));
vi.mock('./background-window-mode', () => ({ isBackgroundWindowMode: () => true }));
vi.mock('./index', () => ({
  get productStartup() {
    return native.product();
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  native.ready = false;
  native.readyDuringReporterImport = true;
  native.product.mockResolvedValue(undefined);
  vi.doMock('./diagnostics-upload', () => {
    native.ready = native.readyDuringReporterImport;
    return { persistStartupFailure: native.persist };
  });
  vi.stubEnv('DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE', '');
  vi.stubGlobal('__WAYPOINT_BUILD_SOURCE_FINGERPRINT__', 'b'.repeat(64));
  vi.stubGlobal(
    '__DNAFORGE_SOURCE_COMMIT__',
    `DNAFORGE_SOURCE_COMMIT=${'a'.repeat(40)}::SOURCE_COMMIT_PROVENANCE_V1::END`
  );
  vi.stubGlobal('__DNAFORGE_RELEASE_BUILD__', '');
  vi.stubGlobal('__DNAFORGE_RELEASE_B_HOSTED__', '');
  vi.stubGlobal('__DNAFORGE_HOSTED_AI_GATEWAY_URL__', '');
  vi.stubGlobal('__DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH__', '');
  vi.stubGlobal('__DNAFORGE_HOSTED_AI_GATEWAY_MARKER__', ':empty');
  vi.stubGlobal('__DNAFORGE_HOSTED_AI_RELEASE_A_MARKER__', ':disabled');
  vi.stubGlobal(
    '__DNAFORGE_PACKAGED_AUTH_MARKER__',
    'DNAFORGE_PACKAGED_AUTH=release-a::ORIGIN=https://dnaforge.com::DESKTOP_AUTH_AUTHORITY_V1::END'
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('retains a failure before readiness while the reporter import completes after readiness', async () => {
  native.product.mockRejectedValue(new Error('Owned product-module fixture failure'));
  await import('./bootstrap');
  await vi.waitFor(() => expect(native.persist).toHaveBeenCalledWith('bootstrap_error'));
  expect(native.ready).toBe(true);
  await vi.waitFor(() => expect(native.quit).toHaveBeenCalled());
});

it('retains a ready-state failure even if the reporter observes a different state', async () => {
  native.ready = true;
  native.readyDuringReporterImport = false;
  native.product.mockRejectedValue(new Error('Owned ready-state fixture failure'));
  await import('./bootstrap');
  await vi.waitFor(() => expect(native.persist).toHaveBeenCalledWith('startup_error'));
  expect(native.ready).toBe(false);
  await vi.waitFor(() => expect(native.quit).toHaveBeenCalled());
});

it('forces a durable before-ready failure without loading product main', async () => {
  vi.stubEnv('DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE', 'before-ready');
  await import('./bootstrap');
  await vi.waitFor(() => expect(native.exit).toHaveBeenCalledWith(42));
  expect(native.persist).toHaveBeenCalledWith('bootstrap_error');
  expect(native.product).not.toHaveBeenCalled();
  expect(native.quit).not.toHaveBeenCalled();
});

it('preserves an ordinary successful product launch', async () => {
  await import('./bootstrap');
  await vi.waitFor(() => expect(native.product).toHaveBeenCalledOnce());
  expect(native.persist).not.toHaveBeenCalled();
  expect(native.exit).not.toHaveBeenCalled();
});
