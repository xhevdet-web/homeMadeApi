import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { verify } from 'argon2';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { UsersService } from './users.service.js';

const safeUser = {
  id: 'ac78a80a-ce2b-4c45-8076-fca001c71418',
  firstName: 'John',
  lastName: 'Doe',
  email: 'john@example.com',
  phone: '044123456',
  role: 'CUSTOMER',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const dto = {
  firstName: 'John',
  lastName: 'Doe',
  email: ' JOHN@example.com ',
  password: 'StrongPassword123!',
  phone: '044123456',
};
const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('Internal query detail', {
    code,
    clientVersion: '7.10.0',
  });

describe('UsersService', () => {
  const user = {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  let service: UsersService;
  beforeEach(() => {
    vi.resetAllMocks();
    service = new UsersService({ user } as unknown as PrismaService);
  });

  it('creates with an Argon2id hash, normalized email, safe defaults and a safe select', async () => {
    user.create.mockResolvedValue(safeUser);
    const result = await service.create({
      ...dto,
      role: 'ADMIN',
      isActive: false,
    } as typeof dto);
    const { data, select } = user.create.mock.calls[0][0];
    expect(data.email).toBe('john@example.com');
    expect(data.role).toBe('CUSTOMER');
    expect(data.isActive).toBe(true);
    expect(data).not.toHaveProperty('password');
    expect(data.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verify(data.passwordHash, dto.password)).toBe(true);
    expect(select).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('maps duplicate email creation to 409, including database race conflicts', async () => {
    user.create.mockRejectedValue(prismaError('P2002'));
    await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
  });

  it('lists users without selecting hashes', async () => {
    user.findMany.mockResolvedValue([safeUser]);
    expect(await service.findAll()).toEqual([safeUser]);
    expect(user.findMany.mock.calls[0][0].select).not.toHaveProperty(
      'passwordHash',
    );
  });

  it('gets a user by UUID without selecting hashes', async () => {
    user.findUnique.mockResolvedValue(safeUser);
    expect(await service.findOne(safeUser.id)).toEqual(safeUser);
    expect(user.findUnique.mock.calls[0][0].where).toEqual({ id: safeUser.id });
    expect(user.findUnique.mock.calls[0][0].select).not.toHaveProperty(
      'passwordHash',
    );
  });

  it('returns 404 for a missing user', async () => {
    user.findUnique.mockResolvedValue(null);
    await expect(service.findOne(safeUser.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updates only permitted fields and normalizes email', async () => {
    user.update.mockResolvedValue(safeUser);
    const input = {
      email: ' JOHN@example.com ',
      isActive: false,
      passwordHash: 'bad',
      password: 'bad',
      role: 'ADMIN',
    };
    expect(await service.update(safeUser.id, input)).toEqual(safeUser);
    const { data, select } = user.update.mock.calls[0][0];
    expect(data.email).toBe('john@example.com');
    expect(data.isActive).toBe(false);
    for (const key of ['password', 'passwordHash', 'role'])
      expect(data).not.toHaveProperty(key);
    expect(select).not.toHaveProperty('passwordHash');
  });

  it('returns 409 for a duplicate email during update', async () => {
    user.update.mockRejectedValue(prismaError('P2002'));
    await expect(
      service.update(safeUser.id, { email: 'other@example.com' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns 404 when updating a missing user', async () => {
    user.update.mockRejectedValue(prismaError('P2025'));
    await expect(service.update(safeUser.id, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('performs a real delete and returns no content', async () => {
    user.delete.mockResolvedValue({ id: safeUser.id });
    expect(await service.remove(safeUser.id)).toBeUndefined();
    expect(user.delete).toHaveBeenCalledWith({
      where: { id: safeUser.id },
      select: { id: true },
    });
  });

  it('returns 404 when deleting a missing user', async () => {
    user.delete.mockRejectedValue(prismaError('P2025'));
    await expect(service.remove(safeUser.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('hides unexpected database errors', async () => {
    user.findMany.mockRejectedValue(new Error('credentials and SQL'));
    await expect(service.findAll()).rejects.toThrow(
      new InternalServerErrorException('Unable to complete user operation'),
    );
  });
  it.each(['create', 'update'])(
    'maps username conflicts for %s',
    async (operation) => {
      user[operation as 'create' | 'update'].mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique conflict', {
          code: 'P2002',
          clientVersion: '7.10.0',
          meta: { target: ['user_name'] },
        }),
      );
      const result =
        operation === 'create'
          ? service.create({ ...dto, userName: 'taken' })
          : service.update(safeUser.id, { userName: 'taken' });
      await expect(result).rejects.toThrow('Username is already in use');
    },
  );
  it('recognizes Prisma 7 PostgreSQL adapter username constraint metadata', async () => {
    user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique conflict', {
        code: 'P2002',
        clientVersion: '7.10.0',
        meta: {
          driverAdapterError: {
            cause: { constraint: { index: 'users_user_name_key' } },
          },
        },
      }),
    );
    await expect(service.create({ ...dto, userName: 'taken' })).rejects.toThrow(
      'Username is already in use',
    );
  });
});
