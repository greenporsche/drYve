// Landing page (S10.1, PO #21273/#21281): every circuit as an outline on the dark page, playable ones
// bright and linked to their drive, the rest dimmed with "Coming soon". Data: public/data/catalog.json
// (scripts/bake-catalog.ts). Nothing of the game is loaded here.
import './catalog.css';
import { SECTOR_COLOURS } from './sectors';

interface Circuit {
  id: string; name: string; city: string; country: string; flag: string;
  round: number | null; playable: string | null; aspect: number; d: string;
  // Playable circuits: the outline by timing sector, label spots and the start/finish bar (S10.2).
  sectors: { runs: { sector: number; d: string }[]; labels: { text: string; x: number; y: number }[]; start: number[]; estimated: boolean } | null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function showCatalog() {
  document.title = 'dryve · circuits';
  const data: { box: number; attribution: string; circuits: Circuit[] } = await (await fetch('/data/catalog.json')).json();
  const open = data.circuits.filter((c) => c.playable).length;
  const card = (c: Circuit) => {
    const s = c.sectors;
    const art = s
      ? s.runs.map((r) => `<path class="sector" style="stroke:${SECTOR_COLOURS[r.sector]}" d="${r.d}"/>`).join('') +
        `<line class="start" x1="${s.start[0]}" y1="${s.start[1]}" x2="${s.start[2]}" y2="${s.start[3]}"/>` +
        s.labels.map((l, k) => `<text x="${l.x}" y="${l.y}" fill="${SECTOR_COLOURS[k]}">${l.text}</text>`).join('')
      : `<path d="${c.d}"/>`;
    const outline = `<svg viewBox="0 0 ${data.box} ${data.box}" aria-hidden="true" focusable="false">${art}</svg>`;
    const where = `<span class="where"><span class="flag" aria-hidden="true">${c.flag}</span>${esc(c.city)} · ${esc(c.country)}</span>`;
    if (c.playable) {
      const note = s?.estimated ? '<span class="note">Sector split estimated</span>' : '';
      return `<li><a class="card open" href="/?track=${encodeURIComponent(c.playable)}">${outline}<span class="name">${esc(c.name)}</span>${where}${note}<span class="status">Drive now</span></a></li>`;
    }
    const round = c.round ? `Round ${c.round} · ` : '';
    return `<li><div class="card soon">${outline}<span class="name">${esc(c.name)}</span>${where}<span class="status">${round}Coming soon</span></div></li>`;
  };
  const root = document.createElement('main');
  root.id = 'catalog';
  root.innerHTML = `
    <header>
      <h1>dryve</h1>
      <p>Drive Formula 1 circuits rebuilt from public survey data: real elevation, real kerbs, real corners.
      A new circuit opens as each one is finished.</p>
      <p class="count">${open} of ${data.circuits.length} circuits open</p>
    </header>
    <ul class="grid">${data.circuits.map(card).join('')}</ul>
    <footer>
      <p>Circuits of the 2026 Formula 1 calendar, plus the Nürburgring GP.</p>
      <p>${esc(data.attribution)}</p>
    </footer>`;
  document.body.appendChild(root);
}
