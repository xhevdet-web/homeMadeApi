import {
  applyDecorators,
  ArgumentsHost,
  BadRequestException,
  Catch,
  Injectable,
  PayloadTooLargeException,
  UseFilters,
  UseInterceptors,
  type CallHandler,
  type ExceptionFilter,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import {
  FileFieldsInterceptor,
  FileInterceptor,
} from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  validateImage,
} from './image-validation.js';

@Catch(PayloadTooLargeException)
class UploadSizeFilter implements ExceptionFilter {
  catch(_error: PayloadTooLargeException, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(400)
      .json(
        new BadRequestException('Image must be at most 5 MB').getResponse(),
      );
  }
}

@Injectable()
class MultipartFieldsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.file) validateImage(request.file);
    const files = request.files as
      Record<string, Express.Multer.File[]> | undefined;
    if (files && !Array.isArray(files))
      for (const group of Object.values(files))
        for (const file of group) validateImage(file);
    // Preserve strict JSON DTO validation. Only multipart transports numbers/booleans as text.
    if (request.is('multipart/form-data')) {
      const body = request.body as Record<string, unknown>;
      for (const field of ['price', 'basePrice', 'stock', 'sortOrder']) {
        const value = body[field];
        if (typeof value === 'string' && /^-?\d+$/.test(value))
          body[field] = Number(value);
      }
      for (const field of ['isActive', 'trackStock', 'removeBackground']) {
        if (body[field] === 'true') body[field] = true;
        if (body[field] === 'false') body[field] = false;
      }
      for (const field of [
        'items',
        'sizes',
        'options',
        'selectedOptions',
        'textLayers',
        'builderConfig',
        'frontPrintArea',
        'backPrintArea',
      ]) {
        if (typeof body[field] === 'string') {
          try {
            body[field] = JSON.parse(body[field]) as unknown;
          } catch {
            throw new BadRequestException(field + ' must be valid JSON');
          }
        }
      }
    }
    return next.handle();
  }
}

export function ImageUpload(
  entity: 'category' | 'subCategory' | 'product' | 'garment',
  update = false,
) {
  const properties: Record<string, object> = {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', nullable: true },
    isActive: { type: 'boolean' },
    file: {
      type: 'string',
      format: 'binary',
      description: 'Optional JPEG, PNG or WebP, maximum 5 MB.',
    },
  };
  if (entity === 'garment') {
    delete properties.file;
    const printArea = {
      description:
        'Printable area as fractions of the mockup, with optional real print size: ' +
        '{ x, y, width, height, widthCm?, heightCm? }. Multipart: JSON.stringify(area).',
      nullable: true,
      oneOf: [{ type: 'string' }, { type: 'object' }],
    };
    Object.assign(properties, {
      basePrice: {
        type: 'integer',
        minimum: 0,
        description: 'Blank garment price in cents.',
      },
      silhouette: {
        type: 'string',
        nullable: true,
        description: 'App-drawn fallback, e.g. HOODIE or TSHIRT.',
      },
      frontPrintArea: printArea,
      backPrintArea: printArea,
      image: {
        type: 'string',
        format: 'binary',
        description: 'Product photo shown to customers.',
      },
      frontImage: {
        type: 'string',
        format: 'binary',
        description: 'Front mockup used as the studio canvas.',
      },
      backImage: {
        type: 'string',
        format: 'binary',
        description: 'Back mockup used as the studio canvas.',
      },
    });
  }
  if (entity === 'category') {
    properties.designCategoryId = {
      type: 'string',
      format: 'uuid',
      nullable: true,
      description:
        'Use the designs (sub-categories) of this library category too.',
    };
    properties.builderType = {
      type: 'string',
      nullable: true,
      enum: ['JEWELRY', 'BOUQUET', 'GIFT', 'APPAREL'],
    };
    properties.options = {
      description:
        'Optional dynamic option definitions or null. Multipart: JSON.stringify(options).',
      nullable: true,
      oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }],
    };
    properties.sizes = {
      description:
        'Optional sizes array or null. Multipart: JSON.stringify(sizes). Size IDs must be unique.',
      nullable: true,
      oneOf: [
        { type: 'string' },
        {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'name', 'measurement', 'unit', 'maxItems'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              measurement: { type: 'number', exclusiveMinimum: 0 },
              unit: { type: 'string' },
              maxItems: { type: 'integer', minimum: 1 },
            },
          },
        },
      ],
    };
  }
  if (entity === 'product') {
    properties.selectedSizeId = {
      type: 'string',
      description:
        'Optional size ID resolved from the selected category. Omit on update to preserve the size snapshot.',
    };
    properties.selectedOptions = {
      description:
        'Selections validated against Category.options. Multipart: JSON.stringify(selectedOptions).',
      nullable: true,
      oneOf: [{ type: 'string' }, { type: 'object' }],
    };
    properties.textLayers = {
      description:
        'GIFT only: personalised text [{ id, text, x, y, scale, rotation, color?, font? }], x/y 0–1 of the canvas. Multipart: JSON.stringify(textLayers).',
      nullable: true,
      oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }],
    };
  }
  if (entity !== 'category')
    properties.categoryId = { type: 'string', format: 'uuid' };
  if (entity !== 'product')
    properties.sortOrder = { type: 'integer', minimum: 0 };
  if (entity === 'subCategory')
    Object.assign(properties, {
      color: { type: 'string', nullable: true },
      type: { type: 'string', nullable: true },
      price: {
        type: 'integer',
        minimum: 0,
        description: 'Price per component in cents',
      },
      stock: { type: 'integer', minimum: 0 },
      trackStock: {
        type: 'boolean',
        description:
          'false for unlimited printed designs; physical items keep stock.',
      },
      removeBackground: {
        type: 'boolean',
        description:
          'Upload only. false keeps fine logos and lettering exactly as uploaded.',
      },
    });
  if (entity === 'product')
    Object.assign(properties, {
      productType: {
        type: 'string',
        enum: ['CUSTOM_DESIGN', 'READY_MADE'],
        description:
          'Defaults to CUSTOM_DESIGN. Cannot be changed after creation.',
      },
      price: {
        type: 'integer',
        minimum: 0,
        maximum: 2147483647,
        description:
          'Required for READY_MADE, in cents. CUSTOM_DESIGN price is calculated.',
      },
      stock: {
        type: 'integer',
        minimum: 0,
        maximum: 2147483647,
        description: 'Required finished-product inventory for READY_MADE.',
      },
    });
  if (entity === 'product')
    properties.items = {
      description:
        'Multipart: JSON text. JSON requests: array. Required and nonempty for CUSTOM_DESIGN; optional for READY_MADE.',
      oneOf: [
        {
          type: 'string',
          example:
            '[{"subCategoryId":"550e8400-e29b-41d4-a716-446655440000","quantity":8,"position":1}]',
        },
        {
          type: 'array',
          minItems: 0,
          maxItems: 1000,
          items: {
            type: 'object',
            required: ['subCategoryId', 'quantity'],
            properties: {
              subCategoryId: { type: 'string', format: 'uuid' },
              quantity: { type: 'integer', minimum: 1 },
              position: { type: 'integer', minimum: 0 },
            },
          },
        },
      ],
    };
  if (entity === 'product')
    properties.designPreview = {
      type: 'string',
      format: 'binary',
      description:
        'Optional generated design preview, JPEG, PNG or WebP, maximum 5 MB.',
    };
  if (entity === 'product')
    properties.backDesignPreview = {
      type: 'string',
      format: 'binary',
      description:
        'Optional back-side preview for two-sided APPAREL designs, maximum 5 MB.',
    };
  if (entity === 'product')
    properties.customDesigns = {
      type: 'array',
      maxItems: 4,
      items: { type: 'string', format: 'binary' },
      description:
        'Customer artwork for "Your own design" (CUSTOM_UPLOAD) items; each item references one by customDesignIndex.',
    };
  const options = {
    limits: {
      fileSize: MAX_IMAGE_BYTES,
      files: entity === 'product' ? 7 : entity === 'garment' ? 3 : 1,
      fields: 20,
      fieldSize: 1024 * 1024,
    },
    fileFilter: (
      _request: Request,
      file: Express.Multer.File,
      callback: (error: Error | null, acceptFile: boolean) => void,
    ) => {
      const valid = IMAGE_MIME_TYPES.includes(file.mimetype);
      callback(
        valid
          ? null
          : new BadRequestException(
              'Only JPEG, PNG and WebP images are accepted',
            ),
        valid,
      );
    },
  };
  return applyDecorators(
    ApiBearerAuth(),
    ApiConsumes('multipart/form-data', 'application/json'),
    ApiBody({
      schema: {
        type: 'object',
        properties,
        required: update
          ? []
          : [
              'name',
              ...(entity !== 'category' ? ['categoryId'] : []),
              ...(entity === 'garment' ? ['basePrice'] : []),
            ],
      },
    }),
    UseFilters(UploadSizeFilter),
    UseInterceptors(
      entity === 'product'
        ? FileFieldsInterceptor(
            [
              { name: 'file', maxCount: 1 },
              { name: 'designPreview', maxCount: 1 },
              { name: 'backDesignPreview', maxCount: 1 },
              { name: 'customDesigns', maxCount: 4 },
            ],
            options,
          )
        : entity === 'garment'
          ? FileFieldsInterceptor(
              [
                { name: 'image', maxCount: 1 },
                { name: 'frontImage', maxCount: 1 },
                { name: 'backImage', maxCount: 1 },
              ],
              options,
            )
          : FileInterceptor('file', options),
      MultipartFieldsInterceptor,
    ),
  );
}
