/* Art Exposium — salon virtuel 3D temps réel (three.js)
   mountHall(el, { mode: 'scroll' | 'attract', getProgress, base })
   - scroll  : la caméra avance dans le hall selon getProgress() (0 → 1)
   - attract : promenade automatique ; un clic ouvre la visite libre
   - explore : visite libre plein écran (glisser pour regarder, clic au sol pour avancer, ZQSD/WASD/flèches, molette) */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const BLUE = 0x3B2FF0;
const L = 66;          // longueur du hall
const HW = 9;          // demi-largeur
const H = 7;           // hauteur
const EYE = 1.7;

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

export function mountHall(el, opts = {}) {
  const base = opts.base || 'assets/img/';
  const mobile = matchMedia('(max-width: 800px)').matches || matchMedia('(hover: none)').matches;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) { el.classList.add('hall-fallback'); return null; }

  let mode = opts.mode || 'attract', prevMode = mode, immersive = false;
  el.classList.add('hall');
  el.dataset.mode = mode;

  /* ---------- rendu ---------- */
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.25 : 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = !mobile;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.className = 'hall-canvas';
  canvas.tabIndex = 0;
  el.appendChild(canvas);
  const aniso = renderer.capabilities.getMaxAnisotropy();

  /* ---------- interface ---------- */
  const ui = document.createElement('div');
  ui.className = 'hall-ui';
  ui.innerHTML = `
    <div class="hall-load"><span>Chargement du salon</span><b>0%</b><i><em></em></i></div>
    <div class="hall-spots"></div>
    <div class="hall-marker"></div>
    <button class="hall-close" type="button">✕ <span>Quitter le salon</span></button>
    <div class="hall-help"><span><b>Glisser</b> regarder</span><span><b>Clic au sol</b> avancer</span><span class="k"><b>ZQSD · flèches</b> marcher</span><span><b>Clic stand</b> découvrir</span></div>
    <div class="hall-card" role="dialog" aria-live="polite"><button type="button" class="x" aria-label="Fermer">✕</button><small></small><h3></h3><p></p></div>`;
  el.appendChild(ui);
  const $ = s => ui.querySelector(s);
  const loadPct = $('.hall-load b'), loadBar = $('.hall-load em'), spotsEl = $('.hall-spots'), card = $('.hall-card');

  /* ---------- scène ---------- */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05050a);
  scene.fog = new THREE.FogExp2(0x07071a, 0.02);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(mobile ? 66 : 56, 1, 0.08, 220);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.42, 0.35, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const manager = new THREE.LoadingManager();
  const loader = new THREE.TextureLoader(manager);
  manager.onProgress = (_, done, total) => {
    const k = Math.round(done / total * 100);
    loadPct.textContent = k + '%'; loadBar.style.width = k + '%';
  };
  manager.onLoad = () => { el.classList.add('ready'); opts.onReady?.(); };

  const std = o => new THREE.MeshStandardMaterial({ envMapIntensity: 0.45, ...o });
  const phys = o => new THREE.MeshPhysicalMaterial({ envMapIntensity: 0.9, ...o });
  const glow = (hex, k = 2) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), toneMapped: false });
  const mesh = (geo, mat, x = 0, y = 0, z = 0, parent = scene) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m;
  };
  const photo = name => {
    const t = loader.load(base + name);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso;
    return t;
  };

  /* ---------- textures générées ---------- */
  function tileTex() {
    const c = document.createElement('canvas'); c.width = c.height = 1024;
    const g = c.getContext('2d'), n = 4, s = c.width / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const v = 22 + Math.random() * 6;
      g.fillStyle = `rgb(${v},${v},${v + 6})`; g.fillRect(i * s, j * s, s, s);
    }
    const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const r = (Math.random() - .5) * 10; d[i] += r; d[i + 1] += r; d[i + 2] += r; }
    g.putImageData(img, 0, 0);
    g.strokeStyle = 'rgba(0,0,0,.65)'; g.lineWidth = 3;
    for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, c.height); g.stroke(); g.beginPath(); g.moveTo(0, i * s); g.lineTo(c.width, i * s); g.stroke(); }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso;
    t.repeat.set(HW * 2 / 4.8, (L + 16) / 4.8);
    return t;
  }
  function signTex(title, sub, w = 1400, h = 114, bg = '#111116') {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso;
    const draw = () => {
      const g = c.getContext('2d');
      g.clearRect(0, 0, w, h);
      if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
      const m = h * .44, mx = h * .5, my = (h - m) / 2;
      g.fillStyle = '#5A50FF';
      g.beginPath(); g.moveTo(mx, my); g.lineTo(mx + m * .55, my + m * .12); g.lineTo(mx + m * .55, my + m); g.lineTo(mx, my + m * .88); g.closePath(); g.fill();
      const tx = mx + m * .55 + h * .32;
      g.textBaseline = 'middle'; g.fillStyle = '#fff';
      g.font = `800 ${h * .42}px Outfit, system-ui, sans-serif`;
      g.fillText(title.toUpperCase(), tx, h * .53);
      if (sub) {
        const tw = g.measureText(title.toUpperCase()).width;
        g.font = `500 ${h * .22}px Outfit, system-ui, sans-serif`; g.fillStyle = 'rgba(255,255,255,.55)';
        g.fillText(sub.toUpperCase(), tx + tw + h * .4, h * .55);
      }
      t.needsUpdate = true;
    };
    draw(); document.fonts?.ready.then(draw);
    return t;
  }

  /* ---------- architecture ---------- */
  const floorLen = L + 16, floorZ = (16 - L) / 2 - 2;
  const refl = new Reflector(new THREE.PlaneGeometry(HW * 2, floorLen), {
    textureWidth: innerWidth * (mobile ? .35 : .6), textureHeight: innerHeight * (mobile ? .35 : .6), color: 0x9a9aa6,
  });
  refl.rotation.x = -Math.PI / 2; refl.position.set(0, 0, floorZ); scene.add(refl);
  const floor = mesh(new THREE.PlaneGeometry(HW * 2, floorLen),
    std({ map: tileTex(), roughness: .32, metalness: .05, transparent: true, opacity: .72 }), 0, .004, floorZ);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;

  const wallMat = std({ color: 0x15151c, roughness: .8 });
  const wallLen = L + 4, wallZ = (4 - L) / 2;
  for (const s of [-1, 1]) mesh(new THREE.BoxGeometry(.3, H, wallLen), wallMat, s * (HW + .15), H / 2, wallZ).receiveShadow = true;
  mesh(new THREE.BoxGeometry(HW * 2, H, .3), wallMat, 0, H / 2, -L - .15);
  const ceil = mesh(new THREE.PlaneGeometry(HW * 2, wallLen), std({ color: 0x0b0b10, roughness: .95 }), 0, H, wallZ);
  ceil.rotation.x = Math.PI / 2;

  // façade d'entrée avec ouverture
  const facade = std({ color: 0x1a1a22, roughness: .55, metalness: .2 });
  mesh(new THREE.BoxGeometry(HW - 3, H, .4), facade, -(HW + 3) / 2, H / 2, 4);
  mesh(new THREE.BoxGeometry(HW - 3, H, .4), facade, (HW + 3) / 2, H / 2, 4);
  mesh(new THREE.BoxGeometry(6, H - 5.5, .4), facade, 0, (H + 5.5) / 2, 4);
  const edge = glow(BLUE, 3);
  mesh(new THREE.BoxGeometry(.06, 5.5, .06), edge, -3, 2.75, 4.22);
  mesh(new THREE.BoxGeometry(.06, 5.5, .06), edge, 3, 2.75, 4.22);
  mesh(new THREE.BoxGeometry(6.06, .06, .06), edge, 0, 5.5, 4.22);
  const sign = mesh(new THREE.PlaneGeometry(5.6, .46), new THREE.MeshBasicMaterial({ map: signTex('Art Exposium', 'Salon virtuel', 1400, 114, null), transparent: true }), 0, 6.15, 4.21);
  sign.material.color.setScalar(.95);
  // la porte bleue du logo, grande ouverte
  const doorShape = new THREE.Shape([new THREE.Vector2(-3, .3), new THREE.Vector2(0, 0), new THREE.Vector2(0, 5.5), new THREE.Vector2(-3, 5.05)]);
  const doorPivot = new THREE.Group(); doorPivot.position.set(3, 0, 4.2); doorPivot.rotation.y = 1.2; scene.add(doorPivot);
  const door = mesh(new THREE.ExtrudeGeometry(doorShape, { depth: .12, bevelEnabled: false }),
    std({ color: BLUE, emissive: BLUE, emissiveIntensity: .55, roughness: .3, metalness: .1 }), 0, 0, 0, doorPivot);
  door.castShadow = true;
  const facadeLight = new THREE.PointLight(0xc9c6ff, 40, 18, 2); facadeLight.position.set(0, 4.5, 9); scene.add(facadeLight);

  // liserés LED
  const led = glow(BLUE, 2.4);
  for (const s of [-1, 1]) {
    mesh(new THREE.BoxGeometry(.05, .05, wallLen), led, s * (HW - .03), .04, wallZ);
    for (let z = -6.5; z > -L + 4; z -= 9) mesh(new THREE.BoxGeometry(.05, H - 1.4, .1), led, s * (HW - .03), H / 2 + .2, z - (s > 0 ? 4.5 : 0));
  }

  // canopée de lumières hexagonales
  const hexGeo = new THREE.RingGeometry(.6, .74, 6, 1); hexGeo.rotateX(Math.PI / 2);
  const hexPos = [];
  let row = 0;
  for (let z = 2; z > -L + 6; z -= 1.22, row++) for (let x = -4.4; x <= 4.4; x += 1.42) {
    if (Math.random() < .2) continue;
    hexPos.push([x + (row % 2) * .71, 6.1 - Math.random() * .5 - (Math.abs(x) < 2 ? .25 : 0), z]);
  }
  const hexes = new THREE.InstancedMesh(hexGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(.85, .9, 1.25), toneMapped: false, side: THREE.DoubleSide }), hexPos.length);
  const m4 = new THREE.Matrix4();
  hexPos.forEach(([x, y, z], i) => hexes.setMatrixAt(i, m4.makeTranslation(x, y, z)));
  scene.add(hexes);
  for (const z of [-4, -18, -32, -46, -58]) {
    const p = new THREE.PointLight(0xdfe3ff, 55, 20, 2); p.position.set(0, 5.4, z); scene.add(p);
  }

  /* ---------- stands ---------- */
  const pickables = [], anchors = [], focusPts = [], products = [];
  function addStand(d, i) {
    const g = new THREE.Group();
    g.position.set(d.side * (HW - 2.6), 0, d.z);
    g.rotation.y = d.side < 0 ? Math.PI / 2 : -Math.PI / 2;
    scene.add(g);
    const pick = m => { m.userData.stand = i; pickables.push(m); return m; };

    const plat = pick(mesh(new THREE.BoxGeometry(9.2, .14, 4.6), std({ color: 0xbdbab3, roughness: .4 }), 0, .07, -.2, g));
    plat.receiveShadow = true;
    const back = pick(mesh(new THREE.BoxGeometry(9.2, 4.9, .25), std({ color: 0x1c1c24, roughness: .6 }), 0, 2.6, -2.45, g));
    back.receiveShadow = true;
    const tex = photo(d.img);
    const aspect = d.aspect || 1032 / 796;
    const sw = Math.min(7.4, 3.4 * aspect), sh = sw / aspect;
    mesh(new THREE.BoxGeometry(sw + .16, sh + .16, .06), std({ color: 0x060608, roughness: .25, metalness: .6 }), 0, 2.85, -2.34, g);
    const screen = pick(mesh(new THREE.PlaneGeometry(sw, sh), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: new THREE.Color(.9, .9, .9) }), 0, 2.85, -2.3, g));
    mesh(new THREE.BoxGeometry(sw, .035, .04), glow(BLUE, 3), 0, 2.85 - sh / 2 - .24, -2.3, g);
    const sideMat = [std({ color: 0x1c1c24 }), std({ color: 0x1c1c24 }), std({ color: 0x1c1c24 }), std({ color: 0x1c1c24 }),
      new THREE.MeshBasicMaterial({ map: signTex(d.title, d.sub), color: new THREE.Color(.92, .92, .92) }), std({ color: 0x1c1c24 })];
    mesh(new THREE.BoxGeometry(9.2, .75, .3), sideMat, 0, 5.4, -2.25, g);
    const part = mesh(new THREE.BoxGeometry(.16, 3.4, 2.5), std({ color: 0x26262f, roughness: .45, metalness: .2 }), -4.52, 1.84, -1.2, g);
    part.castShadow = part.receiveShadow = true;
    mesh(new THREE.BoxGeometry(.04, 3.4, .04), glow(BLUE, 3), -4.52, 1.84, .06, g);
    // comptoir
    const counter = pick(mesh(new THREE.BoxGeometry(1.9, 1.05, .7), phys({ color: 0xf4f3ef, roughness: .22, clearcoat: 1, clearcoatRoughness: .1 }), 2.5, .665, 1.0, g));
    counter.castShadow = true;
    mesh(new THREE.BoxGeometry(1.92, .03, .72), glow(BLUE, 2.6), 2.5, 1.2, 1.0, g);
    // piédestal + objet 3D
    mesh(new THREE.CylinderGeometry(.42, .48, 1, 48), std({ color: 0x0e0e13, roughness: .2, metalness: .4 }), -2.3, .64, .7, g).castShadow = true;
    const halo = mesh(new THREE.TorusGeometry(.43, .012, 8, 72), glow(BLUE, 3), -2.3, 1.15, .7, g);
    halo.rotation.x = Math.PI / 2;
    const geos = [new THREE.TorusKnotGeometry(.24, .08, 180, 24), new THREE.IcosahedronGeometry(.34, 0), new THREE.OctahedronGeometry(.36, 0)];
    const mats = [phys({ color: 0xe8e8ee, metalness: 1, roughness: .07 }), phys({ color: BLUE, roughness: .18, clearcoat: 1, metalness: .1 }), phys({ color: 0xd8b46a, metalness: 1, roughness: .2 })];
    const prod = mesh(geos[i % 3], mats[i % 3], -2.3, 1.72, .7, g);
    prod.castShadow = true; products.push(prod);
    // éclairage scénique
    const spot = new THREE.SpotLight(0xfff1e2, 150, 17, .62, .65, 2);
    spot.position.set(0, 6.6, 3.4); spot.target.position.set(0, 1.6, -1.6);
    g.add(spot, spot.target);
    if (!mobile) { spot.castShadow = true; spot.shadow.mapSize.set(512, 512); spot.shadow.bias = -.0004; spot.shadow.radius = 4; }
    g.updateMatrixWorld(true);
    anchors.push(g.localToWorld(new THREE.Vector3(0, 4.45, 1.4)));
    focusPts.push({ pos: g.localToWorld(new THREE.Vector3(.4, EYE, 7.6)), look: g.localToWorld(new THREE.Vector3(0, 2.6, -2.3)), data: d });
  }
  STANDS.forEach(addStand);

  /* ---------- scène principale ---------- */
  {
    const z0 = -L;
    mesh(new THREE.BoxGeometry(HW * 2, .3, 4.2), std({ color: 0x1b1b23, roughness: .4 }), 0, .15, z0 + 2.1).receiveShadow = true;
    mesh(new THREE.BoxGeometry(HW * 2, .03, .03), glow(BLUE, 3), 0, .31, z0 + 4.2);
    const tex = photo(STAGE.img);
    const sw = 11, sh = sw / (2560 / 1196);
    mesh(new THREE.BoxGeometry(sw + .2, sh + .2, .08), std({ color: 0x060608, roughness: .25, metalness: .6 }), 1.8, 3.6, z0 + .1);
    const screen = mesh(new THREE.PlaneGeometry(sw, sh), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: new THREE.Color(.95, .95, .95) }), 1.8, 3.6, z0 + .16);
    screen.userData.stand = STANDS.length; pickables.push(screen);
    // logo en volume
    const k = 4.4 / 340, P = pts => new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x * k, (340 - y) * k)));
    const frame = P([[5, 95], [198, 5], [198, 55], [85, 108], [85, 250], [5, 290]]);
    const dshape = P([[202, 55], [292, 85], [292, 340], [202, 307]]);
    const ex = { depth: .35, bevelEnabled: true, bevelThickness: .03, bevelSize: .02, bevelSegments: 2 };
    const logo = new THREE.Group(); logo.position.set(-7.9, .3, z0 + .6); scene.add(logo);
    mesh(new THREE.ExtrudeGeometry(frame, ex), std({ color: 0xeeeeee, roughness: .3, metalness: .2 }), 0, 0, 0, logo).castShadow = true;
    mesh(new THREE.ExtrudeGeometry(dshape, ex), std({ color: BLUE, emissive: BLUE, emissiveIntensity: 1.1, roughness: .3 }), 0, 0, 0, logo);
    const st = new THREE.SpotLight(0xffffff, 300, 24, .7, .7, 2);
    st.position.set(0, 6.6, z0 + 12); st.target.position.set(0, 2.6, z0); scene.add(st, st.target);
    if (!mobile) { st.castShadow = true; st.shadow.mapSize.set(512, 512); st.shadow.bias = -.0004; }
    // gradins
    const seat = new THREE.InstancedMesh(new THREE.BoxGeometry(.52, .5, .52), std({ color: 0x24206a, roughness: .9 }), 30);
    const backr = new THREE.InstancedMesh(new THREE.BoxGeometry(.52, .6, .07), std({ color: 0x24206a, roughness: .9 }), 30);
    let n = 0;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 10; c++) {
      if (c === 4 || c === 5) continue;
      const x = -4.5 + c * 1.0 + 1.8, z = z0 + 7.5 + r * 1.3;
      seat.setMatrixAt(n, m4.makeTranslation(x, .25, z)); backr.setMatrixAt(n, m4.makeTranslation(x, .8, z + .23)); n++;
    }
    seat.count = backr.count = n; seat.castShadow = backr.castShadow = true;
    scene.add(seat, backr);
    anchors.push(new THREE.Vector3(1.8, 6.4, z0 + 1));
    focusPts.push({ pos: new THREE.Vector3(1.8, EYE, z0 + 15), look: new THREE.Vector3(1.8, 3.4, z0), data: STAGE });
  }

  /* ---------- visiteurs ---------- */
  const people = [];
  const tones = [0x2b2b33, 0xd9d6cf, 0x3B2FF0, 0x7d7d88, 0x1f2a44, 0xa89f91, 0x111114];
  const bodyGeo = new THREE.CapsuleGeometry(.19, 1.02, 4, 14), headGeo = new THREE.SphereGeometry(.12, 20, 14);
  const skin = std({ color: 0x8a6e5a, roughness: .6 });
  for (let i = 0; i < (mobile ? 7 : 12); i++) {
    const p = new THREE.Group();
    const b = mesh(bodyGeo, std({ color: tones[i % tones.length], roughness: .75 }), 0, .7, 0, p);
    const h = mesh(headGeo, skin, 0, 1.58, 0, p);
    b.castShadow = h.castShadow = true;
    p.position.set((Math.random() - .5) * 6.4, 0, -3 - Math.random() * 52);
    p.userData = { dir: Math.random() < .5 ? 1 : -1, speed: .55 + Math.random() * .5, x0: p.position.x, ph: Math.random() * 9, wait: 0 };
    scene.add(p); people.push(p);
  }

  /* ---------- poussière en suspension ---------- */
  const DN = mobile ? 260 : 600, dpos = new Float32Array(DN * 3);
  for (let i = 0; i < DN; i++) { dpos[i * 3] = (Math.random() - .5) * 16; dpos[i * 3 + 1] = Math.random() * 6.5; dpos[i * 3 + 2] = 4 - Math.random() * (L + 2); }
  const dgeo = new THREE.BufferGeometry(); dgeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
  scene.add(new THREE.Points(dgeo, new THREE.PointsMaterial({ color: 0xb4b8ff, size: .035, transparent: true, opacity: .55, depthWrite: false, blending: THREE.AdditiveBlending })));

  /* ---------- marqueur au sol ---------- */
  const marker = mesh(new THREE.RingGeometry(.22, .27, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.6, 2), toneMapped: false, transparent: true, opacity: .85 }), 0, .02, 0);
  marker.rotation.x = -Math.PI / 2; marker.visible = false;

  /* ---------- hotspots ---------- */
  const spots = [...STANDS, STAGE].map((d, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'hall-spot';
    b.innerHTML = `<b>${String(i + 1).padStart(2, '0')}</b><span>${d.title}</span>`;
    b.addEventListener('click', e => { e.stopPropagation(); if (!immersive) enterImmersive(); focusStand(i); });
    spotsEl.appendChild(b);
    return b;
  });

  /* ---------- caméra ---------- */
  const cam = { pos: new THREE.Vector3(0, EYE, 10.5), yaw: 0, pitch: -.02 };
  const goal = { pos: cam.pos.clone(), yaw: 0, pitch: -.02 };
  let tween = null;
  const mouse = { x: 0, y: 0 };
  const keys = new Set();
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const tmp = new THREE.Vector3();
  const easeIO = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

  function clampPos(p, prevZ) {
    p.x = THREE.MathUtils.clamp(p.x, -HW + .7, HW - .7);
    p.z = THREE.MathUtils.clamp(p.z, -L + 4.6, 12);
    if (prevZ !== undefined && Math.abs(p.x) > 2.7 && (prevZ - 4) * (p.z - 4) <= 0) p.z = prevZ;  // façade
    for (const d of STANDS) if (Math.abs(p.z - d.z) < 4.8 && d.side * p.x > 4.1) p.x = d.side * 4.1;
    p.y = EYE;
    return p;
  }
  function lookAngles(from, to) {
    tmp.subVectors(to, from);
    return { yaw: Math.atan2(-tmp.x, -tmp.z), pitch: Math.atan2(tmp.y, Math.hypot(tmp.x, tmp.z)) };
  }
  function glideTo(pos, yaw = cam.yaw, pitch = cam.pitch, dur) {
    const dist = cam.pos.distanceTo(pos);
    tween = { p0: cam.pos.clone(), p1: pos.clone(), y0: cam.yaw, y1: cam.yaw + angDiff(cam.yaw, yaw), q0: cam.pitch, q1: pitch, t: 0,
      dur: dur || THREE.MathUtils.clamp(dist / 5, .7, 2.6) };
  }
  function focusStand(i) {
    const f = focusPts[i];
    const a = lookAngles(f.pos, f.look);
    glideTo(f.pos, a.yaw, a.pitch);
    card.querySelector('small').textContent = `${String(i + 1).padStart(2, '0')} — ${f.data.sub}`;
    card.querySelector('h3').textContent = f.data.title;
    card.querySelector('p').textContent = f.data.desc;
    card.classList.add('on');
  }
  const hideCard = () => card.classList.remove('on');
  card.querySelector('.x').addEventListener('click', hideCard);

  function setMode(m) {
    mode = m; el.dataset.mode = m;
    marker.visible = false;
    if (m !== 'explore') hideCard();
  }
  const slot = document.createComment('hall');
  function enterImmersive() {
    if (immersive) return;
    immersive = true; prevMode = mode;
    // sortir le salon de son conteneur (contexte d'empilement) pour couvrir toute la page
    el.before(slot); document.body.appendChild(el);
    el.classList.add('hall-immersive');
    document.documentElement.classList.add('hall-lock');
    setMode('explore');
    if (cam.pos.z > 4.5) glideTo(new THREE.Vector3(0, EYE, 1.5), 0, -.02, 1.6);
    resize(); canvas.focus({ preventScroll: true });
  }
  function exitImmersive() {
    if (!immersive) return;
    immersive = false;
    el.classList.remove('hall-immersive');
    slot.replaceWith(el);
    document.documentElement.classList.remove('hall-lock');
    tween = null; keys.clear();
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
  });
  canvas.addEventListener('pointermove', e => {
    const r = el.getBoundingClientRect();
    ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    if (mode !== 'explore') return;
    if (down) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      down.moved += Math.abs(dx) + Math.abs(dy); down.x = e.clientX; down.y = e.clientY;
      if (down.moved > 4) {
        tween = null;
        const k = (e.pointerType === 'touch' ? .0065 : .0042) * camera.fov / 56;
        cam.yaw += dx * k; cam.pitch = THREE.MathUtils.clamp(cam.pitch + dy * k, -.75, .6);
      }
    }
    hoverFloor();
  });
  canvas.addEventListener('pointerup', e => {
    if (mode === 'attract') { opts.onActivate ? opts.onActivate() : enterImmersive(); return; }
    if (mode !== 'explore' || !down) return;
    const click = down.moved <= 6; down = null;
    if (!click) return;
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([floor, ...pickables], false)[0];
    if (!hit) return;
    if (hit.object.userData.stand !== undefined) focusStand(hit.object.userData.stand);
    else { hideCard(); glideTo(clampPos(hit.point.clone())); }
  });
  canvas.addEventListener('pointerleave', () => { marker.visible = false; });
  function hoverFloor() {
    if (mode !== 'explore' || mobile) return;
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([floor, ...pickables], false)[0];
    marker.visible = !!hit && hit.object === floor;
    canvas.style.cursor = hit && hit.object.userData.stand !== undefined ? 'pointer' : 'grab';
    if (marker.visible) marker.position.set(hit.point.x, .02, hit.point.z);
  }
  addEventListener('mousemove', e => { mouse.x = e.clientX / innerWidth * 2 - 1; mouse.y = e.clientY / innerHeight * 2 - 1; });
  el.addEventListener('wheel', e => {
    if (!immersive) return;
    e.preventDefault(); tween = null;
    const prevZ = cam.pos.z;
    cam.pos.x += -Math.sin(cam.yaw) * -e.deltaY * .012;
    cam.pos.z += -Math.cos(cam.yaw) * -e.deltaY * .012;
    clampPos(cam.pos, prevZ);
  }, { passive: false });
  const KEYMAP = { z: 'f', w: 'f', arrowup: 'f', s: 'b', arrowdown: 'b', q: 'l', a: 'l', arrowleft: 'l', d: 'r', arrowright: 'r', shift: 'run' };
  addEventListener('keydown', e => {
    if (!immersive) return;
    if (e.key === 'Escape') { card.classList.contains('on') ? hideCard() : exitImmersive(); return; }
    const k = KEYMAP[e.key.toLowerCase()];
    if (k) { keys.add(k); tween = null; e.preventDefault(); }
  });
  addEventListener('keyup', e => { const k = KEYMAP[e.key.toLowerCase()]; if (k) keys.delete(k); });

  /* ---------- taille / visibilité ---------- */
  let visible = true;
  function resize() {
    const w = el.clientWidth || innerWidth, h = el.clientHeight || innerHeight;
    renderer.setSize(w, h, false); composer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(el);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { rootMargin: '100px' }).observe(el);
  resize();

  /* ---------- boucle ---------- */
  let last = performance.now(), time = 0, tA = 0;
  const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
  function update(dt) {
    time += dt;
    if (mode === 'scroll') {
      const p = THREE.MathUtils.clamp(opts.getProgress ? opts.getProgress() : 0, 0, 1), e = easeIO(p);
      goal.pos.set(Math.sin(p * 2.4) * .5, EYE, THREE.MathUtils.lerp(10.5, -13, e));
      goal.yaw = -mouse.x * .12 + Math.sin(p * 3) * .1; goal.pitch = -mouse.y * .05 - .02;
      cam.pos.x = damp(cam.pos.x, goal.pos.x, 5, dt); cam.pos.z = damp(cam.pos.z, goal.pos.z, 5, dt);
      cam.yaw = damp(cam.yaw, goal.yaw, 4, dt); cam.pitch = damp(cam.pitch, goal.pitch, 4, dt);
    } else if (mode === 'attract') {
      tA += dt * (reduce ? .2 : 1);
      goal.pos.set(Math.sin(tA * .09) * 1.2, EYE, -2 - (1 - Math.cos(tA * .055)) / 2 * 44);
      goal.yaw = Math.sin(tA * .11) * .62 - mouse.x * .1; goal.pitch = -.03 - mouse.y * .04;
      cam.pos.x = damp(cam.pos.x, goal.pos.x, 2, dt); cam.pos.z = damp(cam.pos.z, goal.pos.z, 2, dt);
      cam.yaw = damp(cam.yaw, goal.yaw, 2, dt); cam.pitch = damp(cam.pitch, goal.pitch, 2, dt);
    } else {
      if (tween) {
        tween.t += dt / tween.dur; const k = easeIO(Math.min(1, tween.t));
        cam.pos.lerpVectors(tween.p0, tween.p1, k);
        cam.yaw = THREE.MathUtils.lerp(tween.y0, tween.y1, k); cam.pitch = THREE.MathUtils.lerp(tween.q0, tween.q1, k);
        if (tween.t >= 1) tween = null;
      }
      if (keys.size) {
        const sp = (keys.has('run') ? 7 : 3.6) * dt, prevZ = cam.pos.z;
        const fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
        const f = (keys.has('f') ? 1 : 0) - (keys.has('b') ? 1 : 0), s = (keys.has('r') ? 1 : 0) - (keys.has('l') ? 1 : 0);
        cam.pos.x += (fx * f + -fz * s) * sp; cam.pos.z += (fz * f + fx * s) * sp;
        clampPos(cam.pos, prevZ);
      }
    }
    // léger balancement de marche
    camera.position.set(cam.pos.x, cam.pos.y + Math.sin(time * 1.6) * .012, cam.pos.z);
    camera.rotation.set(cam.pitch, cam.yaw, 0, 'YXZ');

    products.forEach((p, i) => { p.rotation.y += dt * .6; p.rotation.x = Math.sin(time * .7 + i) * .3; p.position.y = 1.72 + Math.sin(time * 1.3 + i) * .06; });
    for (const p of people) {
      const u = p.userData;
      if (u.wait > 0) { u.wait -= dt; continue; }
      p.position.z += u.dir * u.speed * dt;
      p.position.x = u.x0 + Math.sin(time * .3 + u.ph) * .6;
      p.children[0].position.y = .7 + Math.abs(Math.sin(time * 5 * u.speed + u.ph)) * .03;
      if (p.position.z < -56) { u.dir = 1; u.wait = 1 + Math.random() * 3; }
      if (p.position.z > -2) { u.dir = -1; u.wait = 1 + Math.random() * 3; }
      if (Math.random() < .0015) u.wait = 1.5 + Math.random() * 3;
    }
    for (let i = 0; i < DN; i++) {
      let y = dpos[i * 3 + 1] + dt * (.04 + (i % 7) * .006);
      if (y > 6.5) y = 0;
      dpos[i * 3 + 1] = y; dpos[i * 3] += Math.sin(time * .4 + i) * dt * .03;
    }
    dgeo.attributes.position.needsUpdate = true;
    marker.material.opacity = .6 + Math.sin(time * 4) * .25;

    // hotspots
    if (mode !== 'scroll') {
      const r = el.getBoundingClientRect();
      anchors.forEach((a, i) => {
        tmp.copy(a).project(camera);
        const dist = camera.position.distanceTo(a);
        const show = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1 && dist < 30;
        const s = spots[i];
        s.style.opacity = show ? Math.min(1, (30 - dist) / 8) : 0;
        s.style.pointerEvents = show ? 'auto' : 'none';
        if (show) s.style.transform = `translate(${(tmp.x + 1) / 2 * r.width}px, ${(1 - tmp.y) / 2 * r.height}px) translate(-50%, -50%)`;
      });
    }
  }
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    if (!(visible || immersive) || document.hidden) return;
    update(dt);
    composer.render();
  }
  requestAnimationFrame(frame);

  return { enterImmersive, exitImmersive, focusStand, setMode, get mode() { return mode; } };
}
