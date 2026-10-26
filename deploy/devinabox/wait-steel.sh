#!/bin/sh
set -eu

exec "$HOME/.bun/bin/bun" --no-env-file "$HOME/.local/share/steam-value/steel/wait-steel.ts"
