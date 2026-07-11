# Branch protection setup (not yet applied)

Generated during the /oss-1-repo-build pipeline. Apply when ready to make this repo public or
once collaborators are added — not applied automatically per this pipeline's default.

## Via GitHub CLI

```bash
gh api repos/RudrenduPaul/teamspend/branches/main/protection \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -f "required_status_checks[strict]=true" \
  -f "required_status_checks[contexts][]=test (18.x)" \
  -f "required_status_checks[contexts][]=test (20.x)" \
  -f "required_status_checks[contexts][]=test (22.x)" \
  -F "enforce_admins=true" \
  -F "required_pull_request_reviews[required_approving_review_count]=1" \
  -F "restrictions=null" \
  -F "allow_force_pushes=false" \
  -F "allow_deletions=false"
```

## Via GitHub Settings UI

1. Go to Settings -> Branches -> Add branch protection rule
2. Branch name pattern: `main`
3. Enable: "Require a pull request before merging" (1 approving review)
4. Enable: "Require status checks to pass before merging"
   - Search for and require: `test (18.x)`, `test (20.x)`, `test (22.x)` (from `.github/workflows/ci.yml`)
5. Enable: "Require branches to be up to date before merging"
6. Enable: "Do not allow bypassing the above settings" (applies to admins too)
7. Disable: "Allow force pushes"
8. Disable: "Allow deletions"

## What this changes

Once applied, direct pushes to `main` (including from the repo owner) will be blocked; all
changes go through a PR with a green CI run. This is a deliberate workflow change from the
direct-to-main commits made during this build, appropriate once the repo goes public or gets
a second contributor.
