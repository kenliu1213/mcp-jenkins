# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Jenkins MCP server (stdio transport) — `@kud/mcp-jenkins`, 37 tools. Source in `src/`, single compiled entry `dist/index.js`.

## Commands

| Script | Use |
| --- | --- |
| `npm run dev` | Run from source via `tsx` (no build step) |
| `npm run build` | Compile to `dist/` — required before `npm start` or before user-level `~/.mcp.json` picks up changes |
| `npm run build:watch` | Rebuild on save during development |
| `npm start` | Run compiled `dist/index.js` |
| `npm run typecheck` | `tsc --noEmit` — fast type-only check |
| `npm run test` | `vitest run` — single pass |
| `npm run test:watch` | `vitest` — interactive watch |
| `npm run test:coverage` | v8 coverage report |
| `npm run inspect:dev` | MCP Inspector against source (http://localhost:5173) |
| `npm run inspect` | Inspector against compiled `dist/index.js` |
| `npm run clean` | Wipe `dist/` |

Run a single test: `npx vitest run test/tools/get-job-status.test.ts`.

When editing tools that affect the running MCP, the user-level `local-jenkins` entry in `~/.mcp.json` runs `dist/index.js` — `npm run build` is required to make new source changes visible to that MCP.

## Architecture

Three layers, top-down:

1. **`src/index.ts`** — MCP server entry. Owns the `Map<instanceName, JenkinsClient>`, parses CLI, registers `rawTools` (schema list) and `toolHandlers` (function map). Stdio transport via `@modelcontextprotocol/sdk`.
2. **`src/tools/*.ts`** — 37 thin handlers, one file per tool. Signature: `(client: JenkinsClient, input) => result`. No HTTP, no auth logic — just shape the call and return data.
3. **`src/lib/jenkins-client.ts`** — Single class wrapping the Jenkins REST API. Handles auth header construction, CSRF crumbs, session cookies, response normalization, and 401/404 → typed errors.

Shared cross-cutting utilities in `src/common/`:
- `env.ts` — CLI + `MCP_JENKINS_*` env parsing, multi-instance map construction
- `http.ts` — `httpGetJson` / `httpGetText` / `httpPost` thin wrappers over native `fetch` with `AbortController` timeout (default 10s)
- `errors.ts` — `Errors` factory (`authFailed`, `jobNotFound`, `timeout`, …) and `McpError` class
- `logger.ts` — JSON-line logger that writes to **`console.error` (stderr only)** — stdout is the MCP transport, any `console.log` here corrupts the protocol

## Adding a new tool

1. Create `src/tools/my-tool.ts`:
   ```ts
   import { JenkinsClient } from '../lib/jenkins-client.js';
   export interface MyToolInput { ... }
   export const myTool = async (client: JenkinsClient, input: MyToolInput) => { ... };
   ```
2. Add the corresponding API method to `JenkinsClient` in `src/lib/jenkins-client.ts` (this is where HTTP/auth/error mapping lives).
3. Register in **both** `rawTools` (MCP schema) and `toolHandlers` (function map) in `src/index.ts` — easy to forget one.
4. `npm run build` and ideally add a vitest under `test/tools/`.

`injectInstance()` (in `src/index.ts`) auto-prepends an `instance` string param to every tool's schema, so tool inputs don't need to declare it.

## Multi-instance model

One MCP server can target multiple Jenkins instances. They're built at startup into a `Map<name, JenkinsClient>` and the tool call's optional `instance` param picks one.

- `MCP_JENKINS_URL` accepts comma-separated (or `|`) URLs. Count of `MCP_JENKINS_URL` values must equal count of `MCP_JENKINS_INSTANCES` if provided; otherwise names default to first hostname segment.
- First instance is always the default — when no `instance` param is given, that one is used.
- `MCP_JENKINS_USER` / `MCP_JENKINS_API_TOKEN` / `MCP_JENKINS_BEARER_TOKEN` / `MCP_JENKINS_ANONYMOUS` accept positional comma-separated values matching URL order; missing values fall back to index 0.
- Auth modes: Basic (`--user` + `--api-token`), Bearer (`--bearer-token`), or Anonymous (`--anonymous` / `MCP_JENKINS_ANONYMOUS=true`) for no-auth Jenkins. Exactly one of these three is required per instance.
- CLI args override env vars. `parseCliArgs()` is the source of truth.

## Tool filtering

- `MCP_JENKINS_ALLOW_TOOLS` — allowlist; only listed tools are exposed
- `MCP_JENKINS_BLOCK_TOOLS` — blocklist
- If both set, allowlist wins. Applied at startup before `injectInstance`, so the `instance` param respects the same filter.

## Conventions

- ESM (`"type": "module"`), `module: NodeNext`, `target: ES2023`, strict TypeScript
- All imports use `.js` extension even for `.ts` sources (NodeNext requirement)
- Jenkins folder-style job paths use `jobPath()` from `src/lib/jenkins-client.ts` — slash-separated job names become `job/a/job/b`
- HTTP 401 → `Errors.authFailed()`; HTTP 404 on a job → `Errors.jobNotFound(name)`; abort → `Errors.timeout()`
- Build outputs `dist/` with `.d.ts` + sourcemaps — package is published as a library, not just an MCP

## API reference

Jenkins REST API: https://www.jenkins.io/doc/book/using/remote-access-api/
MCP protocol: https://modelcontextprotocol.io/
