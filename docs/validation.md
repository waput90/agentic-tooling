# Implementation and validation record

Checked on October 29, 2026. This is a working desktop implementation with an installer; the original plan's account-dependent acceptance matrix is not fully signed off.

## Versions

| Component                           | Pinned version                                             |
| ----------------------------------- | ---------------------------------------------------------- |
| pnpm                                | 11.22.0                                                    |
| Electron                            | 45.1.0                                                     |
| GitHub Copilot SDK                  | 1.0.28                                                     |
| Bundled Copilot runtime             | 1.0.105, protocol 3                                        |
| React                               | 19.3.1                                                     |
| Vite                                | 8.3.5                                                      |
| Tailwind + official Vite plugin     | 4.3.3                                                      |
| TypeScript                          | 7.0.2                                                      |
| electron-builder / electron-updater | 26.18.0 / 6.8.11                                           |
| Graphify fallback installation      | graphifyy 0.9.76                                           |
| SQLite                              | Electron/Node `node:sqlite`, no separate native driver ABI |

The plan proposed better-sqlite3/Drizzle. This implementation uses the bundled Node SQLite driver in a dedicated backend worker, versioned SQL schema initialization, WAL, foreign keys, transactional writes, and SQLite's backup API. Stored workspace records are JSON documents with indexed ownership rather than the plan's fully normalized table-per-entity schema. Run/attempt/plan relationships are additionally checked by the service.

## Verified

| Check                            | Evidence                                                                                                                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type safety and production build | `pnpm check`, `pnpm build` pass                                                                                                                                                                                                    |
| Core integration tests           | `pnpm test`: 17 tests, all pass                                                                                                                                                                                                    |
| Approval enforcement             | Direct unapproved dispatch and mismatched hashes rejected; changed instructions invalidate approval                                                                                                                                |
| Ownership                        | Cross-workspace reads, rewrites, invalid foreign keys, and MCP binding attempts rejected                                                                                                                                           |
| Agent resolution                 | Repository precedence, per-role fallback, explicit custom override, model inheritance, unavailable models, duplicate definition errors                                                                                             |
| Scheduling                       | Two repository queues overlap within the global cap; dependencies and transitive file handoffs preserved; failures block descendants; cancellation prevents queued dispatch                                                        |
| Filesystem boundary              | Traversal, protected paths, junction/symlink escapes rejected; independent Git worktree changes leave the source checkout untouched                                                                                                |
| Recovery and backup              | Database backup round trip; restart marks unfinished attempts interrupted and partial rather than replaying them                                                                                                                   |
| Usage                            | Event replay deduplication, requested/reported model separation, missing counters, subset arithmetic, context-window exclusion                                                                                                     |
| Portability                      | Known-secret redaction; workflow dependency round trip; fresh ID mappings; disabled imported connections, archived agents, explicit destination context, no imported approvals                                                     |
| Update admission gate            | Queued work blocks silent update; successful idle preparation fences new work                                                                                                                                                      |
| Actual Copilot runtime startup   | Bundled version and protocol match the SDK package metadata                                                                                                                                                                        |
| Actual stdio MCP                 | Local fixture connects and lists its tool through the bundled runtime, no inference                                                                                                                                                |
| Actual HTTP MCP                  | Local authenticated HTTP fixture: valid key succeeds, invalid key fails, secret absent from diagnostics                                                                                                                            |
| Actual runtime isolation         | Two concurrent runtimes use distinct CWD/session IDs and distinct connected MCP servers; selected custom agent is the sole discovered agent despite a conflicting repository profile; session.start captured before create returns |
| Electron development smoke       | Sandboxed renderer without Node, typed IPC, SQLite, navigation, persistent theme, rejected foreign-workspace execution, screenshot                                                                                                 |
| Packaged executable smoke        | Same UI checks plus bundled Copilot runtime discovery pass without a development runtime path                                                                                                                                      |
| Graphify                         | Existing graph reuse and corrupt graph handling tested; this project's code graph generated and queried using installed Graphify                                                                                                   |
| Production dependency audit      | `pnpm audit --prod`: no known vulnerabilities at verification time                                                                                                                                                                 |

The SDK retains a **disabled** `github` MCP inventory entry even after `removeGitHub`; it was not connected in the isolation test. Only each explicitly configured fixture was connected. Tool allowlists exclude undeclared tools and delegation.

Direct runtime tool invocation also verifies that the approved read fixture executes while the excluded write fixture never executes. This test does not need model inference. The two runtimes use identically named MCP connections with different tools, verifying that names alone do not mix their configurations. The Electron smoke additionally verifies an async OS-secret encryption/decryption round trip and a backup through the actual desktop IPC path.

## Important runtime findings incorporated

1. SDK 1.0.28's `mode: empty` forces `COPILOT_DISABLE_KEYTAR=1`. The app uses CLI credential mode for the OS-backed credential owner and explicitly disables config discovery, skills, hooks, memory, embeddings, shared session history, native Git context, and default GitHub MCP access. Available tools are explicit; SDK tool-filter precedence remains deny-wins in either mode.
2. Electron native subprocesses cannot execute through an ASAR virtual path. Packaged sessions select the bundled executable under `app.asar.unpacked` explicitly. The initial packaged smoke found this problem; the corrected packaged smoke passes.
3. On Windows, executable resolution can search the repository CWD. Git/Graphify/Python helpers resolve absolute PATH entries first. Python environment installation runs with `-I` from application-owned tool storage; opening a repository cannot substitute its local `venv.py` or `pip.py`.
4. Three-stage dependency chains require replaying all ancestor task changes, once each, in topological order. A direct-predecessor-only implementation lost earlier changes; the transitive handoff test now covers this.
5. SDK custom tools request permission too, and generic names such as `read_file` can collide with runtime built-ins. App tools use an `agentic_` wire namespace. The permission callback admits only approved app handlers; planning admits only bounded read/list/graph handlers. Commands ask separately inside their handler, and selected MCP calls require native confirmation. The direct runtime fixture caught and verified both issues.
6. Electron's asynchronous decryption API returns `{ result, shouldReEncrypt }`, not a string. The main-process secret adapter extracts `result`; the native smoke verifies that the original value is recovered.

## Acceptance checks still requiring a real account or deployment

- Copilot currently reports **Not authenticated**. Real two-model inference, model/tool permission behavior during model-generated work, cancellation during an inference call, and actual token/compaction event accounting are not live-verified. The capability script offers an explicit `--inference` mode after sign-in.
- The GitHub browser sign-in path is implemented against pinned runtime APIs but has not completed interactive consent here. Third-party OAuth consent, rejection, expiry, refresh, cross-login callback behavior, and Figma client acceptance require real provider accounts and remain unverified. Runtime-owned OAuth logout is not exposed; the UI explicitly clears only app-owned secrets.
- The NSIS installer builds, and its unpacked application passes startup checks. Actual installer execution, an upgrade from a previous installed release, signed distribution, and updater download/install delivery are not verified. No remote release or tag was created during implementation.
- Git, Python/Graphify, and any configured local MCP executable remain host requirements. The app bundles Node/Electron and Copilot, not arbitrary external tools. Missing-Graphify installation code is implemented; this machine already had Graphify, so a clean-machine Python/venv installation still needs acceptance testing.

## Remaining differences from the complete roadmap

- Structured planning proposals can become draft workflows with schema/DAG validation. A malformed/prose model response requires manual composition in Workflows; model output can never approve a draft.
- Root and nested repository instruction files are supplied with scope/provenance; the app does not implement the full native Copilot profile schema, arbitrary hooks, or automatic repository-defined MCP execution. Unsupported profiles fail visibly.
- Usage records cover observed call events; there is no recovery of missing ephemeral counters, provider billing dashboard, or automatic reconciliation with a final cumulative provider checkpoint.
- Event reads are paginated and history cleanup is available, but the dashboard snapshot is intended for local workloads and has not been stress-tested against millions of observations.
- Database backups retain inline evidence but do not archive repositories/worktrees. Definitions are portable; worktree recovery depends on existing filesystem paths.
- Tray minimization, notifications, and alternative desktop platforms are not included; closing the app explicitly quits and handles active work.

These items are not represented as completed acceptance criteria. The core implementation is useful now, while the full original roadmap still requires the live checks and refinements above.

## Sources used to verify interfaces

- [Copilot SDK custom agents](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents)
- [Copilot SDK events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
- [Copilot SDK MCP lifecycle](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/mcp)
- [Copilot authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Tailwind's Vite integration](https://tailwindcss.com/docs/installation/using-vite)
- [Figma remote MCP restrictions](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)

Installed SDK type declarations and implementation were also inspected. The lockfile and runtime smoke results, rather than assumptions from current web documentation alone, determine the shipped interfaces.
