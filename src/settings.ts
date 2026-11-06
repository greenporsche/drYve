// The circuit and driving mode for this process. In the browser they come from the page URL
// (?track=...&mode=...); a headless process (the gym) sets globalThis.F1_SETTINGS before it imports
// the simulation modules, since the car's configuration is fixed when they load. dataBase: where the
// baked circuit files are (a URL prefix; file:// works in Bun).
type Given = { track?: string | null; mode?: string | null; dataBase?: string };
const given: Given = (globalThis as { F1_SETTINGS?: Given }).F1_SETTINGS ?? {};
const params = typeof location !== 'undefined' && location.search ? new URLSearchParams(location.search) : null;
export const SETTINGS = {
  track: params?.get('track') ?? given.track ?? null,
  mode: params?.get('mode') ?? given.mode ?? null,
  dataBase: given.dataBase ?? '/data/',
};
