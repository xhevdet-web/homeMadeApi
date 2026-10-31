-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "completed_at" TIMESTAMP(3);
-- Orders completed before this column existed: COMPLETED is the final status and no
-- later change is recorded more precisely, so their last update is the best estimate.
UPDATE "orders" SET "completed_at" = "updated_at" WHERE "status" = 'COMPLETED';
-- CreateIndex
CREATE INDEX "orders_status_completed_at_idx" ON "orders"("status", "completed_at");
