/**
 * Feedback and support screen. Shows the owner's public contact address and
 * stores a short message with an optional rating, keyed by shop.
 */
import { useState } from "react";
import { Form, useActionData, useNavigation, useSubmit } from "react-router";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  FormLayout,
  Link,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import prisma from "../lib/db.server.js";
import { authenticate } from "../lib/shopify.server.js";
import { saveFeedback } from "../lib/feedback.server.js";
import { SUPPORT_MAILBOX } from "../lib/support.js";

const RATING_OPTIONS = [
  { label: "No rating", value: "" },
  { label: "1", value: "1" },
  { label: "2", value: "2" },
  { label: "3", value: "3" },
  { label: "4", value: "4" },
  { label: "5", value: "5" },
];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return {};
};

const str = (form, key) => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const result = await saveFeedback({
    prisma,
    shop: session.shop,
    message: str(form, "message"),
    rating: str(form, "rating"),
    now: new Date(),
  });
  return {
    ok: result.ok,
    message: result.ok ? "Thank you! Your message was sent." : result.message,
  };
};

export default function Feedback() {
  const result = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const [rating, setRating] = useState("");
  const [message, setMessage] = useState("");

  const busy = navigation.state !== "idle";

  const onSend = (event) => {
    event.preventDefault();
    const data = new FormData();
    data.set("rating", rating);
    data.set("message", message);
    submit(data, { method: "post" });
    setMessage("");
  };

  return (
    <Page
      title="Feedback and support"
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <BlockStack gap="400">
        {result && (
          <Banner tone={result.ok ? "success" : "critical"}>
            <p>{result.message}</p>
          </Banner>
        )}

        <Card>
          <Text as="p">
            Questions, problems or ideas? Write to us at{" "}
            <Link url={`mailto:${SUPPORT_MAILBOX}`} external>
              {SUPPORT_MAILBOX}
            </Link>
            . We read every message.
          </Text>
        </Card>

        <Card>
          <Form method="post" onSubmit={onSend}>
            <BlockStack gap="400">
              <FormLayout>
                <Select
                  label="Rating (optional)"
                  options={RATING_OPTIONS}
                  value={rating}
                  onChange={setRating}
                />
                <TextField
                  label="Your message"
                  value={message}
                  onChange={setMessage}
                  multiline={4}
                  maxLength={2000}
                  showCharacterCount
                  autoComplete="off"
                />
              </FormLayout>
              <Text as="p" tone="subdued">
                Please do not include personal data about your customers. We
                store your message together with your shop address so we can
                follow up; it is deleted after you uninstall the app.
              </Text>
              <div>
                <Button submit variant="primary" loading={busy}>
                  Send
                </Button>
              </div>
            </BlockStack>
          </Form>
        </Card>

        <Text as="p" tone="subdued" variant="bodySm">
          <a href="/privacy">Privacy policy</a> | <a href="/terms">Terms of service</a>
        </Text>
      </BlockStack>
    </Page>
  );
}
