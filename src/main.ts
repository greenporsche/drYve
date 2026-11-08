import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { addRoadMarkings, loadTrack } from './surface';
import { CAR_LIMITS } from './car';
import { CAR, MODES } from './carconfig';
import { RacingLineGuide } from './guide';
import { Minimap } from './minimap';
import { TURNS, CIRCUITS, CIRCUIT_ID, CIRCUIT_NAME, CIRCUIT_SHORT, asset, loadCircuit } from './circuit';
import { addStartFinish, roadFrame } from './startline';
import { formatTime } from './lap';
import { ElevationStrip } from './elevation';
import { auto, input } from './input';
import { Autopilot } from './autopilot';
import { Engine } from './engine';
import { CarSound } from './sound';
import { TyreSmoke } from './smoke';
import { buildCoaster } from './coaster';
import { loadOrtho, addPhotoUVs } from './ortho';
import { buildTrees, buildBuildings, type SceneryData } from './scenery';
import { DrivingWorld, PHYSICS_DT, loadReferenceLine } from './world';

const CAMERAS = [
  { name: 'chase', offset: new THREE.Vector3(0, 3.2, -9), lookAhead: new THREE.Vector3(0, 1, 0), smoothing: 7.7, followPitch: true },
  { name: 'drone', offset: new THREE.Vector3(0, 38, -42), lookAhead: new THREE.Vector3(0, 0, 25), smoothing: 3, followPitch: false },
  // Nose: on the car just ahead of the halo, above the nose cone; rigid (no lag), pitches and rolls with it.
  { name: 'nose', offset: new THREE.Vector3(0, 0.5, 0.9), lookAhead: new THREE.Vector3(0, 0.3, 30), smoothing: Infinity, followPitch: true },
];
const STEERING_RATIO = 4; // steering-wheel turn per front-wheel angle, for the on-screen wheel only
// The car starts on pole, in the first painted grid box behind the start/finish line. (The old
// start, station 20, sat inside the Turn 19 left-hander, so holding throttle ran off the right side.)

async function start() {
  const [track] = await Promise.all([loadTrack(asset('lap.json')), RAPIER.init(), loadCircuit()]);
  // Circuit picker: changing it reloads the page with ?track=<id> (only that circuit's assets load).
  document.title = `dryve · ${CIRCUIT_SHORT}`; // the tab names the site and the circuit being driven (EM #20833, PO #21141)
  const picker = document.getElementById('circuit') as HTMLSelectElement;
  for (const c of CIRCUITS) picker.add(new Option(c.label, c.id, false, c.id === CIRCUIT_ID));
  // Driving mode picker (Accessible / Simulation): reloads with the circuit kept; the circuit picker
  // keeps the mode. Either change restarts the session.
  const modePicker = document.getElementById('mode') as HTMLSelectElement;
  for (const m of MODES) modePicker.add(new Option(m.label, m.id, false, m.id === CAR.id));
  const reload = (track: string, mode: string) => (location.search = `?track=${track}&mode=${mode}`);
  picker.addEventListener('change', () => reload(picker.value, CAR.id));
  modePicker.addEventListener('change', () => reload(CIRCUIT_ID, modePicker.value));
  // Keys used on a HUD control stay with it, except Esc, which always pauses (PO #21244).
  const keepKeys = (e: KeyboardEvent) => { if (e.code !== 'Escape') e.stopPropagation(); };
  modePicker.addEventListener('keydown', keepKeys);
  picker.addEventListener('keydown', keepKeys); // don't steer while choosing

  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);
  await renderer.init();
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL 2';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87a9c9);
  scene.fog = new THREE.Fog(0x87a9c9, 250, 1200);
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);

  scene.add(new THREE.HemisphereLight(0xdfeaff, 0x4a5a3a, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.castShadow = true;
  sun.shadow.camera.left = sun.shadow.camera.bottom = -40;
  sun.shadow.camera.right = sun.shadow.camera.top = 40;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun, sun.target);

  // Everything drawn in the world (road, ground, kerbs, paint, grid, supports, guide, car) hangs from
  // one parent so the stilts view can stretch heights (H) with a single transform; physics and the
  // altitude readout stay in true metres.
  const drawn = new THREE.Group();
  scene.add(drawn);

  // The shared driving world (S5.2): road ribbon, surrounding ground and kerb colliders, the car and lap
  // timing, advanced in fixed steps by the same advance() the headless gym uses.
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.9 });
  const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x5f7f4a, roughness: 1 });
  const apronMat = new THREE.MeshStandardMaterial({ color: 0x5f7f4a, roughness: 1 });
  const gridMat = new THREE.MeshStandardMaterial({ color: 0x587a45, roughness: 1 });
  const terrain = await loadTrack(asset('terrain.json')).catch(() => null);
  const dw = new DrivingWorld(drawn, track, terrain, input, { road: roadMat, shoulder: shoulderMat, apron: apronMat, grid: gridMat });
  const { world, car, ribbonMesh, terrainMesh, kerbs, spawn } = dw;
  const lapTracker = dw.lap;
  // Best lap and sector times are kept in this browser, one record per circuit and driving mode,
  // so a reload or a reopened tab starts with them (PO #144, EM #147). updateTiming saves changes.
  const recordKey = `dryve.best.${CIRCUIT_ID}.${CAR.id}`;
  const saved = JSON.parse(localStorage.getItem(recordKey) ?? 'null');
  if (saved) (lapTracker.bestLap = saved.lap), (lapTracker.bestSectors = saved.sectors);
  let savedRecord = JSON.stringify({ lap: lapTracker.bestLap, sectors: lapTracker.bestSectors });
  addRoadMarkings(drawn, track);
  // Aerial photo layer (O): the baked SPW orthophoto on the ground and the road shoulders; the road
  // itself stays grey. Off (and in the V view) the original materials come back, so the photo is not
  // drawn at all. Visual only: the colliders are unchanged.
  const ortho = await loadOrtho(renderer.getMaxAnisotropy(), asset('ortho.json')).catch(() => null);
  if (ortho) {
    addPhotoUVs(ribbonMesh, ortho.meta);
    if (terrainMesh) addPhotoUVs(terrainMesh, ortho.meta);
  }
  let photoOn = true;
  // Trees (T) and buildings (B): their own visual groups, from LiDAR heights and OSM footprints.
  const scenery: SceneryData | null = await fetch(asset('scenery.json')).then((r) => r.json()).catch(() => null);
  const trees = scenery ? buildTrees(scenery) : null;
  const buildings = scenery ? buildBuildings(scenery) : null;
  if (trees) drawn.add(trees);
  if (buildings) drawn.add(buildings);
  let treesOn = true, buildingsOn = true;
  // Roller-coaster elevation view (V): floor at the lap's lowest point, coloured height supports.
  const coaster = buildCoaster(track);
  drawn.add(coaster.group);
  // Height exaggeration in the stilts view: y' = floor + k (y - floor), k = 1, 2 or 3 (H cycles).
  // The car is counter-scaled so it keeps its true size while riding the stretched road.
  const heightEl = document.getElementById('height')!;
  let heightK = 1;
  const applyLayers = () => {
    const photo = !!ortho && photoOn && !coaster.group.visible;
    ribbonMesh.material = [roadMat, photo ? ortho!.material : shoulderMat];
    if (terrainMesh) terrainMesh.material = photo ? [ortho!.material, ortho!.material] : [apronMat, gridMat];
    // The V view shows the bare track on stilts: scenery is hidden there and comes back as selected.
    if (trees) trees.visible = treesOn && !coaster.group.visible;
    if (buildings) buildings.visible = buildingsOn && !coaster.group.visible;
  };
  applyLayers();
  const applyHeight = () => {
    const k = coaster.group.visible ? heightK : 1;
    drawn.scale.y = k;
    drawn.position.y = coaster.floorY * (1 - k);
    heightEl.textContent = `STILTS VIEW · HEIGHT ×${heightK} · H to change`;
    heightEl.classList.toggle('on', coaster.group.visible);
  };
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'KeyO') photoOn = !photoOn;
    else if (e.code === 'KeyT') treesOn = !treesOn;
    else if (e.code === 'KeyB') buildingsOn = !buildingsOn;
    else if (e.code === 'KeyH' && coaster.group.visible) heightK = (heightK % 3) + 1;
    else if (e.code === 'KeyV') {
      coaster.group.visible = !coaster.group.visible;
      if (terrainMesh) terrainMesh.visible = !coaster.group.visible; // its collider stays, so driving is unchanged
      // See the whole height range: push the fog back while the view is on.
      (scene.fog as THREE.Fog).far = coaster.group.visible ? 4000 : 1200;
    } else return;
    applyLayers();
    applyHeight();
  });
  addStartFinish(drawn, track);
  // The circuit's reference racing line, baked where one exists (Spa); otherwise computed once.
  const reference = await loadReferenceLine(track);
  const autopilot = new Autopilot(track, CAR_LIMITS, reference);
  // Racing-line guide on the road: the shared reference line (the same geometry at every level and in
  // both modes, PO #21026), coloured by its planned speeds at the current level's pace.
  const guide = new RacingLineGuide(autopilot.reference.x, autopilot.reference.y, autopilot.reference.z);
  drawn.add(guide.mesh);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyG' && !e.repeat) guide.mesh.visible = !guide.mesh.visible;
  });
  const autoEl = document.getElementById('auto')!;
  // Controls list: like the pickers, keys used while it has focus (Space/Enter toggle it, arrows scroll the
  // open list) stay with it and don't reach the driving keys; after a mouse click it drops focus so the
  // keys drive again.
  document.getElementById('help')!.addEventListener('keydown', keepKeys);
  const helpSummary = document.querySelector<HTMLElement>('#help summary')!;
  helpSummary.addEventListener('click', (e) => {
    if ((e as MouseEvent).detail > 0) helpSummary.blur();
  });
  const autoLevelEl = document.getElementById('auto-level')!;
  // Touch screens have no P key: a button starts and stops the autopilot (shown only on touch-first devices).
  // Like the pickers, its keys don't also reach the driving keys; a tap or click drops focus.
  const autoBtn = document.getElementById('auto-btn') as HTMLButtonElement;
  autoBtn.addEventListener('keydown', keepKeys);
  autoBtn.addEventListener('click', (e) => {
    auto.on = !auto.on;
    if ((e as MouseEvent).detail > 0) autoBtn.blur();
  });
  let autoShown: boolean | null = null;
  const sim = { auto, car, world, dw, backend, track, lap: lapTracker, camera, frameDt: 0, engine: null as unknown, autopilot, guide, terrainHandle: terrainMesh?.userData.colliderHandle as number | undefined };
  (window as unknown as { __sim: object }).__sim = sim;

  const lowestY = Math.min(...track.centerline.points.filter((_, i) => i % 3 === 1));
  const originH = track.meta.localOrigin.height;

  const speedEl = document.getElementById('speed')!;
  const fpsEl = document.getElementById('fps')!;
  const suspEls = [...document.querySelectorAll<HTMLElement>('.susp i')];
  const strip = new ElevationStrip(document.getElementById('elevation') as HTMLCanvasElement, track);
  // The strip fills whatever width the middle of the bar has (wide monitors included).
  const stripCell = document.querySelector<HTMLElement>('#bar .strip')!;
  const fitStrip = () => strip.layout(stripCell.clientWidth - 32);
  new ResizeObserver(fitStrip).observe(stripCell);
  fitStrip();
  const lapEl = document.getElementById('lap')!;
  const lapTimeEl = document.getElementById('laptime')!;
  const lastEl = document.getElementById('last')!;
  const bestEl = document.getElementById('best')!;
  const sectorEls = [1, 2, 3].map((k) => document.getElementById(`s${k}`)!);
  const turnEl = document.getElementById('turn')!;
  const turnNEl = document.getElementById('turn-n')!;
  const turnNameEl = document.getElementById('turn-name')!;
  const throttleEl = document.getElementById('throttle')!;
  const wheelEl = document.getElementById('wheel')!;
  // Steering-wheel display: gear, 15 rev lights along the top edge (5 green, 5 red, 5 blue),
  // and the shift paddles, all driven by one virtual engine/shift state.
  const engine = new Engine();
  sim.engine = engine;
  const sound = new CarSound();
  const smoke = new TyreSmoke();
  drawn.add(smoke.mesh);
  // G-meter: a circle with rings every 2 g out to 6 g; the dot is the sustained load (cornering left/right,
  // accelerating up / braking down), the faint dot the instantaneous one (kerbs and bumps show there).
  const gCanvas = document.getElementById('gmeter') as HTMLCanvasElement;
  const gCtx = gCanvas.getContext('2d')!;
  const gLatEl = document.getElementById('g-lat')!, gLonEl = document.getElementById('g-lon')!;
  const drawG = () => {
    const dpr = window.devicePixelRatio || 1, S = 88;
    if (gCanvas.width !== S * dpr) (gCanvas.width = S * dpr), (gCanvas.height = S * dpr);
    const c = gCtx, r = S / 2 - 2, scale = r / 6;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, S, S);
    c.strokeStyle = 'rgba(255,255,255,0.14)';
    for (const g of [2, 4, 6]) (c.beginPath(), c.arc(S / 2, S / 2, g * scale, 0, Math.PI * 2), c.stroke());
    c.beginPath(); c.moveTo(S / 2, 2); c.lineTo(S / 2, S - 2); c.moveTo(2, S / 2); c.lineTo(S - 2, S / 2); c.stroke();
    const dot = (lat: number, lon: number, rad: number, fill: string) => {
      // Past the 6 g ring the marker sits on the rim in the same direction (EM #20800); the numbers
      // keep the true values.
      let px = -lat * scale, py = -lon * scale;
      const len = Math.hypot(px, py), max = r - rad;
      if (len > max) (px *= max / len), (py *= max / len);
      const x = S / 2 + px, y = S / 2 + py;
      c.fillStyle = fill; c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.fill();
    };
    dot(car.gRaw.lat, car.gRaw.lon, 2.5, 'rgba(255,255,255,0.35)');
    dot(car.g.lat, car.g.lon, 4.5, car.g.lon < -1 ? '#ff4d4d' : '#ffd23f');
    gLatEl.textContent = Math.abs(car.g.lat).toFixed(1);
    gLonEl.textContent = (car.g.lon >= 0 ? '+' : '−') + Math.abs(car.g.lon).toFixed(1);
  };
  (sim as { sound?: CarSound }).sound = sound;
  const gearEl = document.getElementById('gear')!;
  const paddleUpEl = document.getElementById('paddle-up')!;
  const paddleDownEl = document.getElementById('paddle-down')!;
  const REV_COLOURS = ['#2bd46a', '#ff3b30', '#3b8bff'];
  const revEls = Array.from({ length: 15 }, (_, i) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', String(-28 + i * 4));
    c.setAttribute('cy', '-26');
    c.setAttribute('r', '1.7');
    document.getElementById('revs')!.appendChild(c);
    return c;
  });
  const steerDegEl = document.getElementById('steer-deg')!;
  const brakeEl = document.getElementById('brake')!;
  let shownTurn = -1;
  // Where each turn's label hangs in the scene: 4 m above the road at the turn's midpoint.
  const turnAnchors = new Map(
    TURNS.map((t) => {
      const i = track.centerline.distance.findIndex((d) => d >= (t.in + t.out) / 2);
      const c = track.centerline.points;
      return [t.n, new THREE.Vector3(c[i * 3], c[i * 3 + 1] + 4, c[i * 3 + 2])];
    }),
  );
  const projected = new THREE.Vector3();
  const minimap = new Minimap(document.getElementById('map') as HTMLCanvasElement, track.centerline.points, track.centerline.closed);
  document.getElementById('credit')!.textContent =
    `${track.meta.name} · Elevation: ${track.meta.elevationSource.attribution} (${track.meta.elevationSource.license}) · ` +
    `Track centerline: © OpenStreetMap contributors (ODbL) · Camber: flat, estimated` +
    (ortho ? ` · ${ortho.meta.source.attribution}` : '') +
    (scenery ? ` · Trees/buildings: ${scenery.meta.sources.heights}, footprints © OpenStreetMap contributors (ODbL)` : '');
  document.getElementById('backend')!.textContent = `Renderer: ${backend}`;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Start the chase camera already behind the car, not inside it.
  const camPos = new THREE.Vector3(0, 3.2, -9).applyAxisAngle(new THREE.Vector3(0, 1, 0), spawn.yaw).add(spawn.pos);
  const camTarget = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const drawnCar = new THREE.Vector3();
  let acc = 0;
  let seenResets = 0;
  let cameraMode = 0;
  let seenCamera = 0;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyC' && !e.repeat) cameraMode = (cameraMode + 1) % CAMERAS.length;
  });
  // Esc pauses and resumes (PO #21244): physics, lap timing, tyre smoke and sound stop; the view stays drawn.
  const pausedEl = document.getElementById('paused')!;
  let paused = false;
  let pausedAt = 0; // the clock the wheel display and guide animate by stops here while paused
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || e.repeat) return;
    paused = !paused;
    pausedAt = performance.now();
    pausedEl.classList.toggle('on', paused);
    sound.setPaused(paused);
  });
  Object.defineProperty(sim, 'paused', { get: () => paused });
  let lapResets = 0;
  let frameDt = 1 / 60;
  let last = performance.now();
  let fpsFrames = 0;
  let fpsSince = last;

  function updateTiming() {
    const lt = lapTracker;
    lapEl.textContent = lt.lap > 0 ? (lt.invalid ? `LAP ${lt.lap} · INVALID` : `LAP ${lt.lap}`) : 'OUT LAP';
    lapTimeEl.textContent = lt.lap > 0 ? formatTime(dw.time - lt.lapStart) : '–';
    lastEl.textContent = lt.lastLap === null ? '–' : `${formatTime(lt.lastLap)}${lt.lastInvalid ? ' ✕' : ''}`;
    bestEl.textContent = formatTime(lt.bestLap);
    const record = JSON.stringify({ lap: lt.bestLap, sectors: lt.bestSectors });
    if (record !== savedRecord) localStorage.setItem(recordKey, (savedRecord = record));
    sectorEls.forEach((el, k) => {
      // This lap's completed sectors; the running one live; later ones show last lap's time, or the
      // saved best before this session has completed a lap.
      const done = lt.lap > 0 && k < lt.sector ? lt.current[k] : null;
      const live = lt.lap > 0 && k === lt.sector;
      const shown = done ?? (live ? dw.time - lt.sectorStart : lt.last[k] ?? lt.bestSectors[k]);
      const isBest = shown !== null && !live && shown === lt.bestSectors[k];
      el.className = `sector ${live ? 'live' : shown === null ? '' : isBest ? 'best' : 'slower'}`;
      el.querySelector('span')!.textContent = formatTime(shown);
    });
  }

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    frameDt = Math.min(0.1, (now - last) / 1000);
    sim.frameDt = frameDt;
    acc += frameDt;
    last = now;
    // Frames per second, averaged over half a second so the number is readable.
    fpsFrames++;
    if (now - fpsSince >= 500) {
      fpsEl.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsSince))} FPS`;
      fpsFrames = 0;
      fpsSince = now;
    }
    autoEl.classList.toggle('on', auto.on);
    if (auto.on !== autoShown) {
      autoShown = auto.on;
      autoBtn.textContent = auto.on ? 'Stop autopilot' : 'Start autopilot';
      autoBtn.setAttribute('aria-pressed', String(auto.on));
    }
    autoLevelEl.textContent = String(auto.level);
    // One fixed-step simulation loop owns physics time. The autopilot (when engaged) sets its
    // inputs at each step, through the same throttle/brake/steer path as the keyboard.
    if (paused) acc = 0; // no steps while paused, and none owed on resume
    while (acc >= PHYSICS_DT) {
      autopilot.drive(car, lapTracker, PHYSICS_DT);
      dw.advance();
      acc -= PHYSICS_DT;
    }
    const simTime = dw.time;
    // Off the edge of the world: put the car back on the track where it left, facing along it,
    // at rest. (Manual R still returns to the grid.) Either way the lap in progress is void.
    {
      const p = car.body.translation(); // the lap tracker was updated at the last fixed step
      const i = lapTracker.index, c = track.centerline.points;
      const off = Math.hypot(p.x - c[i * 3], p.z - c[i * 3 + 2]);
      // With the surrounding ground loaded, only falling out of the world or nearing its outer edge
      // counts; without it, leaving the 14 m ribbon does.
      const gone = terrain ? off > 280 : off > 15 && p.y < c[i * 3 + 1] - 3;
      if (gone || p.y < lowestY - 30) {
        const f = roadFrame(track, lapTracker.station);
        car.placeAt({ x: f.pos.x, y: f.pos.y + 1.0, z: f.pos.z }, f.yaw);
        car.onGrid = false;
      }
    }
    // Any reset voids the lap in progress. Back on the grid, the next lap is a standing start.
    if (car.resets !== lapResets) {
      lapResets = car.resets;
      if (car.onGrid) lapTracker.armStandingStart();
      else lapTracker.voidLap();
    }
    car.syncVisuals(acc / PHYSICS_DT);
    const trueY = car.group.position.y; // true (interpolated) height, before any drawing correction
    // Stretched heights: keep the car its true size (counter-scale) and keep its wheels on the drawn
    // road. Mapping the car's origin, h above the road, would put it k*h above the drawn road while
    // its wheels hang only h below it; lowering it by h(1 - 1/k) closes that (k-1)*h gap.
    const k = drawn.scale.y;
    car.group.scale.y = 1 / k;
    if (k !== 1) car.group.position.y -= car.heightAboveRoad() * (1 - 1 / k);
    drawn.updateMatrixWorld();
    const carAt = car.group.getWorldPosition(drawnCar); // where the car is drawn (stretched heights)

    // Camera (C cycles): chase sits close behind and above the car; drone hangs high behind it,
    // following the car's heading but not its pitch or roll, so corner shapes and drops read.
    // Cameras that ride with the car are placed through the car's drawn frame (its matrix includes
    // the height stretch), so they stay on their mount and aimed along the drawn nose.
    const view = CAMERAS[cameraMode];
    if (view.followPitch) car.group.localToWorld(tmp.copy(view.offset));
    else {
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(car.group.quaternion);
      tmp.copy(view.offset).applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(fwd.x, fwd.z)).add(carAt);
    }
    // Elapsed-time smoothing; jump straight there after a reset or a camera change.
    if (car.resets !== seenResets || cameraMode !== seenCamera) {
      seenResets = car.resets;
      seenCamera = cameraMode;
      camPos.copy(tmp);
    } else camPos.lerp(tmp, 1 - Math.exp(-view.smoothing * frameDt));
    if (view.followPitch) car.group.localToWorld(camTarget.copy(view.lookAhead));
    else camTarget.copy(view.lookAhead).applyQuaternion(car.group.quaternion).add(carAt);
    camera.position.copy(camPos);
    // The nose camera rolls with the car; the others keep the horizon level.
    if (view.name === 'nose') camera.up.set(0, 1, 0).transformDirection(car.group.matrixWorld);
    else camera.up.set(0, 1, 0);
    camera.lookAt(camTarget);
    sun.position.copy(carAt).add(new THREE.Vector3(-60, 120, 40));
    sun.target.position.copy(carAt);

    const altitude = originH + trueY - 0.6;
    // Timing advanced once per frame, above, from the physics pose; the drawn (blended) pose is
    // for drawing only, so it can never move the tracker back across a line.
    speedEl.textContent = String(Math.round(Math.abs(car.speed) * 3.6));
    // Controls actually applied to the car (keyboard or autopilot), and the front-wheel angle.
    throttleEl.style.height = `${Math.round(car.applied.throttle * 100)}%`;
    brakeEl.style.height = `${Math.round(car.applied.brake * 100)}%`;
    const animNow = paused ? pausedAt : now;
    if (!paused) engine.update(car.speed, car.applied.reverse, now);
    gearEl.textContent = engine.gear === 0 ? 'R' : String(engine.gear);
    const slideMax = Math.max(...car.tyre.map((t) => (t.fz > 0 ? t.slide : 0)));
    sound.update(engine.rpm, car.applied.throttle, car.speed, car.wheelsOnKerb, car.odometer, slideMax, car.tyre.some((t) => t.fz > 0 && t.slip < -0.5) /* locked: braking slip well past the peak (EM #20798) */);
    if (!paused) smoke.update(car, frameDt);
    drawG();
    const revs = engine.revLights();
    const lit = Math.round(revs.fill * revEls.length);
    const blink = revs.flash && Math.floor(animNow / 60) % 2 === 0;
    revEls.forEach((el, i) => el.setAttribute('fill', revs.flash ? (blink ? REV_COLOURS[2] : '#1a1c22') : i < lit ? REV_COLOURS[Math.floor(i / 5)] : '#1a1c22'));
    const paddle = engine.paddle(animNow);
    paddleUpEl.setAttribute('fill', paddle === 'up' ? '#ffd23f' : '#2a2d35');
    paddleDownEl.setAttribute('fill', paddle === 'down' ? '#ffd23f' : '#2a2d35');
    wheelEl.style.transform = `rotate(${(-car.steer * STEERING_RATIO * 180) / Math.PI}deg)`;
    steerDegEl.textContent = `${Math.abs((car.steer * 180) / Math.PI).toFixed(1)}° ${car.steer > 0.002 ? 'L' : car.steer < -0.002 ? 'R' : ''}`;
    updateTiming();
    const turn = lapTracker.activeTurn();
    if ((turn?.n ?? -1) !== shownTurn) {
      shownTurn = turn?.n ?? -1;
      if (turn) {
        turnNEl.textContent = `T${turn.n}`;
        turnNameEl.textContent = turn.name;
      }
    }
    // Hang the label over its corner; hide it once the corner is behind the camera.
    let onScreen = false;
    if (turn) {
      drawn.localToWorld(projected.copy(turnAnchors.get(turn.n)!)).project(camera);
      onScreen = projected.z < 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1;
      if (onScreen) {
        const sx = THREE.MathUtils.clamp((projected.x + 1) / 2, 0.12, 0.88) * window.innerWidth;
        const sy = THREE.MathUtils.clamp((1 - projected.y) / 2, 0.1, 0.8) * window.innerHeight;
        turnEl.style.left = `${sx}px`;
        turnEl.style.top = `${sy}px`;
      }
    }
    turnEl.classList.toggle('on', onScreen);
    strip.draw(lapTracker.station, altitude);
    if (guide.mesh.visible) guide.update(autopilot.referenceSpeed, Math.abs(car.speed), lapTracker.index, animNow / 1000);
    suspEls.forEach((el, i) => (el.style.height = `${Math.round(car.compression(i) * 100)}%`));
    minimap.draw(car.group.position.x, car.group.position.z);
    renderer.render(scene, camera);
  });
}

start();
