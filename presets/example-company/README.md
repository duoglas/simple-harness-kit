# Preset: example-company

Public scaffold demonstrating how to write a company-specific preset. **Not a real company's rules** — copy this whole directory, rename, and adjust the fields.

## What it demonstrates

1. **Commit format extending `generic`** — adds a `<TICKET-ID>` prefix in front of Conventional Commits (e.g. `JIRA-1234 feat: add login`)
2. **Protected branch families** — `feature-*` / `release-*` / `hotfix-*` / `main` / `master` reject direct push (use MR/PR)
3. **Concurrency constraint** — only one `release-*` branch may exist at a time
4. **Fork constraints** — `feature-*` must fork from `main`/`master`; `hotfix-*` must fork from a tag
5. **Type-on-branch ban** — `feat` commits are forbidden on `release-*`/`hotfix-*`

## How to use as a starting point

```bash
cp -r presets/example-company presets/<your-company>
$EDITOR presets/<your-company>/manifest.json
$EDITOR presets/<your-company>/commit-format.json
$EDITOR presets/<your-company>/branch-policy.json
```

Then in `.harness.local.json`:

```json
{ "preset": "<your-company>" }
```

## What NOT to put in a preset

- **Internal URLs / hostnames** (these belong in your team's local secrets, not in a committed preset)
- **Real internal task IDs** (use a placeholder regex like `^[A-Z]+-\d+`)
- **Employee identities** (handle via `.mailmap` in your private fork, not in the preset)
- **References to internal docs** (link to public-safe equivalents, or omit)

If your preset needs internal-only content (e.g. your real branch list, your internal wiki link), keep that variant **outside this repo** — distribute it to your team via a private channel and gitignore the directory locally. See `methodology/19-company-presets.md` for the recommended pattern.

## Fields reference

See `presets/generic/` for the minimal skeleton. Field semantics are documented in `methodology/19-company-presets.md`.
