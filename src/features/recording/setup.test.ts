import { canStartRecording } from './setup';

test('requires an available source and a course', () => {
  expect(canStartRecording({ source: null, course: 'Architecture des ordinateurs' })).toBe(false);
  expect(canStartRecording({ source: { id: 'zoom', available: false }, course: 'Architecture des ordinateurs' })).toBe(false);
  expect(canStartRecording({ source: { id: 'zoom', available: true }, course: '  ' })).toBe(false);
  expect(canStartRecording({ source: { id: 'zoom', available: true }, course: 'Architecture des ordinateurs' })).toBe(true);
});
