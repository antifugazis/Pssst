#!/usr/bin/env bash
set -euo pipefail

# Audio capture permission is attached to a signed .app, not to Tauri's
# transient debug executable. Always use this command when testing capture.
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle_path="$task_root/src-tauri/target/debug/bundle/macos/Pssst.app"
applications_dir="/Applications"
app_path="$applications_dir/Pssst.app"

cd "$task_root"
pnpm exec tauri build -- --debug --bundles app
pkill -f '/Applications/Pssst.app/Contents/MacOS/pssst' 2>/dev/null || true
mkdir -p "$applications_dir"
ditto "$bundle_path" "$app_path"
open -n "$app_path"
