# Orders API

All routes use the `/api/v1` prefix and require `Authorization: Bearer <accessToken>`.

| Method | Route | Access |
| --- | --- | --- |
| POST | /orders | CUSTOMER and ADMIN |
| GET | /orders | Customers: own orders; admins: all orders |
| GET | /orders/:id | Customers: own orders; admins: any order |
| PATCH | /orders/:id | ADMIN |
| PATCH | /orders/:id/status | ADMIN |
| PATCH | /orders/:id/payment-status | ADMIN |
| DELETE | /orders/:id | ADMIN; returns 204 |

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
