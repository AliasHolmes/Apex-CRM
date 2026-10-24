---
trigger: always_on
---

# Codebase Memory & Graph Intelligence Protocol

This repository is indexed in `codebase-memory-mcp` under project `D-work-AI-Apex-crm`.
To save time, reduce token consumption, and avoid line-ending or quoting friction on Windows, prioritize MCP graph tools as the primary investigation engine.

## Action-to-Tool Priority Matrix

| Task | Priority 1 (High-Speed MCP Tool) | Fallback / Alternative |
|---|---|---|
| Locate symbol / function / class / variable | `call_mcp_tool` -> `search_graph(name_pattern="...")` | Text grep (only if unindexed) |
| Find callers, callees, or call hierarchy | `call_mcp_tool` -> `trace_path(direction="both", target_symbol="...")` | Manual call site search |
| Inspect function or class implementation | `call_mcp_tool` -> `get_code_snippet(qualified_name="...")` | `read_file` (for non-code / config) |
| Assess git modification blast radius | `call_mcp_tool` -> `detect_changes(project="D-work-AI-Apex-crm")` | Manual diff inspection |
| Structural overview of a file | `call_mcp_tool` -> `get_file_outline(path="...")` | Paging through entire file |

## Task Lifecycle Protocol

1. **Investigation / Start of Task**:
   - Locate unfamiliar functions, types, and variables using `search_graph(name_pattern="...")`.
   - Inspect their exact implementation with `get_code_snippet` without reading multi-thousand line files.
   - Trace inbound/outbound dependencies with `trace_path` before altering shared signatures.

2. **After Making Modifications**:
   - Re-index with `index_repository(repo_path="D:/work/AI/Apex crm", persistence: true)`.
   - Run `detect_changes(project="D-work-AI-Apex-crm")` to verify impact before concluding.

3. **When to use Native Tools (`run_command`, `read_file`)**:
   - Use `run_command` for executing tests, builds, and git sync operations.
   - Use `read_file` for `.env`, JSON/YAML configs, markdown documentation, or non-code assets.
