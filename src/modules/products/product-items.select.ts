import type { Prisma } from '../../generated/prisma/client.js';

// Shared by product and order responses; unitPrice is the saved price, not today's catalog price.
export const productItemsSelect = {
  orderBy: [{ position: 'asc' }, { id: 'asc' }],
  select: {
    id: true,
    subCategoryId: true,
    quantity: true,
    position: true,
    unitPrice: true,
    customImageKey: true,
    side: true,
    x: true,
    y: true,
    scale: true,
    rotation: true,
    createdAt: true,
    updatedAt: true,
    subCategory: {
      select: {
        id: true,
        categoryId: true,
        name: true,
        description: true,

        imageKey: true,
        originalImageKey: true,
        color: true,
        type: true,
        price: true,
      },
    },
  },
} satisfies Prisma.Product$itemsArgs;

// The garment a design is printed on, shared by product and order responses.
export const garmentVariantSelect = {
  id: true,
  size: true,
  colorName: true,
  colorValue: true,
  sku: true,
  price: true,
  isActive: true,
  garment: {
    select: {
      id: true,
      name: true,
      basePrice: true,
      imageKey: true,
      frontImageKey: true,
      backImageKey: true,
      frontPrintArea: true,
      backPrintArea: true,
      silhouette: true,
    },
  },
} satisfies Prisma.GarmentVariantSelect;
