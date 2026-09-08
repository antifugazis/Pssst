#!/usr/bin/env bash
set -euo pipefail

# Screen & System Audio Recording permissions are attached to a signed .app,
# not to Tauri's transient debug executable. Always use this command when
# manually testing real macOS capture.
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_path="$task_root/src-tauri/target/debug/bundle/macos/Pssst.app"

cd "$task_root"
npm exec tauri build -- --debug --bundles app
open -n "$app_path"
