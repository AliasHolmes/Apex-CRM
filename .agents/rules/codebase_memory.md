---
trigger: always_on
---

# Codebase Memory & Graph Intelligence Protocol

This repository is indexed in `codebase-memory-mcp` under project identifier `D-work-AI-Apex-crm`.
To save time, reduce token consumption, and avoid line-ending or shell-quoting friction on Windows, prioritize MCP graph tools as the primary investigation engine.

---

## 1. Action-to-Tool Priority Matrix (Project: `D-work-AI-Apex-crm`)

| Task | Priority 1 (High-Speed MCP Tool) | Fallback / Alternative |
|---|---|---|
| **Locate Symbol / Function / Class** | `call_mcp_tool` -> `search_graph(project="D-work-AI-Apex-crm", name_pattern="...")` | Text grep (only if unindexed) |
| **Trace Callers & Call Hierarchy** | `call_mcp_tool` -> `trace_path(project="D-work-AI-Apex-crm", function_name="...", direction="both")` | Manual call-site search |
| **Inspect Function Implementation** | `call_mcp_tool` -> `get_code_snippet(project="D-work-AI-Apex-crm", qualified_name="...")` | `read_file` (for non-code / config) |
| **Ranked Code Text Search** | `call_mcp_tool` -> `search_code(project="D-work-AI-Apex-crm", pattern="...")` | Native ripgrep |
| **Structural Outline of a File** | `call_mcp_tool` -> `get_file_outline(project="D-work-AI-Apex-crm", file_path="...")` | Paging through entire file |
| **Git Change Blast Radius** | `call_mcp_tool` -> `detect_changes(project="D-work-AI-Apex-crm")` | Manual diff inspection |
| **Architecture / Modules Overview** | `call_mcp_tool` -> `get_architecture(project="D-work-AI-Apex-crm", aspects=["overview"])` | Reading multiple READMEs |

---

## 2. Task Lifecycle Protocol

1. **Investigation / Start of Task**:
   - Locate unfamiliar functions, types, and variables using `search_graph(project="D-work-AI-Apex-crm", name_pattern="...")`.
   - Inspect their exact implementation with `get_code_snippet(project="D-work-AI-Apex-crm", qualified_name="...")` without reading multi-thousand line files.
   - Trace inbound/outbound dependencies with `trace_path(project="D-work-AI-Apex-crm", function_name="...", direction="both")` before altering shared signatures.

2. **After Making Modifications**:
   - Re-index with `index_repository(repo_path="D:/work/AI/Apex crm", persistence: true)`.
   - Run `detect_changes(project="D-work-AI-Apex-crm")` to verify impact before concluding.

3. **When to use Native Tools (`run_command`, `read_file`, `edit_file`)**:
   - Use `edit_file` / `write_file` for all file mutations (MCP is strictly read-only).
   - Use `run_command` for executing tests, builds, and git sync operations.
   - Use `read_file` for `.env`, JSON/YAML configs, markdown documentation, or non-code assets.
   - Use `run_command` with inline `node:sqlite` for querying `.apex-data/apex-crm.sqlite`.
