import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import {
  isSafeMethod,
  isWebClient,
  readSessionCookie,
} from '../session-cookie.js';
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

  /** Whether the request carries any session, by Bearer header or website cookie. */
  hasCredentials(request: Request) {
    return (
      !!request.headers.authorization ||
      !!readSessionCookie(request.headers.cookie)
    );
  }

  /**
   * The Bearer header (mobile app) wins; otherwise the website's session cookie. A
   * cookie-authenticated write must also carry the website's client header.
   */
  async authenticateRequest(request: Request): Promise<AuthenticatedUser> {
    if (request.headers.authorization)
      return this.authenticate(request.headers.authorization);
    const token = readSessionCookie(request.headers.cookie);
    if (!token) throw new UnauthorizedException('Invalid or expired session');
    if (!isSafeMethod(request.method) && !isWebClient(request.headers))
      throw new UnauthorizedException('Invalid or expired session');
    return this.verify(token);
  }

  async authenticate(authorization?: string): Promise<AuthenticatedUser> {
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);
    if (!match) throw new UnauthorizedException('Invalid or expired session');
    return this.verify(match[1]);
  }

  private async verify(token: string): Promise<AuthenticatedUser> {
    let subject: string;
    try {
      const payload = await this.jwt.verifyAsync<{
        sub?: unknown;
        tokenUse?: unknown;
        exp?: unknown;
      }>(token);
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
