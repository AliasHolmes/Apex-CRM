# Markdown Documentation Synchronization Rule

Whenever any code change, feature, fix, or update is made and committed to the codebase:

1. **Scan All Markdown Files**:
   - Inspect all project `.md` documentation files (such as `docs/CODEBASE_INDEX.md`, `README.md`, `CONTEXT.md`, and any relevant documents in `docs/` or `docs/adr/`).

2. **Detect Documentation Drift**:
   - Verify whether file counts, test suite inventories, architectural descriptions, stage definitions, pipeline tunables, or API behaviors mentioned in those markdown files are impacted by the recent changes.

3. **Synchronize & Maintain Accuracy**:
   - Update and synchronize all affected `.md` files so that the project documentation, commit notes, and index baselines strictly match the live codebase state without drift.
