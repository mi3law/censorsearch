#!/bin/sh
# Screenshot a design prototype with headless Chrome, through shot.html (which types the query for you).
#   sh design-options/shot.sh <slug> <out.png> [width=375] [height=812] [scheme=light] [query] [extra query string]
# Examples:
#   sh design-options/shot.sh current /tmp/a.png 375 812 light "orwell 1984"
#   sh design-options/shot.sh current /tmp/b.png 1280 900 dark "harry potter"
#   sh design-options/shot.sh current /tmp/c.png 375 2600 light 'the alchemist\nfahrenheit 451\norwell'   # tall = whole page
#   sh design-options/shot.sh current /tmp/d.png 375 812 light "" "open=details.help"                   # open a <details>
#   extra can also carry y=<px> (scroll), focus=<css selector>, blur=1 (take focus off the search box),
#   fail=1 (load-failure state plus the "another sheet" note); join several with &
# A second file <out>.json holds a report: page text, console errors, CSP violations, elements overflowing sideways.
# Needs the preview server on port 8771 (PORT=… to change).
slug="$1"; out="$2"; w="${3:-375}"; h="${4:-812}"; scheme="${5:-light}"; q="$6"; extra="$7"
[ -n "$slug" ] && [ -n "$out" ] || { echo "usage: shot.sh <slug> <out.png> [width] [height] [scheme] [query] [extra]" >&2; exit 1; }
port="${PORT:-8771}"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
enc=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1] || ""))' "$q")
url="http://localhost:$port/design-options/shot.html?slug=$slug&w=$w&scheme=$scheme&q=$enc${extra:+&$extra}"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/censorshot.XXXXXX")
# Chrome's window can't be narrower than ~500px, so phone widths are captured in a wider window; the grey strip on the
# right of such a screenshot is outside the page.
win=$w; [ "$w" -lt 500 ] && win=500
common="--headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check --window-size=$win,$h --virtual-time-budget=15000"
rm -f "$out" "$out.json"
"$chrome" $common --user-data-dir="$tmp/p1" --screenshot="$out" "$url" >/dev/null 2>&1 &
"$chrome" $common --user-data-dir="$tmp/p2" --dump-dom "$url" > "$tmp/dom.html" 2>/dev/null &
# This Chrome writes its output and then doesn't exit, so wait for both outputs (up to 60 s) and stop it ourselves.
i=0
while [ $i -lt 120 ]; do
  if [ -s "$out" ] && grep -q '</html>' "$tmp/dom.html" 2>/dev/null; then break; fi
  sleep 0.5; i=$((i + 1))
done
sleep 0.5
pkill -f "$tmp" >/dev/null 2>&1
node -e '
const fs=require("fs");let s="";try{s=fs.readFileSync(process.argv[1],"utf8");}catch(e){}
const m=s.match(/<pre id="report">([\s\S]*?)<\/pre>/);
const t=m&&m[1].trim()?m[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,"\"").replace(/&amp;/g,"&"):JSON.stringify({done:false,note:"no report: the page did not finish loading"});
fs.writeFileSync(process.argv[2],t);
const r=JSON.parse(t);
console.log(process.argv[3]+"  (done="+r.done+" errors="+(r.errors||[]).length+" csp="+(r.csp||[]).length+" overflow="+(r.overflow||[]).length+" pageHeight="+r.pageHeight+")");
' "$tmp/dom.html" "$out.json" "$out"
rm -rf "$tmp"
[ -s "$out" ] || { echo "no screenshot was written" >&2; exit 1; }
