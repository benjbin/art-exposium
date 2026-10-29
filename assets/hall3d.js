/* Neokrome — salon virtuel 3D temps réel (three.js r160)
   mountHall(el, { mode: 'scroll' | 'attract', getProgress, base })
   - scroll  : la caméra franchit la porte et avance dans le hall selon getProgress() (0 → 1)
   - attract : travelling cinématique automatique ; un clic ouvre la visite libre
   - explore : visite libre plein écran (glisser pour regarder, clic au sol pour avancer,
               ZQSD/WASD/flèches, molette, clic stand → fiche, Échap pour sortir)
   Rendu : MSAA HDR → bloom → passe finale (tone mapping ACES, vignette, grain, aberration).
   Sol : béton ciré avec réflexion temps réel floutée + carte de rugosité.
   Qualité adaptative : mesure du temps de trame puis ajustement (résolution, MSAA, réflexions,
   ombres, bloom). Les stands viennent de ./hall-stands.js (import dynamique) s’il existe. */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const BLUE = 0x145CFF, BLUE2 = 0x4D82FF;
const L = 66;          // longueur du hall
const HW = 9;          // demi-largeur
const H = 8.2;         // hauteur sous plafond
const EYE = 1.7;
const NOREFL = 1;      // calque exclu de la réflexion du sol
const FOG = 0x070b16;  // noir teinté bleu nuit
/* marque Neokrome (viewBox 220×230, y vers le bas) */
const MK = {
  left: [[0, 42], [99, 112], [99, 229], [0, 172]],
  right: [[140, 122], [219, 72], [219, 172], [140, 229]],
  lid: [[78, 45], [204, 1], [205, 69], [139, 100]],
};

const STANDS = [
  { img: 'salon1-header-1.jpg', title: 'Stand LMP2', sub: 'Racing Market', side: -1, z: -11, aspect: 2208 / 796,
    desc: 'Un stand automobile grandeur nature : prototype en 3D, trophées et écrans, comme sur un vrai paddock.' },
  { img: 'salon-2.jpg', title: 'Showroom cuisiniste', sub: 'Cuisine', side: 1, z: -20,
    desc: 'Les cuisines se visitent à l’échelle 1 : matériaux, finitions et implantations, depuis un navigateur.' },
  { img: 'salon-3-1.jpg', title: 'Showroom habitat', sub: 'Mobilier & objets', side: -1, z: -29,
    desc: 'Un showroom mobilier ouvert 24/7 où chaque pièce s’observe sous tous les angles.' },
  { img: 'salon-4.jpg', title: 'Salon « Planète Terre »', sub: 'Technologie', side: 1, z: -38,
    desc: 'Un salon thématique futuriste : écrans géants, bornes interactives et parcours scénarisé.' },
  { img: 'salon-5.jpg', title: 'Showroom Garde Temps', sub: 'Horlogerie', side: -1, z: -47,
    desc: 'L’horlogerie mise en scène : vitrines, détails et zoom sur chaque pièce.' },
];
const STAGE = { img: 'img-slider-5-scaled.jpg', title: 'Scène principale', sub: 'Conférences & networking',
  desc: 'Conférences en direct ou en replay, puis networking : la rencontre reste, la distance disparaît.' };

/* paliers de qualité (adaptés après mesure) */
const TIERS = [
  { pr: .75, msaa: 0, refl: 0,   bloom: 0,   shadowEvery: 0, fx: 0 },
  { pr: 1,   msaa: 2, refl: .3,  bloom: .7,  shadowEvery: 0, fx: 1 },
  { pr: 1.3, msaa: 4, refl: .42, bloom: .85, shadowEvery: 4, fx: 1 },
  { pr: 1.6, msaa: 4, refl: .5,  bloom: 1,   shadowEvery: 2, fx: 1 },
];

/* ---------- bruit procédural (périodique) ---------- */
function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function makeNoise(seed) {
  const r = rng(seed), P = 256, tab = new Float32Array(P * P);
  for (let i = 0; i < tab.length; i++) tab[i] = r();
  const val = (x, y, per, off) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const g = (a, b) => tab[(((a % per) + per) % per + off) % P + ((((b % per) + per) % per + off * 3) % P) * P];
    const a0 = g(xi, yi), a1 = g(xi + 1, yi), b0 = g(xi, yi + 1), b1 = g(xi + 1, yi + 1);
    return a0 + (a1 - a0) * u + (b0 - a0 + (b1 - b0 - a1 + a0) * u) * v;
  };
  return (x, y, oct = 5, f0 = 4, gain = .5) => {
    let s = 0, a = 1, n = 0, f = f0;
    for (let o = 0; o < oct; o++) { s += a * val(x * f, y * f, Math.min(P, f), o * 41); n += a; a *= gain; f *= 2; }
    return s / n;
  };
}

/* ---------- passe finale : ACES + vignette + grain + aberration chromatique ---------- */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null }, exposure: { value: 1 }, time: { value: 0 },
    grain: { value: .028 }, vig: { value: .42 }, ca: { value: .012 }, res: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float exposure, time, grain, vig, ca; uniform vec2 res;
    varying vec2 vUv;
    vec3 RRTAndODTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
    vec3 aces(vec3 c){
      const mat3 I = mat3(vec3(0.59719,0.07600,0.02840), vec3(0.35458,0.90834,0.13383), vec3(0.04823,0.01566,0.83777));
      const mat3 O = mat3(vec3(1.60475,-0.10208,-0.00327), vec3(-0.53108,1.10813,-0.07276), vec3(-0.07367,-0.00605,1.07602));
      c *= exposure / 0.6; c = I * c; c = RRTAndODTFit(c); c = O * c; return clamp(c, 0.0, 1.0);
    }
    vec3 toSRGB(vec3 c){ return mix(c * 12.92, pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, c)); }
    float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main(){
      vec2 d = vUv - 0.5;
      vec2 off = d * dot(d, d) * ca;
      vec3 c = vec3(texture2D(tDiffuse, vUv - off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv + off).b);
      if (!(dot(c, vec3(1.0)) < 6e4)) c = vec3(0.0);
      c = aces(c);
      float r = length(d * vec2(res.x / res.y, 1.0)) / length(vec2(res.x / res.y, 1.0) * 0.5);
      c *= 1.0 - vig * smoothstep(0.35, 1.05, r);
      c = toSRGB(c);
      float n = hash(vUv * res + fract(time * 7.13) * 431.0) - 0.5;
      c += n * grain * (1.0 - c * 0.7);
      gl_FragColor = vec4(c, 1.0);
    }`,
};

/* ---------- module ---------- */
export function mountHall(el, opts = {}) {
  const base = opts.base || 'assets/img/';
  const mobile = matchMedia('(max-width: 800px)').matches || matchMedia('(hover: none)').matches;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const probeCv = document.createElement('canvas');
  if (!(probeCv.getContext('webgl2') || probeCv.getContext('webgl'))) { el.classList.add('hall-fallback'); return null; }

  let mode = opts.mode || 'attract', prevMode = mode, immersive = false, ready = false;
  el.classList.add('hall');
  el.dataset.mode = mode;

  /* ---------- rendu ---------- */
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
  const isGL2 = renderer.capabilities.isWebGL2;
  renderer.toneMapping = THREE.NoToneMapping;          // fait dans la passe finale
  renderer.shadowMap.enabled = !mobile;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(FOG, 1);
  const canvas = renderer.domElement;
  canvas.className = 'hall-canvas';
  canvas.tabIndex = 0;
  el.appendChild(canvas);
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  /* ---------- interface ---------- */
  const MARK = `<svg viewBox="0 0 220 230" aria-hidden="true"><polygon class="f" points="0,42 99,112 99,229 0,172"/><polygon class="f" points="140,122 219,72 219,172 140,229"/><polygon class="d" points="78,45 204,1 205,69 139,100"/></svg>`;
  const ui = document.createElement('div');
  ui.className = 'hall-ui';
  const tap = matchMedia('(hover: none)').matches ? 'Toucher' : 'Clic';
  ui.innerHTML = `
    <div class="hall-load"><div class="hall-load-mark">${MARK}</div><span>Chargement du salon</span><b>0%</b><i><em></em></i></div>
    <div class="hall-spots"></div>
    <div class="hall-brand">${MARK}<span>Neokrome<em><b>.</b>tech</em><small>Salon virtuel · visite libre</small></span></div>
    <button class="hall-close" type="button">✕ <span>Quitter le salon</span></button>
    <aside class="hall-panel">
      <button class="hall-panel-t" type="button" aria-expanded="true"><span>Plan du salon</span><b>6 espaces</b></button>
      <div class="hall-panel-b">
        <canvas class="hall-map" aria-hidden="true"></canvas>
        <ol class="hall-list"></ol>
        <button class="hall-tour" type="button"><i></i><span>Visite guidée</span></button>
      </div>
    </aside>
    <div class="hall-help"><span><b>Glisser</b> regarder</span><span><b>${tap} au sol</b> avancer</span><span class="k"><b>ZQSD · flèches</b> marcher</span><span><b>${tap} stand</b> découvrir</span></div>
    <div class="hall-card" role="dialog" aria-live="polite"><button type="button" class="x" aria-label="Fermer">✕</button><small></small><h3></h3><p></p>
      <div class="hall-card-nav"><button type="button" class="prev">← Précédent</button><button type="button" class="next">Suivant →</button></div></div>`;
  el.appendChild(ui);
  const $ = s => ui.querySelector(s);
  const loadPct = $('.hall-load b'), loadBar = $('.hall-load em'), spotsEl = $('.hall-spots'), card = $('.hall-card');
  const listEl = $('.hall-list'), mapCv = $('.hall-map'), tourBtn = $('.hall-tour'), panel = $('.hall-panel');
  if (mobile) panel.classList.add('closed');

  /* ---------- scène ---------- */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(FOG);
  scene.fog = new THREE.FogExp2(FOG, .0105);
  const camera = new THREE.PerspectiveCamera(mobile ? 66 : 54, 1, .08, 160);
  camera.layers.enable(NOREFL);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = buildEnvironment();

  const manager = new THREE.LoadingManager();
  const loader = new THREE.TextureLoader(manager);
  manager.onProgress = (_, done, total) => {
    const k = Math.round(done / total * 100);
    loadPct.textContent = k + '%'; loadBar.style.width = k + '%';
  };
  manager.onLoad = () => {
    if (ready) return;
    ready = true;
    loadPct.textContent = '100%'; loadBar.style.width = '100%';
    shadowDirty = true;
    el.dataset.loadedMs = String(Math.round(performance.now()));
    const reveal = () => requestAnimationFrame(() => requestAnimationFrame(() => { el.classList.add('ready'); el.dataset.readyMs = String(Math.round(performance.now())); opts.onReady?.(); }));
    // pré-compilation des shaders (en parallèle si KHR_parallel_shader_compile), puis une trame
    // « à blanc » rendue à un moment calme (aucun défilement récent) : les programmes restants
    // (ombres, post-traitement, réflexion) se compilent alors hors défilement, jamais pendant.
    const parallel = !!renderer.extensions.has?.('KHR_parallel_shader_compile');
    const cap = new Promise(r => setTimeout(r, parallel ? 6000 : 1200));
    const comp = precompile();
    // textures envoyées au GPU d’avance, par petits lots : sinon chaque stand qui entre dans le champ
    // pendant le travelling déclenche un téléversement (+ mipmaps) en pleine trame
    const preupload = async () => {
      const set = new Set();
      scene.traverse(o => { const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        ms.forEach(m => { for (const k in m) { const v = m[k]; if (v && v.isTexture && !v.isRenderTargetTexture) set.add(v); } }); });
      let n = 0;
      for (const t of set) {
        if (n++ % 4 === 0) await nextTask();
        try { renderer.initTexture(t); } catch (e) { /* ignoré : sera envoyée au premier rendu */ }
      }
    };
    Promise.race([comp, cap]).then(preupload).then(() => whenCalm(() => {
      const tw = performance.now();
      try { update(0); render(); } catch (e) { /* le premier rendu visible s’en chargera */ }
      el.dataset.warmMs = String(Math.round(performance.now() - tw));
      el.dataset.parallel = parallel ? '1' : '0';
      warmed = true;
      reveal();
    }));
  };
  manager.itemStart('stands');   // le chargement n’est complet qu’une fois les stands construits

  /* ---------- ménagement du fil principal : défilement de la page ---------- */
  let lastScrollT = -1e9, warmed = false;
  addEventListener('scroll', () => { lastScrollT = performance.now(); }, { passive: true, capture: true });
  const scrolling = (now = performance.now()) => now - lastScrollT < 220;
  // exécute fn quand la page ne défile plus (et que le navigateur est libre), avec un plafond
  // en mode accueil (salon dans la page) on attend aussi longtemps que nécessaire ; en mode hero, 4 s max
  const patience = () => (mode === 'attract' && !immersive ? Infinity : 4000);
  function whenCalm(fn, maxWait = patience()) {
    const t0 = performance.now();
    const idle = window.requestIdleCallback || (f => setTimeout(f, 1));
    (function check() {
      const now = performance.now();
      if (!scrolling(now) || now - t0 > maxWait) idle(() => fn(), { timeout: 400 });
      else setTimeout(check, 120);
    })();
  }
  // rend la main au navigateur entre deux gros morceaux de construction (attend la fin du défilement, 3 s max)
  const nextTask = () => new Promise(r => {
    const t0 = performance.now();
    const go = () => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 250 }) : setTimeout(r, 16));
    (function wait() { if (scrolling() && performance.now() - t0 < (mode === 'attract' && !immersive ? Infinity : 3000)) setTimeout(wait, 140); else go(); })();
  });

  const std = o => new THREE.MeshStandardMaterial(o);
  const phys = o => new THREE.MeshPhysicalMaterial(o);
  const glow = (hex, k = 2) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k) });
  const mesh = (geo, mat, x = 0, y = 0, z = 0, parent = scene) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m;
  };
  const rbox = (w, h, d, r = .03, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2.01, h / 2.01, d / 2.01));
  // marque extrudée : origine en bas à gauche, hauteur hgt (viewBox 220×230)
  const markGeo = (hgt, depth, bevel = .02) => {
    const k = hgt / 230, sh = pts => new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x * k, (229 - y) * k)));
    const ex = { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * .7, bevelSegments: 2 };
    return { panels: new THREE.ExtrudeGeometry([sh(MK.left), sh(MK.right)], ex), lid: new THREE.ExtrudeGeometry(sh(MK.lid), ex) };
  };
  const photo = name => {
    const t = loader.load(base + name);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso;
    return t;
  };
  const canvasTex = (w, h, draw, srgb = true) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    const run = () => { const g = c.getContext('2d'); g.clearRect(0, 0, w, h); draw(g, w, h); t.needsUpdate = true; };
    run(); document.fonts?.ready.then(run);
    return t;
  };
  // marque Neokrome : boîte ouverte (2 panneaux + couvercle bleu), viewBox 220×230 ; s = hauteur
  const drawMark = (g, x, y, s, panel = '#fff', lid = '#145CFF') => {
    const P = pts => { g.beginPath(); pts.forEach(([a, b], i) => g[i ? 'lineTo' : 'moveTo'](x + a * s / 230, y + b * s / 230)); g.closePath(); g.fill(); };
    g.fillStyle = panel; P(MK.left); P(MK.right);
    g.fillStyle = lid; P(MK.lid);
  };
  // logotype NEOKROME (bras supérieur du K en bleu) + « .tech » à point bleu ; renvoie la largeur
  const drawWordmark = (g, x, y, px, ink = '#fff', o = {}) => {
    const blue = o.blue || '#145CFF', tech = o.tech !== false;
    g.save(); g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    g.font = `800 ${px}px Outfit, system-ui, sans-serif`;
    g.letterSpacing = (o.track ?? .02) * px + 'px';
    const pre = 'NEO', word = 'NEOKROME';
    const wPre = g.measureText(pre).width, wK = g.measureText('K').width, wAll = g.measureText(word).width;
    g.fillStyle = ink; g.fillText(word, x, y);
    // bras supérieur du K : on repeint la moitié haute droite du glyphe
    const kx = x + wPre, cap = px * .72;
    g.save(); g.beginPath(); g.rect(kx + wK * .36, y - cap - px * .1, wK, cap * .53 + px * .1); g.clip();
    g.fillStyle = blue; g.fillText('K', kx, y); g.restore();
    let w = wAll;
    if (tech) {
      const tp = px * .46, gap = px * .06;
      g.letterSpacing = '0px';
      g.fillStyle = blue; g.beginPath(); g.arc(x + w + gap + tp * .17, y - tp * .14, tp * .15, 0, 7); g.fill();
      g.font = `600 ${tp}px Outfit, system-ui, sans-serif`; g.fillStyle = ink;
      g.fillText('tech', x + w + gap + tp * .42, y);
      w += gap + tp * .42 + g.measureText('tech').width;
    }
    g.restore();
    return w;
  };
  const TAGLINE = ['L’intelligence visuelle.', 'L’expérience numérique.'];

  /* ---------- textures générées ---------- */
  function signTex(title, sub, w = 1400, h = 128, bg = '#101015') {
    return canvasTex(w, h, g => {
      if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
      const m = h * .54, mx = h * .42;
      drawMark(g, mx, (h - m) / 2, m, '#ffffff', '#145CFF');
      const tx = mx + m * .96 + h * .28;
      g.textBaseline = 'middle'; g.fillStyle = '#fff';
      g.font = `800 ${h * .4}px Outfit, system-ui, sans-serif`;
      const T = title.toUpperCase();
      let tw;
      if (T === 'NEOKROME') tw = drawWordmark(g, tx, h * .53 + h * .4 * .36, h * .4, '#fff');
      else { g.fillText(T, tx, h * .53); tw = g.measureText(T).width; }
      if (sub) {
        g.font = `500 ${h * .2}px Outfit, system-ui, sans-serif`; g.fillStyle = 'rgba(255,255,255,.55)';
        g.letterSpacing = '4px';
        g.fillText(sub.toUpperCase(), tx + tw + h * .4, h * .55);
        g.letterSpacing = '0px';
      }
    });
  }
  const sign = (title, sub) => signTex(title, sub);

  const N1 = makeNoise(7), N2 = makeNoise(19);
  function floorMaps() {
    const S = mobile ? 256 : 512;
    const hgt = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      hgt[y * S + x] = N1(u, v, 5, 4) * .75 + N1(u + .37, v + .11, 3, 32) * .25;
    }
    const nc = document.createElement('canvas'); nc.width = nc.height = S;
    const rc = document.createElement('canvas'); rc.width = rc.height = S;
    const ng = nc.getContext('2d'), rg = rc.getContext('2d');
    const nd = ng.createImageData(S, S), rd = rg.createImageData(S, S);
    const k = S / 64;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = y * S + x, p = i * 4;
      const dx = (hgt[y * S + (x + S - 1) % S] - hgt[y * S + (x + 1) % S]) * k;
      const dy = (hgt[((y + S - 1) % S) * S + x] - hgt[((y + 1) % S) * S + x]) * k;
      const il = 1 / Math.hypot(dx, dy, 1);
      nd.data[p] = (dx * il * .5 + .5) * 255; nd.data[p + 1] = (dy * il * .5 + .5) * 255; nd.data[p + 2] = (il * .5 + .5) * 255; nd.data[p + 3] = 255;
      // rugosité : zones polies / zones mates, à grande échelle + micro-variations
      const r2 = N2(x / S, y / S, 4, 3);
      let r = .16 + Math.pow(Math.max(0, r2 - .28) * 1.9, 1.6) * .55 + (Math.random() - .5) * .05;
      r = Math.min(.82, Math.max(.1, r));
      rd.data[p] = rd.data[p + 1] = rd.data[p + 2] = r * 255; rd.data[p + 3] = 255;
    }
    ng.putImageData(nd, 0, 0); rg.putImageData(rd, 0, 0);
    const mk = (c, srgb) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
    // granulat fin (albedo)
    const ac = document.createElement('canvas'); ac.width = ac.height = 512;
    const ag = ac.getContext('2d'), ad = ag.createImageData(512, 512);
    for (let i = 0; i < 512 * 512; i++) {
      const x = i % 512, y = (i / 512) | 0;
      let v = 200 + (N1(x / 512 + .5, y / 512, 3, 8) - .5) * 40 + (Math.random() - .5) * 22;
      if (Math.random() < .012) v -= 40 + Math.random() * 30;
      if (Math.random() < .006) v += 35;
      ad.data[i * 4] = v; ad.data[i * 4 + 1] = v; ad.data[i * 4 + 2] = v + 3; ad.data[i * 4 + 3] = 255;
    }
    ag.putImageData(ad, 0, 0);
    return { normal: mk(nc), rough: mk(rc), albedo: mk(ac, true) };
  }

  function wallTex() {
    const w = 512, h = 1024;
    const map = canvasTex(w, h, g => {
      g.fillStyle = '#181c26'; g.fillRect(0, 0, w, h);
      // variations douces
      for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(${Math.random() < .5 ? '255,255,255' : '0,0,0'},.015)`; g.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 60, 2 + Math.random() * 120); }
      const ppm = h / H;  // px par mètre
      g.fillStyle = '#0c0c10'; g.fillRect(0, 0, 5, h);
      g.fillStyle = 'rgba(255,255,255,.05)'; g.fillRect(5, 0, 2, h);
      for (const y of [.16, 2.9, 5.6]) { const py = h - y * ppm; g.fillStyle = '#0c0c10'; g.fillRect(0, py - 3, w, 4); g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(0, py + 1, w, 2); }
      g.fillStyle = '#0d0d11'; g.fillRect(0, h - .16 * ppm, w, .16 * ppm);  // plinthe
    });
    const em = canvasTex(64, 1024, (g, w2, h2) => {
      const ppm = h2 / H;
      g.fillStyle = '#000'; g.fillRect(0, 0, w2, h2);
      let gr = g.createLinearGradient(0, h2 - .16 * ppm, 0, h2 - 1.9 * ppm);
      gr.addColorStop(0, 'rgba(77,130,255,.9)'); gr.addColorStop(.25, 'rgba(20,92,255,.32)'); gr.addColorStop(1, 'rgba(20,92,255,0)');
      g.fillStyle = gr; g.fillRect(0, h2 - 1.9 * ppm, w2, 1.74 * ppm);
      gr = g.createLinearGradient(0, 0, 0, 2.2 * ppm);
      gr.addColorStop(0, 'rgba(255,214,170,.3)'); gr.addColorStop(1, 'rgba(255,214,170,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w2, 2.2 * ppm);
    });
    return { map, em };
  }

  function hexTex() {
    return canvasTex(256, 256, (g, w) => {
      const c = w / 2;
      const gr = g.createRadialGradient(c, c, 0, c, c, c);
      gr.addColorStop(0, '#d9dbe6'); gr.addColorStop(.62, '#e4e6f0'); gr.addColorStop(.86, '#ffffff'); gr.addColorStop(1, '#9496a8');
      g.fillStyle = gr; g.fillRect(0, 0, w, w);
    }, false);
  }
  function softTex(kind) {    // ombres de contact / halos
    return canvasTex(256, 256, (g, w) => {
      if (kind === 'rect') {
        const id = g.createImageData(w, w);
        for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
          const dx = Math.max(0, Math.abs(x - w / 2 + .5) / (w / 2) - .72) / .28, dy = Math.max(0, Math.abs(y - w / 2 + .5) / (w / 2) - .62) / .38;
          const a = Math.max(0, 1 - Math.hypot(dx, dy)); const p = (y * w + x) * 4;
          id.data[p] = id.data[p + 1] = id.data[p + 2] = 0; id.data[p + 3] = Math.pow(a, 1.6) * 255;
        }
        g.putImageData(id, 0, 0);
      } else {
        const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
        if (kind === 'ring') { gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(.55, 'rgba(255,255,255,0)'); gr.addColorStop(.72, 'rgba(255,255,255,1)'); gr.addColorStop(.8, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); }
        else if (kind === 'dot') { gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.25, 'rgba(255,255,255,.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); }
        else { gr.addColorStop(0, 'rgba(0,0,0,.85)'); gr.addColorStop(.5, 'rgba(0,0,0,.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); }
        g.fillStyle = gr; g.fillRect(0, 0, w, w);
      }
    }, false);
  }
  const shadowRect = softTex('rect'), shadowRound = softTex('round');
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowRect, transparent: true, depthWrite: false, opacity: .75, polygonOffset: true, polygonOffsetFactor: -2 });
  const shadowMatR = new THREE.MeshBasicMaterial({ map: shadowRound, transparent: true, depthWrite: false, opacity: .7, polygonOffset: true, polygonOffsetFactor: -2 });
  function contactShadow(w, d, x, z, parent = scene, round = false, y = .004) {
    const m = mesh(new THREE.PlaneGeometry(w, d), round ? shadowMatR : shadowMat, x, y, z, parent);
    m.rotation.x = -Math.PI / 2; m.layers.set(NOREFL); m.renderOrder = -1;
    return m;
  }

  /* ---------- environnement (réflexions / lumière ambiante) ---------- */
  function buildEnvironment() {
    const s = new THREE.Scene();
    const add = (w, h, color, x, y, z, rx = 0, ry = 0) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      m.position.set(x, y - EYE, z); m.rotation.set(rx, ry, 0); s.add(m);
    };
    const room = new THREE.Mesh(new THREE.BoxGeometry(18, H, 80), new THREE.MeshBasicMaterial({ color: new THREE.Color(.012, .016, .03), side: THREE.BackSide }));
    room.position.set(0, H / 2 - EYE, -24); s.add(room);
    add(18, 80, new THREE.Color(.026, .03, .042), 0, .02, -24, -Math.PI / 2);
    for (let z = 2; z > -62; z -= 5) add(9, 3, new THREE.Color(2.2, 2.25, 2.45), 0, 6.85, z, Math.PI / 2);
    for (const sd of [-1, 1]) {
      add(80, .3, new THREE.Color(.1, .38, 2.3), sd * 8.95, .22, -24, 0, -sd * Math.PI / 2);
      add(80, 1.6, new THREE.Color(.5, .4, .3), sd * 8.95, 7.4, -24, 0, -sd * Math.PI / 2);
    }
    for (const st of STANDS) add(6, 3.2, new THREE.Color(1.1, .85, .65), st.side * 8.5, 2.9, st.z, 0, -st.side * Math.PI / 2);
    add(11, 5, new THREE.Color(1, 1, 1.25), 1.8, 3.6, -65.6);
    add(6, 5.5, new THREE.Color(.28, .36, .58), 0, 2.8, 4.2);
    const t = pmrem.fromScene(s, .03, .1, 120).texture;
    s.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    return t;
  }

  /* ---------- lumières globales ---------- */
  scene.add(new THREE.HemisphereLight(0x8a9fd0, 0x080b14, .2));
  if (!mobile) {
    RectAreaLightUniformsLib.init();
    for (const z of [-5, -24, -43]) {
      const r = new THREE.RectAreaLight(0xe9eeff, 1.1, 9, 16);
      r.position.set(0, 6.8, z); r.lookAt(0, 0, z); scene.add(r);
    }
  } else {
    for (const z of [-5, -24, -43]) { const p = new THREE.PointLight(0xe9eeff, 70, 30, 2); p.position.set(0, 6.4, z); scene.add(p); }
  }

  /* ---------- sol : béton ciré + réflexion floutée ---------- */
  const fm = floorMaps();
  const floorLen = L + 16, floorZ = (16 - L) / 2 - 2 + 2;
  fm.albedo.repeat.set(HW * 2 / 2.2, floorLen / 2.2);
  fm.normal.repeat.set(HW * 2 / 7.5, floorLen / 7.5);
  fm.rough.repeat.copy(fm.normal.repeat);
  const floorU = {
    tRefl: { value: null }, tReflBlur: { value: null }, reflMatrix: { value: new THREE.Matrix4() },
    reflOn: { value: 1 }, reflK: { value: 1 }, hw: { value: HW },
  };
  const floorMat = std({
    color: 0x3d3d43, map: fm.albedo, roughness: 1, roughnessMap: fm.rough, normalMap: fm.normal,
    normalScale: new THREE.Vector2(.14, .14), metalness: 0, envMapIntensity: .55,
  });
  floorMat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, floorU);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 reflMatrix;\nvarying vec4 vReflUv;\nvarying vec3 vWorldP;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvec4 wpR = modelMatrix * vec4(transformed, 1.0);\nvWorldP = wpR.xyz;\nvReflUv = reflMatrix * wpR;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tRefl, tReflBlur; uniform float reflOn, reflK, hw;
        varying vec4 vReflUv; varying vec3 vWorldP;
        float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec2 tp = vWorldP.xz / vec2(3.0, 3.0) + vec2(.5, .0);
        vec2 tid = floor(tp);
        float tone = .95 + hash12(tid) * .1;
        vec2 fw = fwidth(tp);
        vec2 ds = .5 - abs(fract(tp) - .5);
        vec2 sl = 1.0 - smoothstep(vec2(.0011), vec2(.0011) + fw * 1.2, ds);
        float seam = max(sl.x, sl.y) * (1.0 - smoothstep(.015, .06, max(fw.x, fw.y)));
        diffuseColor.rgb *= tone * (1.0 - seam * .3);
        float wallAO = smoothstep(hw, hw - 1.4, abs(vWorldP.x));
        diffuseColor.rgb *= mix(.45, 1.0, wallAO);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, .95, seam);`)
      .replace('#include <opaque_fragment>', `
        {
          vec3 nm = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
          vec2 ruv = vReflUv.xy / vReflUv.w + nm.xy * .018;
          vec2 e = smoothstep(vec2(0.0), vec2(.06), ruv) * smoothstep(vec2(1.0), vec2(.94), ruv);
          vec3 rs = texture2D(tRefl, ruv).rgb, rb = texture2D(tReflBlur, ruv).rgb;
          vec3 rc = mix(rs, rb, smoothstep(.08, .3, roughnessFactor));
          float ndv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
          float F = .03 + .97 * pow(1.0 - ndv, 5.0);
          float gloss = 1.0 - smoothstep(.2, .8, roughnessFactor);
          outgoingLight += rc * F * gloss * reflOn * reflK * e.x * e.y * (1.0 - seam) * mix(.5, 1.0, wallAO);
        }
        #include <opaque_fragment>`);
  };
  const floor = mesh(new THREE.PlaneGeometry(HW * 2, floorLen), floorMat, 0, 0, floorZ);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;

  // réflexion : caméra miroir + flou séparable
  const RT = () => new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false });
  const refl = { rt: new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType }), a: RT(), b: RT(), cam: new THREE.PerspectiveCamera(), on: true };
  refl.cam.layers.set(0);
  floorU.tRefl.value = refl.rt.texture; floorU.tReflBlur.value = refl.b.texture; floorU.reflMatrix.value = new THREE.Matrix4();
  const blurQ = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2() } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 dir; varying vec2 vUv;
      vec3 S(vec2 u){ vec3 c = texture2D(tDiffuse, u).rgb; return (dot(c, vec3(1.0)) < 6e4) ? min(c, vec3(32.0)) : vec3(0.0); }
      void main(){ vec3 c = S(vUv) * .227027;
        c += (S(vUv + dir * 1.3846154) + S(vUv - dir * 1.3846154)) * .3162162;
        c += (S(vUv + dir * 3.2307692) + S(vUv - dir * 3.2307692)) * .0702703;
        gl_FragColor = vec4(c, 1.0); }`,
    depthTest: false, depthWrite: false,
  }));
  const _cp = new THREE.Vector3(), _la = new THREE.Vector3(), _rm = new THREE.Matrix4();
  function blurStep(src, dst, dx, dy) {
    blurQ.material.uniforms.tDiffuse.value = src.texture; blurQ.material.uniforms.dir.value.set(dx, dy);
    renderer.setRenderTarget(dst); blurQ.render(renderer);
  }
  function renderReflection() {
    camera.updateMatrixWorld();
    _cp.setFromMatrixPosition(camera.matrixWorld);
    if (_cp.y < .02) return;
    _rm.extractRotation(camera.matrixWorld);
    _la.set(0, 0, -1).applyMatrix4(_rm).add(_cp);
    const rc = refl.cam;
    rc.position.set(_cp.x, -_cp.y, _cp.z);
    rc.up.set(0, 1, 0).applyMatrix4(_rm); rc.up.y *= -1;
    rc.lookAt(_la.x, -_la.y, _la.z);
    rc.updateMatrixWorld();
    rc.projectionMatrix.copy(camera.projectionMatrix);
    rc.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    floorU.reflMatrix.value.set(.5, 0, 0, .5, 0, .5, 0, .5, 0, 0, .5, .5, 0, 0, 0, 1)
      .multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);
    floor.visible = false;
    renderer.setRenderTarget(refl.rt); renderer.clear(); renderer.render(scene, rc);
    floor.visible = true;
    const w = refl.a.width, h = refl.a.height;
    blurStep(refl.rt, refl.a, 1 / refl.rt.width, 0);
    blurStep(refl.a, refl.b, 0, 1 / h);
    blurStep(refl.b, refl.a, 2.2 / w, 0);
    blurStep(refl.a, refl.b, 0, 2.2 / h);
    renderer.setRenderTarget(null);
  }

  /* ---------- architecture ---------- */
  const M = {
    metal: std({ color: 0x1a1d26, roughness: .34, metalness: .8 }),
    black: std({ color: 0x0a0c12, roughness: .45, metalness: .3 }),
    white: std({ color: 0xcfccc4, roughness: .55 }),
    fabric: std({ color: 0x102a5c, roughness: .92 }),
    fabricGrey: std({ color: 0x30343f, roughness: .95 }),
    chrome: phys({ color: 0xffffff, metalness: 1, roughness: .1 }),
    glass: phys({ color: 0xe8ecff, metalness: 0, roughness: .03, transparent: true, opacity: .13, depthWrite: false, envMapIntensity: 1.6 }),
    ceil: std({ color: 0x090c15, roughness: .9 }),
    // couvercle de la marque : bleu électrique émissif (émission légèrement décalée vers le cyan pour éviter la dérive violette de l’ACES)
    lid: std({ color: 0x061840, emissive: 0x1a6cff, emissiveIntensity: .95, roughness: .45, metalness: 0, envMapIntensity: .35 }),
  };
  const wt = wallTex();
  const wallMats = [];
  const wallMat = (lenM) => {
    const mp = wt.map.clone(), em = wt.em.clone();
    mp.wrapS = em.wrapS = THREE.RepeatWrapping; mp.repeat.set(lenM / 2.4, 1); em.repeat.set(lenM / 2.4, 1);
    mp.needsUpdate = em.needsUpdate = true;
    const m = std({ map: mp, emissiveMap: em, emissive: 0xffffff, emissiveIntensity: .9, roughness: .78, metalness: .05, envMapIntensity: .6 });
    wallMats.push(m); return m;
  };
  const wallLen = L + 4, wallZ = (4 - L) / 2;
  for (const s of [-1, 1]) {
    const w = mesh(new THREE.PlaneGeometry(wallLen, H), wallMat(wallLen), s * HW, H / 2, wallZ);
    w.rotation.y = -s * Math.PI / 2; w.receiveShadow = true;
    // corniche LED basse + haute
    mesh(new THREE.BoxGeometry(.06, .035, wallLen), glow(BLUE2, 2.8), s * (HW - .05), .16, wallZ);
    mesh(new THREE.BoxGeometry(.16, .1, wallLen), M.black, s * (HW - .08), .2, wallZ);
    mesh(new THREE.BoxGeometry(.05, .03, wallLen), glow(0xffd8b0, 2.4), s * (HW - .05), H - .02, wallZ);
  }
  {
    const bw = mesh(new THREE.PlaneGeometry(HW * 2, H), wallMat(HW * 2), 0, H / 2, -L);
    bw.receiveShadow = true;
  }
  const ceil = mesh(new THREE.PlaneGeometry(HW * 2, wallLen), M.ceil, 0, H, wallZ);
  ceil.rotation.x = Math.PI / 2;
  // poutres métalliques
  for (let z = 1; z > -L; z -= 6.5) mesh(new THREE.BoxGeometry(HW * 2, .5, .28), M.metal, 0, H - .25, z);
  for (const x of [-6.4, 6.4]) mesh(new THREE.BoxGeometry(.24, .34, wallLen), M.metal, x, H - .5, wallZ);

  /* ---------- canopée alvéolaire (diffuseurs hexagonaux) ---------- */
  {
    const R = .6, Rc = .74, Y = 6.85;
    const cells = [], dim = [], cr = rng(5);
    const dx = 1.5 * Rc, dz = Math.sqrt(3) * Rc;
    for (let i = -6; i <= 6; i++) for (let z = 3; z > -L + 5; z -= dz) {
      const x = i * dx, zz = z + (i & 1 ? dz / 2 : 0);
      if (Math.abs(x) > 5.6 || zz > 3.2) continue;
      const v = (1 - Math.abs(x) / 5.2) + (N2(x * .05 + .5, zz * .03 + .3, 3, 4) - .5) * 1.6 + (cr() - .5) * .55;
      if (v > .58) cells.push([x, zz]); else if (v > .15) dim.push([x, zz]);
    }
    const frameShape = new THREE.Shape(), hole = new THREE.Path();
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * Math.PI * 2;
      frameShape[k ? 'lineTo' : 'moveTo'](Math.cos(a) * (R + .085), Math.sin(a) * (R + .085));
      hole[k ? 'lineTo' : 'moveTo'](Math.cos(a) * R, Math.sin(a) * R);
    }
    frameShape.holes.push(hole);
    const fg = new THREE.ExtrudeGeometry(frameShape, { depth: .22, bevelEnabled: true, bevelThickness: .012, bevelSize: .012, bevelSegments: 2, curveSegments: 1 });
    fg.rotateX(-Math.PI / 2);
    const frames = new THREE.InstancedMesh(fg, std({ color: 0x141821, roughness: .3, metalness: .85 }), cells.length + dim.length);
    const pg = new THREE.CircleGeometry(R, 6); pg.rotateX(Math.PI / 2);
    const panels = new THREE.InstancedMesh(pg, new THREE.MeshBasicMaterial({ map: hexTex(), color: new THREE.Color(1.25, 1.28, 1.4) }), cells.length);
    const darkPanels = new THREE.InstancedMesh(pg, std({ color: 0x080b12, roughness: .6 }), Math.max(1, dim.length));
    const m4 = new THREE.Matrix4(), col = new THREE.Color(), r = rng(3);
    cells.forEach(([x, z], i) => {
      const y = Y + Math.sin(x * .7 + z * .3) * .02;
      frames.setMatrixAt(i, m4.makeTranslation(x, y, z));
      panels.setMatrixAt(i, m4.makeTranslation(x, y + .045, z));
      const k = .82 + r() * .22; col.setRGB(k * (r() < .12 ? 1.05 : 1), k, k * (r() < .12 ? .9 : 1));
      panels.setColorAt(i, col);
    });
    dim.forEach(([x, z], i) => {
      frames.setMatrixAt(cells.length + i, m4.makeTranslation(x, Y, z));
      darkPanels.setMatrixAt(i, m4.makeTranslation(x, Y + .045, z));
    });
    darkPanels.count = dim.length;
    scene.add(frames, panels, darkPanels);
    // tiges de suspension
    const rods = new THREE.InstancedMesh(new THREE.CylinderGeometry(.008, .008, H - Y), M.black, Math.ceil(cells.length / 6));
    let n = 0; cells.forEach(([x, z], i) => { if (i % 6 === 0) rods.setMatrixAt(n++, m4.makeTranslation(x, (H + Y) / 2, z)); });
    rods.count = n; rods.layers.set(NOREFL); scene.add(rods);
  }

  /* ---------- façade d'entrée : la boîte ouverte Neokrome à l’échelle monumentale ----------
     Les deux panneaux de la marque encadrent la porte (l’écart du « Y » devient le passage),
     le couvercle bleu, articulé sur son arête basse, s’ouvre au-dessus des visiteurs. */
  const entryLid = new THREE.Group();
  {
    const fz = 4, fd = .5, fF = fz + fd / 2;          // fF : nu avant de la façade
    // projection de la marque (viewBox 220×230) sur la façade : l’écart 99→140 = la porte (±3 m)
    const kx = .038, ky = .035;
    const X = x => x <= 99 ? -3 - (99 - x) * kx : x >= 140 ? 3 + (x - 140) * kx : -3 + (x - 99) * 6 / 41;
    const Y = y => (229 - y) * ky;
    const V = ([x, y]) => new THREE.Vector2(X(x), Y(y));
    const facade = std({ color: 0x101827, roughness: .5, metalness: .25 });
    for (const s of [-1, 1]) mesh(new THREE.BoxGeometry(HW + .3 - 3, H, fd), facade, s * (3 + (HW + .3 - 3) / 2), H / 2, fz).receiveShadow = true;
    // linteau : son arête basse suit l’arête de charnière du couvercle
    const L0 = V(MK.lid[0]), L3 = V(MK.lid[3]), sl = (L3.y - L0.y) / (L3.x - L0.x);
    const yAt = x => L0.y + (x - L0.x) * sl;
    const lint = new THREE.Shape([new THREE.Vector2(-3, yAt(-3)), new THREE.Vector2(3, yAt(3)), new THREE.Vector2(3, H), new THREE.Vector2(-3, H)]);
    const lg = new THREE.ExtrudeGeometry(lint, { depth: fd, bevelEnabled: false }); lg.translate(0, 0, -fd / 2);
    mesh(lg, facade, 0, 0, fz);
    // panneaux blancs (fond sombre) — bas ramenés au sol
    const pd = .34, white = std({ color: 0xe9edf4, roughness: .38, metalness: .05 });
    const panel = pts => {
      const sh = new THREE.Shape(pts.map(p => { const v = V(p); v.y = Math.max(0, p[1] > 150 ? 0 : v.y); return v; }));
      const geo = new THREE.ExtrudeGeometry(sh, { depth: pd, bevelEnabled: true, bevelThickness: .02, bevelSize: .02, bevelSegments: 2 });
      const m = mesh(geo, white, 0, 0, fF); m.castShadow = m.receiveShadow = true; return m;
    };
    panel(MK.left); panel(MK.right);
    // filets LED bleus sur les arêtes intérieures (le passage)
    const led = glow(BLUE2, 2.8), zF = fF + pd + .02;
    mesh(new THREE.BoxGeometry(.03, Y(112), .03), led, -2.985, Y(112) / 2, zF);
    mesh(new THREE.BoxGeometry(.03, Y(122), .03), led, 2.985, Y(122) / 2, zF);
    // logotype (panneau gauche) + signature (panneau droit), encre bleu nuit
    const wmTex = canvasTex(1400, 300, (g, w) => {
      const px = 168, ww = drawWordmark(g, 0, -1000, px, '#0B214A');   // mesure (hors champ)
      const x0 = (w - ww) / 2;
      drawWordmark(g, x0, 170, px, '#0B214A');
      g.font = '600 40px Outfit, system-ui, sans-serif'; g.fillStyle = 'rgba(11,33,74,.62)'; g.letterSpacing = '12px';
      g.textAlign = 'left'; g.fillText('SALON VIRTUEL · 24/7', x0 + 6, 262); g.letterSpacing = '0px';
    });
    const wm = mesh(new THREE.PlaneGeometry(3.3, 3.3 * 300 / 1400), new THREE.MeshBasicMaterial({ map: wmTex, transparent: true, color: new THREE.Color(.92, .92, .92) }), (X(0) + X(99)) / 2, 2.35, fF + pd + .028);
    wm.layers.set(NOREFL);
    const tagTex = canvasTex(900, 300, (g, w) => {
      g.fillStyle = '#145CFF'; g.fillRect(0, 18, 70, 8);
      g.font = '700 62px Outfit, system-ui, sans-serif'; g.fillStyle = '#0B214A'; g.textBaseline = 'top';
      TAGLINE.forEach((t, i) => g.fillText(t, 0, 60 + i * 80, w));
    });
    const tg = mesh(new THREE.PlaneGeometry(2.4, .8), new THREE.MeshBasicMaterial({ map: tagTex, transparent: true, color: new THREE.Color(.92, .92, .92) }), X(140) + .3 + 1.2, 2.2, fF + pd + .028);
    tg.layers.set(NOREFL);
    // enseigne intérieure
    const sti = mesh(new THREE.PlaneGeometry(5.6, .52), new THREE.MeshBasicMaterial({ map: signTex('Bienvenue', 'Salon virtuel', 1400, 128, null), transparent: true, color: new THREE.Color(1.1, 1.1, 1.1) }), 0, 6.75, fz - fd / 2 - .01);
    sti.rotation.y = Math.PI;
    // couvercle bleu : charnière = arête basse-gauche du couvercle de la marque
    const hd = new THREE.Vector2().subVectors(L3, L0).normalize(), phi = Math.atan2(hd.y, hd.x);
    const c = Math.cos(-phi), s2 = Math.sin(-phi);
    const lidShape = new THREE.Shape(MK.lid.map(p => { const v = V(p).sub(L3); return new THREE.Vector2(v.x * c - v.y * s2, v.x * s2 + v.y * c); }));
    const hinge = new THREE.Group(); hinge.position.set(L3.x, L3.y, fF + .14); hinge.rotation.z = phi; scene.add(hinge);
    hinge.add(entryLid);
    const lgeo = new THREE.ExtrudeGeometry(lidShape, { depth: .2, bevelEnabled: true, bevelThickness: .025, bevelSize: .025, bevelSegments: 2 }); lgeo.translate(0, 0, -.1);
    const lid = mesh(lgeo, M.lid, 0, 0, 0, entryLid);
    lid.castShadow = true;
    entryLid.rotation.x = .5;
    // charnière (barre sombre)
    const hl = L0.distanceTo(L3);
    mesh(new THREE.CylinderGeometry(.05, .05, hl, 16), M.metal, -hl / 2, 0, 0, hinge).rotation.z = Math.PI / 2;
    // parvis : halo bleu qui s’échappe du passage + totems
    const spill = mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshBasicMaterial({ map: softTex('dot'), color: new THREE.Color(.06, .15, .4), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }), 0, .006, fz + 4);
    spill.rotation.x = -Math.PI / 2; spill.layers.set(NOREFL);
    const fl = new THREE.SpotLight(0xdde6ff, 120, 22, .7, .8, 2); fl.position.set(0, 7.5, 13); fl.target.position.set(0, 3.6, fz); scene.add(fl, fl.target);
    const totemTex = canvasTex(360, 1040, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#0B214A'); gr.addColorStop(.55, '#0A3FCC'); gr.addColorStop(1, '#145CFF');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      drawMark(g, 58, 64, 110, '#ffffff', '#4D82FF');
      drawWordmark(g, 58, 236, 42, '#fff', { blue: '#4D82FF' });
      g.fillStyle = '#fff'; g.font = '800 64px Outfit, system-ui, sans-serif'; g.textBaseline = 'top';
      ['SALON', 'VIRTUEL'].forEach((t, i) => g.fillText(t, 56, 330 + i * 70));
      g.font = '500 30px Manrope, system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,.78)';
      ['Ouvert 24h/24', '100% web', 'Sans installation'].forEach((t, i) => g.fillText(t, 58, 520 + i * 50));
      g.font = '600 24px Manrope, system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,.6)';
      TAGLINE.forEach((t, i) => g.fillText(t, 58, 740 + i * 34));
      g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(58, 860, 80, 4);
      g.font = '700 26px Outfit, system-ui, sans-serif'; g.fillText('ENTRÉE →', 58, 890);
    });
    // lavage lumineux des trumeaux extérieurs (uplights) — texture additive
    const wash = canvasTex(256, 512, (g, w, h) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
      const gr = g.createRadialGradient(w / 2, h * 1.02, 4, w / 2, h * .95, h * .95);
      gr.addColorStop(0, 'rgba(190,212,255,.95)'); gr.addColorStop(.35, 'rgba(60,120,255,.35)'); gr.addColorStop(1, 'rgba(20,92,255,0)');
      g.fillStyle = gr; g.beginPath(); g.ellipse(w / 2, h, w * .42, h * .95, 0, Math.PI, 0); g.fill();
    });
    for (const s of [-1, 1]) {
      const xw = s * (X(219) + HW) / 2;
      const wmm = mesh(new THREE.PlaneGeometry(2.6, 6.2), new THREE.MeshBasicMaterial({ map: wash, color: new THREE.Color(.5, .5, .55), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), xw, 3.1, fF + .012);
      wmm.layers.set(NOREFL);
      mesh(new THREE.BoxGeometry(.3, .08, .18), M.black, xw, .04, fz + .38);
    }
    for (const s of [-1, 1]) {
      const t = mesh(rbox(1, 2.9, .32, .05), M.black, s * 5.4, 1.45, fz + 3.2);
      t.castShadow = true;
      mesh(new THREE.PlaneGeometry(.9, 2.6), new THREE.MeshBasicMaterial({ map: totemTex, color: new THREE.Color(1.05, 1.05, 1.05) }), s * 5.4, 1.47, fz + 3.37);
      contactShadow(1.8, 1.1, s * 5.4, fz + 3.2, scene, true);
    }
  }

  /* ---------- accueil + plan du salon ---------- */
  {
    const g = new THREE.Group(); g.position.set(-5.3, 0, -1.6); g.rotation.y = Math.PI / 2; scene.add(g);
    const desk = mesh(rbox(3.4, 1.05, .8, .06, 3), M.white, 0, .525, 0, g); desk.castShadow = desk.receiveShadow = true;
    mesh(rbox(3.6, .06, 1.0, .02), std({ color: 0x1a1a20, roughness: .22, metalness: .2 }), 0, 1.08, -.05, g).castShadow = true;
    mesh(new THREE.BoxGeometry(3.3, .03, .02), glow(BLUE2, 2.8), 0, .06, .41, g);
    mesh(new THREE.PlaneGeometry(1.8, .22), new THREE.MeshBasicMaterial({ map: signTex('Accueil', 'Welcome', 1200, 128, null), transparent: true, color: new THREE.Color(.95, .95, .95) }), 0, .7, .405, g);
    const scr = mesh(rbox(2.8, 1.6, .1, .03), M.black, 0, 2.6, -1.0, g); scr.castShadow = true;
    mesh(new THREE.PlaneGeometry(2.66, 1.48), new THREE.MeshBasicMaterial({ map: photo(STAGE.img), color: new THREE.Color(.8, .8, .8) }), 0, 2.6, -.94, g);
    mesh(new THREE.CylinderGeometry(.04, .04, 1.9), M.metal, 0, .95, -1.05, g);
    contactShadow(4.4, 2.0, 0, -.1, g);

    const dirTex = canvasTex(600, 1100, (c, w, h) => {
      c.fillStyle = '#0B1630'; c.fillRect(0, 0, w, h);
      drawMark(c, 50, 46, 72, '#ffffff', '#145CFF');
      drawWordmark(c, 138, 104, 46, '#fff', { blue: '#4D82FF' });
      c.fillStyle = '#fff'; c.font = '800 50px Outfit, system-ui, sans-serif'; c.textBaseline = 'top';
      c.fillText('PLAN DU SALON', 50, 150);
      c.fillStyle = '#4D82FF'; c.fillRect(50, 222, 90, 5);
      [...STANDS, STAGE].forEach((d, i) => {
        const y = 270 + i * 128;
        c.fillStyle = '#145CFF'; c.beginPath(); c.arc(82, y + 34, 30, 0, 7); c.fill();
        c.fillStyle = '#fff'; c.font = '700 26px Outfit, system-ui, sans-serif'; c.textAlign = 'center'; c.fillText(String(i + 1).padStart(2, '0'), 82, y + 21); c.textAlign = 'left';
        c.font = '700 32px Outfit, system-ui, sans-serif'; c.fillText(d.title, 136, y + 6);
        c.fillStyle = 'rgba(255,255,255,.55)'; c.font = '500 24px Manrope, system-ui, sans-serif';
        c.fillText(d.sub + (i < 5 ? (d.side < 0 ? ' · à gauche' : ' · à droite') : ' · au fond'), 136, y + 48);
        c.fillStyle = '#fff';
      });
    });
    const t = new THREE.Group(); t.position.set(5.5, 0, -1.4); t.rotation.y = -Math.PI / 2 + .35; scene.add(t);
    mesh(rbox(1.25, 2.5, .26, .05), M.black, 0, 1.25, 0, t).castShadow = true;
    mesh(new THREE.PlaneGeometry(1.1, 2.0), new THREE.MeshBasicMaterial({ map: dirTex, color: new THREE.Color(1.05, 1.05, 1.05) }), 0, 1.35, .135, t);
    mesh(new THREE.BoxGeometry(1.1, .02, .02), glow(BLUE2, 2.8), 0, .1, .14, t);
    contactShadow(1.8, 1, 0, 0, t, true);
  }

  /* ---------- bannières suspendues ---------- */
  const banners = [];
  {
    const texts = [['SALON', 'VIRTUEL', '2026'], ['100%', 'WEB', 'Immersif'], ['OUVERT', '24/7', 'Partout'], ['ZÉRO', 'LOGISTIQUE', 'Impact max']];
    const pos = [[-3.9, -6.2], [3.9, -15.2], [-3.9, -33.2], [3.9, -42.2]];
    pos.forEach(([x, z], i) => {
      const [a, b, c] = texts[i];
      const tx = canvasTex(400, 1100, (g, w, h) => {
        const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, i % 2 ? '#FFFFFF' : '#0B214A'); gr.addColorStop(.6, i % 2 ? '#F1F4FA' : '#0A3FCC'); gr.addColorStop(1, i % 2 ? '#E3E8F2' : '#145CFF');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
        const ink = i % 2 ? '#0B214A' : '#ffffff';
        drawMark(g, 60, 70, 110, ink, i % 2 ? '#145CFF' : '#4D82FF');
        drawWordmark(g, 58, 262, 50, ink, { blue: i % 2 ? '#145CFF' : '#4D82FF' });
        g.fillStyle = ink; g.textBaseline = 'top';
        g.font = '800 92px Outfit, system-ui, sans-serif'; g.fillText(a, 52, 560);
        g.font = `800 ${b.length > 6 ? 54 : 92}px Outfit, system-ui, sans-serif`; g.fillText(b, 52, 660);
        g.font = '500 34px Manrope, system-ui, sans-serif'; g.globalAlpha = .7; g.fillText(c, 56, 800); g.globalAlpha = 1;
        g.fillRect(56, 990, 60, 5);
      });
      const grp = new THREE.Group(); grp.position.set(x, H - .7, z); scene.add(grp);
      const mat = std({ map: tx, roughness: .85, emissive: 0xffffff, emissiveMap: tx, emissiveIntensity: .22, side: THREE.FrontSide });
      for (const s of [1, -1]) { const p = mesh(new THREE.PlaneGeometry(1.25, 3.4), mat, 0, -1.9, s * .006, grp); p.rotation.y = s > 0 ? 0 : Math.PI; }
      mesh(new THREE.BoxGeometry(1.35, .05, .05), M.metal, 0, -.18, 0, grp);
      mesh(new THREE.BoxGeometry(1.35, .04, .04), M.metal, 0, -3.62, 0, grp);
      for (const s of [-1, 1]) mesh(new THREE.CylinderGeometry(.005, .005, .5), M.black, s * .5, .08, 0, grp);
      banners.push(grp);
    });
  }

  /* ---------- habillage des murs libres : visuels + banquettes ---------- */
  {
    const posters = [
      ['Exposez', 'partout.', 'Vos stands ouverts au monde entier, 24h/24.'],
      ['La rencontre', 'reste.', 'Rendez-vous, démos et networking en direct.'],
      ['Chaque visite', 'compte.', 'Statistiques de fréquentation en temps réel.'],
      ['Sans murs,', 'sans limite.', 'Un salon accessible depuis un simple navigateur.'],
      ['Votre marque', 'en 3D.', 'Produits, matériaux et finitions à l’échelle 1.'],
    ];
    const gaps = [[-1, -20], [1, -11], [-1, -38], [1, -29], [1, -47]];
    gaps.forEach(([side, z], i) => {
      const [a, b, c] = posters[i];
      const tx = canvasTex(1024, 640, (g, w, h) => {
        const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#0B214A'); gr.addColorStop(.55, '#0A3FCC'); gr.addColorStop(1, '#4D82FF');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
        g.globalAlpha = .12; drawMark(g, w - 470, 50, 540, '#ffffff', '#ffffff'); g.globalAlpha = 1;
        g.fillStyle = '#fff'; g.textBaseline = 'top';
        g.font = '800 96px Outfit, system-ui, sans-serif'; g.fillText(a.toUpperCase(), 70, 150);
        g.fillStyle = '#AFC6FF'; g.fillText(b.toUpperCase(), 70, 250);
        g.fillStyle = 'rgba(255,255,255,.8)'; g.font = '500 34px Manrope, system-ui, sans-serif'; g.fillText(c, 74, 400);
        drawMark(g, 74, 516, 54, '#ffffff', '#4D82FF'); drawWordmark(g, 140, 562, 34, '#fff', { blue: '#4D82FF' });
      });
      const grp = new THREE.Group(); grp.position.set(side * (HW - .02), 0, z); grp.rotation.y = -side * Math.PI / 2; scene.add(grp);
      mesh(rbox(5.4, 3.5, .14, .03), M.black, 0, 3.3, .07, grp);
      mesh(new THREE.PlaneGeometry(5.2, 3.25), new THREE.MeshBasicMaterial({ map: tx, color: new THREE.Color(.92, .92, .92) }), 0, 3.3, .145, grp);
      mesh(new THREE.BoxGeometry(5.2, .025, .03), glow(BLUE2, 2.8), 0, 1.5, .15, grp);
      // banquette
      const bench = mesh(rbox(2.6, .42, .62, .08, 3), i % 2 ? M.fabric : M.fabricGrey, 0, .29, 1.2, grp); bench.castShadow = true;
      mesh(rbox(2.5, .08, .52, .02), M.black, 0, .04, 1.2, grp);
      contactShadow(3.4, 1.4, 0, 1.2, grp);
      if (i === 1 || i === 3) {   // jardinière
        mesh(new THREE.CylinderGeometry(.34, .28, .7, 40), M.white, 1.9, .35, 1.25, grp).castShadow = true;
        const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(.42, 1), std({ color: 0x1f3a26, roughness: .9, flatShading: true }));
        leaves.position.set(1.9, 1.05, 1.25); leaves.scale.set(1, 1.25, 1); leaves.castShadow = true; grp.add(leaves);
        contactShadow(1.1, 1.1, 1.9, 1.25, grp, true);
      }
    });
  }

  /* ---------- espace networking (rond central) ---------- */
  const ring = { x: 0, z: -24, r: 2.25 };
  const logoSpin = new THREE.Group(), lidHinge = new THREE.Group();
  {
    const g = new THREE.Group(); g.position.set(ring.x, 0, ring.z); scene.add(g);
    const prof = [[1.35, 0], [2.05, 0], [2.1, .05], [2.1, .42], [2.05, .46], [1.35, .46], [1.3, .42], [1.3, .05]].map(([x, y]) => new THREE.Vector2(x, y));
    const seat = mesh(new THREE.LatheGeometry(prof, 72), M.fabric, 0, 0, 0, g); seat.castShadow = seat.receiveShadow = true;
    mesh(new THREE.TorusGeometry(1.31, .015, 6, 96), glow(BLUE2, 2.8), 0, .05, 0, g).rotation.x = Math.PI / 2;
    mesh(new THREE.CylinderGeometry(.75, .8, .9, 64), std({ color: 0x0d1220, roughness: .25, metalness: .5 }), 0, .45, 0, g).castShadow = true;
    mesh(new THREE.CylinderGeometry(.7, .7, .02, 64), glow(BLUE, 2), 0, .91, 0, g);
    contactShadow(5.4, 5.4, 0, 0, g, true);
    // la marque en vrai volume : boîte ouverte en lévitation, couvercle qui respire
    {
      const sz = .6, t = .045, gp = .11, h = sz / 2;
      const shell = phys({ color: 0xf2f3f6, roughness: .2, metalness: .1, clearcoat: 1 });
      logoSpin.position.set(0, 1.4, 0); g.add(logoSpin);
      const box = new THREE.Group(); logoSpin.add(box);
      const W = (w, hh, d, x, y, z) => mesh(rbox(w, hh, d, .012), shell, x, y, z, box);
      W(sz, t, sz, 0, -h + t / 2, 0);                                // fond
      // 4 parois, écartées sur deux arêtes opposées : l’écart du « Y » se lit sous tous les angles
      W(sz - gp, sz, t, -gp / 2, 0, h - t / 2);                      // avant
      W(t, sz, sz - gp, h - t / 2, 0, -gp / 2);                      // droite
      W(sz - gp, sz, t, gp / 2, 0, -h + t / 2);                      // dos (porte la charnière)
      W(t, sz, sz - gp, -h + t / 2, 0, gp / 2);                      // gauche
      mesh(new THREE.PlaneGeometry(sz - 2 * t, sz - 2 * t), glow(BLUE, 2.4), 0, -h + t + .003, 0, box).rotation.x = -Math.PI / 2;   // lumière intérieure
      lidHinge.position.set(0, h, -h); box.add(lidHinge);
      mesh(rbox(sz + .02, t, sz + .02, .012), M.lid, 0, t / 2, sz / 2, lidHinge);
    }
    // anneau lumineux suspendu
    mesh(new THREE.TorusGeometry(2.0, .05, 12, 128), glow(0xfff0dc, 3.2), 0, 5.2, 0, g).rotation.x = Math.PI / 2;
    mesh(new THREE.TorusGeometry(2.0, .075, 12, 128, Math.PI * 2), M.black, 0, 5.26, 0, g).rotation.x = Math.PI / 2;
    for (let a = 0; a < 3; a++) mesh(new THREE.CylinderGeometry(.006, .006, H - 5.26), M.black, Math.cos(a * 2.094) * 2, (H + 5.26) / 2, Math.sin(a * 2.094) * 2, g);
    const pl = new THREE.PointLight(0xffe6c8, 26, 9, 2); pl.position.set(0, 4.6, 0); g.add(pl);
  }

  /* ---------- scène principale ---------- */
  const stage = { z0: -L };
  const seatsBox = { x0: -3.4, x1: 7, z0: -L + 6.6, z1: -L + 12.8 };
  {
    const z0 = -L;
    const plat = mesh(rbox(HW * 2 - .3, .55, 5, .03), std({ color: 0x111521, roughness: .35, metalness: .2 }), 0, .275, z0 + 2.5);
    plat.receiveShadow = true;
    mesh(new THREE.BoxGeometry(HW * 2 - .4, .025, .03), glow(BLUE2, 2.8), 0, .52, z0 + 5.01);
    mesh(new THREE.BoxGeometry(HW * 2 - .4, .025, .03), glow(BLUE2, 2.5), 0, .04, z0 + 5.02);
    for (const x of [-1.2, 4.8]) { mesh(rbox(1.6, .18, .5, .02), M.black, x, .09, z0 + 5.25); mesh(rbox(1.6, .36, .5, .02), M.black, x, .18, z0 + 4.95); }
    const tex = photo(STAGE.img);
    const sw = 11, sh = sw / (2560 / 1196);
    mesh(rbox(sw + .4, sh + .4, .2, .04), M.black, 1.8, 3.75, z0 + .2);
    const screen = mesh(new THREE.PlaneGeometry(sw, sh), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(.95, .95, .95) }), 1.8, 3.75, z0 + .31);
    screen.userData.stand = STANDS.length;
    for (const x of [1.8 - sw / 2 - .55, 1.8 + sw / 2 + .55]) mesh(new THREE.BoxGeometry(.08, sh + .3, .05), glow(BLUE2, 3.6), x, 3.75, z0 + .3);
    // pupitre
    const lect = mesh(rbox(.7, 1.15, .5, .04), M.white, 4.6, .55 + .575, z0 + 3.4); lect.castShadow = true;
    mesh(new THREE.PlaneGeometry(.5, .14), new THREE.MeshBasicMaterial({ map: signTex('Neokrome', '', 900, 128, null), transparent: true }), 4.6, 1.35, z0 + 3.66);
    // logo en volume (marque extrudée, proportions exactes)
    const logo = new THREE.Group(); logo.position.set(-7.95, .55, z0 + .9); logo.rotation.y = .18; scene.add(logo);
    const mk = markGeo(3.8, .35, .03);
    mesh(mk.panels, std({ color: 0xe9ecf2, roughness: .35, metalness: .1 }), 0, 0, 0, logo).castShadow = true;
    mesh(mk.lid, M.lid, 0, 0, .06, logo);
    // pont lumière
    mesh(new THREE.BoxGeometry(HW * 2 - .6, .3, .3), M.metal, 0, 6.7, z0 + 6.5);
    const cans = [];
    for (const x of [-5.5, -2, 1.8, 5.5]) {
      const c = new THREE.Group(); c.position.set(x, 6.45, z0 + 6.5); c.lookAt(x * .7 + .5, 1.5, z0 + 2); scene.add(c);
      mesh(new THREE.CylinderGeometry(.13, .1, .36, 24), M.black, 0, 0, 0, c).rotation.x = Math.PI / 2;
      mesh(new THREE.CircleGeometry(.1, 24), glow(0xfff2e0, 6), 0, 0, .181, c);
      cans.push(c);
    }
    const st = new THREE.SpotLight(0xfff3e6, 260, 26, .62, .7, 2);
    st.position.set(1.8, 6.45, z0 + 6.5); st.target.position.set(1.8, 1.2, z0 + 2); scene.add(st, st.target);
    if (!mobile) { st.castShadow = true; st.shadow.mapSize.set(1024, 1024); st.shadow.bias = -.0004; st.shadow.normalBias = .02; st.shadow.camera.near = 1; st.shadow.camera.far = 14; }
    for (const x of [-6, 7]) { const w = new THREE.PointLight(0x3f8cff, 22, 9, 2); w.position.set(x, 3.4, z0 + 2.2); scene.add(w); }
    // gradins
    const chair = rbox(.5, .1, .5, .03), back = rbox(.5, .55, .07, .025), leg = new THREE.BoxGeometry(.04, .42, .04);
    const N = 36, seatM = new THREE.InstancedMesh(chair, M.fabric, N), backM = new THREE.InstancedMesh(back, M.fabric, N), legM = new THREE.InstancedMesh(leg, M.metal, N * 2);
    const m4 = new THREE.Matrix4(); let n = 0;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 10; c++) {
      if (c === 4 || c === 5) continue;
      if (n >= N) break;
      const x = -2.8 + c * 1.02 + 1.6, z = z0 + 7.3 + r * 1.45;
      seatM.setMatrixAt(n, m4.makeTranslation(x, .47, z)); backM.setMatrixAt(n, m4.makeTranslation(x, .8, z + .24));
      legM.setMatrixAt(n * 2, m4.makeTranslation(x - .2, .21, z)); legM.setMatrixAt(n * 2 + 1, m4.makeTranslation(x + .2, .21, z));
      n++;
    }
    seatM.count = backM.count = n; legM.count = n * 2;
    seatM.castShadow = backM.castShadow = true;
    scene.add(seatM, backM, legM);
    contactShadow(11, 7, 1.8, z0 + 9.5, scene);
    stage.screen = screen; stage.light = st;
  }

  /* ---------- stands ---------- */
  const pickables = [stage.screen], anchors = [], focusPts = [], updaters = [], spotLights = [stage.light], products = [];
  anchors[STANDS.length] = new THREE.Vector3(1.8, 6.6, -L + 1);
  focusPts[STANDS.length] = { pos: new THREE.Vector3(1.8, EYE + .2, -L + 15.5), look: new THREE.Vector3(1.8, 3.3, -L), data: STAGE };

  function builtinStand({ data, index }) {
    const g = new THREE.Group(), pk = [], lights = [];
    const add = (geo, mat, x, y, z, cast = true, recv = true) => { const m = mesh(geo, mat, x, y, z, g); m.castShadow = cast; m.receiveShadow = recv; return m; };
    const accent = [BLUE2, 0xff7a3d, 0x2fd3c4, 0x4D82FF, 0xd8b46a][index % 5];
    pk.push(add(rbox(9.2, .16, 4.8, .03), std({ color: 0x5f5c57, roughness: .62 }), 0, .08, -.2, false));
    add(new THREE.BoxGeometry(9.0, .02, .02), glow(accent, 3), 0, .03, 2.21, false, false);
    pk.push(add(rbox(9.2, 5.4, .3, .04), std({ color: 0x1a1a20, roughness: .62 }), 0, 2.86, -2.45, false));
    const aspect = data.aspect || 1032 / 796;
    const sw = Math.min(7.2, 3.3 * aspect), sh = sw / aspect;
    add(rbox(sw + .18, sh + .18, .08, .02), M.black, 0, 2.95, -2.28, false);
    pk.push(add(new THREE.PlaneGeometry(sw, sh), new THREE.MeshBasicMaterial({ map: photo(data.img), color: new THREE.Color(.86, .86, .86) }), 0, 2.95, -2.235, false, false));
    add(new THREE.BoxGeometry(sw, .025, .03), glow(accent, 3), 0, 2.95 - sh / 2 - .26, -2.27, false, false);
    // fronton lumineux
    add(rbox(9.2, .64, .34, .03), M.black, 0, 5.88, -2.25, false);
    add(new THREE.PlaneGeometry(8.6, .5), new THREE.MeshBasicMaterial({ map: signTex(data.title, data.sub), color: new THREE.Color(1.1, 1.1, 1.1) }), 0, 5.88, -2.075, false, false);
    // cloison latérale + vitrage
    add(rbox(.16, 3.5, 2.6, .03), M.white, -4.52, 1.91, -1.15);
    add(new THREE.BoxGeometry(.035, 3.5, .035), glow(accent, 3), -4.52, 1.91, .16, false, false);
    add(new THREE.BoxGeometry(.02, 1.05, 2.3), M.glass, 4.5, .7, -.9, false, false);
    add(new THREE.BoxGeometry(.05, .04, 2.34), M.chrome, 4.5, 1.24, -.9, false);
    // comptoir
    const counter = add(rbox(2.0, .98, .72, .05, 3), std({ color: 0xc9c5bd, roughness: .6 }), 2.55, .16 + .49, 1.0);
    pk.push(counter);
    add(rbox(2.14, .05, .84, .02), std({ color: 0x1c1c22, roughness: .22, metalness: .3 }), 2.55, 1.165, .98);
    add(new THREE.PlaneGeometry(1.1, .12), new THREE.MeshBasicMaterial({ map: signTex(data.title, '', 1000, 110, null), transparent: true, color: new THREE.Color(.25, .25, .3) }), 2.55, .78, 1.365, false, false);
    // socle + objet
    add(new THREE.CylinderGeometry(.44, .5, .95, 48), std({ color: 0x0e0e13, roughness: .2, metalness: .45 }), -2.3, .16 + .475, .65);
    add(new THREE.TorusGeometry(.45, .012, 8, 72), glow(accent, 3), -2.3, 1.12, .65, false, false).rotation.x = Math.PI / 2;
    add(rbox(.86, .9, .86, .02), M.glass, -2.3, 1.56, .65, false, false);
    const geos = [new THREE.TorusKnotGeometry(.2, .07, 160, 20), new THREE.IcosahedronGeometry(.28, 0), new THREE.OctahedronGeometry(.3, 0)];
    const mats = [phys({ color: 0xe8e8ee, metalness: 1, roughness: .08 }), phys({ color: BLUE, roughness: .18, clearcoat: 1, metalness: .1 }), phys({ color: 0xd8b46a, metalness: 1, roughness: .2 })];
    const prod = add(geos[index % 3], mats[index % 3], -2.3, 1.55, .65);
    // tabourets
    for (const x of [-.4, .5]) add(new THREE.CylinderGeometry(.22, .22, .46, 32), M.fabric, x, .16 + .23, 1.2);
    // pont lumière et projecteurs
    add(new THREE.BoxGeometry(9.0, .12, .12), M.black, 0, 6.12, 2.0, false);
    for (const x of [-3, 0, 3]) {
      const c = new THREE.Group(); c.position.set(x, 5.92, 2.0); c.lookAt(x * .5, 1.8, -2); g.add(c);
      const b = new THREE.Mesh(new THREE.CylinderGeometry(.09, .07, .26, 20), M.black); b.rotation.x = Math.PI / 2; c.add(b);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(.07, 20), glow(0xfff0dc, 6)); lens.position.z = .131; c.add(lens);
    }
    const spot = new THREE.SpotLight(0xffe7cf, 110, 16, .78, .75, 2);
    spot.position.set(0, 5.9, 2.2); spot.target.position.set(0, 1.6, -2.0);
    g.add(spot, spot.target);
    if (!mobile) { spot.castShadow = true; spot.shadow.mapSize.set(1024, 1024); spot.shadow.bias = -.0004; spot.shadow.normalBias = .02; spot.shadow.camera.near = .5; spot.shadow.camera.far = 12; }
    lights.push(spot);
    const time0 = index * 1.7;
    return {
      group: g, pickables: pk, lights,
      anchor: new THREE.Vector3(0, 4.7, 1.6),
      focus: { pos: new THREE.Vector3(.5, EYE, 7.5), look: new THREE.Vector3(0, 2.5, -2.3) },
      update(dt, t) { prod.rotation.y += dt * .5; prod.rotation.x = Math.sin(t * .6 + time0) * .3; prod.position.y = 1.55 + Math.sin(t * 1.2 + time0) * .05; },
    };
  }

  function placeStand(s, d, i) {
    const g = s.group;
    g.position.set(d.side * (HW - 2.6), 0, d.z);
    g.rotation.y = d.side < 0 ? Math.PI / 2 : -Math.PI / 2;
    scene.add(g);
    contactShadow(10, 5.8, 0, -.25, g);
    // numéro au sol
    const nt = canvasTex(256, 256, (c, w) => {
      c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 6; c.beginPath(); c.arc(w / 2, w / 2, w / 2 - 8, 0, 7); c.stroke();
      c.fillStyle = '#fff'; c.font = '800 112px Outfit, system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(String(i + 1).padStart(2, '0'), w / 2, w / 2 + 6);
    }, false);
    const num = mesh(new THREE.PlaneGeometry(1.1, 1.1), new THREE.MeshBasicMaterial({ map: nt, transparent: true, opacity: .22, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }), 0, .006, 3.4, g);
    num.rotation.x = -Math.PI / 2; num.layers.set(NOREFL);
    g.updateMatrixWorld(true);
    (s.pickables || []).forEach(m => { m.userData.stand = i; pickables.push(m); });
    anchors[i] = g.localToWorld((s.anchor || new THREE.Vector3(0, 4.6, 1.5)).clone());
    const f = s.focus || { pos: new THREE.Vector3(.5, EYE, 7.5), look: new THREE.Vector3(0, 2.5, -2.3) };
    focusPts[i] = { pos: g.localToWorld(f.pos.clone()), look: g.localToWorld(f.look.clone()), data: d };
    if (typeof s.update === 'function') updaters.push(s.update);
    (s.lights || []).forEach(l => {
      if (!l.isSpotLight) return;
      if (l.target && !l.target.parent) g.add(l.target);
      if (mobile) l.castShadow = false;
      else if (l.castShadow) { l.shadow.bias = l.shadow.bias || -.0004; l.shadow.normalBias = l.shadow.normalBias || .02; }
      if (s.__module) l.userData.noCone = true;
      spotLights.push(l);
    });
  }

  const standData = i => ({ img: STANDS[i].img, title: STANDS[i].title, sub: STANDS[i].sub, desc: STANDS[i].desc, aspect: STANDS[i].aspect || 1032 / 796 });
  async function buildStands() {
    let mod = null;
    try { mod = await import('./hall-stands.js').catch(() => null); } catch (e) { mod = null; }
    const usable = typeof mod?.buildStand === 'function';
    el.dataset.stands = usable ? 'module' : 'builtin';
    for (let i = 0; i < STANDS.length; i++) {
      const d = STANDS[i];
      await nextTask();   // un stand par tâche : textures procédurales réparties, pas de long blocage
      let s = null;
      if (usable) {
        try {
          s = mod.buildStand({ THREE, data: standData(i), index: i, mobile, photo, sign, envMap: scene.environment });
          if (!s || !s.group || !s.group.isObject3D) s = null; else s.__module = true;
        } catch (e) { console.warn('[hall] stand', i, e); s = null; }
      }
      if (!s) s = builtinStand({ data: standData(i), index: i });
      placeStand(s, d, i);
    }
    await nextTask();
    buildVolumes();
    shadowDirty = true;
    standsBuilt = true;
    manager.itemEnd('stands');
    if (pendingFocus !== null) { const k = pendingFocus; pendingFocus = null; focusStand(k); }
  }

  /* ---------- faisceaux volumétriques + poussière dans la lumière ---------- */
  const cones = [];
  const coneMat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color() }, k: { value: .06 } },
    vertexShader: `varying vec3 vN; varying vec3 vV; varying float vY; uniform float hgt;
      void main(){ vY = position.y; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 color; uniform float k; varying vec3 vN; varying vec3 vV; varying float vY;
      void main(){ float f = abs(dot(normalize(vN), normalize(vV)));
        float t = clamp(-vY, 0.0, 1.0);
        float a = pow(f, 2.2) * pow(1.0 - t, 1.6) * smoothstep(0.0, .06, t) * smoothstep(.0, 2.0, length(vV));
        gl_FragColor = vec4(color * a * k, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  let dust = null;
  function buildVolumes() {
    const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), up = new THREE.Vector3(0, -1, 0);
    spotLights.forEach(l => {
      l.updateMatrixWorld(true); l.target.updateMatrixWorld(true);
      tmpA.setFromMatrixPosition(l.matrixWorld); tmpB.setFromMatrixPosition(l.target.matrixWorld);
      const dir = tmpB.clone().sub(tmpA).normalize();
      if (dir.y > -.2) return;
      const len = Math.min(tmpA.y / -dir.y, 9);
      const rad = Math.tan(Math.min(l.angle, 1)) * len * .8;
      const geo = new THREE.ConeGeometry(rad, len, 40, 1, true);
      geo.translate(0, -len / 2, 0);
      geo.scale(1, 1 / len, 1);   // y local ∈ [-1, 0]
      if (!l.userData.noCone) {   // les stands du module ont déjà leurs faisceaux
        const m = coneMat.clone(); m.uniforms.color.value.copy(l.color); m.uniforms.k.value = .05;
        const c = new THREE.Mesh(geo, m);
        c.scale.y = len;
        c.position.copy(tmpA); c.quaternion.setFromUnitVectors(up, dir);
        c.layers.set(NOREFL); c.renderOrder = 5;
        scene.add(c);
      }
      cones.push({ apex: tmpA.clone(), dir, len, rad });
    });
    // poussière en suspension, uniquement dans les faisceaux
    const per = mobile ? 26 : 60, n = cones.length * per;
    if (!n) return;
    const pos = new Float32Array(n * 3), seeds = new Float32Array(n * 4), r = rng(11);
    for (let i = 0; i < n; i++) { seeds[i * 4] = r(); seeds[i * 4 + 1] = Math.sqrt(r()); seeds[i * 4 + 2] = r() * 6.283; seeds[i * 4 + 3] = .4 + r() * .6; }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ map: softTex('dot'), color: new THREE.Color(1.4, 1.3, 1.15), size: .03, transparent: true, opacity: .8, depthWrite: false, blending: THREE.AdditiveBlending }));
    pts.layers.set(NOREFL); pts.frustumCulled = false; scene.add(pts);
    const basis = cones.map(c => { const u = new THREE.Vector3(1, 0, 0); if (Math.abs(c.dir.x) > .9) u.set(0, 0, 1); u.cross(c.dir).normalize(); const v = c.dir.clone().cross(u).normalize(); return { u, v }; });
    dust = { geo, pos, seeds, per, basis };
  }
  function updateDust(dt, t) {
    if (!dust) return;
    const { pos, seeds, per, basis } = dust;
    for (let i = 0; i < pos.length / 3; i++) {
      const c = cones[(i / per) | 0], b = basis[(i / per) | 0];
      let s = seeds[i * 4] + dt * .006 * seeds[i * 4 + 3]; if (s > 1) s -= 1; seeds[i * 4] = s;
      const along = .12 + s * .78, rr = seeds[i * 4 + 1] * c.rad * along * .9, a = seeds[i * 4 + 2] + t * .05 * seeds[i * 4 + 3];
      const ox = Math.cos(a) * rr, oy = Math.sin(a) * rr, L2 = along * c.len;
      pos[i * 3] = c.apex.x + c.dir.x * L2 + b.u.x * ox + b.v.x * oy;
      pos[i * 3 + 1] = c.apex.y + c.dir.y * L2 + b.u.y * ox + b.v.y * oy + Math.sin(t * .3 + i) * .02;
      pos[i * 3 + 2] = c.apex.z + c.dir.z * L2 + b.u.z * ox + b.v.z * oy;
    }
    dust.geo.attributes.position.needsUpdate = true;
  }

  /* ---------- marqueur au sol ---------- */
  const marker = new THREE.Group(); marker.visible = false; scene.add(marker);
  {
    const ringM = new THREE.Mesh(new THREE.PlaneGeometry(.9, .9), new THREE.MeshBasicMaterial({ map: softTex('ring'), color: new THREE.Color(1.1, 1.35, 1.9), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    const dotM = new THREE.Mesh(new THREE.PlaneGeometry(.22, .22), new THREE.MeshBasicMaterial({ map: softTex('dot'), color: new THREE.Color(.75, .95, 1.7), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    for (const m of [ringM, dotM]) { m.rotation.x = -Math.PI / 2; m.position.y = .012; m.layers.set(NOREFL); marker.add(m); }
    marker.userData.ring = ringM;
  }

  /* ---------- post-traitement ---------- */
  const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: isGL2 ? 4 : 0 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), .42, .6, 1.1);
  bloom.highPassUniforms.smoothWidth.value = .35;
  // protège le bloom des pixels NaN/Inf (spéculaires extrêmes en demi-flottant)
  bloom.materialHighPassFilter.fragmentShader = bloom.materialHighPassFilter.fragmentShader.replace(
    'vec4 texel = texture2D( tDiffuse, vUv );', 'vec4 texel = texture2D( tDiffuse, vUv ); if (!(dot(texel.rgb, vec3(1.0)) < 6e4)) texel = vec4(0.0); texel.rgb = min(texel.rgb, vec3(48.0));');
  bloom.materialHighPassFilter.needsUpdate = true;
  composer.addPass(bloom);
  const finalPass = new ShaderPass(FinalShader);
  composer.addPass(finalPass);

  /* ---------- hotspots + liste des espaces ---------- */
  const ALL = [...STANDS, STAGE];
  const spots = ALL.map((d, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'hall-spot';
    b.innerHTML = `<b>${String(i + 1).padStart(2, '0')}</b><span>${d.title}</span>`;
    b.addEventListener('click', e => { e.stopPropagation(); if (!immersive) enterImmersive(); stopTour(); focusStand(i); });
    spotsEl.appendChild(b);
    return b;
  });
  const items = ALL.map((d, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<button type="button"><b>${String(i + 1).padStart(2, '0')}</b><span>${d.title}<small>${d.sub}</small></span></button>`;
    li.firstChild.addEventListener('click', () => { stopTour(); focusStand(i); if (mobile) panel.classList.add('closed'); });
    listEl.appendChild(li);
    return li;
  });
  $('.hall-panel-t').addEventListener('click', () => {
    panel.classList.toggle('closed');
    $('.hall-panel-t').setAttribute('aria-expanded', String(!panel.classList.contains('closed')));
  });

  /* ---------- caméra ---------- */
  const cam = { pos: new THREE.Vector3(0, EYE, opts.mode === 'scroll' ? 15.5 : 2.2), yaw: 0, pitch: opts.mode === 'scroll' ? .08 : 0 };
  const look = { yaw: 0, pitch: .02 };     // cible de regard (explore)
  const vel = new THREE.Vector3();
  let tween = null, current = -1, pendingFocus = null, standsBuilt = false, shadowDirty = true;
  const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
  const keys = new Set();
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(-9, -9);
  const tmp = new THREE.Vector3();
  const easeIO = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
  const clamp = THREE.MathUtils.clamp;

  function clampPos(p, prevZ) {
    p.x = clamp(p.x, -HW + .7, HW - .7);
    p.z = clamp(p.z, -L + 5.6, 13);
    if (prevZ !== undefined && Math.abs(p.x) > 2.75 && (prevZ - 4) * (p.z - 4) <= 0) p.z = prevZ;
    if (Math.abs(p.z - 4) < .6 && Math.abs(p.x) > 2.75) p.x = Math.sign(p.x) * 2.75;
    for (const d of STANDS) if (Math.abs(p.z - d.z) < 4.9 && d.side * p.x > 4.0) p.x = d.side * 4.0;
    const dx = p.x - ring.x, dz = p.z - ring.z, dd = Math.hypot(dx, dz);
    if (dd < ring.r + .35) { const k = (ring.r + .35) / (dd || 1); p.x = ring.x + dx * k; p.z = ring.z + dz * k; }
    const b = seatsBox;
    if (p.x > b.x0 && p.x < b.x1 && p.z > b.z0 && p.z < b.z1) {
      const opts2 = [[p.x - b.x0, 'x', b.x0], [b.x1 - p.x, 'x', b.x1], [p.z - b.z0, 'z', b.z0], [b.z1 - p.z, 'z', b.z1]].sort((a, c) => a[0] - c[0]);
      p[opts2[0][1]] = opts2[0][2];
    }
    if (Math.abs(p.x + 5.3) < 1.1 && Math.abs(p.z + 1.6) < 2.2) p.x = p.x < -5.3 ? -6.4 : -4.2;   // accueil
    return p;
  }
  function lookAngles(from, to) {
    tmp.subVectors(to, from);
    return { yaw: Math.atan2(-tmp.x, -tmp.z), pitch: Math.atan2(tmp.y, Math.hypot(tmp.x, tmp.z)) };
  }
  function glideTo(pos, yaw = look.yaw, pitch = look.pitch, dur) {
    const dist = cam.pos.distanceTo(pos);
    const y1 = cam.yaw + angDiff(cam.yaw, yaw);
    tween = { p0: cam.pos.clone(), p1: pos.clone(), y0: cam.yaw, y1, q0: cam.pitch, q1: pitch, t: 0,
      dur: dur || clamp(dist / 4.5 + Math.abs(y1 - cam.yaw) * .35, .9, 3.4) };
    vel.set(0, 0, 0);
    return tween.dur;
  }
  function focusStand(i) {
    i = ((i % ALL.length) + ALL.length) % ALL.length;
    const f = focusPts[i];
    if (!f) { pendingFocus = i; return 0; }
    if (mode !== 'explore' && !immersive) return 0;
    const a = lookAngles(f.pos, f.look);
    const d = glideTo(f.pos, a.yaw, a.pitch);
    current = i;
    card.querySelector('small').textContent = `${String(i + 1).padStart(2, '0')} — ${f.data.sub}`;
    card.querySelector('h3').textContent = f.data.title;
    card.querySelector('p').textContent = f.data.desc;
    card.classList.add('on');
    items.forEach((li, k) => li.classList.toggle('on', k === i));
    return d;
  }
  const hideCard = () => { card.classList.remove('on'); current = -1; items.forEach(li => li.classList.remove('on')); };
  card.querySelector('.x').addEventListener('click', () => { stopTour(); hideCard(); });
  card.querySelector('.prev').addEventListener('click', () => { stopTour(); focusStand((current < 0 ? 0 : current) - 1); });
  card.querySelector('.next').addEventListener('click', () => { stopTour(); focusStand(current + 1); });

  /* visite guidée */
  let tour = null;
  function startTour() {
    tour = { i: -1, wait: 0 };
    tourBtn.classList.add('on'); tourBtn.querySelector('span').textContent = 'Arrêter la visite';
    nextStop();
  }
  function nextStop() { tour.i = (tour.i + 1) % ALL.length; tour.wait = focusStand(tour.i) + 6.5; }
  function stopTour() {
    if (!tour) return;
    tour = null; tourBtn.classList.remove('on'); tourBtn.querySelector('span').textContent = 'Visite guidée';
  }
  tourBtn.addEventListener('click', () => tour ? stopTour() : startTour());

  function setMode(m) {
    mode = m; el.dataset.mode = m;
    marker.visible = false;
    if (m !== 'explore') { hideCard(); stopTour(); }
  }
  const slot = document.createComment('hall');
  let helpTimer = 0;
  function enterImmersive() {
    if (immersive) return;
    immersive = true; prevMode = mode;
    // sortir le salon de son conteneur (contexte d'empilement) pour couvrir toute la page
    el.before(slot); document.body.appendChild(el);
    el.classList.add('hall-immersive');
    el.classList.remove('help-off');
    document.documentElement.classList.add('hall-lock');
    setMode('explore');
    look.yaw = cam.yaw; look.pitch = cam.pitch;
    if (cam.pos.z > 3) glideTo(new THREE.Vector3(0, EYE, 1), 0, -.03, 1.8);
    clearTimeout(helpTimer); helpTimer = setTimeout(() => el.classList.add('help-off'), 9000);
    resize(); canvas.focus({ preventScroll: true });
  }
  function exitImmersive() {
    if (!immersive) return;
    immersive = false;
    el.classList.remove('hall-immersive');
    slot.replaceWith(el);
    document.documentElement.classList.remove('hall-lock');
    tween = null; keys.clear(); vel.set(0, 0, 0);
    setMode(prevMode); resize();
    el.dispatchEvent(new CustomEvent('hall:exit'));
  }
  $('.hall-close').addEventListener('click', exitImmersive);

  /* ---------- entrées ---------- */
  let down = null;
  canvas.addEventListener('pointerdown', e => {
    if (mode !== 'explore') return;
    down = { x: e.clientX, y: e.clientY, moved: 0, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', e => {
    const r = el.getBoundingClientRect();
    ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    if (mode !== 'explore') return;
    if (down) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      down.moved += Math.abs(dx) + Math.abs(dy); down.x = e.clientX; down.y = e.clientY;
      if (down.moved > 5) {
        if (tween) { look.yaw = cam.yaw; look.pitch = cam.pitch; tween = null; }
        stopTour();
        const k = (e.pointerType === 'touch' ? .0062 : .0038) * camera.fov / 54;
        look.yaw += dx * k; look.pitch = clamp(look.pitch + dy * k, -.7, .55);
      }
    }
    hoverDirty = true;
  });
  canvas.addEventListener('pointerup', e => {
    if (mode === 'attract') { opts.onActivate ? opts.onActivate() : enterImmersive(); return; }
    canvas.style.cursor = '';
    if (mode !== 'explore' || !down) return;
    const click = down.moved <= 6; down = null;
    if (!click) return;
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([floor, ...pickables], false)[0];
    if (!hit) return;
    stopTour();
    if (hit.object.userData.stand !== undefined) focusStand(hit.object.userData.stand);
    else {
      hideCard();
      const p = clampPos(hit.point.clone());
      p.y = EYE;
      glideTo(p);
      marker.visible = true; marker.position.set(p.x, 0, p.z); marker.userData.pulse = 1;
    }
  });
  canvas.addEventListener('pointerleave', () => { marker.visible = false; ndc.set(-9, -9); });
  let hoverDirty = false;
  function hoverFloor() {
    if (!hoverDirty || mode !== 'explore' || mobile || down) return;
    hoverDirty = false;
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([floor, ...pickables], false)[0];
    const onFloor = !!hit && hit.object === floor;
    if (!marker.userData.pulse) marker.visible = onFloor;
    canvas.style.cursor = hit && hit.object.userData.stand !== undefined ? 'pointer' : 'grab';
    if (onFloor && !marker.userData.pulse) { const p = clampPos(hit.point.clone()); marker.position.set(p.x, 0, p.z); }
  }
  addEventListener('mousemove', e => { mouse.x = e.clientX / innerWidth * 2 - 1; mouse.y = e.clientY / innerHeight * 2 - 1; }, { passive: true });
  el.addEventListener('wheel', e => {
    if (!immersive) return;
    e.preventDefault(); stopTour();
    if (tween) { look.yaw = cam.yaw; look.pitch = cam.pitch; tween = null; }
    const k = clamp(-e.deltaY, -120, 120) * .045;
    vel.x += -Math.sin(cam.yaw) * k; vel.z += -Math.cos(cam.yaw) * k;
  }, { passive: false });
  const KEYMAP = { z: 'f', w: 'f', arrowup: 'f', s: 'b', arrowdown: 'b', q: 'l', a: 'l', arrowleft: 'l', d: 'r', arrowright: 'r', shift: 'run' };
  addEventListener('keydown', e => {
    if (!immersive) return;
    if (e.key === 'Escape') { if (tour) stopTour(); else if (card.classList.contains('on')) hideCard(); else exitImmersive(); return; }
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    const k = KEYMAP[e.key.toLowerCase()];
    if (k) {
      keys.add(k); e.preventDefault(); stopTour();
      if (tween) { look.yaw = cam.yaw; look.pitch = cam.pitch; tween = null; }
    }
  });
  addEventListener('keyup', e => { const k = KEYMAP[e.key.toLowerCase()]; if (k) keys.delete(k); });
  addEventListener('blur', () => keys.clear());

  /* ---------- trajectoire cinématique (attract) ---------- */
  const AP = [
    [0, 1.75, 2.2, 0, 2.0, -20],
    [1.5, 1.7, -5.5, -6.4, 2.5, -11],
    [-1.3, 1.65, -13.5, 6.4, 2.5, -20],
    [-3.0, 1.85, -21, 0, 1.3, -24],
    [2.9, 1.7, -27.5, -6.4, 2.5, -29],
    [-1.4, 1.65, -34, 6.4, 2.5, -38],
    [1.6, 1.7, -42.5, -6.4, 2.5, -47],
    [.6, 1.95, -49.5, 1.8, 3.4, -66],
    [-2.9, 2.3, -46, -2, 2.4, -64],
    [-3.2, 2.1, -36, 0, 1.8, -12],
    [3.2, 1.9, -24, 0, 2.0, -6],
    [2.4, 1.8, -12, 0, 3.0, 4],
    [.7, 1.75, -3, 0, 2.2, -20],
  ];
  const pathP = new THREE.CatmullRomCurve3(AP.map(a => new THREE.Vector3(a[0], a[1], a[2])), true, 'centripetal');
  const pathL = new THREE.CatmullRomCurve3(AP.map(a => new THREE.Vector3(a[3], a[4], a[5])), true, 'centripetal');
  const pathLen = pathP.getLength();
  let uA = 0;
  const _pp = new THREE.Vector3(), _pl = new THREE.Vector3();

  /* ---------- carte ---------- */
  const mapCtx = mapCv.getContext('2d');
  function drawMap() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = mapCv.clientWidth, Hc = mapCv.clientHeight;
    if (!W) return;
    if (mapCv.width !== Math.round(W * dpr)) { mapCv.width = Math.round(W * dpr); mapCv.height = Math.round(Hc * dpr); }
    const g = mapCtx; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, Hc);
    const s = (W - 12) / (L + 9), X = z => 6 + (4 - z) * s, Y = x => Hc / 2 + x * s;
    g.fillStyle = 'rgba(255,255,255,.04)'; g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 1;
    g.fillRect(X(4), Y(-HW), L * s, HW * 2 * s); g.strokeRect(X(4) + .5, Y(-HW) + .5, L * s - 1, HW * 2 * s - 1);
    STANDS.forEach((d, i) => {
      g.fillStyle = i === current ? '#4D82FF' : 'rgba(77,130,255,.45)';
      const x0 = d.side < 0 ? -HW : 4.2, x1 = d.side < 0 ? -4.2 : HW;
      g.fillRect(X(d.z + 4.6), Y(x0), 9.2 * s, (x1 - x0) * s);
    });
    g.fillStyle = current === 5 ? '#4D82FF' : 'rgba(255,255,255,.3)'; g.fillRect(X(-L + 5), Y(-HW), 5 * s, HW * 2 * s);
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.arc(X(ring.z), Y(ring.x), ring.r * s, 0, 7); g.stroke();
    g.fillStyle = '#4D82FF'; g.fillRect(X(4) - 1, Y(-3), 2, 6 * s);
    // visiteur
    const cx = X(cam.pos.z), cy = Y(cam.pos.x), base = -cam.yaw;
    g.fillStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.moveTo(cx, cy);
    g.arc(cx, cy, 16, base - .5, base + .5); g.closePath(); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, 3, 0, 7); g.fill();
  }

  /* ---------- taille / visibilité / qualité ---------- */
  let visible = true, tier = mobile ? 1 : 2, pr = 1, shadowEvery = 0;
  const viewSize = { width: 1, height: 1 };
  function resize() {
    const w = el.clientWidth || innerWidth, h = el.clientHeight || innerHeight;
    viewSize.width = w; viewSize.height = h;
    const T = TIERS[tier];
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    const kb = T.bloom || .5;
    bloom.setSize(Math.round(w * pr * kb), Math.round(h * pr * kb));
    camera.aspect = w / h; camera.fov = (mobile || w / h < .9) ? 66 : 54; camera.updateProjectionMatrix();
    const rs = T.refl || .25;
    refl.rt.setSize(Math.max(2, Math.round(w * rs)), Math.max(2, Math.round(h * rs)));
    refl.a.setSize(Math.max(2, Math.round(w * rs / 2)), Math.max(2, Math.round(h * rs / 2)));
    refl.b.setSize(refl.a.width, refl.a.height);
    finalPass.uniforms.res.value.set(w * pr, h * pr);
  }
  function setTier(n) {
    tier = clamp(n, 0, TIERS.length - 1);
    const T = TIERS[tier];
    pr = Math.min(devicePixelRatio || 1, T.pr);
    const s = isGL2 ? T.msaa : 0;
    if (composer.renderTarget1.samples !== s) {
      composer.renderTarget1.samples = composer.renderTarget2.samples = s;
      composer.renderTarget1.dispose(); composer.renderTarget2.dispose();
    }
    bloom.enabled = T.bloom > 0;
    refl.on = T.refl > 0; floorU.reflOn.value = refl.on ? 1 : 0;
    floorMat.envMapIntensity = refl.on ? .55 : 1;
    shadowEvery = T.shadowEvery; shadowDirty = true;
    finalPass.uniforms.grain.value = T.fx ? .028 : 0;
    finalPass.uniforms.ca.value = T.fx ? .012 : 0;
    el.dataset.quality = String(tier);
    resize();
  }
  new ResizeObserver(() => resize()).observe(el);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { rootMargin: '100px' }).observe(el);
  setTier(tier);

  // mesure : ~2 s après l’affichage, puis surveillance continue
  const perf = { t: 0, acc: 0, n: 0, phase: 'calib', upFrom: -1, upTried: false };
  function monitor(raw) {
    if (!ready || raw > .25 || raw <= 0) return;
    perf.t += raw;
    if (perf.t < .7) return;
    perf.acc += raw; perf.n++;
    if (perf.acc < (perf.phase === 'calib' ? 1.6 : 4)) return;
    const avg = perf.acc / perf.n * 1000;
    perf.acc = perf.n = perf.t = 0;
    el.dataset.fps = String(Math.round(1000 / avg));
    if (perf.phase === 'calib') {
      if (perf.upFrom >= 0) {               // essai du palier supérieur
        if (avg > 19) setTier(perf.upFrom);
        perf.upFrom = -1; perf.phase = 'watch';
      } else if (avg > 21 && tier > 0) setTier(tier - 1);
      else if (avg < 17.6 && !perf.upTried && !mobile && tier < TIERS.length - 1) { perf.upTried = true; perf.upFrom = tier; setTier(tier + 1); }
      else perf.phase = 'watch';
    } else if (avg > 27 && tier > 0) setTier(tier - 1);
  }

  /* précompilation (parallèle) de TOUS les programmes, dans la bonne variante :
     la scène est rendue dans les cibles du composer (espace linéaire), pas à l’écran ;
     les passes de post-traitement aussi, sauf la passe finale (écran). */
  function precompile() {
    if (!renderer.compileAsync) return Promise.resolve();
    const post = new THREE.Scene(), fin = new THREE.Scene(), geo = new THREE.PlaneGeometry(1, 1), seen = new Set();
    const put = (sc, m) => { if (!m || !m.isMaterial || seen.has(m)) return; seen.add(m); const q = new THREE.Mesh(geo, m); q.frustumCulled = false; sc.add(q); };
    const grab = (sc, o) => { for (const k in o) { const v = o[k]; if (v && v.isMaterial) put(sc, v); else if (Array.isArray(v)) v.forEach(m => put(sc, m)); } };
    composer.passes.forEach(p => { if (p !== finalPass) grab(post, p); });
    if (composer.copyPass) grab(post, composer.copyPass);
    put(post, blurQ.material);
    put(fin, finalPass.material);
    const jobs = [];
    try {
      renderer.setRenderTarget(composer.renderTarget1);
      jobs.push(renderer.compileAsync(scene, camera), renderer.compileAsync(post, camera));
      renderer.setRenderTarget(null);
      jobs.push(renderer.compileAsync(fin, camera));
    } catch (e) { renderer.setRenderTarget(null); }
    return Promise.all(jobs.map(j => j.catch(() => {})));
  }

  /* ---------- boucle ---------- */
  let last = performance.now(), time = 0, frameNo = 0, mapTick = 0;
  const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
  const dampAng = (a, b, k, dt) => a + angDiff(a, b) * (1 - Math.exp(-k * dt));
  function update(dt) {
    time += dt;
    mouse.sx = damp(mouse.sx, mouse.x, 3, dt); mouse.sy = damp(mouse.sy, mouse.y, 3, dt);
    let shake = 0;
    if (mode === 'scroll') {
      const p = clamp(opts.getProgress ? opts.getProgress() : 0, 0, 1), e = easeIO(p);
      const tx = Math.sin(p * 2.4) * .4, tz = THREE.MathUtils.lerp(15.5, -14, e);
      cam.pos.x = damp(cam.pos.x, tx, 5, dt); cam.pos.z = damp(cam.pos.z, tz, 5, dt); cam.pos.y = damp(cam.pos.y, EYE, 5, dt);
      cam.yaw = dampAng(cam.yaw, -mouse.sx * .1 + Math.sin(p * 3) * .08, 4, dt);
      cam.pitch = damp(cam.pitch, -mouse.sy * .04 + .1 * Math.pow(1 - e, 2) - .02, 4, dt);
      shake = .4;
    } else if (mode === 'attract') {
      uA = (((uA + dt * (reduce ? .25 : .95) / pathLen) % 1) + 1) % 1;
      const t = pathP.getUtoTmapping(uA);
      pathP.getPoint(t, _pp); pathL.getPoint(t, _pl);
      const a = lookAngles(_pp, _pl);
      cam.pos.x = damp(cam.pos.x, _pp.x, 1.6, dt); cam.pos.y = damp(cam.pos.y, _pp.y, 1.6, dt); cam.pos.z = damp(cam.pos.z, _pp.z, 1.6, dt);
      cam.yaw = dampAng(cam.yaw, a.yaw - mouse.sx * .08, 1.4, dt);
      cam.pitch = damp(cam.pitch, a.pitch - mouse.sy * .035, 1.4, dt);
      shake = 1;
    } else {
      if (tween) {
        tween.t += dt / tween.dur; const k = easeIO(Math.min(1, tween.t));
        cam.pos.lerpVectors(tween.p0, tween.p1, k);
        cam.yaw = THREE.MathUtils.lerp(tween.y0, tween.y1, k); cam.pitch = THREE.MathUtils.lerp(tween.q0, tween.q1, k);
        look.yaw = cam.yaw; look.pitch = cam.pitch;
        if (tween.t >= 1) { tween = null; marker.userData.pulse = 0; }
      } else {
        const fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
        const f = (keys.has('f') ? 1 : 0) - (keys.has('b') ? 1 : 0), s = (keys.has('r') ? 1 : 0) - (keys.has('l') ? 1 : 0);
        const sp = keys.has('run') ? 7 : 3.4;
        const tx = (fx * f - fz * s) * sp, tz = (fz * f + fx * s) * sp;
        const kk = keys.size ? 7 : 4;
        vel.x = damp(vel.x, keys.size ? tx : 0, kk, dt); vel.z = damp(vel.z, keys.size ? tz : 0, kk, dt);
        if (Math.abs(vel.x) + Math.abs(vel.z) > 1e-4) {
          const prevZ = cam.pos.z;
          cam.pos.x += vel.x * dt; cam.pos.z += vel.z * dt;
          clampPos(cam.pos, prevZ);
        }
        cam.pos.y = damp(cam.pos.y, EYE, 3, dt);
        cam.yaw = dampAng(cam.yaw, look.yaw, 14, dt); cam.pitch = damp(cam.pitch, look.pitch, 14, dt);
      }
      if (tour) { tour.wait -= dt; if (tour.wait <= 0) nextStop(); }
      shake = .25;
    }
    // respiration de caméra (très légère)
    const br = reduce ? 0 : shake;
    camera.position.set(cam.pos.x + Math.sin(time * .43) * .015 * br, cam.pos.y + Math.sin(time * .71) * .012 * br, cam.pos.z);
    camera.rotation.set(cam.pitch + Math.sin(time * .53 + 1) * .004 * br, cam.yaw + Math.sin(time * .37) * .006 * br, Math.sin(time * .29) * .0025 * br, 'YXZ');

    for (const u of updaters) { try { u(dt, time); } catch (e) { updaters.splice(updaters.indexOf(u), 1); console.warn('[hall] update', e); } }
    logoSpin.rotation.y += dt * .45; logoSpin.position.y = 1.4 + Math.sin(time * 1.1) * .05;
    lidHinge.rotation.x = -(.78 + Math.sin(time * .9) * .16);
    entryLid.rotation.x = .5 + Math.sin(time * .6) * .05;
    banners.forEach((b, i) => { b.rotation.y = Math.sin(time * .35 + i * 1.7) * .035; });
    updateDust(dt, time);
    if (marker.visible) {
      const s = 1 + Math.sin(time * 3.2) * .06;
      marker.userData.ring.scale.set(s, s, 1);
      marker.userData.ring.material.opacity = .75 + Math.sin(time * 3.2) * .2;
    }
    hoverFloor();

    // hotspots
    if (mode !== 'scroll') {
      const r = viewSize;   // taille mise en cache au redimensionnement (pas de lecture de layout par trame)
      anchors.forEach((a, i) => {
        if (!a) return;
        tmp.copy(a).project(camera);
        const dist = camera.position.distanceTo(a);
        const show = standsBuilt && tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05 && dist < 28 && dist > 2.5 && !(immersive && i === current && !tween);
        const s = spots[i];
        s.style.opacity = show ? Math.min(1, (28 - dist) / 8) : 0;
        s.style.pointerEvents = show ? 'auto' : 'none';
        if (show) s.style.transform = `translate(${(tmp.x + 1) / 2 * r.width}px, ${(1 - tmp.y) / 2 * r.height}px) translate(-50%, -50%)`;
      });
    }
    if (immersive && !panel.classList.contains('closed') && (mapTick++ & 1) === 0) drawMap();
  }
  function render() {
    frameNo++;
    if (renderer.shadowMap.enabled && (shadowDirty || (shadowEvery && frameNo % shadowEvery === 0))) {
      renderer.shadowMap.needsUpdate = true; shadowDirty = false;
    }
    if (refl.on) renderReflection();
    finalPass.uniforms.time.value = time;
    composer.render();
  }
  let skip = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    // rien tant que la scène n’est pas prête (le chargeur la couvre) ni quand elle est hors écran
    if (!warmed || !(visible || immersive) || document.hidden) { last = now; return; }
    // pendant le défilement de la page, le travelling d’accueil passe à ~30 i/s :
    // le GPU reste disponible pour le compositeur et le défilement ne saccade pas
    const pageScroll = !immersive && mode === 'attract' && scrolling(now);
    if (pageScroll && (skip++ & 1)) return;
    const raw = (now - last) / 1000; last = now;
    const dt = Math.min(.05, Math.max(0, raw));
    update(dt);
    render();
    if (mode === 'scroll' || !scrolling(now)) monitor(raw);
  }
  requestAnimationFrame(frame);
  buildStands();

  return { enterImmersive, exitImmersive, focusStand: i => { if (!immersive) enterImmersive(); stopTour(); return focusStand(i); }, setMode, get mode() { return mode; } };
}
