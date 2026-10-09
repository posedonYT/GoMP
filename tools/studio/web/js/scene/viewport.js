// The 3D view: the scene in GTA V's own axes (Z up, metres), the camera with
// orbit (right button), pan (middle), zoom (wheel) and flight (WASD, Q/E,
// Shift faster), the gizmo, picking objects and finding the point under the
// mouse (on the world, or on the plane at the camera target's height).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const CLICK_PIXELS = 5;

export class Viewport extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);
    this.renderer.domElement.tabIndex = 0;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fb6c8);
    this.scene.fog = new THREE.Fog(0x9fb6c8, 1500, 6000);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.3, 8000);
    this.camera.up.set(0, 0, 1);

    const hemi = new THREE.HemisphereLight(0xdfeeff, 0x4a4436, 1.4);
    hemi.position.set(0, 0, 1);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.position.set(0.4, -0.6, 1);
    this.scene.add(this.sun);

    // A grid on the ground plane, following the camera target.
    this.grid = new THREE.GridHelper(1000, 100, 0x31555c, 0x3a4446);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.scene.add(this.grid);

    // Groups: the world around (streamed), the objects of the map, helpers.
    this.world = new THREE.Group();
    this.objects = new THREE.Group();
    this.scene.add(this.world, this.objects);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = Math.PI * 0.98;

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.9);
    this.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      this.dispatchEvent(new CustomEvent(e.value ? 'gizmostart' : 'gizmoend'));
    });
    this.gizmo.addEventListener('objectChange', () => this.dispatchEvent(new CustomEvent('gizmochange')));

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.keys = new Set();
    this.speed = 25;
    this.lastTime = performance.now();
    this.onFrame = [];

    this.lookAt(new THREE.Vector3(195, -930, 30), 120, 0);  // Legion Square, from the south
    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Looks at a point from a distance (behind and above it, keeping the direction).
  lookAt(point, distance = 40, heading = null) {
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    if (dir.lengthSq() < 1e-6 || heading !== null) {
      const h = (heading || 0) * Math.PI / 180;
      dir.set(Math.sin(h), -Math.cos(h), 0.6);  // behind the heading
    }
    dir.normalize().multiplyScalar(distance);
    this.controls.target.copy(point);
    this.camera.position.copy(point).add(dir);
    this.controls.update();
  }

  get target() { return this.controls.target; }

  bindInput() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => {
      el.focus();
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > CLICK_PIXELS || this.gizmo.dragging || this.gizmo.axis) return;
      this.setPointer(e);
      const hit = this.pickObject();
      this.dispatchEvent(new CustomEvent('pick', { detail: { id: hit, shift: e.shiftKey, ctrl: e.ctrlKey, point: this.groundPoint() } }));
    });
    // The point under the mouse at most every 40 ms: rays against the world are not free.
    let lastHover = 0;
    el.addEventListener('pointermove', (e) => {
      this.setPointer(e);
      const now = performance.now();
      if (now - lastHover < 40) return;
      lastHover = now;
      this.dispatchEvent(new CustomEvent('hover', { detail: { point: this.groundPoint() } }));
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      this.keys.add(e.code);
    });
    el.addEventListener('keyup', (e) => this.keys.delete(e.code));
    el.addEventListener('blur', () => this.keys.clear());
  }

  setPointer(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  // The id of the map object under the mouse, or null.
  pickObject() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.objects.children, true);
    for (const h of hits) {
      for (let o = h.object; o; o = o.parent) if (o.userData.mapId) return o.userData.mapId;
    }
    return null;
  }

  // The point of the world under the mouse; without world geometry there, the
  // plane at the height of the camera target.
  groundPoint() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.world.children, true);
    if (hits.length) return hits[0].point.clone();
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.controls.target.z);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, p) ? p : null;
  }

  // Height of the world under a point (a ray from above), or null.
  groundAt(x, y, fromZ = 3000) {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, y, fromZ), new THREE.Vector3(0, 0, -1));
    const hits = ray.intersectObjects(this.world.children, true);
    return hits.length ? hits[0].point.z : null;
  }

  // WASD/QE flight: the camera and its target move together.
  fly(dt) {
    if (!this.keys.size || document.activeElement !== this.renderer.domElement) return;
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    fwd.z = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 1, 0);
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 0, 1));
    const v = new THREE.Vector3();
    if (this.keys.has('KeyW')) v.add(fwd);
    if (this.keys.has('KeyS')) v.sub(fwd);
    if (this.keys.has('KeyD')) v.add(right);
    if (this.keys.has('KeyA')) v.sub(right);
    if (this.keys.has('KeyE')) v.z += 1;
    if (this.keys.has('KeyQ')) v.z -= 1;
    if (v.lengthSq() === 0) return;
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 5 : 1;
    // Faster when far from the target: flying over the city should not take long.
    const dist = this.camera.position.distanceTo(this.controls.target);
    v.normalize().multiplyScalar(Math.max(this.speed, dist * 0.8) * fast * dt);
    this.camera.position.add(v);
    this.controls.target.add(v);
  }

  frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.fly(dt);
    this.controls.update();
    const t = this.controls.target;
    this.grid.position.set(Math.round(t.x / 10) * 10, Math.round(t.y / 10) * 10, t.z - 0.02);
    for (const fn of this.onFrame) fn(dt);
    this.renderer.render(this.other || this.scene, this.camera);
  }

  // Another scene in the view (the vehicle showroom); null: back to the map, where the camera was.
  showScene(scene, target, distance) {
    if (scene && !this.other) this.saved = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
    this.other = scene;
    this.grid.visible = !scene;
    if (scene) {
      this.gizmo.detach();
      this.controls.target.copy(target);
      this.camera.position.set(target.x + distance * 0.75, target.y - distance, target.z + distance * 0.45);
      this.controls.update();
    } else if (this.saved) {
      this.camera.position.copy(this.saved.pos);
      this.controls.target.copy(this.saved.target);
      this.controls.update();
    }
  }
}
