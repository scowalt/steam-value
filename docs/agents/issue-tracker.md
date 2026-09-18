# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `scowalt/steam-value`.
Use the `gh` CLI for all issue operations.

## Conventions

Run commands inside this repo, or pass `--repo scowalt/steam-value`.

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- Read structured metadata:
  `gh issue view <number> --json number,title,body,state,labels,assignees,comments`
- List: `gh issue list --state open`; add label filters as needed.
- Comment: `gh issue comment <number> --body-file <file>`
- Edit body: `gh issue edit <number> --body-file <file>`
- Apply/remove labels:
  `gh issue edit <number> --add-label "..." --remove-label "..."`
- Claim: `gh issue edit <number> --add-assignee @me`
- Close completed work: `gh issue close <number> --reason completed`

Use Markdown checklists for acceptance criteria and Definition of Done.
Record plans, progress, blockers, and final summaries on the issue.
Obtain approval for the implementation plan before coding unless the user
explicitly skips review. Close only after verifying the acceptance criteria
and applicable tests.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the issue and its comments.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub issues and PRs share a number space. When the type is ambiguous,
resolve it with `gh pr view <number>` and fall back to `gh issue view <number>`.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, containing Notes,
  Decisions-so-far, and Fog.
- Child: an issue linked as a GitHub sub-issue, labelled
  `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`).
  If sub-issues are unavailable, use a task list in the map and a
  `Part of #<map>` line in each child.
- Blocking: use native GitHub issue dependencies through `gh api`.
  Dependency endpoints require the blocker's numeric database ID,
  not its issue number. If unavailable, record `Blocked by: #<number>`
  in the child body.
- Frontier: choose the first open child in map order with no assignee
  and no open blockers.
- Claim: assign the ticket to the driving developer before other writes.
- Resolve: comment with the answer, close the ticket, and append a
  summary and issue link to the map's Decisions-so-far.
