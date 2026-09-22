import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtStrategy } from '../../modules/auth/strategies/jwt.strategy.js';
import type { AuthenticatedUser } from '../types/authenticated-user.type.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(JwtStrategy) private readonly strategy: JwtStrategy) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    request.user = await this.strategy.authenticate(
      request.headers.authorization,
    );
    return true;
  }
}
