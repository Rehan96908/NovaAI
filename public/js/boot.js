// Nova AI — frontend. Semua data nyata: tidak ada balasan atau statistik bikinan.
// Server (server.js) yang menyimpan API key dan meneruskan permintaan ke ON Token.
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (id, cls = '') => `<svg class="icon ${cls}"><use href="#i-${id}"/></svg>`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isMobile = () => matchMedia('(max-width: 860px)').matches;
  const fmtBytes = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
  const fmtDate = (ts) => {
    const now = new Date(); const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const days = Math.floor((startToday - new Date(ts).setHours(0, 0, 0, 0)) / 86400000);
    if (days <= 0) return 'Hari ini'; if (days === 1) return 'Kemarin'; if (days < 7) return days + ' hari lalu';
    return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: new Date(ts).getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  };

  /* ═══════════════════════════════════════════════════════════════
     API CLIENT — semua permintaan lewat sini; cookie sesi otomatis ikut.
     ═══════════════════════════════════════════════════════════════ */
  class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method, credentials: 'same-origin',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch { throw new ApiError(0, 'Tidak bisa menghubungi server. Periksa koneksimu.'); }
    let data = null;
    if (res.status !== 204) { try { data = await res.json(); } catch { /* tanpa body */ } }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Permintaan gagal (${res.status}).`);
    return data;
  }
  const apiGet = (u) => api('GET', u);
  const apiPost = (u, b) => api('POST', u, b === undefined ? {} : b);
  const apiPatch = (u, b) => api('PATCH', u, b === undefined ? {} : b);
  const apiDelete = (u, b) => api('DELETE', u, b);

  const state = {
    user: null, models: [], limits: { maxFileMB: 5, dailyMessages: 50 },
    page: 'landing', pendingNav: null,
    model: null, streaming: false, abortCtrl: null,
    files: [], // {id, name, type, size, kind} — sudah terunggah ke server
    conv: null, // {id, title, messages:[...]} percakapan yang sedang dibuka
    convList: [], // ringkasan untuk sidebar & halaman riwayat
    selectMode: false, selected: new Set(),
    motion: true,
  };
  const AUTH_REQUIRED_PAGES = ['chat', 'history', 'settings', 'dashboard', 'admin'];
  const APP_PAGES = ['chat', 'history', 'settings', 'pricing', 'dashboard', 'admin'];
  const TITLES = { chat: 'AI Chat', history: 'Riwayat', settings: 'Pengaturan', pricing: 'Harga', dashboard: 'Dashboard', admin: 'Panel Administrator' };

  /* ═══════════════════════════════════════════════════════════════
     TOAST & MODAL
     ═══════════════════════════════════════════════════════════════ */
  function toast(msg, type = 'info', ms = 3400) {
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'success' ? ' toast--success' : '');
    el.innerHTML = `<span class="toast__icon">${icon(type === 'success' ? 'check' : 'info')}</span><span class="toast__text">${esc(msg)}</span><button class="icon-btn icon-btn--sm toast__close" aria-label="Tutup">${icon('x')}</button>`;
    $('#toasts').appendChild(el);
    const close = () => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 300); };
    el.querySelector('.toast__close').onclick = close;
    setTimeout(close, ms);
  }
  const errMsg = (e) => (e instanceof ApiError ? e.message : 'Terjadi kesalahan tak terduga.');

  let modalCb = null, modalBusy = false;
  function openModal({ title, body, confirm = 'Konfirmasi', iconName = 'trash', danger = true, input = null, inputType = 'text', onConfirm }) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = `<div>${body}</div>`;
    $('#modalConfirm').textContent = confirm;
    $('#modalConfirm').className = 'btn ' + (danger ? 'btn--danger' : 'btn--primary');
    $('.modal__icon').innerHTML = icon(iconName);
    if (input !== null) $('#modalBody').insertAdjacentHTML('beforeend', `<div class="modal__field"><input class="input" id="modalInput" type="${inputType}" value="${esc(input)}" aria-label="Input" autocomplete="off"></div>`);
    setTimeout(() => { const i = $('#modalInput'); if (i) { i.focus(); i.select(); } }, 120);
    modalCb = onConfirm;
    $('#modal').classList.add('is-open'); $('#modal').setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
  }
  function closeModal() {
    if (modalBusy) return;
    $('#modal').classList.remove('is-open'); $('#modal').setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open'); modalCb = null;
    const e = $('#modalBody .modal__error'); if (e) e.remove();
  }
  function modalError(msg) {
    let e = $('#modalBody .modal__error');
    if (!e) { e = document.createElement('div'); e.className = 'modal__error'; $('#modalBody').appendChild(e); }
    e.textContent = msg;
  }
  async function modalConfirmClick() {
    if (!modalCb || modalBusy) return;
    const val = $('#modalInput') ? $('#modalInput').value : undefined;
    modalBusy = true; $('#modalConfirm').classList.add('is-loading');
    try { const keepOpen = await modalCb(val); modalBusy = false; $('#modalConfirm').classList.remove('is-loading'); if (keepOpen !== 'keep') closeModal(); }
    catch (e) { modalBusy = false; $('#modalConfirm').classList.remove('is-loading'); modalError(errMsg(e)); }
  }
  $$('[data-modal-close]').forEach((b) => b.addEventListener('click', closeModal));
  $('#modalConfirm').addEventListener('click', modalConfirmClick);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); closeDropdowns(); closeMobileMenu(); }
    if (e.key === 'Enter' && $('#modal').classList.contains('is-open') && document.activeElement && document.activeElement.id === 'modalInput') modalConfirmClick();
  });

  /* ═══════════════════════════════════════════════════════════════
     TEMA
     ═══════════════════════════════════════════════════════════════ */
  const mq = matchMedia('(prefers-color-scheme: light)');
  function applyTheme(pref) {
    try { localStorage.setItem('nova:theme', pref); } catch { /* penyimpanan tak tersedia */ }
    const theme = pref === 'system' ? (mq.matches ? 'light' : 'dark') : pref;
    document.documentElement.setAttribute('data-theme', theme);
    const r = $(`#themeGrid input[value="${pref}"]`); if (r) r.checked = true;
    return theme;
  }
  function toggleTheme() { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); }
  mq.addEventListener && mq.addEventListener('change', () => { try { if (localStorage.getItem('nova:theme') === 'system') applyTheme('system'); } catch { /* abaikan */ } });
  $$('[data-theme-toggle]').forEach((b) => b.addEventListener('click', toggleTheme));
  $$('#themeGrid input').forEach((r) => r.addEventListener('change', () => applyTheme(r.value)));
  { let saved = 'dark'; try { saved = localStorage.getItem('nova:theme') || 'dark'; } catch { /* abaikan */ } applyTheme(saved); }

  /* ═══════════════════════════════════════════════════════════════
     NAVIGASI SPA
     ═══════════════════════════════════════════════════════════════ */
  function navigate(id, opts = {}) {
    if (!id) return;
    if (AUTH_REQUIRED_PAGES.includes(id) && !state.user) { state.pendingNav = id; return navigate('auth', { authTab: 'login', silent: opts.silent }); }
    const isApp = APP_PAGES.includes(id);
    const target = isApp ? $('#appShell') : $(`#page-${id}`);
    if (!target) return;
    closeMobileMenu(); closeDropdowns();
    if (isMobile()) $('#appShell').classList.remove('is-drawer-open');
    if (id === 'auth' && opts.authTab) setAuthTab(opts.authTab);

    const cur = $$('.page.is-active')[0];
    const swap = () => {
      $$('.page').forEach((p) => p.classList.remove('is-active', 'is-leaving'));
      target.classList.add('is-active');
      if (isApp) {
        $('#appShell').classList.toggle('is-guest', !state.user);
        APP_PAGES.forEach((p) => { const s = $(`#page-${p}`); if (s) s.hidden = p !== id; });
        const sec = $(`#page-${id}`); sec.style.animation = 'none'; void sec.offsetHeight; sec.style.animation = 'pageIn .4s var(--ease) both';
        $$('.side-nav a').forEach((a) => a.classList.toggle('is-active', a.dataset.nav === id));
        renderTopbar(id);
        if (id === 'history') loadHistory();
        if (id === 'dashboard') loadDashboard();
        if (id === 'settings') renderSettings();
        if (id === 'admin') loadAdminPanel();
        if (id === 'pricing') applyLimitsToPricing();
        if (id === 'chat' && !state.conv) showChatEmpty();
        if (id === 'chat') setTimeout(() => $('#chatInput').focus(), 60);
      }
      document.body.dataset.layout = isApp ? 'app' : 'site';
      $('#navbar').style.display = isApp || id === 'auth' ? 'none' : '';
      window.scrollTo(0, 0);
      $$('.content, .chat__scroll').forEach((c) => (c.scrollTop = 0));
      state.page = id;
      if (!opts.silent && location.hash.slice(1) !== id) history.replaceState(null, '', '#' + id);
      observeReveals();
      if (opts.scrollTo) setTimeout(() => scrollToId(opts.scrollTo), 60);
    };
    if (cur && cur !== target && !prefersReduced) { cur.classList.add('is-leaving'); setTimeout(swap, 180); } else swap();
  }
  function scrollToId(id) { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: prefersReduced ? 'auto' : 'smooth', block: 'start' }); }

  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { e.preventDefault(); navigate(nav.dataset.nav, { authTab: nav.dataset.authTab }); return; }
    const sc = e.target.closest('[data-scroll]');
    if (sc) { e.preventDefault(); closeMobileMenu(); if (state.page !== 'landing') navigate('landing', { scrollTo: sc.dataset.scroll }); else scrollToId(sc.dataset.scroll); return; }
    const t = e.target.closest('[data-toast]');
    if (t && !t.closest('[data-nav]')) { e.preventDefault(); toast(t.dataset.toast); }
  });
  window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (id && (APP_PAGES.includes(id) || id === 'landing' || id === 'auth')) navigate(id, { silent: true }); });

  const navbar = $('#navbar');
  const onScroll = () => navbar.classList.toggle('is-scrolled', window.scrollY > 12);
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  function closeMobileMenu() { $('#mobileMenu').classList.remove('is-open'); $('#navBurger').setAttribute('aria-expanded', 'false'); document.body.classList.remove('menu-open'); $('#navBurger').innerHTML = icon('menu'); }
  $('#navBurger').addEventListener('click', () => {
    const open = $('#mobileMenu').classList.toggle('is-open');
    $('#navBurger').setAttribute('aria-expanded', open); document.body.classList.toggle('menu-open', open);
    $('#navBurger').innerHTML = icon(open ? 'x' : 'menu');
  });

  function toggleSidebar() { if (isMobile()) $('#appShell').classList.toggle('is-drawer-open'); else $('#appShell').classList.toggle('is-collapsed'); }
  $('#btnSidebar').addEventListener('click', toggleSidebar);
  $('[data-sidebar-close]').addEventListener('click', toggleSidebar);
  $('#sidebarScrim').addEventListener('click', () => $('#appShell').classList.remove('is-drawer-open'));

  function closeDropdowns() { $$('.dropdown.is-open').forEach((d) => d.classList.remove('is-open')); const b = $('#modelBtn'); if (b) b.setAttribute('aria-expanded', 'false'); }
  $('#userChip').addEventListener('click', (e) => { e.stopPropagation(); const d = $('#userMenu'); const o = d.classList.contains('is-open'); closeDropdowns(); d.classList.toggle('is-open', !o); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.dropdown') && !e.target.closest('#userChip') && !e.target.closest('.model-picker__btn') && !e.target.closest('[data-conv-menu]')) closeDropdowns(); });

  document.addEventListener('click', (e) => { const t = e.target.closest('.accordion__trigger'); if (!t) return; const acc = t.parentElement; const open = acc.classList.toggle('is-open'); t.setAttribute('aria-expanded', open); });

  let io;
  function observeReveals() {
    if (!('IntersectionObserver' in window)) { $$('.reveal').forEach((r) => r.classList.add('is-visible')); return; }
    io = io || new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('is-visible'); io.unobserve(en.target); } }), { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    $$('.reveal:not(.is-visible)').forEach((r) => io.observe(r));
  }
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.btn'); if (!b || prefersReduced || b.disabled) return;
    const r = b.getBoundingClientRect(), s = Math.max(r.width, r.height);
    const sp = document.createElement('span'); sp.className = 'ripple';
    sp.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
    b.appendChild(sp); setTimeout(() => sp.remove(), 600);
  });

  /* ═══════════════════════════════════════════════════════════════
     PARTIKEL LATAR (canvas)
     ═══════════════════════════════════════════════════════════════ */
  (function particles() {
    const c = $('#particles'); if (!c) return; const ctx = c.getContext('2d');
    let w, h, dpr, pts = [], raf = null, running = true;
    const rgb = () => (document.documentElement.dataset.theme === 'dark' ? '220,220,220' : '30,30,30');
    function resize() {
      dpr = Math.min(devicePixelRatio || 1, 2); w = innerWidth; h = innerHeight;
      c.width = w * dpr; c.height = h * dpr; c.style.width = w + 'px'; c.style.height = h + 'px'; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = w < 700 ? 26 : 52; pts = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .22, vy: (Math.random() - .5) * .22, r: Math.random() * 1.3 + .4 }));
    }
    function frame() {
      ctx.clearRect(0, 0, w, h); const col = rgb();
      for (const p of pts) { p.x += p.vx; p.y += p.vy; if (p.x < 0 || p.x > w) p.vx *= -1; if (p.y < 0 || p.y > h) p.vy *= -1; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fillStyle = `rgba(${col},.35)`; ctx.fill(); }
      const maxD = w < 700 ? 90 : 130;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, d = Math.hypot(dx, dy);
        if (d < maxD) { ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.strokeStyle = `rgba(${col},${(1 - d / maxD) * .12})`; ctx.lineWidth = .6; ctx.stroke(); }
      }
      raf = requestAnimationFrame(frame);
    }
    function start() { if (!raf && running && state.motion && !prefersReduced) raf = requestAnimationFrame(frame); }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = null; if (!state.motion || prefersReduced) ctx.clearRect(0, 0, w, h); }
    resize(); addEventListener('resize', resize); start();
    document.addEventListener('visibilitychange', () => { running = !document.hidden; running ? start() : stop(); });
    window.__novaParticles = { start, stop };
  })();
  const swMotionEl = $('#swMotion');
  if (swMotionEl) swMotionEl.addEventListener('change', (e) => {
    state.motion = e.target.checked;
    $$('.bg-mesh, .bg-glow').forEach((el) => (el.style.animationPlayState = state.motion ? 'running' : 'paused'));
    state.motion ? window.__novaParticles.start() : window.__novaParticles.stop();
  });

  /* ═══════════════════════════════════════════════════════════════
     UI TAMU / MASUK
     ═══════════════════════════════════════════════════════════════ */
  const initials = (name) => (String(name || 'NV').trim().split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase() || 'NV');
  function applyAuthUI() {
    const on = !!state.user;
    $$('[data-guest-only]').forEach((el) => (el.hidden = on));
    $$('[data-user-only]').forEach((el) => (el.hidden = !on));
    if (on) {
      $('#userChip .avatar').style.backgroundImage = state.user.avatar ? `url(${state.user.avatar})` : '';
      $('#userChip .avatar').textContent = state.user.avatar ? '' : initials(state.user.name);
      $('.user-chip__meta strong').textContent = state.user.name;
      $('.user-chip__meta span').textContent = state.user.role === 'admin' ? 'Admin • Pro' : (state.user.plan === 'pro' ? 'Paket Pro' : 'Paket Free');
      const sideAdmin = $('#sideAdminNav');
      if (sideAdmin) sideAdmin.hidden = state.user.role !== 'admin';
    } else {
      const sideAdmin = $('#sideAdminNav');
      if (sideAdmin) sideAdmin.hidden = true;
    }
    if ($('#appShell').classList.contains('is-active')) $('#appShell').classList.toggle('is-guest', !on);
  }

  /* ═══════════════════════════════════════════════════════════════
     MARKDOWN RENDERER RINGAN (tanpa library eksternal)
     ═══════════════════════════════════════════════════════════════ */
  function highlight(code, lang) {
    const hash = /^(py|python|bash|sh|shell|zsh|yaml|yml|ruby|rb|toml|r)$/i.test(lang || '');
    const re = new RegExp('(\\/\\/[^\\n]*' + (hash ? '|#[^\\n]*' : '') + ')|(&quot;.*?&quot;|&#39;.*?&#39;|`[^`\\n]*`)|(&(?:#\\d+|\\w+);)|\\b(const|let|var|function|return|if|else|for|while|import|from|export|class|new|async|await|def|try|catch|throw|true|false|null|undefined|this)\\b|\\b(\\d+(?:\\.\\d+)?)\\b', 'g');
    return esc(code).replace(re, (m, c, str, ent, k) => (c ? `<span class="tk-c">${m}</span>` : str ? `<span class="tk-s">${m}</span>` : ent ? m : k ? `<span class="tk-k">${m}</span>` : `<span class="tk-n">${m}</span>`));
  }
  function inline(t) {
    return esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }
  function md(src) {
    const blocks = [];
    const hold = (lang, code) => { blocks.push({ lang: lang || 'teks', code: code.replace(/\n$/, '') }); return `\n\u0000${blocks.length - 1}\u0000\n`; };
    src = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => hold(lang, code));
    const om = /(^|\n)```(\w*)\n?([\s\S]*)$/.exec(src); // fence belum ditutup (masih streaming)
    if (om) src = src.slice(0, om.index) + hold(om[2], om[3]);
    const lines = src.split('\n'); let html = '', i = 0, lastI = -1;
    while (i < lines.length) {
      if (i === lastI) { html += `<p>${inline(lines[i])}</p>`; i++; continue; } // jaring pengaman: parser pasti maju
      lastI = i;
      const L = lines[i];
      const cb = L.match(/^\u0000(\d+)\u0000$/);
      if (cb) { const b = blocks[+cb[1]]; html += `<div class="codeblock"><div class="codeblock__bar"><span>${esc(b.lang)}</span><button class="btn btn--ghost btn--sm" data-copy-code>${icon('copy', 'icon--xs')} Salin</button></div><pre><code>${/^(teks|text|txt|plain|plaintext)$/i.test(b.lang) ? esc(b.code) : highlight(b.code, b.lang)}</code></pre></div>`; i++; continue; }
      let m;
      if ((m = L.match(/^(#{1,3})\s+(.*)/))) { html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; i++; continue; }
      if (/^---+$/.test(L.trim())) { html += '<hr>'; i++; continue; }
      if (/^>\s?/.test(L)) { let q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, '')); html += `<blockquote>${inline(q.join(' '))}</blockquote>`; continue; }
      if (/^\|.+\|$/.test(L.trim()) && lines[i + 1] && /^\|[\s:\-|]+\|$/.test(lines[i + 1].trim())) {
        const head = L.trim().slice(1, -1).split('|').map((s) => s.trim()); i += 2; let rows = [];
        while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) rows.push(lines[i++].trim().slice(1, -1).split('|').map((s) => s.trim()));
        html += `<div class="table-wrap"><table class="table"><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`; continue;
      }
      if (/^\s*[-*]\s+/.test(L)) { let it = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) it.push(lines[i++].replace(/^\s*[-*]\s+/, '')); html += `<ul>${it.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`; continue; }
      if (/^\s*\d+\.\s+/.test(L)) { let it = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) it.push(lines[i++].replace(/^\s*\d+\.\s+/, '')); html += `<ol>${it.map((x) => `<li>${inline(x)}</li>`).join('')}</ol>`; continue; }
      if (!L.trim()) { i++; continue; }
      const isTable = (k) => /^\|.+\|$/.test((lines[k] || '').trim()) && lines[k + 1] && /^\|[\s:\-|]+\|$/.test(lines[k + 1].trim());
      let p = [lines[i++]]; while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|>|\s*[-*]\s|\s*\d+\.\s|---+$|\u0000)/.test(lines[i]) && !isTable(i)) p.push(lines[i++]);
      html += `<p>${inline(p.join(' '))}</p>`;
    }
    return html;
  }

  /* ═══════════════════════════════════════════════════════════════
     LAMPIRAN — unggah ke server, dapat {id,name,type,size,kind}
     ═══════════════════════════════════════════════════════════════ */
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('Gagal membaca file.'));
      r.readAsDataURL(file);
    });
  }
  function renderFileChips() {
    $('#fileChips').innerHTML = state.files.map((f, idx) => `<span class="file-chip ${f.uploading ? 'is-uploading' : ''}">${icon(f.kind === 'image' ? 'image' : 'file', 'icon--sm')}<span class="file-chip__name">${esc(f.name)}</span><small>${f.uploading ? '…' : fmtBytes(f.size)}</small>${f.uploading ? '' : `<button class="icon-btn icon-btn--sm" data-rm="${idx}" aria-label="Hapus ${esc(f.name)}">${icon('x')}</button>`}</span>`).join('');
    updateSendState();
  }
  $('#fileChips').addEventListener('click', (e) => { const r = e.target.closest('[data-rm]'); if (r) { state.files.splice(+r.dataset.rm, 1); renderFileChips(); } });
  async function addFiles(fileList) {
    for (const file of Array.from(fileList)) {
      if (file.size > state.limits.maxFileMB * 1048576) { toast(`${file.name} melebihi ${state.limits.maxFileMB} MB.`); continue; }
      const placeholder = { name: file.name, size: file.size, uploading: true, kind: file.type.startsWith('image/') ? 'image' : 'text' };
      state.files.push(placeholder); renderFileChips();
      try {
        const data = await fileToBase64(file);
        const res = await apiPost('/api/files', { name: file.name, data });
        Object.assign(placeholder, res.file, { uploading: false });
        if (placeholder.kind === 'image' && state.model && !state.model.vision) toast(`${state.model.name} tidak bisa membaca gambar. Pilih model Claude untuk memakainya.`);
      } catch (err) { state.files.splice(state.files.indexOf(placeholder), 1); toast(errMsg(err)); }
      renderFileChips();
    }
  }
  $('#btnAttach').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  { const box = $('#composerBox');
    ['dragenter', 'dragover'].forEach((ev) => box.addEventListener(ev, (e) => { e.preventDefault(); box.classList.add('is-drag'); }));
    ['dragleave', 'drop'].forEach((ev) => box.addEventListener(ev, (e) => { e.preventDefault(); box.classList.remove('is-drag'); }));
    box.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  }
  $('#chatInput').addEventListener('paste', (e) => { if (e.clipboardData.files.length) addFiles(e.clipboardData.files); });

  /* ═══════════════════════════════════════════════════════════════
     INPUT SUARA (Web Speech API — bila didukung browser)
     ═══════════════════════════════════════════════════════════════ */
  (function voice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let rec = null, on = false, base = '';
    const box = $('#composerBox');
    $('#btnVoice').addEventListener('click', () => {
      if (!SR) return toast('Browser ini belum mendukung input suara. Coba Chrome, Edge, atau Safari terbaru.');
      if (on) { rec.stop(); return; }
      const input = $('#chatInput');
      rec = new SR(); rec.lang = (state.user && state.user.settings && state.user.settings.voiceLang) || 'id-ID'; rec.interimResults = true; rec.continuous = true;
      base = input.value ? input.value + ' ' : '';
      rec.onstart = () => { on = true; $('#btnVoice').classList.add('is-active'); box.classList.add('is-recording'); };
      rec.onresult = (e) => { let t = ''; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; input.value = base + t; autoResizeInput(); updateSendState(); };
      rec.onerror = (e) => { if (e.error === 'not-allowed') toast('Izin mikrofon ditolak. Aktifkan di pengaturan browser untuk memakai input suara.'); };
      rec.onend = () => {
        on = false; $('#btnVoice').classList.remove('is-active'); box.classList.remove('is-recording');
        if (state.user && state.user.settings && state.user.settings.voiceAutoSend && $('#chatInput').value.trim()) sendMessage($('#chatInput').value);
      };
      try { rec.start(); } catch { /* sudah berjalan */ }
    });
  })();

  /* ═══════════════════════════════════════════════════════════════
     CHAT
     ═══════════════════════════════════════════════════════════════ */
  const modelName = (id) => { const m = state.models.find((x) => x.id === id); return m ? m.name : id; };
  const isImageFile = (f) => f && f.kind === 'image';

  function showChatEmpty() {
    state.conv = null;
    $('#chatEmpty').hidden = false; $('#chatInner').hidden = true; $('#chatInner').innerHTML = '';
    $$('.hist-item.is-active').forEach((el) => el.classList.remove('is-active'));
  }
  function msgHTML(m) {
    if (m.role === 'user') {
      const files = (m.files || []).map((f) => `<span class="file-chip">${icon(isImageFile(f) ? 'image' : 'file', 'icon--sm')}<span class="file-chip__name">${esc(f.name)}</span></span>`).join('');
      return `<div class="msg msg--user" data-id="${m.id || ''}"><div class="msg__body">${files ? `<div class="msg__files">${files}</div>` : ''}<div class="msg__bubble">${esc(m.content)}</div><div class="msg__actions" style="justify-content:flex-end">${m.id ? `<button class="icon-btn icon-btn--sm" data-act="copy" aria-label="Salin">${icon('copy')}</button><button class="icon-btn icon-btn--sm" data-act="edit" aria-label="Edit pesan">${icon('edit')}</button>` : ''}</div></div></div>`;
    }
    const body = m.pending && !m.content ? `<span class="typing"><i></i><i></i><i></i> Nova sedang berpikir</span>` : md(m.content || '') + (m.pending ? '<span class="cursor"></span>' : '');
    const note = m.aborted ? `<div class="msg__note">${esc(m.errorNote || 'Respons dihentikan sebelum selesai.')}</div>` : '';
    const actions = m.pending ? '' : `<div class="msg__actions"><button class="icon-btn icon-btn--sm" data-act="copy" aria-label="Salin" data-tooltip="Salin">${icon('copy')}</button><button class="icon-btn icon-btn--sm" data-act="regen" aria-label="Buat ulang" data-tooltip="Buat ulang">${icon('refresh')}</button><button class="icon-btn icon-btn--sm ${m.like === 1 ? 'is-active' : ''}" data-act="like" aria-label="Suka">${icon('up')}</button><button class="icon-btn icon-btn--sm ${m.like === -1 ? 'is-active' : ''}" data-act="dislike" aria-label="Tidak suka">${icon('dn')}</button></div>`;
    return `<div class="msg msg--ai" data-id="${m.id || ''}"><span class="msg__avatar"><svg class="logo-mark logo-mark--sm" style="width:30px;height:30px"><use href="#i-logo"/></svg></span><div class="msg__body"><div class="msg__name">Nova ${m.model ? `<span class="badge badge--sm">${esc(modelName(m.model))}</span>` : ''}</div><div class="md">${body}</div>${note}${actions}</div></div>`;
  }
  function renderMessages() {
    $('#chatInner').innerHTML = (state.conv ? state.conv.messages : []).map(msgHTML).join('');
  }
  function openConversationView(conv) {
    state.conv = conv; $('#chatEmpty').hidden = true; $('#chatInner').hidden = false;
    renderMessages(); stickBottom(true);
    $$('.hist-item').forEach((el) => el.classList.toggle('is-active', el.dataset.open === conv.id));
    const m = state.models.find((x) => x.id === conv.model); if (m) { state.model = m; if ($('#modelLabel')) renderTopbar('chat'); }
  }
  async function openConversation(id) {
    try { const { conversation } = await apiGet(`/api/conversations/${id}`); navigate('chat'); openConversationView(conversation); }
    catch (err) { toast(errMsg(err)); }
  }
  document.addEventListener('click', (e) => { const o = e.target.closest('[data-open]'); if (o && !e.target.closest('[data-stop]')) openConversation(o.dataset.open); });

  function stickBottom(force) { const s = $('#chatScroll'); if (force || s.scrollHeight - s.scrollTop - s.clientHeight < 160) s.scrollTop = s.scrollHeight; }
  $('#chatScroll').addEventListener('scroll', () => { const s = $('#chatScroll'); $('#btnScrollBottom').classList.toggle('is-visible', s.scrollHeight - s.scrollTop - s.clientHeight > 240); });
  $('#btnScrollBottom').addEventListener('click', () => $('#chatScroll').scrollTo({ top: 1e9, behavior: 'smooth' }));

  const chatInputEl = $('#chatInput');
  function autoResizeInput() { chatInputEl.style.height = 'auto'; chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 200) + 'px'; }
  function updateSendState() {
    if (state.maintenance && state.maintenance.enabled && (!state.user || state.user.role !== 'admin')) {
      const sendBtn = $('#btnSend');
      if (sendBtn) {
        sendBtn.disabled = true;
        sendBtn.title = 'Server sedang dalam pemeliharaan (maintenance)';
      }
      return;
    }
    const uploading = state.files.some((f) => f.uploading);
    $('#btnSend').disabled = !state.streaming && (uploading || (!chatInputEl.value.trim() && !state.files.length));
  }
  chatInputEl.addEventListener('input', () => { autoResizeInput(); updateSendState(); });
  let editFromId = null;
  function cancelEdit() { if (!editFromId) return; editFromId = null; const b = $('#editBanner'); if (b) b.remove(); }
  function submitComposer() {
    if ($('#btnSend').disabled) return;
    const from = editFromId; editFromId = null; const b = $('#editBanner'); if (b) b.remove();
    sendMessage(chatInputEl.value, from ? { truncateFrom: from } : {});
  }
  chatInputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitComposer(); } });
  $$('[data-suggest]').forEach((b) => b.addEventListener('click', () => sendMessage(b.dataset.suggest)));
  $('#btnNewChat').addEventListener('click', () => {
    if (state.streaming && state.abortCtrl) state.abortCtrl.abort();
    state.files = []; renderFileChips(); chatInputEl.value = ''; autoResizeInput(); updateSendState();
    navigate('chat'); showChatEmpty();
  });

  function setStreamingUI(on) {
    state.streaming = on;
    const b = $('#btnSend'); b.classList.toggle('is-stop', on);
    $('#sendIcon').outerHTML = `<svg class="icon" id="sendIcon"><use href="#i-${on ? 'stop' : 'send'}"/></svg>`;
    b.setAttribute('aria-label', on ? 'Hentikan' : 'Kirim'); b.disabled = false;
    if (!on) updateSendState();
  }
  async function refreshSidebarAfterTurn() { try { await refreshConvList(); } catch { /* sidebar tetap tampil apa adanya */ } }

  async function sendMessage(rawText, opts = {}) {
    if (state.maintenance && state.maintenance.enabled && (!state.user || state.user.role !== 'admin')) {
      const mText = state.maintenance.message || 'Server sedang dalam pemeliharaan (maintenance).';
      toast('Server sedang maintenance: ' + mText, 'warning');
      return;
    }
    if (state.streaming) return;
    const text = String(rawText || '').trim();
    const readyFiles = state.files.filter((f) => !f.uploading);
    if (!opts.regenerate && !text && !readyFiles.length) return;
    if (state.files.some((f) => f.uploading)) return toast('Tunggu lampiran selesai diunggah.');
    const model = state.model || state.models[0]; if (!model) return toast('Tidak ada model tersedia.');
    function lastUserFiles() {
      if (!state.conv) return [];
      for (let i = state.conv.messages.length - 1; i >= 0; i--) if (state.conv.messages[i].role === 'user') return state.conv.messages[i].files || [];
      return [];
    }
    const imageInPlay = (opts.regenerate ? lastUserFiles() : readyFiles).some(isImageFile);
    if (imageInPlay && !model.vision) return toast(`${model.name} tidak bisa membaca gambar. Pilih model Claude, atau hapus gambar dari pesan.`);

    $('#chatEmpty').hidden = true; $('#chatInner').hidden = false;
    if (!state.conv) state.conv = { id: null, title: 'Percakapan baru', model: model.id, messages: [] };

    if (opts.truncateFrom) { const i = state.conv.messages.findIndex((m) => m.id === opts.truncateFrom); if (i >= 0) state.conv.messages = state.conv.messages.slice(0, i); }
    const fileMeta = readyFiles.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size, kind: f.kind }));
    let localUser = null;
    if (!opts.regenerate) { localUser = { id: null, role: 'user', content: text, files: fileMeta, createdAt: Date.now() }; state.conv.messages.push(localUser); }
    else if (state.conv.messages.length && state.conv.messages[state.conv.messages.length - 1].role === 'assistant') state.conv.messages.pop();
    const aiMsg = { id: null, role: 'assistant', content: '', pending: true, model: model.id, createdAt: Date.now() };
    state.conv.messages.push(aiMsg);
    renderMessages(); stickBottom(true);
    state.files = []; renderFileChips();
    chatInputEl.value = ''; autoResizeInput(); updateSendState();

    const ctrl = new AbortController(); state.abortCtrl = ctrl; let userAborted = false;
    setStreamingUI(true);
    const payload = { model: model.id, text, fileIds: fileMeta.map((f) => f.id) };
    if (state.conv.id) payload.conversationId = state.conv.id;
    if (opts.regenerate) payload.regenerate = true;
    if (opts.truncateFrom) payload.truncateFrom = opts.truncateFrom;

    let aiNode = null, isNewConv = false;
    try {
      const res = await fetch('/api/chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal, body: JSON.stringify(payload) });
      if (!res.ok) { let msg = `Permintaan gagal (${res.status}).`; try { msg = (await res.json()).error || msg; } catch { /* tanpa body json */ } throw new ApiError(res.status, msg); }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = raw.split('\n').find((l) => l.startsWith('data:')); if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === 'meta') {
            isNewConv = ev.isNew;
            state.conv.id = ev.conversationId; state.conv.title = ev.title;
            if (localUser) localUser.id = ev.userMessageId;
            aiMsg.id = ev.assistantMessageId;
            aiNode = $(`.msg[data-id="${aiMsg.id}"] .md, #chatInner .msg--ai:last-child .md`);
            if (localUser) { const un = $(`#chatInner .msg--user:last-child`); if (un) un.dataset.id = localUser.id || ''; }
          } else if (ev.type === 'delta') {
            aiMsg.content += ev.t;
            if (!aiNode) aiNode = $('#chatInner .msg--ai:last-child .md');
            if (aiNode) { aiNode.innerHTML = md(aiMsg.content) + '<span class="cursor"></span>'; stickBottom(); }
          } else if (ev.type === 'error') {
            aiMsg.aborted = true; aiMsg.errorNote = ev.message;
            if (!ev.partial) { state.conv.messages.pop(); toast(ev.message); }
          }
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) { userAborted = true; aiMsg.aborted = true; aiMsg.errorNote = 'Dihentikan.'; }
      else { aiMsg.aborted = true; aiMsg.errorNote = errMsg(err); if (!aiMsg.content) { state.conv.messages.pop(); toast(errMsg(err)); } }
    }
    aiMsg.pending = false; state.abortCtrl = null; setStreamingUI(false);
    renderMessages(); stickBottom(true);
    if (isNewConv && state.conv.id) refreshSidebarAfterTurn(); else if (state.conv.id) refreshSidebarAfterTurn();
    void userAborted;
  }
  $('#btnSend').addEventListener('click', () => { if (state.streaming) { if (state.abortCtrl) state.abortCtrl.abort(); } else submitComposer(); });

  document.addEventListener('click', async (e) => {
    const cc = e.target.closest('[data-copy-code]');
    if (cc) {
      const code = cc.closest('.codeblock').querySelector('code').innerText;
      try { await navigator.clipboard.writeText(code); cc.innerHTML = `${icon('check', 'icon--xs')} Tersalin`; setTimeout(() => (cc.innerHTML = `${icon('copy', 'icon--xs')} Salin`), 1500); } catch { toast('Tidak bisa menyalin di browser ini.'); }
      return;
    }
    const a = e.target.closest('#chatInner [data-act]'); if (!a || !state.conv) return;
    const row = a.closest('.msg'); const id = row.dataset.id; const m = state.conv.messages.find((x) => x.id === id);
    if (a.dataset.act === 'copy') { try { await navigator.clipboard.writeText(m ? m.content : row.querySelector('.msg__bubble,.md').innerText); toast('Tersalin ke papan klip.', 'success'); } catch { toast('Tidak bisa menyalin di browser ini.'); } }
    if (a.dataset.act === 'like' && m) { m.like = m.like === 1 ? 0 : 1; try { await apiPatch(`/api/conversations/${state.conv.id}/messages/${m.id}`, { like: m.like }); } catch { /* tampilan tetap berubah secara lokal */ } renderMessages(); }
    if (a.dataset.act === 'dislike' && m) { m.like = m.like === -1 ? 0 : -1; try { await apiPatch(`/api/conversations/${state.conv.id}/messages/${m.id}`, { like: m.like }); } catch { /* abaikan */ } renderMessages(); }
    if (a.dataset.act === 'regen' && !state.streaming) sendMessage(null, { regenerate: true });
    if (a.dataset.act === 'edit' && !state.streaming && m && id) {
      cancelEdit(); editFromId = id; chatInputEl.value = m.content; autoResizeInput(); updateSendState(); chatInputEl.focus();
      $('#composerBox').insertAdjacentHTML('beforebegin', `<div class="edit-banner" id="editBanner"><span>${icon('edit', 'icon--xs')} Mengedit pesan — riwayat setelahnya akan diganti</span><button type="button" id="editCancel">${icon('x', 'icon--xs')}</button></div>`);
      $('#editCancel').addEventListener('click', () => { cancelEdit(); chatInputEl.value = ''; autoResizeInput(); updateSendState(); });
    }
  });

  /* ═══════════════════════════════════════════════════════════════
     RIWAYAT — sidebar & halaman Riwayat berbagi satu daftar (state.convList)
     ═══════════════════════════════════════════════════════════════ */
  async function refreshConvList() {
    const { conversations } = await apiGet('/api/conversations');
    state.convList = conversations;
    renderSidebarHistory($('#sideSearch') ? $('#sideSearch').value : '');
    if (state.page === 'history') renderHistoryList();
  }
  function dayBucket(ts) {
    const now = new Date(); const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.floor((start(now) - start(new Date(ts))) / 86400000);
    return diff <= 0 ? 0 : diff === 1 ? 1 : diff <= 7 ? 7 : 999;
  }
  function renderSidebarHistory(filter = '') {
    const q = filter.trim().toLowerCase();
    const list = state.convList.filter((c) => !c.archived && (!q || (c.title + ' ' + c.snippet).toLowerCase().includes(q)));
    const groups = [['Disematkan', (c) => c.pinned], ['Hari ini', (c) => !c.pinned && dayBucket(c.updatedAt) === 0], ['Kemarin', (c) => !c.pinned && dayBucket(c.updatedAt) === 1], ['7 Hari Terakhir', (c) => !c.pinned && dayBucket(c.updatedAt) === 7], ['Lebih Lama', (c) => !c.pinned && dayBucket(c.updatedAt) === 999]];
    const box = $('#sideHistory'); if (!box) return;
    box.innerHTML = groups.map(([label, fn]) => {
      const items = list.filter(fn); if (!items.length) return '';
      return `<div class="hist-group"><div class="hist-group__label">${label}</div>${items.map((c) => `<button class="hist-item ${state.conv && state.conv.id === c.id ? 'is-active' : ''}" data-open="${c.id}">${c.pinned ? icon('pin', 'icon--xs') : ''}<span>${esc(c.title)}</span></button>`).join('')}</div>`;
    }).join('') || `<p class="empty-inline">${q ? 'Tidak ada hasil.' : 'Belum ada percakapan.'}</p>`;
  }
  const sideSearchEl = $('#sideSearch'); if (sideSearchEl) sideSearchEl.addEventListener('input', (e) => renderSidebarHistory(e.target.value));

  function convRow(c) {
    return `<div class="conv ${state.selected.has(c.id) ? 'is-selected' : ''}" data-id="${c.id}"><label class="checkbox conv__check" data-stop><input type="checkbox" ${state.selected.has(c.id) ? 'checked' : ''} data-sel="${c.id}" aria-label="Pilih ${esc(c.title)}"><span class="checkbox__box">${icon('check')}</span></label><div class="conv__main"><div class="conv__title">${c.pinned ? icon('pin', 'icon--xs') : ''}<span>${esc(c.title)}</span></div><div class="conv__snip">${esc(c.snippet || 'Belum ada pesan')}</div></div><div class="conv__meta"><span class="badge badge--sm">${esc(modelName(c.model))}</span><span>${fmtDate(c.updatedAt)}</span></div><div class="dropdown-host" data-stop><button class="icon-btn icon-btn--sm" data-conv-menu="${c.id}" aria-label="Opsi">${icon('dots')}</button><div class="dropdown" id="cm-${c.id}"><button class="dropdown__item" data-cact="open" data-id="${c.id}">${icon('chat')} Buka</button><button class="dropdown__item" data-cact="rename" data-id="${c.id}">${icon('edit')} Ganti nama</button><button class="dropdown__item" data-cact="pin" data-id="${c.id}">${icon('pin')} ${c.pinned ? 'Lepas sematan' : 'Sematkan'}</button><button class="dropdown__item" data-cact="archive" data-id="${c.id}">${icon('archive')} ${c.archived ? 'Batalkan arsip' : 'Arsipkan'}</button><div class="dropdown__sep"></div><button class="dropdown__item dropdown__item--danger" data-cact="delete" data-id="${c.id}">${icon('trash')} Hapus</button></div></div></div>`;
  }
  function renderHistoryList() {
    const q = $('#histSearch').value.trim().toLowerCase(), d = $('#histDate').value, mdl = $('#histModel').value;
    const list = state.convList.filter((c) => {
      if (mdl === 'archived') { /* ditangani oleh filter tanggal khusus di bawah */ }
      if (d !== 'archived' && c.archived) return false;
      if (d === 'archived' && !c.archived) return false;
      if (q && !(c.title + ' ' + c.snippet).toLowerCase().includes(q)) return false;
      if (mdl !== 'all' && mdl !== 'archived' && c.model !== mdl) return false;
      if (!['all', 'archived'].includes(d)) { const b = dayBucket(c.updatedAt); if (d === 'today' && b !== 0) return false; if (d === 'week' && b > 7) return false; if (d === 'older' && b !== 999) return false; }
      return true;
    }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    const el = $('#convList'); el.classList.toggle('select-mode', state.selectMode);
    if (!list.length) { el.innerHTML = `<div class="empty-state"><div class="empty-state__icon">${icon(q ? 'search' : 'chat', 'icon--lg')}</div><h3>${q ? 'Tidak ada hasil' : 'Belum ada percakapan'}</h3><p>${q ? `Tidak ditemukan percakapan untuk “${esc(q)}”.` : 'Mulai chat baru dan riwayatmu akan muncul di sini.'}</p></div>`; return; }
    el.innerHTML = list.map(convRow).join(''); updateBulkBar();
  }
  async function loadHistory() {
    if (!$('#histModel').dataset.filled) {
      $('#histModel').insertAdjacentHTML('beforeend', state.models.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join(''));
      $('#histModel').dataset.filled = '1';
    }
    $('#convList').innerHTML = `<div class="empty-inline">Memuat…</div>`;
    try { await refreshConvList(); } catch (err) { $('#convList').innerHTML = `<div class="empty-inline">${esc(errMsg(err))}</div>`; }
  }
  ['input', 'change'].forEach((ev) => { $('#histSearch').addEventListener(ev, renderHistoryList); $('#histDate').addEventListener(ev, renderHistoryList); $('#histModel').addEventListener(ev, renderHistoryList); });
  function updateBulkBar() { $('#bulkbar').classList.toggle('is-visible', state.selectMode); $('#bulkCount').textContent = state.selected.size + ' dipilih'; }
  $('#btnSelectMode').addEventListener('click', () => { state.selectMode = !state.selectMode; state.selected.clear(); renderHistoryList(); });
  $('#bulkCancel').addEventListener('click', () => { state.selectMode = false; state.selected.clear(); renderHistoryList(); });
  $('#bulkDelete').addEventListener('click', () => {
    if (!state.selected.size) return toast('Pilih percakapan terlebih dahulu.');
    const n = state.selected.size;
    openModal({ title: `Hapus ${n} percakapan?`, body: 'Tindakan ini tidak dapat dibatalkan.', confirm: 'Hapus', onConfirm: async () => {
      await apiPost('/api/conversations/bulk-delete', { ids: [...state.selected] });
      state.selected.clear(); state.selectMode = false; await refreshConvList(); toast('Percakapan dihapus.', 'success');
    } });
  });
  $('#convList').addEventListener('click', (e) => {
    const cm = e.target.closest('[data-conv-menu]');
    if (cm) { e.stopPropagation(); const d = $(`#cm-${cm.dataset.convMenu}`), o = d.classList.contains('is-open'); closeDropdowns(); d.classList.toggle('is-open', !o); return; }
    const ca = e.target.closest('[data-cact]');
    if (ca) { closeDropdowns(); convAction(ca.dataset.cact, ca.dataset.id); return; }
    const sel = e.target.closest('[data-sel]');
    if (sel) { const id = sel.dataset.sel; sel.checked ? state.selected.add(id) : state.selected.delete(id); sel.closest('.conv').classList.toggle('is-selected', sel.checked); updateBulkBar(); return; }
    if (e.target.closest('[data-stop]')) return;
    const row = e.target.closest('.conv'); if (!row) return;
    if (state.selectMode) { const cb = row.querySelector('[data-sel]'); cb.checked = !cb.checked; cb.dispatchEvent(new Event('click', { bubbles: true })); }
    else openConversation(row.dataset.id);
  });
  async function convAction(act, id) {
    const c = state.convList.find((x) => x.id === id); if (!c) return;
    try {
      if (act === 'open') return openConversation(id);
      if (act === 'pin') { await apiPatch(`/api/conversations/${id}`, { pinned: !c.pinned }); await refreshConvList(); }
      else if (act === 'archive') { await apiPatch(`/api/conversations/${id}`, { archived: !c.archived }); await refreshConvList(); toast(c.archived ? 'Percakapan dibatalkan dari arsip.' : 'Percakapan diarsipkan.', 'success'); }
      else if (act === 'rename') openModal({ title: 'Ganti nama percakapan', body: 'Masukkan judul baru.', iconName: 'edit', danger: false, confirm: 'Simpan', input: c.title, onConfirm: async (v) => { if (!v || !v.trim()) throw new ApiError(400, 'Judul tidak boleh kosong.'); await apiPatch(`/api/conversations/${id}`, { title: v.trim() }); await refreshConvList(); toast('Nama diperbarui.', 'success'); } });
      else if (act === 'delete') openModal({ title: 'Hapus percakapan?', body: `“${esc(c.title)}” akan dihapus permanen.`, confirm: 'Hapus', onConfirm: async () => { await apiDelete(`/api/conversations/${id}`); if (state.conv && state.conv.id === id) showChatEmpty(); await refreshConvList(); toast('Percakapan dihapus.', 'success'); } });
    } catch (err) { toast(errMsg(err)); }
  }

  /* ═══════════════════════════════════════════════════════════════
     PENGATURAN
     ═══════════════════════════════════════════════════════════════ */
  function renderSettings() {
    const u = state.user; if (!u) return;
    $('#stName').value = u.name || ''; $('#stEmail').value = u.email || ''; $('#stBio').value = u.bio || '';
    $('#avatarPreview').style.backgroundImage = u.avatar ? `url(${u.avatar})` : ''; $('#avatarPreview').textContent = u.avatar ? '' : initials(u.name);
    $('#selDefaultModel').value = u.settings.defaultModel; $('#selStyle').value = u.settings.style; $('#selLang').value = u.settings.language; $('#selVoiceLang').value = u.settings.voiceLang;
    $('#swStreaming').checked = !!u.settings.streaming; $('#swVoice').checked = !!u.settings.voice; $('#swVoiceAuto').checked = !!u.settings.voiceAutoSend;
    const r = $(`#themeGrid input[value="${(function () { try { return localStorage.getItem('nova:theme') || 'dark'; } catch { return 'dark'; } })()}"]`); if (r) r.checked = true;
    $('#rngTemp').value = Math.round(u.settings.temperature * 100); paintRange();
  }
  $$('#settingsTabs button').forEach((b) => b.addEventListener('click', () => {
    $$('#settingsTabs button').forEach((x) => x.classList.toggle('is-active', x === b));
    $$('.settings__pane').forEach((p) => p.classList.toggle('is-active', p.dataset.spane === b.dataset.stab));
  }));
  const rngTemp = $('#rngTemp'); function paintRange() { rngTemp.style.setProperty('--pct', rngTemp.value + '%'); $('#rngTempVal').textContent = (rngTemp.value / 100).toFixed(1); }
  rngTemp.addEventListener('input', paintRange);
  rngTemp.addEventListener('change', () => saveSettings({ temperature: rngTemp.value / 100 }));
  $('#selFont').addEventListener('change', (e) => (document.documentElement.style.fontSize = e.target.value + 'px'));
  async function saveSettings(patch) {
    try { const { settings } = await apiPatch('/api/me/settings', patch); state.user.settings = settings; if ('defaultModel' in patch) { const m = state.models.find((x) => x.id === settings.defaultModel); if (m) state.model = m; } }
    catch (err) { toast(errMsg(err)); renderSettings(); }
  }
  $('#selDefaultModel').addEventListener('change', (e) => saveSettings({ defaultModel: e.target.value }));
  $('#selStyle').addEventListener('change', (e) => saveSettings({ style: e.target.value }));
  $('#selLang').addEventListener('change', (e) => saveSettings({ language: e.target.value }));
  $('#selVoiceLang').addEventListener('change', (e) => saveSettings({ voiceLang: e.target.value }));
  $('#swStreaming').addEventListener('change', (e) => saveSettings({ streaming: e.target.checked }));
  $('#swVoice').addEventListener('change', (e) => saveSettings({ voice: e.target.checked }));
  $('#swVoiceAuto').addEventListener('change', (e) => saveSettings({ voiceAutoSend: e.target.checked }));

  $('#btnSaveProfile').addEventListener('click', async () => {
    const btn = $('#btnSaveProfile'); btn.classList.add('is-loading');
    try { const { user } = await apiPatch('/api/me', { name: $('#stName').value.trim(), bio: $('#stBio').value }); state.user = { ...state.user, ...user }; applyAuthUI(); toast('Perubahan disimpan.', 'success'); }
    catch (err) { toast(errMsg(err)); } finally { btn.classList.remove('is-loading'); }
  });
  function resizeImageToSquare(file, size = 256) {
    return new Promise((resolve, reject) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const s = Math.min(img.width, img.height); const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
        canvas.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Gagal membaca gambar.')); };
      img.src = url;
    });
  }
  $('#btnAvatar').addEventListener('click', () => $('#avatarInput').click());
  $('#avatarInput').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    try {
      const dataUrl = await resizeImageToSquare(file);
      const { user } = await apiPatch('/api/me', { avatar: dataUrl });
      state.user.avatar = user.avatar; applyAuthUI(); renderSettings(); toast('Foto profil diperbarui.', 'success');
    } catch (err) { toast(errMsg(err)); }
  });
  $('#btnChangePass').addEventListener('click', () => {
    $('#modalTitle'); openModal({
      title: 'Ubah kata sandi', iconName: 'lock', danger: false, confirm: 'Ubah',
      body: `<div class="field"><label class="field__label">Kata sandi saat ini</label><input class="input" id="mCurrent" type="password" autocomplete="current-password"></div><div class="field" style="margin-top:14px"><label class="field__label">Kata sandi baru</label><input class="input" id="mNext" type="password" autocomplete="new-password" placeholder="Minimal 8 karakter"></div>`,
      onConfirm: async () => {
        const cur = $('#mCurrent').value, next = $('#mNext').value;
        if (next.length < 8) throw new ApiError(400, 'Kata sandi baru minimal 8 karakter.');
        await apiPost('/api/me/password', { current: cur, next }); toast('Kata sandi diperbarui.', 'success');
      },
    });
  });
  $('#btnLogoutAll').addEventListener('click', () => openModal({ title: 'Keluar dari semua perangkat?', body: 'Semua sesi lain (termasuk di perangkat lain) akan diminta masuk ulang.', confirm: 'Keluar semua', iconName: 'logout', onConfirm: async () => { await apiPost('/api/auth/logout-all'); toast('Berhasil keluar dari semua perangkat lain.', 'success'); } }));
  $('#btnExport').addEventListener('click', () => { const a = document.createElement('a'); a.href = '/api/me/export'; a.download = 'nova-ai-data.json'; document.body.appendChild(a); a.click(); a.remove(); });
  $('#btnClearAll').addEventListener('click', () => openModal({ title: 'Hapus semua riwayat?', body: 'Seluruh percakapanmu akan dihapus permanen.', confirm: 'Hapus semua', onConfirm: async () => { await apiDelete('/api/conversations'); showChatEmpty(); await refreshConvList(); toast('Riwayat dihapus.', 'success'); } }));
  $('#btnDeleteAccount').addEventListener('click', () => openModal({
    title: 'Hapus akun?', iconName: 'trash', confirm: 'Hapus akun', input: '',
    body: 'Akun, percakapan, dan file akan dihapus permanen. Ketik <strong>HAPUS</strong> untuk melanjutkan.',
    onConfirm: async (v) => {
      if ((v || '').trim() !== 'HAPUS') throw new ApiError(400, 'Ketik HAPUS (huruf besar) untuk konfirmasi.');
      await apiDelete('/api/me', { confirm: 'HAPUS' }); state.user = null; state.conv = null; state.convList = []; applyAuthUI(); navigate('landing'); toast('Akun telah dihapus.', 'success');
    },
  }));

  /* ═══════════════════════════════════════════════════════════════
     HARGA — hanya kosmetik (Pro/Enterprise belum tersedia)
     ═══════════════════════════════════════════════════════════════ */
  $$('#billing button').forEach((b) => b.addEventListener('click', () => {
    $$('#billing button').forEach((x) => x.classList.toggle('is-active', x === b));
    const y = b.dataset.bill === 'yearly'; $('[data-price-pro]').textContent = y ? 'Rp79rb' : 'Rp99rb'; $('[data-price-unit]').textContent = y ? '/bulan, ditagih tahunan' : '/bulan';
  }));

  /* ═══════════════════════════════════════════════════════════════
     DASHBOARD
     ═══════════════════════════════════════════════════════════════ */
  let statsCache = null, chartRange = 7;
  function drawLine(range) {
    const rows = statsCache.activity[range]; const d = rows.map((r) => r.count);
    const W = 640, H = 240, p = { l: 34, r: 10, t: 12, b: 26 }, max = Math.max(1, ...d) * 1.15, iw = W - p.l - p.r, ih = H - p.t - p.b;
    const X = (i) => p.l + (d.length > 1 ? (i / (d.length - 1)) * iw : iw / 2), Y = (v) => p.t + ih - (v / max) * ih;
    const pts = d.map((v, i) => [X(i), Y(v)]); const path = pts.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' ');
    let g = ''; for (let i = 0; i <= 4; i++) { const y = p.t + (ih / 4) * i; g += `<line class="grid-line" x1="${p.l}" x2="${W - p.r}" y1="${y}" y2="${y}"/><text x="${p.l - 8}" y="${y + 4}" text-anchor="end">${Math.round(max - (max / 4) * i)}</text>`; }
    let xl = ''; rows.forEach((r, i) => { if (range === 7 || i % 5 === 0) xl += `<text x="${X(i)}" y="${H - 6}" text-anchor="middle">${range === 7 ? new Date(r.date).toLocaleDateString('id-ID', { weekday: 'short' }) : new Date(r.date).getDate()}</text>`; });
    const svg = $('#lineChart'); svg.innerHTML = `<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".18"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>${g}${xl}<path class="area" d="${path} L${X(d.length - 1)} ${p.t + ih} L${X(0)} ${p.t + ih}Z" style="color:var(--text-primary)"/><path class="line" d="${path}" id="mainLine"/>${pts.map((q, i) => `<circle cx="${q[0]}" cy="${q[1]}" r="3.5" fill="var(--bg-card)" stroke="var(--text-primary)" stroke-width="1.8"><title>${d[i]} pesan · ${rows[i].date}</title></circle>`).join('')}`;
    const ln = $('#mainLine'); if (ln && !prefersReduced && d.some((v) => v > 0)) { const L = ln.getTotalLength(); ln.style.strokeDasharray = L; ln.style.strokeDashoffset = L; void ln.getBoundingClientRect(); ln.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.4,0,.2,1)'; ln.style.strokeDashoffset = 0; }
  }
  function drawBars() {
    const items = statsCache.modelUsage.length ? statsCache.modelUsage : [{ name: 'Belum ada data', pct: 0 }];
    const W = 320, H = 240, bw = Math.min(56, (W - 40) / items.length - 10), gap = items.length > 1 ? (W - 40 - items.length * bw) / (items.length - 1) : 0, max = Math.max(20, ...items.map((i) => i.pct));
    $('#barChart').innerHTML = `${[0, 1, 2, 3].map((i) => `<line class="grid-line" x1="20" x2="${W - 20}" y1="${20 + i * 50}" y2="${20 + i * 50}"/>`).join('')}${items.map((it, i) => { const h = (it.pct / max) * 170, x = 20 + i * (bw + gap); const label = it.name.length > 10 ? it.name.slice(0, 9) + '…' : it.name; return `<rect class="bar" x="${x}" y="${190 - h}" width="${bw}" height="${h}" rx="8"><title>${esc(it.name)}: ${it.pct}%</title></rect><text x="${x + bw / 2}" y="${188 - h - 6}" text-anchor="middle" style="fill:var(--text-secondary)">${it.pct}%</text><text x="${x + bw / 2}" y="214" text-anchor="middle">${esc(label)}</text>`; }).join('')}`;
  }
  function animateCount(el, to, suffix = '') {
    if (prefersReduced) { el.textContent = to.toLocaleString('id-ID') + suffix; return; }
    const t0 = performance.now();
    (function step(t) { const p = Math.min((t - t0) / 900, 1), e = 1 - Math.pow(1 - p, 3); el.textContent = Math.round(to * e).toLocaleString('id-ID') + suffix; if (p < 1) requestAnimationFrame(step); })(t0);
  }
  const pctDelta = (cur, prev) => (prev === 0 ? (cur > 0 ? '▲ baru bulan ini' : '&nbsp;') : `${cur >= prev ? '▲' : '▼'} ${Math.abs(Math.round(((cur - prev) / prev) * 100))}% dari bulan lalu`);
  async function loadDashboard() {
    try { statsCache = await apiGet('/api/stats'); } catch (err) { toast(errMsg(err)); return; }
    const t = statsCache.totals;
    animateCount($('#stChats'), t.chats); $('#stChatsDelta').innerHTML = pctDelta(t.chatsCur, t.chatsPrev);
    animateCount($('#stMsgs'), t.msgCur); $('#stMsgsDelta').innerHTML = pctDelta(t.msgCur, t.msgPrev);
    animateCount($('#stTokens'), t.tokCur); $('#stTokensDelta').innerHTML = pctDelta(t.tokCur, t.tokPrev);
    $('#stFav').textContent = statsCache.favorite ? statsCache.favorite.name : '–'; $('#stFavSub').textContent = statsCache.favorite ? `${statsCache.favorite.pct}% dari semua jawaban` : 'Belum ada data';
    chartRange = 7; $$('#rangeSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.range === '7'));
    drawLine(7); drawBars();
    $('#activityBody').innerHTML = statsCache.recent.length ? statsCache.recent.map((c) => `<tr><td>${esc(c.title)}</td><td><span class="badge badge--sm">${esc(c.model)}</span></td><td>${fmtDate(c.updatedAt)}</td></tr>`).join('') : `<tr><td colspan="3" class="empty-inline">Belum ada percakapan.</td></tr>`;
    const q = statsCache.quota;
    $('#qMsgs').textContent = `${q.usedToday} / ${q.dailyLimit}`; $('#qMsgsBar').style.width = Math.min(100, (q.usedToday / q.dailyLimit) * 100) + '%';
    $('#qStore').textContent = `${fmtBytes(q.storageBytes)} / ${fmtBytes(q.storageLimitBytes)}`; $('#qStoreBar').style.width = Math.min(100, (q.storageBytes / q.storageLimitBytes) * 100) + '%';
    $('#qConvs').textContent = q.conversations;
    $('#fileList').innerHTML = statsCache.files.length ? statsCache.files.map((f) => `<div class="file-row" data-file="${f.id}"><span class="file-row__ico">${icon(f.kind === 'image' ? 'image' : 'file', 'icon--sm')}</span><div class="file-row__txt"><strong>${esc(f.name)}</strong><span>${fmtBytes(f.size)} · ${fmtDate(f.createdAt)}</span></div><button class="icon-btn icon-btn--sm" data-del-file="${f.id}" aria-label="Hapus file">${icon('trash')}</button></div>`).join('') : `<div class="empty-inline">Belum ada file diunggah.</div>`;
  }
  $$('#rangeSeg button').forEach((b) => b.addEventListener('click', () => { $$('#rangeSeg button').forEach((x) => x.classList.toggle('is-active', x === b)); chartRange = +b.dataset.range; drawLine(chartRange); }));
  $('#fileList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-file]'); if (!b) return;
    try { await apiDelete(`/api/files/${b.dataset.delFile}`); b.closest('.file-row').remove(); toast('File dihapus.', 'success'); } catch (err) { toast(errMsg(err)); }
  });

  /* ═══════════════════════════════════════════════════════════════
     AUTENTIKASI
     ═══════════════════════════════════════════════════════════════ */
  function setAuthTab(tab) {
    $('#authTabs').dataset.tab = tab;
    $$('[data-auth-switch]').forEach((b) => b.classList.toggle('is-active', b.dataset.authSwitch === tab));
    $('#formLogin').classList.toggle('is-active', tab === 'login');
    $('#formRegister').classList.toggle('is-active', tab === 'register');
    $('#authTitle').textContent = tab === 'login' ? 'Selamat datang kembali' : 'Buat akun Nova';
    $('#authLead').textContent = tab === 'login' ? 'Masuk untuk melanjutkan percakapanmu dengan Nova.' : 'Mulai gratis — tanpa kartu kredit.';
  }
  $$('[data-auth-switch]').forEach((b) => b.addEventListener('click', () => setAuthTab(b.dataset.authSwitch)));
  $$('[data-toggle-pass]').forEach((b) => b.addEventListener('click', () => {
    const inp = b.parentElement.querySelector('input'); const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password'; b.innerHTML = icon(show ? 'eyeoff' : 'eye'); b.setAttribute('aria-label', show ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi');
  }));

  const FIELD_RULES = {
    email: (v) => (!v ? 'Email wajib diisi.' : !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? 'Format email belum valid.' : ''),
    password: (v) => (!v ? 'Kata sandi wajib diisi.' : v.length < 8 ? 'Minimal 8 karakter.' : ''),
    name: (v) => (v.trim().length < 2 ? 'Nama minimal 2 karakter.' : v.trim().length > 60 ? 'Nama maksimal 60 karakter.' : ''),
    confirm: (v, form) => (v !== $('input[data-validate="password"]', form).value ? 'Kata sandi tidak cocok.' : v ? '' : 'Konfirmasi wajib diisi.'),
  };
  function validateField(inp, form) {
    const f = inp.closest('.field'), msg = FIELD_RULES[inp.dataset.validate](inp.value, form);
    f.classList.remove('is-error', 'is-success'); void f.offsetWidth;
    f.classList.add(msg ? 'is-error' : 'is-success'); f.querySelector('.field__msg span').textContent = msg || 'Terlihat bagus.';
    return !msg;
  }
  function formError(form, msg) {
    let e = form.querySelector('.form-error');
    if (!e) { e = document.createElement('div'); e.className = 'form-error modal__error'; e.style.marginBottom = '16px'; form.insertBefore(e, form.firstChild); }
    e.textContent = msg;
  }
  $$('.auth__form').forEach((form) => {
    $$('[data-validate]', form).forEach((inp) => {
      inp.addEventListener('blur', () => inp.value && validateField(inp, form));
      inp.addEventListener('input', () => { if (inp.closest('.field').classList.contains('is-error')) validateField(inp, form); });
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fe = form.querySelector('.form-error'); if (fe) fe.remove();
      let ok = true; $$('[data-validate]', form).forEach((i) => { if (!validateField(i, form)) ok = false; });
      if (form.dataset.form === 'register' && !$('#rgTerms').checked) { ok = false; toast('Setujui syarat layanan untuk melanjutkan.'); }
      if (!ok) return;
      const btn = $('button[type="submit"]', form); btn.classList.add('is-loading'); btn.disabled = true;
      try {
        let data;
        if (form.dataset.form === 'login') data = await apiPost('/api/auth/login', { email: $('#lgEmail').value.trim(), password: $('#lgPass').value, remember: $('#lgRemember').checked });
        else data = await apiPost('/api/auth/register', { name: $('#rgName').value.trim(), email: $('#rgEmail').value.trim(), password: $('#rgPass').value });
        state.user = data.user; applyAuthUI();
        toast(form.dataset.form === 'login' ? 'Berhasil masuk. Selamat datang!' : 'Akun berhasil dibuat.', 'success');
        const next = state.pendingNav || 'chat'; state.pendingNav = null; navigate(next);
        form.reset(); $$('.field', form).forEach((f) => f.classList.remove('is-error', 'is-success'));
      } catch (err) { formError(form, errMsg(err)); }
      finally { btn.classList.remove('is-loading'); btn.disabled = false; }
    });
  });
  $('#btnLogout').addEventListener('click', async () => {
    try { await apiPost('/api/auth/logout'); } catch { /* tetap lanjut membersihkan sisi klien */ }
    state.user = null; state.conv = null; state.convList = []; applyAuthUI(); navigate('landing');
    toast('Kamu telah keluar.');
  });

  /* ═══════════════════════════════════════════════════════════════
     MODEL & TOPBAR
     ═══════════════════════════════════════════════════════════════ */
  function populateModelControls() {
    const sel = $('#selDefaultModel');
    if (sel) sel.innerHTML = state.models.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    applyLimitsToPricing();
  }
  function applyLimitsToPricing() {
    $$('[data-limit="dailyMessages"]').forEach((el) => (el.textContent = state.limits.dailyMessages));
    $$('[data-limit="maxFileMB"]').forEach((el) => (el.textContent = state.limits.maxFileMB));
  }
  function renderTopbar(id) {
    const box = $('#topbarLeft');
    if (id === 'chat') {
      const m = state.model || state.models[0];
      box.innerHTML = `<div class="model-picker dropdown-host"><button class="model-picker__btn" id="modelBtn" aria-haspopup="true" aria-expanded="false">${icon(m ? m.icon : 'spark', 'icon--sm')}<span id="modelLabel">${esc(m ? m.name : '')}</span>${icon('chev', 'icon--sm')}</button><div class="dropdown dropdown--left model-menu" id="modelMenu">${state.models.map((mo) => `<button class="model-opt ${m && mo.id === m.id ? 'is-selected' : ''}" data-model="${esc(mo.id)}"><span class="model-opt__ico">${icon(mo.icon, 'icon--sm')}</span><span class="model-opt__txt"><strong>${esc(mo.name)} ${mo.badge ? `<span class="badge badge--sm">${esc(mo.badge)}</span>` : ''}</strong><span>${esc(mo.desc)}</span></span>${icon('check', 'check icon--sm')}</button>`).join('')}</div></div>`;
      $('#modelBtn').addEventListener('click', (e) => { e.stopPropagation(); const d = $('#modelMenu'), o = d.classList.contains('is-open'); closeDropdowns(); d.classList.toggle('is-open', !o); $('#modelBtn').setAttribute('aria-expanded', !o); });
      $$('#modelMenu .model-opt').forEach((b) => b.addEventListener('click', () => {
        const picked = state.models.find((x) => x.id === b.dataset.model); if (!picked) return;
        if (state.files.some((f) => f.kind === 'image') && !picked.vision) { toast(`${picked.name} tidak bisa membaca gambar. Hapus gambar terlampir dulu, atau pilih model lain.`); return; }
        state.model = picked; $('#modelLabel').textContent = picked.name; $('#modelBtn').firstElementChild.outerHTML = icon(picked.icon, 'icon--sm');
        $$('#modelMenu .model-opt').forEach((x) => x.classList.toggle('is-selected', x === b)); closeDropdowns();
      }));
    } else box.innerHTML = `<span class="topbar__title">${TITLES[id] || ''}</span>`;
  }

  /* ═══════════════════════════════════════════════════════════════
     BOOT — sesi & daftar model dimuat sebelum aplikasi siap dipakai
     ═══════════════════════════════════════════════════════════════ */
  async function boot() {
    let session = { user: null }, modelsRes = { models: [], default: null, limits: state.limits };
    try { const [session, modelsRes, healthRes] = await Promise.all([apiGet('/api/auth/session').catch(() => ({ user: null })), apiGet('/api/models').catch(() => ({ models: [], default: null, limits: state.limits })), apiGet('/api/health').catch(() => ({ ok: true, maintenance: { enabled: false, message: '' } }))]);
    if (healthRes && healthRes.maintenance) state.maintenance = healthRes.maintenance;
    applyMaintenanceUI(); }
    catch { toast('Tidak bisa menghubungi server. Beberapa fitur mungkin tidak berfungsi.'); }
    state.user = session.user || null;
    state.models = modelsRes.models || [];
    state.limits = modelsRes.limits || state.limits;
    state.model = state.models.find((m) => m.id === (state.user && state.user.settings && state.user.settings.defaultModel)) || state.models.find((m) => m.id === modelsRes.default) || state.models[0] || null;
    populateModelControls();
    applyAuthUI();

    const hash = location.hash.slice(1);
    if (hash && (APP_PAGES.includes(hash) || hash === 'auth')) navigate(hash, { silent: true });
    else navigate('landing', { silent: true });
    observeReveals();
  }
  boot();

  
  function applyMaintenanceUI() {
    const banner = $('#chatMaintenanceBanner');
    const bText = $('#chatMaintenanceText');
    const maint = state.maintenance || { enabled: false, message: '' };
    if (banner && bText) {
      if (maint.enabled) {
        banner.hidden = false;
        bText.textContent = maint.message || 'Server sedang dalam pemeliharaan (maintenance).';
      } else {
        banner.hidden = true;
      }
    }
    const input = $('#chatInput');
    if (input) {
      if (maint.enabled && (!state.user || state.user.role !== 'admin')) {
        input.placeholder = 'Server sedang dalam pemeliharaan (' + (maint.message || 'maintenance') + '). Chat dinonaktifkan.';
      } else {
        input.placeholder = 'Kirim pesan ke Nova AI...';
      }
    }
    if (typeof updateSendState === 'function') updateSendState();
  }

  async function loadAdminPanel() {
    if (!state.user || state.user.role !== 'admin') {
      toast('Akses khusus administrator.');
      return navigate('dashboard');
    }
    const tbody = $('#adminUsersTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-secondary)">Memuat data dari database...</td></tr>';
    try {
      const data = await apiGet('/api/admin/users');
      state.adminUsers = data.users || [];
      state.maintenance = data.maintenance || { enabled: false, message: '' };
      renderAdminMaint();
      renderAdminUsers();
      applyMaintenanceUI();
    } catch (err) {
      toast(errMsg(err));
    }
  }

  function renderAdminMaint() {
    const m = state.maintenance || { enabled: false, message: '' };
    const badge = $('#maintStatusBadge');
    const inp = $('#maintMsgInput');
    const btn = $('#btnToggleMaint');
    if (!badge || !inp || !btn) return;

    if (m.enabled) {
      badge.className = 'badge badge--disabled';
      badge.innerHTML = icon('bell', 'icon--sm') + ' Maintenance AKTIF';
      btn.textContent = 'Matikan Server Maintenance';
      btn.className = 'btn btn--outline';
    } else {
      badge.className = 'badge badge--active';
      badge.innerHTML = icon('check', 'icon--sm') + ' Server Normal (Online)';
      btn.textContent = 'Aktifkan Server Maintenance';
      btn.className = 'btn btn--primary';
    }
    inp.value = m.message || '';
  }

  function renderAdminUsers() {
    const tbody = $('#adminUsersTableBody');
    const countBadge = $('#adminUsersCount');
    if (!tbody) return;
    const users = state.adminUsers || [];
    if (countBadge) countBadge.textContent = users.length + ' Pengguna';

    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-secondary)">Belum ada pengguna lain di database.</td></tr>';
      return;
    }

    tbody.innerHTML = users.map((u) => {
      const isAdmin = u.role === 'admin';
      const isPro = u.plan === 'pro';
      const isDisabled = !!u.disabled;
      const dateStr = fmtDate(u.createdAt);

      let roleBadge = isAdmin
        ? '<span class="badge badge--admin badge--sm">' + icon('shield', 'icon--sm') + ' Admin</span>'
        : '<span class="badge badge--sm">User</span>';

      let planBadge = isPro
        ? '<span class="badge badge--pro badge--sm">' + icon('spark', 'icon--sm') + ' PRO</span>'
        : '<span class="badge badge--sm">Free</span>';

      let statusBadge = isDisabled
        ? '<span class="badge badge--disabled badge--sm">Dinonaktifkan</span>'
        : '<span class="badge badge--active badge--sm">Aktif</span>';

      let actions = '';
      if (!isAdmin) {
        const togglePlanBtn = isPro
          ? `<button class="btn btn--outline btn--sm btn-admin-plan" data-uid="${esc(u.id)}" data-next="free">Ubah ke Free</button>`
          : `<button class="btn btn--primary btn--sm btn-admin-plan" data-uid="${esc(u.id)}" data-next="pro">${icon('spark', 'icon--sm')} Beri Pro</button>`;

        const toggleStatusBtn = isDisabled
          ? `<button class="btn btn--primary btn--sm btn-admin-status" data-uid="${esc(u.id)}" data-disable="0">Hidupkan</button>`
          : `<button class="btn btn--outline btn--sm btn-admin-status" data-uid="${esc(u.id)}" data-disable="1" style="color:#f87171;border-color:rgba(239,68,68,0.3)">Nonaktifkan</button>`;

        actions = `<div class="flex gap-8 justify-end wrap">${togglePlanBtn}${toggleStatusBtn}</div>`;
      } else {
        actions = '<span style="color:var(--text-muted);font-size:12px">Akun Utama</span>';
      }

      return `
        <tr>
          <td>
            <div style="font-weight:600">${esc(u.name)}</div>
            <div style="font-size:12px;color:var(--text-secondary)">${esc(u.email)} • ${dateStr}</div>
          </td>
          <td>${roleBadge}</td>
          <td>${planBadge}</td>
          <td>${statusBadge}</td>
          <td>${u.chatsCount || 0}</td>
          <td style="text-align:right">${actions}</td>
        </tr>
      `;
    }).join('');

    $$('.btn-admin-plan', tbody).forEach((b) => {
      b.addEventListener('click', async () => {
        const uid = b.dataset.uid;
        const plan = b.dataset.next;
        b.disabled = true;
        try {
          await apiPost('/api/admin/users/' + uid + '/plan', { plan });
          toast('Status paket berhasil diubah menjadi ' + plan.toUpperCase() + '.', 'success');
          await loadAdminPanel();
        } catch (err) {
          toast(errMsg(err));
          b.disabled = false;
        }
      });
    });

    $$('.btn-admin-status', tbody).forEach((b) => {
      b.addEventListener('click', async () => {
        const uid = b.dataset.uid;
        const disabled = b.dataset.disable === '1';
        b.disabled = true;
        try {
          await apiPost('/api/admin/users/' + uid + '/status', { disabled });
          toast(disabled ? 'Akun pengguna dinonaktifkan.' : 'Akun pengguna berhasil diaktifkan kembali.', 'success');
          await loadAdminPanel();
        } catch (err) {
          toast(errMsg(err));
          b.disabled = false;
        }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btnMaint = $('#btnToggleMaint');
    if (btnMaint) {
      btnMaint.addEventListener('click', async () => {
        const m = state.maintenance || { enabled: false, message: '' };
        const currentlyOn = !!m.enabled;
        const inp = $('#maintMsgInput');
        const customMsg = inp ? inp.value.trim() : '';

        if (!currentlyOn && !customMsg) {
          toast('Masukkan alasan server maintenance terlebih dahulu (misal: update fitur).');
          if (inp) inp.focus();
          return;
        }

        btnMaint.disabled = true;
        try {
          const res = await apiPost('/api/admin/maintenance', {
            enabled: !currentlyOn,
            message: customMsg || 'update fitur'
          });
          state.maintenance = res.maintenance;
          renderAdminMaint();
          applyMaintenanceUI();
          toast(!currentlyOn ? 'Server Maintenance DIAKTIFKAN.' : 'Server Maintenance DIMATIKAN. Server normal kembali.', 'success');
        } catch (err) {
          toast(errMsg(err));
        } finally {
          btnMaint.disabled = false;
        }
      });
    }

    const btnRef = $('#btnRefreshAdmin');
    if (btnRef) {
      btnRef.addEventListener('click', () => loadAdminPanel());
    }
  });

  window.novaNavigate = navigate; // untuk pemeriksaan manual lewat console
  window.__nova = { state, api: { apiGet, apiPost, apiPatch, apiDelete }, esc, icon, toast, fmtBytes, fmtDate, $, $$, sleep, prefersReduced, isMobile, closeDropdowns, closeMobileMenu, openModal, ApiError, applyAuthUI, AUTH_REQUIRED_PAGES, APP_PAGES, TITLES, errMsg, navigate, md, highlight };
})();
