# Contributing

Pull requests welcome. This guide covers the boring contract bits up front so reviews stay focused on the work itself.

## License

This project is MIT licensed. By contributing you agree your changes are MIT-licensed too. There is no CLA; the per-commit sign-off below is the lightweight equivalent.

## Sign-off

Every commit must include a `Signed-off-by:` line. Use `git commit -s`. This is the Developer Certificate of Origin 1.1 (https://developercertificate.org/), and it's how we keep the IP story clean without paperwork.

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/). Examples:

- `feat(commands): doctor diagnostics`
- `fix(http): preflight Max-Age was not set`
- `docs: autostart guide for windows`
- `chore: bump vitest`

One scope, one commit. Don't bundle unrelated fixes.

## Branching

Branch from `main`. Name the branch after the change, not the issue number: `feat/doctor-diagnostics`, `fix/cors-preflight-age`. PR target is `main`.

## Tests are mandatory

Every PR that changes runtime behavior must include tests. The bar:

- Unit test for any new function.
- Regression test for any bug fix (the test must fail without your fix and pass with it).
- For commands: a `__tests__` file in `src/commands/__tests__/`.

Run locally:

```sh
npm install
npx tsc --noEmit
npm test
npm run build
```

All four must pass before you push. CI runs the same.

## What's in scope

- New commands or flags that fit the v1.4.x roadmap (see proposition-app#341 and the ENG_PLAN).
- Bug fixes.
- Provider additions (Gemini CLI is welcome).
- Docs improvements and clearer error messages.

## What's out of scope (will be politely closed)

- Web-app features (those live in the proposition-app repo).
- API-key proxying (this CLI is BYOK-subscription only; API key proxying is what would-be cloud SaaS does).
- Telemetry that isn't opt-in (see `TELEMETRY.md`).
- Bundling secrets, npm tokens, or auto-publish behavior (see `SECURITY.md`).

## PR checklist (copy-paste into your PR body)

```
- [ ] Conventional Commit title
- [ ] `git commit -s` sign-off on every commit
- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` green; counts in PR body
- [ ] `npm run build` clean
- [ ] No emojis added to code or commits (the existing WARN/OK marks are intentional)
- [ ] No em dashes (use colons or semicolons)
- [ ] Telemetry stays opt-in
- [ ] CORS allowlist unchanged or audited
- [ ] No secrets in the diff (`gitleaks`-equivalent self-check)
```

## Disclosing a vulnerability

See [SECURITY.md](./SECURITY.md). Please don't open a public issue for it.
