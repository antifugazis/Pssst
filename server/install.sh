#!/usr/bin/env bash
set -euo pipefail

# Friendly Debian/Ubuntu installer for the lightweight pssst Whisper worker.
# It deliberately keeps implementation knobs out of the normal setup path.
INSTALL_DIR="${PSSST_INSTALL_DIR:-/opt/pssst-whisper}"
DATA_DIR="${PSSST_DATA_DIR:-/var/lib/pssst-whisper}"
WORKER_URL="${PSSST_WORKER_URL:-https://raw.githubusercontent.com/pssst/pssst/main/server/worker.py}"

if [[ "$(id -u)" != "0" ]]; then echo "Run this installer as root: sudo bash" >&2; exit 1; fi

cores="$(nproc 2>/dev/null || echo 1)"
ram_gb="$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo '?')"
arch="$(uname -m)"
gpu="none"; device="cpu"; compute="int8"
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then gpu="NVIDIA GPU"; device="cuda"; compute="float16"; fi

echo
echo "pssst Whisper setup"
echo "───────────────────"
echo "Detected:"
echo "  $arch · $cores CPU cores · ${ram_gb} GB RAM · $gpu"
echo

recommended_model="medium"
if [[ "$ram_gb" =~ ^[0-9]+$ ]] && (( ram_gb < 6 )); then recommended_model="small"; fi
recommended_compute="$device $compute"
echo "Recommended setup:"
echo "  Whisper $(tr '[:lower:]' '[:upper:]' <<< "${recommended_model:0:1}")${recommended_model:1} · $recommended_compute · Balanced quality"
echo

model="${PSSST_MODEL:-}"
if [[ -z "$model" ]]; then
  printf "Whisper model [1] Small  [2] Medium (recommended)  [3] Large-v3  [r] Use recommended: "
  read -r model_choice
  case "${model_choice:-r}" in
    1) model=small;; 2) model=medium;; 3) model=large-v3;; r|R) model="$recommended_model";; *) model="$recommended_model";;
  esac
fi

quality="${PSSST_QUALITY:-}"
if [[ -z "$quality" ]]; then
  printf "Processing quality [1] Fast  [2] Balanced (recommended)  [3] Best accuracy: "
  read -r quality_choice
  case "${quality_choice:-2}" in 1) quality=fast;; 3) quality=best;; *) quality=balanced;; esac
fi

language="${PSSST_LANGUAGE:-fr}"
if [[ -z "${PSSST_LANGUAGE:-}" ]]; then
  printf "Language [1] French (recommended): "
  read -r language_choice
  [[ "${language_choice:-1}" == 1 ]] && language=fr || language=fr
fi

echo
echo "Installing the pssst Whisper worker…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip ffmpeg curl ca-certificates
mkdir -p "$INSTALL_DIR" "$DATA_DIR"
python3 -m venv "$INSTALL_DIR/.venv"
"$INSTALL_DIR/.venv/bin/pip" install --upgrade pip >/dev/null
"$INSTALL_DIR/.venv/bin/pip" install 'fastapi>=0.115,<1' 'uvicorn[standard]>=0.30,<1' 'python-multipart>=0.0.12,<1' 'faster-whisper>=1.1,<2' >/dev/null

if [[ -f "$(dirname "$0")/worker.py" ]]; then cp "$(dirname "$0")/worker.py" "$INSTALL_DIR/worker.py"; else curl -fsSL "$WORKER_URL" -o "$INSTALL_DIR/worker.py"; fi

echo "Preparing Whisper $model (the first download can take a while)…"
PSSST_MODEL="$model" "$INSTALL_DIR/.venv/bin/python" -c 'import os; from faster_whisper import WhisperModel; WhisperModel(os.environ["PSSST_MODEL"], device="cpu", compute_type="int8")' >/dev/null

cat > /etc/systemd/system/pssst-whisper.service <<EOF
[Unit]
Description=pssst Whisper transcription worker
After=network-online.target
[Service]
WorkingDirectory=$INSTALL_DIR
Environment=PSSST_STORAGE_DIR=$DATA_DIR
Environment=PSSST_MODEL=$model
Environment=PSSST_QUALITY=$quality
Environment=PSSST_LANGUAGE=$language
Environment=PSSST_DEVICE=$device
Environment=PSSST_COMPUTE_TYPE=$compute
ExecStart=$INSTALL_DIR/.venv/bin/uvicorn worker:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now pssst-whisper
sleep 2
if ! curl -fsS http://127.0.0.1:8000/healthz >/dev/null; then echo "The worker did not become healthy. Check: systemctl status pssst-whisper" >&2; exit 1; fi

host="$(hostname -I | awk '{print $1}')"
secret="$(cat "$DATA_DIR/connection-secret")"
pretty_model="${model^}"
echo
echo "pssst Whisper is ready."
echo "Model: $pretty_model"
echo "Quality: ${quality^}"
echo "Language: French"
echo
echo "Connection link:"
echo "http://$host:8000/connect/$secret"
echo
echo "Paste this link into: pssst → Transcription → My pssst server"
