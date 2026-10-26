# Checkout suite

Environment: qc (default). No login: every scenario runs as a guest.

## Scenarios

1. Open the product page, add the product to the cart, set the quantity to 3, place the
   order, and verify that placing the order sends `POST /api/orders`.
2. On the cart page, apply the coupon `SAVE10` with the "Apply coupon" button and verify the
   discount line appears.
