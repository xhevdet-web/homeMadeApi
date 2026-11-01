import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { WEB_CLIENT_HEADER } from '../modules/auth/session-cookie.js';

export function setupApp(app: INestApplication): void {
  const origins =
    process.env.CORS_ORIGINS?.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean) ??
    (process.env.NODE_ENV === 'production'
      ? []
      : [
          'http://localhost:8081',
          'http://127.0.0.1:8081',
          'http://localhost:5173',
          'http://127.0.0.1:5173',
        ]);
  app.enableCors({
    origin: origins,
    // The website's session cookie is only sent and accepted with credentials.
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', WEB_CLIENT_HEADER],
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false, value: false },
    }),
  );
}
