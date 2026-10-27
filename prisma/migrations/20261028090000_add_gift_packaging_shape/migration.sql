-- CreateEnum
CREATE TYPE "GiftPackagingShape" AS ENUM ('SQUARE', 'RECTANGULAR');
-- AlterTable
ALTER TABLE "gift_packaging" ADD COLUMN     "shape" "GiftPackagingShape" NOT NULL DEFAULT 'SQUARE';
