# Migration registry

One-shot data migrations that run against the production waldo.WTF lake
on the Synology. The `/deploy-nas --migrate <name>` skill reads recipes
from this directory — every file has the schema documented in
[../plans/deploy-nas-skill.md](../plans/deploy-nas-skill.md) so the skill
can drive any of them the same way.

Adding a new migration: drop a new `<name>.md` here following the same
shape as an existing recipe, then add a row below. Do not rename or
remove an obsolete recipe — mark its `Status` as `obsolete` or
`deprecated` instead, so old deploys stay runnable from git history.

## Active migrations

| Name | Added | Status | What it does |
| --- | --- | --- | --- |
| [body-backfill](body-backfill.md) | 2026-04-15 | active | Derives plain `body` from `body_html` in place + rebuilds FTS5 so mail content is searchable. Schema v5 → v6 marker. |

## Obsolete / deprecated

_(none yet)_
