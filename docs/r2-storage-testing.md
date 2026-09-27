# R2 images for Categories, SubCategories and Products

All existing POST/PATCH endpoints accept JSON or multipart/form-data with an
optional `file`. Supported images: JPEG, PNG, WebP; maximum 5 MiB (5,242,880 bytes).
Validation checks MIME and content signatures, not just extensions. It does not
perform image decoding, resizing or background removal.

| Entity      | Create                      | Update / replace image           | Delete                            | R2 prefix      |
| ----------- | --------------------------- | -------------------------------- | --------------------------------- | -------------- |
| Category    | POST /api/v1/categories     | PATCH /api/v1/categories/:id     | DELETE /api/v1/categories/:id     | categories/    |
| SubCategory | POST /api/v1/sub-categories | PATCH /api/v1/sub-categories/:id | DELETE /api/v1/sub-categories/:id | subcategories/ |
| Product     | POST /api/v1/products       | PATCH /api/v1/products/:id       | DELETE /api/v1/products/:id       | products/      |

Category/SubCategory mutations require ADMIN JWT authentication. Product creation
allows ADMIN and CUSTOMER; editing/deleting remains ADMIN-only. Public GET behavior
is unchanged. Temporary POST/DELETE `/api/v1/storage/test-upload` routes are removed.

## Database and image responses

Migration `20260927220000_add_r2_image_keys` added the R2 keys.
Migration `20260927233000_remove_legacy_image_urls` removes the unused image_url
columns from categories, sub_categories and products. All three columns were
verified to contain only null values locally. Both migrations are applied locally.
Only imageKey is stored; imageUrl remains a derived API response field.
Order finalImageUrl is unchanged.

Keep R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET_NAME in the
server environment only. This CRUD integration adds no dependencies.

With R2_PUBLIC_URL empty, uploads work but responses contain `imageUrl: null`:

```json
{
  "id": "...",
  "name": "Black Panther",
  "imageKey": "subcategories/550e8400-e29b-41d4-a716-446655440000.png",
  "imageUrl": null
}
```

An object key is not a publicly viewable URL. Configure a public R2/custom-domain
base URL later to enable image display; do not use the S3 API endpoint. For example,
R2_PUBLIC_URL=https://images.example.com derives imageUrl as
https://images.example.com/subcategories/550e8400-e29b-41d4-a716-446655440000.png.
URLs are derived at response time, including nested Product/Order image relations.
Presigned/private delivery is not implemented.

Clients cannot supply imageKey or imageUrl. Upload using file instead.
Without a file, the key remains unchanged. No binaries/base64 are stored in PostgreSQL.

## Swagger examples

1. Restart the existing backend with `pnpm.cmd run start:dev`. Keep one instance on
   port 3000. Swagger is available with NODE_ENV development, test or unset.
2. Obtain an ADMIN accessToken using POST /api/v1/auth/login with
   `{ "identifier": "your-admin-email", "password": "your-password" }`.
3. Open http://localhost:3000/api/docs, click Authorize, and paste the token without
   the Bearer prefix. Choose Try it out and multipart/form-data.
4. Use the following fields and pick an image in `file`. Leave unused optional
   fields unsent rather than sending empty numeric/boolean values.

Category POST:

```text
name: Bracelets
description: Bracelet category
isActive: true
sortOrder: 1
file: [choose bracelet.png]
```

SubCategory POST:

```text
categoryId: <category UUID>
name: Black Panther
description: Black glass bead
color: Black
type: Bead
price: 200
stock: 30
isActive: true
sortOrder: 1
file: [choose bead.png]
```

Product POST:

```text
categoryId: <category UUID>
name: Custom Bracelet
description: My design
isActive: true
items: [{"subCategoryId":"<component UUID>","quantity":8,"position":1}]
file: [choose bracelet.webp]
```

Multipart `items` is JSON text; quantities inside it must be JSON numbers. In JSON
requests, items remains an array. Multipart price/stock/sortOrder convert integer
strings; isActive accepts only true/false. Invalid strings fail DTO validation.
JSON validation remains strict. Clear optional text fields with null using JSON.

Product price, itemCount, unitPrice and createdById remain server-controlled.
Prices are cents: eight beads at 200 cents yield 1600 cents.

To replace an image, PATCH the entity ID with just `file`. Image-only Product PATCH
preserves ProductItems, IDs, quantities, unit-price snapshots, total price and
itemCount. Explicit component edits retain existing pricing and ordered-design
restrictions. Image operations never decrement stock. Orders continue deducting
inventory once when placed. Order final-image uploads are not included.

Find the returned imageKey in Cloudflare R2's Objects list. GET list/detail responses
expose image information, including nested category/component relations.

## Customer design preview

Migration `20260928100000_add_product_design_preview_key` adds nullable
`products.design_preview_key` (TEXT), preserving existing Product rows. ProductItems
remain the authoritative design: component IDs, quantities, positions and price
snapshots are unchanged. Saving a Product with a preview does not reserve/decrement
stock. Orders continue using ProductItems for inventory; order/payment status changes
do not generate screenshots or alter this preview.

`POST /api/v1/products` and `PATCH /api/v1/products/:id` accept an additional optional
multipart image field named `designPreview` (JPEG, PNG or WebP, 5 MiB maximum). The
existing normal Product image field remains `file`; both may be sent together. For
multipart Product creation, keep `items` as JSON text:

```text
name: My Bracelet
categoryId: <category UUID>
description: My custom design
items: [{"subCategoryId":"<component UUID>","quantity":8,"position":1}]
file: [optional normal product image]
designPreview: [optional generated bracelet PNG]
```

The preview is uploaded under `designs/<uuid>.<ext>`. PostgreSQL stores only
`designPreviewKey`; Product responses include `designPreviewKey` and a derived
`designPreviewUrl` using `R2_PUBLIC_URL`. With no preview, `designPreviewUrl` is
null. Order responses expose an independent saved snapshot of these fields, so the admin
can see the design as ordered. See docs/orders-api.md for immutable order history. Frontends never send `designPreviewKey` or
`designPreviewUrl` as body fields.

On update, omitting `designPreview` keeps the old preview; supplying a new one
uploads it first, updates Product, then removes the old object. A DB failure cleans
up every newly uploaded Product/preview image and keeps existing images. If the
second upload fails, the first upload is cleaned before any DB write. Product
deletion removes both objects only after the DB deletion succeeds. Persistent
post-commit cleanup failures are reported as described below.

## Replacement and cleanup

- Create: upload, save key in DB; on DB failure delete the new upload.
- Replace: upload new object, update DB, then delete old object. On DB failure,
  clean up only the new object and retain the old image. Category/component writes
  compare the prior imageKey to prevent conflicting replacements. Product writes
  use the existing row lock.
- Delete: delete the DB record first, respecting all foreign-key restrictions,
  then delete its image. Category cascade deletion also cleans component images.
- Cleanup retries once. Persistent cleanup failure after a successful DB mutation
  returns HTTP 503 with `databaseCommitted: true`. Refresh; do not repeat the mutation.
  Server logs identify object keys requiring operator cleanup, without credentials
  or SDK errors. The new referenced image is never deleted as compensation for an
  old-image cleanup failure.
- If the DB write and compensating cleanup both fail, return the original DB error
  and log the cleanup keys. PostgreSQL/R2 do not share a transaction: crashes and
  persistent storage outages can leave orphans requiring manual cleanup. There is
  no background cleanup worker yet.

## Commands

Local migration, generation and verification are already performed. On another
deployment, run from the backend directory:

```powershell
pnpm.cmd exec prisma migrate deploy
pnpm.cmd exec prisma generate
pnpm.cmd run build
pnpm.cmd run start:prod
```

Verification:

```powershell
pnpm.cmd exec prisma format
pnpm.cmd exec prisma validate
pnpm.cmd test
pnpm.cmd run test:e2e
pnpm.cmd run lint
$env:RUN_INVENTORY_DB_TESTS='1'
pnpm.cmd run test:e2e
Remove-Item Env:RUN_INVENTORY_DB_TESTS
```

Ordinary tests mock R2 and require no Cloudflare credentials. PostgreSQL integration
tests use disposable isolated schemas. The existing live R2 service test stays opt-in.

## Files changed in this integration

Created:

- prisma/migrations/20260927220000_add_r2_image_keys/migration.sql
- prisma/migrations/20260928100000_add_product_design_preview_key/migration.sql
- prisma/migrations/20260928110000_add_order_design_snapshot/migration.sql
- src/storage/image-upload.decorator.ts
- src/storage/image-response.interceptor.ts
- src/storage/image-response.interceptor.spec.ts
- src/storage/image-write.service.ts
- src/storage/image-write.service.spec.ts
- test/storage/entity-images.e2e-spec.ts

Modified:

- prisma/schema.prisma
- src/storage/storage.service.ts
- src/storage/storage.module.ts
- src/storage/storage.service.spec.ts
- src/config/setup-swagger.ts
- src/modules/categories/categories.controller.ts
- src/modules/categories/categories.service.ts
- src/modules/categories/categories.module.ts
- src/modules/sub-categories/sub-categories.controller.ts
- src/modules/sub-categories/sub-categories.service.ts
- src/modules/sub-categories/sub-categories.module.ts
- src/modules/products/products.controller.ts
- src/modules/products/products.service.ts
- src/modules/products/products.module.ts
- src/modules/products/product-items.select.ts
- src/modules/orders/orders.service.ts (image response selects only)
- test/categories/categories.e2e-spec.ts
- test/orders/orders.e2e-spec.ts
- test/orders/inventory.e2e-spec.ts
- docs/r2-storage-testing.md

Removed temporary test code:

- src/storage/storage.controller.ts
- src/storage/storage-test.guard.ts
- src/storage/dto/delete-storage-object.dto.ts
- test/storage/storage.e2e-spec.ts

Prisma generated files were regenerated and remain Git-ignored. Pre-existing changes
in other files were preserved. No frontend files were modified.
