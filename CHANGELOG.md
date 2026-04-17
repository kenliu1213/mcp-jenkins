# Changelog

All notable changes to this project are documented here.

---

## [2.0.0] — 2026-04-18

### ✨ Features

- Add `jenkins_get_job_parameters` tool to query job parameter definitions ([#5aaad99](https://github.com/kud/mcp-jenkins/commit/5aaad99))

### 🐛 Bug Fixes

- Use `console.error` to prevent stdout pollution in MCP transport ([#d1c04d5](https://github.com/kud/mcp-jenkins/commit/d1c04d5))

### 📝 Documentation

- Add initial documentation site with GitHub Pages deployment ([#e3f80e9](https://github.com/kud/mcp-jenkins/commit/e3f80e9))
- Promote env vars as recommended config approach ([#8bb6a10](https://github.com/kud/mcp-jenkins/commit/8bb6a10))
- Update and simplify hero command ([#c64d54f](https://github.com/kud/mcp-jenkins/commit/c64d54f), [#d9b7adb](https://github.com/kud/mcp-jenkins/commit/d9b7adb))

### 📦 Other

- Rename `MCP_JENKINS_TOOLS` to `MCP_JENKINS_ALLOW_TOOLS` ⚠️ breaking ([#03ec72f](https://github.com/kud/mcp-jenkins/commit/03ec72f))

<details>
<summary>🔧 Internal changes (2 commits)</summary>

- test(logger): add 6 unit tests with stderr regression guard ([#e2cdd48](https://github.com/kud/mcp-jenkins/commit/e2cdd48))
- fix(build): add node types to tsconfig and upgrade dependencies ([#4017180](https://github.com/kud/mcp-jenkins/commit/4017180))

</details>
