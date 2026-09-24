/* Menerapkan tema sebelum halaman digambar (mencegah kedipan). Dimuat sinkron di <head>. */
(function () {
  try {
    var pref = localStorage.getItem('nova:theme');
    var light = pref === 'light' || (pref === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  } catch (e) { /* localStorage tidak tersedia */ }
})();
