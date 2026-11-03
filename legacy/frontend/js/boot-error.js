// Shows a readable message if the UI fails to start (kept out of index.html so the CSP can forbid inline scripts).
window.addEventListener('error', function (e) {
  var el = document.getElementById('bootError');
  if (!el) {
    el = document.createElement('div');
    el.id = 'bootError';
    el.style.cssText = 'position:fixed;inset:20px;z-index:99999;background:#fff;border:1px solid #fecaca;border-radius:16px;padding:24px;font-family:Arial,sans-serif;color:#111827;direction:rtl';
    document.body.appendChild(el);
  }
  el.textContent = '';
  var h = document.createElement('h2'); h.textContent = 'حدث خطأ أثناء تشغيل الواجهة';
  var p = document.createElement('p'); p.textContent = e.message || 'خطأ JavaScript غير معروف';
  el.appendChild(h); el.appendChild(p);
});
