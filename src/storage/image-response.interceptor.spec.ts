import { ConfigService } from '@nestjs/config';
import { firstValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { ImageResponseInterceptor } from './image-response.interceptor.js';
import { StorageService } from './storage.service.js';

describe('ImageResponseInterceptor', () => {
  it('derives Product preview URLs, including the Product nested in Order detail', async () => {
    const storage = new StorageService(
      new ConfigService({
        R2_PUBLIC_URL: 'https://images.example.test/',
      }),
    );
    const interceptor = new ImageResponseInterceptor(storage);
    const response = await firstValueFrom(
      interceptor.intercept(
        {} as ExecutionContext,
        {
          handle: () =>
            of({
              id: 'order-id',
              product: {
                id: 'product-id',
                imageKey: 'products/main.png',
                designPreviewKey: 'designs/preview.png',
                items: [{ quantity: 2, unitPrice: 150 }],
              },
            }),
        } as CallHandler,
      ),
    );
    expect(response).toMatchObject({
      product: {
        imageUrl: 'https://images.example.test/products/main.png',
        designPreviewUrl: 'https://images.example.test/designs/preview.png',
        items: [{ quantity: 2, unitPrice: 150 }],
      },
    });
  });

  it('sets designPreviewUrl to null for products without a preview', async () => {
    const interceptor = new ImageResponseInterceptor(
      new StorageService(new ConfigService()),
    );
    const response = await firstValueFrom(
      interceptor.intercept(
        {} as ExecutionContext,
        {
          handle: () => of({ id: 'product-id', designPreviewKey: null }),
        } as CallHandler,
      ),
    );
    expect(response).toEqual({
      id: 'product-id',
      designPreviewKey: null,
      designPreviewUrl: null,
    });
  });
});
