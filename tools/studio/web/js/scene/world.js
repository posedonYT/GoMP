// The world of GTA V around the camera: cells of 256 m (/api/world/cell) are
// loaded nearest first and dropped when far; their entities are drawn with
// InstancedMesh, one per part of each model (models with small textures),
// following the levels of detail (lod.js). Models are fetched a few at a time,
// the nearest first.
import * as THREE from 'three';
import { cellsAround } from '../math/gta.js';
import { visibleByArchetype } from './lod.js';

const CELL = 256;
const LOAD_RADIUS = 700;   // cells this close are loaded
const KEEP_RADIUS = 1100;  // cells farther are dropped
const TEXTURE = 128;       // texture size of world models
const CELLS_AT_ONCE = 3;
const MODELS_AT_ONCE = 6;
const REFRESH_MS = 300;

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();

export class World extends EventTarget {
  constructor(viewport, models) {
    super();
    this.vp = viewport;
    this.models = models;
    this.root = viewport.world;
    this.cells = new Map();     // "x,y" -> { x, y, entities | null }
    this.archetypes = new Map(); // hash -> { state: 'queued'|'loading'|'ready'|'none', parts, nearest }
    this.cellsLoading = 0;
    this.modelsLoading = 0;
    this.enabled = true;
    this.lastRefresh = 0;
    // On a timer, not per frame: loading must not wait for slow frames.
    setInterval(() => this.tick(), 100);
  }

  setEnabled(on) {
    this.enabled = on;
    this.root.visible = on;
  }

  get stats() {
    let entities = 0;
    for (const c of this.cells.values()) entities += c.entities ? c.entities.length : 0;
    let ready = 0;
    for (const a of this.archetypes.values()) if (a.state === 'ready') ready++;
    return { cells: this.cells.size, entities, models: ready, loading: this.modelsLoading + this.cellsLoading };
  }

  tick() {
    if (!this.enabled || !this.ready) return;
    const now = performance.now();
    if (now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;
    const cam = this.vp.camera.position;
    this.planCells(cam);
    this.refresh(cam);
  }

  planCells(cam) {
    const wanted = cellsAround(cam.x, cam.y, LOAD_RADIUS, CELL);
    for (const c of wanted) {
      if (this.cellsLoading >= CELLS_AT_ONCE) break;
      const key = `${c.x},${c.y}`;
      if (this.cells.has(key)) continue;
      const cell = { x: c.x, y: c.y, entities: null };
      this.cells.set(key, cell);
      this.cellsLoading++;
      fetch(`/api/world/cell?x=${c.x}&y=${c.y}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((ents) => { cell.entities = ents; })
        .catch(() => { cell.entities = []; })
        .finally(() => { this.cellsLoading--; this.lastRefresh = 0; });
    }
    for (const [key, c] of this.cells) {
      const cx = (c.x + 0.5) * CELL;
      const cy = (c.y + 0.5) * CELL;
      if (Math.hypot(cx - cam.x, cy - cam.y) > KEEP_RADIUS && c.entities) this.cells.delete(key);
    }
  }

  // Instances of every visible entity; models that are needed and missing are fetched.
  refresh(cam) {
    const all = [];
    for (const c of this.cells.values()) if (c.entities) for (const e of c.entities) all.push(e);
    const groups = visibleByArchetype(all, cam.x, cam.y, cam.z);
    for (const [hash, a] of this.archetypes) if (!groups.has(hash) && a.state === 'ready') this.setInstances(a, []);
    for (const [hash, g] of groups) {
      let a = this.archetypes.get(hash);
      if (!a) this.archetypes.set(hash, (a = { hash, state: 'queued', parts: null, nearest: g.nearest }));
      a.nearest = g.nearest;
      if (a.state === 'ready') this.setInstances(a, g.entities);
    }
    this.loadModels();
    this.dispatchEvent(new CustomEvent('stats', { detail: this.stats }));
  }

  loadModels() {
    if (this.modelsLoading >= MODELS_AT_ONCE) return;
    const queued = [...this.archetypes.values()].filter((a) => a.state === 'queued').sort((a, b) => a.nearest - b.nearest);
    for (const a of queued) {
      if (this.modelsLoading >= MODELS_AT_ONCE) break;
      a.state = 'loading';
      this.modelsLoading++;
      this.models.load(a.hash, 'high', TEXTURE).then((scene) => {
        if (!scene) {
          a.state = 'none';
          return;
        }
        // The parts of the model with their place in it: one InstancedMesh each.
        scene.updateMatrixWorld(true);
        a.parts = [];
        scene.traverse((m) => {
          if (m.isMesh) a.parts.push({ geometry: m.geometry, material: m.material, local: m.matrixWorld.clone(), mesh: null });
        });
        a.state = 'ready';
      }).finally(() => {
        this.modelsLoading--;
        this.lastRefresh = 0;
      });
    }
  }

  setInstances(a, entities) {
    for (const part of a.parts) {
      if (!part.mesh || part.mesh.instanceMatrix.count < entities.length) {
        if (part.mesh) {
          this.root.remove(part.mesh);
          part.mesh.dispose();
        }
        if (!entities.length) {
          part.mesh = null;
          continue;
        }
        part.mesh = new THREE.InstancedMesh(part.geometry, part.material, Math.ceil(entities.length * 1.5) + 4);
        part.mesh.frustumCulled = false;  // instances spread over the whole cell
        part.mesh.userData.worldArchetype = a.hash;
        this.root.add(part.mesh);
      }
      part.mesh.count = entities.length;
      entities.forEach((e, i) => {
        tmpPos.set(e.p[0], e.p[1], e.p[2]);
        tmpQuat.set(e.q[0], e.q[1], e.q[2], e.q[3]);
        if (e.s) tmpScale.set(e.s[0], e.s[1], e.s[2]);
        else tmpScale.set(1, 1, 1);
        tmpMatrix.compose(tmpPos, tmpQuat, tmpScale).multiply(part.local);
        part.mesh.setMatrixAt(i, tmpMatrix);
      });
      part.mesh.instanceMatrix.needsUpdate = true;
      part.mesh.computeBoundingSphere();
    }
  }

  clear() {
    for (const a of this.archetypes.values()) for (const p of a.parts || []) if (p.mesh) { this.root.remove(p.mesh); p.mesh.dispose(); }
    this.archetypes.clear();
    this.cells.clear();
  }
}
