# R2 images for Categories, SubCategories and Products

All existing POST/PATCH endpoints accept JSON or multipart/form-data with an
optional `file`. Supported images: JPEG, PNG, WebP; maximum 5 MiB (5,242,880 bytes).
Validation checks MIME and content signatures, not just extensions. Category and designPreview uploads remain unchanged. Product and SubCategory
images are decoded and automatically processed by the backend before R2 upload.

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
server environment only. Background processing uses Sharp and ONNX Runtime on the server.

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


## Automatic foreground processing

Only `products/` and `subcategories/` upload folders use background removal, for both POST and PATCH. The backend validates the original size/MIME/signature, decodes a static image, auto-orients it, and uses the local BiRefNet General Lite neural model to produce a foreground alpha mask. Original foreground RGB values are retained; the implementation does not remove pixels by their whiteness. Masks retain antialiased edge transparency. Only fully transparent outer margins are cropped, with a two-pixel guard; output is lossless full-colour PNG. Existing transparent PNG/WebP uploads bypass segmentation and are stored byte for byte, preserving alpha, holes, and soft edges.

`categories/` and `designs/` (customer designPreview) bypass processing entirely. Order image copies also remain unchanged. Originals are never uploaded as an intermediate object. The existing imageKey/imageUrl response and server-only R2 configuration remain unchanged.

Processing occurs inside the existing safe-write flow before R2 upload and DB mutation. A processing failure leaves DB and old objects untouched. Database failure deletes the newly uploaded processed image; successful replacement deletes the old key after the DB write. Postcommit cleanup errors retain the existing `databaseCommitted` behavior.

### Model setup and deployment

Install the locked dependencies with pnpm, then run:

```sh
pnpm images:prepare-model
pnpm build
```

The preparation script downloads the fixed rembg BiRefNet General Lite ONNX model (~224 MB), verifies the upstream checksum, and atomically installs it in `.models/birefnet-general-lite.onnx`. The directory is gitignored. Run preparation in deployment or include the prepared file in your server/container artifact. Start the server from the project root, or set `BACKGROUND_REMOVAL_MODEL_PATH` to an absolute model file path (also respected by the preparation script). No model download or external image-processing API call occurs during an upload. The model session is initialized lazily and reused; a missing model produces 503 without uploading the original.

CPU inference requires native ONNX Runtime and Sharp binaries for the deployment platform, plus memory for the model and decoded images. Processing is serialized with a maximum of four pending images per service instance; excess requests return 503 for retry. Inputs retain the 5 MiB limit and additionally must be static, decodable images of at most 16 megapixels. Processed PNGs must also fit 5 MiB; oversized results return 400 instead of being silently downscaled. There is no API/schema migration or client-side processing change.

The saliency model estimates foreground; results on fine wires, glass, reflective beads or difficult backgrounds can vary. It preserves existing alpha rather than attempting to infer it again. Validate representative catalog photos before broad rollout.

Model: [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) (MIT), using the General Lite variant. Model preprocessing and download/checksum reference: [rembg BiRefNet General Lite](https://github.com/danielgatis/rembg/blob/main/rembg/sessions/birefnet_general_lite.py), [mask inference](https://github.com/danielgatis/rembg/blob/main/rembg/sessions/birefnet_general.py). Runtime: [ONNX Runtime Node](https://onnxruntime.ai/docs/get-started/with-javascript/node.html); image encoding: [Sharp PNG](https://sharp.pixelplumbing.com/api-output/#png).

The model uses 1024 x 1024 inference with sigmoid decoding of its logits. The input is stretched into a square, and the alpha mask is explicitly stretched back to the original photo dimensions. Using Sharp's default cover resize for this step would crop the mask and misalign it with portrait/landscape photos. This is covered by geometry tests. CPU inference is more expensive than the previous 320-pixel U2-Net model; the cached model and bounded processing queue are retained. Run `pnpm images:prepare-model` again when updating a deployment from U2-Net. The existing custom model path must point to the prepared BiRefNet model, not the old U2-Net file.

Existing R2 objects are not rewritten automatically. Replace an unsatisfactory catalog image by uploading its **original opaque photo** again. Uploading an already processed transparent PNG intentionally preserves its current alpha and bypasses segmentation. Order-owned historical image copies remain unchanged.

### Background processing verification

```sh
pnpm test
pnpm test:e2e
# Opt-in real CPU inference (model must be provisioned):
RUN_BACKGROUND_MODEL_TESTS=1 pnpm test:e2e
```

On PowerShell, set `$env:RUN_BACKGROUND_MODEL_TESTS='1'` before running tests. Unit tests verify opaque JPEG/PNG/WebP conversion, preservation of white foreground/soft edges, transparent PNG/WebP byte preservation, and failure handling. HTTP tests use actual Sharp decoding/encoding with deterministic segmentation and intercepted S3 commands, checking both entity create/update paths, processed-only uploads, URLs, category/preview passthrough, and replacement cleanup. The opt-in inference tests exercise the real model on a generated white-pearl sample in JPEG, PNG and WebP, plus the real bracelet regression photo in JPEG and PNG. The bracelet checks verify transparent center/tabletop pixels and preserved black/red/amber beads and the silver clasp. Tests save inspection artifacts under `.temp/background-verification/`. They do not contact R2. Live R2 tests remain separately opt-in with `RUN_R2_LIVE_TESTS=1`.
