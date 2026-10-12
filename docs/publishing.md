# Publishing

This document is for maintainers who publish `oc-go-multi-auth` to npm. It covers the first manual publication, the one-time trusted publisher setup on npmjs.com, and every release after that.

## How releases work

Three pieces make up the release path:

| Piece | Runs | Purpose |
|---|---|---|
| `.github/workflows/ci.yml` | Pull requests and pushes to `main` | Frozen Bun install, typecheck, tests, then `scripts/verify-package.mjs` |
| `scripts/verify-package.mjs` | CI, the publish workflow, or by hand | Builds, packs once, and checks the tarball that would be published |
| `.github/workflows/publish.yml` | Manual (`workflow_dispatch`) only | Verifies a ref and, when dry run is cleared, publishes the verified tarball |

Nothing bumps versions, creates tags, or creates GitHub releases. A maintainer chooses the version in `package.json` and creates the `v<version>` tag.

Both workflows use Bun 1.4.2 and Node 24 on GitHub-hosted Ubuntu runners. Node 24 ships npm 11.5.1 or later, which npm trusted publishing requires. Each workflow also fails early if the runner's npm is older than 11.5.1.

### What the package check verifies

`node scripts/verify-package.mjs` (add `--out <dir>` to choose where the tarball goes; the default is `.tmp/package`) does the following and exits non-zero on the first failure:

1. Deletes `dist/`, runs `bun run build`, and runs `npm pack` once.
2. Confirms the package name is `oc-go-multi-auth` and the version is semver.
3. Confirms every path declared in `main`, `types`, `bin`, and `exports` is in the archive, that `LICENSE`, `README.md` and `package.json` are present, and that nothing else is: the only other files allowed are `dist/*.js` and `dist/*.d.ts`. Tests, source, and local state cannot enter the archive.
4. Scans the built `dist/` files for imported packages and confirms each is declared in `dependencies` or `peerDependencies`. Installing the archive alone cannot catch an undeclared package that npm happens to hoist from another dependency.
5. Installs that exact archive into an empty project in the system temp directory, with lifecycle scripts disabled, no checkout `node_modules`, and an isolated `HOME`. Only the package's own `dependencies` are available.
6. Imports the root entry, `./tui`, and `./v2/provider` through the package `exports` map under both Node and Bun, and checks the shape of each export.
7. Runs the installed `oc-go-multi-auth` bin with `--version`, `--help`, and `list`. The bin starts with `#!/usr/bin/env bun`, so Bun must be on `PATH`.

On success the only line on stdout is the absolute path of the tarball; progress goes to stderr.

The check does not load the package inside a real OpenCode host, and it does not type-check the `.d.ts` files against the optional `@opencode-ai/plugin` and `@opencode/plugin` peers. The root and `./tui` bundles import no host package at runtime, so the host SDKs are not installed during the smoke test. Whether OpenCode accepts the plugin is covered by the tests in `src/__tests__` and by manual use.

### Local and runner validation versus a real publish

The checks above, and a publish workflow dry run, prove that the repository builds and that the tarball is complete and installable. They do not prove that npm will accept a publish from the workflow. That depends on the package existing, the trusted publisher on npmjs.com matching the workflow identity, and npm exchanging the GitHub OIDC token for a publish credential. Only a successful non-dry-run publish demonstrates those, and the first one must be a new version (see [Step 3](#step-3-first-publish-through-the-workflow)).

## Step 1: First publication, by hand

npm only lets you configure a trusted publisher for a package that already exists, and the configuration requires an account with two-factor authentication. The first version therefore has to be published manually. The workflow produces the tarball so that what you publish is exactly what CI verified.

1. Merge the workflow and package changes to `main`.
2. In GitHub, open **Actions → Publish → Run workflow**, choose branch `main`, leave **dry_run** checked, and run it.
3. When the run succeeds, download the `package-tarball` artifact from the run page and unzip it. Confirm the SHA-256 of the `.tgz` matches the one in the run summary: `sha256sum oc-go-multi-auth-0.1.2.tgz`.
4. Sign in with the npm account that should own the package, using the browser and two-factor flow: `npm login`.
5. Publish the tarball itself, not the working tree:

   ```sh
   npm publish ./oc-go-multi-auth-0.1.2.tgz --access public
   ```

   Do not add `--provenance`. npm only generates provenance from a supported CI provider's OIDC identity, so a local publish cannot produce it. Version 0.1.2 will therefore have no provenance attestation.

6. Check `npm view oc-go-multi-auth version` and the package page.
7. Optionally tag the commit the dry run built, `git tag v0.1.2 <sha>` and `git push origin v0.1.2`, so the history lines up with the registry.

An unpublished name is not a reservation. If someone else publishes `oc-go-multi-auth` first, step 5 fails with a registry error, and the package name would have to change in `package.json`, the README, this document, and the trusted publisher.

Published versions are immutable. Version 0.1.2 can never be published again, so it cannot be used to test the OIDC path.

After publishing, update the README: the "Source Setup" section says the package is not published yet.

## Step 2: Configure the trusted publisher

Do this once the package exists. On npmjs.com, open the package, then **Settings → Trusted Publisher**, choose **GitHub Actions**, and enter:

| Field | Value |
|---|---|
| Organization or user | `imarshallwidjaja` |
| Repository | `oc-go-multi-auth` |
| Workflow filename | `publish.yml` |
| Environment name | leave blank (the workflow uses no GitHub environment) |
| Allowed actions | enable `npm publish` |

Enable `npm publish` explicitly. The workflow publishes directly with `npm publish`, and a trusted publisher that only allows `npm stage publish` will reject it.

The same configuration from the command line (npm 11.15.0 or later, signed in with two-factor authentication):

```sh
npm trust github oc-go-multi-auth --file publish.yml --repo imarshallwidjaja/oc-go-multi-auth --allow-publish
```

npm does not validate the values when you save them; a mismatch only shows up when a publish is attempted. All fields are case-sensitive, and the workflow filename must match the file in `.github/workflows/`. Renaming `publish.yml` requires recreating the trusted publisher. The `repository.url` in `package.json` must also match the GitHub repository.

A newly created trusted publisher must complete a successful publish within 2 days. If it does not, it expires and must be deleted and recreated.

Once the trusted publisher works, under **Settings → Publishing access** choose **Require two-factor authentication and disallow tokens**. This blocks token-based publishing. It still allows interactive publishes with two-factor authentication, so it does not make the workflow the only way to publish. The workflow stores no npm token.

Optionally add a GitHub tag ruleset for `v*` so that only maintainers can create release tags.

## Step 3: First publish through the workflow

Because 0.1.2 is already on the registry, the first publish from the workflow must be a new version chosen for a real reason, not a re-publish to test the setup. When the next release is ready, follow the steps below with that version, and do it within 2 days of creating the trusted publisher. If the 2 days run out first, delete and recreate the trusted publisher.

## Releasing a version

1. In a pull request, set the new `version` in `package.json`. Merge it to `main` once CI passes.
2. Tag the merge commit and push the tag:

   ```sh
   git tag v<version> <commit-on-main>
   git push origin v<version>
   ```

3. Optional rehearsal: run **Actions → Publish → Run workflow**, choose the tag in **Use workflow from**, leave **dry_run** checked.
4. Run the workflow again on the tag with **dry_run** cleared. The `prepare` job verifies and packs; the `publish` job downloads that tarball, checks its SHA-256, and runs `npm publish ./<tarball> --access public --provenance`.

The workflow file used is the one at the selected ref, so the tag must be created after `publish.yml` is on `main`.

### What the workflow refuses

| Situation | Result |
|---|---|
| Tag name is not exactly `v` plus the `package.json` version | `prepare` fails |
| Tag points to a commit that is not on `origin/main` | `prepare` fails |
| Real publish from a branch | `prepare` fails |
| Dry run from a branch other than `main` | `prepare` fails |
| Version already on the registry | `npm publish` fails with a registry error; nothing is retried or bumped |

Runs share one concurrency group and an in-progress run is never cancelled. A later dispatch waits behind it; if several are waiting, GitHub keeps only the newest.

### Permissions

The workflow defaults to `contents: read`. Only the `publish` job has `id-token: write`, and it runs no repository code: it downloads the artifact, verifies the checksum, and publishes. The `prepare` job runs the build and tests without `id-token`. Third-party actions are pinned to commit SHAs; update the pins deliberately and keep the version comment beside each one.
