#!/bin/sh
set -eu

: "${RUNTIME_DIRECTORY:?The private systemd runtime directory is required}"
attempt=0
while [ "$attempt" -lt 60 ]; do
    api_url=
    if [ -s "$RUNTIME_DIRECTORY/api-url" ]; then
        IFS= read -r api_url < "$RUNTIME_DIRECTORY/api-url"
    fi
    if [ -n "$api_url" ]; then
        api_url=${api_url%/}
        result=0
        code=$(/usr/bin/curl --silent --show-error --max-time 2 --output /dev/null --write-out '%{http_code}' "$api_url/v1/sessions") || result=$?
        if [ "$result" -eq 0 ] && [ "$code" = 200 ]; then
            exit 0
        fi
        case "$result:$code" in
            7:*|28:*|0:502|0:503|0:504) ;;
            *) printf 'Steel readiness failed: curl=%s HTTP=%s\n' "$result" "$code" >&2; exit 1 ;;
        esac
    fi
    attempt=$((attempt + 1))
    sleep 1
done

printf '%s\n' 'Steel API did not become ready; private routes are required' >&2
exit 1
