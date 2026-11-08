# Kalma Capital backend

## Paystack wallet setup

Configure `PAYSTACK_SECRET_KEY` as a secret in the backend environment. Use a Paystack test secret for sandbox testing; use a live secret only when ready to process real money. Never add either key to source control or frontend environment variables.

Set `FRONTEND_URL` to the deployed frontend origin so Paystack can return users to the dashboard after checkout.

Configure this webhook URL in the Paystack dashboard:

```text
https://gwic-backend.onrender.com/api/paystack/webhook
```

The endpoint verifies Paystack's HMAC signature and handles `charge.success`, `transfer.success`, `transfer.failed`, and `transfer.reversed` events. Keep it publicly reachable over HTTPS.

Deposits are limited to ₦100–₦1,000,000 per transaction. Wallet funds are credited only after the backend verifies a successful Paystack transaction. Withdrawals require at least ₦100, sufficient confirmed wallet funds, and a resolved Nigerian bank account whose holder name matches the user's profile name (case, spaces, and punctuation ignored). Withdrawals are sent from the business Paystack balance; failed or reversed transfers are returned to the wallet.

Paystack can require approval for transfers depending on the account's transfer security settings. In that case, the withdrawal remains reserved and pending until Paystack reports a final transfer event.

The authenticated `GET /api/wallet/transactions?page=1&type=all` endpoint returns wallet activity newest-first in pages of 20. `type` accepts `all`, `deposit`, or `withdrawal`; the response includes `total` and `hasMore` for pagination.

The authenticated `GET /api/portfolio` endpoint summarizes a user's current wallet balance, active Core savings plans, and balances saved toward user-created savings goals. Savings-goal balances are included in the portfolio total and reported separately from the available wallet balance. The endpoint reports current account allocation and accrued yield only; historical performance and securities holdings are not represented because those products and market-data feeds are not integrated.

## Core savings operations

Core Target (12% annual customer yield, 30–60 days) and Core Lock (15%, 90–365 days) are implemented as authenticated investment plans. Amounts are posted in integer kobo and plan creation, wallet debits, and ledger postings use MongoDB transactions. Starting a plan requires a verified user account, sufficient wallet balance, and a UUID v4 idempotency key. `isKycVerified` defaults to `false`; do not set it from a client request. The backend does not collect or store BVNs. Connect a compliant identity-verification provider before enabling customer onboarding.

Core Flex is intentionally unavailable and has no withdrawal endpoint because an instant-access reserve or committed liquidity facility has not been implemented. Early liquidation of locked plans requires password confirmation and returns principal minus the greater of the 3.5% principal penalty or accrued yield; all accrued yield is forfeited. Maturity returns principal and recorded yield to the wallet.

`CORE_SAVINGS_ENABLED` defaults to `false`. Keep it disabled until asset placement/custody, reconciliation, operational funding, legal disclosures, KYC verification, and production controls are ready. The current backend records the yield and spread accruals in its ledger; it does not itself purchase or settle T-Bills, commercial paper, or fund units. Do not enable plans based only on this internal ledger. Before enabling plans, run `npm run wallet:reconcile-opening-balances` once to bring existing wallet balances into the double-entry ledger; review the resulting opening-balance entries with Finance.

The API starts a UTC-midnight scheduler after connecting to MongoDB; it also runs a catch-up sweep at startup and retries failures every five minutes. The sweep is idempotent and catches up missed UTC days. `npm run core-savings:daily` is also available for a dedicated scheduled job or manual operations; do not configure both unless you intend to run a redundant, idempotent sweep. MongoDB must run as a replica set because wallet and investment changes require transactions. Monitor scheduler logs and reconcile ledger balances before enabling customer plans. The endpoint is `GET /api/core-savings`; create plans with `POST /api/core-savings/plans`, and early-liquidate with `POST /api/core-savings/plans/:planId/liquidate`.

## Account settings and support

Signup requires at least a first and last name. Tell users to enter their full legal name as it appears on bank and identity records: bank withdrawals are rejected when the verified bank-account holder name does not match the Kalma Capital profile name. The name is immutable through the regular profile endpoint; users can submit a support request for a correction.

Optional profile photos are uploaded through the authenticated `/api/account/profile/photo` route and stored as authenticated Cloudinary images. Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` in the backend environment. Only PNG, JPEG, and WebP files under 2 MB are accepted. The API returns a signed image URL; photos are not identity evidence and must not be used for face verification. `DELETE /api/account/profile/photo` removes the current profile photo.

The authenticated `/api/account` routes power the More page:

- `GET/PATCH /profile` reads the account name and updates the phone. The legal account name is fixed after signup; correction requests must go through support. Email changes are not supported by this endpoint.
- `GET/PATCH /preferences` persists wallet-balance visibility and the available display preferences.
- `GET/PATCH /notifications` persists the user's choices. Email and push delivery are not integrated yet; saving a choice does not send a notification.
- `PATCH /password` verifies the current password, changes it, invalidates prior sessions, and clears the current session cookie.
- `GET/POST /verification` reads or submits a manual verification request. It collects legal name and date of birth, not BVN or identity-document numbers. A request is not proof of verification; a reviewer must validate it separately before account KYC status changes.
- `GET/POST /banks`, `PATCH /banks/:bankId/default`, and `DELETE /banks/:bankId` manage up to three verified payout recipients. Linking requires Paystack configuration, password confirmation, and a holder name matching the Kalma Capital profile. Plain account numbers are not stored; only masked details and a provider recipient reference are retained. A linked account can be selected for wallet withdrawals.
- `GET/POST /support` lists and creates support tickets. Admin staff can update their status through the admin API; email delivery is not integrated.
- `GET /about` returns the product information shown in More.

The legacy `/api/account-review` routes use `ACCOUNT_REVIEW_TOKEN` for trusted server-side tools. Never expose that token in browser code. The admin dashboard instead uses authenticated, role-protected routes under `/api/admin`.

## Admin dashboard

The admin app uses this backend's HttpOnly session cookie and requires an `admin` or `super_admin` role. Configure `ADMIN_EMAIL`, `ADMIN_NAME`, and `ADMIN_PASSWORD` only in the backend deployment environment. At startup, the backend creates the configured admin or synchronizes the matching account as a `super_admin`; changing `ADMIN_PASSWORD` also changes the account password on the next restart. Use a unique password of at least 12 characters and rotate any password shared in chat.

Set `ADMIN_URL` to the exact admin site origin (scheme and hostname only, with no trailing slash) in the backend deployment. The production admin origin `https://gwic-audit.vercel.app` is also allowed for CORS and admin write requests. The admin frontend deployment must separately set `VITE_API_URL` to this backend's public origin.

The authenticated staff API is under `/api/admin`:

- `GET /overview`, `/users`, `/users/:userId`, and `/transactions` provide real platform data. The user-detail endpoint is read-only and returns profile fields, wallet balance, recent transactions, verification status history, support ticket summaries, investment plans, and savings goals. It excludes credentials, session data, bank details, verification birth dates, and private staff notes.
- `GET /operations/wallets` provides read-only wallet totals and recent balances.
- `GET /operations/verification-requests?status=pending` lists submitted requests. `PATCH /operations/verification-requests/:requestId` requires a decision, an evidence-review confirmation, and a reviewer note. Identity documents are not collected by this app; review evidence only through an approved secure process.
- `GET /operations/support-requests?status=all` lists real support tickets. `PATCH /operations/support-requests/:requestId` changes status with a required staff note.
- `GET /operations/audit-logs` lists recorded KYC and support actions. Mutations and audit entries are saved in one MongoDB transaction.

Admin write routes require a valid admin session, admin role, and an approved request origin. Wallets remain read-only.
