# Codebase Memory & Incremental Change Tracking

This repository (`Apex crm`) is indexed in `codebase-memory-mcp` under project `D-work-AI-Apex-crm`.

## Incremental Sync Protocol
1. **At the start of tasks / investigations:**
   - Call `detect_changes(project="D-work-AI-Apex-crm")` to inspect recently changed files and impacted symbols.
2. **If changes are detected:**
   - Run `index_repository(repo_path="D:/work/AI/Apex crm", mode="fast")` to incrementally re-index and refresh the graph representation.
3. **For Code Discovery:**
   - ALWAYS prefer graph tools (`search_graph`, `trace_path`, `get_code_snippet`, `query_graph`) over raw grep/file scanning.
