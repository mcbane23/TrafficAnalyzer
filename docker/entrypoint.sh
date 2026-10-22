#!/bin/sh
# Starts the server as the unprivileged `node` user (uid 1000) instead of root.
#
# The container still starts as root, only to:
# - hand /app/data to node: volumes made by older images were written by
#   root, and the server must keep writing its databases, settings and
#   thumbnails there. Only files not already node's are touched, so after the
#   first start this is a quick scan;
# - keep access to the Intel GPU: node joins the group owning each
#   /dev/dri/render* device passed in, besides the groups the container was
#   given (compose `group_add`).
# Then it drops root for good (setpriv) before running the server.
#
# A container started with its own user (compose `user:`) skips all of this.
set -e

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

RUN_UID="$(id -u node)"
RUN_GID="$(id -g node)"

if [ -d /app/data ]; then
  find /app/data -xdev \( ! -user "$RUN_UID" -o ! -group "$RUN_GID" \) -exec chown -h "$RUN_UID:$RUN_GID" {} +
fi

GROUPS_LIST="$(id -G | tr ' ' '\n' | grep -vx 0 || true)"
for device in /dev/dri/render*; do
  [ -e "$device" ] && GROUPS_LIST="$GROUPS_LIST
$(stat -c %g "$device")"
done
GROUPS_LIST="$(printf '%s\n' "$RUN_GID" "$GROUPS_LIST" | grep -v '^$' | grep -vx 0 | sort -un | paste -sd, -)"

exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --groups="$GROUPS_LIST" --inh-caps=-all --bounding-set=-all -- "$@"
