import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { hash, argon2id } from 'argon2';
import { OAuth2Client } from 'google-auth-library';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { setupApp } from '../../src/config/setup-app.js';
import { Prisma } from '../../src/generated/prisma/client.js';

/*
 * Google's real verifier runs against a test key that stands in for Google's published
 * keys, so signature, issuer, expiry and audience checks are exercised for real. The users
 * table is an in-memory stand-in with the same unique constraints.
 */

const WEB = 'web-client.apps.googleusercontent.com';
const IOS = 'ios-client.apps.googleusercontent.com';
const KID = 'test-key';
const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });

type Claims = Record<string, unknown>;
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

function googleToken(claims: Claims = {}, key = google.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    iss: 'https://accounts.google.com',
    aud: WEB,
    sub: '1000001',
    email: 'customer@gmail.com',
    email_verified: true,
    given_name: 'Ana',
    family_name: 'Krasniqi',
    iat: now,
    exp: now + 3600,
    ...claims,
  };
  const unsigned = b64({ alg: 'RS256', typ: 'JWT', kid: KID }) + '.' + b64(body);
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url');
  return unsigned + '.' + signature;
}

interface Row {
  id: string;
  firstName: string;
  lastName: string;
  userName: string | null;
  email: string;
  passwordHash: string | null;
  googleId: string | null;
  phone: string | null;
  country: string | null;
  address: string | null;
  postalCode: string | null;
  role: 'CUSTOMER' | 'ADMIN';
  isActive: boolean;
  notificationsEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const rows: Row[] = [];
const pick = (row: Row | undefined, select: Record<string, boolean>) =>
  row
    ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k as keyof Row]]))
    : null;
const matches = (row: Row, where: Partial<Row>) =>
  Object.entries(where).every(([k, v]) => row[k as keyof Row] === v);
const unique = (field: string) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: [field] },
  });

const user = {
  findUnique: vi.fn(async ({ where, select }: { where: Partial<Row>; select: Record<string, boolean> }) =>
    pick(rows.find((row) => matches(row, where)), select),
  ),
  create: vi.fn(async ({ data, select }: { data: Partial<Row>; select: Record<string, boolean> }) => {
    if (rows.some((row) => row.email === data.email)) throw unique('email');
    if (data.googleId && rows.some((row) => row.googleId === data.googleId)) throw unique('google_id');
    const row: Row = {
      id: randomUUID(),
      userName: null,
      passwordHash: null,
      googleId: null,
      phone: null,
      country: null,
      address: null,
      postalCode: null,
      role: 'CUSTOMER',
      isActive: true,
      notificationsEnabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      firstName: '',
      lastName: '',
      email: '',
      ...data,
    };
    rows.push(row);
    return pick(row, select);
  }),
  updateMany: vi.fn(async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
    const found = rows.filter((row) => matches(row, where));
    if (data.googleId && rows.some((row) => row.googleId === data.googleId)) throw unique('google_id');
    for (const row of found) Object.assign(row, data);
    return { count: found.length };
  }),
  update: vi.fn(),
};

describe('Google sign-in (POST /auth/google)', () => {
  let app: INestApplication<App>;
  const password = 'ValidPassword123!';
  let passwordHash: string;

  const signIn = (body: object, web = false) => {
    const req = request(app.getHttpServer()).post('/api/v1/auth/google');
    if (web) req.set('X-HomeMade-Client', 'web');
    return req.send(body);
  };
  const me = (token: string) =>
    request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', 'Bearer ' + token);
  const localAccount = (overrides: Partial<Row> = {}) => {
    const row = {
      id: randomUUID(),
      firstName: 'Ana',
      lastName: 'Krasniqi',
      userName: null,
      email: 'customer@gmail.com',
      passwordHash,
      googleId: null,
      phone: '044111222',
      country: 'Kosovo',
      address: 'Main Street 1',
      postalCode: null,
      role: 'CUSTOMER' as const,
      isActive: true,
      notificationsEnabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    rows.push(row);
    return row;
  };

  beforeAll(async () => {
    vi.stubEnv('JWT_ACCESS_SECRET', 'test-only-jwt-secret-at-least-32-characters');
    vi.stubEnv('JWT_ACCESS_EXPIRES_IN', '60m');
    passwordHash = await hash(password, { type: argon2id });
    vi.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({
      certs: { [KID]: google.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      format: 'PEM' as never,
    });
    const module = await Test.createTestingModule({ imports: [AuthModule] })
      .overrideProvider(PrismaService)
      .useValue({ user })
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
  });
  beforeEach(() => {
    rows.length = 0;
    vi.stubEnv('GOOGLE_WEB_CLIENT_ID', WEB);
    vi.stubEnv('GOOGLE_IOS_CLIENT_ID', IOS);
    vi.stubEnv('GOOGLE_ANDROID_CLIENT_ID', '');
    user.findUnique.mockClear();
    user.create.mockClear();
    user.updateMany.mockClear();
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('creates one CUSTOMER without a password for a new Google user and signs them in', async () => {
    const response = await signIn({ idToken: googleToken() }).expect(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: 'customer@gmail.com',
      googleId: '1000001',
      passwordHash: null,
      role: 'CUSTOMER',
      firstName: 'Ana',
      lastName: 'Krasniqi',
    });
    expect(response.body).toMatchObject({ expiresIn: 3600, profileComplete: true, user: { id: rows[0].id } });
    expect(response.body.user).not.toHaveProperty('passwordHash');
    expect(response.body.user).not.toHaveProperty('googleId');
    // The normal HM Craft session: existing endpoints accept it unchanged.
    expect((await me(response.body.accessToken).expect(200)).body.id).toBe(rows[0].id);
  });

  it('returns the same user on every later sign-in, from the website and the app alike', async () => {
    const first = await signIn({ idToken: googleToken() }).expect(200);
    const again = await signIn({ idToken: googleToken() }).expect(200);
    // iOS tokens carry the iOS client ID as their audience.
    const ios = await signIn({ idToken: googleToken({ aud: IOS }) }).expect(200);
    const web = await signIn({ idToken: googleToken() }, true).expect(200);
    expect(rows).toHaveLength(1);
    for (const response of [again, ios, web]) expect(response.body.user.id).toBe(first.body.user.id);
    // The website gets its cookie session and no token in the body.
    expect(web.body).not.toHaveProperty('accessToken');
    expect([web.headers['set-cookie']].flat().join()).toMatch(/hc_session=.*HttpOnly/);
  });

  it('finds the account by Google ID even after the Google email changes', async () => {
    const first = await signIn({ idToken: googleToken() }).expect(200);
    const renamed = await signIn({ idToken: googleToken({ email: 'new-address@gmail.com' }) }).expect(200);
    expect(renamed.body.user.id).toBe(first.body.user.id);
    expect(rows).toHaveLength(1);
  });

  describe('an existing password account with the same email', () => {
    it('asks for the HM Craft password before linking', async () => {
      const local = localAccount();
      const response = await signIn({ idToken: googleToken() }).expect(409);
      expect(response.body).toMatchObject({
        message: 'An account with this email already exists. Enter your password to connect Google.',
        email: 'customer@gmail.com',
      });
      expect(response.body).not.toHaveProperty('accessToken');
      expect(local.googleId).toBeNull();
      expect(rows).toHaveLength(1);
    });

    it('rejects a wrong password and leaves the account unlinked', async () => {
      const local = localAccount();
      const response = await signIn({ idToken: googleToken(), password: 'WrongPassword999!' }).expect(401);
      expect(response.body.message).toBe('Incorrect password');
      expect(local.googleId).toBeNull();
    });

    it('links with the right password, keeps the account, its data and its password', async () => {
      const local = localAccount();
      const response = await signIn({ idToken: googleToken(), password }).expect(200);
      expect(rows).toHaveLength(1);
      expect(response.body.user).toMatchObject({ id: local.id, phone: '044111222', notificationsEnabled: false });
      expect(local.googleId).toBe('1000001');
      expect(local.passwordHash).toBe(passwordHash);
      // Both ways in keep working.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'customer@gmail.com', password })
        .expect(200);
      expect((await signIn({ idToken: googleToken() }).expect(200)).body.user.id).toBe(local.id);
    });

    it('never links on an unverified Google email', async () => {
      const local = localAccount();
      await signIn({ idToken: googleToken({ email_verified: false }), password }).expect(401);
      expect(local.googleId).toBeNull();
      expect(user.updateMany).not.toHaveBeenCalled();
    });

    it('refuses an account already tied to a different Google account', async () => {
      localAccount({ googleId: '999' });
      await signIn({ idToken: googleToken(), password }).expect(401);
      expect(rows).toHaveLength(1);
    });
  });

  it('does not create an account from an unverified or missing email', async () => {
    await signIn({ idToken: googleToken({ email_verified: false }) }).expect(401);
    await signIn({ idToken: googleToken({ email: undefined }) }).expect(401);
    expect(user.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a malformed token', () => 'not-a-jwt'],
    ['a token signed by someone else', () => googleToken({}, stranger.privateKey)],
    ['a token for another app', () => googleToken({ aud: 'someone-else.apps.googleusercontent.com' })],
    ['an expired token', () => googleToken({ iat: 1_000, exp: 2_000 })],
    ['a token from another issuer', () => googleToken({ iss: 'https://evil.example' })],
  ])('rejects %s', async (_case, token) => {
    const response = await signIn({ idToken: token() }).expect(401);
    expect(response.body.message).toBe('Unable to sign in with Google');
    expect(user.findUnique).not.toHaveBeenCalledWith(expect.objectContaining({ where: { googleId: '1000001' } }));
    expect(rows).toHaveLength(0);
  });

  it('keeps disabled accounts out, linked or not', async () => {
    localAccount({ googleId: '1000001', isActive: false });
    await signIn({ idToken: googleToken() }).expect(401);
    rows.length = 0;
    localAccount({ isActive: false });
    await signIn({ idToken: googleToken(), password }).expect(401);
  });

  it('never creates an ADMIN, whatever the request or token says', async () => {
    await signIn({ idToken: googleToken(), role: 'ADMIN' }).expect(400);
    await signIn({ idToken: googleToken({ role: 'ADMIN' }) }).expect(200);
    expect(rows[0].role).toBe('CUSTOMER');
    expect(user.create.mock.calls[0][0].data.role).toBe('CUSTOMER');
  });

  it('flags a missing name so the apps can ask for it', async () => {
    const response = await signIn({ idToken: googleToken({ family_name: undefined }) }).expect(200);
    expect(response.body.profileComplete).toBe(false);
    expect(rows[0]).toMatchObject({ firstName: 'Ana', lastName: '' });
  });

  it('gives a Google-only account no password: password login and change are refused', async () => {
    const created = await signIn({ idToken: googleToken() }).expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'customer@gmail.com', password })
      .expect(401);
    const change = await request(app.getHttpServer())
      .patch('/api/v1/auth/change-password')
      .set('Authorization', 'Bearer ' + created.body.accessToken)
      .send({ currentPassword: password, newPassword: 'AnotherPassword456!', confirmPassword: 'AnotherPassword456!' })
      .expect(400);
    expect([change.body.message].flat()).toEqual(['This account signs in with Google and has no password']);
  });

  it('validates the request body', async () => {
    for (const body of [{}, { idToken: '' }, { idToken: 42 }, { idToken: googleToken(), googleId: '1' }])
      await signIn(body).expect(400);
    expect(rows).toHaveLength(0);
  });

  it('answers 503 while Google sign-in is not configured', async () => {
    vi.stubEnv('GOOGLE_WEB_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_IOS_CLIENT_ID', '');
    await signIn({ idToken: googleToken() }).expect(503);
  });
});
