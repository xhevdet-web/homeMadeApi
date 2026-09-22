import { accessTokenSeconds, jwtConfig } from './jwt.config.js';

describe('JWT access configuration', () => {
  beforeEach(() => {
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'test-access-secret-with-at-least-32-bytes',
    );
    vi.stubEnv('JWT_SECRET', 'test-legacy-secret-with-at-least-32-bytes');
    vi.stubEnv('JWT_ACCESS_EXPIRES_IN', undefined);
  });
  afterEach(() => vi.unstubAllEnvs());
  it('defaults to 60 minutes and prefers the access secret', () => {
    expect(accessTokenSeconds()).toBe(3600);
    expect(jwtConfig().secret).toBe(process.env.JWT_ACCESS_SECRET);
    expect(jwtConfig().verifyOptions?.algorithms).toEqual(['HS256']);
  });
  it('preserves the legacy environment secret', () => {
    vi.stubEnv('JWT_ACCESS_SECRET', undefined);
    expect(jwtConfig().secret).toBe(process.env.JWT_SECRET);
  });
  it.each([
    ['15m', 900],
    ['60m', 3600],
    ['1h', 3600],
    ['120', 120],
  ])('parses %s', (value, seconds) => {
    vi.stubEnv('JWT_ACCESS_EXPIRES_IN', value as string);
    expect(accessTokenSeconds()).toBe(seconds);
    expect(jwtConfig().signOptions?.expiresIn).toBe(seconds);
  });
  it.each(['', '0', '-1', 'never', '15ms', '999999999999999999999d'])(
    'rejects invalid expiry %s',
    (value) => {
      vi.stubEnv('JWT_ACCESS_EXPIRES_IN', value);
      expect(() => jwtConfig()).toThrow('JWT_ACCESS_EXPIRES_IN');
    },
  );
  it('fails closed for an invalid explicitly configured access secret', () => {
    vi.stubEnv('JWT_ACCESS_SECRET', 'short');
    expect(() => jwtConfig()).toThrow('JWT_ACCESS_SECRET');
  });
});
