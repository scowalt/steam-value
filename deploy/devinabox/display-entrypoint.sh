#!/bin/sh
set -eu

/usr/local/bin/node /usr/local/lib/steam-value/patch-steel-shutdown.mjs
/usr/bin/Xvfb :10 -screen 0 1920x1080x24 -nolisten tcp &
exec /app/api/entrypoint.sh "$@"
