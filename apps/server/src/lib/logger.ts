// ============================================================
// STRUCTURED LOGGER
// ============================================================

import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
  base: { service: 'fno-terminal' },
  serializers: {
    ...pino.stdSerializers,
    // Never log secrets
    req: (req) => ({
      method: req.method,
      url: req.url,
      headers: {
        'content-type': req.headers?.['content-type'],
        'user-agent': req.headers?.['user-agent'],
      },
    }),
  },
  redact: {
    paths: [
      'password',
      'apiKey',
      'totpSecret',
      'accessToken',
      'refreshToken',
      'feedToken',
      'req.headers.authorization',
    ],
  },
});
