// Per-browser storage that never breaks the drive: when storage is blocked or full (private windows,
// strict privacy settings) reads give null and writes are dropped.
export function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not kept; the drive carries on
  }
}
