// The homepage centerpiece: a generative quill made of light. A curved shaft, a few hundred barbs that sway like they
// are under water, and ink that gathers at the nib and falls. Three.js, no textures, no models.
import * as THREE from "/vendor/three.module.min.js";

export function mountQuill(canvas, { reduced = false, manual = false } = {}) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" }); }
  catch { return null; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0.2, 9.5);

  const quill = new THREE.Group();
  quill.rotation.z = -0.62;
  scene.add(quill);

  // shaft: from nib (y=-3) curving up to the tip (y=3.2)
  const shaft = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -3.1, 0), new THREE.Vector3(0.05, -1.6, 0.05), new THREE.Vector3(0.2, 0.4, 0),
    new THREE.Vector3(0.45, 2.1, -0.08), new THREE.Vector3(0.85, 3.3, -0.15),
  ]);
  const shaftGeo = new THREE.TubeGeometry(shaft, 160, 0.028, 8, false);
  quill.add(new THREE.Mesh(shaftGeo, new THREE.MeshBasicMaterial({ color: 0xf3efe6, transparent: true, opacity: 0.95 })));

  // barbs
  const BARBS = 170, SEG = 18;
  const pts = new Float32Array(BARBS * 2 * SEG * 2 * 3);
  const cols = new Float32Array(pts.length);
  const base = []; // per barb: t, side, length, phase
  for (let i = 0; i < BARBS; i++) {
    const t = 0.24 + (i / BARBS) * 0.74;
    for (const side of [-1, 1]) base.push({ t, side, len: Math.sin(Math.PI * ((t - 0.24) / 0.74)) ** 0.65 * 1.15 + 0.06, phase: Math.random() * Math.PI * 2 });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pts, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  quill.add(lines);

  const teal = new THREE.Color(0x5eead4), deep = new THREE.Color(0x0e7490), nib = new THREE.Color(0xfb923c), white = new THREE.Color(0xf3efe6);
  const tmp = new THREE.Color(), P = new THREE.Vector3(), T = new THREE.Vector3(), N = new THREE.Vector3();

  function updateBarbs(time) {
    let k = 0;
    for (const b of base) {
      shaft.getPointAt(b.t, P);
      shaft.getTangentAt(b.t, T);
      N.set(-T.y, T.x, 0).normalize().multiplyScalar(b.side);
      const sway = Math.sin(time * 0.9 + b.phase + b.t * 6) * 0.06 + Math.sin(time * 0.37 + b.t * 3) * 0.05;
      let px = P.x, py = P.y, pz = P.z;
      for (let s = 1; s <= SEG; s++) {
        const u = s / SEG;
        const reach = b.len * u;
        // barbs sweep toward the tip and curl slightly out of plane
        const x = P.x + N.x * reach + T.x * reach * 0.55 + Math.sin(u * 3 + time + b.phase) * 0.02;
        const y = P.y + N.y * reach + T.y * reach * 0.55 + sway * u * u;
        const z = P.z + Math.sin(u * Math.PI) * 0.18 * b.side + Math.cos(time * 0.6 + b.phase) * 0.08 * u;
        const c0 = colorAt(b.t, u - 1 / SEG), c1 = colorAt(b.t, u);
        pts.set([px, py, pz, x, y, z], k * 6);
        cols.set([c0.r, c0.g, c0.b, c1.r, c1.g, c1.b], k * 6);
        k++;
        px = x; py = y; pz = z;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }
  function colorAt(t, u) {
    tmp.copy(deep).lerp(teal, Math.min(1, t * 1.2)).lerp(white, Math.max(0, u - 0.75) * 1.2);
    const fade = 0.25 + 0.75 * (1 - u * 0.65);
    return { r: tmp.r * fade, g: tmp.g * fade, b: tmp.b * fade };
  }

  // nib glow + ink drops
  const nibPoint = shaft.getPointAt(0);
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 16), new THREE.MeshBasicMaterial({ color: nib }));
  glow.position.copy(nibPoint);
  quill.add(glow);
  const DROPS = 90;
  const dropPos = new Float32Array(DROPS * 3), dropState = [];
  for (let i = 0; i < DROPS; i++) dropState.push({ y: -Math.random() * 3, v: 0.4 + Math.random() * 0.8, x: (Math.random() - 0.5) * 0.2, z: (Math.random() - 0.5) * 0.2 });
  const dropGeo = new THREE.BufferGeometry();
  dropGeo.setAttribute("position", new THREE.BufferAttribute(dropPos, 3));
  const drops = new THREE.Points(dropGeo, new THREE.PointsMaterial({ color: nib, size: 0.045, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(drops);

  // a signature line the ink lands on
  const sigPts = [];
  for (let i = 0; i <= 140; i++) { const x = -0.2 + i * 0.022; sigPts.push(new THREE.Vector3(x, Math.sin(x * 3.4) * 0.07 + Math.sin(x * 8.1) * 0.025 - x * 0.04, 0)); }
  const sig = new THREE.Line(new THREE.BufferGeometry().setFromPoints(sigPts), new THREE.LineBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.0 }));
  scene.add(sig);

  let w = 0, h = 0, baseScale = 0.7, baseY = 0;
  function resize() {
    const r = canvas.getBoundingClientRect();
    if (r.width === w && r.height === h) return;
    w = r.width; h = r.height;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    // fit the whole quill (nib, ink and signature included) to the canvas, whatever its shape
    baseScale = Math.min(0.7, camera.aspect * 0.62);
    quill.scale.setScalar(baseScale);
    quill.position.x = w < 700 ? 0.05 : 0.2;
    baseY = w < 700 ? 0.55 : 0.62;
  }

  let mx = 0, my = 0, tx = 0, ty = 0;
  addEventListener("pointermove", (e) => { tx = (e.clientX / innerWidth - 0.5) * 2; ty = (e.clientY / innerHeight - 0.5) * 2; }, { passive: true });

  const world = new THREE.Vector3();
  let raf = 0, visible = true, t0 = performance.now();
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible && !raf) loop(); }).observe(canvas);

  function loop() {
    raf = 0;
    if (!visible || manual) return;
    draw(reduced ? 1.2 : (performance.now() - t0) / 1000);
    if (!reduced) raf = requestAnimationFrame(loop);
  }

  // draw(time): one frame at a given time in seconds. Used by the loop, and directly when rendering video frames.
  function draw(time) {
    resize();
    mx += (tx - mx) * 0.04; my += (ty - my) * 0.04;
    quill.rotation.y = Math.sin(time * 0.25) * 0.5 + mx * 0.35;
    quill.rotation.x = Math.sin(time * 0.18) * 0.12 + my * 0.15;
    quill.position.y = baseY + Math.sin(time * 0.6) * 0.06;
    updateBarbs(time);
    glow.scale.setScalar(1 + Math.sin(time * 3) * 0.25);

    glow.getWorldPosition(world);
    for (let i = 0; i < DROPS; i++) {
      const d = dropState[i];
      if (!reduced) d.y -= d.v * (manual ? 1 / 30 : 0.016);
      if (d.y < -0.62) { d.y = 0; d.v = 0.4 + Math.random() * 0.8; d.x = (Math.random() - 0.5) * 0.25; }
      dropPos[i * 3] = world.x + d.x * (1 - d.y);
      dropPos[i * 3 + 1] = world.y + d.y;
      dropPos[i * 3 + 2] = world.z + d.z;
    }
    dropGeo.attributes.position.needsUpdate = true;
    sig.position.set(world.x - 0.05, world.y - 0.66, world.z);
    sig.material.opacity = Math.min(0.6, sig.material.opacity + 0.004);

    renderer.render(scene, camera);
  }
  if (manual) draw(0); else loop();
  return { stop: () => cancelAnimationFrame(raf), draw };
}
