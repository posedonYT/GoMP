// The houses editor ("Дома" tab): doors and garage points of the houses as markers over
// the world, interiors and garages with their spawn and exit points, classes, and the forms
// for all of them. The document is server-files/houses.json; it is edited in
// memory (undo by snapshots) and written with Ctrl+S (PUT /api/houses), which
// the game server picks up at once.
import * as THREE from 'three';
import { $, h, toast, setStatus, confirmBox } from './dom.js';
import { api } from '../api.js';
import { DEG } from '../math/gta.js';
import { HouseMarkers } from '../scene/house-markers.js';
import { houseForm, interiorForm, garageForm, classForm, problems, slotLabel } from './houses-forms.js';
import {
  dirToHeading, clone, canonical, check, serverIssues, Snapshots, normalizeDoc, geoKey, MAX_SLOTS,
  propsToObjects, interiorOf, interiorById, garageById, garageOf, classById, newHouse, newInterior, newGarage,
  removeHouse, removeInterior, removeGarage, removeClass, defaultGaragePoint, slotBeside,
  exitAtDoor, spawnAtDoor, pickEntrance,
} from '../houses/model.js';

const round = (v) => Math.round(v * 1000) / 1000;
const money = (n) => `$${Number(n).toLocaleString('ru-RU')}`;
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export class HouseEditor {
  constructor(studio) {
    this.studio = studio;
    this.vp = studio.viewport;
    this.markers = new HouseMarkers(this.vp);
    this.pivot = new THREE.Object3D();
    this.vp.scene.add(this.pivot);
    this.doc = null;
    this.states = {};        // { houseId: { owner, ownerName, locked, garage } }
    this.nextId = 1;
    this.savedCanon = '';    // the document as last loaded or saved
    this.serverIssues = [];  // what the server said at the last load or save; stale after an edit
    this.loadError = null;
    this.snaps = new Snapshots();
    // { kind: 'house', id, part: 'door' | 'garage' } | { kind: 'interior', id, part: 'spawn' | 'exit' }
    // | { kind: 'garage', id, part: 'spawn' | 'exit' | 'slot', slot } | { kind: 'class', id }
    this.sel = null;
    this.active = false;
    this.drag = null;        // { before } while the gizmo is held
    this.live = null;        // inputs of the open form that the gizmo also changes
    this.geoSeq = 0;
    this.geoFor = null;      // geoKey(kind, id) of the interior or garage whose game geometry is drawn
    this.doors = [];         // its door portals (geometry.doors), and which one is the entrance:
    this.entrance = -1;      // an index into doors, the user's pick or the server's
    this.formBox = null;
    this.problemBox = null;
  }

  get dirty() { return !!this.doc && canonical(this.doc) !== this.savedCanon; }

  async init() {
    this.bindViewport();
    this.vp.onFrame.push(() => { if (this.active || this.studio.decor) this.markers.frame(); });
    await this.load();
    this.renderLeft();
  }

  // ------------------------------------------------------------------ loading and saving

  async load() {
    try {
      this.adopt(await api.houses());
      this.loadError = null;
    } catch (e) {
      this.loadError = e.message;
      if (!this.doc) this.renderLeft();
      toast('Дома: ' + e.message, 'error');
    }
  }

  adopt(r) {
    this.doc = normalizeDoc(r.doc);
    this.states = r.states || {};
    this.nextId = r.nextId || 1;
    this.savedCanon = canonical(this.doc);
    this.serverIssues = serverIssues(r.issues);
    this.snaps.clear();
    if (this.selected() === null) {
      this.sel = null;
      this.clearGeometry();
    }
    this.refresh();
  }

  // Resolves true when the file is written (or there was nothing to write).
  async save() {
    if (!this.doc || !this.dirty) return true;
    try {
      const r = await api.saveHouses(this.doc);
      this.savedCanon = canonical(this.doc);
      this.nextId = r.nextId || this.nextId;
      this.serverIssues = serverIssues(r.issues);
      this.changed();
      setStatus(`Дома сохранены: ${this.doc.houses.length} домов, ${this.doc.interiors.length} интерьеров, ${this.doc.garages.length} гаражей`);
      toast('Дома сохранены — сервер применит их сразу');
      return true;
    } catch (e) {
      this.serverIssues = serverIssues(e.body && e.body.issues);
      this.changed();
      toast(`Не сохранено: ${e.message}`, 'error');
      return false;
    }
  }

  // houses.json changed on disk: our own save, or the game server (the /house command).
  async onFileChanged() {
    let r;
    try {
      r = await api.houses();
    } catch {
      return;  // half-written or broken: the next event brings the real file
    }
    this.states = r.states || {};
    this.nextId = r.nextId || this.nextId;
    normalizeDoc(r.doc);
    if (!this.doc || canonical(r.doc) === this.savedCanon) {
      if (!this.doc) this.adopt(r);
      else this.changed({ right: true });
    } else if (this.dirty) {
      toast('houses.json изменён снаружи (например, командой /house в игре); сохранение перезапишет его', 'warning', 8000);
      this.changed({ right: true });
    } else {
      this.adopt(r);
    }
  }

  onGameReady() {
    // The models were dropped with the game's restart: draw the interior again.
    const s = this.selected();
    if ((this.active || this.studio.decor) && s && (s.kind === 'interior' || s.kind === 'garage')) this.showGeometry(s.kind, s.obj);
  }

  // ------------------------------------------------------------------ decor mode

  // The interior's props are edited in the map editor (Studio.editDecor).
  editDecor(interior) {
    const id = interior.id;
    this.studio.editDecor({
      interiorId: id,
      title: `Декор: ${interior.name}`,
      objects: propsToObjects(interior.props),
      spawn: interior.spawn.slice(),
      heading: interior.heading,
      onSave: (props) => this.applyDecor(id, props),
      onExit: () => this.afterDecor(id),
    });
  }

  // While the decor is open the markers of all doors are hidden; the interior's own stay.
  holdForDecor() {
    this.markers.setDoorsVisible(false);
    this.markers.setVisible(true);
  }

  // The decor was dropped for another map: the houses' drawing goes away with it.
  releaseDecor() {
    this.markers.setDoorsVisible(true);
    this.markers.setVisible(false);
    this.clearGeometry();
  }

  // Writes the props into the interior (one undo step here) and saves the houses file.
  async applyDecor(interiorId, props) {
    const interior = this.doc && interiorById(this.doc, interiorId);
    if (!interior) {
      toast('Интерьер больше не существует в домах — декор некуда сохранить', 'error');
      return false;
    }
    this.edit(() => { interior.props = props; }, { right: true });
    return this.save();
  }

  afterDecor(interiorId) {
    if (this.doc && interiorById(this.doc, interiorId)) this.selectInterior(interiorId, true);
  }

  // ------------------------------------------------------------------ the tab

  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    const s = this.studio;
    if (on) {
      s.stopPlacing();
      this.vp.gizmo.detach();
      this.markers.setDoorsVisible(true);
      this.markers.setVisible(true);
      if (this.doc) this.onFileChanged();  // owners may have changed meanwhile
      this.refresh();
      // Back from the decor mode the interior is still drawn: no need to fetch it again.
      const s2 = this.selected();
      if (s2 && (s2.kind === 'interior' || s2.kind === 'garage') && (this.geoFor !== geoKey(s2.kind, s2.obj.id) || !this.studio.world.interiorGroup)) this.showGeometry(s2.kind, s2.obj);
    } else {
      // The decor mode edits inside the interior: it stays on screen, with its two markers.
      if (!s.decor) {
        this.markers.setVisible(false);
        this.clearGeometry();
      }
      this.vp.gizmo.detach();
      this.vp.gizmo.showX = this.vp.gizmo.showY = this.vp.gizmo.showZ = true;
      s.showMapPanels();
      s.attachGizmo();
      s.updateTitle();
    }
  }

  onModeChange() {
    if (this.active) this.attachGizmo();
  }

  // The top toolbar belongs to the houses while their tab is open.
  syncToolbar() {
    if (!this.active) return;
    const dirty = this.dirty;
    $('#btn-save').disabled = !dirty;
    $('#btn-undo').disabled = !this.snaps.canUndo;
    $('#btn-redo').disabled = !this.snaps.canRedo;
    $('#doc-title').textContent = 'дома (houses.json)';
    $('#doc-dirty').hidden = !dirty;
    document.title = `${dirty ? '● ' : ''}Дома — GoMP Studio`;
  }

  // ------------------------------------------------------------------ selection

  // { kind, obj } of the selection, or null when it no longer exists.
  selected() {
    if (!this.sel || !this.doc) return null;
    const { kind, id } = this.sel;
    const obj = kind === 'house' ? this.doc.houses.find((x) => x.id === id)
      : kind === 'interior' ? interiorById(this.doc, id)
        : kind === 'garage' ? garageById(this.doc, id) : classById(this.doc, id);
    return obj ? { kind, obj } : null;
  }

  // part: 'door' | 'garage' (which of the house's two points the gizmo moves).
  selectHouse(id, fly = false, part = 'door') {
    this.setSelection({ kind: 'house', id, part });
    const s = this.selected();
    if (fly && s) this.lookAtHouse(s.obj);
  }

  selectClass(id) {
    this.setSelection({ kind: 'class', id });
  }

  selectInterior(id, fly = true, part = null) {
    const interior = interiorById(this.doc, id);
    if (!interior) return;
    const changed = this.geoFor !== geoKey('interior', id);
    // A fresh interior starts with its spawn point under the gizmo.
    this.setSelection({ kind: 'interior', id, part: part || (changed || !this.sel ? 'spawn' : this.sel.part) });
    if (fly) this.lookAtInterior(interior);
    if (changed) this.showGeometry('interior', interior);
  }

  // part: 'spawn' | 'exit' | 'slot' (then slot is the index; keeps the current one by default).
  selectGarage(id, fly = true, part = null, slot = null) {
    const garage = garageById(this.doc, id);
    if (!garage) return;
    const changed = this.geoFor !== geoKey('garage', id);
    const prev = this.sel && this.sel.kind === 'garage' && this.sel.id === id ? this.sel : null;
    const p = part || (changed || !prev ? 'spawn' : prev.part);
    const index = p === 'slot' ? (slot !== null ? slot : prev && prev.slot !== undefined && prev.slot !== null ? prev.slot : 0) : null;
    this.setSelection({ kind: 'garage', id, part: p, slot: index });
    if (fly) this.flyToGarage(garage, p, index);
    if (changed) this.showGeometry('garage', garage);
  }

  selectByObjectId(objectId) {
    const m = /^(house|interior|garage|class):(.+)$/.exec(objectId || '');
    if (!m) return;
    if (m[1] === 'house') this.selectHouse(Number(m[2]), true);
    else if (m[1] === 'interior') this.selectInterior(m[2]);
    else if (m[1] === 'garage') this.selectGarage(m[2]);
    else this.selectClass(m[2]);
  }

  setSelection(sel) {
    this.sel = sel;
    if (!sel || (sel.kind !== 'interior' && sel.kind !== 'garage')) this.clearGeometry();
    this.changed({ right: true });
  }

  lookAtHouse(house) {
    // From the street side: the heading points away from the house.
    this.vp.lookAt(new THREE.Vector3(...house.door), 18, house.heading + 180);
  }

  lookAtInterior(interior) {
    this.vp.lookAt(new THREE.Vector3(...interior.spawn), 8, interior.heading);
  }

  // From behind the car that leaves the garage there, looking along its way out.
  lookAtGaragePoint(house) {
    if (!house.garagePoint) return;
    this.vp.lookAt(new THREE.Vector3(...house.garagePoint.pos), 14, house.garagePoint.heading);
  }

  lookAtSlot(garage, index) {
    const slot = garage.slots[index];
    if (slot) this.vp.lookAt(new THREE.Vector3(...slot.pos), 8, slot.heading);
  }

  // Looks at the selected part of a garage template: its spawn, its exit or a slot.
  flyToGarage(garage, part, index) {
    if (part === 'slot') this.lookAtSlot(garage, index);
    else if (part === 'exit') this.vp.lookAt(new THREE.Vector3(...garage.exit), 8, garage.heading);
    else this.lookAtInterior(garage);
  }

  // ------------------------------------------------------------------ editing

  // fn changes this.doc and may return an error text (then nothing changes).
  // One call is one undo step. right: the form needs a redraw (not just new values).
  edit(fn, { right = false } = {}) {
    const before = clone(this.doc);
    const error = fn();
    if (typeof error === 'string') {
      toast(error, 'error');
      this.renderRight();
      return false;
    }
    if (canonical(before) === canonical(this.doc)) return true;
    this.snaps.push(before);
    this.serverIssues = [];
    this.changed({ right });
    return true;
  }

  undo() { this.travel(this.snaps.undo(this.doc)); }
  redo() { this.travel(this.snaps.redo(this.doc)); }

  travel(doc) {
    if (!doc) return;
    this.doc = doc;
    this.serverIssues = [];
    if (this.selected() === null) {
      this.sel = null;
      this.clearGeometry();
    }
    this.changed({ right: true });
  }

  addHouse() {
    const t = this.vp.target;
    const ground = this.vp.groundAt(t.x, t.y, t.z + 200);
    const cam = this.vp.camera.position;
    // The camera looks at the door from the street: facing the camera is facing out.
    const heading = Math.round(dirToHeading(cam.x - t.x, cam.y - t.y));
    const r = newHouse(this.doc, { pos: [round(t.x), round(t.y), round((ground ?? t.z) + 1)], heading, nextId: this.nextId });
    this.edit(() => { this.doc.houses.push(r.house); });
    this.nextId = r.nextId;
    this.selectHouse(r.house.id);
  }

  async deleteHouse(house) {
    const st = this.states[house.id];
    const owned = st && st.owner ? ` Дом куплен (${st.ownerName || st.owner}): владелец его потеряет.` : '';
    if (!(await confirmBox('Удалить дом?', `Дом #${house.id} «${house.name}» будет удалён из списка.${owned}`))) return;
    if (this.edit(() => removeHouse(this.doc, house.id))) this.setSelection(null);
  }

  addInterior() {
    const t = this.vp.target;
    const interior = newInterior(this.doc);
    interior.spawn = [round(t.x), round(t.y), round(t.z)];
    interior.exit = interior.spawn.slice();
    this.edit(() => { this.doc.interiors.push(interior); });
    this.selectInterior(interior.id, false);
  }

  duplicateInterior(from) {
    const copy = newInterior(this.doc, from);
    copy.name = `${from.name} (копия)`;
    this.edit(() => { this.doc.interiors.push(copy); });
    this.selectInterior(copy.id, false);
  }

  async deleteInterior(interior) {
    if (!(await confirmBox('Удалить интерьер?', `Интерьер «${interior.name}» вместе с его декором будет удалён.`))) return;
    if (this.edit(() => removeInterior(this.doc, interior.id))) this.setSelection(null);
  }

  addClass() {
    let n = 1;
    while (classById(this.doc, `class_${n}`)) n++;
    const first = this.doc.interiors[0];
    const cls = { id: `class_${n}`, name: 'Новый класс', garage: 2, interior: first ? first.id : '' };
    this.edit(() => { this.doc.classes.push(cls); });
    this.selectClass(cls.id);
  }

  async deleteClass(cls) {
    if (!(await confirmBox('Удалить класс?', `Класс «${cls.name}» будет удалён.`))) return;
    if (this.edit(() => removeClass(this.doc, cls.id))) this.setSelection(null);
  }

  addGarage() {
    const t = this.vp.target;
    const garage = newGarage(this.doc);
    garage.spawn = [round(t.x), round(t.y), round(t.z)];
    garage.exit = garage.spawn.slice();
    garage.slots = [slotBeside({ pos: garage.spawn.slice(), heading: 0 })];
    this.edit(() => { this.doc.garages.push(garage); });
    this.selectGarage(garage.id, false);
  }

  duplicateGarage(from) {
    const copy = newGarage(this.doc, from);
    copy.name = `${from.name} (копия)`;
    this.edit(() => { this.doc.garages.push(copy); });
    this.selectGarage(copy.id, false);
  }

  async deleteGarage(garage) {
    if (!(await confirmBox('Удалить гараж?', `Гараж «${garage.name}» будет удалён.`))) return;
    if (this.edit(() => removeGarage(this.doc, garage.id))) this.setSelection(null);
  }

  // A slot to the right of the selected one (else of the last one), same heading and z.
  addSlot(garage) {
    const cur = this.sel && this.sel.kind === 'garage' && this.sel.id === garage.id && this.sel.part === 'slot' ? garage.slots[this.sel.slot] : null;
    const base = cur || garage.slots[garage.slots.length - 1] || { pos: garage.spawn.slice(), heading: 0 };
    const slot = slotBeside(base);
    const ok = this.edit(() => {
      if (garage.slots.length >= MAX_SLOTS) return `В гараже не больше ${MAX_SLOTS} мест`;
      garage.slots.push(slot);
    }, { right: true });
    if (ok) this.selectGarage(garage.id, false, 'slot', garage.slots.length - 1);
  }

  deleteSlot(garage, index) {
    const ok = this.edit(() => {
      if (garage.slots.length <= 1) return 'В гараже должно остаться хотя бы одно место';
      garage.slots.splice(index, 1);
    }, { right: true });
    if (ok) this.selectGarage(garage.id, false, 'slot', Math.min(index, garage.slots.length - 1));
  }

  // The house's gizmo goes to the door or to the garage point.
  selectHousePart(house, part) {
    this.setSelection({ kind: 'house', id: house.id, part });
  }

  dropGaragePointToGround(house) {
    const gp = house.garagePoint;
    if (!gp) return;
    const z = this.vp.groundAt(gp.pos[0], gp.pos[1], gp.pos[2] + 1.5);
    if (z === null) {
      toast('Под въездом нет загруженного мира', 'warning');
      return;
    }
    this.edit(() => { gp.pos[2] = round(z + 1); }, { right: true });
  }

  // A garage point 6 m in front of the door, on the ground.
  placeGaragePoint(house) {
    const p0 = defaultGaragePoint(house, null);
    const ground = this.vp.groundAt(p0.pos[0], p0.pos[1], house.door[2] + 1.5);
    this.edit(() => { house.garagePoint = defaultGaragePoint(house, ground); }, { right: true });
    this.selectHousePart(house, 'garage');
  }

  // The garage point at the nearest road node (Studio answers from the game's path data).
  async snapGaragePointToRoad(house) {
    let r;
    try {
      r = await api.roadsNearest(house.door[0], house.door[1], house.door[2]);
    } catch (e) {
      toast(e.status === 503 ? 'Игра ещё не загружена — дороги недоступны, попробуйте позже'
        : e.status === 404 ? 'Эта версия Studio не умеет искать дороги (/api/roads/nearest)' : `Дороги: ${e.message}`,
      e.status === 503 ? 'warning' : 'error');
      return;
    }
    if (!r || !r.suggest) {
      toast('Рядом с дверью нет дороги для машин (60 м)', 'warning');
      return;
    }
    const { pos, heading } = r.suggest;
    this.edit(() => {
      const gp = house.garagePoint || (house.garagePoint = { pos: [0, 0, 0], heading: 0 });
      gp.pos = pos.map(round);
      gp.heading = round(heading);
    }, { right: true });
    this.selectHousePart(house, 'garage');
  }

  dropDoorToGround(house) {
    // Starting a little above the door: a roof over it must not count as ground.
    const z = this.vp.groundAt(house.door[0], house.door[1], house.door[2] + 1.5);
    if (z === null) {
      toast('Под дверью нет загруженного мира', 'warning');
      return;
    }
    this.edit(() => { house.door[2] = round(z + 1); }, { right: true });
  }

  // ------------------------------------------------------------------ interior geometry

  // kind: 'interior' | 'garage' (both have a spawn and an exit inside a game interior).
  async showGeometry(kind, interior) {
    const seq = ++this.geoSeq;
    const key = geoKey(kind, interior.id);
    // A redraw of the same interior keeps the entrance the user picked; another interior starts afresh.
    if (this.geoFor !== key) this.entrance = -1;
    this.geoFor = key;
    this.doors = [];
    this.markers.clearPortals();
    this.studio.world.clearInterior();
    const [x, y, z] = interior.spawn;
    try {
      const g = await api.interiorGeometry(x, y, z, 60, 'contains');
      if (seq !== this.geoSeq) return;
      if (!g.mlos.length) {
        toast('В точке появления нет интерьера игры — декор не показан. Поставьте точку внутрь интерьера.', 'warning');
        return;
      }
      // 'contains' gives one interior, so every door of the answer is its own.
      this.doors = g.doors || [];
      this.entrance = pickEntrance(this.doors, this.entrance, g.mlos[0].entrance);
      this.markers.setPortals(this.doors, this.entrance);
      if (this.sel && (this.sel.kind === 'interior' || this.sel.kind === 'garage')) this.renderRight();
      await this.studio.world.showInterior(g.entities);
      if (seq === this.geoSeq) setStatus(`Интерьер игры ${g.mlos[0].name}: ${g.entities.length} объектов, дверей: ${this.doors.length}`);
    } catch (e) {
      if (seq !== this.geoSeq) return;
      toast(e.status === 503 ? 'Игра ещё не загружена — стены интерьера не показаны, но точки можно править.' : e.message, e.status === 503 ? 'warning' : 'error');
    }
  }

  clearGeometry() {
    this.geoSeq++;
    this.geoFor = null;
    this.doors = [];
    this.entrance = -1;
    this.markers.clearPortals();
    this.studio.world.clearInterior();
  }

  // The user picks which way in from outside is the entrance (not a document change).
  setEntrance(i) {
    this.entrance = i;
    this.markers.setPortals(this.doors, i);
  }

  // Puts the exit or the spawn (with its heading) of an interior or a garage by the entrance
  // door: one undo step.
  placeAtDoor(interior, what) {
    const door = this.doors[this.entrance];
    if (!door) return;
    this.edit(() => {
      if (what === 'exit') {
        interior.exit = exitAtDoor(door);
      } else {
        const s = spawnAtDoor(door);
        interior.spawn = s.pos;
        interior.heading = s.heading;
      }
    }, { right: true });
  }

  // ------------------------------------------------------------------ gizmo and picking

  bindViewport() {
    const vp = this.vp;
    vp.addEventListener('pick', () => {
      if (!this.active || !this.doc) return;
      const hit = this.markers.pick();
      const inGeo = this.sel && (this.sel.kind === 'interior' || this.sel.kind === 'garage');
      if (hit && hit.house !== undefined) this.selectHouse(hit.house, false, hit.part === 'garage' ? 'garage' : 'door');
      else if (hit && hit.slot !== undefined && this.sel && this.sel.kind === 'garage') this.selectGarage(this.sel.id, false, 'slot', hit.slot);
      else if (hit && hit.part && this.sel && this.sel.kind === 'interior') this.selectInterior(this.sel.id, false, hit.part);
      else if (hit && hit.part && this.sel && this.sel.kind === 'garage') this.selectGarage(this.sel.id, false, hit.part);
      else if (!inGeo) this.setSelection(null);
    });
    vp.addEventListener('gizmostart', () => {
      if (this.active && this.gizmoTarget()) this.drag = { before: clone(this.doc) };
    });
    vp.addEventListener('gizmochange', () => this.onGizmoChange());
    vp.addEventListener('gizmoend', () => {
      if (!this.active || !this.drag) return;
      const { before } = this.drag;
      this.drag = null;
      if (canonical(before) !== canonical(this.doc)) {
        this.snaps.push(before);
        this.serverIssues = [];
      }
      this.changed();
    });
  }

  // Where the gizmo's pivot writes to: the object, the key of its position and of its heading (or null).
  gizmoTarget() {
    const s = this.selected();
    if (!s) return null;
    if (s.kind === 'house') {
      if (this.sel.part === 'garage') return s.obj.garagePoint ? { obj: s.obj.garagePoint, pos: 'pos', head: 'heading' } : null;
      return { obj: s.obj, pos: 'door', head: 'heading' };
    }
    if ((s.kind === 'interior' || s.kind === 'garage') && this.sel.part === 'spawn') return { obj: s.obj, pos: 'spawn', head: 'heading' };
    if ((s.kind === 'interior' || s.kind === 'garage') && this.sel.part === 'exit') return { obj: s.obj, pos: 'exit', head: null };
    if (s.kind === 'garage' && this.sel.part === 'slot') {
      const slot = s.obj.slots[this.sel.slot];
      return slot ? { obj: slot, pos: 'pos', head: 'heading' } : null;
    }
    return null;
  }

  attachGizmo() {
    if (!this.active) return;  // the gizmo belongs to the map editor (also in the decor mode)
    const g = this.vp.gizmo;
    const t = this.gizmoTarget();
    const rotate = this.studio.mode === 'rotate';
    if (!t || (rotate && !t.head)) {
      g.detach();
      return;
    }
    this.pivot.position.set(...t.obj[t.pos]);
    this.pivot.quaternion.setFromAxisAngle(Z_AXIS, t.head ? t.obj[t.head] * DEG : 0);
    // A house only turns about the vertical axis: its heading.
    g.showX = g.showY = !rotate;
    g.showZ = true;
    g.attach(this.pivot);
  }

  onGizmoChange() {
    if (!this.active || !this.drag) return;
    const t = this.gizmoTarget();
    if (!t) return;
    if (this.studio.mode === 'rotate') {
      const d = new THREE.Vector3(0, 1, 0).applyQuaternion(this.pivot.quaternion);
      t.obj[t.head] = round(dirToHeading(d.x, d.y));
    } else {
      const p = this.pivot.position;
      t.obj[t.pos] = [round(p.x), round(p.y), round(p.z)];
    }
    this.syncMarkers();
    this.syncLive();
  }

  // The numbers of the open form follow the gizmo (except the field being typed in).
  syncLive() {
    const s = this.selected();
    if (!s || !this.live) return;
    const set = (inputs, values) => inputs.forEach((input, i) => {
      if (document.activeElement !== input) input.value = round(values[i]);
    });
    if (s.kind === 'house') {
      set(this.live.door, s.obj.door);
      set(this.live.heading, [s.obj.heading]);
      if (s.obj.garagePoint) {
        set(this.live.gpos, s.obj.garagePoint.pos);
        set(this.live.gheading, [s.obj.garagePoint.heading]);
      }
    } else if (s.kind === 'interior' || s.kind === 'garage') {
      set(this.live.spawn, s.obj.spawn);
      set(this.live.sheading, [s.obj.heading]);
      set(this.live.exit, s.obj.exit);
      const slot = s.kind === 'garage' && this.sel.part === 'slot' ? s.obj.slots[this.sel.slot] : null;
      if (slot) {
        set(this.live.slot, slot.pos);
        set(this.live.slotHeading, [slot.heading]);
        // The slot's line in the list shows its numbers.
        if (this.live.slotRow) this.live.slotRow.textContent = slotLabel(slot, this.sel.slot);
      }
    }
  }

  // ------------------------------------------------------------------ keys

  // Called by the Studio while this tab is open; true: the key was ours.
  onKey(e, ctrl) {
    if (ctrl && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return true; }
    if (ctrl && e.code === 'KeyY') { e.preventDefault(); this.redo(); return true; }
    if (ctrl) return false;
    const s = this.selected();
    switch (e.code) {
      case 'Delete':
        if (s && s.kind === 'house') {
          // With the garage point selected only the point goes; the house stays.
          if (this.sel.part === 'garage' && s.obj.garagePoint) this.edit(() => { delete s.obj.garagePoint; }, { right: true });
          else this.deleteHouse(s.obj);
        } else if (s && s.kind === 'garage' && this.sel.part === 'slot') {
          this.deleteSlot(s.obj, this.sel.slot);
        }
        return true;
      case 'Escape':
        this.setSelection(null);
        return true;
      case 'KeyF':
        if (s && s.kind === 'house') {
          if (this.sel.part === 'garage' && s.obj.garagePoint) this.lookAtGaragePoint(s.obj);
          else this.lookAtHouse(s.obj);
        } else if (s && s.kind === 'interior') {
          this.lookAtInterior(s.obj);
        } else if (s && s.kind === 'garage') {
          this.flyToGarage(s.obj, this.sel.part, this.sel.slot);
        }
        return true;
      default:
        return false;
    }
  }

  // ------------------------------------------------------------------ drawing

  // Everything that depends on the document or the selection, except the form when right is false.
  changed({ right = false } = {}) {
    if (!this.doc) return;
    this.syncMarkers();
    this.renderLeft();
    this.syncToolbar();
    if (right) this.renderRight();
    else this.renderProblems();
    if (!this.drag) this.attachGizmo();
  }

  refresh() {
    this.changed({ right: true });
  }

  syncMarkers() {
    const s = this.selected();
    this.markers.syncHouses(this.doc.houses, this.states, s && s.kind === 'house' ? s.obj.id : null, s && s.kind === 'house' ? this.sel.part : 'door');
    const geo = s && (s.kind === 'interior' || s.kind === 'garage') ? s.obj : null;
    this.markers.syncInterior(geo, this.sel && this.sel.part);
    this.markers.syncSlots(s && s.kind === 'garage' ? s.obj : null, s && s.kind === 'garage' && this.sel.part === 'slot' ? this.sel.slot : null);
  }

  // Problems from the quick local check plus what only the server knows (warnings).
  issues() {
    if (!this.doc) return [];
    const local = check(this.doc);
    const broken = new Set(local.filter((i) => i.severity === 0).map((i) => i.objectId));
    return [...local, ...this.serverIssues.filter((i) => i.severity !== 0 || !broken.has(i.objectId))];
  }

  renderLeft() {
    const panel = $('#houses-panel');
    if (!panel) return;
    if (!this.doc) {
      panel.replaceChildren(
        h('p', { class: 'hint' }, this.loadError ? `Файл домов не открылся: ${this.loadError}` : 'Загрузка…'),
        h('button', { onclick: () => this.load().then(() => this.renderLeft()) }, 'Повторить'));
      return;
    }
    const keep = panel.querySelector('.houses-scroll');
    const top = keep ? keep.scrollTop : 0;
    const doc = this.doc;
    const bad = new Set(this.issues().filter((i) => i.severity === 0).map((i) => i.objectId));
    const on = (kind, id) => (this.sel && this.sel.kind === kind && this.sel.id === id ? 'on' : '');
    const row = (kind, id, title, sub, onclick, ...tags) => h('li', { class: on(kind, id), onclick },
      h('div', { class: 'grow' }, h('div', {}, title), h('div', { class: 'sub' }, sub)),
      bad.has(`${kind}:${id}`) ? h('span', { class: 'tag bad', title: 'Есть ошибки' }, '!') : null,
      ...tags.filter(Boolean).map((t) => h('span', { class: 'tag' }, t)));

    const houses = doc.houses.map((x) => {
      const st = this.states[x.id];
      const cls = classById(doc, x.cls);
      return row('house', x.id, `#${x.id} ${x.name}`, `${cls ? cls.name : x.cls} · ${money(x.price)}${st && st.owner ? ` · ${st.ownerName || st.owner}` : ''}`,
        () => this.selectHouse(x.id, true), st && st.owner ? 'куплен' : null,
        // The house gets a garage interior but cars can only be parked at its door.
        garageOf(doc, x) && !x.garagePoint ? 'без въезда' : null);
    });
    const interiors = doc.interiors.map((i) => {
      const k = doc.houses.filter((x) => { const o = interiorOf(doc, x); return o && o.id === i.id; }).length;
      return row('interior', i.id, i.name, `${i.id} · домов: ${k}`, () => this.selectInterior(i.id));
    });
    const garages = doc.garages.map((g) => {
      const k = doc.houses.filter((x) => { const o = garageOf(doc, x); return o && o.id === g.id; }).length;
      return row('garage', g.id, g.name, `${g.id} · мест: ${(g.slots || []).length} · домов: ${k}`, () => this.selectGarage(g.id));
    });
    const classes = doc.classes.map((c) => {
      const i = interiorById(doc, c.interior);
      return row('class', c.id, c.name, `${c.id} · гараж ${c.garage} · ${i ? i.name : 'нет интерьера'}`, () => this.selectClass(c.id));
    });

    const dirty = this.dirty;
    panel.replaceChildren(
      h('button', { class: 'primary', disabled: !dirty, title: 'Ctrl+S — сервер применит сразу', onclick: () => this.save() }, dirty ? 'Сохранить дома ●' : 'Сохранить дома'),
      h('div', { class: 'houses-scroll' },
        h('div', { class: 'subhead' }, `Дома (${doc.houses.length})`),
        h('ul', { class: 'list compact' }, ...houses),
        h('button', { onclick: () => this.addHouse() }, '+ Новый дом'),
        h('div', { class: 'subhead' }, `Интерьеры (${doc.interiors.length})`),
        h('ul', { class: 'list compact' }, ...interiors),
        h('button', { onclick: () => this.addInterior() }, '+ Новый интерьер'),
        h('div', { class: 'subhead' }, `Гаражи (${doc.garages.length})`),
        h('ul', { class: 'list compact' }, ...garages),
        h('button', { onclick: () => this.addGarage() }, '+ Новый гараж'),
        h('div', { class: 'subhead' }, `Классы (${doc.classes.length})`),
        h('ul', { class: 'list compact' }, ...classes),
        h('button', { onclick: () => this.addClass() }, '+ Новый класс'),
        h('p', { class: 'hint' }, 'Новый дом ставится под центром экрана. Файл — server-files/houses.json; сервер подхватывает его сразу.')));
    const scroll = panel.querySelector('.houses-scroll');
    if (scroll) scroll.scrollTop = top;
  }

  renderRight() {
    if (!this.active) return;
    const right = $('#right');
    this.formBox = h('div', {});
    this.problemBox = h('div', {});
    right.replaceChildren(this.formBox, this.problemBox);
    this.live = null;
    const s = this.selected();
    if (!this.doc) {
      this.formBox.append(h('p', { class: 'hint' }, 'Файл домов не открыт.'));
    } else if (!s) {
      this.sel = null;
      this.formBox.append(h('h3', {}, 'Дома'), h('p', { class: 'hint' },
        'Выберите дом (клик по маркеру двери в мире или в списке), интерьер, гараж или класс.'));
    } else {
      const form = s.kind === 'house' ? houseForm : s.kind === 'interior' ? interiorForm : s.kind === 'garage' ? garageForm : classForm;
      this.formBox.append(...form(this, s.obj));
    }
    this.renderProblems();
  }

  renderProblems() {
    if (!this.active || !this.problemBox) return;
    this.problemBox.replaceChildren(...problems(this, this.issues()));
  }
}
