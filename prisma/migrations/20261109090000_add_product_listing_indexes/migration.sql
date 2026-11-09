-- GET /products?page=…: the catalog (COMPANY, active) newest first or by price.
CREATE INDEX "products_origin_is_active_created_at_idx" ON "products"("origin", "is_active", "created_at");

CREATE INDEX "products_origin_is_active_price_idx" ON "products"("origin", "is_active", "price");
