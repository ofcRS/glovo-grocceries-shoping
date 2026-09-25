# Glovo discovery session

Run `bun run discover`. A browser window opens on your logged-in profile and the
terminal logs every Glovo API call. Do these in the window, in order, slowly:

1. Open your profile menu and go to **Orders**. Scroll to load older orders.
2. Open one **past grocery order** so its line items load.
3. Go back home, open the **Groceries** category, and note which stores are listed.
4. Open **Agrohub**. Browse two categories (for example Meat and Fruit).
5. Use the in-store **search** for "milk" and for "რძე".
6. Open one **product detail**.
7. **Add** that product to the cart, then change its quantity to 2.
8. Open the **cart** and press **Checkout**. Stop on the checkout page. Do not pay.
9. Remove the item from the cart so nothing is left behind.
10. Return to the terminal and press Enter.

The recorder writes redacted JSON per request into `data/discovery/<timestamp>/`
and a `SUMMARY.txt` listing each endpoint. Lines flagged `ID-KEYS` contain
barcode-like fields; that answers whether matching can be exact.
