# Bug list — execu_20261010_0900 (story 321)

## BUG-1 — Download Receipt crashes the app to a blank page (Expired tab)
- **Steps:** Dashboard → Expired Policies tab → any card → Policy actions (⋮) → Download Receipt.
- **Expected:** the receipt PDF downloads.
- **Actual:** the whole app crashes to a blank white page; console:
  `TypeError: Cannot read properties of undefined (reading 'at')` in `generate-receipt-pdf.js`.
- **Evidence:** `screenshots/receipt-after-click.png`
