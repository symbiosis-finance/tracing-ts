Publish the package to JSR. Run all steps sequentially, stopping on any failure.

## 1. Run tests

Run `deno task test`. If tests fail, stop and report the failures.

## 2. Check version bump

Read `deno.jsonc` to get the current version. Get the latest git tag with `git describe --tags --abbrev=0`. Compare them:
- If the version in `deno.jsonc` is already ahead of the latest tag (e.g., tag is `v1.0.2` and version is `1.0.3`), skip to step 3.
- If the version matches the tag, ask the user what kind of bump to apply (patch/minor/major). Apply the bump by editing `deno.jsonc`, then commit with message "Bump version to X.Y.Z" and push.

## 3. Tag and push

Create a git tag `vX.Y.Z` matching the version in `deno.jsonc` and push it:
```
git tag vX.Y.Z && git push origin vX.Y.Z
```

## 4. Wait for CI

Wait for both GitHub Actions workflows triggered by the push/tag to complete:
```
gh run list --limit 5
```

Watch the "Publish to JSR" run specifically:
```
gh run watch <run-id>
```

If either workflow fails, report the failure and stop.

## 5. Verify on JSR

Fetch the package metadata from JSR to confirm the version is published:
```
curl -s https://api.jsr.io/scopes/symbiosis-finance/packages/tracing | python3 -m json.tool
```

Check that the new version appears in the response. Report the final status with a link to `https://jsr.io/@symbiosis-finance/tracing`.
