import * as THREE from 'three/webgpu';

// Aerial photo layer (scenery stage 2): one baked SPW orthophoto over the terrain's X/Z bounds
// (scripts/bake-ortho.ts). Texture coordinates are a linear function of local X/Z, so the ground and
// the road shoulders sample the same image and their photo joins agree.
export interface OrthoMeta {
  image: string;
  width: number;
  height: number;
  metresPerPixel: number;
  source: { name: string; attribution: string; crs: string; bbox3812: number[] };
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export async function loadOrtho(maxAnisotropy: number, url: string) {
  const meta: OrthoMeta = await (await fetch(url)).json();
  const map = await new THREE.TextureLoader().loadAsync(meta.image);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = Math.min(8, maxAnisotropy); // the ground is mostly seen at grazing angles
  const material = new THREE.MeshStandardMaterial({ map, roughness: 1 });
  return { meta, material };
}

// Adds photo texture coordinates to a surface mesh: u east, v north (three.js flips image rows, so
// v = 1 is the image's top row, the north edge = min Z).
export function addPhotoUVs(mesh: THREE.Mesh, meta: OrthoMeta) {
  const pos = mesh.geometry.getAttribute('position');
  const { minX, maxX, minZ, maxZ } = meta.bounds;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - minX) / (maxX - minX);
    uv[i * 2 + 1] = 1 - (pos.getZ(i) - minZ) / (maxZ - minZ);
  }
  mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
