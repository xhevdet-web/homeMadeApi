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
    createdAt: true,
    updatedAt: true,
    subCategory: {
      select: {
        id: true,
        categoryId: true,
        name: true,
        description: true,
        imageUrl: true,
        color: true,
        type: true,
        price: true,
      },
    },
  },
} satisfies Prisma.Product$itemsArgs;
