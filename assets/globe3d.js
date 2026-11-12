/* Neokrome — globe 3D « Partout » (three.js r160)
   mountGlobe(el) → { destroy() }
   Globe en points, atmosphère en fresnel, liaisons lumineuses qui partent du studio vers le monde. */
import * as THREE from 'three';

const deg = Math.PI / 180;
const HUB = [48.4, 2.7];
const DEST = [
  [40.7, -74], [45.5, -73.6], [34, -118.2], [-23.5, -46.6], [14.7, -17.4], [25.2, 55.3],
  [1.35, 103.8], [35.7, 139.7], [-33.9, 151.2], [-33.9, 18.4], [51.5, -.1], [55.7, 37.6], [19.4, -99.1], [28.6, 77.2],
];
function ll(lat, lon, r = 1) {
  const p = (90 - lat) * deg, t = (lon + 180) * deg;
  return new THREE.Vector3(-r * Math.sin(p) * Math.cos(t), r * Math.cos(p), r * Math.sin(p) * Math.sin(t));
}

export function mountGlobe(el) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0, 0);
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(30, 1, .1, 50); cam.position.set(0, 0, 4.5);

  const world = new THREE.Group(); world.rotation.z = .22; scene.add(world);
  const globe = new THREE.Group(); world.add(globe);

  /* sphère pleine (cache les points de dos) */
  globe.add(new THREE.Mesh(new THREE.SphereGeometry(.985, 64, 48), new THREE.MeshBasicMaterial({ color: 0x0E2152 })));

  /* points — distribution de Fibonacci, plus lumineux face caméra */
  const N = 5200, pos = new Float32Array(N * 3), rnd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * Math.PI * (3 - Math.sqrt(5));
    pos.set([Math.cos(th) * r, y, Math.sin(th) * r], i * 3); rnd[i] = Math.random();
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); pg.setAttribute('rnd', new THREE.BufferAttribute(rnd, 1));
  const pm = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uPx: { value: 1 }, uT: { value: 0 } },
    vertexShader: `attribute float rnd; uniform float uPx; uniform float uT; varying float vF; varying float vR;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.); vec3 n = normalize(normalMatrix * position);
        vF = clamp(dot(n, normalize(-mv.xyz)), 0., 1.); vR = rnd;
        gl_PointSize = (1.6 + rnd * 1.1) * uPx * (.55 + .45 * vF); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying float vF; varying float vR; uniform float uT;
      void main(){ vec2 c = gl_PointCoord - .5; float d = length(c); if (d > .5) discard;
        float tw = .75 + .25 * sin(uT * 1.5 + vR * 40.);
        vec3 col = mix(vec3(.2,.36,.85), vec3(.78,.87,1.), vF);
        gl_FragColor = vec4(col, smoothstep(.5,.2,d) * (.15 + .85 * vF) * tw); }`,
  });
  globe.add(new THREE.Points(pg, pm));

  /* atmosphère (fresnel, face arrière agrandie) */
  const atm = new THREE.Mesh(new THREE.SphereGeometry(1.16, 64, 48), new THREE.ShaderMaterial({
    transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `varying vec3 vN; varying vec3 vV; void main(){ float i = pow(smoothstep(0., .52, -dot(vN, vV)), 2.) * .55; gl_FragColor = vec4(vec3(.25,.45,1.) * i, i); }`,
  }));
  world.add(atm);
  const rim = new THREE.Mesh(new THREE.SphereGeometry(1.0, 64, 48), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `varying vec3 vN; varying vec3 vV; void main(){ float i = pow(1. - clamp(dot(vN, vV),0.,1.), 4.) ; gl_FragColor = vec4(vec3(.35,.55,1.) * i * .55, i * .6); }`,
  }));
  world.add(rim);

  /* studio : point lumineux + onde */
  const hubP = ll(...HUB, 1.004);
  const ringGeo = new THREE.RingGeometry(.7, 1, 48);
  const mkRing = (p, color, s) => {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    m.position.copy(p); m.lookAt(p.clone().multiplyScalar(2)); m.scale.setScalar(s); globe.add(m); return m;
  };
  const hubDot = new THREE.Mesh(new THREE.SphereGeometry(.022, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  hubDot.position.copy(hubP); globe.add(hubDot);
  const hubRings = [0, 1].map(() => mkRing(hubP, 0x7FA6FF, .01));

  /* liaisons : tube fin, tête lumineuse qui file puis traîne qui s'efface */
  const arcMat = () => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uHead: { value: 0 }, uTail: { value: 0 } },
    vertexShader: `varying float vU; void main(){ vU = uv.x; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `varying float vU; uniform float uHead; uniform float uTail;
      void main(){ if (vU > uHead || vU < uTail) discard; float k = (vU - uTail) / max(uHead - uTail, .001);
        float head = smoothstep(.0, .06, uHead - vU) ; float glow = exp(-(uHead - vU) * 18.);
        vec3 col = mix(vec3(.2,.4,1.), vec3(1.), glow); gl_FragColor = vec4(col * 1.3, (.35 + .65 * k) * (.8 + glow)); }`,
  });
  const arcs = DEST.map((d, i) => {
    const b = ll(...d, 1.004), a = hubP.clone();
    const dist = a.angleTo(b), lift = Math.min(.32, .08 + dist * .14);
    const pts = [];
    for (let k = 0; k <= 64; k++) {
      const u = k / 64, v = new THREE.Vector3().copy(a).lerp(b, u).normalize();
      v.multiplyScalar(1.004 + Math.sin(u * Math.PI) * lift); pts.push(v);
    }
    const mat = arcMat();
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 96, .0065, 6), mat);
    globe.add(tube);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(.013, 12, 8), new THREE.MeshBasicMaterial({ color: 0xBFD3FF, transparent: true }));
    dot.position.copy(b); globe.add(dot);
    const ring = mkRing(b, 0x4D82FF, .01);
    return { mat, dot, ring, t0: i * .55 + Math.random() * .3, dur: 1.3 + dist * .45 };
  });

  /* interaction : léger suivi de la souris */
  let mx = 0, my = 0, tx = 0, ty = 0;
  const onMove = e => { const r = el.getBoundingClientRect(); tx = ((e.clientX - r.left) / r.width - .5); ty = ((e.clientY - r.top) / r.height - .5); };
  addEventListener('pointermove', onMove, { passive: true });

  function resize() {
    const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix();
    pm.uniforms.uPx.value = renderer.getPixelRatio() * Math.min(1.4, w / 380);
  }
  const ro = new ResizeObserver(resize); ro.observe(el); resize();

  const CYCLE = 6.5;
  const t0 = performance.now() / 1000;
  /* orientation de départ : le studio face caméra, un peu à gauche */
  const baseRot = -Math.atan2(hubP.x, hubP.z) - .35;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const s = now / 1000 - t0;
    mx += (tx - mx) * .05; my += (ty - my) * .05;
    globe.rotation.y = baseRot + s * .06 + mx * .35;
    world.rotation.x = .5 + my * .2;
    pm.uniforms.uT.value = s;
    hubRings.forEach((r, i) => { const k = ((s + i * 1.1) % 2.2) / 2.2; r.scale.setScalar(.02 + k * .13); r.material.opacity = (1 - k) * .9; });
    arcs.forEach(a => {
      const T = ((s - a.t0) % CYCLE + CYCLE) % CYCLE, d = a.dur;
      const head = Math.min(1, T / d), tail = Math.max(0, Math.min(1, (T - d * .55) / d));
      const ease = x => 1 - Math.pow(1 - x, 2.2);
      a.mat.uniforms.uHead.value = ease(head); a.mat.uniforms.uTail.value = ease(tail);
      const hit = (T - d) / 1.4;
      a.ring.material.opacity = hit > 0 && hit < 1 ? (1 - hit) * .9 : 0; a.ring.scale.setScalar(.01 + Math.max(0, Math.min(1, hit)) * .09);
      a.dot.material.opacity = .35 + (hit > 0 && hit < 1.5 ? .65 * (1 - hit / 1.5) : 0);
    });
    renderer.render(scene, cam);
  }
  let raf = 0, running = false;
  const play = () => { if (!running) { running = true; raf = requestAnimationFrame(frame); } };
  const pause = () => { running = false; cancelAnimationFrame(raf); };
  const io = new IntersectionObserver(([e]) => (e.isIntersecting && !document.hidden ? play() : pause()));
  io.observe(el);
  const vis = () => (document.hidden ? pause() : play());
  document.addEventListener('visibilitychange', vis);
  return { destroy() { pause(); io.disconnect(); ro.disconnect(); removeEventListener('pointermove', onMove); document.removeEventListener('visibilitychange', vis); renderer.dispose(); el.innerHTML = ''; } };
}
