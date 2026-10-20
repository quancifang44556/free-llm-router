;(function () {
  try {
    var t = localStorage.getItem('wb_theme') || 'system'
    var dark = t === 'dark' || ((t === 'system' || t === 'auto') && matchMedia('(prefers-color-scheme: dark)').matches)
    if (dark) document.documentElement.classList.add('dark')
  } catch (e) {}
})()