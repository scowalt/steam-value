# Historical Woodpecker definitions

These configurations and bootstrap preserve the files from commit `4aba6c2a281432a434ab0e37c260a6b1645a4825`. They are documentation only, outside `.woodpecker` and `ci/bun.sh`. Other helpers at that commit remain available in Git history; current production helpers require GitHub Actions and cannot execute the old publisher.

Do not copy these files back or activate a second controller as a retry mechanism. The [handoff](../github-actions.md) must retire this repository's Woodpecker webhook/registration before the approved main merge. The target is public GitHub development and GitHub-hosted Actions for all CI/CD, with no private-runner contribution lane. Archiving these files does not itself change hosted settings, delete logs/artifacts, or stop the existing Worker or external jobs.
