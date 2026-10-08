// The objects of the open map in the 3D view. Each object is a group with its
// position and rotation (SET_ENTITY_ROTATION order 2 = Euler 'ZXY'); inside it
// the model of the game when it is available (models.js), else a box of the
// model's size (from the catalog) or a 1 m cube.
import * as THREE from 'three';
import { DEG, EULER_ORDER } from '../math/gta.js';
import { api } from '../api.js';

const infoCache = new Map();  // model key -> Promise<archetype info | null>

export function modelInfo(model) {
  const key = String(model);
  if (!infoCache.has(key)) infoCache.set(key, api.model(key).catch(() => null));
  return infoCache.get(key);
}

// When the game finishes loading, models looked up before are looked up again.
export function forgetModelInfo() {
  infoCache.clear();
}

function colorOf(model) {
  let h = 0;
  for (const c of String(model)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.35, 0.55);
}

const SELECTED = new THREE.Color(0x20b8cd);

export class MapObjects {
  constructor(viewport, models = null) {
    this.viewport = viewport;
    this.models = models;  // optional: loads the game's models (glb)
    this.nodes = new Map();  // id -> THREE.Group
    this.selected = new Set();
    this.doc = null;
  }

  setDocument(doc) {
    for (const node of this.nodes.values()) this.dispose(node);
    this.nodes.clear();
    this.doc = doc;
    if (doc) this.sync(doc.list().map((o) => o.id));
  }

  // Brings the 3D objects in line with the map for these ids.
  sync(ids) {
    if (!this.doc) return;
    for (const id of ids) {
      const o = this.doc.get(id);
      let node = this.nodes.get(id);
      if (!o) {
        if (node) this.dispose(node);
        this.nodes.delete(id);
        continue;
      }
      if (!node || node.userData.model !== o.model) {
        if (node) this.dispose(node);
        node = this.build(o);
        this.nodes.set(id, node);
      }
      node.position.set(o.pos[0], o.pos[1], o.pos[2]);
      node.rotation.set(o.rot[0] * DEG, o.rot[1] * DEG, o.rot[2] * DEG, EULER_ORDER);
      node.visible = o.alpha > 0;
      this.paint(node);
    }
  }

  build(o) {
    const node = new THREE.Group();
    node.userData = { mapId: o.id, model: o.model };
    const mat = new THREE.MeshStandardMaterial({ color: colorOf(o.model), roughness: 0.8, transparent: true, opacity: 0.85 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    box.position.set(0, 0, 0.5);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color: 0x0b1416 }));
    box.add(edges);
    node.add(box);
    node.userData.box = box;
    node.userData.edges = edges;
    this.viewport.objects.add(node);

    // The real size of the model, then its geometry.
    modelInfo(o.model).then((info) => {
      if (!info || !this.nodes.has(o.id)) return;
      const [x0, y0, z0] = info.bbMin;
      const [x1, y1, z1] = info.bbMax;
      box.scale.set(Math.max(0.05, x1 - x0), Math.max(0.05, y1 - y0), Math.max(0.05, z1 - z0));
      box.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      node.userData.info = info;
      if (this.models) this.models.attach(node, info);
    });
    return node;
  }

  dispose(node) {
    this.viewport.objects.remove(node);
    node.traverse((c) => {
      if (c.geometry && !c.userData.shared) c.geometry.dispose();
      if (c.material && !c.userData.shared) [].concat(c.material).forEach((m) => m.dispose());
    });
  }

  setSelected(ids) {
    this.selected = new Set(ids);
    for (const node of this.nodes.values()) this.paint(node);
  }

  paint(node) {
    const on = this.selected.has(node.userData.mapId);
    node.userData.edges.material.color.set(on ? SELECTED : 0x0b1416);
    node.userData.edges.material.linewidth = on ? 2 : 1;
    node.userData.box.material.emissive = on ? SELECTED.clone().multiplyScalar(0.35) : new THREE.Color(0);
    // With the real model shown, the box is only an outline.
    node.userData.box.material.visible = !node.userData.hasModel;
    if (node.userData.hasModel) node.userData.edges.visible = on;
  }

  node(id) { return this.nodes.get(id); }
}
