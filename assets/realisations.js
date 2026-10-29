/* Réalisations — portfolio, modale projet, études de cas, lightbox */
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const nav = $('#nav');

  /* ----- boucle de scroll : toutes les LECTURES d'abord, puis toutes les ÉCRITURES
     (aucune mise en page forcée), une seule rAF par frame, valeurs coûteuses en cache ----- */
  const darks = $$('[data-dark],.cta,footer,.marquee');
  const ribbon = $('.rz-ribbon-track');
  const csImg = $('.cs-hero .bg img');
  const filters = $('.filters');
  let ribbonMax = 0, filtersTop = 0, vh = innerHeight;
  function measure(){
    vh = innerHeight;
    if (ribbon) ribbonMax = Math.max(0, ribbon.scrollWidth - innerWidth);
    if (filters) filtersTop = parseFloat(getComputedStyle(filters).top) || 0;
  }
  let lastInv = null, lastScrolled = null, lastStuck = null, lastRib = null, lastHero = null;
  function loop(){
    ticking = false;
    const y = scrollY;
    // lectures
    const menuOpen = $('#mmenu')?.classList.contains('open');
    const onDark = menuOpen ? null : darks.some(s => { const b = s.getBoundingClientRect(); return b.top <= 40 && b.bottom >= 40; });
    let rib = null;
    if (ribbon && !reduce){
      const b = ribbon.parentElement.getBoundingClientRect();
      if (b.bottom > -50 && b.top < vh + 50){
        const p = clamp(1 - b.bottom / (vh + b.height));
        rib = Math.round(-(0.12 + p * 0.88) * ribbonMax * .6 * 10) / 10;
      }
    }
    const stuck = filters ? filters.getBoundingClientRect().top <= filtersTop + 1 : null;
    // écritures
    const scrolled = y > 40;
    if (scrolled !== lastScrolled){ nav.classList.toggle('scrolled', scrolled); lastScrolled = scrolled; }
    if (onDark !== null && onDark !== lastInv){ nav.classList.toggle('inv', onDark); lastInv = onDark; }
    if (rib !== null && rib !== lastRib){ ribbon.style.transform = `translate3d(${rib}px,0,0)`; lastRib = rib; }
    if (csImg && !reduce && y <= vh + 10){
      const hy = Math.round(Math.min(y, vh) * .05 * 10) / 10;
      if (hy !== lastHero){ csImg.style.translate = `0 ${hy}px`; lastHero = hy; }
    }
    if (filters && stuck !== lastStuck){ filters.classList.toggle('stuck', stuck); lastStuck = stuck; }
  }
  function navFrame(){ lastInv = null; loop(); }
  let ticking = false;
  const kick = () => { if (!ticking) { ticking = true; requestAnimationFrame(loop); } };
  addEventListener('scroll', kick, {passive:true});
  addEventListener('resize', () => { measure(); kick(); placePill(); });
  measure(); loop();
  addEventListener('load', () => { measure(); kick(); });
  if ('ResizeObserver' in window) new ResizeObserver(() => { measure(); kick(); }).observe(document.body);

  /* ----- apparition ----- */
  const io = new IntersectionObserver(es => es.forEach(e => {
    // visible, ou déjà dépassé (saut d'ancre / scroll très rapide) : on révèle
    if (e.isIntersecting || e.boundingClientRect.bottom < 0) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), {threshold:.12});
  $$('.rv').forEach(el => io.observe(el));

  /* =====================================================
     FILTRES + GRILLE
     ===================================================== */
  const grid = $('#grid');
  const chips = $$('.chip');
  const pill = $('.chip-pill');
  function placePill(){
    const on = $('.chip.on');
    if (!pill || !on) return;
    pill.style.width = on.offsetWidth + 'px';
    pill.style.height = on.offsetHeight + 'px';
    pill.style.transform = `translate(${on.offsetLeft}px,${on.offsetTop}px)`;
  }
  if (grid){
    const cards = $$('.pj', grid);
    const countEl = $('#rzCount');
    // compteurs par catégorie
    chips.forEach(c => {
      const f = c.dataset.filter;
      const n = f === 'all' ? cards.length : cards.filter(p => p.dataset.cats.split(' ').includes(f)).length;
      const s = c.querySelector('sup'); if (s) s.textContent = n;
    });
    requestAnimationFrame(placePill);
    document.fonts?.ready.then(placePill);

    function apply(filter, animate = true){
      const first = new Map(cards.map(c => [c, c.getBoundingClientRect()]));
      let n = 0;
      cards.forEach(c => {
        const show = filter === 'all' || c.dataset.cats.split(' ').includes(filter);
        c.hidden = !show; if (show) n++;
      });
      countEl.textContent = String(n).padStart(2, '0');
      $('.rz-empty').style.display = n ? 'none' : 'block';
      if (!animate || reduce) return;
      cards.forEach((c, i) => {
        if (c.hidden) return;
        const a = first.get(c), b = c.getBoundingClientRect();
        if (a.width === 0) {
          c.animate([{opacity:0, transform:'translateY(40px) scale(.96)'},{opacity:1, transform:'none'}],
            {duration:650, delay: Math.min(i, 10) * 35, easing:'cubic-bezier(.2,.8,.2,1)', fill:'backwards'});
        } else {
          const dx = a.left - b.left, dy = a.top - b.top, sx = a.width / b.width, sy = a.height / b.height;
          if (dx || dy || Math.abs(sx - 1) > .01 || Math.abs(sy - 1) > .01)
            c.animate([{transformOrigin:'0 0', transform:`translate(${dx}px,${dy}px) scale(${sx},${sy})`},{transformOrigin:'0 0', transform:'none'}],
              {duration:700, easing:'cubic-bezier(.2,.8,.2,1)'});
        }
      });
    }
    chips.forEach(c => c.addEventListener('click', () => {
      chips.forEach(x => { x.classList.toggle('on', x === c); x.setAttribute('aria-pressed', x === c); });
      placePill();
      c.scrollIntoView?.({block:'nearest', inline:'center', behavior: reduce ? 'auto' : 'smooth'});
      apply(c.dataset.filter);
      const top = grid.getBoundingClientRect().top + scrollY - 200;
      if (scrollY > top) scrollTo({top, behavior: reduce ? 'auto' : 'smooth'});
    }));

    // parallaxe de l'image au survol
    if (!reduce && matchMedia('(hover:hover)').matches){
      cards.forEach(c => {
        const m = $('.pj-media', c);
        m.addEventListener('mousemove', e => {
          const r = m.getBoundingClientRect();
          m.style.setProperty('--px', ((e.clientX - r.left) / r.width - .5) * -3 + '%');
          m.style.setProperty('--py', ((e.clientY - r.top) / r.height - .5) * -3 + '%');
        });
        m.addEventListener('mouseleave', () => { m.style.setProperty('--px', 0); m.style.setProperty('--py', 0); });
      });
    }

    /* ----- modale projet ----- */
    const pm = $('#pm');
    const pmImg = $('.pm-media img', pm);
    let cur = -1, lastFocus = null;
    const visible = () => cards.filter(c => !c.hidden);
    function fill(card){
      const d = card.dataset, t = $('template', card).content;
      $('.num', pm).textContent = d.num + ' / ' + String(cards.length).padStart(2, '0');
      $('h2', pm).innerHTML = $('h3', card).innerHTML;
      $('.sub', pm).textContent = d.sub || '';
      $('.lead', pm).textContent = d.text || '';
      $('.txt', pm).replaceChildren(t.cloneNode(true));
      $('.tags', pm).innerHTML = d.labels.split('|').map(l => `<li>${l}</li>`).join('');
      const go = $('.pm-go', pm);
      if (d.href){ go.hidden = false; go.href = d.href; go.firstChild.textContent = d.cta + ' '; } else go.hidden = true;
      const im = $('.pj-media img', card);
      pmImg.src = d.big || im.src; pmImg.alt = im.alt;
    }
    function open(card){
      lastFocus = document.activeElement;
      cur = cards.indexOf(card);
      fill(card);
      pm.classList.add('open'); pm.setAttribute('aria-hidden', 'false');
      document.documentElement.style.overflow = 'hidden';
      history.replaceState(null, '', '#' + card.id);
      $('.pm-panel', pm).scrollTop = 0; $('.pm-body', pm).scrollTop = 0;
      setTimeout(() => $('.pm-x', pm).focus({preventScroll:true}), 50);
    }
    function close(){
      pm.classList.remove('open'); pm.setAttribute('aria-hidden', 'true');
      document.documentElement.style.overflow = '';
      history.replaceState(null, '', location.pathname);
      lastFocus?.focus?.({preventScroll:true});
    }
    function step(dir){
      const v = visible(); let i = v.indexOf(cards[cur]);
      i = (i + dir + v.length) % v.length;
      const card = v[i]; cur = cards.indexOf(card);
      if (reduce) { fill(card); }
      else { pm.classList.add('swap'); setTimeout(() => { fill(card); $('.pm-panel', pm).scrollTop = 0; $('.pm-body', pm).scrollTop = 0; pm.classList.remove('swap'); }, 380); }
      history.replaceState(null, '', '#' + card.id);
    }
    cards.forEach(c => $('button', c).addEventListener('click', () => open(c)));
    $('.pm-bg', pm).addEventListener('click', close);
    $('.pm-x', pm).addEventListener('click', close);
    $('.pm-prev', pm).addEventListener('click', () => step(-1));
    $('.pm-next', pm).addEventListener('click', () => step(1));
    addEventListener('keydown', e => {
      if (!pm.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'Tab'){ // piège à focus
        const f = $$('a[href]:not([hidden]),button', pm).filter(x => x.offsetParent);
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
        else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
      }
    });
    const h = location.hash.slice(1);
    if (h && document.getElementById(h)?.classList.contains('pj')) open(document.getElementById(h));
  }

  /* ----- études de cas à la une : aperçu qui suit le curseur ----- */
  const peek = $('.case-peek');
  if (peek && !reduce && matchMedia('(hover:hover)').matches){
    const imgs = $$('img', peek);
    let mx = 0, my = 0, x = 0, y = 0, on = false;
    $$('.case').forEach((c, i) => {
      c.addEventListener('mouseenter', () => { on = true; peek.classList.add('on'); imgs.forEach((im, j) => im.classList.toggle('on', i === j)); });
      c.addEventListener('mouseleave', () => { on = false; peek.classList.remove('on'); });
    });
    let raf = 0;
    function f(){
      x += (mx - x) * .14; y += (my - y) * .14;
      peek.style.transform = `translate(${x + 40}px,${y}px) translate(0,-50%) scale(${on ? 1 : .85}) rotate(${clamp((mx - x) * .04, -6, 6)}deg)`;
      raf = (Math.abs(mx - x) > .3 || Math.abs(my - y) > .3) ? requestAnimationFrame(f) : 0;
    }
    addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; if (on && !raf) raf = requestAnimationFrame(f); }, {passive:true});
    $$('.case').forEach(c => {
      c.addEventListener('mouseenter', () => { if (!raf) { x = mx; y = my; raf = requestAnimationFrame(f); } });
      c.addEventListener('mouseleave', () => { if (!raf) raf = requestAnimationFrame(f); });
    });
  }

  /* =====================================================
     LIGHTBOX (galeries)
     ===================================================== */
  const lb = $('#lb');
  if (lb){
    const shots = $$('[data-lb]');
    const lbImg = $('img', lb), lbCap = $('p', lb);
    let i = 0;
    lb.classList.toggle('solo', shots.length < 2);
    const show = k => {
      i = (k + shots.length) % shots.length;
      const im = $('img', shots[i]);
      lbImg.src = im.currentSrc || im.src; lbImg.alt = im.alt;
      lbCap.textContent = $('figcaption', shots[i])?.textContent || im.alt;
    };
    let last = null;
    shots.forEach((s, k) => {
      s.tabIndex = 0; s.setAttribute('role', 'button');
      const go = () => { last = s; show(k); lb.classList.add('open'); lb.setAttribute('aria-hidden', 'false'); $('.x', lb).focus(); };
      s.addEventListener('click', go);
      s.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
    const close = () => { lb.classList.remove('open'); lb.setAttribute('aria-hidden', 'true'); last?.focus({preventScroll:true}); };
    $('.x', lb).addEventListener('click', close);
    $('.pv', lb).addEventListener('click', e => { e.stopPropagation(); show(i - 1); });
    $('.nx', lb).addEventListener('click', e => { e.stopPropagation(); show(i + 1); });
    lb.addEventListener('click', e => { if (e.target === lb || e.target.tagName === 'FIGURE') close(); });
    addEventListener('keydown', e => {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') show(i + 1);
      if (e.key === 'ArrowLeft') show(i - 1);
    });
  }

  /* ----- curseur ----- */
  if (!reduce && matchMedia('(hover:hover)').matches){
    const cu = $('.cursor'); let mx = 0, my = 0, cx = 0, cy = 0;
    let raf = 0;
    function f(){
      cx += (mx - cx) * .2; cy += (my - cy) * .2;
      cu.style.transform = `translate(${cx}px,${cy}px)`;
      raf = (Math.abs(mx - cx) > .2 || Math.abs(my - cy) > .2) ? requestAnimationFrame(f) : 0;
    }
    addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; if (!raf) raf = requestAnimationFrame(f); }, {passive:true});
    document.addEventListener('mouseover', e => cu.classList.toggle('big', !!e.target.closest('a,button,[data-lb],.chip')));
  }

  /* ----- menu mobile ----- */
  const mm = $('#mmenu');
  $('#burger').addEventListener('click', () => { mm.classList.toggle('open'); nav.classList.toggle('inv', mm.classList.contains('open')); if (!mm.classList.contains('open')) navFrame(); });
  $$('a', mm).forEach(a => a.addEventListener('click', () => mm.classList.remove('open')));
})();
