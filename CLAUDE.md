@AGENTS.md

## Claude-specific notes

- The hot rendering path (`packages/core/src/render/*`) is perf-load-bearing and full of
  non-obvious invariants — prefer plan mode there, and read `packages/core/AGENTS.md` first.
- Do broad code search/exploration with read-only sub-agents so the investigation doesn't pollute
  the main thread; keep a single writer.
