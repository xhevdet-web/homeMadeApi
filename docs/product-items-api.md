# Product components and order inventory

## Schema and migration status

Product now has `items ProductItem[]` instead of `subCategoryId/subCategory`.
SubCategory has `productItems ProductItem[]` instead of `products Product[]`.
Product retains categoryId, itemCount, and price.

ProductItem stores id, productId, subCategoryId, quantity, optional position,
unitPrice, createdAt, and updatedAt. It indexes productId and subCategoryId.
Deleting an unordered product cascades to its items. Referenced components cannot
be deleted. Orders continue to reference Product.

The supplied schema and migration `20260926155025_add_product_items` already
contained this structure and were already applied when this implementation began.
The schema was formatted/validated and the Prisma client regenerated; applied
migration SQL was not rewritten and no extra destructive migration was run.

**Data-loss finding:** that migration drops products.sub_category_id before
creating product_items, with no backfill. The inspected local database contained
one product, one order, zero product items, and no legacy sub_category_id column.
The original component link was therefore unavailable. The user accepted leaving
these test records unrestored. Existing records were not deleted or fabricated.
Componentless designs cannot be ordered.

For another database where this migration has NOT run, back up/export the legacy
product-to-subcategory links and product quantities before applying it. A reviewed
backfill is necessary for populated databases. Do not blindly apply this migration
to valuable data: its SQL does not migrate existing links. Historical itemCount
can be zero and historical product prices need not equal component price times
quantity, so legacy quantities/unit prices require verification rather than guessed
defaults. If already applied, restore from a backup or verified original data.

## Product requests

All existing routes and authorization remain. Prefix: `/api/v1`.
Authenticated ADMIN and CUSTOMER can create. Only ADMIN can edit/delete.

`POST /products`:

```json
{
  "categoryId": "category-uuid",
  "name": "Gold and red bracelet",
  "description": "Custom design",
  "imageUrl": "https://example.com/design.png",
  "items": [
    { "subCategoryId": "gold-bead-uuid", "quantity": 10, "position": 0 },
    { "subCategoryId": "red-bead-uuid", "quantity": 15, "position": 1 }
  ]
}
```

Items must be a nonempty array (maximum 1,000 rows). quantity is a positive integer;
position is an optional nonnegative integer. Repeated SubCategory IDs are allowed,
for example for separate positions in a design.

The server verifies that every component exists, is active, and belongs to the
chosen category. It sets createdById from JWT, snapshots database SubCategory.price
as unitPrice, sums quantities into itemCount, and sums quantity × unitPrice into
price. Prices are integer cents. Integer overflow is rejected.

Client-supplied price, unitPrice, itemCount, createdById, the old top-level
subCategoryId, and server-generated IDs/timestamps are rejected.

`PATCH /products/:id` accepts the same editable fields, all optional.
Supplying items replaces the entire array atomically. For unordered designs,
omitting items retains the existing component quantities/positions and refreshes
their price snapshots when saved. Changing category validates all resulting items.
Saving a design never decrements/reserves stock, even if quantities exceed stock.

Because orders reference the saved product rather than a separate order-item
snapshot table, ordered designs' component lists, category, and prices are protected:
items/category changes return 409. Create a new product for a different design.
Metadata such as name, description, imageUrl, and isActive can still be edited.

## Product responses and filters

Product GET/create/update responses contain items with id, subCategoryId,
quantity, position, unitPrice, timestamps, and nested subCategory details:
id, categoryId, name, description, imageUrl, color, type, and current price.
Saved unitPrice may differ from the current subcategory price.

`GET /sub-categories/:subCategoryId/products` finds products containing any
matching item. Other product routes are unchanged.

## Order creation and stock

The order request remains `{ "productId": "...", "paymentType": "...", "customerNotes": "..." }`.
Customers can order only their own products; admins can order any product.
Profile delivery snapshots, payment defaults, and the six order statuses are unchanged.

One Prisma transaction:

1. Locks and loads the product and items, preventing simultaneous design edits.
2. Rejects empty/invalid component lists and calculates the total from saved quantities and unit prices.
3. Aggregates quantities for repeated subcategory IDs.
4. Checks each active component has enough stock and creates the order using saved component prices and the authenticated user's profile.
5. Conditionally decrements each component only if stock is still sufficient; any lost inventory race rolls back the order and every decrement.

Every decrement and order insertion commits together. Any failure rolls everything
back. Components are processed in a stable order to reduce deadlocks; unique-number
collisions and retryable transaction conflicts retry the entire transaction.

Insufficient inventory returns HTTP 400 (BadRequestException):

```json
{
  "statusCode": 400,
  "error": "Insufficient inventory",
  "message": "Insufficient inventory for Gold bead: requested 10, available 4",
  "subCategoryId": "gold-bead-uuid",
  "subCategoryName": "Gold bead",
  "requestedQuantity": 10,
  "availableQuantity": 4
}
```

Order details now expose `product.items[].subCategory`, with component quantities,
positions, saved unit prices, names, colors, types, descriptions, and images.
User passwordHash remains excluded and customer responses exclude adminNotes.
Component display fields reflect current catalog data; quantities and unit-price
snapshots belong to the saved product. No separate immutable catalog-detail snapshot
or S3 upload was introduced.

Deleting an order does not automatically restock components. Cancellation/refund
inventory behavior is not part of the existing six-status workflow.

## Validation

Prisma format/validate/generate, Nest build, full TypeScript checks, lint, and HTTP
regressions cover this change. PostgreSQL integration tests run all migration SQL
in a temporary randomly named schema and test price snapshots, rollback after a
late stock failure or failed order insertion, duplicate components, and concurrent
orders. They do not modify application records.

Run the PostgreSQL tests in PowerShell:

```powershell
$env:RUN_INVENTORY_DB_TESTS = '1'
.\node_modules\.bin\vitest.cmd run --config vitest.config.e2e.ts test/orders/inventory.e2e-spec.ts
```

They use DATABASE_URL and remove only their own temporary schema afterward.
