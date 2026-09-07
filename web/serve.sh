#!/bin/sh
# Serve `web/` on http://localhost:8017.
#
# The apps are static -- this is a file server, not a backend. It exists
# because ES modules and `fetch` need an origin, not because anything here
# needs a process: `python3 -m http.server`, `npx serve`, or any static host
# will do exactly as well.
set -e
cd "$(dirname "$0")"
if [ ! -d data ] || [ ! -d vendor ]; then
  echo "web/data or web/vendor is missing -- run ./web/gen.py first" >&2
  exit 1
fi
echo "http://localhost:${1:-8017}/"
exec python3 -m http.server "${1:-8017}" --bind 127.0.0.1
