// Written by the engineering session from the code's actual behaviour. Reviewed by the owner and marked complete on 2026-10-14. Not legal advice.
//
// All prose for the public privacy and terms pages lives here, not in the route files, because the
// route files are scanned for personal-data words (test/schema.test.js). Routes render these arrays generically.

export const POLICY_LAST_UPDATED = "2026-10-12";
export const SUPPORT_ADDRESS = "arsalanarshad.dev@gmail.com";

export const PRIVACY_SECTIONS = [
  {
    heading: "Who we are",
    paragraphs: [
      "Pipeline-Aware Forecast is a Shopify app maintained by Arsalan Arshad.",
      `You can reach us at ${SUPPORT_ADDRESS}.`,
    ],
  },
  {
    heading: "What the app does",
    paragraphs: [
      "The app estimates when each of your products will run out of stock and when to reorder. It counts your online sales and the open wholesale deals in your own Salesforce.",
      "It is read-only: it never changes anything in your Shopify store or in your Salesforce org.",
    ],
  },
  {
    heading: "What we read from Shopify",
    paragraphs: [
      "Products and SKUs, inventory levels and locations, and, for the last 28 days, the SKU and quantity of each order line.",
      "We add up quantities per SKU. We do not read customer names, addresses, phone numbers or email addresses.",
    ],
  },
  {
    heading: "What we read from Salesforce",
    paragraphs: [
      "Open Opportunities and their line items (product code and quantity), read through the External Client App that you create in your own Salesforce org and the credentials you enter in the app's Settings.",
    ],
  },
  {
    heading: "Data we store",
    paragraphs: [
      "For each shop we store: your shop domain and the install, uninstall and last-seen times; your forecast settings; your Salesforce connection (instance URL, client ID and client secret, with the client ID and secret encrypted); weekly quantities and deal counts per SKU; Salesforce product codes that matched no Shopify SKU (the code, deal count and units); any feedback messages you send us (free text and an optional 1 to 5 rating); and Shopify's session record for your shop.",
    ],
  },
  {
    heading: "Data we do not store",
    paragraphs: [
      "We do not store Salesforce account names, contacts, deal amounts or notes.",
      "We do not store Shopify customer details.",
      "We do not store order contents beyond the per-SKU sums that are computed in memory.",
    ],
  },
  {
    heading: "Third parties",
    paragraphs: [
      "The only third party the app connects to is your own Salesforce org, and only because you set up the connection.",
      "We use no analytics, no advertising and no AI provider, and we do not sell your data.",
    ],
  },
  {
    heading: "Retention and deletion",
    paragraphs: [
      "When you uninstall the app, your Shopify session and your stored Salesforce credentials are deleted.",
      "When Shopify sends its shop erasure request, about 48 hours after uninstall, everything we store for your shop is deleted, including feedback messages.",
    ],
  },
  {
    heading: "Security",
    paragraphs: [
      "Your Salesforce client ID and secret are encrypted at rest with AES-256-GCM.",
      "The app has read-only access to both Shopify and Salesforce.",
      "Access to stored data is limited to the maintainer.",
    ],
  },
  {
    heading: "Your rights and requests",
    paragraphs: [
      `To ask what we hold about your shop, or to ask us to delete it, write to ${SUPPORT_ADDRESS}.`,
      "Deletion also happens automatically when you uninstall the app, as described above.",
    ],
  },
  {
    heading: "Changes to this policy",
    paragraphs: [
      "If we change this policy we will update the date at the top of this page.",
    ],
  },
  {
    heading: "Contact",
    paragraphs: [`Write to ${SUPPORT_ADDRESS}.`],
  },
];

export const TERMS_SECTIONS = [
  {
    heading: "The service",
    paragraphs: [
      "Pipeline-Aware Forecast is a Shopify app for brands that sell on Shopify and also sell wholesale through a Salesforce sales team. It combines your Shopify sales and stock with your open Salesforce deals to estimate stockout and reorder dates.",
      "By installing or using the app you agree to these terms.",
    ],
  },
  {
    heading: "Your responsibilities",
    paragraphs: [
      "You are responsible for the permissions and credentials in your own Salesforce org, and for keeping them secure.",
      "We recommend that the integration uses a read-only integration user.",
      "You are responsible for the accuracy of your SKUs and Salesforce product codes. The app matches them exactly (ignoring letter case and surrounding spaces), and codes that do not match are left out of the numbers.",
    ],
  },
  {
    heading: "Read-only",
    paragraphs: [
      "The app only reads data. It never writes to your Shopify store or to your Salesforce org.",
    ],
  },
  {
    heading: "Forecasts are estimates",
    paragraphs: [
      "Forecasts are estimates to help you plan. They are not guarantees.",
      "They depend on your own deal probabilities, your settings and the quality of your data.",
      "You decide what to order; please use your own judgement.",
    ],
  },
  {
    heading: "Availability and changes",
    paragraphs: [
      "The app is provided as is, without warranty of any kind. It may be unavailable at times, and we may change it.",
    ],
  },
  {
    heading: "Limitation of liability",
    paragraphs: [
      "To the extent the law allows, we are not liable for losses that result from using the app or relying on its forecasts, including lost sales, excess stock or stockouts.",
    ],
  },
  {
    heading: "Termination",
    paragraphs: [
      "You can uninstall the app at any time. What happens to your data is described in the privacy policy.",
      "We may stop providing the service.",
    ],
  },
  {
    heading: "Contact",
    paragraphs: [`Write to ${SUPPORT_ADDRESS}.`],
  },
];
