import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { argon2id, hash, verify } from 'argon2';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service.js';
import { accessTokenSeconds } from '../../config/jwt.config.js';
import { authenticatedUserSelect } from '../../common/types/authenticated-user.type.js';
import type { LoginDto } from './dto/login.dto.js';

// Use comparable password work for unknown accounts without keeping plaintext.
const dummyHash = hash(randomBytes(32), { type: argon2id });
@Injectable()
export class AuthService {
  private readonly expiresIn = accessTokenSeconds();
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto) {
    if (dto.email !== undefined && dto.identifier !== undefined)
      throw new BadRequestException(
        'Provide either identifier or email, not both',
      );
    const identifier = (dto.identifier ?? dto.email ?? '').trim().toLowerCase();
    if (!identifier)
      throw new BadRequestException('Email or username is required');
    const user = await this.prisma.user.findUnique({
      where: identifier.includes('@')
        ? { email: identifier }
        : { userName: identifier },
      select: { ...authenticatedUserSelect, passwordHash: true },
    });
    let matches = false;
    try {
      matches = await verify(
        user?.passwordHash ?? (await dummyHash),
        dto.password,
      );
    } catch {
      // Legacy placeholder/malformed hashes are not valid credentials.
    }
    if (!user || !user.isActive || !matches)
      throw new UnauthorizedException('Invalid email or password');
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      tokenUse: 'access',
    });
    const { passwordHash: _passwordHash, ...safeUser } = user;
    return { accessToken, expiresIn: this.expiresIn, user: safeUser };
  }
}
