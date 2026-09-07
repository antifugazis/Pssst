# pssst Whisper server

This is the lightweight self-hosted transcription worker. It does not require
PostgreSQL, Docker, Redis, or manual API-key configuration.

On a fresh Debian/Ubuntu machine:

```sh
curl -fsSL https://raw.githubusercontent.com/pssst/pssst/main/server/install.sh | sudo bash
```

For a checkout-based install, run `sudo ./server/install.sh`. The installer
detects CPU/RAM/NVIDIA availability, installs Python, ffmpeg and
faster-whisper, creates a restart-on-boot systemd service, and prints one
secure connection link. Set `PSSST_MODEL`, `PSSST_LANGUAGE`, or
`PSSST_PRESET` before running it to choose a simple preset; lower-level
faster-whisper settings remain service-internal.
