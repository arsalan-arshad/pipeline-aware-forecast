/**
 * Dashboard: per-SKU stockout forecast under three scenarios (retail only,
 * weighted pipeline, all deals close) plus a Refresh action that syncs the
 * Salesforce pipeline. Only status columns of the connection are selected;
 * encrypted credential columns are never read.
 */
import {
  Form,
  data,
  Link as RouterLink,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  Page,
  Text,
} from "@shopify/polaris";
import prisma from "../lib/db.server.js";
import { authenticate } from "../lib/shopify.server.js";
import { buildForecastRows } from "../lib/pipeline/forecast-view.js";
import {
  fetchDailyDemand,
  fetchSkuStock,
} from "../lib/shopify-data.server.js";
import {
  dashboardCache,
  invalidateShop,
  readThrough,
  shopCacheKey,
} from "../lib/shopify-cache.server.js";
import { syncShop } from "../lib/sync-shop.server.js";
import { loadPipelineSettings } from "../lib/settings.server.js";
import { SUPPORT_MAILBOX } from "../lib/support.js";

const DEMAND_DAYS = 28;

const isoDay = (date) => date.toISOString().slice(0, 10);

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const now = new Date();
  const today = isoDay(now);

  const [connection, snapshotRows, unmatchedRows, settings] =
    await Promise.all([
      prisma.salesforceConnection.findUnique({
        where: { shop },
        select: {
          lastSyncAt: true,
          lastErrorClass: true,
          lastErrorMessage: true,
          lastErrorAt: true,
        },
      }),
      prisma.pipelineSnapshot.findMany({
        where: { shop },
        select: {
          sku: true,
          weekStart: true,
          weightedQty: true,
          rawQty: true,
          openDealCount: true,
        },
      }),
      prisma.unmatchedProduct.findMany({
        where: { shop },
        select: { productCode: true, openDealCount: true, rawQty: true },
        orderBy: { productCode: "asc" },
      }),
      loadPipelineSettings({ prisma, shop }),
    ]);

  // Without a connection any stored pipeline data is stale (e.g. after uninstall and reinstall): ignore it.
  const snapshots = (connection ? snapshotRows : []).map((row) => ({
    sku: row.sku,
    weekStart: isoDay(row.weekStart),
    weightedQty: row.weightedQty,
    rawQty: row.rawQty,
    openDealCount: row.openDealCount,
  }));

  let rows = [];
  let shopifyError = null;
  try {
    // Sequential on purpose: two simultaneous Admin API requests failed with a network-level error
    // when run inside the embedded dev server.
    // Cached for up to a minute; the Refresh action invalidates the shop's entries.
    const stockBySku = await readThrough({
      cache: dashboardCache,
      key: shopCacheKey(shop, "stock"),
      loader: () => fetchSkuStock(admin),
    });
    const dailyDemandBySku = await readThrough({
      cache: dashboardCache,
      key: shopCacheKey(shop, "demand"),
      loader: () => fetchDailyDemand(admin, { days: DEMAND_DAYS, now }),
    });
    rows = buildForecastRows({
      today,
      stockBySku,
      dailyDemandBySku,
      snapshots,
      leadTimeDays: settings.leadTimeDays,
      horizonDays: settings.horizonDays,
    });
  } catch (error) {
    // Log only the error type/code and the first GraphQL message (never tokens or payloads).
    console.error(
      "Shopify read failed:",
      error?.name,
      error?.code,
      error?.errors?.graphQLErrors?.[0]?.message ?? error?.message,
      error?.cause?.code ?? error?.cause?.message,
    );
    shopifyError =
      typeof error?.userMessage === "string"
        ? error.userMessage
        : "Could not read stock and sales from Shopify. Try again shortly.";
  }

  return {
    today,
    connected: Boolean(connection),
    lastSyncAt: connection?.lastSyncAt
      ? connection.lastSyncAt.toISOString()
      : null,
    lastError: connection?.lastErrorClass
      ? {
          errorClass: connection.lastErrorClass,
          message: connection.lastErrorMessage,
        }
      : null,
    settings,
    rows,
    shopifyError,
    unmatched: unmatchedRows,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "refresh") {
    // Stock and sales may have changed, so the next dashboard load must re-read Shopify.
    invalidateShop(dashboardCache, session.shop);
    const now = new Date();
    const refresh = await syncShop({
      prisma,
      shop: session.shop,
      admin,
      encryptionKey: process.env.ENCRYPTION_KEY,
      today: isoDay(now),
      now,
      minIntervalMs: 60000, // manual refreshes: at most one a minute per shop
    });
    return { refresh };
  }
  return data({ error: "Unknown action." }, { status: 400 });
};

const timeAgo = (iso, nowMs) => {
  if (!iso) return "never";
  const minutes = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};

const num = (value) =>
  Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "-";

function ScenarioCell({ scenario, today, horizonDays }) {
  if (!scenario || scenario.stockoutDate == null) {
    return (
      <Text as="span" tone="subdued">
        no stockout in {horizonDays} days
      </Text>
    );
  }
  const late = scenario.orderByDate != null && scenario.orderByDate < today;
  return (
    <BlockStack gap="050">
      <Text as="span">{scenario.stockoutDate}</Text>
      {scenario.orderByDate != null && (
        <Text as="span" tone={late ? "critical" : "subdued"}>
          order by {scenario.orderByDate}
          {late ? " (late)" : ""}
        </Text>
      )}
    </BlockStack>
  );
}

export default function Dashboard() {
  const data = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const refreshing =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "refresh";
  const { today, settings, rows, unmatched, lastError } = data;
  const nowMs = Date.parse(`${today}T12:00:00Z`);
  const refresh = actionData?.refresh;

  const tableRows = rows.map((row) => [
    row.sku,
    num(row.stock),
    num(row.retailDailyDemand),
    String(row.openDealCount),
    num(row.weightedUnits),
    <ScenarioCell
      key={`${row.sku}-r`}
      scenario={row.scenarios.retailOnly}
      today={today}
      horizonDays={settings.horizonDays}
    />,
    <ScenarioCell
      key={`${row.sku}-w`}
      scenario={row.scenarios.weighted}
      today={today}
      horizonDays={settings.horizonDays}
    />,
    <ScenarioCell
      key={`${row.sku}-a`}
      scenario={row.scenarios.allClose}
      today={today}
      horizonDays={settings.horizonDays}
    />,
  ]);

  return (
    <Page title="Pipeline-Aware Forecast">
      <BlockStack gap="400">
        <Form method="post">
          <input type="hidden" name="intent" value="refresh" />
          <Button submit variant="primary" loading={refreshing}>
            Refresh pipeline
          </Button>
        </Form>

        {refresh && (
          <Banner tone={refresh.ok ? "success" : "critical"}>
            <p>
              {refresh.ok
                ? `Pipeline refreshed: ${refresh.skuCount} SKUs, ${refresh.rowCount} weekly rows, ${refresh.unmatchedCount} unmatched product codes.`
                : `Refresh failed (${refresh.errorClass}): ${refresh.message}`}
            </p>
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical">
            <p>{actionData.error}</p>
          </Banner>
        )}

        {!data.connected && (
          <Banner tone="warning">
            <p>
              Salesforce is not connected.{" "}
              <RouterLink to="/app/settings">Connect Salesforce</RouterLink> to
              include open deals in the forecast.
            </p>
          </Banner>
        )}

        {lastError && (
          <Banner tone="critical">
            <p>
              Last sync failed ({lastError.errorClass}): {lastError.message}.
              Showing data from the last successful sync{" "}
              {timeAgo(data.lastSyncAt, nowMs)}.
            </p>
          </Banner>
        )}

        {data.connected && (
          <Text as="p" tone="subdued">
            Last successful sync:{" "}
            {data.lastSyncAt ? data.lastSyncAt : "never"}
            <br />
            Shopify stock and sales are cached for up to a minute.
          </Text>
        )}

        {data.shopifyError && (
          <Banner tone="critical">
            <p>{data.shopifyError}</p>
          </Banner>
        )}

        {!data.shopifyError && (
          <Card padding="0">
            {tableRows.length === 0 ? (
              <BlockStack gap="200" inlineAlign="center">
                <Text as="p" tone="subdued">
                  No SKUs to forecast yet.
                </Text>
              </BlockStack>
            ) : (
              <DataTable
                columnContentTypes={[
                  "text",
                  "numeric",
                  "numeric",
                  "numeric",
                  "numeric",
                  "text",
                  "text",
                  "text",
                ]}
                headings={[
                  "SKU",
                  "In stock",
                  "Units/day",
                  "Open deals",
                  "Weighted units",
                  "Retail only",
                  "With weighted pipeline",
                  "If all deals close",
                ]}
                rows={tableRows}
              />
            )}
          </Card>
        )}

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              How the numbers are built
            </Text>
            <Text as="p">
              weighted units = quantity x stage probability x haircut
            </Text>
            <Text as="p" tone="subdued">
              Haircut {settings.haircut}, ship offset {settings.shipOffsetDays}{" "}
              days, horizon {settings.horizonDays} days, supplier lead time{" "}
              {settings.leadTimeDays} days. Retail demand is the average of the last{" "}
              {DEMAND_DAYS} days of orders. Order-by date = stockout date minus
              lead time; a past date is shown as late.
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Data quality
            </Text>
            {unmatched.length === 0 ? (
              <Text as="p" tone="subdued">
                No unmatched Salesforce product codes.
              </Text>
            ) : (
              <>
                <Text as="p">
                  These codes matched no Shopify SKU and are excluded from every
                  number.
                </Text>
                <DataTable
                  columnContentTypes={["text", "numeric", "numeric"]}
                  headings={["Product code", "Deals", "Units"]}
                  rows={unmatched.map((u) => [
                    u.productCode,
                    String(u.openDealCount),
                    num(u.rawQty),
                  ])}
                />
              </>
            )}
          </BlockStack>
        </Card>

        <Text as="p" tone="subdued">
          Questions or feedback?{" "}
          <a href={`mailto:${SUPPORT_MAILBOX}`}>{SUPPORT_MAILBOX}</a> or use the{" "}
          <RouterLink to="/app/feedback">Feedback page</RouterLink>.
        </Text>
      </BlockStack>
    </Page>
  );
}
