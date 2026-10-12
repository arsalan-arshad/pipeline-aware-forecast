# Contributing to pipeline-aware-forecast

Thanks for your interest! This project is **open source (MIT)**. The spec in `README.md` and `docs/` describes
what it does and what is planned.

## Feedback
- Open an issue for bugs, missing edge cases, or better approaches.
- Use GitHub Discussions for questions, ideas and design feedback. Challenging the forecasting rules in `docs/SPEC.md` is especially welcome.

## Pull requests
- Open an issue first for anything beyond a small fix.
- Keep PRs focused: one feature or fix per PR; branch names `feat/<short>` or `fix/<short>`.
- Only claim checks that are really wired up. CI, lint and tests will be added with the first
  implementation commit; the README's Verification section will list the real commands.
- Never commit secrets. `.env` is git-ignored; document every variable in `.env.example`.
- Forecast math must stay pure and deterministic (no network, no AI). Any change to it needs unit tests with fixed inputs and expected outputs.
- The AI layer may only explain numbers the engine produced; it must never generate them.
- Security-sensitive changes (auth, webhooks, token storage, permissions) get extra scrutiny.

See also the portfolio-level guide: `../CONTRIBUTING.md`.
