import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

export interface PublicStats {
  /** Active customer accounts (admins are not counted). */
  registeredUsers: number;
  completedOrders: number;
  /** Active ready-made products in the company catalog. */
  products: number;
  /** Active categories, i.e. the ways to create. */
  categories: number;
}

/** The homepage counts change slowly; one database round trip per minute is plenty. */
export const PUBLIC_STATS_TTL_MS = 60_000;

@Injectable()
export class StatsService {
  private cached: { value: PublicStats; expiresAt: number } | null = null;
  private pending: Promise<PublicStats> | null = null;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async publicStats(): Promise<PublicStats> {
    if (this.cached && this.cached.expiresAt > Date.now())
      return this.cached.value;
    // Concurrent requests after expiry share one query instead of each counting.
    this.pending ??= this.count().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async count(): Promise<PublicStats> {
    const [registeredUsers, completedOrders, products, categories] =
      await this.prisma.$transaction([
        this.prisma.user.count({ where: { role: 'CUSTOMER', isActive: true } }),
        this.prisma.order.count({ where: { status: 'COMPLETED' } }),
        this.prisma.product.count({
          where: { origin: 'COMPANY', isActive: true },
        }),
        this.prisma.category.count({ where: { isActive: true } }),
      ]);
    const value = { registeredUsers, completedOrders, products, categories };
    this.cached = { value, expiresAt: Date.now() + PUBLIC_STATS_TTL_MS };
    return value;
  }
}
