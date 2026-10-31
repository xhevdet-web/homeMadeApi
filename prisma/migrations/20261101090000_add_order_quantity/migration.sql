-- AlterTable
-- Every existing order was for one product.
ALTER TABLE "orders" ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1;
