# Project conventions

- Use pnpm. Keep exact dependency versions and `pnpm-lock.yaml`; do not add npm/yarn locks.
- Query the existing Graphify graph first for code navigation: `graphify query "<question>"`. Verify findings against current source and tests. Regenerate code graphs with `graphify extract . --code-only --no-cluster --max-workers 2 --force` after substantial changes.
- Keep renderer capabilities limited to validated commands in `src/shared.ts` and the typed preload bridge. Native confirmation and protected credential operations belong in Electron main.
- Maintain workspace ownership checks and approval hashes in the backend. Never grant approval through model output or a caller-supplied boolean.
- Do not add direct-provider/BYOK inference, automatic shell approvals, automatic retries after interruption, or unscoped MCP grants.
- Check changes with `pnpm check`, `pnpm test`, and `pnpm build`. Runtime-sensitive changes also require `pnpm mcp:smoke`, `pnpm isolation:smoke`, and `pnpm smoke`. Account-dependent tests must explicitly report unavailable authentication.
- Releases are tag-only. Preserve the user's Docker Compose configuration and unrelated concurrent edits.
