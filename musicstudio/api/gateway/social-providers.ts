import {
  APPLE_OIDC_ENDPOINTS,
  createOidcAuthorizationCodeProvider,
  GOOGLE_OIDC_ENDPOINTS,
} from '../../services/account/adapters/oidc-provider';
import type { OAuthProvider } from '../../services/account/oauth-provider';

import type { GatewayConfig } from './config';

/**
 * Builds the OAuth provider list from configuration (Requirement 1.7).
 *
 * A provider appears only when its credentials are present, which is how the
 * requirement's `WHERE ... 설정된 경우` guard is realised: an unconfigured
 * provider is absent from the registry and its routes answer
 * `social_login_not_configured`.
 */
export function buildSocialProviders(config: GatewayConfig): OAuthProvider[] {
  const providers: OAuthProvider[] = [];

  if (config.google !== null) {
    const { clientId, clientSecret } = config.google;
    providers.push(
      createOidcAuthorizationCodeProvider({
        id: 'google',
        clientId,
        clientSecret: () => clientSecret,
        ...GOOGLE_OIDC_ENDPOINTS,
      }),
    );
  }

  if (config.apple !== null) {
    const { clientId, clientSecret } = config.apple;
    providers.push(
      createOidcAuthorizationCodeProvider({
        id: 'apple',
        clientId,
        // Apple expects a signed, short-lived client secret. Reading it from
        // configuration on every call keeps rotation outside this module.
        clientSecret: () => clientSecret,
        responseMode: 'form_post',
        ...APPLE_OIDC_ENDPOINTS,
      }),
    );
  }

  return providers;
}
