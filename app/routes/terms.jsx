/**
 * Public terms of service. No authentication. All text comes from lib/policy-text.js.
 */
import { BlockStack, Card, Link, Page, Text } from "@shopify/polaris";
import {
  POLICY_LAST_UPDATED,
  TERMS_SECTIONS,
  SUPPORT_ADDRESS,
} from "../lib/policy-text.js";

export const meta = () => [{ title: "Terms of service" }];

export default function Terms() {
  return (
    <Page title="Terms of service">
      <BlockStack gap="400">
        <Text as="p" tone="subdued">
          Last updated: {POLICY_LAST_UPDATED}
        </Text>
        <Card>
          <BlockStack gap="400">
            {TERMS_SECTIONS.map((section) => (
              <BlockStack gap="200" key={section.heading}>
                <Text as="h2" variant="headingMd">
                  {section.heading}
                </Text>
                {section.paragraphs.map((text) => (
                  <Text as="p" key={text}>
                    {text}
                  </Text>
                ))}
              </BlockStack>
            ))}
            <Text as="p">
              Questions? Write to{" "}
              <Link url={`mailto:${SUPPORT_ADDRESS}`} external>
                {SUPPORT_ADDRESS}
              </Link>
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
