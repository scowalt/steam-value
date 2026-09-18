# Domain Docs

## Layout

This is a single-context repo:
- `CONTEXT.md`: domain vocabulary.
- `docs/adr/`: architectural decisions.

All paths are relative to the repository root.

## Before exploring

Read `CONTEXT.md` and ADRs relevant to the area being explored.
If these documents are absent, proceed silently; domain-modeling
creates them when terminology or decisions are resolved.

## Vocabulary

Use the terms defined in `CONTEXT.md` in issues, proposals, hypotheses,
and tests. Respect explicitly avoided synonyms.

If a needed concept is missing, reconsider the terminology or note
the gap for domain-modeling.

## ADR conflicts

Explicitly flag proposals that contradict an existing ADR, naming
the decision and explaining why it should be reopened.
