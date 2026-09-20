#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/build/apks"
mkdir -p "$OUTPUT_DIR"

build_app() {
  local app_dir="$1"
  local artifact_prefix="$2"
  local raw_version version build_number release_label source_apk target_apk

  raw_version="$(sed -n 's/^version: //p' "$ROOT_DIR/$app_dir/pubspec.yaml" | head -n 1)"
  version="${raw_version%%+*}"
  build_number="${raw_version##*+}"
  if [[ "$build_number" == "$raw_version" ]]; then
    build_number="1"
  fi
  release_label="v${version}-build${build_number}"

  (
    cd "$ROOT_DIR/$app_dir"
    flutter build apk --release
  )

  source_apk="$ROOT_DIR/$app_dir/build/app/outputs/flutter-apk/app-release.apk"
  target_apk="$OUTPUT_DIR/${artifact_prefix}-${release_label}-release.apk"
  cp "$source_apk" "$target_apk"
  printf 'Created %s\n' "$target_apk"
}

build_app "apps/customer_app" "Kraveo-Customer"
build_app "apps/vendor_app" "Kraveo-Restaurant-Partner"
build_app "apps/driver_app" "Kraveo-Delivery-Partner"
