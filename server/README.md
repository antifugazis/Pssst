# pssst Whisper server

This is the lightweight self-hosted transcription worker. It does not require
PostgreSQL, Docker, Redis, or manual API-key configuration.

On a fresh Debian/Ubuntu machine:

```sh
curl -fsSL https://irisla.com/pssst/install.sh | sudo bash
```

The installer is self-contained: it embeds and writes the worker directly, so
it never downloads Pssst source code from GitHub. It detects CPU/RAM/NVIDIA
availability, installs Python, ffmpeg and faster-whisper, creates a
restart-on-boot systemd service, and prints one secure connection link. Set
`PSSST_MODEL`, `PSSST_LANGUAGE`, or `PSSST_PRESET` before running it to choose
a simple preset; lower-level faster-whisper settings remain service-internal.
