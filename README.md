# Agentic Tooling

A Windows Electron application for running independent GitHub Copilot workflows across local repositories. Each workspace has its own plans, approval records, context, MCP bindings, attempts, and usage ledger.

## Run locally

Requirements: Node.js 24 or newer, pnpm 11.22.0, Git, and an eligible GitHub Copilot account. Python 3.10+ is needed only when Graphify is not already installed.

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

The production application bundles Electron and the compatible Copilot runtime; it does not need a separate Node.js or Copilot CLI installation. Git and Graphify/Python remain host prerequisites. No direct model-provider keys or alternate inference endpoints are supported.

1. Open **Settings**, sign in with GitHub, and check the available models.
2. Add a Git repository with at least one commit. Graphify checks run automatically.
3. In **Agents**, create a `planner` with read tools and a `developer` with file-writing tools. Select an account-available model for each.
4. Select a workspace and set its default model for repository profiles that omit `model`.
5. Start a read-only planning request from Overview. Read the result in Runs and use **Create workflow draft from this plan** for structured responses. The generated draft has no approval.
6. In Workflows, enter one question, choose the agents, and select sequential or parallel execution. Preview the resolved agents and tasks. Use the advanced editor when each task needs different instructions or dependencies.
7. Approve the exact scope in the native desktop confirmation, then start execution.
8. Inspect each attempt's output, context, events, and diff. Integrate successful results with a separate confirmation.

Repository agents in `.github/agents/*.agent.md` win per matching `role` (or `name` when role is absent). Absent roles fall back to custom agents. Unsupported tools, invalid YAML, duplicate identities, unavailable models, and repository-provided hooks/MCP definitions produce errors. Configure tool access in the app. An explicit custom override is also available.

## Graphify

Adding or selecting a workspace checks `graphify-out/graph.json` in that repository. Valid graphs are reused. If missing, the app locates Graphify on the absolute system PATH, or installs pinned `graphifyy==0.9.76` into an isolated environment under application data using Python. It then runs:

```text
graphify extract <repository> --code-only --no-cluster --max-workers 2
```

The graph is written inside the selected repository, never a global combined graph. Indexing does not use an external LLM. Progress and failures appear on the workspace card. Corrupt existing graphs require an explicit **Rebuild graph** action. No Git hooks are installed. Add `graphify-out/` to your repository's `.gitignore` if you do not want to commit generated graphs. Agent `graph_query` searches the graph before source inspection; source remains authoritative. Documentation/image/video semantic extraction is outside the automatic indexing path.

## Execution and data boundaries

- Planning has only the app's bounded read/list/graph tools; shell, writes, and MCP are absent.
- Execution requires a backend-recorded approval with a native human confirmation. IPC cannot forge an approval record. Hashes freeze the repository base, resolved agents, models, instructions, dependencies, context, MCP definitions, and limits.
- Workflow drafts can be saved with uncommitted repository changes. Git checkouts must be clean before approval and execution (generated Graphify output is excluded). Stashing changes preserves the committed base; committing changes requires a fresh draft and approval for the new base. Independent tasks use detached worktrees under app data. Dependency commits and selected results are explicitly carried forward.
- Commands require an additional confirmation showing the exact executable, arguments, and CWD. They run with the user's OS permissions. This application is **not an OS sandbox**. Only approve commands and MCP servers you trust. In particular, project test scripts can perform arbitrary actions.
- File tools reject traversal, protected paths, and symlinks escaping the approved worktree. Native discovery, repository hooks, undeclared delegation, skills, and shared session history are explicitly disabled in each session. The SDK's CLI credential mode retains OS keychain support; its `empty` mode forcibly disables that support in this release.
- Each attempt has its own worker and Copilot runtime process. Account selection and runtime-owned credentials share an application identity directory; explicit session configuration determines workspace tool access. There is no implicit cross-workspace conversation sharing.
- Restart classifies queued/running work as interrupted. No uncertain side effect is automatically repeated. To retry, review the existing worktree and create a fresh approved workflow.
- Cancel stops admissions and asks active sessions to abort; completed effects remain. Pause stops admitting tasks, while in-flight calls may finish.
- Drafts in Approvals can be edited before approval: choose agents, add or reorder steps, edit instructions, and set dependencies. Saving creates a new draft and hash, and retires the previous draft. Runs shows each agent's task, model, and live status, with an animated working icon while an attempt is running.
- Usage stores reported call deltas by attempt/event ID. Unknown counters stay null. Context-window occupancy is not token consumption, and reasoning/cache subsets are not added to input/output totals. Parallel calls can overshoot a dispatch threshold. At the threshold, the run pauses and shows an alert; a native confirmation lets the remaining tasks continue without that threshold.

SQLite runs in a dedicated backend worker with WAL, foreign keys, transactions, migrations, and a consistent backup operation. Database files live in Electron's user-data directory, normally `%APPDATA%/agentic-tooling`. Database backups include inline diffs, events, context, and encrypted secret records; they do not copy the repository or worktree directories. Restore preserves a `before-restore.sqlite` snapshot and restarts without resuming work. Keep repositories/worktrees separately when migrating machines. OS-encrypted secrets may not decrypt for another OS account.

Context can be summarized with the planner agent; the read-only attempt, reported usage, input snapshot, and resulting handoff provenance are saved. Usage filters persist per workspace. Runs, Approvals, and Usage are paginated and have reviewed delete actions. Deleting completed run history removes attempts, events, and usage while retaining a run identity to prevent replay; unintegrated results must be handled first. Plans that have run remain as hidden audit records. Settings shows database size and offers a reviewed retention action: only old successful runs with integrated/no-change results qualify. Detail is pruned while run identities remain to prevent accidental replay. Runs referenced by context provenance are retained. Source/worktree files are never deleted by history cleanup.

Definition exports include custom agents, workflow templates, context, and inert MCP configurations with credentials omitted and known secret values redacted. Import creates fresh IDs and preserves a mapping, archives agents, and disables connections. Select a workspace before import to explicitly map context and connection definitions to that workspace. Without a selected workspace, only global agents and workflow templates are imported. Imported workflows appear in the workflow template selector and require fresh agent resolution and approval.

## Optional Headroom compression

Settings includes **Headroom context compression**, disabled by default. If Headroom is already installed, start its local service with `headroom proxy --port 8787`. Set the local URL (default `http://127.0.0.1:8787`), click **Check Headroom**, enable it, and save. The app verifies the compression API before enabling; it does not install or launch Headroom automatically. See the [official Headroom setup guide](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/quickstart.mdx) if it is not installed.

The existing `docker-compose.yml` also exposes the Headroom proxy on local port 8787. Its MCP port 8788 is a separate integration; use the proxy port for these Settings controls.

This integration calls only Headroom's local `/v1/compress` endpoint for large file reads, directory listings, and Graphify results. It does not route Copilot authentication or inference through Headroom, compress instructions, or intercept MCP/command outputs. The threshold and timeout are configurable. The app accepts only loopback base URLs and rejects redirects. The Headroom server's own configuration controls how it processes data.

Configuration is frozen into each new plan's approval scope. Changing it invalidates existing approvals; create a fresh draft. On a failed request the attempt continues with original results and skips further compression calls. Compressed results instruct the agent to use `raw=true` on the same read tool when original details are needed. Run events record `headroom.compression` observations and Headroom token estimates separately from actual Copilot usage. Savings depend on the content; no fixed reduction is promised.

## MCP and authentication

Local executable/argument-array and remote HTTPS/loopback HTTP definitions are workspace-scoped. Save does not launch them. Disabled connections can be enabled again, and removal unbinds them from custom agents and invalidates approvals. Test explicitly starts a short-lived probe and lists tools; its diagnostic contains the observed state. OAuth authentication also checks that a separate session can use the saved grant. After a successful probe closes, Connections shows **verified** with its last check time and detected tools. This records observed availability; approved attempts open their own connections and check the required tools again before sending a prompt.

Bearer/API-key values are encrypted with Electron asynchronous `safeStorage`. Runtime-managed MCP OAuth uses persistent OS credential storage. **Authenticate** requests fresh OAuth consent when a cached grant is stuck. The app keeps the runtime alive while browser consent finishes; cancellation, timeout, and connection errors are surfaced. Clearing an **app secret** removes the app-owned encrypted record. Runtime OAuth grants are owned by Copilot and are not removed by that button; revoke those at the provider/runtime. No wildcard MCP grants are accepted. Select individual tools after testing. A connection can be bound to a custom agent, or explicitly shared with every agent in the same workspace, including repository agents. Enabling workspace sharing requires native confirmation and a successful probe of the selected tools. Changes invalidate existing approvals; create a fresh workflow to use the new scope. Read-only planning sessions do not receive MCP tools. MCP tool calls in execution still require separate confirmation.

[Figma's remote MCP server](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/) currently admits clients in its supported catalog; Agentic Tooling is not listed, so a browser consent screen alone does not prove this app can use the grant. Connections provides a [Figma desktop server](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/) preset at `http://127.0.0.1:3845/mcp` using HTTP without OAuth. Turn on the desktop MCP server inside the Figma desktop app, test the preset, select individual tools, then enable and bind it to an agent. The desktop server requires an eligible seat and has fewer features than the remote server. Neither path has been live-verified with a Figma account here. The local stdio fixture is verified; see [validation and remaining acceptance checks](docs/validation.md).

## Build, verify, and package

```powershell
pnpm check
pnpm test
pnpm build
pnpm smoke
pnpm mcp:smoke
pnpm capabilities
pnpm package
```

`pnpm capabilities` starts the bundled runtime and checks authentication/models without inference. After sign-in, `pnpm capabilities --inference` explicitly sends short prompts using two available models and reports startup/usage observations. These calls consume Copilot usage.

Installer output: `release/Agentic Tooling Setup <version>.exe`. The installer is unsigned unless a signing certificate is supplied. `pnpm format` formats maintained source; generated output is excluded.

## Automatic releases and silent updates

`.github/workflows/release.yml` runs on pushed **version tags** such as `v0.1.1`, and on manual dispatch with an explicit version. It uses that tag/input as the installer version, installs from the pnpm lockfile, tests, builds the NSIS installer, smoke-tests the packaged executable, and publishes the installer, blockmap, and `latest.yml` to a GitHub Release only after checks pass. Ordinary branch pushes do not publish releases. Push a higher stable version tag for each update; no version-bump commit loop is needed.

The configured feed is `waput90/agentic-tooling`. Enable GitHub Actions with `contents: write` permission. The release assets must be readable by installed clients; private repositories need a separately configured authenticated/public update distribution service. Never embed a repository token in the application. Optional signing secrets are `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`.

Installed builds check after startup and every four hours, download in the background, and install silently on exit or after the app becomes idle. Queued, active, and paused workflows, Graphify jobs, and pending confirmation dialogs block an idle restart. User data is stored separately from installation files and survives upgrades. Development runs do not download updates.

No release was published and no update delivery has been verified in this checkout. A real previous-version-to-next-version test requires published assets and an installed copy.

## Project structure

```text
electron/main.ts              Native window, trusted IPC, secret storage, updater
electron/preload.ts           Narrow typed renderer bridge
electron/backend.ts           Dedicated SQLite writer and orchestration worker
electron/copilot-worker.ts    One isolated runtime worker per attempt/probe
electron/core/                Approval policy, agents, scheduler, Git, Graphify, ledger
src/                         React dashboard and shared validated commands
tests/                       Policy, persistence, isolation, and scheduling tests
scripts/                     Build, runtime capability, MCP, and Electron smoke tools
docs/                        Validation and compatibility notes
```
