import { beforeEach, expect, test, vi } from 'vitest';

const { invoke, tauriIsTauri } = vi.hoisted(() => ({
  invoke: vi.fn(),
  tauriIsTauri: vi.fn(() => false),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: tauriIsTauri }));

import { isTauri, requestCapturePermission } from './native';

beforeEach(() => {
  invoke.mockReset();
  tauriIsTauri.mockReset();
  tauriIsTauri.mockReturnValue(false);
});

test('uses Tauri’s runtime detector instead of guessing from private globals', () => {
  tauriIsTauri.mockReturnValue(true);
  expect(isTauri()).toBe(true);
});

test('requests capture permission before opening System Settings', async () => {
  invoke.mockResolvedValueOnce('required').mockResolvedValueOnce(undefined);

  await expect(requestCapturePermission()).resolves.toBe(false);

  expect(invoke).toHaveBeenNthCalledWith(1, 'request_screen_recording_access');
  expect(invoke).toHaveBeenNthCalledWith(2, 'open_screen_recording_settings');
});
