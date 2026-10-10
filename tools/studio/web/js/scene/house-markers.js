// What the houses editor draws over the world: a marker per house door (a
// translucent cylinder and a flat arrow showing where the player faces when
// coming out), a purple car box per garage point (real size, with an arrow for the way the
// car faces on leaving the garage) and, for the interior or garage being edited, the spawn
// point and the exit marker (a garage also draws one car box per slot). Every part is
// drawn twice: normally (hidden by walls, so a door behind a
// building is not mistaken for one on its roof) and as a faint ghost that ignores depth (so
// it stays findable and clickable). Markers grow with the distance to the camera.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const COLOR = { sale: 0x3ecf6e, owned: 0x3b82f6, selected: 0xffffff, spawn: 0x3b82f6, exit: 0xf59e0b, entrance: 0x22d3a0, inner: 0x8a94a6, garage: 0xa855f7 };
// Doors are given at about chest height: the marker stands on the ground below.
const DOOR_DROP = 1;

const GHOST = 0.2;  // opacity of the "seen through walls" pass

function material(color, opacity, depthTest = false) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest, depthWrite: false, side: THREE.DoubleSide });
}

// A mesh drawn twice (a group): the normal pass tested against depth and the ghost behind it.
function twice(geometry, color, opacity) {
  const g = new THREE.Group();
  const ghost = new THREE.Mesh(geometry, material(color, GHOST, false));
  const solid = new THREE.Mesh(geometry, material(color, opacity, true));
  ghost.renderOrder = 9;
  solid.renderOrder = 10;
  g.add(ghost, solid);
  return g;
}

// Z-up cylinder standing on z = 0.
function cylinder(radius, height, color, opacity) {
  const g = new THREE.CylinderGeometry(radius, radius, height, 24);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, height / 2);
  return twice(g, color, opacity);
}

// A flat arrow on the ground pointing along +Y (rotate about Z for a heading).
function arrow(color, opacity) {
  const s = new THREE.Shape();
  s.moveTo(-0.15, 0.7);
  s.lineTo(0.15, 0.7);
  s.lineTo(0.15, 1.9);
  s.lineTo(0.45, 1.9);
  s.lineTo(0, 2.6);
  s.lineTo(-0.45, 1.9);
  s.lineTo(-0.15, 1.9);
  const m = twice(new THREE.ShapeGeometry(s), color, opacity);
  m.position.z = 0.05;
  return m;
}

// Materials and geometry are per marker; dispose them with it.
function disposeTree(o) {
  o.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  });
}

function colorize(group, color) {
  group.userData.color = color;
  group.traverse((c) => { if (c.material) c.material.color.setHex(color); });
}

function place(o) {
  return o;
}

function doorMarker(houseId) {
  const g = new THREE.Group();
  g.userData.houseId = houseId;
  g.userData.arrow = arrow(COLOR.sale, 0.9);
  g.add(cylinder(0.6, 1.2, COLOR.sale, 0.4), g.userData.arrow);
  return place(g);
}

// A car-sized box (2.0 x 4.8 x 1.4 m) standing on z = 0 and facing +Y (rotate about Z for a
// heading): outline plus translucent fill. Not scaled with the camera distance: it shows
// the real room a car needs. withArrow: the way out, drawn on the ground in front of the nose.
const CAR = { w: 2.0, l: 4.8, h: 1.4 };
function carBox(color, withArrow) {
  const g = new THREE.Group();
  const box = new THREE.BoxGeometry(CAR.w, CAR.l, CAR.h);
  box.translate(0, 0, CAR.h / 2);
  g.add(twice(box, color, 0.3));
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }));
  edges.renderOrder = 10;
  // Lines are not pickable: the filled box is.
  edges.raycast = () => {};
  g.add(edges);
  if (withArrow) {
    g.userData.arrow = arrow(color, 0.9);
    g.userData.arrow.position.set(0, CAR.l / 2 - 0.7, 0.05);
    g.add(g.userData.arrow);
  }
  g.userData.color = color;
  return g;
}

function garagePointMarker(houseId) {
  const g = carBox(COLOR.garage, true);
  g.userData.garageHouse = houseId;
  return g;
}

function slotMarker(index) {
  const g = carBox(COLOR.garage, false);
  g.userData.slot = index;
  return g;
}

function spawnMarker() {
  const g = new THREE.Group();
  g.userData.part = 'spawn';
  g.userData.arrow = arrow(COLOR.spawn, 0.9);
  g.add(cylinder(0.35, 1.8, COLOR.spawn, 0.45), g.userData.arrow);
  return place(g);
}

function exitMarker() {
  const g = new THREE.Group();
  g.userData.part = 'exit';
  const ring = twice(new THREE.TorusGeometry(0.6, 0.07, 8, 32), COLOR.exit, 0.95);
  ring.position.z = 0.07;
  g.add(cylinder(0.6, 1.2, COLOR.exit, 0.3), ring);
  return place(g);
}

export class HouseMarkers {
  constructor(viewport) {
    this.vp = viewport;
    this.doors = new THREE.Group();
    this.interior = new THREE.Group();
    this.root = new THREE.Group();
    this.root.visible = false;
    this.portals = new THREE.Group();  // the interior's door portals, from the game data
    this.garagePoints = new THREE.Group();  // a car box per garage point, and its link to the door
    this.slots = new THREE.Group();         // the car boxes of the selected garage template
    this.root.add(this.doors, this.garagePoints, this.interior, this.slots, this.portals);
    viewport.scene.add(this.root);
    this.byId = new Map();
    this.garageById = new Map();  // house id -> { box, line }
    this.spawn = null;
    this.exit = null;
  }

  setVisible(on) {
    this.root.visible = on;
  }

  // The doors and everything outside the interior (garage points); the decor mode hides them.
  setDoorsVisible(on) {
    this.doors.visible = on;
    this.garagePoints.visible = on;
  }

  // houses: the document's; states: { id: { owner } }; selectedId: the house shown in white
  // (part 'garage': its garage point is white instead of its door).
  syncHouses(houses, states, selectedId, part = 'door') {
    const keep = new Set();
    for (const x of houses) {
      keep.add(x.id);
      let m = this.byId.get(x.id);
      if (!m) {
        m = doorMarker(x.id);
        this.byId.set(x.id, m);
        this.doors.add(m);
      }
      if (Array.isArray(x.door) && x.door.every(Number.isFinite)) m.position.set(x.door[0], x.door[1], x.door[2] - DOOR_DROP);
      m.userData.arrow.rotation.z = (Number(x.heading) || 0) * DEG;
      const st = states && states[x.id];
      const color = x.id === selectedId && part !== 'garage' ? COLOR.selected : st && st.owner ? COLOR.owned : COLOR.sale;
      if (m.userData.color !== color) colorize(m, color);
    }
    for (const [id, m] of this.byId) {
      if (keep.has(id)) continue;
      this.doors.remove(m);
      disposeTree(m);
      this.byId.delete(id);
    }
    this.syncGaragePoints(houses, selectedId, part);
  }

  // One car box and one link line (door -> garage point) per house that has a garage point.
  syncGaragePoints(houses, selectedId, part) {
    const finite = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
    const keep = new Set();
    for (const x of houses) {
      const gp = x.garagePoint;
      if (!gp || !finite(gp.pos) || !finite(x.door)) continue;
      keep.add(x.id);
      let e = this.garageById.get(x.id);
      if (!e) {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
          new THREE.LineBasicMaterial({ color: COLOR.garage, transparent: true, opacity: 0.6, depthTest: false }));
        line.renderOrder = 9;
        line.raycast = () => {};
        e = { box: garagePointMarker(x.id), line };
        this.garageById.set(x.id, e);
        this.garagePoints.add(e.box, e.line);
      }
      // The point is "ground + 1" like every other point: the car box stands on the ground below it.
      e.box.position.set(gp.pos[0], gp.pos[1], gp.pos[2] - DOOR_DROP);
      e.box.rotation.z = (Number(gp.heading) || 0) * DEG;
      const pos = e.line.geometry.attributes.position;
      pos.setXYZ(0, x.door[0], x.door[1], x.door[2] - DOOR_DROP);
      pos.setXYZ(1, gp.pos[0], gp.pos[1], gp.pos[2] - DOOR_DROP);
      pos.needsUpdate = true;
      e.line.geometry.computeBoundingSphere();
      const color = x.id === selectedId && part === 'garage' ? COLOR.selected : COLOR.garage;
      if (e.box.userData.color !== color) colorize(e.box, color);
    }
    for (const [id, e] of this.garageById) {
      if (keep.has(id)) continue;
      this.garagePoints.remove(e.box, e.line);
      disposeTree(e.box);
      disposeTree(e.line);
      this.garageById.delete(id);
    }
  }

  // The car boxes of a garage template's slots (null: none); slot is the selected index.
  syncSlots(garage, slot) {
    const list = garage && Array.isArray(garage.slots) ? garage.slots.filter((s) => s && Array.isArray(s.pos) && s.pos.every(Number.isFinite)) : [];
    // The index in the document, not in the filtered list, is what a click must report.
    const all = garage && Array.isArray(garage.slots) ? garage.slots : [];
    while (this.slots.children.length > list.length) {
      const m = this.slots.children[this.slots.children.length - 1];
      this.slots.remove(m);
      disposeTree(m);
    }
    let k = 0;
    all.forEach((sl, i) => {
      if (!list.includes(sl)) return;
      let m = this.slots.children[k];
      if (!m) {
        m = slotMarker(i);
        this.slots.add(m);
      }
      m.userData.slot = i;
      k++;
      m.position.set(sl.pos[0], sl.pos[1], sl.pos[2] - DOOR_DROP);
      m.rotation.z = (Number(sl.heading) || 0) * DEG;
      const color = i === slot ? COLOR.selected : COLOR.garage;
      if (m.userData.color !== color) colorize(m, color);
    });
  }

  // The spawn and exit markers of one interior (null: none); part is the selected one.
  syncInterior(interior, part) {
    if (!interior) {
      this.clearInterior();
      return;
    }
    if (!this.spawn) {
      this.spawn = spawnMarker();
      this.exit = exitMarker();
      this.interior.add(this.spawn, this.exit);
    }
    const [sx, sy, sz] = interior.spawn;
    const [ex, ey, ez] = interior.exit;
    this.spawn.position.set(sx, sy, sz - DOOR_DROP);
    this.spawn.userData.arrow.rotation.z = (Number(interior.heading) || 0) * DEG;
    this.exit.position.set(ex, ey, ez - DOOR_DROP);
    const spawnColor = part === 'spawn' ? COLOR.selected : COLOR.spawn;
    const exitColor = part === 'exit' ? COLOR.selected : COLOR.exit;
    if (this.spawn.userData.color !== spawnColor) colorize(this.spawn, spawnColor);
    if (this.exit.userData.color !== exitColor) colorize(this.exit, exitColor);
  }

  // The door portals of the interior (entries of the geometry's doors): thin outlines, the
  // entrance filled and in green, the other ways in from outside white, inner doors dim.
  setPortals(doors, entrance) {
    this.clearPortals();
    (doors || []).forEach((d, i) => {
      if (!Array.isArray(d.corners) || d.corners.length < 3) return;
      const isEntrance = i === entrance;
      const color = isEntrance ? COLOR.entrance : d.outside ? COLOR.selected : COLOR.inner;
      const pts = d.corners.map((c) => new THREE.Vector3(c[0], c[1], c[2]));
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: isEntrance ? 1 : 0.7, depthTest: false }));
      line.renderOrder = 9;
      this.portals.add(line);
      if (isEntrance) {
        // A quad (two triangles) across the portal, and a short arrow along the normal.
        const g = new THREE.BufferGeometry().setFromPoints([pts[0], pts[1], pts[2], pts[0], pts[2], pts[3] || pts[2]]);
        const fill = new THREE.Mesh(g, material(color, 0.25));
        fill.renderOrder = 9;
        const c = d.center;
        const tip = new THREE.Vector3(c[0] + d.normal[0] * 1.2, c[1] + d.normal[1] * 1.2, c[2]);
        const arrowLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...c), tip]),
          new THREE.LineBasicMaterial({ color, depthTest: false }));
        arrowLine.renderOrder = 9;
        this.portals.add(fill, arrowLine);
      }
    });
  }

  clearPortals() {
    for (const o of [...this.portals.children]) {
      this.portals.remove(o);
      disposeTree(o);
    }
  }

  clearInterior() {
    this.clearPortals();
    this.syncSlots(null, null);
    for (const m of [this.spawn, this.exit]) if (m) { this.interior.remove(m); disposeTree(m); }
    this.spawn = null;
    this.exit = null;
  }

  // Keeps markers readable: the farther the camera, the larger they are.
  frame() {
    if (!this.root.visible) return;
    const cam = this.vp.camera.position;
    // The car boxes keep their real size: they show how much room a car needs.
    for (const m of [...this.byId.values(), this.spawn, this.exit]) {
      if (!m) continue;
      m.scale.setScalar(Math.min(12, Math.max(1, m.position.distanceTo(cam) / 30)));
    }
  }

  // What is under the mouse: { house: id, part?: 'garage' } | { slot: index } | { part: 'spawn' | 'exit' } | null.
  pick() {
    const vp = this.vp;
    vp.raycaster.setFromCamera(vp.pointer, vp.camera);
    this.root.updateMatrixWorld(true);
    const hits = vp.raycaster.intersectObjects(this.root.children, true);
    for (const hit of hits) {
      for (let o = hit.object; o; o = o.parent) {
        if (o.userData.houseId !== undefined) return { house: o.userData.houseId };
        if (o.userData.garageHouse !== undefined) return { house: o.userData.garageHouse, part: 'garage' };
        if (o.userData.slot !== undefined) return { slot: o.userData.slot };
        if (o.userData.part) return { part: o.userData.part };
      }
    }
    return null;
  }
}
