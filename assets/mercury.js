/* Neokrome — goutte de mercure liquide (three.js)
   mountMercury(el) : sphère chromée qui ondule et se déforme vers le pointeur.
   La déformation est calculée sur le GPU (vertex shader) : position ET normale
   (différences finies dans le shader) → aucun travail par sommet sur le thread
   principal, le scroll reste fluide. Rendu uniquement quand la goutte est visible. */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const BLUE = 0x145CFF;

const DEFORM_GLSL = /* glsl */`
uniform float uTime;
uniform float uPull;
uniform vec3 uPtr;
uniform float uRadius;
// même formule que l'ancienne version CPU
vec3 mercP(vec3 v){
  float n = sin(v.x * 2.2 + uTime * 1.1) * cos(v.y * 2.6 + uTime * .8) * .5
          + sin(v.z * 3.4 + uTime * 1.5 + v.x * 1.7) * .28
          + sin((v.x + v.y) * 5.0 + uTime * 2.1) * .07;
  float d = max(0.0, dot(v, uPtr));
  float d2 = d * d;
  float r = 1.0 + n * .11 + d2 * d2 * d2 * .38 * uPull;
  return v * (uRadius * r);
}
`;

export function mountMercury(el) {
  if (!el) return null;
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) return null;
  const mobile = matchMedia('(max-width: 800px)').matches;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  // canvas très grand (jusqu'à ~900 px de côté) : on plafonne la densité de pixels
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, mobile ? 2 : 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.domElement.className = 'merc-canvas';
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // environnement : studio neutre + un grand panneau bleu de la marque qui se reflète dans le métal
  const env = new RoomEnvironment(renderer);
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(6, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color(BLUE).multiplyScalar(6) }));
  panel.position.set(-9, 2, 2); panel.rotation.y = Math.PI / 2; env.add(panel);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(env, 0.02).texture;
  pmrem.dispose();
  env.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });

  const camera = new THREE.PerspectiveCamera(32, 1, .1, 50);
  camera.position.set(0, 0, 7);

  // sphère unité : le shader la déforme et l'agrandit (uRadius)
  const geo = new THREE.IcosahedronGeometry(1, mobile ? 28 : 56);
  geo.deleteAttribute('uv');
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.5 * 1.6);

  const uniforms = {
    uTime: { value: 0 }, uPull: { value: 0 },
    uPtr: { value: new THREE.Vector3(0, 0, 1) }, uRadius: { value: 1.5 },
  };
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xe6e8ee, metalness: 1, roughness: .05, clearcoat: 1, clearcoatRoughness: .04, envMapIntensity: 1.25 });
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + DEFORM_GLSL)
      .replace('#include <beginnormal_vertex>', /* glsl */`
        vec3 mV = normalize(position);
        vec3 mT = normalize(cross(mV, abs(mV.y) < .99 ? vec3(0., 1., 0.) : vec3(1., 0., 0.)));
        vec3 mB = cross(mV, mT);
        vec3 mP0 = mercP(mV);
        const float mE = .012;
        vec3 mP1 = mercP(normalize(mV + mT * mE));
        vec3 mP2 = mercP(normalize(mV + mB * mE));
        vec3 objectNormal = normalize(cross(mP1 - mP0, mP2 - mP0));
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = mP0;');
  };
  mat.customProgramCacheKey = () => 'merc-gpu-v1';

  const blob = new THREE.Mesh(geo, mat);
  scene.add(blob);
  const l1 = new THREE.PointLight(BLUE, 40, 0, 2); l1.position.set(-3, 2, 3);
  const l2 = new THREE.PointLight(0xffffff, 25, 0, 2); l2.position.set(3, -2, 3);
  scene.add(l1, l2);

  // pointeur : on mémorise seulement les coordonnées, le calcul se fait dans la frame
  const ptr = uniforms.uPtr.value, ptrGoal = new THREE.Vector3(0, 0, 1);
  let pull = 0, pullGoal = 0, mx = null, my = null;
  addEventListener('pointermove', e => { mx = e.clientX; my = e.clientY; }, { passive: true });

  let visible = false, raf = 0;
  function resize() {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    if (!raf) renderer.render(scene, camera);
  }
  new ResizeObserver(resize).observe(el); resize();

  let t = reduce ? 1.3 : 0, last = 0;
  function frame(now) {
    raf = 0;
    if (!visible || document.hidden) return;
    // prefers-reduced-motion : goutte immobile (un seul rendu)
    if (!reduce) raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(.05, (now - last) / 1000) : 0; last = now;
    t += dt;
    if (mx !== null) {
      const r = el.getBoundingClientRect();
      const x = (mx - r.left) / r.width * 2 - 1, y = -((my - r.top) / r.height) * 2 + 1;
      ptrGoal.set(x * 1.6, y * 1.6, 1.2).normalize();
      pullGoal = Math.max(0, 1 - Math.hypot(x, y) / 1.6);
    }
    ptr.lerp(ptrGoal, 1 - Math.exp(-dt * 4)).normalize();
    pull += (pullGoal - pull) * (1 - Math.exp(-dt * 3));
    uniforms.uTime.value = t; uniforms.uPull.value = pull;
    blob.position.y = Math.sin(t * .8) * .06;
    renderer.render(scene, camera);
  }
  function start() { if (!raf && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } }
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; start(); }).observe(el);
  document.addEventListener('visibilitychange', start);
  // premier rendu immédiat (compile le shader avant le premier scroll)
  renderer.render(scene, camera);
  return { el };
}
