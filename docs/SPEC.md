# Pipeline-Aware Forecast — Spec

_Status: planned. Verify every platform claim against current docs before building._

## 1. Scope (v1)
- Read open Opportunities and their line items from one Salesforce org per shop.
- Compute weighted weekly demand per SKU, merge with retail demand, show three scenarios.
- Surface unmatched SKUs. Extend the AI snapshot with aggregated pipeline numbers.
- **Read-only** on both platforms.

**Non-goals (v1):** writing to Salesforce; showing stock on Opportunity records (v2); quotes/orders objects; multi-org per shop; forecasting *which* deals will close.

## 2. Salesforce data contract
Objects read: `Opportunity`, `OpportunityLineItem`, `Product2`.

```sql
SELECT Id, StageName, Probability, CloseDate,
       (SELECT ProductCode, Quantity FROM OpportunityLineItems)
FROM Opportunity
WHERE IsClosed = false AND CloseDate <= :horizonDate
```
- Paginate with `nextRecordsUrl`; one pull per refresh to stay far inside daily API limits.
- Ship date = `CloseDate` + merchant-configurable offset (default 7 days). An optional custom date field can be mapped later; none is *required* (no package in v1).
- Probability = `Probability` unless a per-stage override exists; effective = probability × haircut (default 1.0).

## 3. SKU matching
1. Exact match: `ProductCode` equals a Shopify variant SKU (case/whitespace-normalised).
2. Otherwise → **Unmatched** (reported, excluded from math). No fuzzy matching in v1.
3. Many Salesforce products may map to one SKU (summed); one product mapping to several SKUs is out of scope.
4. Unit of measure: v1 assumes quantities are in the same unit as Shopify. UoM mapping is a good-first-issue.

## 4. Pure functions (no network, no AI)
- `pipelineDemandByWeek(opportunities, stageOverrides, haircut, shipOffsetDays) → Map<sku, Week[]>`
- `simulateBurnDown({ stock, retailDailyDemand, shipments, leadTimeDays, horizonDays }) → { stockoutDay, orderByDay }`
- `scenarioSet(...) → { retailOnly, weighted, allClose }`
Every function is covered by tests with fixed inputs and expected outputs, including the worked example in the README.

_Implementation note (2026-10-12): the built functions take a single options object (they also need `today`, `horizonDays` and a SKU index) and add `pipelineShipments` (day-precision) and `weeksToShipments`. Exact shapes are in `docs/M1_CONTRACT.md`; the signatures above show intent._

## 5. Storage (Prisma)
| Model | Purpose |
|---|---|
| `SalesforceConnection` | shop, instance URL, auth mode, **encrypted** credentials, last sync, last error |
| `PipelineSnapshot` | shop, sku, weekStart, weightedQty, rawQty, openDealCount, syncedAt |
| `UnmatchedProduct` | shop, productCode, openDealCount, rawQty, syncedAt — feeds the data-quality panel; never used in any number _(added 2026-10-12)_ |
| `StageProbabilityOverride` | shop, stageName, probability |
| `PipelineSetting` | shop, haircut, shipOffsetDays, horizonDays |

No account, contact or amount columns exist.

## 6. Salesforce authentication
- New integrations use an **External Client App** (Connected App creation is disabled in all orgs since Spring '26 — re-verify at build time).
- Supported server-to-server flows to evaluate: **JWT bearer** or **client credentials**. Username-Password flow is being retired — do not use it.
- **v1 (recommended): bring-your-own External Client App** — the merchant/admin creates it in their org, following a step-by-step guide, and pastes the credentials. No central client, no AppExchange review.
- **v2 option:** ship the External Client App inside a packaged 2GP unlocked package (the same release process as `smart-record-cloner`) for a one-click install link.
- Decide *Local vs Packaged* at creation — it cannot be changed later.

## 7. Sync
Scheduled pull (default every 6 h) plus a manual **Refresh** button. Failures keep the last good snapshot, show the error and its age in the UI, and never block retail-only forecasting.

## 8. AI layer
The snapshot gains a `pipeline` object of aggregates (per SKU: weighted units next 30 days, scenario stockout dates, open-deal count). The system prompt keeps the existing rule: answer only from the snapshot, say so when data does not cover the question. Rebuilt server-side every request. No account names or amounts are ever included.

## 9. Review & disclosure
- Shopify: the app is a **separate listing**. It requests read-only scopes (`read_orders`, `read_products`, `read_inventory`, `read_locations`) itself, so it needs its own App Store review. **Verified 2026-10-12 against a real dev store and https://shopify.dev/docs/apps/launch/protected-customer-data:** the Order object is *protected customer data*; reading it fails with `ACCESS_DENIED` ("not approved to access the Order object") until access is requested. Because this app selects no customer name/address/phone/email, **Level 1** is what applies; for a public app Shopify reviews and approves it (minimum-data rule), and for development stores no approval is needed once the access request steps are completed in the dashboard. It also connects to a third-party system: disclose in the listing and privacy policy. Opportunity data is business data and is not protected customer data.
- Run the `shopify-app-store-review` self-review before the first submission.
- No AppExchange review in v1.

## 10. Acceptance criteria
- Worked example from the README reproduces exactly in a unit test.
- With the Salesforce connection removed, the app behaves exactly as today.
- An unmatched product appears in the data-quality panel and does not affect any number.
- A failed sync leaves the previous snapshot in place and shows a clear error.
- No account name, contact, or amount exists in the database or in any AI prompt.
- Credentials are encrypted at rest and deleted on uninstall and `shop/redact`.

## 11. Risks
| Risk | Mitigation |
|---|---|
| No production merchant yet | Validated on a dev store with seeded data only; real-world accuracy of the inputs is untested |
| Dirty CRM data (missing line items, wrong SKUs) | Unmatched panel; never guess |
| Merchants distrust CRM probabilities | Three scenarios + haircut; show the arithmetic |
| Credential handling | BYO app, least privilege, encryption, redaction |
