import { Test } from '@nestjs/testing';
import {
  Controller,
  Get,
  Module,
  Req,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../src/common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { JwtService } from '@nestjs/jwt';
import { hash, argon2id } from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { setupApp } from '../../src/config/setup-app.js';

@Controller('guard-probe')
class GuardProbeController {
  @Get()
  @UseGuards(JwtAuthGuard)
  probe(
    @Req() request: { user: AuthenticatedUser },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { user, attached: request.user === user };
  }
}
@Module({ imports: [AuthModule], controllers: [GuardProbeController] })
class GuardProbeModule {}

describe('Authentication HTTP', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  let passwordHash: string;
  const id = 'ac78a80a-ce2b-4c45-8076-fca001c71418';
  const password = 'ValidPassword123!';
  const user = { findUnique: vi.fn() };
  const safe = {
    id,
    firstName: 'Test',
    lastName: 'User',
    email: 'test@example.com',
    userName: 'test.user',
    country: 'Kosovo',
    address: 'Main Street',
    postalCode: '10000',
    phone: null,
    role: 'CUSTOMER',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeAll(async () => {
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'test-only-jwt-secret-at-least-32-characters',
    );
    vi.stubEnv('JWT_ACCESS_EXPIRES_IN', '60m');
    passwordHash = await hash(password, { type: argon2id });
    const module = await Test.createTestingModule({
      imports: [GuardProbeModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ user })
      .compile();
    app = module.createNestApplication();
    jwt = module.get(JwtService);
    setupApp(app);
    await app.init();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    user.findUnique.mockImplementation(
      async ({ select }: { select: { passwordHash?: boolean } }) =>
        select.passwordHash ? { ...safe, passwordHash } : safe,
    );
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('logs in with Argon2id credentials and validates the resulting mobile session', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ' TEST@example.com ', password })
      .expect(200);
    expect(login.body.expiresIn).toBe(3600);
    expect(typeof login.body.accessToken).toBe('string');
    expect(login.body).not.toHaveProperty('passwordHash');
    expect(login.body.user).toMatchObject({
      id,
      email: safe.email,
      userName: safe.userName,
      role: 'CUSTOMER',
    });
    expect(login.body.user).not.toHaveProperty('passwordHash');
    const payload = jwt.decode(login.body.accessToken);
    expect(payload.exp - payload.iat).toBe(3600);
    expect(Object.keys(payload).sort()).toEqual([
      'aud',
      'exp',
      'iat',
      'iss',
      'sub',
      'tokenUse',
    ]);
    expect(user.findUnique.mock.calls[0][0].where).toEqual({
      email: 'test@example.com',
    });
    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer ' + login.body.accessToken)
      .expect(200);
    expect(me.body.id).toBe(id);
    expect(me.body).not.toHaveProperty('passwordHash');
    expect(user.findUnique.mock.calls[1][0].select).not.toHaveProperty(
      'passwordHash',
    );
  });

  it('rejects incorrect passwords', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'incorrect' })
      .expect(401);
  });
  it.each(['missing', 'inactive', 'placeholder'])(
    'rejects %s accounts with the same credential error',
    async (kind) => {
      user.findUnique.mockResolvedValue(
        kind === 'missing'
          ? null
          : {
              id,
              isActive: kind !== 'inactive',
              passwordHash:
                kind === 'placeholder' ? 'temporary-test-hash' : passwordHash,
            },
      );
      const result = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'test@example.com', password })
        .expect(401);
      expect(result.body.message).toBe('Invalid email or password');
    },
  );
  it.each([
    { email: 'bad', password },
    { email: 'test@example.com' },
    { email: 'test@example.com', password, role: 'ADMIN' },
  ])('validates login DTO %j', async (body) => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(body)
      .expect(400);
    expect(user.findUnique).not.toHaveBeenCalled();
  });
  it('rejects missing, malformed, expired, wrongly signed and wrong-audience tokens', async () => {
    const expired = await jwt.signAsync(
      { sub: id, tokenUse: 'access' },
      { expiresIn: -1 },
    );
    const wrongKey = await jwt.signAsync(
      { sub: id, tokenUse: 'access' },
      { secret: 'wrong-key' },
    );
    const wrongAudience = await jwt.signAsync(
      { sub: id, tokenUse: 'access' },
      { audience: 'other-app' },
    );
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    for (const token of ['invalid', expired, wrongKey, wrongAudience]) {
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer ' + token)
        .expect(401);
    }
    expect(user.findUnique).not.toHaveBeenCalled();
  });
  it.each([null, { ...safe, isActive: false }])(
    'rejects deleted or deactivated users on session restoration',
    async (account) => {
      const token = await jwt.signAsync({ sub: id, tokenUse: 'access' });
      user.findUnique.mockResolvedValue(account);
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer ' + token)
        .expect(401);
    },
  );
  it.each([
    [' TEST.USER ', { userName: 'test.user' }],
    [' TEST@example.com ', { email: 'test@example.com' }],
  ])('logs in with identifier %s', async (identifier, where) => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier, password })
      .expect(200);
    expect(user.findUnique.mock.calls[0][0].where).toEqual(where);
  });
  it.each([
    { identifier: '', password: 'secret' },
    { identifier: null, password: 'secret' },
    { identifier: 'test.user', email: 'test@example.com', password: 'secret' },
  ])('rejects ambiguous or empty identifiers', async (body) => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(body)
      .expect(400);
    expect(user.findUnique).not.toHaveBeenCalled();
  });
  it('exports a reusable guard that attaches a safe request user in another module', async () => {
    await request(app.getHttpServer()).get('/api/v1/guard-probe').expect(401);
    const token = await jwt.signAsync({ sub: id, tokenUse: 'access' });
    const result = await request(app.getHttpServer())
      .get('/api/v1/guard-probe')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(result.body.attached).toBe(true);
    expect(result.body.user.id).toBe(id);
    expect(result.body.user).not.toHaveProperty('passwordHash');
  });
  it('rejects tokens with missing expiration, wrong issuer, wrong purpose or invalid subject', async () => {
    const tokens = [
      await new JwtService({ secret: process.env.JWT_ACCESS_SECRET }).signAsync(
        {
          sub: id,
          tokenUse: 'access',
          iss: 'homemade-api',
          aud: 'homemade-mobile',
        },
      ),
      await jwt.signAsync(
        { sub: id, tokenUse: 'access' },
        { issuer: 'other-api' },
      ),
      await jwt.signAsync({ sub: id, tokenUse: 'refresh' }),
      await jwt.signAsync({ sub: 'not-a-uuid', tokenUse: 'access' }),
    ];
    for (const token of tokens)
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer ' + token)
        .expect(401);
    expect(user.findUnique).not.toHaveBeenCalled();
  });
});
