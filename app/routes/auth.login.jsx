/**
 * /auth/login: login() redirects into OAuth when `shop` is present. Otherwise
 * a static message is shown; the shop domain is never requested manually.
 */
import { Page, Card, Text } from "@shopify/polaris";
import { login } from "../lib/shopify.server.js";

export const loader = async ({ request }) => {
  await login(request);
  return null;
};

export default function Auth() {
  return (
    <Page>
      <Card>
        <Text as="p">Open Pipeline-Aware Forecast from your Shopify admin.</Text>
      </Card>
    </Page>
  );
}
