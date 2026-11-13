import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { app, protocol, safeStorage } from 'electron';

import { registerAssemblyAnnotationSceneScheme } from './ipc/assembly-annotation-scene-scheme';
import { startNativeCrashReporter } from './native-crash-reporter-start';
import { initSentryMain } from './sentry';
import { preferCurrentThread } from './thread-scheduling.cjs';

export function readEnvLocalValue(key: string): string | undefined {
  const envPath = join(process.cwd(), '.env.local');
  if (!existsSync(envPath)) return undefined;

  const line = readFileSync(envPath, 'utf-8')
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(`${key}=`));
  if (!line) return undefined;

  return line
    .slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

function resolveDevRemoteDebuggingPort(): string {
  const explicit = process.env.DESKTOP_DEBUG_PORT ?? readEnvLocalValue('DESKTOP_DEBUG_PORT');
  if (explicit && /^\d+$/.test(explicit)) return explicit;

  const desktopDevPort = process.env.DESKTOP_DEV_PORT ?? readEnvLocalValue('DESKTOP_DEV_PORT');
  const parsedDesktopDevPort = desktopDevPort ? Number.parseInt(desktopDevPort, 10) : NaN;
  if (Number.isInteger(parsedDesktopDevPort) && parsedDesktopDevPort >= 1421) {
    return String(parsedDesktopDevPort + 7800);
  }

  return '9223';
}

function configureLinuxTestSafeStorage(): void {
  if (process.platform !== 'linux' || app.isPackaged) return;
  const e2e =
    process.env.WAYPOINT_TEST === '1' ||
    process.argv.includes('--e2e') ||
    process.argv.includes('--waypoint-test=1');
  if (!e2e) return;
  if (process.env.DNAFORGE_E2E_SYSTEM_KEYCHAIN === '1') {
    if (!process.env.DBUS_SESSION_BUS_ADDRESS || !process.env.GNOME_KEYRING_CONTROL)
      throw new Error('Linux system-keychain tests require their private Secret Service session.');

    app.commandLine.removeSwitch('password-store');
    app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
    return;
  }
  app.commandLine.appendSwitch('password-store', 'basic');
  safeStorage.setUsePlainTextEncryption(true);
}

export function configureElectronBeforeReady(): void {
  preferCurrentThread('userInteractive');
  configureLinuxTestSafeStorage();

  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');

  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-webgl');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  if (process.platform !== 'darwin' || process.env.WAYPOINT_E2E_FORCE_SWIFTSHADER === '1') {
    app.commandLine.appendSwitch('use-gl', 'angle');
    app.commandLine.appendSwitch('use-angle', 'swiftshader-webgl');
  }

  if (!app.isPackaged && process.env.NODE_ENV !== 'test') {
    const remoteDebuggingPort = resolveDevRemoteDebuggingPort();
    app.commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort);
    console.log(`[DevTools] Remote debugging port: ${remoteDebuggingPort}`);
  }

  startNativeCrashReporter();
  initSentryMain();

  registerAssemblyAnnotationSceneScheme(protocol);

  if (process.platform === 'linux') {
    app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
    app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
  }
}
