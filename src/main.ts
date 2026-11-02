import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { setupApp } from './config/setup-app.js';
import { setupSwagger } from './config/setup-swagger.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  setupApp(app);
  setupSwagger(app);
  app.enableShutdownHooks();
  await app.listen(
    process.env.PORT ?? 3000,
    process.env.HOST ?? '0.0.0.0',
  );
}
await bootstrap();
