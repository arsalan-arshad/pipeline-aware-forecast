/**
 * Public entry. Shopify-initiated opens carry `?shop=`; those go straight to
 * /app. Otherwise a static page points to the Shopify admin (no manual shop
 * domain entry, App Store requirement 2.3.1).
 */
import { redirect } from "@remix-run/node";
import { Page, Card, Text } from "@shopify/polaris";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return null;
};

export default function Index() {
  return (
    <Page>
      <Card>
        <Text as="p">Open Pipeline-Aware Forecast from your Shopify admin.</Text>
      </Card>
    </Page>
  );
}
