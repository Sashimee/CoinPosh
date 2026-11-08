import { describe, expect, it } from 'vitest';
import { resolveNetMode, resolveTurnstileSiteKey } from './env.ts';

describe('resolveNetMode', () => {
  it('selects Demo Mode when VITE_API_URL is unset or blank', () => {
    expect(resolveNetMode(undefined)).toEqual({ kind: 'demo' });
    expect(resolveNetMode('')).toEqual({ kind: 'demo' });
    expect(resolveNetMode('   ')).toEqual({ kind: 'demo' });
  });

  it('accepts https origins and trims trailing slashes', () => {
    expect(resolveNetMode('https://api.example.com/')).toEqual({
      kind: 'live',
      apiUrl: 'https://api.example.com',
    });
  });

  it('allows plain http only on loopback', () => {
    expect(resolveNetMode('http://localhost:8787')).toEqual({
      kind: 'live',
      apiUrl: 'http://localhost:8787',
    });
    expect(resolveNetMode('http://127.0.0.1:8787')).toEqual({
      kind: 'live',
      apiUrl: 'http://127.0.0.1:8787',
    });
    expect(() => resolveNetMode('http://api.example.com')).toThrow(/https/);
  });

  it('fails loudly on a URL that is not absolute', () => {
    expect(() => resolveNetMode('api.example.com')).toThrow(/absolute URL/);
  });
});

describe('resolveTurnstileSiteKey', () => {
  it('treats an unset or blank key as absent', () => {
    expect(resolveTurnstileSiteKey(undefined)).toBeUndefined();
    expect(resolveTurnstileSiteKey('')).toBeUndefined();
    expect(resolveTurnstileSiteKey('  ')).toBeUndefined();
  });

  it('trims and keeps a site key', () => {
    expect(resolveTurnstileSiteKey(' 0x4AAAAAAABkMYinukE8nzY_ ')).toBe('0x4AAAAAAABkMYinukE8nzY_');
    expect(resolveTurnstileSiteKey('1x00000000000000000000AA')).toBe('1x00000000000000000000AA');
  });

  it('fails loudly on something that is not a site key', () => {
    expect(() => resolveTurnstileSiteKey('0x4AAA AAAA')).toThrow(/site key/);
    expect(() => resolveTurnstileSiteKey('"0x4AAA"')).toThrow(/VITE_TURNSTILE_SITE_KEY/);
  });
});
