# npm CI/CD Setup Tasks

Repository: **github.com/ryansabin/signalk-autopilot-provider-garmin**
Package: **signalk-autopilot-provider-garmin** (already published, we own the name)

The GitHub Actions workflow file is already committed at
`.github/workflows/npm-publish.yml`. It triggers on GitHub Release publish
and runs `npm publish --provenance`.

The following tasks require human action (browser + terminal). Complete them
in order.

---

## Task 1 — Create a scoped npm Granular Access Token

1. Log in at **npmjs.com**
2. Avatar (top right) → **Access Tokens** → **Generate New Token** → **Granular Access Token**
3. Fill in:
   - Name: `github-actions-autopilot-provider`
   - Expiration: 365 days
   - Packages and scopes: **Read and write**
   - Select packages: **Only select packages** → `signalk-autopilot-provider-garmin`
4. Click **Generate Token**
5. **Copy the token value** — it is only shown once

---

## Task 2 — Add the token as a GitHub Actions secret

1. Go to **github.com/ryansabin/signalk-autopilot-provider-garmin**
2. **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
   - Name: `NPM_TOKEN`
   - Value: the token copied in Task 1
4. Click **Add secret**

---

## Task 3 — Set GitHub Actions workflow permissions

1. On the same repo, go to **Settings** → **Actions** → **General**
2. Under **Workflow permissions**, select **Read and write permissions**
3. Click **Save**

---

## Task 4 — Verify the workflow file is correct

File: `.github/workflows/npm-publish.yml`

Expected content:
```yaml
name: Publish to npm

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

If the file is missing or different, create/update it and push to `main`.

---

## Task 5 — Do a test release to confirm the pipeline works

Run these commands in the repo root:

```bash
# Bump to next patch version (0.2.0 → 0.2.1)
npm version patch

# Push the commit and the new tag
git push && git push --tags
```

Then in the browser:
1. Go to **github.com/ryansabin/signalk-autopilot-provider-garmin/releases**
2. Click **Draft a new release**
3. **Choose a tag:** select the tag just pushed (e.g., `v0.2.1`)
4. Title: `v0.2.1`
5. Click **Publish release**

---

## Task 6 — Confirm success

- **github.com/ryansabin/signalk-autopilot-provider-garmin/actions** — workflow run should show green
- **npmjs.com/package/signalk-autopilot-provider-garmin** — version should be updated

---

## How to release going forward

Every future release follows the same pattern:

```bash
npm version patch   # or minor or major
git push && git push --tags
```

Then create a GitHub Release on the new tag. The workflow handles the rest.
