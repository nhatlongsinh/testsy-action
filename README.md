# Testsy

Check releases, investigate failed runs and preserve regression coverage.

Documentation: https://testsy.dev/docs/mcp/

This action bundles its versioned Node CLI. Use Node 22 or later. Configure `api-key` as a repository secret and either `project` or `tests`. Use it as `uses: nhatlongsinh/testsy-action@v1` (pin a commit SHA in production), or copy this folder to .github/actions/testsy and use `./.github/actions/testsy` after checkout. `junit` defaults to testsy-junit.xml. For a conclusive release gate set `fail-on: failed,error,blocked,inconclusive,cancelled`.

CLI: `node bin/testsy.mjs version`, then `node bin/testsy.mjs run --project p_yourproject --junit testsy-junit.xml` with QA_AI_API_KEY securely set.

This is an integration package prepared for local testing. A directory listing or live-client validation is not implied. Keep API keys out of prompts and version control. Runs use the workspace allowance and perform the test's actions. MIT applies to these integration files only.
