import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { hash, argon2id } from 'argon2';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { CreateUserDto } from './dto/create-user.dto.js';
import type { UpdateUserDto } from './dto/update-user.dto.js';
import type { UpdateProfileDto } from './dto/update-profile.dto.js';

const userSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  userName: true,
  country: true,
  address: true,
  postalCode: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(dto: CreateUserDto) {
    const passwordHash = await hash(dto.password, { type: argon2id });
    return this.query(() =>
      this.prisma.user.create({
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email.trim().toLowerCase(),
          passwordHash,
          phone: dto.phone,
          userName:
            dto.userName === null ? null : dto.userName?.trim().toLowerCase(),
          country: dto.country,
          address: dto.address,
          postalCode: dto.postalCode,
          role: 'CUSTOMER',
          isActive: true,
        },
        select: userSelect,
      }),
    );
  }

  findAll() {
    return this.query(() => this.prisma.user.findMany({ select: userSelect }));
  }

  async findOne(id: string) {
    const user = await this.query(() =>
      this.prisma.user.findUnique({ where: { id }, select: userSelect }),
    );
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  updateProfile(id: string, dto: UpdateProfileDto) {
    return this.update(id, {
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone: dto.phone,
      country: dto.country,
      address: dto.address,
      postalCode: dto.postalCode,
    });
  }

  update(id: string, dto: UpdateUserDto) {
    return this.query(() =>
      this.prisma.user.update({
        where: { id },
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email?.trim().toLowerCase(),
          phone: dto.phone,
          userName:
            dto.userName === null ? null : dto.userName?.trim().toLowerCase(),
          country: dto.country,
          address: dto.address,
          postalCode: dto.postalCode,
          isActive: dto.isActive,
        },
        select: userSelect,
      }),
    );
  }

  async remove(id: string): Promise<void> {
    await this.query(() =>
      this.prisma.user.delete({ where: { id }, select: { id: true } }),
    );
  }

  private async query<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          const adapter = error.meta?.driverAdapterError as
            | { cause?: { constraint?: { fields?: unknown; index?: unknown } } }
            | undefined;
          const rawTarget =
            error.meta?.target ??
            adapter?.cause?.constraint?.fields ??
            adapter?.cause?.constraint?.index;
          const target =
            typeof rawTarget === 'string'
              ? rawTarget
              : Array.isArray(rawTarget)
                ? rawTarget
                    .filter(
                      (field): field is string => typeof field === 'string',
                    )
                    .join(',')
                : '';
          throw new ConflictException(
            /user_?name/i.test(target)
              ? 'Username is already in use'
              : 'Email is already in use',
          );
        }
        if (error.code === 'P2003')
          throw new ConflictException(
            'This user has linked records and cannot be deleted. Deactivate the account instead.',
          );
        if (error.code === 'P2025')
          throw new NotFoundException('User not found');
      }
      // Do not expose database details or Prisma query arguments to the client.
      throw new InternalServerErrorException(
        'Unable to complete user operation',
      );
    }
  }
}
