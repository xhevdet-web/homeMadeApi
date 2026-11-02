import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { verify } from 'argon2';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { accessTokenSeconds } from '../../config/jwt.config.js';
import {
  authenticatedUserSelect,
  type AuthenticatedUser,
} from '../../common/types/authenticated-user.type.js';
import type { LoginDto } from './dto/login.dto.js';
import type { ChangePasswordDto } from './dto/change-password.dto.js';
import type { GoogleLoginDto } from './dto/google-login.dto.js';
import { hashPassword } from './password.js';
import {
  GOOGLE_SIGN_IN_FAILED,
  GoogleTokenVerifier,
  type GoogleIdentity,
} from './google-token.verifier.js';

// Use comparable password work for unknown accounts without keeping plaintext.
const dummyHash = hashPassword(randomBytes(32));

/** The 409 the apps answer by asking for the HM Craft password, then sending it with the token. */
export const GOOGLE_LINK_REQUIRED =
  'An account with this email already exists. Enter your password to connect Google.';

const googleUserSelect = {
  ...authenticatedUserSelect,
  passwordHash: true,
  googleId: true,
} satisfies Prisma.UserSelect;
type GoogleCandidate = Prisma.UserGetPayload<{ select: typeof googleUserSelect }>;

@Injectable()
export class AuthService {
  private readonly expiresIn = accessTokenSeconds();
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(GoogleTokenVerifier) private readonly google: GoogleTokenVerifier,
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
    // Google-only accounts have no hash and are checked against the dummy, so they fail
    // like a wrong password.
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
    const { passwordHash: _passwordHash, ...safeUser } = user;
    return this.session(safeUser);
  }

  /**
   * Sign-in and sign-up with Google, for the website and the app alike. The verified token
   * decides who the person is; the result is the same session as a password login.
   *
   * - Google ID already linked → that account.
   * - Otherwise a verified Google email is required. An existing account with that email is
   *   linked only after its HM Craft password is given (409 until then): HM Craft never
   *   verified emails at registration, so a matching email alone doesn't prove ownership.
   * - No account → a new CUSTOMER without a password.
   */
  async googleLogin(dto: GoogleLoginDto) {
    const google = await this.google.verify(dto.idToken);
    const linked = await this.prisma.user.findUnique({
      where: { googleId: google.sub },
      select: googleUserSelect,
    });
    if (linked) return this.googleSession(linked);
    if (!google.email || !google.emailVerified)
      throw new UnauthorizedException(GOOGLE_SIGN_IN_FAILED);
    const existing = await this.prisma.user.findUnique({
      where: { email: google.email },
      select: googleUserSelect,
    });
    if (existing) return this.linkGoogle(existing, google.sub, dto.password);
    return this.createGoogleUser(google, google.email);
  }

  private async linkGoogle(
    user: GoogleCandidate,
    googleId: string,
    password: string | undefined,
  ) {
    // Already tied to another Google account, disabled, or nothing to prove ownership with.
    if (user.googleId || !user.isActive || !user.passwordHash)
      throw new UnauthorizedException(GOOGLE_SIGN_IN_FAILED);
    if (password === undefined)
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: GOOGLE_LINK_REQUIRED,
        email: user.email,
      });
    let matches = false;
    try {
      matches = await verify(user.passwordHash, password);
    } catch {
      // A malformed stored hash never verifies.
    }
    if (!matches) throw new UnauthorizedException('Incorrect password');
    // The password hash is kept: the customer can still sign in either way.
    try {
      const { count } = await this.prisma.user.updateMany({
        where: { id: user.id, googleId: null },
        data: { googleId },
      });
      if (count !== 1) throw new UnauthorizedException(GOOGLE_SIGN_IN_FAILED);
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException(GOOGLE_SIGN_IN_FAILED);
    }
    return this.googleSession(user);
  }

  private async createGoogleUser(google: GoogleIdentity, email: string) {
    let user: GoogleCandidate;
    try {
      user = await this.prisma.user.create({
        data: {
          // Names only when Google has them; the app asks for any that are missing.
          firstName: google.givenName?.slice(0, 100) ?? '',
          lastName: google.familyName?.slice(0, 100) ?? '',
          email,
          googleId: google.sub,
          // Never from the token or the request: social sign-up is always a customer.
          role: 'CUSTOMER',
          isActive: true,
        },
        select: googleUserSelect,
      });
    } catch (error) {
      // A parallel first sign-in created the account a moment earlier.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const created = await this.prisma.user.findUnique({
          where: { googleId: google.sub },
          select: googleUserSelect,
        });
        if (created) return this.googleSession(created);
      }
      throw new UnauthorizedException(GOOGLE_SIGN_IN_FAILED);
    }
    return this.googleSession(user);
  }

  private async googleSession({
    passwordHash: _passwordHash,
    googleId: _googleId,
    ...user
  }: GoogleCandidate) {
    // A disabled account stays disabled whichever way the customer signs in.
    if (!user.isActive) throw new UnauthorizedException(GOOGLE_SIGN_IN_FAILED);
    return {
      ...(await this.session(user)),
      // False when Google gave no first or last name: the apps ask for them.
      profileComplete: !!user.firstName.trim() && !!user.lastName.trim(),
    };
  }

  /** The HM Craft access token for a signed-in user: one session for every sign-in method. */
  private async session(user: AuthenticatedUser) {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      tokenUse: 'access',
    });
    return { accessToken, expiresIn: this.expiresIn, user };
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
    // Accounts created with Google have no password to change.
    if (user && !user.passwordHash)
      throw new BadRequestException(
        'This account signs in with Google and has no password',
      );
    let matches = false;
    try {
      matches =
        !!user?.passwordHash &&
        (await verify(user.passwordHash, dto.currentPassword));
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
