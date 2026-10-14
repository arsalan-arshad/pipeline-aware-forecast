# Pipeline-Aware Forecast

Read-only standalone Shopify app: weighted open Salesforce pipeline -> deterministic stockout forecast (a standalone app).
Start with `README.md`; details in `docs/SPEC.md`, `docs/BUILD_PLAN.md` and `docs/M1_CONTRACT.md`.
If a `PROJECT_CONTEXT.md` build log exists locally (it is not part of the public repo), read it too.

## Hard rules
- Core logic is pure and deterministic (no network, no AI, no clock reads). AI only explains.
- v1 is READ-ONLY on Salesforce and Shopify. No writes, no new Shopify scopes without owner sign-off.
- Aggregates only: per-SKU per-week quantities. No account names, contacts or amounts anywhere
  (code, fixtures, logs, prompts, schema).
- Salesforce integrations use External Client Apps, never Connected Apps. Re-verify platform facts
  against current docs and cite the URL.
- README/docs claim only what exists. CI gates only on checks that really run.
- Never print or commit secrets; reference variable names only.
- ASK the owner before: commit, push, tag, deploy, release, open/merge a PR, submit for review.
- Never touch `../salesforce`.
- One public contact email: arsalanarshad.dev@gmail.com.

## Code conventions
- ESM, plain `.js`, no dependencies for the engine. Code lives in `app/lib/pipeline/` so files drop
  into a React Router app. Match the surrounding style: doc-comment header, `round2`.
- Tests: Node built-in runner. `npm test` (= `node --test`). Tests live in `test/`.
- Edit only files you own when working in a team. Need another file? Ask the lead.

## Session end
After material progress, update the README roadmap and `docs/BUILD_PLAN.md`. If a local
`PROJECT_CONTEXT.md` exists, also append a numbered section to it (append-only).
