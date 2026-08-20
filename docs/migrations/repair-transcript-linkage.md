# repair-transcript-linkage

**Status**: active
**Added**: 2026-08-20
**One-line**: Clears the false `__no-transcript-found__` markers written by
the conferenceId bug, and backfills `events.chat_id` from the stored
joinUrl. No schema change.

## Why

The transcripts feature (slices T1–T7, shipped 2026-08-12) keyed the
Graph transcript API off `events.online_meeting_id`, which is populated
from `onlineMeeting.conferenceId` — the **audio dial-in number**, not an
onlineMeeting resource id. Two artifacts are now sitting in the
production lake:

1. **False `not-available` markers.** Every transcript lookup that did
   run 404'd, and the sync job recorded a `__no-transcript-found__`
   marker row. `not-available` is deliberately never retried, so those
   markers would suppress a correct re-check *forever* once the code fix
   lands. They must be deleted.
2. **NULL `chat_id` on ~470 events.** Slice 5 read
   `onlineMeeting.chatInfo.threadId`, which Graph omits on nearly every
   calendarView event, so `get_event.linkedChat` was null almost
   everywhere. The joinUrl embeds the chat thread id and is reliably
   populated, so it is derivable in place.

Both are fixed going forward by
[transcripts-meeting-id-resolution.md](../plans/done/transcripts-meeting-id-resolution.md);
this recipe repairs the rows already written.

## Prerequisites

- Code deployed at or past the commit that adds
  `src/store/repair-transcript-linkage.ts` and the
  `--repair-transcript-linkage` CLI flag.
- Schema v19 (no bump — this migration is data-only).

## Pre-verify

```sh
ssh waldomacmini1
cd /Users/waldo/Sourcecode/waldo.wtf && /opt/homebrew/opt/node@22/bin/node -e "
const D=require('better-sqlite3');const db=new D('/Users/waldo/waldo-wtf/db/lake.db',{readonly:true});
console.log('bogus markers:', db.prepare(\"SELECT COUNT(*) n FROM transcripts WHERE transcript_id='__no-transcript-found__'\").get());
console.log('null chat_id w/ joinUrl:', db.prepare('SELECT COUNT(*) n FROM events WHERE chat_id IS NULL AND online_meeting_url IS NOT NULL').get());
"
```

## Dry run

```sh
cd /Users/waldo/waldo-wtf && /opt/homebrew/opt/node@22/bin/node \
  /Users/waldo/Sourcecode/waldo.wtf/node_modules/.bin/tsx \
  /Users/waldo/Sourcecode/waldo.wtf/src/cli.ts --repair-transcript-linkage --dry-run
```

Counts printed must match the pre-verify numbers. Nothing is written.

## Run

Snapshot the lake, stop the writer, run, restart — per
[/deploy-local](../../.claude/skills/deploy-local/SKILL.md):

```sh
cp /Users/waldo/waldo-wtf/db/lake.db{,.pre-repair-transcript-linkage-20260820}
sudo launchctl bootout system/com.waldo.wtf.server
cd /Users/waldo/waldo-wtf && /opt/homebrew/opt/node@22/bin/node \
  /Users/waldo/Sourcecode/waldo.wtf/node_modules/.bin/tsx \
  /Users/waldo/Sourcecode/waldo.wtf/src/cli.ts --repair-transcript-linkage
sudo launchctl bootstrap system /Library/LaunchDaemons/com.waldo.wtf.server.plist
```

## Post-verify

Re-run the pre-verify snippet: bogus markers must be `0`, and the
null-chat_id count must have dropped by the reported backfill count
(anything left is the "skipped" bucket — join links that don't decode to
a `19:…` thread id, e.g. live events).

## Rollback

Restore the snapshot taken above:

```sh
sudo launchctl bootout system/com.waldo.wtf.server
cp /Users/waldo/waldo-wtf/db/lake.db.pre-repair-transcript-linkage-20260820 \
   /Users/waldo/waldo-wtf/db/lake.db
sudo launchctl bootstrap system /Library/LaunchDaemons/com.waldo.wtf.server.plist
```

Both operations are also safe to simply re-run: marker deletion is
idempotent, and the backfill only touches rows where `chat_id IS NULL`.
