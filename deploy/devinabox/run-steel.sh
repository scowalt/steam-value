#!/bin/sh
set -eu

if [ "${1:-route}" = route ]; then
    exec "$HOME/.bun/bin/portless" run --tailscale --name steam-value-steel-api "$0" container
fi

[ "${1:-}" = container ] || exit 1
: "${PORT:?Portless did not allocate the API port}"
: "${PORTLESS_URL:?The local API route is required}"
: "${PORTLESS_TAILSCALE_URL:?Private API sharing is required}"
: "${RUNTIME_DIRECTORY:?The private systemd runtime directory is required}"

case "$PORTLESS_URL:$PORTLESS_TAILSCALE_URL" in
    https://*:https://*) ;;
    *) printf '%s\n' 'Steel requires local and private Tailscale HTTPS routes' >&2; exit 1 ;;
esac

api_domain=${PORTLESS_TAILSCALE_URL#https://}
api_domain=${api_domain%/}
printf '%s\n' "$PORTLESS_URL" > "$RUNTIME_DIRECTORY/api-url"

exec /usr/bin/docker run --rm --pull=never \
    --name steam-value-steel-devinabox \
    --cidfile "$RUNTIME_DIRECTORY/container-id" \
    --label info.scowalt.application=steam-value \
    --label info.scowalt.component=steel \
    --memory=2g --cpus=2 --pids-limit=512 --shm-size=1g \
    --security-opt=no-new-privileges:true \
    --publish "127.0.0.1:$PORT:3000" \
    --mount "type=bind,src=$HOME/.local/share/steam-value/steel-profile,dst=/app/api/user-data-dir" \
    --mount "type=bind,src=$HOME/.local/share/steam-value/steel/display-entrypoint.sh,dst=/usr/local/bin/steam-value-steel-display,readonly" \
    --entrypoint /usr/local/bin/steam-value-steel-display \
    --env "DOMAIN=$api_domain" \
    --env USE_SSL=true \
    --env DISABLE_CHROME_SANDBOX=true \
    --env ENABLE_VERBOSE_LOGGING=false \
    --env ENABLE_CDP_LOGGING=false \
    --env LOG_STORAGE_ENABLED=false \
    ghcr.io/steel-dev/steel-browser@sha256:5c10c06375cb1e4833999432f307c816bf72486c8c57667d41b307fb660191fc
