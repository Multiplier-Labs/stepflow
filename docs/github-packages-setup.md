# GitHub Packages Setup for @multiplier-labs/stepflow

This document describes how to publish stepflow to GitHub Packages and how to install it in your projects.

## Publishing (Maintainers)

### Automated Publishing via Release

1. Ensure your changes are merged to the main branch
2. Go to **Releases** in the GitHub repository
3. Click **Draft a new release**
4. Create a tag matching the version in `package.json` (e.g., `v0.1.0`)
5. Publish the release

The GitHub Actions workflow (`.github/workflows/publish.yml`) automatically:
- Installs dependencies
- Builds the package
- Publishes to GitHub Packages

### Manual Publishing (if needed)

```bash
# Authenticate with GitHub Packages
npm login --registry=https://npm.pkg.github.com
# Username: your GitHub username
# Password: Personal Access Token with write:packages scope

# Build and publish
npm run build
npm publish
```

## Installing in Projects

### Step 1: Configure npm for the @multiplier-labs scope

Create or update `.npmrc` in your project root:

```
@multiplier-labs:registry=https://npm.pkg.github.com
```

### Step 2: Authenticate with GitHub Packages

Generate a Personal Access Token (PAT):
1. Go to GitHub → Settings → Developer settings → Personal access tokens
2. Generate a token with `read:packages` scope
3. Authenticate npm:

```bash
npm login --registry=https://npm.pkg.github.com
# Username: your GitHub username
# Password: your PAT
# Email: your email
```

Alternatively, add to your `~/.npmrc` (for global auth):

```
//npm.pkg.github.com/:_authToken=YOUR_PAT_HERE
```

### Step 3: Install the package

```bash
npm install @multiplier-labs/stepflow
```

## Usage in CI/CD

For GitHub Actions, use the built-in `GITHUB_TOKEN`:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: '20'
    registry-url: 'https://npm.pkg.github.com'
    scope: '@multiplier-labs'

- run: npm ci
  env:
    NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

For other CI systems, set `NODE_AUTH_TOKEN` environment variable to a PAT with `read:packages` scope.

## Versioning

Update the version in `package.json` before creating a release:

```bash
npm version patch  # 0.1.0 → 0.1.1
npm version minor  # 0.1.0 → 0.2.0
npm version major  # 0.1.0 → 1.0.0
```

Then push the tag and create a release on GitHub.
