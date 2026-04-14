#!/usr/bin/env bash
set -euo pipefail

NAS_USER=waldo
NAS_HOST=waldonas3           # or 100.126.225.69
IMAGE=waldo-wtf:local
TAR=/tmp/waldo-wtf.tar

echo "==> Saving image on Mac..."
docker save "$IMAGE" -o "$TAR"
ls -lh "$TAR"

echo "==> Copying to NAS..."
scp -O "$TAR" "${NAS_USER}@${NAS_HOST}:/tmp/waldo-wtf.tar"

echo "==> Loading image on NAS..."
ssh -t "${NAS_USER}@${NAS_HOST}" 'sudo /usr/local/bin/docker load -i /tmp/waldo-wtf.tar && sudo /usr/local/bin/docker image ls waldo-wtf && rm /tmp/waldo-wtf.tar'

echo "==> Cleaning up local tarball..."
rm "$TAR"

echo "==> Done. Image should now be on the NAS."
