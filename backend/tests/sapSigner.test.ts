import { describe, expect, it } from 'vitest';
import { signerBaseURL } from '../src/services/sapSigner.js';

describe('SAP signer service', () => {
  it('accepts only explicit loopback addresses', () => {
    expect(signerBaseURL('127.0.0.1:54726')).toBe(
      'http://127.0.0.1:54726',
    );
    expect(signerBaseURL('[::1]:54726')).toBe('http://[::1]:54726');
  });

  it('rejects remote, credentialed, and path-bearing addresses', () => {
    expect(() => signerBaseURL('example.com:54726')).toThrow(/loopback/i);
    expect(() => signerBaseURL('user@127.0.0.1:54726')).toThrow(/loopback/i);
    expect(() => signerBaseURL('127.0.0.1:54726/path')).toThrow(/loopback/i);
  });
});
