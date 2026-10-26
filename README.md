# GWIC backend

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

## Core savings operations

Core Target (12% annual customer yield, 30–60 days) and Core Lock (15%, 90–365 days) are implemented as authenticated investment plans. Amounts are posted in integer kobo and plan creation, wallet debits, and ledger postings use MongoDB transactions. Starting a plan requires a verified user account, sufficient wallet balance, and a UUID v4 idempotency key. `isKycVerified` defaults to `false`; do not set it from a client request. The backend does not collect or store BVNs. Connect a compliant identity-verification provider before enabling customer onboarding.

Core Flex is intentionally unavailable and has no withdrawal endpoint because an instant-access reserve or committed liquidity facility has not been implemented. Early liquidation of locked plans requires password confirmation and returns principal minus the greater of the 3.5% principal penalty or accrued yield; all accrued yield is forfeited. Maturity returns principal and recorded yield to the wallet.

`CORE_SAVINGS_ENABLED` defaults to `false`. Keep it disabled until asset placement/custody, reconciliation, operational funding, legal disclosures, KYC verification, and production controls are ready. The current backend records the yield and spread accruals in its ledger; it does not itself purchase or settle T-Bills, commercial paper, or fund units. Do not enable plans based only on this internal ledger. Before enabling plans, run `npm run wallet:reconcile-opening-balances` once to bring existing wallet balances into the double-entry ledger; review the resulting opening-balance entries with Finance.

The API starts a UTC-midnight scheduler after connecting to MongoDB; it also runs a catch-up sweep at startup and retries failures every five minutes. The sweep is idempotent and catches up missed UTC days. `npm run core-savings:daily` is also available for a dedicated scheduled job or manual operations; do not configure both unless you intend to run a redundant, idempotent sweep. MongoDB must run as a replica set because wallet and investment changes require transactions. Monitor scheduler logs and reconcile ledger balances before enabling customer plans. The endpoint is `GET /api/core-savings`; create plans with `POST /api/core-savings/plans`, and early-liquidate with `POST /api/core-savings/plans/:planId/liquidate`.
