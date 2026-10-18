# Category builders and dynamic options

Categories support optional `builderType` values `JEWELRY`, `BOUQUET`, `GIFT`,
and `APPAREL`. They also support an optional `options` JSON array. Both fields
are returned by category endpoints and accepted by admin category create/update
requests. For multipart requests, send `options` as `JSON.stringify(options)`.

`JEWELRY` continues to use the existing `sizes`, `selectedSize`, component,
pricing, inventory, and maximum-item behavior. Those fields were not replaced.

Each option definition requires `key`, `name`, `type`, and `required`. Supported
types are:

- `select`: requires a unique string `values` array.
- `color`: requires a `values` array of unique `{ name, value }` objects; an
  empty array permits any nonempty color string.
- `number`: optionally accepts finite `min` and `max` values.
- `text`: optionally accepts an integer `maxLength` from 1 through 10000.

## Product selections

Product create/update accepts optional `selectedOptions`. With multipart, send
it as `JSON.stringify(selectedOptions)`. The server loads the selected category,
rejects unknown keys, enforces required options and constraints, and stores only
validated values. Frontends cannot submit option definitions or override limits.

For a configured color, the frontend may send the configured color value:

```json
{
  "selectedOptions": {
    "size": "L",
    "color": "#000000"
  }
}
```

The server stores the authoritative configured color object:

```json
{
  "size": "L",
  "color": { "name": "Black", "value": "#000000" }
}
```

Explicit non-jewelry builders may create a custom product without component
items. Existing `JEWELRY` and legacy categories still require components.
No option selection changes price or stock: existing component calculations and
order-time stock deduction remain authoritative. Orders snapshot
`selectedOptions` along with the existing product design snapshot.

## Apparel base price and inventory

Categories accept nullable `basePrice` and `stock` integer fields. Both must be
nonnegative; `basePrice` is expressed in cents. Multipart category requests send
these as ordinary numeric fields (for example, `basePrice=3500` and `stock=40`).

Only `APPAREL` uses these fields in current business logic. A custom apparel
product price is calculated as the database category's `basePrice` plus its
ProductItem component prices. Client-provided custom-product prices remain
rejected. Jewelry, bouquet, gift, and legacy category pricing is unchanged.

Saving or editing a product never changes category inventory. When an apparel
order is placed, the order transaction verifies at least one category stock unit,
creates the order, decrements category stock by one, and applies the existing
component stock decrements. Any failure rolls back the order and every stock
change. A null or zero apparel stock value cannot be ordered.
