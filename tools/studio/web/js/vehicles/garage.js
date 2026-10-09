// The vehicle showroom: its own scene (the vehicle at the origin on a turntable
// floor) drawn in the Studio's view instead of the map. The model comes from
// /api/vehicles/<pack>/<model>/model.glb with its bones as nodes: doors, bonnet
// and boot can be opened; materials marked as paint take the chosen colours.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const OPENERS = {
  door_dside_f: { axis: 'z', angle: -65 },
  door_dside_r: { axis: 'z', angle: -65 },
  door_pside_f: { axis: 'z', angle: 65 },
  door_pside_r: { axis: 'z', angle: 65 },
  bonnet: { axis: 'x', angle: 45 },
  boot: { axis: 'x', angle: -55 },
};

export const PART_GROUPS = {
  doors: ['door_dside_f', 'door_dside_r', 'door_pside_f', 'door_pside_r'],
  bonnet: ['bonnet'],
  boot: ['boot'],
};

export class Garage {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x202424);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x303030, 1.6);
    hemi.position.set(0, 0, 1);
    const key = new THREE.DirectionalLight(0xffffff, 2);
    key.position.set(3, -4, 6);
    const fill = new THREE.DirectionalLight(0xbfd8ff, 0.8);
    fill.position.set(-4, 3, 2);
    this.scene.add(hemi, key, fill);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(4.5, 64), new THREE.MeshStandardMaterial({ color: 0x2d3232, roughness: 0.95 }));
    floor.position.z = -0.01;
    this.scene.add(floor);
    const ring = new THREE.Mesh(new THREE.RingGeometry(4.45, 4.55, 64), new THREE.MeshBasicMaterial({ color: 0x20b8cd }));
    this.scene.add(ring);
    this.loader = new GLTFLoader();
    this.model = null;
    this.open = new Set();
  }

  async load(pack, model, tex = 1024) {
    const res = await fetch(`/api/vehicles/${encodeURIComponent(pack)}/${encodeURIComponent(model)}/model.glb?tex=${tex}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const gltf = await this.loader.parseAsync(await res.arrayBuffer(), '');
    if (this.model) this.scene.remove(this.model);
    this.model = gltf.scene;
    // Standing on the floor: the lowest point at z = 0.
    const box = new THREE.Box3().setFromObject(this.model);
    this.model.position.z -= box.min.z;
    this.scene.add(this.model);
    this.parts = {};
    this.paints = [];
    this.model.traverse((o) => {
      if (OPENERS[o.name] && !this.parts[o.name]) this.parts[o.name] = { node: o, base: o.quaternion.clone() };
      if (o.isMesh) {
        o.material.roughness = 0.6;
        o.material.metalness = 0;
        if (o.material.userData && o.material.userData.paint) {
          o.material.metalness = 0.35;
          o.material.roughness = 0.35;
          this.paints.push(o.material);
        }
      }
    });
    this.open.clear();
    this.tried = new Map();  // mod type -> { name, node, hidden, paints }
    this.size = box.getSize(new THREE.Vector3());
    return this.size;
  }

  // Tries a mod part on (one per type): its model on the vehicle, the bones it
  // replaces (turnOffBones) hidden. Again with the same part: taken off.
  async tryPart(pack, model, mod) {
    const type = mod.type || mod.modelName;
    if (!this.model) throw new Error('модель машины не загружена');
    const cur = this.tried.get(type);
    if (cur) {
      this.model.remove(cur.node);
      for (const n of cur.hidden) n.visible = true;
      this.paints = this.paints.filter((m) => !cur.paints.includes(m));
      this.tried.delete(type);
      if (cur.name === mod.modelName) return false;
    }
    const res = await fetch(`/api/vehicles/${encodeURIComponent(pack)}/${encodeURIComponent(model)}/part/${encodeURIComponent(mod.modelName)}.glb`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const gltf = await this.loader.parseAsync(await res.arrayBuffer(), '');
    const hidden = [];
    for (const bone of mod.turnOff || []) {
      this.model.traverse((o) => {
        if (o.name === bone && o.visible) {
          o.visible = false;
          hidden.push(o);
        }
      });
    }
    const paints = [];
    gltf.scene.traverse((o) => {
      if (o.isMesh && o.material.userData && o.material.userData.paint) paints.push(o.material);
    });
    this.paints.push(...paints);
    this.model.add(gltf.scene);
    this.tried.set(type, { name: mod.modelName, node: gltf.scene, hidden, paints });
    return true;
  }

  isTried(mod) {
    const cur = this.tried && this.tried.get(mod.type || mod.modelName);
    return !!cur && cur.name === mod.modelName;
  }

  // Paint: [primary, secondary] as CSS colours; paint 2 is secondary, the rest primary.
  setPaint(primary, secondary) {
    for (const m of this.paints) m.color.set(m.userData.paint === 2 ? secondary : primary);
  }

  toggle(group) {
    const names = PART_GROUPS[group] || [];
    const opening = !names.some((n) => this.open.has(n));
    for (const n of names) {
      const p = this.parts && this.parts[n];
      if (!p) continue;
      const o = OPENERS[n];
      const q = p.base.clone();
      if (opening) {
        const axis = o.axis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        q.multiply(new THREE.Quaternion().setFromAxisAngle(axis, (o.angle * Math.PI) / 180));
        this.open.add(n);
      } else {
        this.open.delete(n);
      }
      p.node.quaternion.copy(q);
    }
    return opening;
  }

  has(group) {
    return (PART_GROUPS[group] || []).some((n) => this.parts && this.parts[n]);
  }
}
