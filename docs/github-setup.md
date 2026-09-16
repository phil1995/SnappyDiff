# GitHub App and Actions setup

Create a distinct GitHub App for staging and production. Configure the callback/installation URL for the corresponding SnappyDiff origin and set the webhook URL to `/webhooks/github`.

## Minimum repository permissions

- Checks: read and write
- Contents: read (commit/branch state only; SnappyDiff does not read repository file contents)
- Metadata: read
- Pull requests: read

Subscribe to `installation`, `installation_repositories`, `pull_request`, and `push`. Record the final permission/event inventory in the Milestone 0 validation evidence before enabling the App for customer repositories.

Store the App private key and webhook secret as `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` Worker secrets. The Worker exchanges its short-lived App JWT for an installation token; installation tokens are never persisted.

After installing the App, an organization administrator calls the project installation-link endpoint with the numeric installation ID. The Worker verifies through GitHub that the installation can access the project's exact repository before persisting the tenant mapping.

## GitHub Actions OIDC

The workflow needs no stored SnappyDiff token:

```yaml
permissions:
  contents: read
  id-token: write
  checks: read

steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
  - name: Upload snapshots
    env:
      SNAPPYDIFF_ENDPOINT: https://staging.example.invalid
      SNAPPYDIFF_PROJECT: prj_replace_me
      SNAPPYDIFF_OIDC_AUDIENCE: snappydiff-staging
    run: snappydiff upload ./Snapshots --commit "$GITHUB_SHA" --branch "$GITHUB_REF_NAME"
```

The CLI requests a GitHub OIDC token for the environment-specific audience and exchanges it for a signed, 15-minute SnappyDiff credential. The Worker verifies the JWT signature, issuer, audience, expiry, repository, workflow run identity, and project/installation mapping. For pull requests it queries the installed repository to classify the head as first-party or fork-origin; fork credentials can create only isolated runs.

## Check delivery

Check delivery is a durable outbox job. Each check has desired/delivered versions, an external ID used to reconcile ambiguous creates, and a PR/commit scope owner. A late job exits without delivery when it no longer owns that scope, preventing an older attempt from overwriting the current result.

No provider configuration in this repository is live. Complete the OIDC claims, fork restriction, event delivery, branch refresh, and Checks API gates in `provider-validation.md` with disposable resources before enabling staging.
