-- CreateEnum
CREATE TYPE "GiftPackagingType" AS ENUM ('TRANSPARENT', 'OPAQUE');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "gift_packaging_color_id" TEXT,
ADD COLUMN     "gift_packaging_id" TEXT,
ADD COLUMN     "packaging_price" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "gift_packaging" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "GiftPackagingType" NOT NULL,
    "image_key" TEXT,
    "price" INTEGER NOT NULL DEFAULT 0,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gift_packaging_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_packaging_colors" (
    "id" TEXT NOT NULL,
    "packaging_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hex" TEXT NOT NULL,
    "image_key" TEXT,
    "price_adjustment" INTEGER NOT NULL DEFAULT 0,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gift_packaging_colors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gift_packaging_name_key" ON "gift_packaging"("name");

-- CreateIndex
CREATE INDEX "gift_packaging_is_active_idx" ON "gift_packaging"("is_active");

-- CreateIndex
CREATE INDEX "gift_packaging_colors_packaging_id_idx" ON "gift_packaging_colors"("packaging_id");

-- CreateIndex
CREATE UNIQUE INDEX "gift_packaging_colors_packaging_id_name_key" ON "gift_packaging_colors"("packaging_id", "name");

-- CreateIndex
CREATE INDEX "products_gift_packaging_id_idx" ON "products"("gift_packaging_id");

-- CreateIndex
CREATE INDEX "products_gift_packaging_color_id_idx" ON "products"("gift_packaging_color_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_gift_packaging_id_fkey" FOREIGN KEY ("gift_packaging_id") REFERENCES "gift_packaging"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_gift_packaging_color_id_fkey" FOREIGN KEY ("gift_packaging_color_id") REFERENCES "gift_packaging_colors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_packaging_colors" ADD CONSTRAINT "gift_packaging_colors_packaging_id_fkey" FOREIGN KEY ("packaging_id") REFERENCES "gift_packaging"("id") ON DELETE CASCADE ON UPDATE CASCADE;

