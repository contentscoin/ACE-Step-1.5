import { MAX_PASSWORD_BYTES } from '../../../services/account/password-hasher';

/**
 * Request/response schemas for the auth routes.
 *
 * Fastify validates and serialises from these (design §12: "높은 처리량, 스키마
 * 검증 내장"), so malformed input is rejected before any account code runs and
 * no field can leak into a response unless it is declared here.
 */
export const MIN_PASSWORD_LENGTH = 8;

export const emailProperty = {
  type: 'string',
  format: 'email',
  minLength: 3,
  maxLength: 254,
} as const;

export const passwordProperty = {
  type: 'string',
  minLength: MIN_PASSWORD_LENGTH,
  // bcrypt consumes at most 72 bytes; a longer secret would be silently
  // truncated, so it is refused at the edge instead.
  maxLength: MAX_PASSWORD_BYTES,
} as const;

const errorResponse = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
      additionalProperties: true,
    },
  },
} as const;

const tokenPairResponse = {
  type: 'object',
  required: [
    'accountId',
    'email',
    'tokenType',
    'accessToken',
    'accessTokenExpiresAt',
    'accessTokenExpiresInSeconds',
    'refreshToken',
    'refreshTokenExpiresAt',
    'refreshTokenExpiresInSeconds',
  ],
  properties: {
    accountId: { type: 'string' },
    email: { type: 'string' },
    tokenType: { type: 'string' },
    accessToken: { type: 'string' },
    accessTokenExpiresAt: { type: 'string' },
    accessTokenExpiresInSeconds: { type: 'integer' },
    refreshToken: { type: 'string' },
    refreshTokenExpiresAt: { type: 'string' },
    refreshTokenExpiresInSeconds: { type: 'integer' },
  },
} as const;

export const registerSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: { email: emailProperty, password: passwordProperty },
  },
  response: {
    201: {
      type: 'object',
      required: ['accountId', 'email', 'emailVerificationSent'],
      properties: {
        accountId: { type: 'string' },
        email: { type: 'string' },
        emailVerificationSent: { type: 'boolean' },
      },
    },
    409: errorResponse,
  },
} as const;

export const loginSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: { email: emailProperty, password: passwordProperty },
  },
  response: { 200: tokenPairResponse, 401: errorResponse, 429: errorResponse },
} as const;

export const refreshSchema = {
  body: {
    type: 'object',
    required: ['refreshToken'],
    additionalProperties: false,
    properties: { refreshToken: { type: 'string', minLength: 1 } },
  },
  response: { 200: tokenPairResponse, 401: errorResponse },
} as const;

export const logoutSchema = {
  body: refreshSchema.body,
  response: { 204: { type: 'null' }, 401: errorResponse },
} as const;

export const verifyEmailSchema = {
  body: {
    type: 'object',
    required: ['token'],
    additionalProperties: false,
    properties: { token: { type: 'string', minLength: 1 } },
  },
  response: {
    200: {
      type: 'object',
      required: ['accountId', 'email', 'emailVerified'],
      properties: {
        accountId: { type: 'string' },
        email: { type: 'string' },
        emailVerified: { type: 'boolean' },
      },
    },
    401: errorResponse,
  },
} as const;

export const socialAuthorizeSchema = {
  params: {
    type: 'object',
    required: ['provider'],
    properties: { provider: { type: 'string', minLength: 1 } },
  },
  querystring: {
    type: 'object',
    required: ['redirectUri'],
    additionalProperties: false,
    properties: { redirectUri: { type: 'string', minLength: 1, maxLength: 2048 } },
  },
  response: {
    200: {
      type: 'object',
      required: ['provider', 'authorizationUrl', 'state', 'nonce'],
      properties: {
        provider: { type: 'string' },
        authorizationUrl: { type: 'string' },
        state: { type: 'string' },
        nonce: { type: 'string' },
      },
    },
    404: errorResponse,
  },
} as const;

export const socialCallbackSchema = {
  params: socialAuthorizeSchema.params,
  body: {
    type: 'object',
    required: ['code', 'state', 'expectedState', 'redirectUri'],
    additionalProperties: false,
    properties: {
      code: { type: 'string', minLength: 1 },
      state: { type: 'string', minLength: 1 },
      expectedState: { type: 'string', minLength: 1 },
      redirectUri: { type: 'string', minLength: 1, maxLength: 2048 },
    },
  },
  response: {
    200: {
      ...tokenPairResponse,
      required: [...tokenPairResponse.required, 'accountCreated'],
      properties: { ...tokenPairResponse.properties, accountCreated: { type: 'boolean' } },
    },
    400: errorResponse,
    404: errorResponse,
  },
} as const;

export const currentAccountSchema = {
  response: {
    200: {
      type: 'object',
      required: ['accountId', 'email', 'emailVerified', 'sessionId'],
      properties: {
        accountId: { type: 'string' },
        email: { type: 'string' },
        emailVerified: { type: 'boolean' },
        sessionId: { type: 'string' },
      },
    },
    401: errorResponse,
  },
} as const;
