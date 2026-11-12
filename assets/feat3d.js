/* Neokrome — visuels 3D temps réel du panneau « Fonctionnalités » (three.js r160)
   mountFeat3D(el, startIndex) → { show(i), destroy() }
   Une seule scène : un socle commun, 9 mini-scènes construites à la demande, chacune avec sa
   séquence narrative (≈ 4 s) puis une boucle douce. Éclairage studio (clé + contre-jour bleu +
   environnement PMREM), ombres douces, tone mapping ACES. Rendu seulement quand le panneau est visible. */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const BG = 0x0D1E45;
const C = { ink: 0x13224C, navy: 0xE3E9F6, navy2: 0xC9D5EE, pale: 0x9FB2DA, blue: 0x145CFF, blue2: 0x4D82FF, screen: 0x06132E, white: 0xF2F6FF };

/* ---------- easing / timeline ---------- */
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (t, a, b) => clamp((t - a) / (b - a));
const eOut = t => 1 - Math.pow(1 - t, 3);
const eIO = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const eBack = t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const eBounce = t => { const n = 7.5625, d = 2.75; if (t < 1 / d) return n * t * t; if (t < 2 / d) return n * (t -= 1.5 / d) * t + .75; if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + .9375; return n * (t -= 2.625 / d) * t + .984375; };
const hop = (k, h) => 4 * h * k * (1 - k);            // parabole 0 → h → 0
const lerp = (a, b, k) => a + (b - a) * k;

/* ---------- matières ---------- */
function mats() {
  const std = (color, o = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: .55, metalness: 0, envMapIntensity: .32, ...o });
  return {
    ink: std(C.ink, { roughness: .4, clearcoat: .5 }),
    navy: std(C.navy, { roughness: .62 }),
    navy2: std(C.navy2, { roughness: .62 }),
    pale: std(C.pale, { roughness: .7 }),
    plinth: std(0x0F1D44, { roughness: .45, clearcoat: .4, clearcoatRoughness: .4 }),
    blue: std(C.blue, { roughness: .22, clearcoat: 1, clearcoatRoughness: .15, envMapIntensity: .6 }),
    blue2: std(C.blue2, { roughness: .3, clearcoat: .6 }),
    white: std(C.white, { roughness: .25, clearcoat: 1 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: .05, transmission: .85, thickness: .4, transparent: true, opacity: .9 }),
  };
}
const screenMat = (on = 0) => new THREE.MeshStandardMaterial({ color: C.screen, emissive: C.blue2, emissiveIntensity: on, roughness: .35 });

/* ---------- constructeurs ---------- */
function box(w, h, d, mat, r = .06, bottom = true) {
  const g = new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2.1, h / 2.1, d / 2.1));
  if (bottom) g.translate(0, h / 2, 0);
  const m = new THREE.Mesh(g, mat); m.castShadow = m.receiveShadow = true; return m;
}
function at(o, x = 0, y = 0, z = 0) { o.position.set(x, y, z); return o; }
function pawn(mat, s = 1) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(.2 * s, .32 * s, 6, 16), mat); body.position.y = .36 * s;
  const head = new THREE.Mesh(new THREE.SphereGeometry(.17 * s, 24, 16), mat); head.position.y = .86 * s;
  [body, head].forEach(m => { m.castShadow = m.receiveShadow = true; g.add(m); });
  return g;
}
function plane(w, h, mat) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); m.receiveShadow = true; return m; }
function disc(r, mat, seg = 40) { const m = new THREE.Mesh(new THREE.CircleGeometry(r, seg), mat); m.rotation.x = -Math.PI / 2; return m; }
function starGeo(r = .42, ri = .18, depth = .16) {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) { const a = Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? ri : r; i ? s.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : s.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); }
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: .04, bevelSize: .03, bevelSegments: 3 });
  g.center(); return g;
}
/* faisceau (cône ouvert) de a vers b */
function beam(a, b, r0, r1, mat) {
  const dir = new THREE.Vector3().subVectors(b, a), len = dir.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, 32, 1, true), mat);
  m.position.copy(a).addScaledVector(dir, .5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

/* =================================================================== */
/*  Les 9 scènes : build(M) → { group, update(t, dt) } (t = s depuis l'affichage) */
/* =================================================================== */
const SCENES = [

  /* 01 — Immersion 3D : la pièce se construit autour du visiteur */
  M => {
    const g = new THREE.Group();
    const wallA = at(box(5, 2.6, .2, M.navy, .05), 0, 0, -2.4), wallB = at(box(.2, 2.6, 4.6, M.navy2, .05), -2.4, 0, .1);
    const scrA = screenMat(), scrB = screenMat();
    const sA = at(plane(2.6, 1.2, scrA), .2, 1.45, -2.29), sB = plane(2.2, 1.1, scrB); at(sB, -2.29, 1.45, .4); sB.rotation.y = Math.PI / 2;
    const sofa = at(box(1.6, .42, .8, M.pale, .14), 1.1, 0, 1.4), table = at(box(.8, .5, .8, M.ink, .08), -1.2, 0, 1.3);
    const obj = new THREE.Mesh(new THREE.IcosahedronGeometry(.55, 0), M.blue); obj.castShadow = true;
    const objG = at(new THREE.Group(), .1, 1.35, -.1); objG.add(obj);
    const glow = new THREE.PointLight(C.blue2, 0, 4, 2); objG.add(glow);
    g.add(wallA, wallB, sA, sB, sofa, table, objG);
    return { group: g, update(t) {
      wallA.scale.y = Math.max(.001, eOut(seg(t, 0, .7))); wallB.scale.y = Math.max(.001, eOut(seg(t, .2, .95)));
      scrA.emissiveIntensity = seg(t, .9, 1.2) * (1.1 + .15 * Math.sin(t * 3)); scrB.emissiveIntensity = seg(t, 1.1, 1.4) * (1 + .15 * Math.sin(t * 2.4 + 1));
      sofa.position.y = (1 - eBounce(seg(t, 1.3, 2))) * 2.2; table.position.y = (1 - eBounce(seg(t, 1.5, 2.2))) * 2.2;
      sofa.visible = t > 1.3; table.visible = t > 1.5;
      const k = eBack(seg(t, 2, 2.7)); objG.scale.setScalar(Math.max(.001, k));
      objG.position.y = 1.35 + Math.sin(t * 2.2) * .08 * seg(t, 2.7, 3.2);
      obj.rotation.y = t * .7; obj.rotation.x = t * .35;
      glow.intensity = 6 * seg(t, 2, 2.6);
    } };
  },

  /* 02 — Interaction : on saisit l'objet, il s'ouvre en vue éclatée, fiche info, puis se referme */
  M => {
    const g = new THREE.Group();
    const ped = at(box(1.7, 1, 1.7, M.navy, .08), 0, 0, 0);
    const body = at(box(1.2, .7, 1.2, M.blue, .1), 0, 1, 0), lid = at(box(1.3, .2, 1.3, M.blue2, .08), 0, 1.7, 0);
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(.32, 0), M.white); core.castShadow = true; at(core, 0, 1.45, 0);
    const ring = disc(1, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide }), 64);
    ring.geometry = new THREE.RingGeometry(.75, .8, 64); at(ring, 0, 1.92, 0);
    const card = at(new THREE.Group(), -2, 1.9, .2);
    const cardB = box(1.3, .85, .06, M.white, .06, false); card.add(cardB);
    [.22, .02, -.18].forEach((y, i) => { const l = box(i ? .8 : .5, .07, .02, i ? M.pale : M.blue, .02, false); at(l, -.15 + (i ? .1 : 0), y, .05); card.add(l); });
    card.rotation.y = Math.PI / 4;
    g.add(ped, body, lid, core, ring, card);
    return { group: g, update(t) {
      const T = t % 4.4, open = eIO(seg(T, .8, 1.6)) * (1 - eIO(seg(T, 3.4, 4.1)));
      lid.position.y = 1.7 + open * .95 + (T > 3.4 ? Math.sin(seg(T, 4.0, 4.4) * Math.PI) * .05 : 0);
      lid.rotation.x = -open * .25; lid.rotation.z = open * .15;
      core.position.y = 1.45 + open * .7; core.rotation.y = t * 1.6; core.rotation.x = open * .6;
      const rk = seg(T, .65, 1.25); ring.material.opacity = (1 - rk) * .8 * (rk > 0); ring.scale.setScalar(.6 + rk * .9);
      const ck = eBack(seg(T, 1.6, 2.2)) * (1 - eIO(seg(T, 3.2, 3.6)));
      card.position.x = lerp(-3.2, -1.65, ck); card.scale.setScalar(Math.max(.001, ck));
    } };
  },

  /* 03 — Réalité augmentée : le téléphone scanne le sol et projette un objet */
  M => {
    const g = new THREE.Group();
    const phone = at(new THREE.Group(), 1.35, .1, 1.35); phone.rotation.set(-1.05, Math.PI / 4, 0, 'YXZ');
    phone.add(box(.9, 1.7, .1, M.ink, .1, false));
    const scr = screenMat(); const ps = at(plane(.78, 1.55, scr), 0, 0, .056); phone.add(ps);
    const target = new THREE.Vector3(-.35, 1.9, -.35);
    const scan = at(new THREE.Mesh(new THREE.RingGeometry(.9, .96, 4, 1), new THREE.MeshBasicMaterial({ color: C.blue2, transparent: true, opacity: 0 })), target.x, .012, target.z);
    scan.rotation.x = -Math.PI / 2; scan.rotation.z = Math.PI / 4;
    const bm = new THREE.MeshBasicMaterial({ color: C.blue2, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const src = new THREE.Vector3(1.2, .75, 1.2);
    const b = beam(src, target, .06, .75, bm);
    const cube = at(new THREE.Group(), target.x, target.y, target.z);
    const cg = new THREE.BoxGeometry(1.1, 1.1, 1.1);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(cg), new THREE.LineBasicMaterial({ color: 0xffffff }));
    const solidM = M.blue.clone(); solidM.transparent = true; solidM.opacity = 0;
    const solid = new THREE.Mesh(new RoundedBoxGeometry(1.1, 1.1, 1.1, 3, .08), solidM); solid.castShadow = true;
    cube.add(solid, edges);
    const light = new THREE.PointLight(C.blue2, 0, 5, 2); cube.add(light);
    g.add(phone, scan, b, cube);
    return { group: g, update(t) {
      scr.emissiveIntensity = eOut(seg(t, 0, .4)) * (.9 + .1 * Math.sin(t * 6));
      const sk = seg(t, .3, 1); scan.material.opacity = sk > 0 ? (.9 * (1 - sk * .4)) : 0; scan.scale.setScalar(1.6 - .6 * eOut(sk));
      bm.opacity = eOut(seg(t, .8, 1.2)) * (.22 + .06 * Math.sin(t * 5));
      edges.geometry.setDrawRange(0, Math.floor(eIO(seg(t, 1, 1.9)) * 24));
      const f = eOut(seg(t, 1.8, 2.5)); solidM.opacity = f; solidM.transparent = f < 1; edges.material.opacity = 1 - f; edges.material.transparent = true;
      cube.scale.setScalar(.85 + .15 * eBack(seg(t, 1.8, 2.5)));
      cube.rotation.y = t * .6; cube.position.y = target.y + Math.sin(t * 2) * .08 * seg(t, 2.5, 3);
      light.intensity = 5 * f;
    } };
  },

  /* 04 — Communication temps réel : un message part d'un écran, l'autre répond */
  M => {
    const g = new THREE.Group();
    const mon = (x, z) => {
      const m = at(new THREE.Group(), x, 0, z); m.rotation.y = Math.PI / 4;
      m.add(at(box(.9, .08, .6, M.ink, .04), 0, 0, 0), at(box(.12, .9, .12, M.ink, .05), 0, 0, -.1));
      const s = at(box(1.9, 1.15, .1, M.navy, .06, false), 0, 1.45, 0); m.add(s);
      const mat = screenMat(.25); m.add(at(plane(1.75, 1.0, mat), 0, 1.45, .056));
      g.add(m); return { m, mat };
    };
    const A = mon(-1.5, .55), B = mon(.55, -1.5);
    const pa = new THREE.Vector3(-1.2, 1.5, .85), pb = new THREE.Vector3(.85, 1.5, -1.2);
    const pk = new THREE.Mesh(new RoundedBoxGeometry(.5, .36, .14, 3, .08), M.blue); pk.castShadow = true;
    const pl = new THREE.PointLight(C.blue2, 4, 3.5, 2); pk.add(pl);
    const trail = [...Array(6)].map((_, i) => { const s = new THREE.Mesh(new THREE.SphereGeometry(.05 - i * .006, 12, 8), new THREE.MeshBasicMaterial({ color: C.blue2, transparent: true, opacity: .8 - i * .12 })); g.add(s); return s; });
    g.add(pk);
    const posAt = (k, fromA) => { const a = fromA ? pa : pb, b = fromA ? pb : pa; const p = a.clone().lerp(b, k); p.y += hop(k, 1.1); return p; };
    return { group: g, update(t) {
      const P = 2.6, n = Math.floor(t / P), k = eIO(seg(t % P, .35, 1.6)), fromA = n % 2 === 0;
      const p = posAt(k, fromA); pk.position.copy(p); pk.rotation.y = Math.PI / 4; pk.rotation.z = Math.sin(k * Math.PI) * .25 * (fromA ? -1 : 1);
      pk.scale.setScalar(Math.max(.001, .6 + .4 * Math.sin(Math.min(1, k * 1.3) * Math.PI * .5) - (k > .97 ? (k - .97) * 10 : 0)));
      trail.forEach((s, i) => { const kk = Math.max(0, k - (i + 1) * .045); s.position.copy(posAt(kk, fromA)); s.visible = k > .02 && k < .99; });
      const arrive = seg(t % P, 1.55, 2.3), leave = seg(t % P, 0, .5);
      const recv = fromA ? B : A, send = fromA ? A : B;
      recv.mat.emissiveIntensity = .25 + (arrive > 0 ? (1 - arrive) * .85 : 0);
      send.mat.emissiveIntensity = .25 + (1 - leave) * .6 * (t > .3);
    } };
  },

  /* 05 — Gamification : le pion gravit les marches, valide chaque défi, l'étoile jaillit */
  M => {
    const g = new THREE.Group();
    const H = [.4, .85, 1.3, 1.75], X = [-1.8, -.6, .6, 1.8];
    const lights = [];
    H.forEach((h, i) => {
      g.add(at(box(1.15, h, 1.7, i % 2 ? M.navy2 : M.navy, .06), X[i], 0, 0));
      const d = disc(.28, new THREE.MeshStandardMaterial({ color: C.ink, emissive: C.blue2, emissiveIntensity: 0 })); at(d, X[i] + .25, h + .01, .45); g.add(d); lights.push(d.material);
    });
    const p = pawn(M.blue, 1.2); g.add(p);
    const star = at(new THREE.Mesh(starGeo(), new THREE.MeshPhysicalMaterial({ color: 0xFFFFFF, emissive: C.blue2, emissiveIntensity: .35, roughness: .2, clearcoat: 1 })), X[3], H[3] + 1.25, -.2);
    star.castShadow = true; g.add(star);
    const sl = new THREE.PointLight(C.blue2, 0, 4, 2); star.add(sl);
    const jumps = [.85, 1.45, 2.05];
    return { group: g, update(t) {
      let i = 0, x = X[0], y = H[0], k;
      if (t < .5) { k = eBounce(seg(t, 0, .5)); y = lerp(H[0] + 2.2, H[0], k); }
      jumps.forEach((tj, j) => { if (t >= tj) { k = seg(t, tj, tj + .45); i = j + 1; x = lerp(X[j], X[j + 1], eIO(k)); y = lerp(H[j], H[j + 1], k) + hop(k, .7); } });
      if (t > 3) { const v = ((t - 3) % 2.4); y += hop(seg(v, 0, .45), .35); }
      p.position.set(x - .1, y, -.05);
      const sq = jumps.map((tj, j) => seg(t, tj + .45, tj + .6)); p.scale.set(1, 1, 1);
      lights.forEach((m, j) => { const land = j === 0 ? .5 : jumps[j - 1] + .45; m.emissiveIntensity = t > land ? 1.4 - .6 * seg(t, land, land + .5) : 0; });
      const sk = eBack(seg(t, 2.55, 3.05)); star.scale.setScalar(Math.max(.001, sk));
      star.rotation.y = t * 1.4; star.position.y = H[3] + 1.25 + Math.sin(t * 2) * .08;
      sl.intensity = 5 * sk;
    } };
  },

  /* 06 — Données : les paquets tombent, les barres montent, la tendance se trace */
  M => {
    const g = new THREE.Group();
    const H = [1, 1.8, 1.3, 2.6], X = [-1.65, -.55, .55, 1.65];
    const bars = H.map((h, i) => { const b = at(box(.8, h, .8, i === 3 ? M.blue : (i % 2 ? M.navy2 : M.navy), .06), X[i], 0, 0); g.add(b); return b; });
    const pk = H.map(() => { const c = new THREE.Mesh(new RoundedBoxGeometry(.28, .28, .28, 2, .05), M.white); c.castShadow = true; g.add(c); return c; });
    const pts = H.map((h, i) => new THREE.Vector3(X[i], h + .32, 0));
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 80, .035, 8), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: .6 }));
    g.add(tube);
    const dots = pts.map(p => { const s = at(new THREE.Mesh(new THREE.SphereGeometry(.09, 16, 12), M.white), p.x, p.y, p.z); g.add(s); return s; });
    const total = tube.geometry.index.count;
    return { group: g, update(t) {
      bars.forEach((b, i) => {
        const t0 = .3 + i * .32, fall = seg(t, t0, t0 + .35);
        pk[i].visible = fall > 0 && fall < 1; pk[i].position.set(X[i], lerp(4, 0, fall * fall), 0); pk[i].rotation.y = fall * 3;
        b.scale.y = Math.max(.001, eBack(seg(t, t0 + .3, t0 + .9)));
      });
      const lk = eIO(seg(t, 2, 2.9)); tube.geometry.setDrawRange(0, Math.floor(lk * total / 6) * 6);
      dots.forEach((d, i) => d.scale.setScalar(Math.max(.001, eBack(seg(lk, i / 3 - .05, i / 3 + .1)))));
      if (t > 3.2) { const P = 1.2, n = Math.floor((t - 3.2) / P) % 4, f = seg((t - 3.2) % P, 0, .45);
        pk[n].visible = f < 1; pk[n].position.set(X[n], lerp(4.2, H[n], f * f), 0);
        bars.forEach((b, i) => b.scale.y = i === n && f >= 1 ? 1 + .05 * Math.sin(seg((t - 3.2) % P, .45, .8) * Math.PI) : b.scale.y); }
    } };
  },

  /* 07 — Multi-support : l'ordinateur s'ouvre, le contenu saute vers la tablette puis le téléphone */
  M => {
    const g = new THREE.Group();
    const lap = at(new THREE.Group(), -1, 0, .7); lap.rotation.y = Math.PI / 4;
    lap.add(box(2, .1, 1.35, M.ink, .05));
    const hinge = at(new THREE.Group(), 0, .1, -.62); lap.add(hinge);
    hinge.add(at(box(2, 1.3, .07, M.navy, .05, false), 0, .65, 0));
    const lm = screenMat(); hinge.add(at(plane(1.85, 1.15, lm), 0, .65, .04));
    const tab = at(new THREE.Group(), 1.15, .75, -.9); tab.rotation.set(-.25, Math.PI / 4, 0, 'YXZ');
    tab.add(box(1.1, 1.5, .08, M.navy2, .08, false)); const tm = screenMat(); tab.add(at(plane(.98, 1.36, tm), 0, 0, .045));
    const ph = at(new THREE.Group(), 1.6, .5, 1.1); ph.rotation.set(-.2, Math.PI / 4, 0, 'YXZ');
    ph.add(box(.55, 1, .07, M.ink, .07, false)); const pm = screenMat(); ph.add(at(plane(.47, .9, pm), 0, 0, .04));
    g.add(lap, tab, ph);
    const pk = new THREE.Mesh(new RoundedBoxGeometry(.32, .32, .32, 2, .06), M.blue); pk.castShadow = true; g.add(pk);
    const pl = new THREE.PointLight(C.blue2, 3, 3, 2); pk.add(pl);
    const P0 = new THREE.Vector3(-.75, 1.35, .95), P1 = new THREE.Vector3(1.2, 1.3, -.7), P2 = new THREE.Vector3(1.65, .75, 1.25);
    return { group: g, update(t) {
      hinge.rotation.x = lerp(Math.PI / 2 - .05, -.18, eBack(seg(t, 0, .7)));
      lm.emissiveIntensity = eOut(seg(t, .55, .9)) * 1.1;
      let p = P0.clone(), vis = t > .8;
      const k1 = eIO(seg(t, .9, 1.6)), k2 = eIO(seg(t, 1.9, 2.6));
      if (k1 > 0) { p = P0.clone().lerp(P1, k1); p.y += hop(k1, 1.2); }
      if (k2 > 0) { p = P1.clone().lerp(P2, k2); p.y += hop(k2, .9); }
      vis = vis && t < 2.75; pk.visible = vis; pk.position.copy(p); pk.rotation.set(t * 2, t * 3, 0);
      pk.scale.setScalar(Math.max(.001, eBack(seg(t, .8, 1)) * (1 - seg(t, 2.6, 2.75))));
      const pulse = t > 3 ? .15 * Math.sin((t - 3) * 3.5) : 0;
      tm.emissiveIntensity = eOut(seg(t, 1.55, 1.9)) * 1.1 + pulse; pm.emissiveIntensity = eOut(seg(t, 2.55, 2.9)) * 1.1 + pulse;
      lm.emissiveIntensity += pulse;
      ph.position.y = .5 + hop(seg(t, 2.6, 2.95), .15);
    } };
  },

  /* 08 — Multimédias : image, audio et vidéo arrivent puis prennent vie */
  M => {
    const g = new THREE.Group();
    const card = (w, h, mat, x, y, z) => { const c = at(new THREE.Group(), x, y, z); c.rotation.y = Math.PI / 4; c.add(box(w, h, .07, mat, .07, false)); g.add(c); return c; };
    const img = card(1.6, 1.1, M.white, -1.35, 2.0, -.75), aud = card(1.3, 1.25, M.navy, 1.0, 2.15, -1.45), vid = card(2.1, 1.3, M.blue, .2, 1.05, 1.0);
    const sun = at(new THREE.Mesh(new THREE.CircleGeometry(.13, 24), new THREE.MeshBasicMaterial({ color: C.blue2 })), .45, .25, .04); img.add(sun);
    const hill = new THREE.Shape(); hill.moveTo(-.75, -.5); hill.lineTo(-.2, .05); hill.lineTo(.15, -.2); hill.lineTo(.4, 0); hill.lineTo(.75, -.5);
    const hm = at(new THREE.Mesh(new THREE.ShapeGeometry(hill), new THREE.MeshBasicMaterial({ color: C.blue })), 0, 0, .04); img.add(hm);
    const eq = [...Array(7)].map((_, i) => { const b = at(box(.09, .7, .03, M.pale, .02), -.42 + i * .14, -.4, .04); aud.add(b); return b; });
    const tri = new THREE.Shape(); tri.moveTo(-.14, -.18); tri.lineTo(.2, 0); tri.lineTo(-.14, .18);
    const play = at(new THREE.Mesh(new THREE.ShapeGeometry(tri), new THREE.MeshBasicMaterial({ color: 0xffffff })), 0, .1, .045); vid.add(play);
    const track = at(box(1.6, .05, .02, M.navy, .02, false), 0, -.45, .045), prog = at(box(1.6, .06, .03, M.white, .02, false), 0, -.45, .05);
    prog.geometry.translate(.8, 0, 0); prog.position.x = -.8; vid.add(track, prog);
    const vl = new THREE.PointLight(C.blue2, 0, 4, 2); vl.position.set(0, 0, .6); vid.add(vl);
    const cards = [[img, -1, .9, 0], [aud, 1, .9, .15], [vid, 0, -1.2, .3]];
    return { group: g, update(t) {
      cards.forEach(([c, dx, dy, d], i) => {
        const k = eBack(seg(t, d, d + .8)); c.scale.setScalar(Math.max(.001, k));
        c.userData.y ??= c.position.y; c.position.y = c.userData.y + (1 - k) * dy + Math.sin(t * 1.6 + i * 2) * .07 * seg(t, 1.2, 1.8);
      });
      hm.scale.y = Math.max(.001, eOut(seg(t, .8, 1.3))); sun.scale.setScalar(Math.max(.001, eBack(seg(t, 1.2, 1.5))));
      eq.forEach((b, i) => b.scale.y = Math.max(.08, seg(t, 1, 1.3) * (.35 + .65 * Math.abs(Math.sin(t * (4 + i * .7) + i)))));
      const pr = seg(t, 1.25, 1.6); play.scale.setScalar(1 - .25 * Math.sin(pr * Math.PI));
      prog.scale.x = Math.max(.001, seg(t, 1.5, 4.5) * .75 + (t > 4.5 ? ((t - 4.5) % 6) / 6 * .25 : 0));
      vl.intensity = 4 * seg(t, 1.3, 1.8);
    } };
  },

  /* 09 — Utilisateurs & permissions : badge validé, la barrière se lève, le profil passe */
  M => {
    const g = new THREE.Group();
    const postA = at(box(.28, 1.25, .28, M.ink, .06), .3, 0, -1.1), postB = at(box(.28, 1.25, .28, M.ink, .06), .3, 0, 1.1);
    const lampM = new THREE.MeshStandardMaterial({ color: 0x334, emissive: C.blue2, emissiveIntensity: 0 });
    const lamp = at(new THREE.Mesh(new THREE.SphereGeometry(.12, 20, 14), lampM), .3, 1.38, -1.1);
    const piv = at(new THREE.Group(), .3, 1.05, -1.1);
    const bar = at(box(.12, .12, 2.15, M.white, .05, false), 0, 0, 1.08); piv.add(bar);
    [.35, .9, 1.45, 2].forEach(z => piv.add(at(box(.13, .13, .22, M.blue, .03, false), 0, 0, z)));
    const greyA = at(pawn(M.pale, 1.35), -1.6, 0, -1.25), greyB = at(pawn(M.pale, 1.35), -1.75, 0, 1.3);
    const me = pawn(M.blue, 1.35);
    const ml = new THREE.PointLight(C.blue2, 2, 2.5, 2); ml.position.y = .9; me.add(ml);
    g.add(postA, postB, lamp, piv, greyA, greyB, me);
    return { group: g, update(t) {
      const T = t % 5;
      const walk1 = eIO(seg(T, .2, 1)), walk2 = eIO(seg(T, 1.9, 2.9));
      let x = lerp(-2.1, -.55, walk1); if (walk2 > 0) x = lerp(-.55, 2.0, walk2);
      me.position.set(x, hop(seg(T, 1.05, 1.35), .25) + Math.abs(Math.sin(T * 9)) * .05 * ((walk1 > 0 && walk1 < 1) || (walk2 > 0 && walk2 < 1)), 0);
      me.scale.setScalar(Math.max(.001, 1 - seg(T, 4.4, 4.8)) * Math.max(.001, eBack(seg(T, 0, .25))));
      const blink = seg(T, 1.05, 1.4); lampM.emissiveIntensity = (blink > 0 && blink < 1 ? (Math.sin(blink * 18) > 0 ? 2 : .2) : (T > 1.4 && T < 3.4 ? 2 : 0));
      const up = eIO(seg(T, 1.4, 1.85)) * (1 - eBounce(seg(T, 3.0, 3.5)));
      piv.rotation.x = up * 1.35;
      greyA.rotation.y = T > 3.4 && T < 4.1 ? Math.sin((T - 3.4) * 22) * .45 * (1 - seg(T, 3.4, 4.1)) : 0;
    } };
  },
];

/* =================================================================== */
export function mountFeat3D(el, start = 0) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(BG, 1);
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(renderer), .04).texture;
  scene.fog = new THREE.Fog(BG, 22, 34);

  const cam = new THREE.PerspectiveCamera(24, 1, .1, 80);
  const M = mats();

  /* lumières : clé chaude-neutre + contre-jour bleu + ciel */
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x0b1840, .22));
  const key = new THREE.DirectionalLight(0xfff6ee, 2.6); key.position.set(5, 9, 6); key.castShadow = true;
  Object.assign(key.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 25 });
  key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -.0004; key.shadow.normalBias = .02; key.shadow.radius = 6;
  scene.add(key);
  const rim = new THREE.DirectionalLight(C.blue2, 3.2); rim.position.set(-6, 4, -5); scene.add(rim);
  const fill = new THREE.DirectionalLight(0x9fbcff, .25); fill.position.set(6, 2, -4); scene.add(fill);

  /* socle commun + sol qui reçoit l'ombre */
  const base = new THREE.Group(); scene.add(base);
  base.add(at(box(5.4, .3, 5.4, M.plinth, .12), 0, -.3, 0));
  const edge = at(box(5.5, .08, 5.5, new THREE.MeshStandardMaterial({ color: C.blue, emissive: C.blue, emissiveIntensity: .9 }), .04), 0, -.38, 0); base.add(edge);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: .35 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -.4; floor.receiveShadow = true; scene.add(floor);
  const grid = new THREE.GridHelper(40, 40, 0x2a3f7a, 0x1a2c5c); grid.position.y = -.395; grid.material.transparent = true; grid.material.opacity = .45; scene.add(grid);

  const built = [];
  let R = 16, cur = -1, prev = -1, tShow = 0, tSwitch = -10, running = false, raf = 0, last = 0, visible = true;
  const get = i => built[i] || (built[i] = (() => { const s = SCENES[i](M); s.group.visible = false; scene.add(s.group); return s; })());

  function show(i) {
    if (i === cur || !SCENES[i]) return;
    prev = cur; cur = i; get(i); tSwitch = performance.now() / 1000; tShow = tSwitch + .28;
  }

  function resize() {
    const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); cam.aspect = w / h;
    cam.fov = 26; cam.updateProjectionMatrix();
    const vt = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)), ht = vt * cam.aspect;
    R = Math.max(4.4 / ht, 3.0 / vt);
  }
  const ro = new ResizeObserver(resize); ro.observe(el); resize();

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const s = now / 1000, dt = Math.min(.05, s - (last || s)); last = s;
    /* caméra : légère respiration autour de l'angle isométrique */
    const az = Math.PI / 4 + Math.sin(s * .25) * .07, el2 = .55 + Math.sin(s * .19) * .02;
    cam.position.set(Math.sin(az) * Math.cos(el2) * R, Math.sin(el2) * R + .6, Math.cos(az) * Math.cos(el2) * R);
    cam.lookAt(0, 1.15, 0);

    const sw = clamp((s - tSwitch) / .3);
    if (prev >= 0 && built[prev]) {
      const p = built[prev]; p.group.visible = sw < 1;
      p.group.scale.setScalar(Math.max(.001, 1 - eIO(sw) * .25)); p.group.position.y = -eIO(sw) * .6;
      p.group.traverse(o => { if (o.material && o.material.transparent === false) { /* rien */ } });
    }
    const c = built[cur];
    if (c) {
      const t = Math.max(0, s - tShow), k = eOut(seg(t, 0, .5));
      c.group.visible = s >= tShow; c.group.position.y = (1 - k) * -.4;
      c.update(t, dt);
    }
    renderer.render(scene, cam);
  }
  function play() { if (!running && visible) { running = true; last = 0; raf = requestAnimationFrame(frame); } }
  function pause() { running = false; cancelAnimationFrame(raf); }
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting && !document.hidden; visible ? play() : pause(); });
  io.observe(el);
  const vis = () => { if (document.hidden) pause(); else if (visible) play(); };
  document.addEventListener('visibilitychange', vis);

  show(start); play();
  /* rendu figé d'une scène à l'instant t (contrôle visuel) */
  function snap(i, t, s = 0) {
    built.forEach(b => b && (b.group.visible = false));
    const c = get(i); c.group.visible = true; c.group.position.y = 0; c.group.scale.setScalar(1); c.update(t, .016);
    const az = Math.PI / 4 + Math.sin(s * .25) * .07, el2 = .55;
    cam.position.set(Math.sin(az) * Math.cos(el2) * R, Math.sin(el2) * R + .6, Math.cos(az) * Math.cos(el2) * R); cam.lookAt(0, 1.15, 0);
    renderer.render(scene, cam); return renderer.domElement.toDataURL('image/jpeg', .85);
  }
  return { show, snap, destroy() { pause(); io.disconnect(); ro.disconnect(); document.removeEventListener('visibilitychange', vis); renderer.dispose(); el.innerHTML = ''; } };
}
