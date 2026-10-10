import { describe, expect, it } from 'vitest';
import { pickCamera, scoreCameraLabel, type CameraDeviceInfo } from '../src/lib/camera';

/** Build a device list from labels, mirroring what enumerateDevices returns. */
function devices(labels: string[]): CameraDeviceInfo[] {
  return labels.map((label, index) => ({ deviceId: `device-${index}`, label }));
}

describe('scoreCameraLabel', () => {
  it('prefers the plain rear camera over the virtual multi-cameras', () => {
    const plain = scoreCameraLabel('Back Camera', 0, 'environment');
    const dual = scoreCameraLabel('Back Dual Wide Camera', 1, 'environment');
    const triple = scoreCameraLabel('Back Triple Camera', 2, 'environment');
    expect(plain).toBeGreaterThan(dual);
    expect(plain).toBeGreaterThan(triple);
  });

  it('rejects the ultra-wide and telephoto lenses', () => {
    expect(scoreCameraLabel('Back Ultra Wide Camera', 0, 'environment')).toBeLessThanOrEqual(0);
    expect(scoreCameraLabel('Back Telephoto Camera', 0, 'environment')).toBeLessThanOrEqual(0);
  });

  it('rejects the front camera when the rear is requested', () => {
    expect(scoreCameraLabel('Front Camera', 0, 'environment')).toBeLessThanOrEqual(0);
  });

  it('rejects auxiliary sensors', () => {
    for (const label of ['Back Depth Camera', 'Back LiDAR Camera', 'Back Macro Camera']) {
      expect(scoreCameraLabel(label, 0, 'environment')).toBeLessThanOrEqual(0);
    }
  });

  it('falls back to enumeration order when labels are hidden', () => {
    expect(scoreCameraLabel('', 0, 'environment')).toBe(0);
    expect(scoreCameraLabel('', 1, 'environment')).toBeLessThan(0);
  });
});

describe('pickCamera', () => {
  it('picks the standard rear lens on iOS', () => {
    const list = devices([
      'Back Camera',
      'Back Dual Wide Camera',
      'Back Triple Camera',
      'Back Ultra Wide Camera',
      'Back Telephoto Camera',
      'Front Camera',
      'Front Ultra Wide Camera',
    ]);
    expect(pickCamera(list, 'environment')?.label).toBe('Back Camera');
    expect(pickCamera(list, 'user')?.label).toBe('Front Camera');
  });

  it('picks the first rear sensor on Android', () => {
    const list = devices([
      'camera2 0, facing back',
      'camera2 1, facing back',
      'camera2 2, facing back',
      'camera2 3, facing front',
    ]);
    expect(pickCamera(list, 'environment')?.deviceId).toBe('device-0');
    expect(pickCamera(list, 'user')?.deviceId).toBe('device-3');
  });

  it('returns null when every label is hidden', () => {
    expect(pickCamera(devices(['', '', '']), 'environment')).toBeNull();
  });

  it('returns null when only non-standard lenses are available', () => {
    expect(
      pickCamera(devices(['Back Ultra Wide Camera', 'Back Telephoto Camera']), 'environment'),
    ).toBeNull();
  });

  it('returns null for an empty device list', () => {
    expect(pickCamera([], 'environment')).toBeNull();
  });
});
