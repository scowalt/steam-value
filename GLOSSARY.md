# Steam Value

Steam Value ranks Steam games by combining public game metadata with one person's Steam account state. The language below separates catalog facts from account-specific status so deployment and sync decisions stay precise.

## Language

**Game Catalog**:
The set of Steam games known to Steam Value. Catalog facts describe the game itself, not whether Scott owns, wants, ignored, or played it.
_Avoid_: Full system, Steam dump

**Catalog Facts**:
Public or third-party facts about a game, such as review score, review count, release date, controller support, game modes, tags, and HowLongToBeat estimates.
_Avoid_: User data, Steam status

**Steam Status**:
Scott-specific status for a catalog game: wishlist membership, ignored state, ownership, and playtime. A game can have zero or more Steam Status markers.
_Avoid_: Catalog data, hydration

**HowLongToBeat Estimate**:
The playtime estimate used by Steam Value for ranking. It is distinct from Scott's actual Steam playtime.
_Avoid_: Playtime

**Playtime**:
Scott's recorded Steam playtime for an owned game. It is not the same as a HowLongToBeat Estimate.
_Avoid_: HLTB, completion time

**Value Score**:
Steam Value's ranking score for a catalog game. It summarizes game quality and expected time investment; it is not a Steam-provided score.
_Avoid_: Steam score, review score

## Flagged ambiguities

**Sync** is ambiguous. Use **Steam Status** when talking about Scott-specific ownership/wishlist/ignored/playtime refreshes, and **Catalog Facts** when talking about public metadata enrichment.

## Example dialogue

Dev: "Can the hosted app refresh sync every hour?"

Domain expert: "Which sync? Steam Status can refresh often because it only updates my account state. Catalog Facts can refresh separately because tags, game modes, and HowLongToBeat estimates are public enrichment data."

Dev: "If a game shows 12 hours, is that Scott's playtime?"

Domain expert: "No. A HowLongToBeat Estimate is expected completion time. Playtime is Scott's actual Steam playtime."
