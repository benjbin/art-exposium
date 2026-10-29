/* Neokrome — goutte de mercure liquide (three.js)
   mountMercury(el) : sphère chromée qui ondule et se déforme vers le pointeur */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const BLUE = 0x145CFF;

export function mountMercury(el) {
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) return null;
  const mobile = matchMedia('(max-width: 800px)').matches;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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

  const camera = new THREE.PerspectiveCamera(32, 1, .1, 50);
  camera.position.set(0, 0, 7);

  let geo = new THREE.IcosahedronGeometry(1.5, mobile ? 28 : 56);
  geo.deleteAttribute('normal'); geo.deleteAttribute('uv');
  geo = mergeVertices(geo);
  const pos = geo.attributes.position, base = pos.array.slice(), N = pos.count;
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xe6e8ee, metalness: 1, roughness: .05, clearcoat: 1, clearcoatRoughness: .04, envMapIntensity: 1.25 });
  const blob = new THREE.Mesh(geo, mat);
  scene.add(blob);
  const l1 = new THREE.PointLight(BLUE, 40, 0, 2); l1.position.set(-3, 2, 3);
  const l2 = new THREE.PointLight(0xffffff, 25, 0, 2); l2.position.set(3, -2, 3);
  scene.add(l1, l2);

  const ptr = new THREE.Vector3(0, 0, 1), ptrGoal = new THREE.Vector3(0, 0, 1);
  let pull = 0, pullGoal = 0;
  addEventListener('pointermove', e => {
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * 2 - 1, y = -((e.clientY - r.top) / r.height) * 2 + 1;
    ptrGoal.set(x * 1.6, y * 1.6, 1.2).normalize();
    pullGoal = Math.max(0, 1 - Math.hypot(x, y) / 1.6);
  });

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(el);
  function resize() {
    const w = el.clientWidth, h = el.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(el); resize();

  let t = 0, last = performance.now();
  const v = new THREE.Vector3();
  (function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    if (!visible || document.hidden) return;
    t += dt * (reduce ? .25 : 1);
    ptr.lerp(ptrGoal, 1 - Math.exp(-dt * 4)).normalize();
    pull += (pullGoal - pull) * (1 - Math.exp(-dt * 3));
    const a = pos.array;
    for (let i = 0; i < N; i++) {
      const x = base[i * 3], y = base[i * 3 + 1], z = base[i * 3 + 2];
      v.set(x, y, z).normalize();
      let n = Math.sin(v.x * 2.2 + t * 1.1) * Math.cos(v.y * 2.6 + t * .8) * .5
            + Math.sin(v.z * 3.4 + t * 1.5 + v.x * 1.7) * .28
            + Math.sin((v.x + v.y) * 5 + t * 2.1) * .07;
      const d = Math.max(0, v.dot(ptr));
      const r = 1 + n * .11 + Math.pow(d, 6) * .38 * pull;
      a[i * 3] = x * r; a[i * 3 + 1] = y * r; a[i * 3 + 2] = z * r;
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    blob.position.y = Math.sin(t * .8) * .06;
    renderer.render(scene, camera);
  })(last);
  return { el };
}
