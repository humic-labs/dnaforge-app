import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((_value: string) => Buffer.from('encrypted')),
  decryptString: vi.fn((_value: Buffer) => 'decrypted'),
  isAsyncEncryptionAvailable: vi.fn(async () => true),
  encryptStringAsync: vi.fn(async (_value: string) => Buffer.from('encrypted')),
  decryptStringAsync: vi.fn(async (_value: Buffer) => ({
    result: 'decrypted',
    shouldReEncrypt: false,
  })),
}));

vi.mock('electron', () => ({ safeStorage: h }));

import { installQualificationSafeStorageGuard } from './qualification-safe-storage';

describe('qualification Safe Storage guard', () => {
  it('is absent for normal builds and blocks every Keychain-touching method when installed', () => {
    expect(installQualificationSafeStorageGuard(false)).toBeNull();
    const audit = installQualificationSafeStorageGuard(true);
    expect(audit).toMatchObject({ installed: true, attempts: 0, methods: [] });

    expect(() => h.isEncryptionAvailable()).toThrow(
      'QUALIFICATION_EPHEMERAL_AUTH_FORBIDS_SAFE_STORAGE:isEncryptionAvailable'
    );
    expect(() => h.encryptString('secret')).toThrow(
      'QUALIFICATION_EPHEMERAL_AUTH_FORBIDS_SAFE_STORAGE:encryptString'
    );
    expect(() => h.decryptString(Buffer.from('ciphertext'))).toThrow(
      'QUALIFICATION_EPHEMERAL_AUTH_FORBIDS_SAFE_STORAGE:decryptString'
    );
    expect(audit).toEqual({
      installed: true,
      attempts: 3,
      methods: ['isEncryptionAvailable', 'encryptString', 'decryptString'],
    });
  });

  it('also rejects every asynchronous Keychain-touching method', async () => {
    const audit = installQualificationSafeStorageGuard(true)!;
    const attempts = audit.attempts;
    const methods = [...audit.methods];
    await expect(h.isAsyncEncryptionAvailable()).rejects.toThrow(
      'QUALIFICATION_EPHEMERAL_AUTH_FORBIDS_SAFE_STORAGE:isAsyncEncryptionAvailable'
    );
    await expect(h.encryptStringAsync('secret')).rejects.toThrow(
      'QUALIFICATION_EPHEMERAL_AUTH_FORBIDS_SAFE_STORAGE:encryptStringAsync'
    );
    await expect(h.decryptStringAsync(Buffer.from('ciphertext'))).rejects.toThrow(
      'QUALIFICATION_EPHEMERAL_AUTH_FORBIDS_SAFE_STORAGE:decryptStringAsync'
    );
    expect(audit).toEqual({
      installed: true,
      attempts: attempts + 3,
      methods: [
        ...methods,
        'isAsyncEncryptionAvailable',
        'encryptStringAsync',
        'decryptStringAsync',
      ],
    });
  });
});
