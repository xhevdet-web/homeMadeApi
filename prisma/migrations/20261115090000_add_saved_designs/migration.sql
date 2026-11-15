-- "My designs": designs a customer explicitly saved. Starts empty: existing designs and
-- orders are left as they are, and none is marked as saved.
-- CreateTable
CREATE TABLE "saved_designs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "saved_designs_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "saved_designs_user_id_updated_at_idx" ON "saved_designs"("user_id", "updated_at");
-- CreateIndex
CREATE INDEX "saved_designs_product_id_idx" ON "saved_designs"("product_id");
-- AddForeignKey
ALTER TABLE "saved_designs" ADD CONSTRAINT "saved_designs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "saved_designs" ADD CONSTRAINT "saved_designs_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;