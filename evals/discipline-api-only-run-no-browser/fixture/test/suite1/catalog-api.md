# Spec: Catalog API smoke

Drivers: api
Type: API regression — read-only

## Acceptance criteria
- Known products and their stock are served by the catalog API.

## Scenarios
1. api: shop-api.product-by-sku(sku=PRD-1) → expect HTTP 200 and name present
2. api: shop-api.stock-by-sku(sku=PRD-1) → expect HTTP 200 and quantity present

## Notes
- No UI is involved in this spec.
