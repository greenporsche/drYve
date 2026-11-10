// Pause menu (S1.21, PO #21308/#21314, EM #21312/#21315): Esc or the Menu button opens one modal panel
// with Resume, the view/camera/driving/sound settings and the keyboard reference, so none of it sits on
// the HUD. The driving runtime keeps the state; the panel reads it each time it opens and writes it
// through the same actions the shortcut keys use. While it is open no key reaches the car, the
// autopilot or the shortcuts.

export interface MenuSettings {
  photo: boolean;
  trees: boolean;
  buildings: boolean;
  line: boolean;
  camera: number; // index into the camera list
  stilts: boolean; // elevation (stilts) view
  height: number; // 1..3, applies in the stilts view
  sound: boolean;
  level: number; // autopilot aggression 1..5
}

export interface MenuOptions {
  get: () => MenuSettings;
  set: (patch: Partial<MenuSettings>) => void;
  // Settings with nothing behind them on this circuit (no orthophoto, no scenery file) are disabled.
  available: { photo: boolean; trees: boolean; buildings: boolean };
  onOpenChange: (open: boolean) => void;
}

export function setupMenu(o: MenuOptions) {
  const dialog = document.getElementById('menu') as HTMLDialogElement;
  const button = document.getElementById('menu-btn') as HTMLButtonElement;
  const check = (id: string) => dialog.querySelector<HTMLInputElement>(`#${id}`)!;
  const radios = (name: string) => [...dialog.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)];
  const switches = { photo: check('opt-photo'), trees: check('opt-trees'), buildings: check('opt-buildings'), line: check('opt-line'), stilts: check('opt-stilts'), sound: check('opt-sound') };
  const groups = { camera: radios('camera'), height: radios('height'), level: radios('level') };
  for (const k of ['photo', 'trees', 'buildings'] as const) switches[k].disabled = !o.available[k];

  const sync = () => {
    const s = o.get();
    for (const k of Object.keys(switches) as (keyof typeof switches)[]) switches[k].checked = s[k] && !switches[k].disabled;
    for (const k of Object.keys(groups) as (keyof typeof groups)[]) for (const r of groups[k]) r.checked = Number(r.value) === s[k];
    // Height stretches only the stilts view, as H does.
    for (const r of groups.height) r.disabled = !s.stilts;
  };
  for (const k of Object.keys(switches) as (keyof typeof switches)[]) {
    switches[k].addEventListener('change', () => (o.set({ [k]: switches[k].checked }), sync()));
  }
  for (const k of Object.keys(groups) as (keyof typeof groups)[]) {
    for (const r of groups[k]) r.addEventListener('change', () => r.checked && (o.set({ [k]: Number(r.value) }), sync()));
  }

  // Open/closed as the runtime last heard it. settle() reports a change once, whichever way the panel
  // opened or closed: our own calls settle at once; Esc inside the panel closes it natively, and the
  // dialog's close event can arrive late (in a busy page it was seen not to arrive at all), so the
  // driving loop also calls settle() every frame.
  let shown = false;
  const settle = () => {
    if (dialog.open === shown) return;
    shown = dialog.open;
    button.setAttribute('aria-expanded', String(shown));
    // On the way out the dialog hands focus back to what had it (often the Menu button), where Space
    // would press it: drop focus so the driving keys drive.
    if (!shown) (document.activeElement as HTMLElement | null)?.blur();
    o.onOpenChange(shown);
  };
  const open = () => {
    if (dialog.open) return;
    sync();
    dialog.showModal();
    settle();
  };
  const close = () => {
    dialog.close();
    settle();
  };
  dialog.addEventListener('close', settle);
  document.getElementById('resume')!.addEventListener('click', close);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close(); // the backdrop: the panel itself fills the dialog box
  });
  button.addEventListener('click', open);
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || e.repeat || dialog.open) return;
    // Keep this key press from also counting as a close request for the dialog it just opened.
    e.preventDefault();
    open();
  });

  // Input isolation: keys used in the panel (arrows on a radio group, Space on a switch, letters in a
  // list) stop at the panel, so the driving keys, the autopilot keys and the shortcuts never see them.
  // A held Esc opens the panel once: its auto-repeat is not also a request to close it.
  dialog.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.code === 'Escape' && e.repeat) e.preventDefault();
  });
  // And if focus is somewhere else while the panel is open (a click on the backdrop leaves it on the
  // page), the key is dropped before any window listener runs.
  window.addEventListener('keydown', (e) => {
    if (dialog.open && !dialog.contains(e.target as Node)) e.stopImmediatePropagation();
  }, { capture: true });

  return { open, close, settle };
}
