# Reference: GitHub Cryptographic Release Pipeline & Artifact Attestations

Obsidian's automated community review bot inspects release assets (`main.js`, `manifest.json`, `styles.css`) for **GitHub Artifact Attestations** (SLSA v1 build provenance). 

If a maintainer or agent builds release files locally and uploads them manually (e.g. via GitHub Web UI or `gh release create <tag> main.js ...`), the release lacks cryptographic provenance proofs, resulting in this review warning:

```
- Warning: Missing GitHub artifact attestations for release assets: main.js, styles.css
  Artifact attestations let users cryptographically verify the provenance of the release assets,
  proving they were built from the source repository.
  https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds
```

To eliminate this warning completely and guarantee that releases are cryptographically signed, every release **must be triggered through the automated GitHub Actions pipeline**.

---

## 1. How the Pipeline Works

1. A maintainer or agent creates and pushes a Git tag (e.g. `1.2.0`).
2. GitHub Actions intercepts the tag push and runs the job defined in `.github/workflows/release.yml`.
3. In a pristine, isolated Ubuntu runner, the workflow:
   - Checks out the exact tagged commit.
   - Installs dependencies (`npm ci`).
   - Builds the production bundle (`npm run build`).
   - Runs the headless simulation test suite (`node test-obsidian-simulator.mjs`).
   - Generates cryptographic Sigstore build provenance attestations via `actions/attest-build-provenance@v2`.
   - Automatically signs the predicate using GitHub's OIDC certificate authority.
   - Attaches `main.js`, `manifest.json`, and `styles.css` to the official GitHub Release via `softprops/action-gh-release@v2`.
4. Anyone can cryptographically verify that the published release assets were compiled untampered directly from the source repository.

---

## 2. Workflow Specification (`.github/workflows/release.yml`)

The workflow requires three specific permissions:
```yaml
name: Release Plugin

on:
  push:
    tags:
      - '*'
  workflow_dispatch:

jobs:
  build-and-release:
    runs-on: ubuntu-latest
    permissions:
      contents: write       # Required to create the GitHub Release and attach assets
      id-token: write       # Required to request GitHub OIDC token for Sigstore signing
      attestations: write   # Required to record the artifact attestation in GitHub's registry

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build plugin production bundle
        run: npm run build

      - name: Run automated test suite
        run: node test-obsidian-simulator.mjs

      - name: Generate artifact attestations (Sigstore provenance)
        uses: actions/attest-build-provenance@v2
        with:
          subject-path: |
            main.js
            manifest.json
            styles.css

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            main.js
            manifest.json
            styles.css
          generate_release_notes: true
```

---

## 3. Mandatory Agent Release Protocol (Step-by-Step)

Whenever an agent is tasked with releasing a new version of the plugin, the agent MUST follow these exact steps:

### Step 1: 4-Way Version Bump
Update the version string across all 4 mandatory files simultaneously:
1. `package.json` -> `"version": "X.Y.Z"`
2. `package-lock.json` -> `"version": "X.Y.Z"` (both top-level and `packages[""]`)
3. `manifest.json` -> `"version": "X.Y.Z"`
4. `v0/manifest.json` -> `"version": "X.Y.Z"`

### Step 2: Local Build & Pre-Flight Testing
Run the local build and automated simulator before committing:
```bash
npm run build
node test-obsidian-simulator.mjs
```

### Step 3: Commit and Merge to Master
Ensure all feature work is committed and merged to `master`:
```bash
git add -A
git commit -m "chore(release): X.Y.Z - <summary of changes>"
git push origin master
```

### Step 4: Tag and Push (The Release Trigger)
**NEVER manually upload release assets via `gh release create`!** Simply push the annotated Git tag:
```bash
git tag -a X.Y.Z -m "Release X.Y.Z: <release notes>"
git push origin X.Y.Z
```

### Step 5: Monitor GitHub Actions Workflow
Monitor the workflow run until it completes successfully:
```bash
gh run list --workflow=release.yml -L 1
```

### Step 6: Cryptographically Verify Provenance
Verify that the published assets contain a valid SLSA v1 provenance attestation:
```bash
gh attestation verify main.js -R <owner>/<repo>
```
Expected output:
```
✓ Verification succeeded!
The following 1 attestation matched the policy criteria
Predicate: SLSA Provenance v1
Signer:    <owner>/<repo>/.github/workflows/release.yml@refs/tags/X.Y.Z
OIDC:      token.actions.githubusercontent.com
```

Only when verification succeeds is the release considered ready for the Obsidian Community Marketplace.
