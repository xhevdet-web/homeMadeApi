import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';

/** One message for every rejected Google credential, so failures reveal nothing more. */
export const GOOGLE_SIGN_IN_FAILED = 'Unable to sign in with Google';

/** The verified claims HM Craft uses. Never taken from the request body. */
export interface GoogleIdentity {
  /** Google's stable account ID. */
  sub: string;
  email: string | null;
  emailVerified: boolean;
  givenName: string | null;
  familyName: string | null;
}

/**
 * The OAuth client IDs whose ID tokens this API accepts. The website and Android both sign
 * in with the web client ID (Android tokens carry it as their audience); iOS tokens carry
 * the iOS client ID. GOOGLE_ANDROID_CLIENT_ID is accepted too in case a build requests it.
 */
export function googleAudiences(): string[] {
  return [
    process.env.GOOGLE_WEB_CLIENT_ID,
    process.env.GOOGLE_IOS_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
  ]
    .map((id) => id?.trim())
    .filter((id): id is string => !!id);
}

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

@Injectable()
export class GoogleTokenVerifier {
  private readonly client = new OAuth2Client();

  /**
   * Verifies the ID token with Google's library: signature against Google's published keys,
   * issuer (accounts.google.com), expiry and audience. The token is never just decoded.
   */
  async verify(idToken: string): Promise<GoogleIdentity> {
    const audience = googleAudiences();
    if (!audience.length)
      throw new ServiceUnavailableException('Google sign-in is not configured');
    try {
      // Google's signing keys (cached by the library); failing here is Google being unreachable.
      await this.client.getFederatedSignonCertsAsync();
    } catch {
      throw new ServiceUnavailableException(
        'Google sign-in is temporarily unavailable',
      );
    }
    let payload;
    try {
      payload = (
        await this.client.verifyIdToken({ idToken, audience })
      ).getPayload();
    } catch {
      throw new UnauthorizedException(GOOGLE_SIGN_IN_FAILED);
    }
    const sub = text(payload?.sub);
    if (!payload || !sub) throw new UnauthorizedException(GOOGLE_SIGN_IN_FAILED);
    const verified: unknown = payload.email_verified;
    return {
      sub,
      email: text(payload.email)?.toLowerCase() ?? null,
      emailVerified: verified === true || verified === 'true',
      givenName: text(payload.given_name),
      familyName: text(payload.family_name),
    };
  }
}
