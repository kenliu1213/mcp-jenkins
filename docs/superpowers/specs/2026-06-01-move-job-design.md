# Move job tool — design

**Date:** 2026-06-01
**Status:** Draft (pending user review)
**Target:** `@kud/mcp-jenkins` v2.1.x → adds 38th tool

## Goal

Add a `jenkins_move_job` tool that moves a Jenkins job into a folder (or renames it via a new full path), preserving build history. Use Jenkins native `POST /job/<src>/move?destination=<dest>` semantics.

## Non-goals

- Cross-instance moves (instance param still works per call; tool resolves to one instance).
- Moving items between Jenkins instances.
- A separate "rename only" path — `/move` already handles it via `destination=folder/new-name`.
- Bulk moves (one job per call).

## API surface

### Tool schema (added to `rawTools` in `src/index.ts`)

```ts
{
  name: "jenkins_move_job",
  description: "Move a job to a new folder or rename it, preserving build history. Uses Jenkins POST /job/<src>/move?destination=...",
  inputSchema: {
    type: "object",
    properties: {
      jobName:     { type: "string", description: "Source job path (e.g. 'my-job' or 'folder/sub/my-job')" },
      destination: { type: "string", description: "Target full path (e.g. 'new-folder/my-job' or 'new-folder/renamed-name')" },
      overwrite:   { type: "boolean", description: "Delete the existing job at destination first. Default: false" },
    },
    required: ["jobName", "destination"],
  },
}
```

`instance` is auto-injected by `injectInstance()` (consistent with all other tools).

### Client method (added to `src/lib/jenkins-client.ts`)

```ts
async moveJob(
  jobName: string,
  destination: string,
  overwrite = false,
): Promise<{ from: string; to: string; url: string; renamed: boolean }>
```

- `from` — `jobName` as supplied
- `to` — `destination` as supplied
- `url` — `${this.baseUrl}/job/${jobPath(destination)}`
- `renamed` — `path.basename(jobName) !== path.basename(destination)`

### New error type (added to `Errors` factory in `src/common/errors.ts`)

```ts
destinationConflict: (dest: string) =>
  new McpError("DESTINATION_CONFLICT", `Job already exists at destination: ${dest}`, 409)
```

## Data flow

```
moveJob(src, dest, overwrite):
  1. Short-circuit: if `src === dest` (strict string equality, no normalization —
     path normalization is the caller's responsibility),
     return `{ from: src, to: dest, url: <derived>, renamed: false }` without HTTP calls.

  2. crumb = await this.ensureCrumb()
  3. headers = this.headers() + crumb header (if crumb)

  4. Existence check on destination:
       GET <baseUrl>/job/<jobPath(dest)>/api/json
         200 → destination exists
           if !overwrite → throw destinationConflict(dest)
           if overwrite  → await httpPost(<baseUrl>/job/<jobPath(dest)>/doDelete, { headers })
         404 → destination is free, continue

  5. Perform move:
       POST <baseUrl>/job/<jobPath(src)>/move?destination=<encodeURIComponent(dest)>
         404 → throw jobNotFound(src)
         2xx (typically 302) → success
         other 4xx/5xx → throw unexpected(`Move job failed: HTTP <status>`)

  6. Return { from: src, to: dest, url, renamed }
```

## Error mapping

| Condition | Error |
| --- | --- |
| HTTP 401 on any call | `Errors.authFailed()` (handled by `httpGetJson`/`httpPost`) |
| GET dest → 200 + `overwrite=false` | `Errors.destinationConflict(dest)` (DESTINATION_CONFLICT, 409) |
| GET dest → 200 + `overwrite=true` + DELETE fails | propagate (delete error) |
| POST /move → 404 | `Errors.jobNotFound(src)` |
| POST /move → other 4xx/5xx | `Errors.unexpected("Move job failed: HTTP <n>")` |
| `src === dest` (after trim) | no-op success (no HTTP) |
| Timeout | `Errors.timeout()` (handled by `httpGetJson`/`httpPost`) |

## Files to change

| File | Change |
| --- | --- |
| `src/lib/jenkins-client.ts` | Add `moveJob(src, dest, overwrite?)` after `copyJob` (~35 lines) |
| `src/tools/move-job.ts` | New: `MoveJobInput` interface + 1-line `moveJob` handler (5 lines) |
| `src/index.ts` | Import `moveJob` handler; add entry to `rawTools`; add entry to `toolHandlers` |
| `src/common/errors.ts` | Add `destinationConflict(dest)` to `Errors` factory |
| `test/tools/move-job.test.ts` | New: 3 vitest cases (happy / conflict / overwrite) |
| `README.md` | Add `jenkins_move_job` row to Job Operations table; bump total from 37 → 38 |
| `server.mcp.json` | Optional — `tools[]` is documentation, not enforced; the published tool list is generated at build. Leave for now unless CI lints it. |

`dist/` is a build artifact; rebuild after changes via `npm run build`.

## Testing

Three vitest cases in `test/tools/move-job.test.ts`, mocking `fetch` per the pattern in `test/lib/jenkins-client.test.ts`:

1. **Happy path** — GET dest 404, POST /move 200 → returns `{from, to, url, renamed}`, only 2 HTTP calls (GET + POST, no DELETE).
2. **Conflict (overwrite=false)** — GET dest 200 → throws `DESTINATION_CONFLICT`; POST /move never called.
3. **Overwrite (overwrite=true)** — GET dest 200, DELETE dest 200, POST /move 200 → returns success; verify 3 HTTP calls in order.
4. **No-op short-circuit (bonus)** — `src === dest` returns immediately with 0 HTTP calls.

Mock the crumb response (`/crumbIssuer/api/json`) too — the existing client tests already do this.

## Out of scope / follow-ups

- Folder creation: `/move` will fail if intermediate folders in `destination` don't exist. We don't auto-create. Documented behavior, matches Jenkins.
- Cyclic move prevention (folder into itself): Jenkins rejects natively; we don't pre-check.
- `copyJob` / `renameJob` consistency audit: not in scope for this change.

## Migration / rollout

- Additive change. No existing tool signatures change. SemVer patch-level bump at minimum; minor bump is safer since a new tool is exposed.
- After `npm run build`, the user-level `local-jenkins` MCP in `~/.mcp.json` (which runs `dist/index.js`) automatically picks up the new tool on next restart.
