# Graph Report - agentic-tooling  (2026-10-29)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 307 nodes · 696 edges · 14 communities (12 shown, 2 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `4a40bf75`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13

## God Nodes (most connected - your core abstractions)
1. `Service` - 26 edges
2. `Store` - 16 edges
3. `App()` - 16 edges
4. `git()` - 14 edges
5. `scripts` - 13 edges
6. `compilerOptions` - 13 edges
7. `safePath()` - 12 edges
8. `main()` - 11 edges
9. `DesktopAPI` - 11 edges
10. `Graphify` - 10 edges

## Surprising Connections (you probably didn't know these)
- `repo()` --calls--> `git()`  [EXTRACTED]
  tests/core.test.ts → electron/core/git.ts
- `Service` --references--> `Snapshot`  [EXTRACTED]
  electron/core/service.ts → src/shared.ts
- `main()` --calls--> `Headroom`  [EXTRACTED]
  electron/copilot-worker.ts → electron/core/headroom.ts
- `instructions()` --calls--> `safePath()`  [EXTRACTED]
  electron/core/agents.ts → electron/core/policy.ts
- `discover()` --calls--> `safePath()`  [EXTRACTED]
  electron/core/agents.ts → electron/core/policy.ts

## Import Cycles
- None detected.

## Communities (14 total, 2 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.10
Nodes (34): discover(), instructions(), walk(), resolveAgent(), hash(), Host, Table, tables (+26 more)

### Community 1 - "Community 1"
Cohesion: 0.11
Nodes (24): abort, active(), approvals, client, confirm(), isolatedSession, main(), send() (+16 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (33): author, dependencies, electron-updater, @github/copilot-sdk, react, react-dom, yaml, zod (+25 more)

### Community 3 - "Community 3"
Cohesion: 0.09
Nodes (15): pending, service, boot(), changed(), confirm(), pending, request(), shutdown() (+7 more)

### Community 4 - "Community 4"
Cohesion: 0.20
Nodes (11): Job, baseline(), git(), repository(), snapshotChanges(), worktree(), prerequisiteOrder(), validateDag() (+3 more)

### Community 5 - "Community 5"
Cohesion: 0.21
Nodes (24): react, react-dom, Agents(), App(), AttemptDetails(), Badge(), blankAgent, Button() (+16 more)

### Community 6 - "Community 6"
Cohesion: 0.13
Nodes (12): checkHeadroom(), CompressionObservation, Headroom, headroomUrl(), request(), responseSchema, playwright, job (+4 more)

### Community 7 - "Community 7"
Cohesion: 0.13
Nodes (15): devDependencies, electron, electron-builder, esbuild, playwright, prettier, tailwindcss, @tailwindcss/vite (+7 more)

### Community 8 - "Community 8"
Cohesion: 0.13
Nodes (14): compilerOptions, allowImportingTsExtensions, esModuleInterop, jsx, lib, module, moduleResolution, noEmit (+6 more)

### Community 9 - "Community 9"
Cohesion: 0.14
Nodes (14): build, appId, asarUnpack, directories, files, nsis, productName, publish (+6 more)

### Community 10 - "Community 10"
Cohesion: 0.15
Nodes (13): scripts, build, capabilities, check, dev, format, isolation:smoke, mcp:smoke (+5 more)

### Community 12 - "Community 12"
Cohesion: 0.50
Nodes (3): printWidth, singleQuote, trailingComma

## Knowledge Gaps
- **108 isolated node(s):** `singleQuote`, `trailingComma`, `printWidth`, `pending`, `service` (+103 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 131 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `zod` connect `Community 1` to `Community 0`, `Community 2`, `Community 6`?**
  _High betweenness centrality (0.131) - this node is a cross-community bridge._
- **What connects `singleQuote`, `trailingComma`, `printWidth` to the rest of the system?**
  _108 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.10299003322259136 - nodes in this community are weakly interconnected._
- **Why does `@github/copilot-sdk` connect `Community 1` to `Community 0`, `Community 2`?**
  _High betweenness centrality (0.092) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.11219512195121951 - nodes in this community are weakly interconnected._
- **Why does `devDependencies` connect `Community 7` to `Community 2`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.05855855855855856 - nodes in this community are weakly interconnected._