# Contributing

The canonical development home is [scowalt/steam-value on GitHub](https://github.com/scowalt/steam-value): use its [issues](https://github.com/scowalt/steam-value/issues) for bugs/proposals and pull requests for changes. GitHub-hosted Actions runs all CI and CD; there is no separate private development or Woodpecker contribution lane. The [Actions runbook](docs/ci/github-actions.md) records the completed handoff and current release safeguards.

## Isolated development

Use Bun and the versions in `.mise.toml`; the scheduled Node/Steel job is a runtime exception, not the local development path. Follow [README's isolated setup](README.md#isolated-setup-and-verification). Frozen dependency installation, synthetic tests, type checks and builds need no Steam account, Doppler values, D1 operator credentials or production access. Tests use isolated native D1 fixtures and synthetic browser contexts, not the owner's authenticated browser profile.

Do not run the `web`, `worker:dev` or `secrets:dev` convenience aliases for a contribution: they download private credentials. Do not run provider refresh/login jobs to validate a patch. Never commit `.env`, `.dev.vars`, cookies, profile directories, database/export files, real Steam Status, or provider datasets. Use synthetic examples and fixtures. Browser-accessible development servers must follow the README's Portless/private-Tailscale instructions; tests need no such server.

## Checks and review

Read [GLOSSARY.md](GLOSSARY.md) for terminology and relevant [ADRs](docs/adr/). Preserve the distinction between Catalog Facts, HowLongToBeat Estimates and account-specific Steam Status/Playtime.

Run the full Bun suite, configured type checks/build, and the [comment-policy checks](.comment-policy/README.md) before requesting review. Authored source is comment-free; Markdown documents explain intent. Preserve third-party license notices byte-for-byte. Do not bypass existing hooks or weaken tests to obtain green CI.

Fork PRs run on GitHub-hosted runners without artifact or production credentials. Main-only environments and reviewed workflows govern release; a successful local build does not authorize a deployment. CI/CD changes require special review of event filters, environment permissions, artifact identity, current-main checks and serialization. Main merges may publish after activation: coordinate delivery with the maintainer rather than pushing directly or dispatching production workflows.

## Licensing and sensitive reports

Original contributions are under the project's [MIT license](LICENSE), unless separately agreed and clearly identified. Identify any third-party material and its provenance/license in the PR; retain applicable [notices](THIRD_PARTY_NOTICES.md). A provider integration's software license does not license its data or trademarks.

Do not post credentials, private account data or exploit details in a public issue. Contact the maintainer privately for sensitive reports; use GitHub private vulnerability reporting if it is enabled. Do not test suspected exposed credentials against a live service.
