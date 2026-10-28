# Apex CRM Agent Guidelines

This repository (`Apex crm`) is indexed in `codebase-memory-mcp` under project identifier `D-work-AI-Apex-crm`.

---

## 1. Codebase Memory & Graph Intelligence Protocol (Priority 1)

To save time, reduce token consumption, and avoid line-ending or shell-quoting friction on Windows, prioritize MCP graph tools as the primary investigation engine.

### Action-to-Tool Priority Matrix (Project: `D-work-AI-Apex-crm`)

| Task | Priority 1 (High-Speed MCP Tool) | Fallback / Alternative |
|---|---|---|
| **Locate Symbol / Function / Class** | `search_graph(project="D-work-AI-Apex-crm", name_pattern="...")` | Text grep (only if unindexed) |
| **Trace Callers & Call Hierarchy** | `trace_path(project="D-work-AI-Apex-crm", function_name="...", direction="both")` | Manual call-site search |
| **Inspect Function Implementation** | `get_code_snippet(project="D-work-AI-Apex-crm", qualified_name="...")` | `read_file` (for non-code / config) |
| **Ranked Code Text Search** | `search_code(project="D-work-AI-Apex-crm", pattern="...")` | Native ripgrep |
| **Structural Outline of a File** | `get_file_outline(project="D-work-AI-Apex-crm", file_path="...")` | Paging through entire file |
| **Git Change Blast Radius** | `detect_changes(project="D-work-AI-Apex-crm")` | Manual diff inspection |
| **Architecture / Modules Overview** | `get_architecture(project="D-work-AI-Apex-crm", aspects=["overview"])` | Reading multiple READMEs |

### Invocation Protocol
- **Antigravity (Lazy MCP)**: Invoke via `call_mcp_tool` with `ServerName: "codebase-memory-mcp"`, `ToolName: "<tool>"`, and `Arguments: { "project": "D-work-AI-Apex-crm", ... }`.
- **OpenCode Desktop (Native CLI)**: Invoke the tool directly (e.g. `search_graph({ project: "D-work-AI-Apex-crm", name_pattern: "..." })`).

### Task Lifecycle Protocol
1. **Investigation / Start of Task**:
   - Locate unfamiliar functions, types, and variables using `search_graph(project="D-work-AI-Apex-crm", name_pattern="...")`.
   - Inspect their exact implementation with `get_code_snippet(project="D-work-AI-Apex-crm", qualified_name="...")` without reading multi-thousand line files.
   - Trace inbound/outbound dependencies with `trace_path(project="D-work-AI-Apex-crm", function_name="...", direction="both")` before altering shared signatures.
2. **After Making Modifications**:
   - Re-index with `index_repository(repo_path="D:/work/AI/Apex crm", persistence: true)`.
   - Run `detect_changes(project="D-work-AI-Apex-crm")` to verify impact before concluding.

---

## 2. Native Tool Allocation (When to Use Directly)

Native tools are strictly superior for execution, environment inspection, and state mutation:

1. **File Modifications**: Always use `edit_file` or `write_file` (MCP is read-only).
2. **Environment & Configurations**: Use `read_file` for `.env`, `.env.example`, JSON/YAML configs, and markdown docs (MCP excludes `.env` and non-code assets).
3. **Database & Telemetry Inspection**: Use `run_command` with inline `node:sqlite` for `.apex-data/apex-crm.sqlite` (MCP cannot query binary SQLite logs).
4. **Builds, Typechecking & Tests**: Use `run_command` for `npm run typecheck` and test runners.

---

## 3. Execution Rules

- **Prohibit `npx` and `tsx` invocations**: NEVER invoke commands using `npx` or `tsx` (including `.\node_modules\.bin\tsx.cmd` or npm scripts wrapping `tsx`). Run Node directly (`node --experimental-strip-types`) or bundle with esbuild (`node ./node_modules/esbuild/bin/esbuild`).
- **UTF-8 ASCII Hygiene**: Maintain strict ASCII-only code hygiene (`codePoint <= 127`).
- **Mandatory Temporary File Cleanup**: Always remove temporary investigation scripts, scratch dumps, and build caches before concluding tasks.
