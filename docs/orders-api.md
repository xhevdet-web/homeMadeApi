# Orders API

All routes use the `/api/v1` prefix and require `Authorization: Bearer <accessToken>`.

| Method | Route                      | Access                                    |
| ------ | -------------------------- | ----------------------------------------- |
| POST   | /orders                    | CUSTOMER and ADMIN                        |
| GET    | /orders                    | Customers: own orders; admins: all orders |
| GET    | /orders/:id                | Customers: own orders; admins: any order  |
| PATCH  | /orders/:id                | ADMIN                                     |
| PATCH  | /orders/:id/status         | ADMIN                                     |
| PATCH  | /orders/:id/payment-status | ADMIN                                     |
| DELETE | /orders/:id                | ADMIN; returns 204                        |

## Create

```json
{
  "productId": "product-uuid",
  "paymentType": "CASH_ON_DELIVERY",
  "customerNotes": "Please call before delivery"
}
```

`paymentType` accepts `CASH_ON_DELIVERY`, `CASH_ON_PICKUP`, or `CARD`.
`customerNotes` is optional. No card processing is performed by this API.

The authenticated account becomes the order's user, including when an admin creates the order. Customers can order only products they created; admins can order any existing product.

The account must have nonblank firstName, lastName, phone, country, and address. These values and optional postalCode are copied into the order. Update the user profile before ordering if required fields are missing. Later profile changes do not change the snapshot.

Mobile checkout saves delivery details with authenticated `PATCH /api/v1/users/me`
before calling `POST /api/v1/orders`. The profile endpoint accepts only firstName,
lastName, phone, country, address, and optional postalCode (null clears postalCode).
The backend identifies the account from JWT; do not send a user ID. The existing
`PATCH /users/:id` is an admin-only user-management endpoint and must not be used
by customer checkout.

The backend calculates totalPrice in cents from the saved ProductItem quantities and unitPrice snapshots, rather than trusting the cached Product.price. Stock is decremented and the order inserted in one transaction; any failure rolls everything back. Empty designs cannot be ordered. See [component API and inventory behavior](product-items-api.md). Status starts as ORDERED and paymentStatus as UNPAID. Client-supplied userId, prices, snapshots, statuses, timestamps, IDs, and order numbers are rejected.

Order numbers have the form `HM-2026-123456789`. The numeric suffix is random, not sequential. The unique constraint and collision retries prevent duplicates.

## List and details

`GET /orders?page=1&limit=50&status=ORDERED&paymentStatus=UNPAID&paymentType=CARD&userId=<customer-uuid>&orderNumber=HM-2026`

All filters are optional. orderNumber uses a case-insensitive substring match. page defaults to 1; limit defaults to 50 and is capped at 100. Results are ordered newest first.

```json
{
  "data": [],
  "meta": { "page": 1, "limit": 50, "total": 0, "totalPages": 0 }
}
```

Customers' results and counts are always restricted to their own orders. Filtering for another user returns 403; retrieving another user's order returns 404.

Responses include delivery snapshots, basic user information, and the product with category and items[].subCategory details, quantities, positions, and unitPrice snapshots. Password hashes are never selected. Internal adminNotes are selected only for admins. Related user/product display fields reflect their current values; delivery snapshots and totalPrice retain their creation-time values. Ordered product components and price snapshots cannot be edited through the Product API.

## Admin updates

- `PATCH /orders/:id`: accepts only optional `adminNotes` and `finalImageUrl`. Both accept a string or null to clear. finalImageUrl can contain a future storage key; this endpoint does not upload files.
- `PATCH /orders/:id/status`: accepts `{ "status": "CREATING" }`.
- `PATCH /orders/:id/payment-status`: accepts `{ "paymentStatus": "PAID" }`. Valid values are UNPAID, PAID, FAILED, and REFUNDED.
- `DELETE /orders/:id`: permanently deletes the order.

Status must advance exactly one step:

```text
ORDERED -> CREATING -> CREATED -> READY_FOR_COURIER -> PICKED_UP_BY_COURIER -> COMPLETED
```

Backward, skipped, and repeated transitions return 400. A concurrent status change returns 409; reload before retrying. COMPLETED is terminal.

All customer update/delete attempts are denied. Generic updates cannot change ownership, product, delivery snapshots, price, or statuses.

## Immutable design history

Migration `20260928110000_add_order_design_snapshot` adds nullable
`Order.designSnapshot` (JSONB) and `Order.designPreviewKey` (TEXT).

When placing a new order, the backend captures Product name/description, Category
metadata, and every ProductItem's component IDs, names, descriptions, colors,
types, positions, quantities, catalog price and unit-price snapshot. The saved
Product total is calculated from ordered quantities and unit-price snapshots.
Snapshots cannot be supplied or edited through order DTOs.

Each referenced design preview, normal Product image, Category image and component
image is copied to `orders/<order-id>/<uuid>.<ext>` using R2 CopyObject. Duplicate
references within one order share one copy. These objects belong to the order;
Product/catalog image replacement removes only the source, leaving order copies.
No screenshot is generated during status/payment updates.

For new orders, `order.product` in create/list/detail/update responses comes from
this snapshot, including `product.designPreviewUrl` and component `imageUrl`s.
The order also exposes its own `designPreviewKey`/`designPreviewUrl`. URLs are
derived from R2_PUBLIC_URL at response time; no public/presigned URLs are stored.
`designSnapshot.version` is 1. Frontends can keep their existing order.product path.
ProductItems remain the authoritative input at placement; order history then reads
the captured version.

R2 copies occur after stock preflight, inside the existing placement transaction
while the Product lock is held. Conditional inventory decrement and all existing
status/payment/authorization rules are preserved. The transaction timeout allows
up to 120 seconds for image copies. If a copy or transaction fails, placement rolls
back and completed copies are cleaned before retrying a retryable transaction.
R2 and PostgreSQL cannot share a transaction: persistent cleanup failures or a
process crash can leave orphan objects; cleanup failures log safe object keys for
operator recovery. Product source objects are never cleaned as order compensation.
Deleting an order removes its own images only after successful DB deletion; it
keeps existing inventory behavior and does not restore stock automatically.

Existing orders retain `designSnapshot: null` and the legacy current-Product view.
Their original design cannot be reconstructed reliably after earlier edits, so the
migration does not invent historical data. Immutable history applies to orders
placed after this change. No existing order/product rows are deleted.


## Ready-made purchases

Customers can order active `READY_MADE` products created by admins through the existing order creation endpoint. Each order buys one finished product. Placement atomically checks and deducts one unit of product stock, without deducting component stock. Out-of-stock, inactive, and non-admin-created ready-made products are rejected. The purchased admin price, product type, product details, components, and independent image copies are preserved in the immutable order snapshot. Later catalog edits do not change the purchased details or total price.

Custom-design ordering retains its ownership rules, component price snapshots, and component stock deductions.


## Purchased size

New orders copy the complete `Product.selectedSize` into `designSnapshot.product.selectedSize` at placement. Order detail, list and update responses expose that saved value as `product.selectedSize`. A recorded size can be displayed as `Medium ? 18 cm` using its name, measurement and unit.

Orders without a saved size return `product.selectedSize: null`; display **Size not recorded**. Never infer an older purchase's size from the live product or current category configuration. This addition does not change price or inventory handling and requires no migration.
