# Agent Instructions

## Before implementation

1. Read `PRD.md`, `IMPLEMENTATION_PLAN.md`, and `ARCHITECTURE.md`.
2. Read `.ai/specs/README.md` and the one feature spec requested for this session.
3. Implement only the requested task (for example, `T1`) unless the user explicitly expands scope.
4. The repository starts without application code. Follow the decisions in the product docs and the feature spec; do not assume existing source conventions.

## Working rules

- Keep changes within the selected task and its listed files unless a necessary supporting change is explained.
- Preserve the modular frontend, typed IPC, and database-adapter boundaries in `ARCHITECTURE.md`.
- Do not add dependencies unless the spec calls for them or a concrete need is explained first.
- Never persist database passwords in plain-text settings, logs, query history, or test fixtures.
- Never silently retry a write with an uncertain outcome or report success without backend confirmation.
- Run the spec's automated verification commands and report their results.
- Manual verification is performed by the user. Provide the exact steps, wait for feedback at the spec's manual gate, then address requested changes before marking that gate complete.
- Do not mark a feature complete while required manual verification is outstanding.
- Do not commit unless the user requests implementation/commits for that session. When requested, commit only the completed task's intended files using the task title in the commit message.

## Documentation

- Keep `PRD.md`, `IMPLEMENTATION_PLAN.md`, and `ARCHITECTURE.md` aligned when a user approves a material product or architecture change.
- Feature-specific decisions and verification belong in `.ai/specs/`.
