import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import {
  SESSION_COOKIE,
  clearedSessionCookieOptions,
  isWebClient,
  sessionCookieOptions,
} from './session-cookie.js';
import { LoginDto } from './dto/login.dto.js';
import { GoogleLoginDto } from './dto/google-login.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';

/** The website gets its session as a cookie and no token in the body; the app gets the token. */
function respond(
  session: { accessToken: string; expiresIn: number; user: AuthenticatedUser },
  request: Request,
  response: Response,
) {
  if (!isWebClient(request.headers)) return session;
  response.cookie(
    SESSION_COOKIE,
    session.accessToken,
    sessionCookieOptions(session.expiresIn),
  );
  return { expiresIn: session.expiresIn, user: session.user };
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  // The website asks for a cookie session with its client header: the token goes into
  // an httpOnly cookie and is left out of the body. The mobile app gets the token as before.
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return respond(await this.auth.login(dto), request, response);
  }

  // Google sign-in and sign-up for the website and the app. The verified Google ID token
  // becomes the same session as login above: a cookie for the website, a token for the app.
  @Post('google')
  @HttpCode(HttpStatus.OK)
  async google(
    @Body() dto: GoogleLoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { profileComplete, ...session } = await this.auth.googleLogin(dto);
    return { ...respond(session, request, response), profileComplete };
  }

  // Tokens are stateless, so signing out only removes the website's cookie.
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(SESSION_COOKIE, clearedSessionCookieOptions());
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  // The user comes from the access token only; passwords travel in the body only.
  @Patch('change-password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.auth.changePassword(user.id, dto);
  }
}
