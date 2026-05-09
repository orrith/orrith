# Distribution channels

Orrith targets multiple distribution channels at launch (Step 5). This directory holds templates / drafts for each.

## Channels

### 1. npm (primary)
- `npx orrith` works without install
- Published to https://www.npmjs.com/package/orrith
- Handled by `package.json` + `npm publish`

### 2. Homebrew tap (`homebrew-orrith`)
- Separate repo: `github.com/orrith/homebrew-orrith`
- Formula template: `homebrew-formula.rb`
- Install: `brew tap orrith/orrith && brew install orrith`

### 3. Scoop (Windows)
- Manifest template: `scoop-manifest.json`
- Submit to scoop-extras or own bucket

### 4. awesome-* lists
- Target list: `awesome-prs.md`

### 5. ProductHunt / Hacker News / Show HN / Reddit
- Launch-time channels (one-shot)
- Detail: `secretary/notes/orrith-launch-strategy.md`

## At launch (Step 5)

1. `npm publish` (after version freeze)
2. Create `homebrew-orrith` repo + push formula
3. Submit Scoop manifest
4. Open PRs to awesome-* lists (5 minimum)
5. Show HN post (timing per launch-strategy)
