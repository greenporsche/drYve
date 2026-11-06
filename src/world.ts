// The shared fixed-step driving world (S5.2): the colliders, the car and lap timing, advanced in
// fixed 1/120 s steps. The browser and the headless gym build the same world and call the same
// advance(); the browser adds wall-clock accumulation and everything visual around it.
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { addSurface, type Track } from './surface';
import { addKerbs } from './kerbs';
import { gridSlot } from './startline';
import { Car } from './car';
import { LapTracker } from './lap';
import { TURNS, asset } from './circuit';
import type { Controls } from './controls';

export const PHYSICS_DT = 1 / 120;

export interface WorldMaterials {
  road: THREE.Material;
  shoulder: THREE.Material;
  apron: THREE.Material;
  grid: THREE.Material;
}

const plain = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 1 });

export class DrivingWorld {
  readonly world: RAPIER.World;
  readonly car: Car;
  readonly lap: LapTracker;
  readonly ribbonMesh: THREE.Mesh;
  readonly terrainMesh: THREE.Mesh | null;
  readonly kerbs: ReturnType<typeof addKerbs>;
  readonly spawn: { pos: THREE.Vector3; yaw: number }; // the pole slot, 1 m up
  tick = 0; // fixed steps since the world was built

  // drawn: the parent the meshes hang from (the browser's scene group; any group headless).
  constructor(drawn: THREE.Object3D, readonly track: Track, readonly terrain: Track | null, controls: Controls, mats?: WorldMaterials) {
    const m = mats ?? { road: plain(0x55585e), shoulder: plain(0x5f7f4a), apron: plain(0x5f7f4a), grid: plain(0x587a45) };
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = PHYSICS_DT;
    // Baked LiDAR surface: the same positions/indices for the mesh and the collider. Collider order
    // (ribbon, terrain, kerbs, car) is the same in every build of the world.
    const order = ['road', 'shoulder'];
    const groups = [...track.groups].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    this.ribbonMesh = addSurface(drawn, this.world, track.positions, track.indices, [m.road, m.shoulder], groups);
    // Surrounding ground: apron continuing the ribbon plus a coarse grid, collided like the road.
    this.terrainMesh = terrain ? addSurface(drawn, this.world, terrain.positions, terrain.indices, [m.apron, m.grid], terrain.groups) : null;
    this.kerbs = addKerbs(drawn, this.world, track, TURNS.map((t) => [t.in - 10, t.out + 10]));
    // The car starts on pole, 1 m above the first grid box, at rest; it holds still for its settle steps.
    const pole = gridSlot(track, 0);
    this.spawn = { pos: pole.pos.add(new THREE.Vector3(0, 1.0, 0)), yaw: pole.yaw };
    this.car = new Car(drawn, this.world, this.spawn, controls);
    this.car.kerbHandle = this.kerbs.handle;
    this.lap = new LapTracker(track);
    const p = this.car.body.translation();
    this.lap.update(p.x, p.z, 0); // the tracker starts at the car, before any step
  }

  get time() {
    return this.tick * PHYSICS_DT;
  }

  // One fixed step: the controls through the car's steering/pedal dynamics and tyre solve, exactly one
  // world.step, the G-meter, then the car's place on the lap and the lap timing at the new tick.
  advance() {
    this.car.capturePrev();
    this.car.step(PHYSICS_DT);
    this.world.step();
    this.car.sampleG(PHYSICS_DT);
    this.tick++;
    const p = this.car.body.translation();
    this.lap.update(p.x, p.z, this.time);
  }

  free() {
    this.world.free();
  }
}

// The circuit's baked reference racing line offsets, when one exists and matches the lap.
export async function loadReferenceLine(track: Track): Promise<number[] | undefined> {
  const baked: { samples: number; n: number[] } | null = await fetch(asset('line.json')).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const ok = baked && baked.samples === track.centerline.distance.length;
  if (baked && !ok) console.warn('reference line does not match the lap samples; computing one');
  return ok ? baked.n : undefined;
}
