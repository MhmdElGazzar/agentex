# Checkout regression

env: qc

1. **checkout-happy-path** — login as standard_user, add one item, complete checkout with the
   disposable card data; expect the confirmation page.
2. **checkout-empty-cart** — open checkout with an empty cart; expect the empty-cart notice
   and a disabled pay button.
3. **checkout-expired-session** — let the session expire on the payment step; expect a
   redirect to login with the cart preserved.
