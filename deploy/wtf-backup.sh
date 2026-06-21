#!/usr/bin/env bash
# waldo.WTF — nightly cold backup: Mac mini -> NAS (the NAS is backup-only now).
#
# Takes a HOT, WAL-safe snapshot of the live lake (no server stop) via
# better-sqlite3's online backup API, integrity-checks it, then pushes the
# snapshot + auth + whatsapp-archive to a dated dir on the NAS and prunes old
# backups. Uses tar-over-ssh (macOS openrsync is incompatible with the NAS rsync).
# NEVER starts a writer on the NAS.
#
# Run by the com.waldo.wtf.backup LaunchDaemon (nightly). Manual: bash deploy/wtf-backup.sh
set -euo pipefail

NODE=/opt/homebrew/opt/node@22/bin/node
BSQLITE=/Users/waldo/Sourcecode/waldo.wtf/node_modules/better-sqlite3
DATA=/Users/waldo/waldo-wtf
DB="$DATA/db/lake.db"
NAS=waldo@waldonas3
NAS_ROOT=/volume1/backup/waldo-wtf
KEEP=14

STAMP="$(date -u +%Y-%m-%d_%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[$(date -u +%FT%TZ)] backup start ($STAMP)"

# 1) hot snapshot (WAL-safe online backup; does not modify or block the source)
"$NODE" -e '
const D=require(process.argv[3]);
const src=new D(process.argv[1]);
src.backup(process.argv[2]).then(()=>{src.close();process.exit(0)})
  .catch(e=>{console.error("backup error:",e.message);process.exit(1)});
' "$DB" "$WORK/lake.db" "$BSQLITE"

# 2) integrity-check the snapshot before shipping it
"$NODE" -e '
const D=require(process.argv[2]);
const db=new D(process.argv[1],{readonly:true});
const ic=db.pragma("integrity_check",{simple:true});
const n=db.prepare("select count(*) c from messages").get().c;
db.close();
if(ic!=="ok"){console.error("snapshot integrity FAILED:",ic);process.exit(1);}
console.log("snapshot ok: integrity="+ic+" messages="+n+" bytes="+require("fs").statSync(process.argv[1]).size);
' "$WORK/lake.db" "$BSQLITE"

# 3) ship snapshot + auth + whatsapp-archive to a dated dir on the NAS
DEST="$NAS_ROOT/$STAMP"
# COPYFILE_DISABLE=1 stops macOS bsdtar from emitting AppleDouble (._*) xattr
# sidecars that GNU tar on the NAS would otherwise warn about and materialize.
export COPYFILE_DISABLE=1
tar czf - -C "$WORK" lake.db | ssh "$NAS" "sudo mkdir -p '$DEST' && sudo tar xzf - -C '$DEST'"
tar czf - -C "$DATA" auth whatsapp-archive | ssh "$NAS" "sudo tar xzf - -C '$DEST'"
echo "[$(date -u +%FT%TZ)] pushed to $NAS:$DEST"

# 4) prune: keep the newest $KEEP dated dirs
ssh "$NAS" "cd '$NAS_ROOT' 2>/dev/null && ls -1dt */ 2>/dev/null | tail -n +$((KEEP+1)) | while read -r d; do echo 'pruning '\$d; sudo rm -rf \"\$d\"; done" || true

echo "[$(date -u +%FT%TZ)] backup done"
