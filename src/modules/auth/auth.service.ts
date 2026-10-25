import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { verify } from 'argon2';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service.js';
import { accessTokenSeconds } from '../../config/jwt.config.js';
import { authenticatedUserSelect } from '../../common/types/authenticated-user.type.js';
import type { LoginDto } from './dto/login.dto.js';
import type { ChangePasswordDto } from './dto/change-password.dto.js';
import { hashPassword } from './password.js';

// Use comparable password work for unknown accounts without keeping plaintext.
const dummyHash = hashPassword(randomBytes(32));
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

  /**
   * Changes the signed-in user's password after verifying the current one. Access
   * tokens are stateless and there are no refresh tokens, so the current session (and
   * any other signed-in device) stays valid until its token expires.
   */
  async changePassword(userId: string, dto: ChangePasswordDto) {
    if (dto.newPassword !== dto.confirmPassword)
      throw new BadRequestException('New passwords do not match');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    let matches = false;
    try {
      matches =
        !!user && (await verify(user.passwordHash, dto.currentPassword));
    } catch {
      // A malformed stored hash never verifies.
    }
    if (!matches)
      throw new BadRequestException('Current password is incorrect');
    if (dto.newPassword === dto.currentPassword)
      throw new BadRequestException(
        'New password must be different from your current password',
      );
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(dto.newPassword) },
      select: { id: true },
    });
    return { message: 'Password updated' };
  }
}
