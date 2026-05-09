# Git hooks

Repository-tracked git hooks. Run once after clone:

```bash
git config core.hooksPath scripts/git-hooks
```

## Hooks

### `pre-commit`

Runs `gitleaks protect --staged` to detect secrets in staged changes before commit.

- Requires: `brew install gitleaks` (skipped silently if not installed)
- Bypass (emergency only): `SKIP_GITLEAKS=1 git commit ...`
- Final defense line: GitHub Action `.github/workflows/secret-scan.yml`
  re-runs gitleaks on every push, so bypassed commits get caught at push time.

## Adding new hooks

Place executable shell scripts in this directory. Git will pick them up via
`core.hooksPath` configured above.
