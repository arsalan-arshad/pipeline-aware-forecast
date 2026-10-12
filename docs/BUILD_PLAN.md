# Pipeline-Aware Forecast — Build Plan

Order matters: each milestone is useful on its own and can be stopped at.

## M0 — Validate (before any code)
- [ ] Validate with a real merchant. Status: validated on a dev store with seeded data only; no production merchants yet.
- [ ] Create an External Client App in the Developer Edition org; test JWT bearer and client credentials; record which works (D3).
- [ ] Write the seed data plan: ~10 sample Opportunities with line items across 3 SKUs.

## M1 — Pure engine (no network)
- [x] `pipelineDemandByWeek`, `simulateBurnDown`, `scenarioSet` with fixture tests. _(2026-10-12; contract in `docs/M1_CONTRACT.md`; `npm test` = 104 pass)_
- [x] The README worked example is a passing test (stockout day 40 / 25 / 20; order-by 26 / 11 / 6).
- [x] Edge cases: no open deals, zero retail demand, deal beyond horizon, probability 0 and 100, haircut 0.

## M2 — Salesforce read client
- [x] OAuth against the External Client App (client credentials), SOQL with pagination, error mapping (auth, permission, limits, network, server). _(`app/lib/pipeline/salesforce-client.server.js`, 2026-10-12)_
- [x] "Test connection" returns a clear human message for each failure class.
- [x] Integration test against the Developer org (`npm run test:integration`; skipped unless `SF_*` variables are set). It checks shape and a wrong-secret case rather than specific seed records, so it works on any org.
- [ ] Known gap: an Opportunity with more line items than fit in one nested page is truncated (nested pages are not followed yet).
- [ ] D3 still open: JWT bearer not tested; client credentials is the working default.

## M3 — Storage and sync
- [x] Prisma models (SPEC §5) in `prisma/schema.prisma` (validated; no account/contact/amount columns). _(2026-10-12)_
- [x] Encrypted credentials: AES-256-GCM helpers in `app/lib/pipeline/credentials-crypto.server.js`.
- [x] Sync logic: `runPipelineSync` + `isSyncDue` in `app/lib/pipeline/pipeline-sync.server.js` (store, client and clock are injected). A failed sync never touches the last good snapshot and records the error.
- [x] Prisma-backed store (`app/lib/pipeline-store.server.js`): atomic replace of a shop's snapshot rows in one transaction (chunked for large shops); a failure writes only the error fields. _(tested with a fake Prisma client; not yet run against Postgres)_
- [x] Local Shopify app shell (Remix + Polaris): auth routes, app layout, placeholder dashboard, compliance webhooks; `npm run build` succeeds. Nothing is registered with Shopify (`shopify.app.toml` holds placeholders).
- [x] Delete credentials on uninstall and everything on `shop/redact` (`app/lib/shop-data.server.js`, wired into the webhook routes; a test fails if a new shop-keyed model is not covered).
- [x] Shopify reads (`app/lib/shopify-data.server.js`): variant SKUs, stock per SKU, units/day over the last 28 days (max 60 without `read_all_orders`). Queries validated against the 2026-10 schema; page sizes kept under Shopify's 1,000-point query-cost limit but **not yet run against a live store**.
- [x] Initial Prisma migration generated (`prisma/migrations/20261012000000_init`, 6 tables; not yet applied to any database).
- [ ] Still to wire: the scheduled trigger (default every 6 h), the manual **Refresh** route, and showing the last-good snapshot's age beyond the placeholder dashboard.
- [x] Verified live on the dev store (2026-10-12): install + offline token exchange work; `fetchVariantSkus` and `fetchSkuStock` return the right data (PAF-001..003, stock 50 each); measured query cost 13 and 86 points (limit 1,000), so the page sizes could be raised later.
- [x] `fetchDailyDemand` verified live on the dev store after the owner saved step 1 of the protected-customer-data request in the Partner Dashboard (was `ACCESS_DENIED` before): 28-day sales read OK, cost 5 points. A **public** listing still needs Shopify's review of that request (submitted with the App Store listing).
- [ ] Large stores: reading many pages of orders is slow under Shopify's rate limit; a bulk operation is the proper fix (not built).

## M4 — UI
- [ ] Settings: connection wizard, stage probability table, haircut, ship-offset.
- [ ] SKU table: three scenarios and the unmatched-SKU panel.

## M5 — AI snapshot
- [ ] Add the aggregated `pipeline` block; confirm the prompt grounding rule still holds with a regression check (question about data that is not in the snapshot gets "not covered").

## M6 — Ship as its own Shopify app
- [ ] Own hosting (Railway service + Postgres), own Shopify app config, compliance webhooks, pricing plan and listing.
- [x] Own Shopify reads of stock and retail demand (see M3); wiring them into the sync is still to do.
- [ ] Update privacy policy and listing disclosure (third-party connection).
- [ ] Re-run the `shopify-app-store-review` self-review; setup guide for the External Client App with screenshots.
- [ ] Ask the owner before releasing.

## Later (v2)
Packaged External Client App (one-click install) · read-only LWC on the Opportunity showing stock cover · kit/bundle expansion · UoM mapping.
