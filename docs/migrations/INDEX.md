# Migration registry

One-shot data migrations that run against the production waldo.WTF lake
on the **Mac mini** (`waldomacmini1`, native, no Docker). The
`/deploy-local --migrate <name>` skill reads recipes from this directory
and drives them as native one-shots (stop daemon → `tsx src/cli.ts --<flag>`
→ restart); see [../deploy-macmini.md](../deploy-macmini.md).

> Recipe command blocks below were written for the retired Docker-on-Synology
> deploy (`docker compose run --rm waldo --<flag>`). The migration *logic* and
> CLI flags are unchanged; substitute the native invocation from `/deploy-local`.

Adding a new migration: drop a new `<name>.md` here following the same
shape as an existing recipe, then add a row below. Do not rename or
remove an obsolete recipe — mark its `Status` as `obsolete` or
`deprecated` instead, so old deploys stay runnable from git history.

## Active migrations

| Name | Added | Status | What it does |
| --- | --- | --- | --- |
| [body-backfill](body-backfill.md) | 2026-04-15 | active | Derives plain `body` from `body_html` in place + rebuilds FTS5 so mail content is searchable. Schema v5 → v6 marker. |
| [whatsapp-rethread](whatsapp-rethread.md) | 2026-04-21 | active | Heals bifurcated WhatsApp threads by normalizing `thread_id`, rewriting `thread_name` (latest-imported wins), and recomputing message `id` on the normalized chat. No schema change. |
| [repair-transcript-linkage](repair-transcript-linkage.md) | 2026-08-20 | active | Clears the false `__no-transcript-found__` markers left by the conferenceId bug (they would suppress re-checks forever) and backfills `events.chat_id` from the stored joinUrl. Data-only, no schema bump. |
| [oauth-token-hashing](oauth-token-hashing.md) | 2026-10-12 | active | Schema v19 → v20. Hashes OAuth access/refresh tokens + auth codes in place (SHA-256) and adds `grant_created_at` for the 180-day grant cap. Runs automatically at boot; recipe covers backup, pre/post-verify, the one-time connector re-add, and rollback. |
| [sent-items-schema](sent-items-schema.md) | 2026-04-21 | active | Schema v10 → v11. Adds `messages.from_me` and widens `sync_state` PK to `(account, source, folder)` so Outlook Sent Items tracks its own delta cursor. Runs automatically at boot; recipe documents pre/post-verify and rollback. |

## Obsolete / deprecated

_(none yet)_
