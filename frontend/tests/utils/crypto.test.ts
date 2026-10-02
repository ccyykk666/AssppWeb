import { createCipheriv, pbkdf2Sync, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptData, encryptData } from '../../src/utils/crypto';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe('encrypted account backup compatibility', () => {
  const data = { accounts: [{ email: 'fixture@example.com', name: '中文测试' }] };
  const password = 'fixture-password';

  it('round-trips Unicode data and uses fresh salt and IV each time', async () => {
    const first = await encryptData(data, password);
    const second = await encryptData(data, password);
    expect(first).not.toBe(second);
    expect(await decryptData(first, password)).toEqual(data);
    expect(await decryptData(second, password)).toEqual(data);
  });

  it('reads the existing salt + IV + AES-GCM ciphertext backup format', async () => {
    const salt = Buffer.alloc(16, 1);
    const iv = Buffer.alloc(12, 2);
    const key = pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    const backup = Buffer.concat([salt, iv, encrypted]).toString('base64');
    expect(await decryptData(backup, password)).toEqual(data);
  });

  it('still rejects incorrect passwords and corrupted backups', async () => {
    const backup = await encryptData(data, password);
    await expect(decryptData(backup, 'wrong-password')).rejects.toThrow('Decryption failed');
    const corrupted = Buffer.from(backup, 'base64');
    corrupted[corrupted.length - 1] ^= 1;
    await expect(decryptData(corrupted.toString('base64'), password)).rejects.toThrow('Decryption failed');
  });
});
