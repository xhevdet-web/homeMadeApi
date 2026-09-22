import type { Prisma } from '../../generated/prisma/client.js';

export const authenticatedUserSelect = {
  id: true,
  firstName: true,
  lastName: true,
  userName: true,
  email: true,
  phone: true,
  country: true,
  address: true,
  postalCode: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type AuthenticatedUser = Prisma.UserGetPayload<{
  select: typeof authenticatedUserSelect;
}>;
