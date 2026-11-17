import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyFiles } from '../../../scripts/generate-keys.ts';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'keys-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('generateKeyFiles', () => {
  it('writes a matching Ed25519 pair, the private key readable by its owner only', () => {
    const { privateKeyPath, publicKeyPath } = generateKeyFiles(join(directory, 'keys'));

    const privateKey = createPrivateKey(readFileSync(privateKeyPath));
    const publicKey = createPublicKey(readFileSync(publicKeyPath));
    expect(privateKey.asymmetricKeyType).toBe('ed25519');
    expect(createPublicKey(privateKey).export({ format: 'jwk' })).toEqual(
      publicKey.export({ format: 'jwk' }),
    );
    expect(statSync(privateKeyPath).mode & 0o777).toBe(0o600);
  });

  it('keeps existing keys unless forced', () => {
    const first = generateKeyFiles(directory);
    const original = readFileSync(first.privateKeyPath, 'utf8');

    expect(() => generateKeyFiles(directory)).toThrow('pass --force');
    expect(readFileSync(first.privateKeyPath, 'utf8')).toBe(original);

    generateKeyFiles(directory, { force: true });
    expect(readFileSync(first.privateKeyPath, 'utf8')).not.toBe(original);
  });
});
