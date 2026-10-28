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
        effectiveLengthMm: true,
      },
    },
  },
} satisfies Prisma.Product$itemsArgs;

// The COMPANY product a customer design is made on (e.g. the hoodie it is printed on),
// shared by product and order responses.
export const baseProductSelect = {
  id: true,
  name: true,
  price: true,
  color: true,
  colorHex: true,
  imageKey: true,
  backImageKey: true,
  printAreas: true,
  // Phone case models: the brand and the overlay drawn above the artwork.
  deviceBrand: true,
  overlayImageKey: true,
  sizes: true,
  isActive: true,
} satisfies Prisma.ProductSelect;
