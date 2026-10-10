// The world of GTA V around the camera: cells of 256 m (/api/world/cell) are
// loaded nearest first and dropped when far; their entities are drawn with
// InstancedMesh, one per part of each model (models with small textures),
// following the levels of detail (lod.js). Models are fetched a few at a time,
// the nearest first.
import * as THREE from 'three';
import { cellsAround } from '../math/gta.js';
import { visibleByArchetype, isDetailed } from './lod.js';
import { CELLS_AT_ONCE, modelSlots, nextModels, streaming } from './stream.js';

const CELL = 256;
const LOAD_RADIUS = 700;   // cells this close are loaded
const KEEP_RADIUS = 1100;  // cells farther are dropped
const TEXTURE = 128;       // texture size of world models
const REFRESH_MS = 300;
const MOVE_EPS = 2;        // metres the camera must move before the visible set is worked out again
const CELLS_KEPT = 48;     // dropped cells kept in memory: coming back does not fetch them again

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();

// The parts of a model with their place in it: one InstancedMesh each.
function partsOf(scene) {
  scene.updateMatrixWorld(true);
  const parts = [];
  scene.traverse((m) => {
    if (m.isMesh) parts.push({ geometry: m.geometry, material: m.material, local: m.matrixWorld.clone(), mesh: null });
  });
  return parts;
}

function writeInstances(mesh, local, entities) {
  entities.forEach((e, i) => {
    tmpPos.set(e.p[0], e.p[1], e.p[2]);
    tmpQuat.set(e.q[0], e.q[1], e.q[2], e.q[3]);
    if (e.s) tmpScale.set(e.s[0], e.s[1], e.s[2]);
    else tmpScale.set(1, 1, 1);
    tmpMatrix.compose(tmpPos, tmpQuat, tmpScale).multiply(local);
    mesh.setMatrixAt(i, tmpMatrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
}

export class World extends EventTarget {
  constructor(viewport, models) {
    super();
    this.vp = viewport;
    this.models = models;
    this.root = viewport.world;
    this.cells = new Map();     // "x,y" -> { x, y, entities | null }
    this.kept = new Map();      // cells dropped for distance, newest last
    this.dirty = true;          // something changed (cells, models, switch) since the last refresh
    this.visible = new Set();   // archetypes visible from the camera at the last refresh
    this.lastCam = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.archetypes = new Map(); // hash -> { state: 'queued'|'loading'|'ready'|'none', parts, nearest }
    this.cellsLoading = 0;
    this.modelsLoading = 0;
    this.enabled = true;
    this.lastRefresh = 0;
    this.interiorGroup = null;
    this.interiorSeq = 0;
    // On a timer, not per frame: loading must not wait for slow frames.
    setInterval(() => this.tick(), 100);
  }

  setEnabled(on) {
    this.enabled = on;
    this.root.visible = on;
    this.touch();
  }

  // The next tick works the world out again; `lastRefresh` is reset so it does not wait.
  touch() {
    this.dirty = true;
    this.lastRefresh = 0;
    this.vp.invalidate?.();
  }

  get stats() {
    let entities = 0;
    for (const c of this.cells.values()) entities += c.entities ? c.entities.length : 0;
    let ready = 0;
    for (const a of this.archetypes.values()) if (a.state === 'ready') ready++;
    return { cells: this.cells.size, entities, models: ready, loading: this.modelsLoading + this.cellsLoading };
  }

  tick() {
    if (!streaming({ enabled: this.enabled, ready: this.ready, otherScene: this.vp.other })) return;
    const now = performance.now();
    if (now - this.lastRefresh < REFRESH_MS) return;
    const cam = this.vp.camera.position;
    // Nothing new to load and the camera has hardly moved: the same entities are
    // visible, so the instance buffers stay as they are and nothing is redrawn.
    if (!this.dirty && cam.distanceTo(this.lastCam) < MOVE_EPS) return;
    this.lastRefresh = now;
    this.dirty = false;
    this.lastCam.copy(cam);
    this.planCells(cam);
    this.refresh(cam);
  }

  planCells(cam) {
    const wanted = cellsAround(cam.x, cam.y, LOAD_RADIUS, CELL);
    for (const c of wanted) {
      if (this.cellsLoading >= CELLS_AT_ONCE) break;
      const key = `${c.x},${c.y}`;
      if (this.cells.has(key)) continue;
      const again = this.kept.get(key);
      if (again) {
        this.kept.delete(key);
        this.cells.set(key, again);
        continue;
      }
      const cell = { x: c.x, y: c.y, entities: null };
      this.cells.set(key, cell);
      this.cellsLoading++;
      fetch(`/api/world/cell?x=${c.x}&y=${c.y}`, { priority: 'low' })
        .then((r) => (r.ok ? r.json() : []))
        .then((ents) => { cell.entities = ents; })
        .catch(() => { cell.entities = []; })
        .finally(() => { this.cellsLoading--; this.touch(); });
    }
    for (const [key, c] of this.cells) {
      const cx = (c.x + 0.5) * CELL;
      const cy = (c.y + 0.5) * CELL;
      if (Math.hypot(cx - cam.x, cy - cam.y) > KEEP_RADIUS && c.entities) {
        this.cells.delete(key);
        this.kept.set(key, c);
        if (this.kept.size > CELLS_KEPT) this.kept.delete(this.kept.keys().next().value);
      }
    }
  }

  // Instances of every visible entity; models that are needed and missing are fetched.
  refresh(cam) {
    const all = [];
    for (const c of this.cells.values()) if (c.entities) for (const e of c.entities) all.push(e);
    const groups = visibleByArchetype(all, cam.x, cam.y, cam.z);
    this.visible = new Set(groups.keys());
    this.groups = groups;
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
    for (const a of nextModels(this.archetypes, this.visible, modelSlots(this.cellsLoading, this.modelsLoading))) {
      a.state = 'loading';
      this.modelsLoading++;
      this.models.load(a.hash, 'high', TEXTURE, true).then((scene) => {
        if (!scene) {
          a.state = 'none';
          return;
        }
        a.parts = partsOf(scene);
        a.state = 'ready';
      }).finally(() => {
        this.modelsLoading--;
        // The camera has not moved: no need to work the world out again. The model
        // takes its place at once and the next one is asked for right away (waiting
        // for the next refresh capped loading at a few models per tick).
        const g = this.groups && this.groups.get(a.hash);
        if (a.state === 'ready' && g) this.setInstances(a, g.entities);
        this.loadModels();
        this.statsSoon();
      });
    }
  }

  // The status line follows loading without an event per model.
  statsSoon() {
    if (this.statsTimer) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      this.dispatchEvent(new CustomEvent('stats', { detail: this.stats }));
    }, 250);
  }

  setInstances(a, entities) {
    // The same entities as last time: the buffers are right already.
    const prev = a.inst;
    if (prev && prev.length === entities.length) {
      let same = true;
      for (let i = 0; i < prev.length && same; i++) same = prev[i] === entities[i];
      if (same) return;
    }
    a.inst = entities;
    this.vp.invalidate?.();
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
      writeInstances(part.mesh, part.local, entities);
    }
  }

  // An interior (entities of /api/interiors/geometry, world space) drawn in
  // its own group, whatever the distance: it lies far from where the camera
  // streams the outdoor world, and only its highest level of detail is drawn.
  async showInterior(entities) {
    this.clearInterior();  // also invalidates a load still running
    const seq = this.interiorSeq;
    const groups = new Map();
    for (const e of entities) {
      if (e.l !== undefined && !isDetailed(e)) continue;
      if (!groups.has(e.a)) groups.set(e.a, []);
      groups.get(e.a).push(e);
    }
    const group = new THREE.Group();
    this.interiorGroup = group;
    this.vp.scene.add(group);
    this.vp.groundExtra = [group];
    await Promise.all([...groups].map(async ([hash, list]) => {
      const scene = await this.models.load(hash, 'high', TEXTURE);
      if (!scene || seq !== this.interiorSeq) return;
      for (const part of partsOf(scene)) {
        part.mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        part.mesh.frustumCulled = false;
        writeInstances(part.mesh, part.local, list);
        group.add(part.mesh);
      }
    }));
  }

  clearInterior() {
    this.interiorSeq++;  // a load still running must not add to the group any more
    if (!this.interiorGroup) return;
    // Geometry and materials are shared with the model cache: only the instance buffers go.
    for (const m of this.interiorGroup.children) m.dispose();
    this.vp.scene.remove(this.interiorGroup);
    this.vp.groundExtra = [];
    this.interiorGroup = null;
  }

  clear() {
    for (const a of this.archetypes.values()) for (const p of a.parts || []) if (p.mesh) { this.root.remove(p.mesh); p.mesh.dispose(); }
    this.archetypes.clear();
    this.cells.clear();
    this.kept.clear();
    this.touch();
  }
}
