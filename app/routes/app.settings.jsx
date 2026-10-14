/**
 * Salesforce connection screen. The loader returns only whether a connection
 * exists and its host; credential columns are never selected, and submitted
 * credentials are never echoed back or placed in any response.
 */
import { useState } from "react";
import {
  Form,
  data,
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  FormLayout,
  InlineStack,
  Link,
  List,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import prisma from "../lib/db.server.js";
import { authenticate } from "../lib/shopify.server.js";
import {
  deleteSalesforceConnection,
  saveSalesforceConnection,
  testStoredConnection,
} from "../lib/connection.server.js";
import {
  loadPipelineSettings,
  savePipelineSettings,
} from "../lib/settings.server.js";

const DOCS_URL =
  "https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_client_credentials_flow.htm";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const connection = await prisma.salesforceConnection.findUnique({
    where: { shop: session.shop },
    select: { instanceUrl: true },
  });
  let instanceHost = null;
  if (connection) {
    try {
      instanceHost = new URL(connection.instanceUrl).host;
    } catch {
      instanceHost = null;
    }
  }
  const settings = await loadPipelineSettings({ prisma, shop: session.shop });
  return { connected: Boolean(connection), instanceHost, settings };
};

const str = (form, key) => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const encryptionKey = process.env.ENCRYPTION_KEY;
  const form = await request.formData();
  const intent = str(form, "intent");

  if (intent === "save") {
    const result = await saveSalesforceConnection({
      prisma,
      shop,
      instanceUrl: str(form, "instanceUrl").trim(),
      clientId: str(form, "clientId").trim(),
      clientSecret: str(form, "clientSecret"),
      encryptionKey,
    });
    return {
      intent,
      ok: result.ok,
      message: result.ok ? "Connection saved." : result.message,
    };
  }
  if (intent === "test") {
    const result = await testStoredConnection({ prisma, shop, encryptionKey });
    return {
      intent,
      ok: result.ok,
      message: result.message,
    };
  }
  if (intent === "disconnect") {
    await deleteSalesforceConnection({ prisma, shop });
    return { intent, ok: true, message: "Salesforce disconnected." };
  }
  if (intent === "saveSettings") {
    let stageOverrides;
    try {
      stageOverrides = JSON.parse(str(form, "stageOverrides") || "[]");
    } catch {
      return {
        intent,
        ok: false,
        message: "The stage table could not be read.",
      };
    }
    const result = await savePipelineSettings({
      prisma,
      shop,
      haircut: str(form, "haircut"),
      shipOffsetDays: str(form, "shipOffsetDays"),
      horizonDays: str(form, "horizonDays"),
      leadTimeDays: str(form, "leadTimeDays"),
      stageOverrides,
    });
    return {
      intent,
      ok: result.ok,
      message: result.ok
        ? "Settings saved. They apply to the next refresh."
        : result.message,
    };
  }
  return data({ ok: false, message: "Unknown action." }, { status: 400 });
};

export default function Settings() {
  const { connected, instanceHost, settings } = useLoaderData();
  const result = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const [instanceUrl, setInstanceUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const [haircut, setHaircut] = useState(String(settings.haircut));
  const [shipOffsetDays, setShipOffsetDays] = useState(
    String(settings.shipOffsetDays),
  );
  const [horizonDays, setHorizonDays] = useState(String(settings.horizonDays));
  const [leadTimeDays, setLeadTimeDays] = useState(
    String(settings.leadTimeDays),
  );
  const [stageRows, setStageRows] = useState(
    settings.stageOverrides.map((o) => ({
      stageName: o.stageName,
      probability: String(o.probability),
    })),
  );

  const updateStageRow = (index, field, value) =>
    setStageRows((rows) =>
      rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  const removeStageRow = (index) =>
    setStageRows((rows) => rows.filter((_, i) => i !== index));
  const addStageRow = () =>
    setStageRows((rows) => [...rows, { stageName: "", probability: "" }]);

  const onSaveSettings = (event) => {
    event.preventDefault();
    const data = new FormData();
    data.set("intent", "saveSettings");
    data.set("haircut", haircut);
    data.set("shipOffsetDays", shipOffsetDays);
    data.set("horizonDays", horizonDays);
    data.set("leadTimeDays", leadTimeDays);
    data.set("stageOverrides", JSON.stringify(stageRows));
    submit(data, { method: "post" });
  };

  const busyIntent =
    navigation.state !== "idle" ? navigation.formData?.get("intent") : null;

  const post = (intent) => {
    const data = new FormData();
    data.set("intent", intent);
    submit(data, { method: "post" });
  };

  const onSave = (event) => {
    event.preventDefault();
    const data = new FormData();
    data.set("intent", "save");
    data.set("instanceUrl", instanceUrl);
    data.set("clientId", clientId);
    data.set("clientSecret", clientSecret);
    submit(data, { method: "post" });
    // Do not keep the secret in client state after submitting.
    setClientSecret("");
  };

  return (
    <Page
      title="Settings"
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <BlockStack gap="400">
        {result && (
          <Banner tone={result.ok ? "success" : "critical"}>
            <p>{result.message}</p>
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Set up a Salesforce External Client App
            </Text>
            <List type="number">
              <List.Item>
                In Salesforce Setup, create an External Client App and enable
                OAuth.
              </List.Item>
              <List.Item>
                Enable the client credentials flow and select the OAuth scope{" "}
                <Text as="span" fontWeight="semibold">
                  api
                </Text>{" "}
                only.
              </List.Item>
              <List.Item>
                Set Run As to a read-only integration user (read access to
                opportunities and their products only).
              </List.Item>
              <List.Item>
                Copy the consumer key (client ID) and consumer secret, and your
                My Domain URL, into the form below.
              </List.Item>
              <List.Item>
                Save, then use Test connection to check it.
              </List.Item>
            </List>
            <Text as="p">
              <Link url={DOCS_URL} target="_blank" external>
                Salesforce documentation: OAuth client credentials flow
              </Link>
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <Form method="post" onSubmit={onSave}>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Connection
              </Text>
              {connected ? (
                <Text as="p">
                  Connected to {instanceHost ?? "Salesforce"}. Enter new values
                  below to replace the stored connection.
                </Text>
              ) : (
                <Text as="p" tone="subdued">
                  Not connected.
                </Text>
              )}
              <FormLayout>
                <TextField
                  label="Instance URL"
                  name="instanceUrl"
                  value={instanceUrl}
                  onChange={setInstanceUrl}
                  placeholder="https://yourcompany.my.salesforce.com"
                  autoComplete="off"
                />
                <TextField
                  label="Client ID"
                  name="clientId"
                  value={clientId}
                  onChange={setClientId}
                  autoComplete="off"
                />
                <TextField
                  label="Client secret"
                  name="clientSecret"
                  type="password"
                  value={clientSecret}
                  onChange={setClientSecret}
                  autoComplete="off"
                />
              </FormLayout>
              <InlineStack gap="300">
                <Button
                  submit
                  variant="primary"
                  loading={busyIntent === "save"}
                >
                  Save
                </Button>
                <Button
                  onClick={() => post("test")}
                  loading={busyIntent === "test"}
                  disabled={!connected}
                >
                  Test connection
                </Button>
                {connected && (
                  <Button
                    tone="critical"
                    onClick={() => post("disconnect")}
                    loading={busyIntent === "disconnect"}
                  >
                    Disconnect
                  </Button>
                )}
              </InlineStack>
            </BlockStack>
          </Form>
        </Card>

        <Card>
          <Form method="post" onSubmit={onSaveSettings}>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Forecast settings
              </Text>
              <FormLayout>
                <FormLayout.Group>
                  <TextField
                    label="Haircut"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={haircut}
                    onChange={setHaircut}
                    helpText="Multiply every deal probability by this; 1 = trust the CRM"
                    autoComplete="off"
                  />
                  <TextField
                    label="Ship offset days"
                    type="number"
                    min={0}
                    max={90}
                    step={1}
                    value={shipOffsetDays}
                    onChange={setShipOffsetDays}
                    helpText="Days between a deal's close date and when stock ships"
                    autoComplete="off"
                  />
                </FormLayout.Group>
                <FormLayout.Group>
                  <TextField
                    label="Horizon days"
                    type="number"
                    min={7}
                    max={365}
                    step={1}
                    value={horizonDays}
                    onChange={setHorizonDays}
                    autoComplete="off"
                  />
                  <TextField
                    label="Supplier lead time days"
                    type="number"
                    min={0}
                    max={180}
                    step={1}
                    value={leadTimeDays}
                    onChange={setLeadTimeDays}
                    autoComplete="off"
                  />
                </FormLayout.Group>
              </FormLayout>

              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Stage probability overrides
                </Text>
                {stageRows.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No overrides. Salesforce stage probabilities are used as
                    they are.
                  </Text>
                ) : (
                  stageRows.map((row, index) => (
                    <InlineStack
                      key={index}
                      gap="300"
                      blockAlign="end"
                      wrap={false}
                    >
                      <TextField
                        label="Stage name"
                        value={row.stageName}
                        onChange={(value) =>
                          updateStageRow(index, "stageName", value)
                        }
                        maxLength={80}
                        autoComplete="off"
                      />
                      <TextField
                        label="Probability (0-100)"
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={row.probability}
                        onChange={(value) =>
                          updateStageRow(index, "probability", value)
                        }
                        autoComplete="off"
                      />
                      <Button
                        tone="critical"
                        onClick={() => removeStageRow(index)}
                      >
                        Remove
                      </Button>
                    </InlineStack>
                  ))
                )}
                <InlineStack>
                  <Button onClick={addStageRow}>Add row</Button>
                </InlineStack>
              </BlockStack>

              <InlineStack gap="300">
                <Button
                  submit
                  variant="primary"
                  loading={busyIntent === "saveSettings"}
                >
                  Save settings
                </Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Card>
      </BlockStack>
    </Page>
  );
}
