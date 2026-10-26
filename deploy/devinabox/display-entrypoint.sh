#!/bin/sh
set -eu

/usr/bin/Xvfb :10 -screen 0 1920x1080x24 -nolisten tcp &
exec /app/api/entrypoint.sh "$@"
