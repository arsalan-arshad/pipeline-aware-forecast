# M1 Contract — Pure Engine

_Written 2026-10-12 by the lead before any code. Implements BUILD_PLAN M1 / SPEC §3–§4. If this file and SPEC disagree, SPEC wins for intent and this file wins for exact shapes; record any deviation in this file._

**M1 done =** `npm test` passes, including (a) the README worked example (stockout day 40 / 25 / 20, order-by 26 / 11 / 6) and (b) the edge cases: no open deals, zero retail demand, deal beyond horizon, probability 0 and 100, haircut 0, unmatched SKU, overdue deal, stock already ≤ 0. No network, no AI, no `Date.now()`/`new Date()` without arguments in any engine file.

## Conventions
- **Day numbering:** day 0 = `today`. Integer days. All dates are `'YYYY-MM-DD'` strings, interpreted in UTC.
- **Probability scale:** Salesforce scale, `0–100`. Overrides use the same scale. `haircut` is `0–1` (default 1).
- **effectiveProbability** = `clamp((stageOverrides[stageName] ?? probability) / 100, 0, 1) * clamp(haircut, 0, 1)`.
- **Rounding:** quantities in outputs are rounded to 2 decimals with `round2(n) = Math.round(n * 100) / 100`. Internal math is unrounded.
- **Files (module layout, ESM, named exports only, no default exports):**
  `app/lib/pipeline/sku-matching.js` · `app/lib/pipeline/pipeline-demand.js` · `app/lib/pipeline/burn-down.js`
- A file may import from another engine file only as stated below.

## Input shape — Opportunity (already normalised from Salesforce; contains NO account/contact/amount)
```js
{ id: 'opaque string', stageName: 'Negotiation', probability: 50,   // 0-100
  closeDate: '2026-11-01',
  lineItems: [{ productCode: 'SKU-X', quantity: 300 }] }
```

## sku-matching.js  (owner: engine-match) — imports nothing
```js
normalizeSku(s)            // String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase(); '' stays ''
buildSkuIndex(shopifySkus) // -> { index: Map<normalized, shopifySku>, collisions: [{ normalized, skus: [..] }] }
                           //    empty/blank skus skipped. If two Shopify SKUs normalise equal, the FIRST wins in
                           //    `index` and the clash is listed in `collisions` (never silently merged).
resolveSku(productCode, index) // -> shopifySku string | null   (exact normalised match only; no fuzzy)
summarizeUnmatched(opportunities, index)
                           // -> [{ productCode, openDealCount, rawQty }] sorted by productCode (normalised) asc.
                           //    One row per distinct normalised code that does not resolve. productCode is the
                           //    first spelling seen. openDealCount counts distinct opportunities. Blank codes
                           //    are reported with productCode ''. Quantities <= 0 or non-finite are ignored.
```

## pipeline-demand.js  (owner: engine-demand) — may import `resolveSku` from `./sku-matching.js`
```js
effectiveProbability(probability, stageName, stageOverrides, haircut) // -> number in [0,1]

// Shipment: one entry per (sku, day). Sorted by day asc. Same-day entries are summed.
//   { day: int >= 0, weightedQty: number, rawQty: number, openDealCount: int }
pipelineShipments({ opportunities, stageOverrides = {}, haircut = 1, shipOffsetDays = 7,
                    today, horizonDays, skuIndex })
  // -> Map<shopifySku, Shipment[]>
  // shipDay = daysBetween(today, closeDate) + shipOffsetDays.
  //   shipDay < 0  (overdue deal)        -> clamped to day 0, still counted
  //   shipDay > horizonDays              -> excluded
  // Line items whose productCode does not resolve are skipped (see summarizeUnmatched).
  // Items with quantity <= 0 or non-finite are skipped. Several line items for the same SKU in one
  // opportunity are summed. openDealCount counts distinct opportunities per (sku, day).
  // Opportunities with effective probability 0 still contribute rawQty and openDealCount, weightedQty 0.
  // Empty/absent opportunities -> empty Map.

// Week: { weekStart: 'YYYY-MM-DD' (the ISO Monday, UTC, on or before the ship date),
//         weightedQty, rawQty, openDealCount }.  Sorted by weekStart asc.
pipelineDemandByWeek(sameOptionsAsPipelineShipments) // -> Map<shopifySku, Week[]>
  // Built from the same shipments (same clamping/horizon rules). Quantities summed per week.
  // openDealCount = distinct opportunities per (sku, week).

weeksToShipments(weeks, today) // -> Shipment[]  (used when only stored weekly rows are available)
  // day = max(0, daysBetween(today, weekStart)). Deliberately places weekly demand at the START of its
  // week (conservative: it can only move a stockout earlier). Same-day entries summed. Sorted by day asc.
  // Documented precision loss: weekly storage is coarser than the deal-level worked example.
```

## burn-down.js  (owner: engine-burndown) — imports nothing
```js
simulateBurnDown({ stock, retailDailyDemand, shipments = [], leadTimeDays, horizonDays })
  // shipments: [{ day, qty }]   (qty = the number to consume; the caller chooses weightedQty or rawQty)
  // -> { stockoutDay: int | null, orderByDay: int | null }
  // Algorithm: level = stock; for day t = 0..horizonDays:
  //     if t > 0: level -= retailDailyDemand          (retail consumed during day t)
  //     level -= sum(qty of shipments whose day == t)  (day < 0 treated as day 0)
  //     if level <= 0: stockoutDay = t; stop.          (reaching exactly 0 counts as stockout)
  //   No stockout within horizon -> stockoutDay null.
  // orderByDay = stockoutDay - leadTimeDays (may be NEGATIVE = already late); null when stockoutDay null.
  // Retail demand < 0 or non-finite is treated as 0. stock already <= 0 -> stockoutDay 0.

scenarioSet({ stock, retailDailyDemand, shipments, leadTimeDays, horizonDays })
  // shipments here are Shipment[] from pipeline-demand ({day, weightedQty, rawQty, ...}).
  // -> { retailOnly, weighted, allClose }, each { stockoutDay, orderByDay }
  //    retailOnly: no shipments · weighted: qty = weightedQty · allClose: qty = rawQty
```

## Worked example (must pass as a test)
`stock 400, retail 10/day, leadTimeDays 14, horizon 90.`
Deal A: 300 units at probability 50, ships day 20. Deal B: 200 units at probability 20, ships day 30.

| Scenario | stockoutDay | orderByDay |
|---|---|---|
| retailOnly | 40 | 26 |
| weighted | 25 | 11 |
| allClose | 20 | 6 |

Build it end-to-end through the real functions: with `today = '2026-01-01'`, `shipOffsetDays = 0`,
closeDates `'2026-01-21'` (day 20) and `'2026-01-31'` (day 30), one SKU `SKU-X`, then
`pipelineShipments` -> `scenarioSet`.
Hand check — weighted: day 20 level = 400 − 200 − 150 = 50; 5 more days of retail → 0 at day 25. allClose: day 20 level = 400 − 200 − 300 = −100 → day 20.

## Rulings made during the build (2026-10-12, lead) — now part of the contract
- `openDealCount` counts distinct opportunity **objects** (array elements), never `id` values. Same `id` twice = two deals.
- A quantity counts only if `typeof === 'number'`, finite and > 0. Numeric strings are ignored, not coerced.
- `buildSkuIndex`: the same Shopify SKU string listed twice is one SKU, not a collision. Only different strings that normalise equal are collisions.
- `resolveSku` / `summarizeUnmatched` accept the `{ index, collisions }` object or a bare `Map`.
- `summarizeUnmatched.productCode` is the first spelling seen, trimmed (internal whitespace kept).
- Overdue deals are clamped to day 0 *before* weekly bucketing, so they land in the week containing `today`.
- Only strict `YYYY-MM-DD` dates are accepted (Salesforce `CloseDate` is date-only). Invalid dates, invalid `today` or a missing `skuIndex` are skipped / return an empty result, never thrown.
- Defensive defaults: non-finite `horizonDays` in demand = no upper bound; non-finite `shipOffsetDays` = 7; non-finite `haircut` = 1; non-finite `probability` = 0; override `null`/`undefined` falls back to the deal's probability.
- Burn-down: fractional shipment days are floored; non-finite `stock` = 0 (immediate stockout); non-finite `leadTimeDays` = 0; non-finite shipment `qty`/`day` are skipped.
- **Open (unspecified, untested):** a burn-down shipment with a negative `qty` currently adds stock. Decide whether to clamp it to 0 before M2.

## Privacy
No identifiers named `account`, `contact`, `amount`, `email`, `phone` or similar in engine code, fixtures or tests (a test greps for this). Opportunity `id` is an opaque string and is never output.
