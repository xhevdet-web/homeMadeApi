import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtStrategy } from '../../modules/auth/strategies/jwt.strategy.js';
import type { AuthenticatedUser } from '../types/authenticated-user.type.js';

/**
 * For public routes whose response depends on who asks (e.g. a customer's private phone
 * case photos). A valid session sets request.user; no session, or an expired one, reads
 * the route anonymously instead of failing it.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(@Inject(JwtStrategy) private readonly strategy: JwtStrategy) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    if (!request.headers.authorization) return true;
    try {
      request.user = await this.strategy.authenticate(
        request.headers.authorization,
      );
    } catch {
      request.user = undefined;
    }
    return true;
  }
}
