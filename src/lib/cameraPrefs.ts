const KEY = 'doc-scanner.camera.v1';

/**
 * A deviceId the user picked by hand, or null for automatic selection.
 *
 * DeviceIds are salted per origin and can rotate between sessions, so a stored
 * value is a hint rather than a guarantee — `openCamera` falls back to
 * automatic selection if it no longer resolves.
 */
export function loadCameraPreference(): string | null {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function saveCameraPreference(deviceId: string | null): void {
  try {
    if (deviceId) localStorage.setItem(KEY, deviceId);
    else localStorage.removeItem(KEY);
  } catch {
    // Persistence is best effort.
  }
}
