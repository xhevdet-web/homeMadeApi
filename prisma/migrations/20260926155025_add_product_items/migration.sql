/*
  Warnings:

  - You are about to drop the column `sub_category_id` on the `products` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "products" DROP CONSTRAINT "products_sub_category_id_fkey";

-- DropIndex
DROP INDEX "products_sub_category_id_idx";

-- AlterTable
ALTER TABLE "products" DROP COLUMN "sub_category_id";

-- CreateTable
CREATE TABLE "product_items" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "sub_category_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "position" INTEGER,
    "unit_price" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_items_product_id_idx" ON "product_items"("product_id");

-- CreateIndex
CREATE INDEX "product_items_sub_category_id_idx" ON "product_items"("sub_category_id");

-- AddForeignKey
ALTER TABLE "product_items" ADD CONSTRAINT "product_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_items" ADD CONSTRAINT "product_items_sub_category_id_fkey" FOREIGN KEY ("sub_category_id") REFERENCES "sub_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
