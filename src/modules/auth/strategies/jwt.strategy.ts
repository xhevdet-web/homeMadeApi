import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../../database/prisma.service.js';
import {
  authenticatedUserSelect,
  type AuthenticatedUser,
} from '../../../common/types/authenticated-user.type.js';

// Uses the existing @nestjs/jwt verifier; Passport is not required for this strategy.
@Injectable()
export class JwtStrategy {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async authenticate(authorization?: string): Promise<AuthenticatedUser> {
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);
    if (!match) throw new UnauthorizedException('Invalid or expired session');
    let subject: string;
    try {
      const payload = await this.jwt.verifyAsync<{
        sub?: unknown;
        tokenUse?: unknown;
        exp?: unknown;
      }>(match[1]);
      if (
        typeof payload.sub !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          payload.sub,
        ) ||
        payload.tokenUse !== 'access' ||
        typeof payload.exp !== 'number'
      )
        throw new Error('Invalid access token');
      subject = payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: subject },
      select: authenticatedUserSelect,
    });
    if (!user || !user.isActive)
      throw new UnauthorizedException('Invalid or expired session');
    return user;
  }
}
