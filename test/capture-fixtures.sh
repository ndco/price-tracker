#!/usr/bin/env bash
# Recreates the regression fixtures the extractor suite runs against.
# They are not committed — see .gitignore for why.
#
#   bash test/capture-fixtures.sh
#
# Each page here is kept because it once broke the extractor:
#   on.com    offers nested under ProductGroup.hasVariant
#   zappos    the store serves a different colour than the URL asked for
#   allbirds  14 size variants sharing a single URL
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p fixtures
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

get () {
  local name="$1" url="$2"
  local code
  code=$(curl -sL -o "fixtures/$name" -w "%{http_code}" -A "$UA" \
    -H "accept-language: en-US,en;q=0.9" --compressed --max-time 30 "$url")
  printf "%-26s %s  %s bytes\n" "$name" "$code" "$(wc -c < "fixtures/$name" | tr -d ' ')"
}

get on-com.html   "https://www.on.com/en-us/products/cloud-sky-3YD1144/unisex/black-eclipse-shoes-3YD11440106?variant=6"
get zappos.html   "https://www.zappos.com/p/womens-allbirds-wool-runner-hazy-indigo-blizzard/product/9973596/color/1090604"
get allbirds.html "https://www.allbirds.com/products/mens-cruiser-medium-grey"
get allbirds-shopify.json "https://www.allbirds.com/products/mens-cruiser-medium-grey.json"

echo
echo "Stores change their pages, so the exact prices will differ from the day"
echo "these were first captured. The suite asserts on structure and behaviour;"
echo "update the expected values in test/extract.js if a store has moved on."
