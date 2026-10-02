#!/bin/sh
# Scaffold a design prototype: a working copy of the real page in design-options/<slug>/ that shares the real
# engine, sheet loader and config. Usage: sh design-options/scaffold.sh <slug>
set -e
cd "$(dirname "$0")/.."
slug="$1"
[ -n "$slug" ] || { echo "usage: scaffold.sh <slug>" >&2; exit 1; }
dir="design-options/$slug"
[ -e "$dir" ] && { echo "$dir already exists" >&2; exit 1; }
mkdir -p "$dir"
cp styles.css "$dir/styles.css"
cp src/app.js "$dir/app.js"
sed -e 's#src="config.js"></script>#src="../../config.js"></script>\
  <script defer src="../config.local.js"></script>#' \
    -e 's#src="src/sheet.js"#src="../../src/sheet.js"#' \
    -e 's#src="src/engine.js"#src="../../src/engine.js"#' \
    -e 's#src="src/app.js"#src="app.js"#' index.html > "$dir/index.html"
echo "created $dir"
