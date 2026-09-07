# Lecture Recording First Screen Design

## Goal

Create the macOS-first Tauri desktop interface shown before recording begins. It must let a student select a running application, optionally include their microphone, assign a course, and begin a locally safe lecture recording.

## Scope

This slice implements only the ready-to-record screen plus a lightweight in-place mock of the immediate recording state. Native ScreenCaptureKit capture and the full recording workspace are intentionally outside this slice.

## Experience

The app is called **pssst**. Its visual language is warm paper, deep ink, and a restrained vermilion recording accent. The layout uses a macOS-style title bar and a centred composition that remains useful at compact desktop widths.

The main setup has three sequential controls:

1. A source picker presents familiar running applications — Zoom Workplace, Google Chrome, and Safari — with recognisable visual marks. It has explicit empty, selected, and unavailable states. A selected application may be marked unavailable to demonstrate the closed-app recovery state.
2. A microphone control lets the student include or exclude their own voice. The default is enabled and clearly labelled.
3. A course combobox offers recent classes and permits new class names, seeded with “Architecture des ordinateurs”.

The record button stays disabled until an available source and a non-empty course exist. A small local-storage statement sits beside the controls, not in a separate card. Clicking the enabled button transitions into a compact simulated active-recording confirmation with a timer and Stop action; it does not implement the future recording screen.

## Architecture

React owns an explicit recording-setup state model. Data describing capture sources is separate from rendering components so ScreenCaptureKit-backed source enumeration can replace the mock later without restructuring the UI.

Components are split by interaction boundary: app shell, source picker, microphone switch, course input, and recording-state transition. Tailwind CSS provides layout, typography, visual states, keyboard focus, and low-motion-safe transitions. Tauri is scaffolded with a minimal Rust command surface that can later receive source enumeration and capture control.

## Interaction and Error Behavior

- Source picker opens with no selection and surfaces all sample applications.
- Selecting an available source closes the picker and records the selection.
- Selecting/marking an unavailable source presents a clear “not open” status, disables start, and lets the student choose another source.
- Course entry trims whitespace before evaluating button availability.
- The primary action disables rather than showing an error when requirements are incomplete.
- Controls expose labels, visible keyboard focus, semantic buttons, and `aria-pressed`/`aria-expanded` state.

## Verification

Unit tests cover setup readiness and source availability state rules. A production build verifies TypeScript and bundle integration. Manual browser inspection verifies source selection, mic toggle, course entry, unavailable-source recovery, disabled/enabled primary action, and the recording transition.
