# Spec: checkout regression

Target: https://qa.demo.example

## Scenarios
1. Login as valid_user; expect the dashboard.
2. Add any product to the cart and start checkout; expect the payment step.
3. db: shop-db.order-by-number(orderNumber=ORD-1001) → expect 1 row
   (catalog entry defined in integrations/shop_db.json)

## Notes
- Set QA_TARGET_URL in .env before running.
- Screenshot every scenario.
