// One short notice above the instrument bar: the first-drive hint (S1.22) and shortcut confirmations
// (S1.23). It never takes input; a new notice replaces the current one, and it fades out after its time
// or when hidden.
const el = document.getElementById('notice')!;
let timer = 0;
export function showNotice(html: string, ms: number) {
  el.innerHTML = html;
  el.classList.add('on');
  clearTimeout(timer);
  timer = window.setTimeout(hideNotice, ms);
}
export function hideNotice() {
  clearTimeout(timer);
  el.classList.remove('on');
}
