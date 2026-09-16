# macOS capture verification

Manual checklist for the real ScreenCaptureKit/AVFoundation capture path.
Everything here requires the signed `.app` bundle — macOS attaches the audio
capture permission to `Pssst.app`, not to the `tauri dev` executable.

## Setup

```sh
pnpm app:mac
```

This builds a debug bundle, installs it to `/Applications/Pssst.app`, and
launches it. Re-run after every change to `src-tauri/`.

## Permission

1. On first launch, use the app's explicit permission action. macOS should
   show the system prompt once, originating from Pssst itself.
2. If permission was previously denied, the app opens System Settings →
   Privacy & Security → Microphone. Grant it and relaunch.
3. Opening System Settings must never re-trigger the system prompt.

## Recording

1. Start audio in the target app (e.g. a Zoom meeting or Chrome tab playing
   a lecture video) and keep the mic toggle on.
2. Select the application, enter a course name, and start recording.
   The primary action stays disabled until both are set.
3. While recording, verify in the app data directory
   (`~/Library/Application Support/com.irisla.pssst.desktop/recordings/sessions/<id>/`):
   - `application/track.wav` and `microphone/track.wav` both grow
   - `manifest.json` shows `recording_state: "recording"`
   - `application/chunks/*.wav` appear in ~25s windows as the upload queue works
4. Stop recording (hold-to-stop). Both tracks finalize; remaining partial
   audio is exported as a last chunk.

## Track separation

- `application/track.wav` contains only the selected app's audio.
- `microphone/track.wav` contains only the microphone.
- Speak near the mic while the app is silent: only the mic track should grow.

## Transcription and correction

1. With a running backend and a configured connection link, chunks upload and
   transcript segments appear in the lecture detail view while recording
   continues.
2. Stop the backend mid-recording: uploads retry locally; recording and the
   already-captured audio are unaffected. Restart the backend and verify the
   queue catches up.
3. With an OpenRouter key saved in Settings, run correction from the detail
   view. Corrected text appears incrementally; raw text never changes.

## Recovery

1. Force-quit Pssst (`killall -9 pssst`) mid-recording.
2. Relaunch. The session reappears marked recoverable with preserved audio,
   and pending processing resumes.
3. Verify `manifest.json` tracks still point at the same relative paths.

## Notes

- The permission status uses Core Audio only. CoreGraphics/ScreenCaptureKit
   preflight is deliberately avoided so an audio-only recording never looks
   like screen sharing.
- A microphone failure must never kill an active application capture: Start
   succeeds with a warning in `last_error` instead.
