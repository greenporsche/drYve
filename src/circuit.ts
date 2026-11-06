// The circuit being driven, chosen by the page URL (?track=spa | nurburgring-gp; Spa by default).
// Its teaching data (turn names and stations, timing lines, road width and track limit) comes from
// public/data/<id>-circuit.json; its baked assets are public/data/<id>-*.json. Changing circuit
// reloads the page, so only one circuit's assets are ever loaded.
//
// The values below are live bindings: modules read them after loadCircuit() has filled them in.
export interface Turn {
  n: number;
  name: string;
  in: number; // turn-in station (m along the baked lap)
  out: number; // exit station
}

export const CIRCUITS = [
  { id: 'spa', label: 'Spa-Francorchamps' },
  { id: 'nurburgring-gp', label: 'Nürburgring GP' },
];
const requested = new URLSearchParams(location.search).get('track');
export const CIRCUIT_ID = CIRCUITS.some((c) => c.id === requested) ? requested! : 'spa';
export const asset = (file: string) => `/data/${CIRCUIT_ID}-${file}`;

export let CIRCUIT_NAME = '';
export let TURNS: Turn[] = [];
export let CONTROL_LINE = 0; // lap and sector timing
export let START_LINE = 0; // the grid forms up behind this line
export let SECTOR_LINES: number[] = []; // start of sectors 1, 2, 3
export let CALLOUT_LEAD = 150; // m before turn-in that a turn's name appears
export let ROAD_WIDTH = 12; // m (assumption, per circuit)
export let TRACK_LIMIT = 7.2; // m from the centerline (car centre) before a lap is invalid

export async function loadCircuit() {
  const c = await (await fetch(asset('circuit.json'))).json();
  CIRCUIT_NAME = c.name;
  TURNS = c.turns;
  CONTROL_LINE = c.controlLine;
  START_LINE = c.startLine;
  SECTOR_LINES = c.sectorLines;
  CALLOUT_LEAD = c.calloutLead;
  ROAD_WIDTH = c.roadWidth;
  TRACK_LIMIT = c.trackLimit;
}
