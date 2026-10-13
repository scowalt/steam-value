# Immutable D1 schema history

`0001_complete_schema.sql` is the complete **provisional source schema**, not certified live truth. Preserve each committed/applied file and append ordered migrations for reviewed changes. Authorized source inventory and drift resolution are separate gates.

Use explicit `applyMigrations` or `bun run db:migrate:local --persist-to <isolated-directory>`. No runtime or deploy migration is permitted. See [local bootstrap/fixture operations](../docs/operations/d1-local-bootstrap.md), the [source inventory](../docs/operations/d1-consumer-schema-inventory.md) and [access contract](../docs/operations/d1-access-contract.md).
