// Offline bake of the aerial photo draped on the ground (scenery stage 2). Run after the terrain bake:
//   bun scripts/bake-ortho.ts   -> public/data/spa-ortho.jpg + public/data/spa-ortho.json
//
// One image over the terrain's X/Z bounds, exported by the SPW orthophoto MapServer directly in
// EPSG:3812 (the same CRS and local origin as the road and terrain), so the browser does no GIS work:
// a vertex's texture coordinate is a linear function of its local X/Z (see `uv` in the JSON).
import { mkdirSync } from "node:fs";

const CAMPAIGN = "ORTHO_2023_ETE"; // SPW orthophotos, summer 2023 (full foliage, close to race season)
const SERVICE = `https://geoservices.wallonie.be/arcgis/rest/services/IMAGERIE/${CAMPAIGN}/MapServer`;
const CATALOGUE = "https://geoportail.wallonie.be/catalogue/ad55c2ce-62ad-4c3c-b3cf-8fbc270a6b6e.html";
// From the catalogue: the whole campaign was flown 27 May - 25 June 2023 (not the date of the Spa
// flight itself, which the catalogue does not give); 0.25 m native resolution; licence CC BY 4.0.
const CAMPAIGN_WINDOW = "2023-05-27/2023-06-25";
const LICENCE = "CC BY 4.0";
const MAX_SIDE = 4096; // px, one texture (EM #20686)
// Circuit: `bun scripts/bake-ortho.ts [spa|nurburgring-gp]` (Spa by default).
const CIRCUIT = process.argv[2] ?? "spa";
const OUT_IMG = `public/data/${CIRCUIT}-ortho.jpg`;
const OUT_META = `public/data/${CIRCUIT}-ortho.json`;
// Rhineland-Palatinate DOP20 (20 cm) through its WMS, in EPSG:25832.
const RLP_WMS = "https://geo4.service24.rlp.de/wms/rp_dop20.fcgi";
const RLP_META = "https://geobasis-rlp.de/data/dop20rgb/current/metadata";

const terrain = JSON.parse(await Bun.file(`public/data/${CIRCUIT}-terrain.json`).text());
const RLP = terrain.meta.sourceCrs === "EPSG:25832";
const o = terrain.meta.localOrigin;
const p: number[] = terrain.positions;
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (let i = 0; i < p.length; i += 3) {
  minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
  minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
}
// Square pixels: the longer side gets MAX_SIDE.
const pixel = Math.max(maxX - minX, maxZ - minZ) / MAX_SIDE;
const width = Math.round((maxX - minX) / pixel), height = Math.round((maxZ - minZ) / pixel);
// Local Z points south: northing = origin.northing - z. The image's top row is the north edge (min Z).
const bbox = [o.easting + minX, o.northing - maxZ, o.easting + maxX, o.northing - minZ];
const url = RLP
  ? `${RLP_WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=rp_dop20&STYLES=&CRS=EPSG:25832&BBOX=${bbox.join(",")}&WIDTH=${width}&HEIGHT=${height}&FORMAT=image/jpeg`
  : `${SERVICE}/export?bbox=${bbox.join(",")}&bboxSR=3812&imageSR=3812&size=${width},${height}&format=jpg&f=image`;
console.log(`exporting ${width}x${height} px at ${pixel.toFixed(3)} m/px`);
const res = await fetch(url, { headers: { "User-Agent": "spa-kinesthetic-map-bake/1.0" } });
if (!res.ok || !res.headers.get("content-type")?.includes("image")) throw new Error(`export failed: ${res.status} ${await res.text()}`);
mkdirSync("public/data", { recursive: true });
await Bun.write(OUT_IMG, await res.arrayBuffer());

// RLP: the dates of the DOP20 2 km tiles under the image, from each tile's own metadata.
const rlpTiles: { name: string; created: string | null; edition: string | null }[] = [];
if (RLP) {
  const list = await (await fetch("https://geobasis-rlp.de/data/dop20rgb/current/jp2/", { headers: { "User-Agent": "spa-kinesthetic-map-bake/1.0" } })).text();
  for (let e = Math.floor(bbox[0] / 2000) * 2; e <= Math.floor(bbox[2] / 1000); e += 2)
    for (let n = Math.floor(bbox[1] / 2000) * 2; n <= Math.floor(bbox[3] / 1000); n += 2) {
      const name = list.match(new RegExp(`dop20rgb_32_${e}_${n}_2_rp_\\d{4}`))?.[0];
      if (!name) continue;
      const xml = await (await fetch(`${RLP_META}/${name}_meta.xml`, { headers: { "User-Agent": "spa-kinesthetic-map-bake/1.0" } })).text();
      const created = xml.match(/<gco:Date>([^<]+)<\/gco:Date>\s*<\/gmd:date>\s*<gmd:dateType>\s*<gmd:CI_DateTypeCode[^>]*codeListValue="creation"/)?.[1] ?? null;
      rlpTiles.push({ name, created, edition: xml.match(/<gmd:editionDate>\s*<gco:Date>([^<]+)/)?.[1] ?? null });
    }
}
const source = RLP
  ? {
      name: "LVermGeo RLP Digitale Orthophotos DOP20 (WMS rp_dop20)",
      service: RLP_WMS,
      catalogue: "https://www.geoportal.rlp.de/mapbender/php/mod_showMetadata.php?id=3398&languageCode=de&layout=tabs&resource=wms",
      tiles: rlpTiles,
      campaignAcquisition: `editions ${[...new Set(rlpTiles.map((t) => t.edition))].join(", ")}; product created ${[...new Set(rlpTiles.map((t) => t.created))].join(", ")} (tile metadata gives no flight date)`,
      nativeResolutionM: 0.2,
      licence: "dl-de/by-2-0",
      attribution: `Orthophotos ©GeoBasis-DE / LVermGeoRP ${new Date().getFullYear()}, dl-de/by-2-0, www.lvermgeo.rlp.de [Daten bearbeitet], resampled to ${pixel.toFixed(2)} m`,
      crs: "EPSG:25832",
      bbox25832: bbox.map((v) => +v.toFixed(2)),
    }
  : null;
await Bun.write(
  OUT_META,
  JSON.stringify(
    {
      image: `/data/${CIRCUIT}-ortho.jpg`,
      width,
      height,
      metresPerPixel: +pixel.toFixed(4),
      source: source ?? {
        name: `SPW Orthophotos 2023 - Été (${CAMPAIGN})`,
        service: SERVICE,
        catalogue: CATALOGUE,
        campaignAcquisition: CAMPAIGN_WINDOW, // whole-campaign window, not the exact Spa flight date
        nativeResolutionM: 0.25,
        licence: LICENCE,
        attribution: "Orthophotos 2023 Été © SPW — Service public de Wallonie (CC BY 4.0), resampled to 0.65 m",
        crs: "EPSG:3812",
        bbox3812: bbox.map((v) => +v.toFixed(2)),
      },
      localOrigin: o,
      // Local bounds covered by the image, and how a vertex maps to texture coordinates (three.js,
      // flipY on: v = 1 is the image's top row = north = min Z).
      bounds: { minX, maxX, minZ, maxZ },
      uv: "u = (x - minX) / (maxX - minX); v = 1 - (z - minZ) / (maxZ - minZ)",
    },
    null,
    2,
  ),
);
console.log(`wrote ${OUT_IMG} and ${OUT_META}`);
