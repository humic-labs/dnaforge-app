import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { app } from 'electron';

const BOOT_LOG_NAME = 'main-boot.log';
const PREVIOUS_BOOT_LOG_NAME = 'main-boot.log.1';
const INSTALL_LOG_NAME = 'install.log';
const MAX_BOOT_LOG_BYTES = 5 * 1024 * 1024;

let bootLogPath: string | null = null;
let initialized = false;
let maxBootLogBytes = MAX_BOOT_LOG_BYTES;
let bootLogBytes = 0;

function ensureLogsDir(userDataPath: string): string {
  const logsDir = join(userDataPath, 'logs');
  mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

export function resolveWindowsInstallLogPath(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return null;
    const candidate = join(localAppData, 'DNAForge', 'logs', INSTALL_LOG_NAME);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function safeAppVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return 'unknown';
  }
}

function readTailBytes(filePath: string, maxBytes: number): Buffer {
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function rotateBootLog(path: string): void {
  writeFileSync(join(dirname(path), PREVIOUS_BOOT_LOG_NAME), readTailBytes(path, maxBootLogBytes));
  writeFileSync(path, '');
  bootLogBytes = 0;
}

function writeBootLogLine(path: string, line: string): void {
  const bytes = Buffer.byteLength(line);
  if (bootLogBytes + bytes > maxBootLogBytes) rotateBootLog(path);
  appendFileSync(path, line);
  bootLogBytes += bytes;
}

export function initBootLog(userDataPath: string = app.getPath('userData')): string {
  const logsDir = ensureLogsDir(userDataPath);
  bootLogPath = join(logsDir, BOOT_LOG_NAME);
  try {
    bootLogBytes = existsSync(bootLogPath) ? statSync(bootLogPath).size : 0;
  } catch {
    bootLogBytes = 0;
  }
  if (!initialized) {
    try {
      writeBootLogLine(
        bootLogPath,
        `# DNAForge main-boot.log schema=1 started=${new Date().toISOString()} version=${safeAppVersion()} platform=${process.platform}\n`
      );
    } catch {}
    initialized = true;
  }
  return bootLogPath;
}

export function appendBootLog(message: string): void {
  if (!bootLogPath) {
    try {
      initBootLog();
    } catch {
      return;
    }
  }
  if (!bootLogPath) return;
  try {
    writeBootLogLine(bootLogPath, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

export function copyInstallLogIntoUserData(
  userDataPath: string = app.getPath('userData')
): string | null {
  const source = resolveWindowsInstallLogPath();
  if (!source) return null;
  const logsDir = ensureLogsDir(userDataPath);
  const dest = join(logsDir, INSTALL_LOG_NAME);
  try {
    copyFileSync(source, dest);
    const attemptSource = source.replace(/install\.log$/i, 'install-attempt.id');
    const attemptDest = join(logsDir, 'install-attempt.id');
    if (existsSync(attemptSource)) {
      copyFileSync(attemptSource, attemptDest);
    }
    return dest;
  } catch {
    return null;
  }
}

export function readLogTail(filePath: string, maxChars: number): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readTailBytes(filePath, maxChars * 4).toString('utf-8');
    return content.length > maxChars ? content.slice(-maxChars) : content;
  } catch {
    return null;
  }
}

export function getBootLogPath(): string | null {
  return bootLogPath;
}

export function __resetBootLogForTest(): void {
  bootLogPath = null;
  initialized = false;
  maxBootLogBytes = MAX_BOOT_LOG_BYTES;
  bootLogBytes = 0;
}

export function __setBootLogMaxBytesForTest(bytes: number): void {
  maxBootLogBytes = bytes;
}
