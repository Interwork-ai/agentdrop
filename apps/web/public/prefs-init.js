// Applies the saved theme and language before the first paint (defaults: dark, English); see src/lib/theme.ts
// and src/lib/lang.ts. Loaded as a file because the Content-Security-Policy forbids inline scripts.
try {
  if (localStorage.getItem('agentdrop.theme') === 'light') {
    document.documentElement.dataset.theme = 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#f5f7f5');
  }
  if (localStorage.getItem('agentdrop.lang') === 'zh') document.documentElement.lang = 'zh-CN';
} catch (_) {}
