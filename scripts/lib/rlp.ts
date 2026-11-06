// Rhineland-Palatinate (LVermGeo RLP) open elevation rasters for the bake scripts: DGM1 (terrain,
// 1 m) and DOM1 (surface: tree tops and roofs, 1 m), 1 km GeoTIFF tiles in EPSG:25832, heights in
// DHHN2016 (normal heights), licence dl-de/by-2-0. Tiles and their metadata XML are downloaded once
// into data/raw/rlp/ (git-ignored); each tile's acquisition date-time and height datum are read from
// its own metadata, not from directory listings.
import { existsSync, mkdirSync } from "node:fs";
import { fromArrayBuffer } from "geotiff";

export type RlpKind = "dgm1" | "dom1";
const BASE = "https://geobasis-rlp.de/data";
const RAW = "data/raw/rlp";
const UA = { "User-Agent": "spa-kinesthetic-map-bake/1.0" };
export const RLP_LICENCE = "Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0)";
export const RLP_ATTRIBUTION = (year: number) => `©GeoBasis-DE / LVermGeoRP ${year}, dl-de/by-2-0, www.lvermgeo.rlp.de [Daten bearbeitet]`;

async function download(url: string, path: string) {
  if (existsSync(path)) return;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  await Bun.write(path, await r.arrayBuffer());
}

// Tile names carry an edition year (e.g. _2025); take it from the official directory listing.
async function tileNames(kind: RlpKind): Promise<Map<string, string>> {
  const listing = `data/raw/rlp-${kind}-listing.html`;
  await download(`${BASE}/${kind}/current/tif/`, listing);
  const html = await Bun.file(listing).text();
  const names = new Map<string, string>();
  for (const m of html.matchAll(new RegExp(`(${kind}_32_(\\d{3})_(\\d{4})_1_rp_\\d{4})\\.tif`, "g"))) names.set(`${m[2]}_${m[3]}`, m[1]);
  return names;
}

export interface TileMeta { name: string; acquired: string | null; heightDatum: string | null }

// A raster over a bounding box (EPSG:25832 metres): bilinear sample at any easting/northing inside.
export async function rlpRaster(kind: RlpKind, minE: number, minN: number, maxE: number, maxN: number) {
  mkdirSync(RAW, { recursive: true });
  const names = await tileNames(kind);
  const tiles = new Map<string, { data: Float32Array; x0: number; y0: number; w: number; h: number; res: number; nodata: number }>();
  const metas: TileMeta[] = [];
  const keys: string[] = [];
  for (let e = Math.floor(minE / 1000); e <= Math.floor(maxE / 1000); e++)
    for (let n = Math.floor(minN / 1000); n <= Math.floor(maxN / 1000); n++) keys.push(`${e}_${n}`);
  console.log(`${kind}: ${keys.length} tiles`);
  await Promise.all(
    keys.map(async (key) => {
      const name = names.get(key);
      if (!name) throw new Error(`${kind}: no tile ${key} in the listing`);
      const tif = `${RAW}/${name}.tif`, xml = `${RAW}/${name}_meta.xml`;
      await download(`${BASE}/${kind}/current/tif/${name}.tif`, tif);
      await download(`${BASE}/${kind}/current/metadata/${name}_meta.xml`, xml).catch(() => {});
      const img = await (await fromArrayBuffer(await Bun.file(tif).arrayBuffer())).getImage();
      const [x0, y0] = img.getOrigin(), [res] = img.getResolution();
      const data = (await img.readRasters({ interleave: true })) as unknown as Float32Array;
      const nodata = Number(img.getGDALNoData() ?? -9999);
      tiles.set(key, { data, x0, y0, w: img.getWidth(), h: img.getHeight(), res, nodata });
      const meta = existsSync(xml) ? await Bun.file(xml).text() : "";
      metas.push({
        name,
        acquired: meta.match(/<gco:DateTime>([^<]+)</)?.[1] ?? null,
        heightDatum: meta.match(/DHHN\d+[^<"]*/)?.[0] ?? null,
      });
    }),
  );
  // Value of the cell whose centre is at or around (e, n), from whichever tile holds it.
  const cell = (e: number, n: number): number => {
    const t = tiles.get(`${Math.floor(e / 1000)}_${Math.floor(n / 1000)}`);
    if (!t) return NaN;
    const c = Math.min(t.w - 1, Math.max(0, Math.floor((e - t.x0) / t.res)));
    const r = Math.min(t.h - 1, Math.max(0, Math.floor((t.y0 - n) / t.res)));
    const v = t.data[r * t.w + c];
    return v === t.nodata ? NaN : v;
  };
  // Bilinear between the four cell centres around (e, n) (1 m cells, centres at x.5).
  const sample = (e: number, n: number): number => {
    const gx = e - 0.5, gy = n - 0.5;
    const i = Math.floor(gx), j = Math.floor(gy), tx = gx - i, ty = gy - j;
    const c = (a: number, b: number) => cell(a + 0.5, b + 0.5);
    return (c(i, j) * (1 - tx) + c(i + 1, j) * tx) * (1 - ty) + (c(i, j + 1) * (1 - tx) + c(i + 1, j + 1) * tx) * ty;
  };
  return { sample, cell, metas: metas.sort((a, b) => a.name.localeCompare(b.name)) };
}
