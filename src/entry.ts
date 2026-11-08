// Page entry (S10.1, EM #21276/#21286): a drive link (?track=...) loads the game exactly as before; the
// plain address shows the circuit catalog, which never loads the game, its renderer, physics or
// circuit data.
if (new URLSearchParams(location.search).has('track')) import('./main');
else import('./catalog').then((m) => m.showCatalog());
