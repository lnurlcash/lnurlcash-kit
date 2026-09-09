# Releasing lnurlcash-kit

Releases run through [forgesworn/anvil](https://github.com/forgesworn/anvil), a
hardened npm publish workflow. Once it is set up, a release is OIDC trusted
publishing with no npm token in the repo, a SLSA provenance attestation, a
secret scan over the exact files being published, an exports check, an
action-pin audit, and a two-runner reproducible-build attestation.

You control the version. Bump `package.json`, add the CHANGELOG entry, cut the
release; anvil does the rest.

## First publish, a one-time bootstrap

npm's trusted-publisher flow needs the package to already exist on the
registry, and OIDC cannot create a new one ([npm/cli#8544][issue]). So the very
first publish is a manual one from your machine. It is the only time a token is
involved.

The seed is a **prerelease on the `next` tag**, not the real version:

```bash
npm version 0.1.0-next.0 --no-git-tag-version
npm publish --tag next --no-provenance
git checkout -- package.json package-lock.json
```

Three things that matter here:

- `--no-provenance` is required. Provenance can only be generated inside CI,
  where the OIDC token exists; with `publishConfig.provenance: true` set, a
  local publish without this flag fails.
- `--tag next` keeps the seed off `latest`, so nothing installs the
  unattested bootstrap version by accident.
- Seeding a *prerelease* leaves `0.1.0` itself unclaimed, so anvil publishes
  the real first version with full provenance. Every version anyone actually
  installs is attested. (Seeding `0.1.0` directly would burn that version and
  force the debut release to be a patch.)

Do not create a GitHub Release for the seed. Once the real `0.1.0` is out, tidy
up:

```bash
npm dist-tag rm lnurlcash-kit next
npm deprecate lnurlcash-kit@0.1.0-next.0 "bootstrap seed - use 0.1.0 or later"
```

[issue]: https://github.com/npm/cli/issues/8544

## Set up trusted publishing (one-off, on npmjs.com)

After the seed exists, wire OIDC so no token is ever needed again.

1. npmjs.com, the package, Settings, Trusted Publisher.
2. Add a GitHub Actions publisher:
   - Repository: `lnurlcash/lnurlcash-kit`
   - Workflow filename: `release.yml` — **this repo's caller**, not anvil's
     reusable workflow. npm matches the OIDC `workflow_ref` claim, which names
     the caller; pointing it at anvil fails with a misleading "package not
     found" from the token exchange.
   - Environment: `npm-publish`
3. Then turn on "require 2FA and disallow tokens" for the package, so the only
   route to publish is this workflow. The bootstrap token can be revoked.

**If the repository ever moves** - renamed, or transferred to another owner -
this has to be changed to match, before the next release. npm matches the OIDC
claim against the repository as it is named NOW, GitHub's redirect does not
apply to it, and a stale entry fails as `npm error 404 ... could not be found
or you do not have permission to access it` on the publish step. That reads
like a missing package rather than a rejected token, so it is worth checking
here first.

## Every release after the first

1. Bump `version` in `package.json`.
2. Add a `## x.y.z` section to `CHANGELOG.md`; anvil puts it in the release body.
3. Commit and push to `main`.
4. Cut the release:

   ```bash
   gh release create v0.1.0 --title v0.1.0 --notes-from-tag
   ```

   The `release: published` event fires `release.yml`, which runs anvil's gates,
   the two-runner reproducible build, then an OIDC-authenticated publish and a
   release-body update carrying the tarball hashes.

You can also publish a specific tag by hand from Actions, Release, Run workflow.

## What anvil enforces before it publishes

Tests, a runtime-only `npm audit`, an exports-map check that every subpath in
`package.json` exists on disk, a secret scan over the pack set, an action-pin
audit (strict: every `uses:` in `.github/workflows` must be SHA-pinned), a
lifecycle-script policy (strict: no `preinstall`/`install`/`postinstall` hooks
ship to consumers), and a byte-identical build across two independent runners.
Any failure blocks the publish.

`prepare: npm run build` is present so the package also installs straight from
git; it is not an install hook and does not run on consumers of the published
tarball.
