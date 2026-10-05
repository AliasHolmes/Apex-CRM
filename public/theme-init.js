/* Applies the stored theme before first paint so there is no flash.
   Loaded as a blocking external script because production CSP forbids inline scripts.
   Keep in sync with src/lib/theme.ts. */
(function () {
  try {
    var stored = window.localStorage.getItem('apex-theme');
    if (stored !== 'light' && stored !== 'dark' && stored !== 'system') stored = 'dark';
    var dark =
      stored === 'dark' ||
      (stored === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0d0f17' : '#f9fafb');
  } catch (error) {
    document.documentElement.classList.add('dark');
  }
})();
