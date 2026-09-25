# Glovo discovery session

Run `bun run discover`. A browser window opens on your logged-in profile and the
terminal logs every Glovo API call. Do these in the window, in order, slowly:

0. Before starting, open DevTools > Application > Cookies for `glovoapp.com` and
   note the `glovo_auth_info` cookie's **expiry** and **path**.
1. Open your profile menu and go to **Orders**. Scroll to load older orders.
2. Open one **past grocery order** so its line items load.
3. Go back home, open the **Groceries** category, and note which stores are listed.
4. Open **Agrohub**. Browse two categories (for example Meat and Fruit).
5. Use the in-store **search** for "milk" and for "რძე".
6. Open one **product detail**.
7. **Add** that product to the cart, then change its quantity to 2.
8. Open the **cart** and press **Checkout**. Stop on the checkout page. Do not pay.
9. Remove the item from the cart so nothing is left behind.
10. Return to the terminal and press Enter. The window closes.
11. Wait 25 minutes, longer than the 20-minute access token. Then run `bun run discover`
    again (it always opens a visible window, never headless) and check whether the
    `[001]` line in the terminal shows a 200 for the first API call. That tells us
    whether the cookie survives an idle session. Press Enter to finish that run.

The recorder writes redacted JSON per request into `data/discovery/<timestamp>/`
and a `SUMMARY.txt` listing each endpoint. Lines flagged `ID-KEYS` contain
barcode-like fields; that answers whether matching can be exact. Each recording
also carries the request headers with credentials, session, device and location
values replaced by `[REDACTED]`; response headers are never recorded.

## Before committing any fixture

The recorder redacts at record time, but you are the last check. After copying
the curated recordings into `tests/fixtures/glovo/`, grep them for anything
personal and read every hit:

```sh
grep -rniE 'eyJ|\+995|599|apt|<your street>|<your door code>|<your name>|<your card digits>' tests/fixtures/glovo/
```

- street names of your address, and "apt", entrance, floor or door codes
- your first or last name
- card digits (last four, expiry)
- `eyJ` (the start of a JWT)
- `+995` and `599` (Georgian phone numbers). `599` also appears in ids and
  prices, so look at each hit rather than counting them.

Replace or drop anything that identifies you before `git add`. Nothing under
`data/` is ever committed.
