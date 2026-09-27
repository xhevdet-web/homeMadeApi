import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { CategoriesModule } from '../modules/categories/categories.module.js';
import { SubCategoriesModule } from '../modules/sub-categories/sub-categories.module.js';
import { ProductsModule } from '../modules/products/products.module.js';

export function setupSwagger(app: INestApplication): void {
  const environment =
    app.get(ConfigService).get<string>('NODE_ENV') ?? 'development';
  if (!['development', 'test'].includes(environment)) return;
  const config = new DocumentBuilder()
    .setTitle('HomeMade API — Storage tests')
    .setDescription(
      'Categories, components and products with optional R2 image uploads. Authorize with an existing access token.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    include: [CategoriesModule, SubCategoriesModule, ProductsModule],
  });
  SwaggerModule.setup('api/docs', app, document);
}
