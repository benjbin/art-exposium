/* Art Exposium — 5 stands d'exposition premium pour le hall 3D (three.js 0.160)
 *
 *   export function buildStand({ THREE, data, index, mobile, photo, sign, envMap })
 *     → { group, pickables, anchor, focus, lights, update }
 *
 * Repère local : x ∈ [-4.6, 4.6], z ∈ [-2.6, 2.2] (façade ouverte vers +z), sol y = 0, hauteur ≤ 6.2.
 * Toute la géométrie statique est fusionnée par matériau (Kit) pour tenir ~25-40 draw calls par stand.
 * Textures procédurales (CanvasTexture) générées une seule fois et partagées entre stands. */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const BLUE = 0x3B2FF0;
const PH = 0.12;          // hauteur du plancher de stand
const WZ = -2.35;         // face avant du mur de fond
const PI = Math.PI;
let TS = 1024;            // taille des textures procédurales (512 sur mobile)

/* =====================================================================
   Aléatoire, bruit, utilitaires
   ===================================================================== */
function rng(seed) {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const NZ = (() => {
  const R = rng(1337), N = 256, g = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) g[i] = R();
  return (x, y, px = 256, py = 256) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    let xf = x - xi, yf = y - yi;
    xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px, y0 = ((yi % py) + py) % py, y1 = (y0 + 1) % py;
    const a = g[y0 * N + x0], b = g[y0 * N + x1], c = g[y1 * N + x0], d = g[y1 * N + x1];
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
})();
function fbm(x, y, px, py, oct = 4) {
  let s = 0, a = .5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) {
    s += a * NZ(x * f, y * f, Math.min(256, px * f), Math.min(256, py * f));
    n += a; a *= .5; f *= 2;
  }
  return s / n;
}
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const mix = (a, b, t) => a + (b - a) * t;

const CACHE = new Map();
const once = (k, f) => { if (!CACHE.has(k)) CACHE.set(k, f()); return CACHE.get(k); };

function finishTex(c, srgb = true, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

/* Texture pixel par pixel : fn(u, v, out[r,g,b,rough], x, y). Renvoie { map, rough }. */
function pixelTex(w, h, fn, withRough = true) {
  const c = canvas(w, h), g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
  let rc, rimg, rd;
  if (withRough) { rc = canvas(w, h); rimg = rc.getContext('2d').createImageData(w, h); rd = rimg.data; }
  const o = [0, 0, 0, .5];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    fn(x / w, y / h, o, x, y);
    const i = (y * w + x) * 4;
    d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2]; d[i + 3] = 255;
    if (withRough) { const r = clamp01(o[3]) * 255; rd[i] = rd[i + 1] = rd[i + 2] = r; rd[i + 3] = 255; }
  }
  g.putImageData(img, 0, 0);
  const out = { map: finishTex(c, true) };
  if (withRough) { rc.getContext('2d').putImageData(rimg, 0, 0); out.rough = finishTex(rc, false); }
  return out;
}

/* =====================================================================
   Textures procédurales
   ===================================================================== */
function woodTex(kind) {
  return once('wood:' + kind, () => {
    const walnut = kind === 'walnut', plank = kind === 'oakPlank';
    const L = walnut ? [122, 84, 58] : [214, 176, 128], D = walnut ? [64, 41, 27] : [163, 118, 76];
    const rows = plank ? 6 : 1, R = rng(walnut ? 11 : plank ? 23 : 37);
    const rowInfo = Array.from({ length: rows }, () => [R() * 9, (R() - .5) * .14, .15 + R() * .7]);
    const S = plank ? TS : TS / 2;
    return pixelTex(S, S, (u, v, o) => {
      const row = Math.min(rows - 1, Math.floor(v * rows)), ri = rowInfo[row];
      const vv = v * rows - row;
      const sh = plank && u > ri[2] ? 3.7 : 0;
      const warp = fbm(u * 4, v * 8, 4, 8, 3);
      let ring = (v * 26 + warp * 3.4 + ri[0] + sh) % 1;
      const late = Math.pow(ring, 6);
      const streak = NZ(u * 8, v * 256, 8, 256);
      let t = clamp01(late * .6 + streak * .32 + (warp - .5) * .5 + .1);
      let k = 1 + ri[1];
      let rough = .52 + late * .12 + streak * .06;
      if (plank && (vv < .012 || vv > .988 || Math.abs(u - ri[2]) < .0025)) { k *= .42; rough = .9; }
      o[0] = mix(L[0], D[0], t) * k; o[1] = mix(L[1], D[1], t) * k; o[2] = mix(L[2], D[2], t) * k; o[3] = rough;
    });
  });
}
function carbonTex() {
  return once('carbon', () => pixelTex(512, 512, (u, v, o, x, y) => {
    const c = 16, i = x >> 4, j = y >> 4, fx = (x % c + .5) / c, fy = (y % c + .5) / c;
    const ori = ((i + j) & 3) < 2;
    const across = ori ? fx : fy, along = ori ? fy : fx;
    const bundle = Math.pow(Math.sin(across * PI), .7);
    const fib = NZ((ori ? x : y) * .9, (ori ? y : x) * .05, 256, 256);
    const b = 13 + 36 * bundle * (ori ? 1 : .68) * (.85 + .3 * fib) + Math.sin(along * PI) * 3;
    o[0] = b; o[1] = b; o[2] = b + 3; o[3] = .3 + (1 - bundle) * .25;
  }));
}
function stoneTex(kind) {
  return once('stone:' + kind, () => pixelTex(TS / 2, TS / 2, (u, v, o) => {
    const cloud = fbm(u * 4, v * 4, 4, 4, 5);
    if (kind === 'travertine') {
      const band = fbm(u * 2, v * 24, 2, 24, 3);
      const pore = NZ(u * 96, v * 192, 96, 192) > .8 ? .78 : 1;
      const k = (.9 + band * .16 + cloud * .06) * pore;
      o[0] = 214 * k; o[1] = 196 * k; o[2] = 166 * k; o[3] = .55 + (1 - pore) * 1.5;
      return;
    }
    const d = Math.abs(Math.sin((u * 3 + v * 2 + fbm(u * 3, v * 3, 3, 3, 5) * 2.6) * PI * 2));
    const d2 = Math.abs(Math.sin((u * 5 - v * 3 + fbm(u * 5 + 7, v * 5, 5, 5, 4) * 3) * PI));
    if (kind === 'nero') {
      const vein = Math.pow(1 - d, 60) * .9 + Math.pow(1 - d2, 90) * .5 + Math.pow(1 - d, 8) * .05;
      const b = 18 + cloud * 14;
      o[0] = b + vein * 150; o[1] = b + vein * 146; o[2] = b + 2 + vein * 140; o[3] = .14 + cloud * .08;
    } else {
      const vein = Math.pow(1 - d, 22) * .5 + Math.pow(1 - d2, 40) * .3 + Math.pow(1 - d, 4) * .07;
      const b = 220 + cloud * 18;
      o[0] = b - vein * 120; o[1] = b - 2 - vein * 118; o[2] = b - 6 - vein * 110; o[3] = .3 + vein * .2 + cloud * .1;
    }
  }));
}
function greyTex(kind) {
  return once('grey:' + kind, () => {
    if (kind === 'fabric') return pixelTex(256, 256, (u, v, o, x, y) => {
      const weave = (((x >> 1) + (y >> 1)) & 1) ? .9 : 1;
      const k = weave * (.92 + NZ(u * 64, v * 64, 64, 64) * .1) * (.96 + NZ(u * 8, v * 256, 8, 256) * .06);
      o[0] = o[1] = o[2] = 235 * k; o[3] = .9;
    });
    if (kind === 'brushed') return pixelTex(512, 512, (u, v, o) => {
      const s = NZ(u * 4, v * 256, 4, 256) * .6 + NZ(u * 16, v * 128, 16, 128) * .4;
      o[0] = o[1] = o[2] = 200 + s * 50; o[3] = .22 + s * .22;
    });
    if (kind === 'plaster') return pixelTex(512, 512, (u, v, o) => {
      const k = .93 + fbm(u * 4, v * 4, 4, 4, 5) * .1 + (NZ(u * 128, v * 128, 128, 128) - .5) * .03;
      o[0] = o[1] = o[2] = 236 * k; o[3] = .88;
    });
    if (kind === 'concrete') return pixelTex(512, 512, (u, v, o) => {
      const f = fbm(u * 4, v * 4, 4, 4, 5);
      const sp = NZ(u * 200, v * 200, 200, 200) > .86 ? .86 : 1;
      const k = (.86 + f * .2) * sp;
      o[0] = 200 * k; o[1] = 198 * k; o[2] = 194 * k; o[3] = .62 + f * .2;
    });
    // epoxy (sol de garage)
    return pixelTex(512, 512, (u, v, o) => {
      const f = fbm(u * 4, v * 4, 4, 4, 4);
      const sp = NZ(u * 220, v * 220, 220, 220);
      const fleck = sp > .9 ? 1.45 : sp < .08 ? .7 : 1;
      const b = (44 + f * 14) * fleck;
      o[0] = b; o[1] = b + 1; o[2] = b + 4; o[3] = .18 + f * .2;
    });
  });
}
function hazardTex() {
  return once('hazard', () => {
    const c = canvas(256, 64), g = c.getContext('2d');
    g.fillStyle = '#141414'; g.fillRect(0, 0, 256, 64);
    g.fillStyle = '#e9b800';
    for (let i = -2; i < 6; i++) { const x = i * 64; g.beginPath(); g.moveTo(x, 64); g.lineTo(x + 32, 64); g.lineTo(x + 96, 0); g.lineTo(x + 64, 0); g.fill(); }
    return finishTex(c);
  });
}
function checkerTex() {
  return once('checker', () => {
    const c = canvas(256, 64), g = c.getContext('2d');
    for (let i = 0; i < 8; i++) for (let j = 0; j < 2; j++) { g.fillStyle = (i + j) & 1 ? '#151515' : '#d8d8d8'; g.fillRect(i * 32, j * 32, 32, 32); }
    return finishTex(c);
  });
}
function rugTex() {
  return once('rug', () => {
    const W = 1024, H = 724, c = canvas(W, H), g = c.getContext('2d');
    g.fillStyle = '#d8ccb6'; g.fillRect(0, 0, W, H);
    g.save(); g.beginPath(); g.rect(34, 34, W - 68, H - 68); g.clip();
    const blobs = [['#b9653f', 240, 520, 300], ['#5f6a74', 820, 180, 260], ['#c9a464', 600, 640, 200], ['#e7dfd0', 420, 160, 180], ['#2f3d55', 960, 620, 150]];
    for (const [col, x, y, r] of blobs) { g.fillStyle = col; g.globalAlpha = .85; g.beginPath(); g.ellipse(x, y, r * 1.2, r * .8, .5, 0, PI * 2); g.fill(); }
    g.globalAlpha = 1; g.strokeStyle = '#efe7d8'; g.lineWidth = 6;
    for (let i = 0; i < 7; i++) { g.beginPath(); g.arc(520, 360, 90 + i * 70, -.4, 2.2); g.stroke(); }
    g.restore();
    g.strokeStyle = '#8a6d4c'; g.lineWidth = 10; g.strokeRect(22, 22, W - 44, H - 44);
    const img = g.getImageData(0, 0, W, H), d = img.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, k = (((x >> 1) + (y >> 1)) & 1 ? .9 : 1) * (.9 + NZ(x * .3, y * .3) * .16);
      d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
    }
    g.putImageData(img, 0, 0);
    const t = finishTex(c, true, false);
    return t;
  });
}
function chaseTex() {
  const c = canvas(256, 4), g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 256, 0);
  for (let i = 0; i <= 8; i++) { gr.addColorStop(i / 8, i % 2 ? '#ffffff' : '#141414'); }
  g.fillStyle = gr; g.fillRect(0, 0, 256, 4);
  return finishTex(c);
}
function glowFrameTex() {
  return once('glowframe', () => {
    const c = canvas(256, 256), g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256);
    g.shadowColor = '#ffe7c4'; g.shadowBlur = 38; g.fillStyle = '#ffe7c4';
    g.fillRect(44, 44, 168, 168);
    return finishTex(c, true, false);
  });
}
/* Carte du monde (masque terres) en équirectangulaire, pour le globe holographique */
const LAND = [
  [[-168,66],[-162,70],[-140,70],[-125,70],[-95,72],[-80,73],[-62,66],[-55,52],[-66,45],[-70,42],[-76,35],[-81,31],[-80,25],[-82,29],[-84,30],[-90,29],[-97,26],[-97,22],[-92,18],[-88,21],[-87,16],[-83,10],[-78,8],[-80,7],[-86,12],[-92,14],[-105,20],[-110,24],[-112,30],[-117,32],[-120,34],[-124,40],[-124,48],[-130,54],[-140,59],[-150,60],[-158,57],[-165,60]],
  [[-120,70],[-80,70],[-70,80],[-90,82],[-120,77]],
  [[-55,60],[-44,60],[-20,70],[-18,80],[-35,83],[-60,82],[-70,77],[-58,70]],
  [[-78,8],[-72,12],[-62,11],[-52,5],[-35,-5],[-39,-15],[-48,-25],[-58,-35],[-63,-40],[-66,-47],[-68,-55],[-74,-50],[-74,-40],[-72,-30],[-70,-18],[-76,-14],[-81,-5],[-80,0]],
  [[-10,36],[-9,43],[-2,44],[-5,48],[2,51],[8,54],[8,57],[5,59],[5,62],[14,68],[22,70],[30,70],[40,67],[45,68],[60,70],[70,73],[80,73],[100,77],[110,74],[130,72],[150,71],[170,70],[180,68],[180,65],[170,60],[160,58],[156,51],[150,59],[142,59],[136,54],[140,48],[132,43],[128,38],[126,35],[122,40],[118,38],[122,32],[121,28],[117,23],[110,21],[108,16],[109,12],[105,9],[103,10],[100,13],[100,7],[103,2],[100,3],[98,8],[98,16],[94,16],[91,22],[87,21],[80,15],[77,8],[73,17],[72,21],[66,25],[57,26],[56,23],[59,22],[52,16],[44,12],[42,15],[35,28],[34,31],[35,36],[28,36],[26,40],[23,38],[22,40],[19,40],[16,38],[12,44],[13,45],[8,44],[3,43],[-1,37],[-6,36]],
  [[-17,21],[-16,28],[-10,32],[-6,36],[10,37],[11,33],[20,31],[32,31],[35,28],[43,12],[51,12],[50,2],[40,-10],[40,-16],[35,-24],[32,-29],[27,-34],[20,-35],[18,-30],[12,-17],[14,-10],[9,-1],[9,4],[5,6],[-8,4],[-13,8],[-17,15]],
  [[44,-25],[48,-25],[50,-15],[48,-13],[44,-17]],
  [[-6,50],[2,51],[0,54],[-3,58],[-6,57],[-5,54]],
  [[-24,64],[-14,64],[-15,66],[-22,66]],
  [[130,31],[135,34],[140,35],[142,40],[141,45],[139,42],[135,36],[130,34]],
  [[95,5],[98,5],[106,-6],[102,-5]], [[109,1],[117,7],[119,1],[116,-4],[110,-3]], [[105,-6],[114,-7],[114,-8],[106,-7]],
  [[131,-1],[141,-3],[150,-10],[142,-9],[138,-8],[132,-4]], [[120,18],[122,18],[126,7],[122,8]],
  [[114,-22],[122,-18],[130,-12],[137,-12],[136,-15],[141,-11],[146,-19],[153,-26],[150,-37],[141,-38],[136,-35],[131,-31],[118,-35],[115,-34],[113,-26]],
  [[172,-34],[178,-38],[174,-41],[167,-46],[170,-46]],
  [[-180,-70],[-120,-73],[-60,-64],[0,-69],[60,-67],[120,-66],[180,-70],[180,-90],[-180,-90]],
];
function landCanvas() {
  return once('landCanvas', () => {
    const W = 512, H = 256, c = canvas(W, H), g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.fillStyle = '#fff';
    for (const poly of LAND) {
      g.beginPath();
      poly.forEach(([lo, la], i) => { const x = (lo + 180) / 360 * W, y = (90 - la) / 180 * H; i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.closePath(); g.fill();
    }
    return c;
  });
}
function landTex() {
  return once('landTex', () => { const t = new THREE.CanvasTexture(landCanvas()); t.wrapS = THREE.RepeatWrapping; return t; });
}
function kioskTex() {
  return once('kiosk', () => {
    const W = 512, H = 352, c = canvas(W, H), g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#040b22'); gr.addColorStop(1, '#0c2766');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(0, 0, W, 54);
    g.fillStyle = '#fff'; g.font = '700 26px system-ui, sans-serif'; g.fillText('PLANÈTE TERRE', 22, 36);
    g.fillStyle = '#5A50FF'; g.beginPath(); g.arc(W - 34, 27, 9, 0, PI * 2); g.fill();
    const lc = landCanvas(), ld = lc.getContext('2d').getImageData(0, 0, 512, 256).data;
    g.fillStyle = '#6fd3ff';
    for (let y = 0; y < 34; y++) for (let x = 0; x < 72; x++) {
      const sx = Math.floor((x + .5) / 72 * 512), sy = Math.floor((y + .5) / 34 * 256);
      const on = ld[(sy * 512 + sx) * 4] > 128;
      g.globalAlpha = on ? .95 : .12;
      g.beginPath(); g.arc(30 + x * 6.3, 76 + y * 5.6, on ? 1.9 : 1.2, 0, PI * 2); g.fill();
    }
    g.globalAlpha = 1;
    ['Climat', 'Océans', 'Énergie'].forEach((t, i) => {
      const x = 22 + i * 160;
      g.fillStyle = i === 0 ? '#3B2FF0' : 'rgba(255,255,255,.1)';
      g.beginPath(); g.roundRect?.(x, 284, 146, 46, 12); if (!g.roundRect) g.rect(x, 284, 146, 46); g.fill();
      g.fillStyle = '#fff'; g.font = '600 20px system-ui, sans-serif'; g.fillText(t, x + 22, 314);
    });
    return finishTex(c, true, false);
  });
}
function dialTex(style) {
  return once('dial:' + style, () => {
    const S = 512, c = canvas(S, S), g = c.getContext('2d'), m = S / 2;
    const base = { black: ['#1b1e24', '#07080a'], blue: ['#1f5aa0', '#0a1f3d'], green: ['#1f5c45', '#0a241a'] }[style];
    const gr = g.createRadialGradient(m * .8, m * .7, 10, m, m, m); gr.addColorStop(0, base[0]); gr.addColorStop(1, base[1]);
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    g.globalAlpha = .07; g.strokeStyle = '#fff';
    for (let a = 0; a < 360; a += 2) { g.beginPath(); g.moveTo(m, m); g.lineTo(m + Math.cos(a / 57.3) * m, m + Math.sin(a / 57.3) * m); g.stroke(); }
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 2;
    for (let i = 0; i < 60; i++) { const a = i / 60 * PI * 2; g.beginPath(); g.moveTo(m + Math.sin(a) * m * .92, m - Math.cos(a) * m * .92); g.lineTo(m + Math.sin(a) * m * .97, m - Math.cos(a) * m * .97); g.stroke(); }
    g.fillStyle = '#e3c27a';
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * PI * 2; g.save(); g.translate(m, m); g.rotate(a);
      if (i === 0) { g.fillRect(-14, -m * .88, 10, 52); g.fillRect(4, -m * .88, 10, 52); }
      else if (i === 3) { g.fillStyle = '#f2efe6'; g.fillRect(-20, -m * .86, 40, 30); g.fillStyle = '#222'; g.font = '700 22px system-ui'; g.fillText('24', -12, -m * .86 + 23); g.fillStyle = '#e3c27a'; }
      else g.fillRect(-7, -m * .88, 14, 46);
      g.restore();
    }
    g.fillStyle = 'rgba(255,255,255,.85)'; g.font = '600 22px Georgia, serif'; g.textAlign = 'center';
    g.fillText('EXPOSIUM', m, m * .62); g.font = '400 13px system-ui'; g.fillText('GARDE TEMPS · GENÈVE', m, m * 1.5);
    const hand = (ang, len, w) => { g.save(); g.translate(m, m); g.rotate(ang); g.fillStyle = '#e3c27a'; g.beginPath(); g.moveTo(-w, 20); g.lineTo(-w * .6, -len); g.lineTo(0, -len - 14); g.lineTo(w * .6, -len); g.lineTo(w, 20); g.fill(); g.fillStyle = '#f6f3ea'; g.fillRect(-w * .35, -len + 14, w * .7, len * .6); g.restore(); };
    hand(-PI / 3 * 1.0 - .17, m * .5, 11); hand(PI / 3, m * .78, 8);
    g.fillStyle = '#e3c27a'; g.beginPath(); g.arc(m, m, 12, 0, PI * 2); g.fill();
    return finishTex(c, true, false);
  });
}
function fallbackSign(title) {
  const c = canvas(1400, 114), g = c.getContext('2d');
  g.fillStyle = '#111116'; g.fillRect(0, 0, 1400, 114);
  g.fillStyle = '#fff'; g.font = '800 48px system-ui, sans-serif'; g.textBaseline = 'middle';
  g.fillText(String(title || '').toUpperCase(), 60, 60);
  return finishTex(c, true, false);
}

/* =====================================================================
   Matériaux partagés
   ===================================================================== */
const P = o => new THREE.MeshPhysicalMaterial(o);
const S = o => new THREE.MeshStandardMaterial(o);
const withUV = (m, s) => { m.userData.uv = s; return m; };
function led(hex, k) {
  return once(`led:${hex}:${k}`, () => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), toneMapped: false }));
}
const MF = {
  matteBlack: () => S({ color: 0x161618, roughness: .62, envMapIntensity: .6 }),
  felt: () => withUV(S({ color: 0x1c1c20, map: greyTex('fabric').map, roughness: .95 }), .3),
  cabinet: () => S({ color: 0x3a3c41, roughness: .58, envMapIntensity: .7 }),
  plasterWarm: () => withUV(S({ color: 0xd6cbb9, map: greyTex('plaster').map, roughness: .9, envMapIntensity: .6 }), 2),
  charcoal: () => withUV(S({ color: 0x3a3b40, map: greyTex('plaster').map, roughness: .88, envMapIntensity: .6 }), 2),
  lacquerBlack: () => P({ color: 0x0b0b0d, roughness: .3, clearcoat: 1, clearcoatRoughness: .05 }),
  lacquerWhite: () => P({ color: 0xb4b7bd, roughness: .34, clearcoat: .7, clearcoatRoughness: .12 }),
  carbon: () => { const t = carbonTex(); return withUV(P({ map: t.map, roughnessMap: t.rough, roughness: 1, metalness: .1, clearcoat: .6, clearcoatRoughness: .2, envMapIntensity: .45 }), .55); },
  epoxy: () => { const t = greyTex('epoxy'); return withUV(P({ map: t.map, roughnessMap: t.rough, roughness: 1, clearcoat: .6, clearcoatRoughness: .2, envMapIntensity: .5 }), 2.2); },
  oak: () => { const t = woodTex('oak'); return withUV(S({ map: t.map, roughnessMap: t.rough, roughness: 1, envMapIntensity: .8 }), 1.1); },
  oakFloor: () => { const t = woodTex('oakPlank'); return withUV(S({ map: t.map, roughnessMap: t.rough, roughness: .9, color: 0xc9c0b6, envMapIntensity: .8 }), 1.3); },
  walnut: () => { const t = woodTex('walnut'); return withUV(S({ map: t.map, roughnessMap: t.rough, roughness: .95, envMapIntensity: .8 }), 1.1); },
  marble: () => { const t = stoneTex('marble'); return withUV(P({ map: t.map, roughnessMap: t.rough, roughness: 1, color: 0xb4b0aa, clearcoat: .35, clearcoatRoughness: .2 }), 1.6); },
  stoneCounter: () => { const t = stoneTex('marble'); return withUV(P({ map: t.map, color: 0xc4c0b8, roughness: .5, clearcoat: .15, clearcoatRoughness: .45, envMapIntensity: .8 }), 1.4); },
  nero: () => { const t = stoneTex('nero'); return withUV(P({ map: t.map, roughnessMap: t.rough, roughness: 1, clearcoat: .8, clearcoatRoughness: .06 }), 1.8); },
  travertine: () => withUV(S({ map: stoneTex('travertine').map, color: 0xd0c9be, roughness: .55, envMapIntensity: .8 }), 1.2),
  concrete: () => { const t = greyTex('concrete'); return withUV(S({ map: t.map, roughnessMap: t.rough, roughness: 1, color: 0x9d9a95 }), 2.6); },
  chrome: () => S({ color: 0xc4c8ce, metalness: 1, roughness: .07 }),
  steel: () => S({ color: 0xd9dbe0, metalness: 1, roughness: .16 }),
  alu: () => withUV(S({ color: 0xc8cbd0, metalness: 1, roughness: 1, roughnessMap: greyTex('brushed').rough }), .6),
  brass: () => withUV(S({ color: 0xc9a266, metalness: 1, roughness: 1, roughnessMap: greyTex('brushed').rough }), .6),
  gold: () => S({ color: 0xe5b553, metalness: 1, roughness: .13 }),
  rubber: () => S({ color: 0x141415, roughness: .86, envMapIntensity: .5 }),
  paint: () => S({ vertexColors: true, roughness: .55 }),
  gloss: () => P({ vertexColors: true, roughness: .25, clearcoat: 1, clearcoatRoughness: .04 }),
  ceramic: () => P({ vertexColors: true, roughness: .42, clearcoat: .45, clearcoatRoughness: .3 }),
  fabric: () => withUV(P({ vertexColors: true, map: greyTex('fabric').map, roughness: .92, sheen: .6, sheenRoughness: .5, sheenColor: new THREE.Color(0x5a5a5a) }), .14),
  velvet: () => withUV(P({ vertexColors: true, map: greyTex('fabric').map, roughness: .78, sheen: 1, sheenRoughness: .3, sheenColor: new THREE.Color(0x8c8c8c) }), .1),
  leather: () => P({ vertexColors: true, roughness: .42, clearcoat: .35, clearcoatRoughness: .35 }),
  leaf: () => S({ vertexColors: true, roughness: .5, side: THREE.DoubleSide }),
  darkGlass: () => P({ color: 0x050507, roughness: .06, clearcoat: 1, clearcoatRoughness: .02 }),
  glass: () => P({ color: 0x0c0d0f, roughness: .02, metalness: 0, transparent: true, opacity: .22, depthWrite: false, envMapIntensity: 2.2, specularIntensity: 1 }),
  offwhite: () => S({ color: 0xb9b4ab, roughness: .9 }),
  rug: () => S({ map: rugTex(), roughness: 1, envMapIntensity: .5 }),
  hazard: () => S({ map: hazardTex(), roughness: .5 }),
  checker: () => S({ map: checkerTex(), roughness: .45 }),
  ledBlue: () => led(BLUE, 3.4),
  ledCyan: () => led(0x4fb6ff, 2.6),
  ledYellow: () => led(0xffc400, 2.3),
  warmLED: () => led(0xffd6a6, 2.4),
  coolLED: () => led(0xeef3ff, 2.2),
  coreBlue: () => P({ color: 0x050d2e, roughness: .25, clearcoat: 1, clearcoatRoughness: .05, emissive: 0x0a1a5a, emissiveIntensity: .35 }),
  cone: () => coneMat(0xffe6c4, .07),
  coneBlue: () => coneMat(0x5b7cff, .08),
  kiosk: () => new THREE.MeshBasicMaterial({ map: kioskTex(), color: new THREE.Color(.9, .9, .9), toneMapped: false }),
  glowFrame: () => new THREE.MeshBasicMaterial({ map: glowFrameTex(), color: new THREE.Color(1.15, 1.05, .95), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
};
/* l'environnement du hall (RoomEnvironment) est lumineux : on l'atténue sur les diélectriques */
function tuneEnv(m) { if (m.isMeshStandardMaterial) m.envMapIntensity *= m.metalness > .5 ? .85 : .5; return m; }
/* sur mobile, certains matériaux proches sont fusionnés pour réduire les draw calls */
let MOBILE = false;
const MOBILE_ALIAS = { chrome: 'steel', gold: 'brass', rubber: 'matteBlack', felt: 'matteBlack', darkGlass: 'lacquerBlack', offwhite: 'stoneCounter', cabinet: 'matteBlack', ledYellow: 'warmLED', ceramic: 'gloss' };
const M = name => { if (MOBILE && MOBILE_ALIAS[name]) name = MOBILE_ALIAS[name]; return once('m:' + name, () => tuneEnv(MF[name]())); };
function dialMat(style) { return once('dialm:' + style, () => tuneEnv(P({ map: dialTex(style), roughness: .35, metalness: .25, clearcoat: 1, clearcoatRoughness: .03 }))); }

function coneMat(hex, op) {
  return new THREE.ShaderMaterial({
    uniforms: { uC: { value: new THREE.Color(hex) }, uO: { value: op } },
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.); vV = normalize(-mv.xyz); vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uC; uniform float uO; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ float f = abs(dot(normalize(vN), normalize(vV))); float a = pow(f, 2.5) * pow(vUv.y, 1.8) * uO; gl_FragColor = vec4(uC * a, a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

/* =====================================================================
   Kit : collecte des géométries et fusion par matériau
   ===================================================================== */
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
function worldUV(g, s, rot) {
  const p = g.attributes.position.array, uv = g.attributes.uv.array, n = p.length / 9;
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
    const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
    const nx = Math.abs(ay * bz - az * by), ny = Math.abs(az * bx - ax * bz), nz = Math.abs(ax * by - ay * bx);
    const mode = ny >= nx && ny >= nz ? 1 : nx >= nz ? 0 : 2;
    for (let k = 0; k < 3; k++) {
      const x = p[i + k * 3], y = p[i + k * 3 + 1], z = p[i + k * 3 + 2];
      let u, v;
      if (mode === 1) { u = x; v = z; } else if (mode === 0) { u = z; v = y; } else { u = x; v = y; }
      if (rot) { const tt = u; u = v; v = tt; }
      uv[(t * 3 + k) * 2] = u / s; uv[(t * 3 + k) * 2 + 1] = v / s;
    }
  }
}
class Kit {
  constructor(parent, mobile, picks) { this.parent = parent; this.mobile = mobile; this.picks = picks; this.b = new Map(); this.F = null; this.meshes = []; }
  add(mat, geo, o = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    g.morphAttributes = {}; g.clearGroups();
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    const uv = g.attributes.uv;
    if (o.uvs || o.flipU) for (let i = 0; i < n; i++) {
      let u = uv.getX(i), v = uv.getY(i);
      if (o.flipU) u = 1 - u;
      if (o.uvs) { u *= o.uvs[0]; v *= o.uvs[1]; }
      uv.setXY(i, u, v);
    }
    if (o.q) _q.copy(o.q); else { _e.set(...(o.r || [0, 0, 0])); _q.setFromEuler(_e); }
    _p.set(...(o.p || [0, 0, 0]));
    if (typeof o.s === 'number') _s.setScalar(o.s); else _s.set(...(o.s || [1, 1, 1]));
    _m.compose(_p, _q, _s);
    if (this.F) _m.premultiply(this.F);
    g.applyMatrix4(_m);
    const uvS = o.uv ?? mat.userData.uv;
    if (uvS) worldUV(g, uvS, o.rotUV);
    const col = new THREE.Color(o.c ?? 0xffffff), ca = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { ca[i * 3] = col.r; ca[i * 3 + 1] = col.g; ca[i * 3 + 2] = col.b; }
    g.setAttribute('color', new THREE.BufferAttribute(ca, 3));
    const cast = !!o.cast && !this.mobile;
    const key = mat.uuid + (cast ? 'c' : '') + (o.pick ? 'p' : '');
    let e = this.b.get(key);
    if (!e) this.b.set(key, e = { mat, cast, pick: !!o.pick, geos: [] });
    e.geos.push(g);
    return this;
  }
  /* exécute fn avec une matrice de repère (position/rotation/échelle) appliquée à tout ce qui est ajouté */
  at(x, y, z, ry = 0, s = 1, fn) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(s, s, s));
    const prev = this.F; this.F = prev ? prev.clone().multiply(m) : m;
    try { fn(); } finally { this.F = prev; }
  }
  flush() {
    for (const e of this.b.values()) {
      const geo = e.geos.length === 1 ? e.geos[0] : mergeGeometries(e.geos, false);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, e.mat);
      mesh.castShadow = e.cast;
      mesh.receiveShadow = !this.mobile && !(e.mat.transparent || e.mat.isMeshBasicMaterial || e.mat.isShaderMaterial);
      if (e.mat.isShaderMaterial || e.mat.transparent) mesh.renderOrder = 2;
      this.parent.add(mesh); this.meshes.push(mesh);
      if (e.pick) this.picks.push(mesh);
    }
    this.b.clear();
    return this.meshes;
  }
}

/* Géométries */
const rb = (w, h, d, r = .02, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, Math.max(.0005, Math.min(r, Math.min(w, h, d) / 2 - .0005)));
const cyl = (rt, rbm, h, seg = 32, open = false) => new THREE.CylinderGeometry(rt, rbm, h, seg, 1, open);
const lathe = (pts, seg = 48) => new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg);
const _up = new THREE.Vector3(0, 1, 0);
function rod(kit, mat, a, b, r, seg = 6, o = {}) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), L = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(_up, d.normalize());
  const mid = A.add(B).multiplyScalar(.5);
  kit.add(mat, cyl(r, r, L, seg, true), { ...o, p: [mid.x, mid.y, mid.z], q });
}
/* faisceau lumineux factice : du point a (source) vers b */
function cone(kit, mat, a, b, r0, r1, seg = 20) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = A.clone().sub(B), L = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(_up, d.normalize());
  const mid = A.add(B).multiplyScalar(.5);
  kit.add(mat, cyl(r0, r1, L, seg, true), { p: [mid.x, mid.y, mid.z], q, uv: 0 });
}
/* Treillis alu carré (structure événementielle) entre A et B (alignés sur un axe) */
function truss(kit, mat, A, B, s = .29, mobile = false) {
  const a = new THREE.Vector3(...A), b = new THREE.Vector3(...B), d = b.clone().sub(a), L = d.length(); d.normalize();
  const e1 = Math.abs(d.y) > .9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const e2 = new THREE.Vector3().crossVectors(d, e1).normalize();
  const h = s / 2, P3 = (t, u, v) => a.clone().addScaledVector(d, t).addScaledVector(e1, u).addScaledVector(e2, v).toArray();
  for (const [u, v] of [[h, h], [h, -h], [-h, h], [-h, -h]]) rod(kit, mat, P3(0, u, v), P3(L, u, v), .024, 8);
  const n = Math.max(1, Math.round(L / (mobile ? s * 2 : s)));
  for (let k = 0; k < n; k++) {
    const t0 = k / n * L, t1 = (k + 1) / n * L, sg = k % 2 ? 1 : -1;
    rod(kit, mat, P3(t0, h, sg * h), P3(t1, h, -sg * h), .009, 5);
    rod(kit, mat, P3(t0, -h, sg * h), P3(t1, -h, -sg * h), .009, 5);
    rod(kit, mat, P3(t0, sg * h, h), P3(t1, -sg * h, h), .009, 5);
    rod(kit, mat, P3(t0, sg * h, -h), P3(t1, -sg * h, -h), .009, 5);
  }
}
/* Logo Art Exposium (cadre + porte) en relief, hauteur hgt, centré, face vers +z */
function logo(kit, frameMat, doorMat, x, y, z, hgt) {
  const k = hgt / 340, sh = pts => new THREE.Shape(pts.map(([px, py]) => new THREE.Vector2((px - 148) * k, (170 - py) * k)));
  const ex = { depth: .008, bevelEnabled: true, bevelThickness: .002, bevelSize: .0015, bevelSegments: 1 };
  kit.add(frameMat, new THREE.ExtrudeGeometry(sh([[5, 95], [198, 5], [198, 55], [85, 108], [85, 250], [5, 290]]), ex), { p: [x, y, z], uv: 0 });
  kit.add(doorMat, new THREE.ExtrudeGeometry(sh([[202, 55], [292, 85], [292, 340], [202, 307]]), ex), { p: [x, y, z + .003], uv: 0 });
}
function plane(mat, w, h) { return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); }

/* Socle commun : dalle + retrait avec LED bleue (signature Art Exposium) */
function platform(C, top) {
  const { kit } = C;
  kit.add(M('matteBlack'), rb(9.04, .05, 4.62, .01, 1), { p: [0, .025, -.2] });
  kit.add(top, rb(9.16, PH - .05, 4.74, .015, 1), { p: [0, .05 + (PH - .05) / 2, -.2], pick: true });
  kit.add(M('ledBlue'), new THREE.BoxGeometry(9.0, .014, .01), { p: [0, .03, 2.118] });
  kit.add(M('ledBlue'), new THREE.BoxGeometry(.01, .014, 4.5), { p: [4.525, .03, -.2] });
  kit.add(M('ledBlue'), new THREE.BoxGeometry(.01, .014, 4.5), { p: [-4.525, .03, -.2] });
}
function screenMesh(C, w, h) {
  const m = plane(C.screenMat, w, h);
  C.picks.push(m);
  return m;
}
function signMesh(C, w) {
  const m = plane(new THREE.MeshBasicMaterial({ map: C.signTex, color: new THREE.Color(.86, .86, .86), toneMapped: false }), w, w / 12.28);
  return m;
}
function keySpot(C, pos, target, o = {}) {
  const s = new THREE.SpotLight(o.color ?? 0xfff1e2, o.intensity ?? 150, o.dist ?? 16, o.angle ?? .72, o.pen ?? .6, 2);
  s.position.set(...pos); s.target.position.set(...target);
  C.g.add(s, s.target);
  if (!C.mobile) {
    s.castShadow = true; s.shadow.mapSize.set(1024, 1024); s.shadow.bias = -.00015; s.shadow.normalBias = .02;
    s.shadow.radius = 4; s.shadow.camera.near = .5; s.shadow.camera.far = 14;
  }
  C.lights.push(s);
  return s;
}
function fillPoint(C, pos, color, intensity, dist) {
  const p = new THREE.PointLight(color, intensity, dist, 2);
  p.position.set(...pos); C.g.add(p); C.lights.push(p);
  return p;
}
/* Comptoir d'accueil générique (corps pierre claire non éblouissante) */
function counter(C, x, z, w, d, o = {}) {
  const { kit } = C, h = o.h ?? .98;
  kit.at(x, 0, z, o.ry ?? 0, 1, () => {
    kit.add(M('matteBlack'), rb(w - .08, .07, d - .1, .01, 1), { p: [0, PH + .035, 0] });
    kit.add(o.body ?? M('stoneCounter'), rb(w, h - .11, d, .02), { p: [0, PH + .07 + (h - .11) / 2, 0], cast: true, pick: true });
    kit.add(o.top ?? M('stoneCounter'), rb(w + .1, .04, d + .1, .012), { p: [0, PH + h - .02, .02], cast: true });
    kit.add(o.led ?? M('ledBlue'), new THREE.BoxGeometry(w - .12, .012, .012), { p: [0, PH + .02, d / 2 - .06] });
    if (o.inlay) kit.add(o.inlay, rb(w - .3, .46, .016, .006, 1), { p: [0, PH + .55, d / 2 + .008] });
    logo(kit, o.logoFrame ?? M('alu'), M('ledBlue'), o.logoX ?? 0, PH + .58, d / 2 + (o.inlay ? .02 : .004), .24);
  });
  return PH + h;
}
/* Plante (pot + feuillage fusionné) */
function plant(C, kit, x, z, o = {}) {
  const R = rng(o.seed ?? 5), H = o.h ?? 1.8, n = C.mobile ? (o.n ?? 50) * .6 : (o.n ?? 50);
  kit.add(M('ceramic'), lathe([[0, 0], [.17, 0], [.2, .04], [.23, .42], [.235, .46], [.215, .46], [.2, .44], [0, .44]], 32), { p: [x, PH, z], c: o.pot ?? 0x2a2a2c, cast: true });
  kit.add(M('paint'), cyl(.2, .2, .01, 24), { p: [x, PH + .43, z], c: 0x2b2118 });
  const leafG = new THREE.SphereGeometry(1, 7, 4);
  const stems = o.stems ?? 3;
  for (let s = 0; s < stems; s++) {
    const tx = x + (R() - .5) * .3, tz = z + (R() - .5) * .3, top = H * (.75 + R() * .25);
    rod(kit, M('paint'), [x, PH + .4, z], [tx, PH + top, tz], .012, 5, { c: 0x4a3a2a });
  }
  for (let i = 0; i < n; i++) {
    const t = .35 + R() * .65, a = R() * PI * 2, rr = (o.spread ?? .45) * (.4 + R() * .6) * Math.sin(t * PI * .9);
    const sz = (o.leaf ?? .13) * (.7 + R() * .5);
    const g = new THREE.Color().setHSL(.27 + R() * .05, .45 + R() * .2, .17 + R() * .1);
    kit.add(M('leaf'), leafG, { p: [x + Math.cos(a) * rr, PH + .45 + t * (H - .5), z + Math.sin(a) * rr], r: [(R() - .5) * 1.4, a, (R() - .5) * 1.2 + .4], s: [sz * .7, sz * .06, sz], c: g, cast: true });
  }
}
function vase(kit, x, y, z, s, c, kind = 0) {
  const pts = [
    [[0, 0], [.05, 0], [.08, .06], [.09, .14], [.06, .24], [.035, .3], [.04, .33], [0, .32]],
    [[0, 0], [.07, 0], [.1, .05], [.11, .12], [.1, .17], [.09, .18], [0, .17]],
    [[0, 0], [.04, 0], [.05, .1], [.04, .32], [.045, .42], [0, .41]],
  ][kind];
  kit.add(M('ceramic'), lathe(pts, 28), { p: [x, y, z], s, c, cast: true });
}
function books(kit, x, y, z, n, R, ry = 0, lying = false) {
  const cols = [0x8c2f2a, 0x1f3b5a, 0xd8cdb6, 0x2c2c2c, 0x5b6e4f, 0xc79a3a, 0xe8e4dc];
  let off = 0;
  for (let i = 0; i < n; i++) {
    const w = .025 + R() * .02, h = .2 + R() * .08, d = .15 + R() * .04, c = cols[Math.floor(R() * cols.length)];
    if (lying) { kit.add(M('paint'), rb(h * 1.2, w, d * 1.3, .004, 1), { p: [x, y + off + w / 2, z], r: [0, ry + (R() - .5) * .3, 0], c }); off += w; }
    else { kit.add(M('paint'), rb(w, h, d, .004, 1), { p: [x + Math.cos(ry) * off, y + h / 2, z - Math.sin(ry) * off], r: [0, ry, 0], c }); off += w + .002; }
  }
}
/* Suspension (abat-jour dôme) : retourne rien, ajoute au kit */
const DOME = [[0, .19], [.055, .18], [.115, .12], [.165, .01], [.17, 0], [.175, .03], [.125, .13], [.06, .195], [.03, .205], [0, .207]];

/* =====================================================================
   STAND 0 — LMP2 Racing Market (garage / paddock)
   ===================================================================== */
function standRacing(C) {
  const { kit, mobile } = C;
  platform(C, M('epoxy'));
  kit.add(M('hazard'), new THREE.PlaneGeometry(9.0, .14), { p: [0, PH + .002, 2.06], r: [-PI / 2, 0, 0], uv: 0, uvs: [16, 1] });
  // marquage jaune du box autour de la platine
  const Y = 0xe9b800;
  for (const [x, z, w, d] of [[-1.15, -.42, 2.3, .05], [-1.15, 1.92, 2.3, .05], [-2.3, .75, .05, 2.39], [0, .75, .05, 2.39]])
    kit.add(M('paint'), new THREE.PlaneGeometry(w, d), { p: [x, PH + .002, z], r: [-PI / 2, 0, 0], c: Y });

  // mur de fond habillé de panneaux carbone
  kit.add(M('matteBlack'), rb(9.16, 4.8, .22, .02), { p: [0, PH + 2.4, -2.46], pick: true, cast: true });
  for (let c = 0; c < 6; c++) for (let r = 0; r < 2; r++)
    kit.add(M('carbon'), rb(1.49, 2.39, .03, .008, 1), { p: [-3.75 + c * 1.5, PH + 1.2 + r * 2.4, WZ + .015] });
  if (!mobile) kit.add(M('checker'), new THREE.PlaneGeometry(9.0, .18), { p: [0, PH + 4.52, WZ + .032], uv: 0, uvs: [12.5, 1] });
  kit.add(M('matteBlack'), rb(9.18, .04, .26, .01, 1), { p: [0, PH + 4.82, -2.46] });

  // mur LED (photo)
  const a = C.aspect;
  let sh = 2.38, sw = sh * a; if (sw > 6.6) { sw = 6.6; sh = sw / a; }
  const cy = PH + 1.5 + sh / 2;
  kit.add(M('matteBlack'), rb(sw + .16, sh + .16, .1, .015), { p: [0, cy, WZ + .08], cast: true });
  const scr = screenMesh(C, sw, sh); scr.position.set(0, cy, WZ + .132); C.g.add(scr);
  const chase = new THREE.MeshBasicMaterial({ map: chaseTex(), color: new THREE.Color(BLUE).multiplyScalar(3.6), toneMapped: false });
  chase.map.repeat.set(10, 1);
  kit.add(chase, new THREE.PlaneGeometry(sw, .03), { p: [0, cy - sh / 2 - .17, WZ + .035], uv: 0 });

  // cloison gauche carbone + LED jaune
  kit.add(M('matteBlack'), rb(.2, 3.8, 2.95, .02), { p: [-4.48, PH + 1.9, WZ + 1.475], cast: true });
  kit.add(M('carbon'), rb(.025, 3.7, 2.85, .006, 1), { p: [-4.367, PH + 1.9, WZ + 1.475] });
  kit.add(M('ledYellow'), new THREE.BoxGeometry(.035, 3.7, .03), { p: [-4.48, PH + 1.9, .62] });

  // structure treillis (portique) + projecteurs + bandeau enseigne
  const tz = 1.85;
  for (const sx of [-1, 1]) {
    truss(kit, M('alu'), [sx * 4.36, PH + .02, tz], [sx * 4.36, 5.35, tz], .29, mobile);
    kit.add(M('alu'), rb(.4, .02, .4, .005, 1), { p: [sx * 4.36, PH + .01, tz] });
  }
  truss(kit, M('alu'), [-4.21, 5.2, tz], [4.21, 5.2, tz], .29, mobile);
  kit.add(M('matteBlack'), rb(6.7, .6, .04, .01, 1), { p: [0, 5.2, 2.02] });
  const sg = signMesh(C, 6.5); sg.position.set(0, 5.2, 2.043); C.g.add(sg);
  for (const x of [-3.1, -1.3, 1.3, 3.1]) {
    const can = new THREE.Vector3(x, 4.86, tz), tgt = new THREE.Vector3(x * .7, 1.0, -1.6), dir = tgt.clone().sub(can).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(_up, dir.clone().negate());
    kit.add(M('matteBlack'), cyl(.075, .085, .24, 16), { p: can.toArray(), q });
    kit.add(M('warmLED'), new THREE.CircleGeometry(.062, 16), { p: can.clone().addScaledVector(dir, .121).toArray(), q: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir) });
    rod(kit, M('matteBlack'), [x, 5.06, tz], [x, 4.93, tz], .012, 6);
    if (!mobile) cone(kit, M('cone'), can.clone().addScaledVector(dir, .13).toArray(), can.clone().addScaledVector(dir, 4.6).toArray(), .07, .75);
  }

  // vitrine trophée
  const vx = -3.55, vz = -1.55;
  kit.add(M('lacquerBlack'), rb(.8, 1.0, .8, .02), { p: [vx, PH + .5, vz], cast: true });
  kit.add(M('ledYellow'), new THREE.BoxGeometry(.805, .012, .805), { p: [vx, PH + 1.0, vz] });
  kit.add(M('glass'), rb(.76, .72, .76, .008, 1), { p: [vx, PH + 1.37, vz] });
  kit.add(M('lacquerBlack'), rb(.8, .06, .8, .015, 1), { p: [vx, PH + 1.76, vz] });
  kit.add(M('warmLED'), new THREE.CircleGeometry(.09, 20), { p: [vx, PH + 1.729, vz], r: [PI / 2, 0, 0] });
  kit.add(M('lacquerBlack'), rb(.26, .09, .26, .01, 1), { p: [vx, PH + 1.055, vz] });
  kit.add(M('gold'), lathe([[0, 0], [.1, 0], [.1, .025], [.07, .035], [.03, .06], [.022, .12], [.024, .2], [.035, .23], [.09, .26], [.125, .31], [.14, .38], [.142, .44], [.136, .445], [.128, .39], [.115, .32], [.08, .275], [0, .27]], 40), { p: [vx, PH + 1.1, vz], s: 1.05, cast: true });
  for (const sx of [-1, 1]) kit.add(M('gold'), new THREE.TorusGeometry(.07, .011, 8, 20, PI), { p: [vx + sx * .14, PH + 1.1 + .36, vz], r: [0, 0, sx > 0 ? -PI / 2 : PI / 2] });

  // piles de pneus
  const TYRE = [[.215, -.13], [.25, -.142], [.3, -.14], [.322, -.125], [.334, -.09], [.338, -.04], [.338, .04], [.334, .09], [.322, .125], [.3, .14], [.25, .142], [.215, .13], [.215, -.13]];
  const tyreG = lathe(TYRE, mobile ? 32 : 56);
  for (const [x, z, n, rot] of [[-3.72, .98, 4, .3], [-2.98, 1.62, 3, 1.1]]) {
    for (let k = 0; k < n; k++) kit.add(M('rubber'), tyreG, { p: [x + (k % 2) * .015, PH + .142 + k * .284, z], r: [0, rot + k, 0], cast: true });
    kit.add(M('ledYellow'), new THREE.TorusGeometry(.285, .005, 4, 48), { p: [x, PH + .142 + (n - 1) * .284 + .141, z], r: [PI / 2, 0, 0] });
  }

  // platine tournante + jante chromée
  const tx = -1.15, tzz = .75;
  kit.add(M('lacquerBlack'), cyl(.78, .8, .16, 48), { p: [tx, PH + .08, tzz], cast: true });
  kit.add(M('ledBlue'), new THREE.TorusGeometry(.79, .008, 4, 64), { p: [tx, PH + .012, tzz], r: [PI / 2, 0, 0] });
  const turn = new THREE.Group(); turn.position.set(tx, PH + .16, tzz); C.g.add(turn);
  const tk = new Kit(turn, mobile, C.picks);
  tk.add(M('carbon'), cyl(.74, .74, .03, 48), { p: [0, .015, 0] });
  const wy = .03 + .34;
  tk.add(M('rubber'), tyreG, { p: [0, wy, 0], r: [PI / 2, 0, 0], cast: true });
  tk.add(M('ledYellow'), new THREE.TorusGeometry(.29, .004, 4, 64), { p: [0, wy, .133] });
  tk.add(M('chrome'), lathe([[.2, -.115], [.214, -.125], [.214, .125], [.2, .115]], 48), { p: [0, wy, 0], r: [PI / 2, 0, 0] });
  tk.add(M('chrome'), new THREE.TorusGeometry(.21, .01, 8, 64), { p: [0, wy, .118] });
  tk.add(M('steel'), cyl(.17, .17, .022, 40), { p: [0, wy, -.01], r: [PI / 2, 0, 0] });
  tk.add(M('paint'), rb(.07, .13, .07, .015, 1), { p: [.12, wy + .11, .02], r: [0, 0, -.8], c: 0xe9b800 });
  tk.add(M('chrome'), cyl(.065, .07, .07, 24), { p: [0, wy, .085], r: [PI / 2, 0, 0] });
  tk.add(M('paint'), new THREE.CircleGeometry(.04, 20), { p: [0, wy, .1205], c: 0xe9b800 });
  for (let i = 0; i < 5; i++) for (const off of [-.11, .11]) {
    const ang = i / 5 * PI * 2 + off, r0 = .065, r1 = .208;
    const mid = (r0 + r1) / 2;
    tk.add(M('chrome'), rb(.026, r1 - r0, .03, .008, 1), { p: [Math.sin(ang) * mid, wy + Math.cos(ang) * mid, .095], r: [0, 0, -ang] });
  }
  for (const sz of [-1, 1]) tk.add(M('alu'), rb(.3, .05, .07, .015, 1), { p: [0, .055, sz * .17] });
  tk.flush();

  // servante d'atelier
  kit.at(3.95, 0, -2.02, 0, 1, () => {
    kit.add(M('lacquerBlack'), rb(1.0, .92, .55, .02), { p: [0, PH + .1 + .46, 0], cast: true });
    for (let i = 0; i < 5; i++) {
      kit.add(M('alu'), rb(.94, .15, .02, .006, 1), { p: [0, PH + .2 + i * .17, .28] });
      kit.add(M('chrome'), rb(.6, .015, .025, .006, 1), { p: [0, PH + .25 + i * .17, .3] });
    }
    kit.add(M('rubber'), rb(1.02, .03, .57, .01, 1), { p: [0, PH + 1.035, 0] });
    for (const [x, z] of [[-.42, -.2], [.42, -.2], [-.42, .2], [.42, .2]]) kit.add(M('rubber'), cyl(.045, .045, .04, 12), { p: [x, PH + .05, z], r: [0, 0, PI / 2] });
  });

  // comptoir + casque
  const top = counter(C, 2.65, 1.12, 2.0, .64, { inlay: M('carbon'), top: M('carbon'), led: M('ledYellow'), logoX: .6 });
  kit.at(3.25, top, 1.05, -.6, 1, () => {
    kit.add(M('gloss'), new THREE.SphereGeometry(.15, 32, 20), { p: [0, .14, 0], s: [1, .93, 1.12], c: 0xe9c400, cast: true });
    kit.add(M('gloss'), new THREE.SphereGeometry(.152, 32, 10, PI * .3, PI * .4, PI * .32, PI * .2), { p: [0, .14, 0], s: [1, .93, 1.12], c: 0x0b0b0c });
    kit.add(M('gloss'), new THREE.TorusGeometry(.149, .012, 8, 40, PI), { p: [0, .14, 0], r: [0, PI / 2, PI / 2], s: [1, 1.12, .93], c: 0x111111 });
  });

  keySpot(C, [0, 4.85, 1.95], [-.4, .6, -.8], { intensity: 130, angle: .82, color: 0xfff3e6 });
  fillPoint(C, [-1.15, 1.7, 2.1], 0xe8eeff, 3, 4);

  return {
    anchor: new THREE.Vector3(0, 4.4, 1.4),
    focus: { pos: new THREE.Vector3(.3, 1.7, 7.8), look: new THREE.Vector3(0, 2.5, -1.4) },
    update(dt, t) { turn.rotation.y += dt * .45; chase.map.offset.x = (chase.map.offset.x - dt * .5) % 1; },
  };
}

/* =====================================================================
   STAND 1 — Showroom cuisiniste
   ===================================================================== */
function standKitchen(C) {
  const { kit, mobile } = C, R = rng(21);
  platform(C, M('oakFloor'));
  kit.add(M('plasterWarm'), rb(9.16, 4.75, .22, .02), { p: [0, PH + 2.375, -2.46], pick: true, cast: true });
  kit.add(M('oak'), rb(9.18, .05, .26, .01, 1), { p: [0, PH + 4.77, -2.46] });

  // colonnes hautes anthracite (fours intégrés)
  kit.add(M('cabinet'), rb(2.4, 2.48, .58, .01, 1), { p: [-3.28, PH + .08 + 1.24, WZ + .29], cast: true });
  kit.add(M('matteBlack'), rb(2.36, .08, .5, .005, 1), { p: [-3.28, PH + .04, WZ + .27] });
  for (const x of [-4.18, -2.98, -2.38]) kit.add(M('cabinet'), rb(.594, 2.46, .02, .004, 1), { p: [x, PH + .08 + 1.23, WZ + .59] });
  kit.add(M('cabinet'), rb(.594, .78, .02, .004, 1), { p: [-3.58, PH + .08 + .39, WZ + .59] });
  kit.add(M('darkGlass'), rb(.56, .58, .025, .006, 1), { p: [-3.58, PH + 1.17, WZ + .59] });
  kit.add(M('darkGlass'), rb(.56, .4, .025, .006, 1), { p: [-3.58, PH + 1.68, WZ + .59] });
  kit.add(M('cabinet'), rb(.594, .64, .02, .004, 1), { p: [-3.58, PH + 2.22, WZ + .59] });
  for (const y of [1.43, 1.85]) kit.add(M('alu'), rb(.5, .02, .03, .008, 1), { p: [-3.58, PH + y, WZ + .62] });
  for (const x of [-4.18, -2.98, -2.38]) kit.add(M('alu'), rb(.015, .4, .02, .006, 1), { p: [x + (x < -3 ? .26 : -.26), PH + 1.2, WZ + .61] });

  // grand tirage photo encadré chêne
  const ph = 2.0, pw = ph * C.aspect, px = .15, py = PH + 1.75 + ph / 2;
  kit.add(M('oak'), rb(pw + .34, ph + .34, .05, .012), { p: [px, py, WZ + .025], cast: true });
  kit.add(M('offwhite'), rb(pw + .2, ph + .2, .012, .003, 1), { p: [px, py, WZ + .056] });
  const scr = screenMesh(C, pw, ph); scr.position.set(px, py, WZ + .063); C.g.add(scr);
  kit.add(M('brass'), rb(.9, .04, .05, .015, 1), { p: [px, py + ph / 2 + .3, WZ + .2] });
  rod(kit, M('brass'), [px, py + ph / 2 + .3, WZ + .03], [px, py + ph / 2 + .3, WZ + .18], .01, 8);
  kit.add(M('warmLED'), new THREE.BoxGeometry(.84, .006, .02), { p: [px, py + ph / 2 + .278, WZ + .2] });

  // linéaire droit : bas anthracite, plan marbre, hauts chêne, étagère
  const rx = 3.125;
  kit.add(M('cabinet'), rb(2.35, .8, .58, .01, 1), { p: [rx, PH + .08 + .4, WZ + .29], cast: true });
  kit.add(M('matteBlack'), rb(2.3, .08, .5, .005, 1), { p: [rx, PH + .04, WZ + .27] });
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const x = rx - .78 + i * .78, y = PH + .08 + .135 + j * .265;
    kit.add(M('cabinet'), rb(.774, .258, .02, .004, 1), { p: [x, y, WZ + .59] });
    kit.add(M('brass'), rb(.3, .012, .02, .005, 1), { p: [x, y + .09, WZ + .608] });
  }
  kit.add(M('marble'), rb(2.4, .04, .64, .008, 1), { p: [rx, PH + .9, WZ + .32], cast: true });
  kit.add(M('marble'), rb(2.35, .55, .02, .004, 1), { p: [rx, PH + .92 + .275, WZ + .01] });
  kit.add(M('oak'), rb(2.35, .7, .36, .01, 1), { p: [rx, PH + 1.85, WZ + .18], cast: true });
  for (let i = 0; i < 3; i++) kit.add(M('oak'), rb(.774, .68, .02, .004, 1), { p: [rx - .78 + i * .78, PH + 1.85, WZ + .37] });
  kit.add(M('warmLED'), new THREE.BoxGeometry(2.3, .008, .02), { p: [rx, PH + 1.497, WZ + .28] });
  kit.add(M('oak'), rb(2.35, .04, .28, .008, 1), { p: [rx, PH + 2.62, WZ + .14] });
  for (let i = 0; i < 5; i++) kit.add(M('ceramic'), cyl(.12, .1, .012, 28), { p: [2.25 + i * .025, PH + 2.76, WZ + .12], r: [PI / 2 - .1, 0, 0], c: 0xece8e0 });
  vase(kit, 3.0, PH + 2.64, WZ + .14, .9, 0xbfa58a, 1);
  vase(kit, 3.35, PH + 2.64, WZ + .14, .8, 0x2d2d2d, 0);
  vase(kit, 3.62, PH + 2.64, WZ + .14, .75, 0xe9e4da, 2);
  books(kit, 3.95, PH + 2.64, WZ + .14, 6, R, 0);
  // accessoires plan de travail
  for (let i = 0; i < 3; i++) {
    const x = 2.2 + i * .2;
    kit.add(M('ceramic'), cyl(.065, .05, .11, 18), { p: [x, PH + .92 + .055, WZ + .2], c: 0xb5653d });
    kit.add(M('leaf'), new THREE.IcosahedronGeometry(.075, 1), { p: [x, PH + .92 + .15, WZ + .2], s: [1, .8, 1], c: 0x3d6b2f });
  }
  kit.add(M('oak'), rb(.42, .3, .02, .008, 1), { p: [3.0, PH + .92 + .16, WZ + .06], r: [-.12, 0, 0] });
  kit.add(M('alu'), rb(.28, .34, .34, .03, 2), { p: [3.85, PH + .92 + .17, WZ + .22], cast: true });
  kit.add(M('darkGlass'), rb(.2, .12, .02, .008, 1), { p: [3.85, PH + .92 + .24, WZ + .395] });

  // claustra chêne côté droit
  kit.add(M('matteBlack'), rb(.04, 3.1, 2.6, .01, 1), { p: [4.5, PH + 1.55, -1.05] });
  for (let z = -2.28; z <= .2; z += .11) kit.add(M('oak'), rb(.04, 3.1, .055, .008, 1), { p: [4.44, PH + 1.55, z], rotUV: true, cast: true });

  // îlot central : façade chêne, plan marbre en cascade
  const ix = .2, iz = .45;
  kit.add(M('matteBlack'), rb(2.4, .08, .78, .005, 1), { p: [ix, PH + .04, iz] });
  kit.add(M('oak'), rb(2.5, .8, .9, .015), { p: [ix, PH + .08 + .4, iz], cast: true });
  for (const dx of [-.62, 0, .62]) kit.add(M('matteBlack'), new THREE.BoxGeometry(.008, .66, .004), { p: [ix + dx, PH + .5, iz + .452] });
  kit.add(M('marble'), rb(2.62, .05, 1.05, .01, 2), { p: [ix, PH + .905, iz + .03], cast: true, pick: true });
  for (const sx of [-1, 1]) kit.add(M('marble'), rb(.05, .88, 1.05, .01, 2), { p: [ix + sx * 1.285, PH + .44, iz + .03], cast: true });
  kit.add(M('darkGlass'), rb(.62, .008, .5, .004, 1), { p: [ix + .72, PH + .932, iz - .05] });
  for (const [dx, dz, r] of [[-.14, -.1, .07], [.14, -.1, .055], [-.14, .12, .055], [.14, .12, .07]])
    kit.add(M('alu'), new THREE.TorusGeometry(r, .003, 4, 32), { p: [ix + .72 + dx, PH + .937, iz - .05 + dz], r: [PI / 2, 0, 0] });
  kit.add(M('steel'), rb(.5, .006, .4, .003, 1), { p: [ix - .55, PH + .931, iz - .1] });
  const tapC = new THREE.CatmullRomCurve3([[0, 0, 0], [0, .3, 0], [0, .36, .05], [0, .34, .14], [0, .27, .17]].map(v => new THREE.Vector3(...v)));
  kit.add(M('chrome'), new THREE.TubeGeometry(tapC, 24, .011, 8), { p: [ix - .55, PH + .93, iz - .38] });
  kit.add(M('chrome'), cyl(.025, .028, .04, 16), { p: [ix - .55, PH + .95, iz - .38] });
  kit.add(M('ceramic'), lathe([[0, 0], [.08, 0], [.15, .05], [.17, .1], [.16, .1], [.14, .055], [.07, .015], [0, .015]], 32), { p: [ix + .05, PH + .93, iz + .2], c: 0xe8e4dc });
  for (let i = 0; i < 5; i++) kit.add(M('gloss'), new THREE.SphereGeometry(.035, 12, 8), { p: [ix + .05 + Math.cos(i * 1.3) * .07, PH + .93 + .05 + (i > 3 ? .04 : 0), iz + .2 + Math.sin(i * 1.3) * .06], s: [1, .9, 1.2], c: 0xe8c22a });

  // tabourets de bar
  for (const x of [-.6, .2, 1.0]) kit.at(x, 0, 1.38, 0, 1, () => {
    kit.add(M('leather'), lathe([[0, 0], [.17, 0], [.19, .02], [.195, .045], [.18, .065], [0, .07]], 32), { p: [0, PH + .66, 0], c: 0x8a5532, cast: true });
    kit.add(M('matteBlack'), cyl(.13, .13, .02, 24), { p: [0, PH + .65, 0] });
    for (let k = 0; k < 4; k++) { const a = k * PI / 2 + PI / 4; rod(kit, M('matteBlack'), [Math.cos(a) * .2, PH, Math.sin(a) * .2], [Math.cos(a) * .1, PH + .65, Math.sin(a) * .1], .011, 6, { cast: true }); }
    kit.add(M('matteBlack'), new THREE.TorusGeometry(.165, .008, 6, 32), { p: [0, PH + .3, 0], r: [PI / 2, 0, 0] });
  });

  // canopée à lames de chêne + suspensions
  for (const x of [-2.5, 2.6]) kit.add(M('matteBlack'), rb(.08, .14, 3.5, .01, 1), { p: [x, PH + 4.18, -.6], cast: true });
  for (let z = -2.15; z <= 1.0; z += .2) kit.add(M('oak'), rb(5.2, .09, .05, .008, 1), { p: [.05, PH + 4.08, z], cast: true });
  kit.add(M('matteBlack'), rb(5.4, .52, .08, .01, 1), { p: [.05, PH + 4.2, 1.17], cast: true });
  const sg = signMesh(C, 5.2); sg.position.set(.05, PH + 4.2, 1.212); C.g.add(sg);
  const pend = new THREE.Group(); C.g.add(pend);
  const pk = new Kit(pend, mobile, C.picks);
  for (const x of [-.6, .2, 1.0]) {
    rod(pk, M('matteBlack'), [x, PH + 4.03, iz], [x, PH + 2.07, iz], .004, 4);
    pk.add(M('brass'), lathe(DOME, 32), { p: [x, PH + 1.88, iz], s: .9, cast: true });
    pk.add(M('warmLED'), new THREE.CircleGeometry(.13, 24), { p: [x, PH + 1.9, iz], r: [PI / 2, 0, 0] });
  }
  pk.flush();

  // accueil
  const top = counter(C, -3.25, 1.42, 1.7, .6, { top: M('oak'), led: M('ledBlue') });
  kit.add(M('paint'), rb(.24, .03, .32, .004, 1), { p: [-3.6, top + .015, 1.4], r: [0, .2, 0], c: 0xf1eee8 });
  vase(kit, -2.75, top, 1.35, .9, 0x6b7a6a, 0);
  if (!mobile) plant(C, kit, 3.95, 1.55, { h: 1.5, seed: 9, n: 40, leaf: .1, pot: 0xb5653d });

  keySpot(C, [.3, 3.95, 2.1], [.1, .7, -1.2], { intensity: 72, angle: .85, color: 0xfff0dc });
  fillPoint(C, [.2, PH + 1.75, iz + .1], 0xffcf9a, 3.2, 3.2);

  return {
    anchor: new THREE.Vector3(0, 4.9, 1.4),
    update(dt, t) { pend.rotation.z = Math.sin(t * .6) * .0025; },
  };
}

/* =====================================================================
   STAND 2 — Showroom habitat (salon)
   ===================================================================== */
function standHome(C) {
  const { kit, mobile } = C, R = rng(77);
  platform(C, M('concrete'));
  kit.add(M('charcoal'), rb(9.16, 4.55, .22, .02), { p: [0, PH + 2.275, -2.46], pick: true, cast: true });
  kit.add(M('walnut'), rb(9.16, .62, .26, .015), { p: [0, PH + 4.55 + .31, -2.46], cast: true });
  const sg = signMesh(C, 6.6); sg.position.set(0, PH + 4.86, -2.328); C.g.add(sg);

  // mur acoustique à tasseaux de noyer
  kit.add(M('felt'), rb(2.45, 4.35, .03, .005, 1), { p: [-3.27, PH + 2.2, WZ + .015] });
  for (let x = -4.45; x <= -2.08; x += .1) kit.add(M('walnut'), rb(.045, 4.35, .04, .008, 1), { p: [x, PH + 2.2, WZ + .05], rotUV: true });

  // œuvre (photo) encadrée + applique
  const ph = 1.85, pw = ph * C.aspect, px = .1, py = PH + 1.95 + ph / 2;
  kit.add(M('walnut'), rb(pw + .32, ph + .32, .045, .01), { p: [px, py, WZ + .023], cast: true });
  kit.add(M('offwhite'), rb(pw + .2, ph + .2, .01, .003, 1), { p: [px, py, WZ + .05] });
  const scr = screenMesh(C, pw, ph); scr.position.set(px, py, WZ + .057); C.g.add(scr);
  kit.add(M('brass'), rb(.8, .035, .045, .014, 1), { p: [px, py + ph / 2 + .28, WZ + .19] });
  rod(kit, M('brass'), [px, py + ph / 2 + .28, WZ + .03], [px, py + ph / 2 + .28, WZ + .17], .009, 8);
  kit.add(M('warmLED'), new THREE.BoxGeometry(.75, .006, .018), { p: [px, py + ph / 2 + .26, WZ + .19] });

  // bibliothèque noyer rétroéclairée
  const bx = 3.25, bw = 2.4, bh = 3.6, bd = .36, bz = WZ + bd / 2;
  kit.add(M('matteBlack'), rb(bw, bh, .02, .004, 1), { p: [bx, PH + bh / 2, WZ + .01] });
  for (const sx of [-1, 1]) kit.add(M('walnut'), rb(.04, bh, bd, .006, 1), { p: [bx + sx * (bw / 2 - .02), PH + bh / 2, bz], rotUV: true, cast: true });
  kit.add(M('walnut'), rb(.035, bh - .08, bd - .02, .006, 1), { p: [bx, PH + bh / 2, bz], rotUV: true });
  const shelfY = [];
  for (let k = 0; k <= 5; k++) {
    const y = PH + .02 + k * (bh - .04) / 5; shelfY.push(y);
    kit.add(M('walnut'), rb(bw - .06, .035, bd - .01, .006, 1), { p: [bx, y, bz] });
    if (k > 0 && k < 5) kit.add(M('warmLED'), new THREE.BoxGeometry(bw - .14, .006, .012), { p: [bx, y - .02, WZ + .3] });
  }
  for (let k = 0; k < 5; k++) for (const side of [-1, 1]) {
    const cx = bx + side * .58, y = shelfY[k] + .018, r = R();
    if (k === 0 && side < 0) { books(kit, cx - .4, y, bz, 9, R, 0); continue; }
    if (r < .3) { vase(kit, cx - .15, y, bz, 1 + R() * .4, [0xd8cbb4, 0x2b2b2b, 0xb5653d, 0xe9e5dc][k % 4], k % 3); books(kit, cx + .2, y, bz, 3, R, 0, true); }
    else if (r < .55) { books(kit, cx - .35, y, bz, 6 + Math.floor(R() * 4), R, 0); kit.add(M('brass'), new THREE.SphereGeometry(.07, 20, 14), { p: [cx + .3, y + .07, bz] }); }
    else if (r < .8) { vase(kit, cx, y, bz, 1.3, [0xcfc3ad, 0x5d6770, 0x8c2f2a][k % 3], (k + 1) % 3); vase(kit, cx + .25, y, bz, .8, 0xe9e5dc, 1); }
    else { kit.add(M('walnut'), rb(.26, .34, .02, .006, 1), { p: [cx, y + .17, bz - .05], r: [-.15, 0, 0] }); kit.add(M('ceramic'), new THREE.SphereGeometry(.06, 16, 12), { p: [cx + .25, y + .06, bz], c: 0x2b2b2b }); }
  }

  // tapis
  kit.add(M('rug'), rb(3.4, .012, 2.4, .005, 1), { p: [.1, PH + .006, -.6], uv: 0 });

  // canapé trois places velours bleu nuit
  const NAVY = 0x283756;
  kit.at(.1, 0, -1.3, 0, 1, () => {
    for (const [x, z] of [[-1.2, -.38], [1.2, -.38], [-1.2, .38], [1.2, .38]]) kit.add(M('walnut'), rb(.06, .1, .06, .01, 1), { p: [x, PH + .062, z] });
    kit.add(M('fabric'), rb(2.6, .32, .95, .04), { p: [0, PH + .1 + .16, 0], c: NAVY, cast: true });
    for (const sx of [-1, 1]) kit.add(M('fabric'), rb(.2, .6, .95, .07), { p: [sx * 1.2, PH + .1 + .3, 0], c: NAVY, cast: true });
    kit.add(M('fabric'), rb(2.2, .46, .2, .06), { p: [0, PH + .42 + .23, -.375], c: NAVY, cast: true });
    for (let i = -1; i <= 1; i++) {
      kit.add(M('fabric'), rb(.72, .16, .72, .06), { p: [i * .73, PH + .42 + .08, .1], c: NAVY, cast: true });
      kit.add(M('fabric'), rb(.7, .44, .18, .08), { p: [i * .73, PH + .58 + .22, -.22], r: [-.14, 0, 0], c: NAVY, cast: true });
    }
    const pil = [[-.82, 0xd5a02a, .2], [-.48, 0xb3ac9f, -.1], [.5, 0xc9566a, .12], [.86, 0x2c7c78, -.18]];
    for (const [x, c, rz] of pil) kit.add(M('velvet'), rb(.42, .42, .13, .07), { p: [x, PH + .8, -.08], r: [-.28, rz * .6, rz], c, cast: true });
  });

  // fauteuil bouclette
  kit.at(2.1, 0, .3, -.55, 1, () => {
    const CR = 0xbdb6a9;
    for (const [x, z] of [[-.33, -.3], [.33, -.3], [-.33, .3], [.33, .3]]) kit.add(M('walnut'), rb(.05, .12, .05, .01, 1), { p: [x, PH + .06, z] });
    kit.add(M('fabric'), rb(.82, .3, .8, .06), { p: [0, PH + .12 + .15, 0], c: CR, cast: true });
    kit.add(M('fabric'), rb(.82, .5, .2, .08), { p: [0, PH + .42 + .2, -.3], r: [-.1, 0, 0], c: CR, cast: true });
    for (const sx of [-1, 1]) kit.add(M('fabric'), rb(.15, .28, .78, .07), { p: [sx * .335, PH + .42 + .1, .01], c: CR, cast: true });
    kit.add(M('fabric'), rb(.54, .12, .6, .05), { p: [0, PH + .42 + .06, .06], c: CR });
  });
  kit.add(M('walnut'), cyl(.22, .22, .03, 32), { p: [2.95, PH + .52, -.6] });
  kit.add(M('walnut'), cyl(.05, .07, .5, 16), { p: [2.95, PH + .25, -.6] });
  vase(kit, 2.95, PH + .535, -.6, .7, 0xb5653d, 0);

  // table basse travertin
  kit.add(M('travertine'), cyl(.52, .52, .06, 48), { p: [.1, PH + .012 + .36, -.1], cast: true });
  kit.add(M('travertine'), cyl(.3, .34, .33, 40), { p: [.1, PH + .012 + .165, -.1], cast: true });
  books(kit, -.1, PH + .012 + .39, -.05, 3, R, .3, true);
  vase(kit, .32, PH + .402, -.18, .9, 0x2b2b2b, 2);
  kit.add(M('ceramic'), lathe([[0, 0], [.05, 0], [.1, .03], [.11, .05], [.1, .05], [.09, .035], [0, .01]], 24), { p: [.25, PH + .402, .12], c: 0xe9e5dc });

  // lampadaire arc
  kit.add(M('marble'), cyl(.19, .2, .07, 32), { p: [-2.15, PH + .035, -1.45], cast: true });
  const arc = new THREE.CatmullRomCurve3([[-2.15, .07, -1.45], [-2.15, 1.3, -1.45], [-2.05, 2.1, -1.38], [-1.6, 2.38, -1.18], [-1.12, 2.22, -1.0], [-.96, 2.02, -.95]].map(v => new THREE.Vector3(v[0], v[1] + PH, v[2])));
  kit.add(M('brass'), new THREE.TubeGeometry(arc, 48, .014, 8), { cast: true });
  kit.add(M('brass'), lathe(DOME, 40), { p: [-.96, PH + 1.8, -.95], s: 1.4, cast: true });
  kit.add(M('warmLED'), new THREE.CircleGeometry(.2, 24), { p: [-.96, PH + 1.83, -.95], r: [PI / 2, 0, 0] });

  // plante
  const leaves = new THREE.Group(); C.g.add(leaves);
  const lk = new Kit(leaves, mobile, C.picks);
  plant(C, lk, -3.55, 1.05, { h: 2.0, seed: 3, n: 55, leaf: .17, spread: .5 });
  lk.flush();

  // accueil
  const top = counter(C, 3.4, 1.48, 1.6, .58, { top: M('walnut'), body: M('stoneCounter') });
  vase(kit, 3.85, top, 1.45, .8, 0xe9e5dc, 1);
  kit.add(M('paint'), rb(.24, .02, .32, .004, 1), { p: [3.1, top + .01, 1.45], r: [0, -.2, 0], c: 0xf1eee8 });

  keySpot(C, [0, 5.6, 2.15], [.2, .6, -.9], { intensity: 120, angle: .78, color: 0xfff1df });
  fillPoint(C, [-.96, PH + 1.6, -.95], 0xffc98f, 3, 3.6);

  return {
    anchor: new THREE.Vector3(0, 4.3, 1.4),
    update(dt, t) { leaves.rotation.z = Math.sin(t * .7) * .004; },
  };
}

/* =====================================================================
   STAND 3 — Salon « Planète Terre » (tech / futuriste)
   ===================================================================== */
const HOLO_VS = `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.); vV = normalize(-mv.xyz); vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`;
const HOLO_FS = `uniform sampler2D uLand; uniform float uTime; uniform vec3 uCol; uniform vec3 uRim;
varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main(){
  float rows = 64.;
  float r = floor(vUv.y * rows);
  float latc = ((r + .5) / rows - .5) * 3.14159265;
  float n = max(1., floor(rows * 2. * cos(latc)));
  vec2 cell = vec2(fract(vUv.x * n) - .5, fract(vUv.y * rows) - .5);
  vec2 cuv = vec2((floor(vUv.x * n) + .5) / n, (r + .5) / rows);
  float land = texture2D(uLand, cuv).r;
  float dotm = 1. - smoothstep(.16, .3, length(cell));
  float gx = abs(fract(vUv.x * 24.) - .5), gy = abs(fract(vUv.y * 12.) - .5);
  float grid = max(smoothstep(.48, .5, gx), smoothstep(.475, .5, gy));
  float fr = pow(1. - abs(dot(vN, vV)), 2.4);
  float scan = exp(-pow((vUv.y - fract(uTime * .11)) * 28., 2.));
  vec3 c = uCol * (dotm * (land * 1.7 + .08) + grid * .1 + scan * .4 * (.25 + land)) + uRim * fr * 1.2;
  float a = clamp(max(max(c.r, c.g), c.b), 0., 1.);
  gl_FragColor = vec4(c, a);
}`;
const ATMO_FS = `uniform vec3 uRim; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main(){ float i = pow(clamp(-dot(vN, vV), 0., 1.), 1.6) * 1.1; gl_FragColor = vec4(uRim * i, i); }`;
function standTech(C) {
  const { kit, mobile } = C;
  platform(C, M('lacquerWhite'));

  // mur courbe blanc laqué (extrusion d'un secteur d'anneau)
  const R1 = 6.0, R2 = 6.22, cz = WZ + R1, A = Math.asin(4.48 / R2), N = 40;
  const shape = new THREE.Shape();
  for (let i = 0; i <= N; i++) { const a = -A + 2 * A * i / N; const x = R1 * Math.sin(a), z = cz - R1 * Math.cos(a); i ? shape.lineTo(x, -z) : shape.moveTo(x, -z); }
  for (let i = N; i >= 0; i--) { const a = -A + 2 * A * i / N; shape.lineTo(R2 * Math.sin(a), -(cz - R2 * Math.cos(a))); }
  shape.closePath();
  const wallG = new THREE.ExtrudeGeometry(shape, { depth: 4.36, bevelEnabled: true, bevelThickness: .02, bevelSize: .02, bevelSegments: 2, curveSegments: 1 });
  wallG.rotateX(-PI / 2);
  kit.add(M('lacquerWhite'), wallG, { p: [0, PH + .02, 0], pick: true, cast: true, uv: 0 });

  // écran courbe (photo)
  const sh = 2.4, sw = sh * C.aspect, th = sw / (R1 - .03), cy = PH + 1.45 + sh / 2;
  const bez = new THREE.CylinderGeometry(R1 - .015, R1 - .015, sh + .1, 48, 1, true, PI - th / 2 - .012, th + .024);
  kit.add(once('m:blackDS', () => S({ color: 0x0c0c0f, roughness: .4, side: THREE.DoubleSide })), bez, { p: [0, cy, cz], uv: 0 });
  const scrG = new THREE.CylinderGeometry(R1 - .03, R1 - .03, sh, 48, 1, true, PI - th / 2, th);
  const uv = scrG.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
  const scr = new THREE.Mesh(scrG, C.screenMat); C.screenMat.side = THREE.BackSide;
  scr.position.set(0, cy, cz); C.g.add(scr); C.picks.push(scr);
  const arcTube = (r, y, a0, a1, rad = .012) => {
    const pts = []; for (let i = 0; i <= 48; i++) { const a = a0 + (a1 - a0) * i / 48; pts.push(new THREE.Vector3(r * Math.sin(a), y, cz - r * Math.cos(a))); }
    kit.add(M('ledBlue'), new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, rad, 6), { uv: 0 });
  };
  arcTube(R1 - .02, cy + sh / 2 + .16, -th / 2 - .06, th / 2 + .06);
  arcTube(R1 - .02, cy - sh / 2 - .16, -th / 2 - .06, th / 2 + .06);
  arcTube(R1 - .03, PH + .06, -A + .03, A - .03, .015);
  arcTube(R1 - .03, PH + 4.3, -A + .03, A - .03, .015);

  // bandeau enseigne flottant
  for (const x of [-2.4, 2.4]) kit.add(M('alu'), rb(.04, .32, .04, .01, 1), { p: [x, PH + 4.55, WZ - .1] });
  kit.add(M('darkGlass'), rb(5.8, .52, .06, .015, 1), { p: [0, PH + 4.95, WZ - .1] });
  const sg = signMesh(C, 5.6); sg.position.set(0, PH + 4.95, WZ - .068); C.g.add(sg);

  // globe holographique sur colonne
  const gx = -2.55, gz = .55, gy = PH + 1.95;
  kit.add(M('lacquerWhite'), lathe([[0, 0], [.46, 0], [.46, .05], [.33, .12], [.22, .3], [.19, .8], [.3, .92], [.38, .96], [0, .96]], 48), { p: [gx, PH, gz], cast: true });
  kit.add(M('ledBlue'), new THREE.TorusGeometry(.38, .008, 4, 48), { p: [gx, PH + .965, gz], r: [PI / 2, 0, 0] });
  const pulse = new THREE.MeshBasicMaterial({ color: new THREE.Color(BLUE).multiplyScalar(3), toneMapped: false });
  for (const r of [.9, 1.15]) kit.add(pulse, new THREE.RingGeometry(r, r + .022, 64), { p: [gx, PH + .002, gz], r: [-PI / 2, 0, 0], uv: 0 });
  const globe = new THREE.Group(); globe.position.set(gx, gy, gz); C.g.add(globe);
  const spin = new THREE.Group(); spin.rotation.z = .41; globe.add(spin);
  const core = new THREE.Mesh(new THREE.SphereGeometry(.585, 48, 32), M('coreBlue'));
  const holoMat = new THREE.ShaderMaterial({
    uniforms: { uLand: { value: landTex() }, uTime: { value: 0 }, uCol: { value: new THREE.Color(0x56b8ff) }, uRim: { value: new THREE.Color(0x4a5cff) } },
    vertexShader: HOLO_VS, fragmentShader: HOLO_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const holo = new THREE.Mesh(new THREE.SphereGeometry(.6, 64, 40), holoMat); holo.renderOrder = 3;
  spin.add(core, holo);
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(.74, 48, 32), new THREE.ShaderMaterial({
    uniforms: { uRim: { value: new THREE.Color(0x3d5bff) } }, vertexShader: HOLO_VS, fragmentShader: ATMO_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
  }));
  atmo.renderOrder = 2; globe.add(atmo);
  const orbits = new THREE.Group(); globe.add(orbits);
  const ok = new Kit(orbits, mobile, C.picks);
  ok.add(M('ledCyan'), new THREE.TorusGeometry(.84, .0035, 4, 96), { r: [PI / 2 + .35, 0, .2] });
  ok.add(M('ledCyan'), new THREE.TorusGeometry(.92, .003, 4, 96), { r: [PI / 2 - .5, .3, 0] });
  ok.add(M('coolLED'), new THREE.SphereGeometry(.02, 10, 8), { p: [.84 * Math.cos(.3), .84 * Math.sin(.3) * Math.sin(.35), .84 * Math.sin(.3) * Math.cos(.35)] });
  ok.flush();

  // anneau suspendu au-dessus du globe
  kit.add(M('lacquerWhite'), new THREE.TorusGeometry(.95, .07, 16, 72), { p: [gx, PH + 4.6, gz], r: [PI / 2, 0, 0], s: [1, 1, .6], uv: 0 });
  kit.add(M('ledBlue'), new THREE.TorusGeometry(.95, .02, 6, 72), { p: [gx, PH + 4.555, gz], r: [PI / 2, 0, 0] });
  for (let i = 0; i < 3; i++) { const a = i / 3 * PI * 2 + .3; rod(kit, M('alu'), [gx + Math.cos(a) * .95, PH + 4.64, gz + Math.sin(a) * .95], [gx + Math.cos(a) * .95, 6.15, gz + Math.sin(a) * .95], .004, 4); }
  if (!mobile) cone(kit, M('coneBlue'), [gx, PH + 4.5, gz], [gx, PH + .05, gz], .85, 1.0, 32);

  // bornes tactiles
  for (const [x, z, ry] of [[2.25, .75, -.25], [3.55, -.35, -.5]]) kit.at(x, 0, z, ry, 1, () => {
    kit.add(M('lacquerWhite'), rb(.46, .95, .34, .05), { p: [0, PH + .475, 0], cast: true });
    kit.add(M('ledBlue'), new THREE.BoxGeometry(.03, .7, .006), { p: [0, PH + .45, .171] });
    kit.add(M('ledBlue'), rb(.42, .015, .3, .005, 1), { p: [0, PH + .008, 0] });
    kit.add(M('lacquerWhite'), rb(.62, .055, .46, .02), { p: [0, PH + 1.02, .04], r: [.45, 0, 0], cast: true });
    kit.add(M('kiosk'), new THREE.PlaneGeometry(.54, .37), { p: [0, PH + 1.02 + Math.cos(.45) * .029, .04 + Math.sin(.45) * .029], r: [-PI / 2 + .45, 0, 0], uv: 0 });
  });

  // comptoir en gélule
  const cs = new THREE.Shape(); const cw = 2.0, cd = .7, r = .35;
  cs.moveTo(-cw / 2 + r, -cd / 2); cs.lineTo(cw / 2 - r, -cd / 2); cs.absarc(cw / 2 - r, 0, r, -PI / 2, PI / 2); cs.lineTo(-cw / 2 + r, cd / 2); cs.absarc(-cw / 2 + r, 0, r, PI / 2, PI * 1.5);
  const ext = (d, s) => { const g = new THREE.ExtrudeGeometry(cs, { depth: d, bevelEnabled: true, bevelThickness: .015, bevelSize: .015, bevelSegments: 2, curveSegments: 20 }); g.rotateX(-PI / 2); g.scale(s, 1, s); return g; };
  const cx = .5, czz = 1.42;
  kit.add(M('matteBlack'), ext(.06, .94), { p: [cx, PH + .015, czz], uv: 0 });
  kit.add(M('stoneCounter'), ext(.86, 1), { p: [cx, PH + .09, czz], pick: true, cast: true });
  kit.add(M('darkGlass'), ext(.03, 1.04), { p: [cx, PH + .985, czz], uv: 0, cast: true });
  kit.add(M('ledBlue'), new THREE.BoxGeometry(1.2, .012, .012), { p: [cx, PH + .05, czz + .33] });
  logo(kit, M('alu'), M('ledBlue'), cx, PH + .55, czz + .368, .26);

  keySpot(C, [0, 5.6, 2.15], [0, .4, -.6], { intensity: 75, angle: .75, color: 0xf0f4ff });
  fillPoint(C, [gx + .3, gy, gz + .9], 0x4a6bff, 4, 4);

  return {
    anchor: new THREE.Vector3(0, 4.25, 1.4),
    update(dt, t) {
      spin.rotation.y += dt * .18; holoMat.uniforms.uTime.value = t;
      orbits.rotation.y -= dt * .35;
      const k = 2.2 + Math.sin(t * 2.2) * 1.0; pulse.color.setRGB(.06 * k, .04 * k, .9 * k);
    },
  };
}

/* =====================================================================
   STAND 4 — Showroom Garde Temps (horlogerie)
   ===================================================================== */
function watch(kit, o) {
  // unités réelles (m), boîtier Ø 42 mm ; le kit est déjà sous une matrice d'échelle
  const caseM = o.gold ? M('gold') : M('steel');
  kit.add(caseM, lathe([[0, -.006], [.0195, -.006], [.021, -.0035], [.0212, 0], [.021, .0035], [.0195, .006], [0, .006]], 40), { r: [PI / 2, 0, 0] });
  kit.add(o.bezel ?? caseM, new THREE.TorusGeometry(.0186, .0019, 8, 48), { p: [0, 0, .0062] });
  kit.add(dialMat(o.dial), new THREE.CircleGeometry(.0172, 40), { p: [0, 0, .0064], uv: 0 });
  kit.add(caseM, cyl(.0028, .0028, .004, 12), { p: [.0225, 0, 0], r: [0, 0, PI / 2] });
  for (const [x, y] of [[-.008, .021], [.008, .021], [-.008, -.021], [.008, -.021]]) kit.add(caseM, rb(.004, .009, .007, .0015, 1), { p: [x, y, -.001] });
  const sh = new THREE.Shape(), out = (x0, y0, w, h, r, s) => {
    s.moveTo(x0 + r, y0); s.lineTo(x0 + w - r, y0); s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r); s.lineTo(x0 + w, y0 + h - r); s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
    s.lineTo(x0 + r, y0 + h); s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r); s.lineTo(x0, y0 + r); s.quadraticCurveTo(x0, y0, x0 + r, y0);
  };
  out(.004, -.029, .072, .058, .02, sh);
  const hole = new THREE.Path(); out(.007, -.026, .066, .052, .017, hole); sh.holes.push(hole);
  const strap = new THREE.ExtrudeGeometry(sh, { depth: .019, bevelEnabled: false, curveSegments: 6 });
  strap.rotateY(PI / 2); strap.translate(-.0095, 0, 0);
  kit.add(o.strapMat ?? M('leather'), strap, { c: o.strapC ?? 0x1a1410, uv: 0 });
}
function standWatch(C) {
  const { kit, mobile } = C;
  platform(C, M('nero'));
  kit.add(M('lacquerBlack'), rb(9.16, 4.6, .22, .02), { p: [0, PH + 2.3, -2.46], pick: true, cast: true });
  kit.add(M('brass'), rb(9.18, .03, .25, .008, 1), { p: [0, PH + 4.6, -2.46] });

  // caisson lumineux (photo) cadre laiton + halo
  const ph = 2.3, pw = ph * C.aspect, py = PH + 1.5 + ph / 2;
  kit.add(M('glowFrame'), new THREE.PlaneGeometry(pw + .9, ph + .9), { p: [0, py, WZ + .006], uv: 0 });
  kit.add(M('brass'), rb(pw + .08, ph + .08, .035, .008, 1), { p: [0, py, WZ + .02], cast: true });
  const scr = screenMesh(C, pw, ph); scr.position.set(0, py, WZ + .039); C.g.add(scr);

  // panneaux cannelés laqués + filets laiton
  const fl = new THREE.CylinderGeometry(.035, .035, 4.2, mobile ? 5 : 8, 1, true, -PI / 2, PI);
  const x0 = 1.98, x1 = 4.5;
  for (const sx of [-1, 1]) {
    for (let x = x0 + .035; x <= x1 - .035; x += .07) kit.add(M('lacquerBlack'), fl, { p: [sx * x, PH + 2.25, WZ] });
    kit.add(M('brass'), rb(.02, 4.3, .025, .006, 1), { p: [sx * (x0 - .04), PH + 2.25, WZ + .012] });
    kit.add(M('brass'), rb(x1 - x0 + .04, .02, .03, .006, 1), { p: [sx * (x0 + x1) / 2, PH + .14, WZ + .04] });
  }

  // plafond suspendu laqué + enseigne + downlights
  const CY = 4.45; // sous-face du plafond
  kit.add(M('lacquerBlack'), rb(8.8, .5, 2.7, .03), { p: [0, CY + .25, .2], cast: true });
  for (const sz of [-1, 1]) kit.add(M('brass'), rb(8.84, .025, .02, .006, 1), { p: [0, CY + .012, .2 + sz * 1.36] });
  for (const sx of [-1, 1]) kit.add(M('brass'), rb(.02, .025, 2.74, .006, 1), { p: [sx * 4.41, CY + .012, .2] });
  const sg = signMesh(C, 5.6); sg.position.set(0, CY + .25, 1.553); C.g.add(sg);
  for (const [x, z] of [[-4.1, -.9], [4.1, -.9], [-4.1, 1.3], [4.1, 1.3]]) rod(kit, M('steel'), [x, CY + .5, z], [x, 6.15, z], .004, 4);

  // vitrines sur colonnes
  const vitr = [[-3.05, -.05, 'black', false], [-1.45, .9, 'blue', true], [1.95, -.1, 'green', false]];
  let hero = null, heroSec = null;
  for (const [x, z, dial, isHero] of vitr) {
    kit.add(M('lacquerBlack'), rb(.6, 1.0, .6, .02), { p: [x, PH + .5, z], cast: true });
    kit.add(M('brass'), rb(.62, .03, .62, .008, 1), { p: [x, PH + 1.0, z] });
    kit.add(M('velvet'), rb(.54, .02, .54, .006, 1), { p: [x, PH + 1.025, z], c: 0x4a1420 });
    kit.add(M('glass'), rb(.58, .44, .58, .006, 1), { p: [x, PH + 1.255, z] });
    kit.add(M('lacquerBlack'), rb(.62, .05, .62, .012, 1), { p: [x, PH + 1.5, z] });
    for (const sd of [-1, 1]) { kit.add(M('brass'), new THREE.BoxGeometry(.63, .012, .012), { p: [x, PH + 1.472, z + sd * .309] }); kit.add(M('brass'), new THREE.BoxGeometry(.012, .012, .63), { p: [x + sd * .309, PH + 1.472, z] }); }
    kit.add(M('warmLED'), new THREE.CircleGeometry(.05, 16), { p: [x, PH + 1.474, z], r: [PI / 2, 0, 0] });
    kit.add(M('warmLED'), new THREE.CircleGeometry(.07, 20), { p: [x, CY - .001, z], r: [PI / 2, 0, 0] });
    kit.add(M('brass'), new THREE.TorusGeometry(.075, .008, 6, 24), { p: [x, CY, z], r: [PI / 2, 0, 0] });
    if (!mobile) cone(kit, M('cone'), [x, CY - .01, z], [x, PH + 1.53, z], .06, .38);
    for (const [cx2, cz2] of [[-.285, -.285], [.285, -.285], [-.285, .285], [.285, .285]]) kit.add(M('brass'), new THREE.BoxGeometry(.008, .44, .008), { p: [x + cx2, PH + 1.255, z + cz2] });
    const sc = 3.3;
    const host = isHero ? new THREE.Group() : null;
    if (host) { host.position.set(x, PH + 1.035, z); C.g.add(host); hero = host; }
    const wk = isHero ? new Kit(host, mobile, C.picks) : kit;
    const ox = isHero ? 0 : x, oy = isHero ? 0 : PH + 1.035, oz = isHero ? 0 : z;
    wk.add(M('velvet'), rb(.09 * sc, .05 * sc, .066 * sc, .02 * sc), { p: [ox, oy + .045 * sc, oz - .04 * sc], c: 0x4a4039 });
    wk.add(M('brass'), cyl(.07 * sc, .075 * sc, .02 * sc, 32), { p: [ox, oy + .01 * sc, oz - .04 * sc] });
    wk.at(ox, oy + .045 * sc, oz - .004 * sc, 0, sc, () => watch(wk, { dial, gold: dial === 'green', bezel: dial === 'black' ? M('lacquerBlack') : null, strapMat: dial === 'blue' ? M('steel') : M('leather'), strapC: dial === 'green' ? 0x4a2a18 : 0x111111 }));
    if (isHero) {
      wk.flush();
      const sg2 = new THREE.BoxGeometry(.0007, .017, .0004); sg2.translate(0, .005, 0);
      heroSec = new THREE.Mesh(sg2, once('m:secHand', () => S({ color: 0xd8322a, roughness: .4 })));
      heroSec.position.set(0, .045 * sc, -.004 * sc + .0068 * sc); heroSec.scale.setScalar(sc); host.add(heroSec);
    }
  }

  // banquette velours + piètement laiton
  kit.at(.55, 0, 1.45, 0, 1, () => {
    kit.add(M('velvet'), rb(1.5, .14, .44, .06), { p: [0, PH + .38, 0], c: 0x1d4636, cast: true });
    for (const [x, z] of [[-.68, -.17], [.68, -.17], [-.68, .17], [.68, .17]]) rod(kit, M('brass'), [x, PH, z], [x, PH + .31, z], .014, 10, { cast: true });
    for (const sz of [-.17, .17]) rod(kit, M('brass'), [-.68, PH + .1, sz], [.68, PH + .1, sz], .01, 8);
    for (const sx of [-.68, .68]) rod(kit, M('brass'), [sx, PH + .1, -.17], [sx, PH + .1, .17], .01, 8);
  });
  for (const x of [.55]) {
    kit.add(M('warmLED'), new THREE.CircleGeometry(.07, 20), { p: [x, CY - .001, 1.45], r: [PI / 2, 0, 0] });
    kit.add(M('brass'), new THREE.TorusGeometry(.075, .008, 6, 24), { p: [x, CY, 1.45], r: [PI / 2, 0, 0] });
  }

  // accueil travertin / marbre noir / laiton
  counter(C, 3.35, .9, 1.6, .62, { body: M('travertine'), top: M('nero'), led: M('warmLED'), logoFrame: M('brass') });
  kit.add(M('brass'), rb(1.56, .06, .55, .006, 1), { p: [3.35, PH + .1, .9] });
  kit.add(M('warmLED'), new THREE.CircleGeometry(.07, 20), { p: [3.35, CY - .001, .9], r: [PI / 2, 0, 0] });

  keySpot(C, [0, 4.3, 2.05], [-.5, .7, -.6], { intensity: 100, angle: .9, color: 0xffe4c4 });
  fillPoint(C, [-2.2, 2.2, 1.6], 0xffd2a0, 1.6, 4);

  let tick = 0;
  return {
    anchor: new THREE.Vector3(0, 4.25, 1.75),
    update(dt, t) {
      if (hero) hero.rotation.y = Math.sin(t * .35) * .7;
      if (heroSec) { const s = Math.floor(t); if (s !== tick) { tick = s; heroSec.rotation.z = -(s % 60) / 60 * PI * 2; } }
    },
  };
}

/* =====================================================================
   Point d'entrée
   ===================================================================== */
const BUILDERS = [standRacing, standKitchen, standHome, standTech, standWatch];

export function buildStand({ THREE: _T, data = {}, index = 0, mobile = false, photo, sign, envMap } = {}) {
  TS = mobile ? 512 : 1024; MOBILE = !!mobile;
  const group = new THREE.Group();
  group.name = 'stand-' + index;
  const picks = [], lights = [];
  let tex = null;
  try { tex = photo ? photo(data.img) : null; } catch (e) { tex = null; }
  let signTex = null;
  try { signTex = sign ? sign(data.title || '', data.sub || '') : null; } catch (e) { signTex = null; }
  if (!signTex) signTex = fallbackSign(data.title);
  const screenMat = new THREE.MeshBasicMaterial({ map: tex || null, color: tex ? new THREE.Color(.9, .9, .9) : new THREE.Color(0x1a1a22), toneMapped: false });
  const C = {
    g: group, mobile, picks, lights, envMap, signTex, screenMat,
    aspect: data.aspect || (index === 0 ? 2208 / 796 : 1032 / 796),
  };
  C.kit = new Kit(group, mobile, picks);
  const builder = BUILDERS[((index % 5) + 5) % 5];
  const res = builder(C);
  C.kit.flush();
  group.traverse(o => { if (o.isMesh && !o.userData.standPart) o.userData.standPart = true; });
  const focus = res.focus || { pos: new THREE.Vector3(.3, 1.7, 7.6), look: new THREE.Vector3(0, 2.4, -1.4) };
  return {
    group, pickables: picks, anchor: res.anchor, focus, lights,
    update: (dt, time) => { try { res.update && res.update(dt, time); } catch (e) { /* jamais bloquant */ } },
  };
}
