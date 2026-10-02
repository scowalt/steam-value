# Domain Docs

## Layout

This is a single-context repo:
- `GLOSSARY.md`: domain vocabulary.
- `docs/adr/`: architectural decisions.

All paths are relative to the repository root.

## Before exploring

Read `GLOSSARY.md` and ADRs relevant to the area being explored.
If these documents are absent, proceed silently; domain-modeling
creates them when terminology or decisions are resolved.

## Vocabulary

Use the terms defined in `GLOSSARY.md` in issues, proposals, hypotheses,
and tests. Respect explicitly avoided synonyms.

If a needed concept is missing, reconsider the terminology or note
the gap for domain-modeling.

## Migrating older domain docs

For an existing checkout using the old filenames, run the applicable commands
only when the source exists and the destination does not:

```sh
git mv CONTEXT.md GLOSSARY.md
git mv CONTEXT-MAP.md GLOSSARY-MAP.md
git mv CONTEXT-FORMAT.md GLOSSARY-FORMAT.md
```

Update references to the renamed files. If both names exist, reconcile their
contents before renaming; do not overwrite either file. Skills look only for
the new names going forward.

## ADR conflicts

Explicitly flag proposals that contradict an existing ADR, naming
the decision and explaining why it should be reopened.
