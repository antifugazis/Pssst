# Lecture Recording First Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the polished, interactive pssst ready-to-record desktop screen in a Tauri + React application.

**Architecture:** A Vite React client provides the stateful recording setup flow and visual shell. Data-driven capture-source records and pure setup-readiness helpers isolate mock native data from UI components, leaving an obvious seam for Tauri ScreenCaptureKit commands. The Rust Tauri layer is minimal bootstrap code for this prototype.

**Tech Stack:** Tauri 2, Rust, React, TypeScript, Vite, Tailwind CSS, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-07-lecture-recording-first-screen-design.md`

## Global Constraints

- Use Tauri, React, TypeScript, Tailwind CSS, and Rust; do not use Electron or SwiftUI.
- Build only the ready-to-record screen and a local mock transition to recording.
- Use French course data and familiar application names; do not expose transcription, API, or advanced audio controls.
- Keep source data replaceable by a later macOS ScreenCaptureKit implementation.
- Keep recording unavailable until course text and an available capture source are present.

---

### Task 1: Scaffold the Tauri React application

**Files:**
- Create: `package.json`
- Create: `vite.config.ts`
- Create: `tsconfig.json`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/index.css`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/tauri.conf.json`

**Interfaces:**
- Produces: `npm run dev`, `npm run test`, and `npm run build` scripts.
- Produces: a Tauri 2 Rust entrypoint that opens the React bundle.

- [ ] **Step 1: Create the test runner and a failing smoke test**

```ts
// src/App.test.tsx
import { render, screen } from '@testing-library/react';
import App from './App';

test('shows pssst ready to record', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /prêt à enregistrer/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run src/App.test.tsx`

Expected: FAIL because the app module and test runner do not exist.

- [ ] **Step 3: Add the minimal Vite, React, Tauri, and Vitest setup**

```json
// package.json script excerpt
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest"
  }
}
```

```rust
// src-tauri/src/main.rs
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running pssst");
}
```

- [ ] **Step 4: Run the test to verify the harness loads**

Run: `npm test -- --run src/App.test.tsx`

Expected: FAIL only because `App` has not yet been created.

- [ ] **Step 5: Commit**

```bash
git add package.json vite.config.ts tsconfig.json index.html src src-tauri
git commit -m "chore: scaffold pssst Tauri app"
```

### Task 2: Model recording setup state and readiness rules

**Files:**
- Create: `src/features/recording/types.ts`
- Create: `src/features/recording/setup.ts`
- Create: `src/features/recording/setup.test.ts`

**Interfaces:**
- Produces: `CaptureSource`, `RecordingSetup`, and `canStartRecording(setup: RecordingSetup): boolean`.
- Consumes: no application dependencies.

- [ ] **Step 1: Write the failing readiness tests**

```ts
import { canStartRecording } from './setup';

test('requires an available source and a course', () => {
  expect(canStartRecording({ source: null, course: 'Architecture des ordinateurs' })).toBe(false);
  expect(canStartRecording({ source: { id: 'zoom', available: false }, course: 'Architecture des ordinateurs' })).toBe(false);
  expect(canStartRecording({ source: { id: 'zoom', available: true }, course: '  ' })).toBe(false);
  expect(canStartRecording({ source: { id: 'zoom', available: true }, course: 'Architecture des ordinateurs' })).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run src/features/recording/setup.test.ts`

Expected: FAIL because the setup module does not exist.

- [ ] **Step 3: Implement the minimal state rules**

```ts
export function canStartRecording(setup: RecordingSetup): boolean {
  return Boolean(setup.source?.available && setup.course.trim());
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --run src/features/recording/setup.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/recording
git commit -m "feat: model recording setup readiness"
```

### Task 3: Implement the ready-to-record interface and its visual states

**Files:**
- Create: `src/App.tsx`
- Create: `src/components/SourcePicker.tsx`
- Create: `src/components/MicrophoneToggle.tsx`
- Create: `src/components/CourseInput.tsx`
- Modify: `src/main.tsx`
- Modify: `src/index.css`
- Modify: `src/App.test.tsx`

**Interfaces:**
- Consumes: `CaptureSource`, `RecordingSetup`, `canStartRecording` from `src/features/recording`.
- Produces: an interactive `App` component with source, mic, course, unavailable, disabled, and recording-transition states.

- [ ] **Step 1: Write the failing interaction test**

```tsx
test('enables recording after choosing an available source and course', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole('button', { name: /choisir une application/i }));
  await user.click(screen.getByRole('button', { name: /zoom workplace/i }));
  await user.type(screen.getByLabelText(/cours/i), 'Architecture des ordinateurs');
  expect(screen.getByRole('button', { name: /commencer l’enregistrement/i })).toBeEnabled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run src/App.test.tsx`

Expected: FAIL because the controls are not implemented.

- [ ] **Step 3: Implement focused, semantic UI components**

```tsx
const ready = canStartRecording({ source: selectedSource, course });

<button disabled={!ready} onClick={() => setRecording(true)}>
  Commencer l’enregistrement
</button>
```

Use component-local classes for source highlight, unavailable status, checked microphone state, focus rings, 150–250ms transitions, and `prefers-reduced-motion` support. Use inline SVG application marks and do not add a general-purpose icon package.

- [ ] **Step 4: Run interaction and unit tests to verify they pass**

Run: `npm test -- --run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components src/main.tsx src/index.css src/App.test.tsx
git commit -m "feat: build pssst recording setup screen"
```

### Task 4: Verify the production artifact and interactions

**Files:**
- Modify: `src/App.test.tsx` only if verification exposes a missing behavior.

**Interfaces:**
- Consumes: all prior client and Tauri bootstrap files.
- Produces: evidence that the screen builds and its core readiness path works.

- [ ] **Step 1: Run the complete unit suite**

Run: `npm test -- --run`

Expected: PASS with no failing tests.

- [ ] **Step 2: Build the client production bundle**

Run: `npm run build`

Expected: exit code 0 and a Vite production bundle in `dist/`.

- [ ] **Step 3: Inspect key interaction states in the browser**

Verify: no source has disabled Record; Zoom selection enables readiness with a named course; unavailable source shows a closed-app recovery state; microphone toggle changes its pressed state; clicking Record reveals a simulated active recording state.

- [ ] **Step 4: Commit verification-only fixes if needed**

```bash
git add src
git commit -m "test: cover recording setup interactions"
```
