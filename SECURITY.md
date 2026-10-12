# Security

Pipeline-Aware Forecast reads a merchant's open Salesforce Opportunities (read-only) and Shopify stock and sales (read-only), and stores only aggregates: per-SKU, per-week quantities and deal counts. It does not store Salesforce account names, contacts or deal amounts, and it does not store Shopify customer details.

What is protected, and how:

- The merchant's Salesforce client ID and secret and Shopify's access and refresh tokens are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`).
- Credentials are only ever sent to a Salesforce "My Domain" API host over HTTPS (strict host allow-list, no redirects, response-size cap).
- Every in-app route authenticates the Shopify session; webhooks verify Shopify's HMAC; the scheduled-sync endpoint requires a long secret.
- All stored data is deleted when Shopify sends `shop/redact`; credentials and the Shopify session are deleted on uninstall.

If you find a security issue, please **do not open a public issue**. Email
arsalanarshad.dev@gmail.com instead with details. We'll acknowledge within a few days.
