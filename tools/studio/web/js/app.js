// GoMP Studio in the browser: opens maps of the server, shows them in 3D and
// edits them (catalog, gizmo, inspector, undo/redo); Ctrl+S sends the map to
// the Studio, which writes it where the GoMP server picks it up at once.
import * as THREE from 'three';
import { api, listen } from './api.js';
import { $, $$, h, toast, setStatus, typing, confirmBox } from './ui/dom.js';
import { Viewport } from './scene/viewport.js';
import { MapObjects, forgetModelInfo, modelInfo } from './scene/objects.js';
import { Models } from './scene/models.js';
import { World } from './scene/world.js';
import { VehicleEditor } from './ui/vehicles.js';
import { HouseEditor } from './ui/houses.js';
import { MapDocument } from './editor/document.js';
import { Selection } from './editor/selection.js';
import { dragPatches, placeOnGround, pasteAt } from './editor/transform.js';
import { DEG, EULER_ORDER, eulerToQuat } from './math/gta.js';
import { MAX_PROPS, objectsToProps } from './houses/model.js';
import { renderMaps, newMap, renderOutliner, renderCatalog, modelOf, renderInspector, renderMapProps, renderIssues } from './ui/panels.js';

class Studio {
  constructor() {
    this.viewport = new Viewport($('#viewport'));
    this.models = new Models();
    this.objects = new MapObjects(this.viewport, this.models);
    this.world = new World(this.viewport, this.models);
    this.world.addEventListener('stats', (e) => { this.worldStats = e.detail; });
    this.vehicles = new VehicleEditor(this);
    this.houses = new HouseEditor(this);
    this.mapPanels = $('#right').innerHTML;  // restored when the vehicle or houses editor gives the panel back
    this.selection = new Selection();
    this.doc = null;
    this.unsubscribe = null;
    this.placing = null;    // { name, info, ghost }
    this.clipboard = [];
    this.cursor = null;
    this.pivot = new THREE.Object3D();
    this.viewport.scene.add(this.pivot);
    this.dragStart = null;
    this.mode = 'translate';
    this.decor = null;        // { interiorId, title, onSave, onExit, ... } while the props of an interior are edited
    this.decorReturn = null;  // the map that was open before the decor mode
    this.decorBar = h('div', { id: 'decor-bar', class: 'banner decor-bar', hidden: true },
      h('span', { id: 'decor-text' }),
      h('button', { class: 'primary', title: 'Выйти из режима декора', onclick: () => this.leaveDecor() }, 'Готово'));
    $('#view').append(this.decorBar);

    this.selection.onChange((ids) => {
      this.objects.setSelected(ids);
      this.attachGizmo();
      renderInspector(this);
      renderOutliner(this);
    });
    this.bindViewport();
    this.bindToolbar();
    this.bindKeys();
    this.viewport.onFrame.push(() => this.updateHud());
  }

  // ------------------------------------------------------------------ maps

  async refreshMaps() {
    try {
      renderMaps(this, await api.maps());
    } catch (e) {
      toast('Не удалось получить карты: ' + e.message, 'error');
    }
  }

  async openMap(name) {
    // Another map while the decor is open: leave the decor first, but stay on this tab.
    if (this.decor && !(await this.leaveDecor({ toHouses: false }))) return;
    if (this.doc && this.doc.name === name) return;
    if (this.doc && this.doc.dirty && !(await confirmBox('Несохранённые изменения', `В карте «${this.doc.name}» есть несохранённые изменения. Открыть другую карту без сохранения?`))) return;
    try {
      const json = await api.map(name);
      this.setDocument(new MapDocument(name, json));
      // The camera goes to the map's objects.
      const objs = this.doc.list();
      if (objs.length) {
        const c = objs.reduce((a, o) => a.map((v, i) => v + o.pos[i] / objs.length), [0, 0, 0]);
        this.viewport.lookAt(new THREE.Vector3(...c), 60);
      }
      setStatus(`Открыта карта ${name}: ${objs.length} объектов`);
      this.refreshMaps();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  closeMap() {
    this.setDocument(null);
    this.refreshMaps();
  }

  setDocument(doc) {
    if (this.unsubscribe) this.unsubscribe();
    this.doc = doc;
    this.selection.clear();
    this.objects.setDocument(doc);
    if (doc) {
      this.unsubscribe = doc.onChange((ids) => {
        if (ids) {
          this.objects.sync(ids);
          this.selection.keepExisting(doc);
          if (!this.dragStart) this.attachGizmo();
        }
        renderInspector(this);
        renderOutliner(this);
        renderMapProps(this);
        this.updateTitle();
      });
      doc.history.onChange(() => this.updateTitle());
    }
    renderInspector(this);
    renderOutliner(this);
    renderMapProps(this);
    renderIssues([]);
    this.updateTitle();
  }

  updateTitle() {
    if (this.houses.active) {
      this.houses.syncToolbar();
      return;
    }
    const doc = this.doc;
    this.updateDecorBar();
    $('#doc-title').textContent = doc ? (doc.decor ? doc.decor.title : `${doc.name}${doc.meta.name && doc.meta.name !== doc.name ? ` — ${doc.meta.name}` : ''}`) : 'карта не открыта';
    $('#doc-dirty').hidden = !(doc && doc.dirty);
    $('#btn-save').disabled = !doc;
    $('#btn-undo').disabled = !(doc && doc.history.canUndo);
    $('#btn-redo').disabled = !(doc && doc.history.canRedo);
    document.title = doc ? `${doc.dirty ? '● ' : ''}${doc.decor ? doc.decor.title : doc.name} — GoMP Studio` : 'GoMP Studio';
  }

  async save() {
    if (!this.doc) return;
    if (this.decor) return this.saveDecor();
    try {
      const r = await api.saveMap(this.doc.name, this.doc.toJSON());
      this.doc.markSaved();
      this.updateTitle();
      renderIssues(r.issues);
      const warnings = (r.issues || []).length;
      setStatus(`Сохранено: ${this.doc.name} (${this.doc.objects.size} объектов)${warnings ? ` · предупреждений: ${warnings}` : ''} — сервер обновит объекты сам`);
      toast(`Карта «${this.doc.name}» сохранена — в игре она уже обновилась`);
      this.refreshMaps();
    } catch (e) {
      renderIssues(e.body && e.body.issues);
      toast(`Не сохранено: ${e.message}`, 'error');
    }
  }

  // ------------------------------------------------------------------ decor of an interior

  // The props of a house interior are edited as a map document, so the whole map
  // editor (catalog, gizmo, inspector, undo) works unchanged; the interior's
  // game geometry and its spawn/exit markers stay on screen, read-only.
  // opts: { interiorId, title, objects, spawn, heading, onSave(props) -> Promise<boolean>, onExit() }
  async editDecor(opts) {
    if (this.decor) return;
    if (this.doc && this.doc.dirty && !(await confirmBox('Несохранённые изменения', `В карте «${this.doc.name}» есть несохранённые изменения. Открыть декор без сохранения?`))) return;
    this.stopPlacing();
    this.decorReturn = this.doc ? this.doc.name : null;
    this.decor = opts;  // before the tab switch: the houses tab must keep the interior on screen
    this.houses.holdForDecor();
    const doc = new MapDocument(`decor:${opts.interiorId}`, { name: opts.title, objects: opts.objects });
    doc.decor = opts;
    await this.showTab('catalog');
    this.setDocument(doc);
    this.viewport.lookAt(new THREE.Vector3(...opts.spawn), 8, opts.heading);
    $('#view').classList.add('decor');
    setStatus(`${opts.title}: ${doc.objects.size} предметов — ставьте новые из каталога, Ctrl+S сохраняет в дома`);
  }

  // toHouses: back to the houses tab with the interior selected, and the earlier map
  // reopened. Otherwise (another map is being opened) only the decor is dropped.
  async leaveDecor({ toHouses = true } = {}) {
    const d = this.decor;
    if (!d) return true;
    if (this.doc && this.doc.dirty && !(await confirmBox('Несохранённые изменения', 'Декор интерьера не сохранён. Выйти без сохранения?'))) return false;
    this.stopPlacing();
    this.decor = null;
    $('#view').classList.remove('decor');
    const back = this.decorReturn;
    this.decorReturn = null;
    this.setDocument(null);
    if (!toHouses) {
      this.houses.releaseDecor();
      return true;
    }
    if (back) await this.openMap(back);
    await this.showTab('houses');
    if (d.onExit) d.onExit();
    return true;
  }

  async saveDecor() {
    const d = this.decor;
    const doc = this.doc;
    if (!d || !doc) return;
    if (doc.objects.size > MAX_PROPS) {
      toast(`В интерьере не больше ${MAX_PROPS} предметов декора, сейчас ${doc.objects.size}: удалите лишние.`, 'error', 7000);
      return;
    }
    const ok = await d.onSave(objectsToProps(doc.list()));
    if (!ok) return;  // the houses editor has told why
    doc.markSaved();
    this.updateTitle();
    setStatus(`${d.title}: сохранено ${doc.objects.size} предметов — игроки внутри увидят их сразу`);
    toast(`Декор сохранён: ${doc.objects.size} предметов`);
  }

  updateDecorBar() {
    const d = this.decor;
    this.decorBar.hidden = !d;
    if (d && this.doc) $('#decor-text').textContent = `Декор интерьера «${d.title.replace(/^Декор:\s*/, '')}» · ${this.doc.objects.size} / ${MAX_PROPS}`;
  }

  // ------------------------------------------------------------------ selection and gizmo

  select(id, add = false) {
    if (!id) {
      if (!add) this.selection.clear();
      return;
    }
    if (add) this.selection.toggle(id);
    else this.selection.set([id]);
  }

  attachGizmo() {
    if (this.houses.active) return;  // the gizmo belongs to the houses tab
    const id = this.selection.primary;
    const node = id && this.objects.node(id);
    if (!node) {
      this.viewport.gizmo.detach();
      return;
    }
    this.pivot.position.copy(node.position);
    this.pivot.quaternion.copy(node.quaternion);
    this.viewport.gizmo.attach(this.pivot);
  }

  bindViewport() {
    const vp = this.viewport;
    vp.addEventListener('pick', (e) => {
      if (this.vehicles.active || this.houses.active) return;  // the showroom has nothing to pick; houses pick their own markers
      const { id, shift, ctrl, point } = e.detail;
      if (this.placing) {
        if (point) this.place(point);
        return;
      }
      this.select(id, shift || ctrl);
    });
    vp.addEventListener('hover', (e) => {
      this.hoverPoint = e.detail.point;
      if (this.placing && this.placing.ghost && e.detail.point) {
        const p = placeOnGround([e.detail.point.x, e.detail.point.y, e.detail.point.z], this.placing.info, this.snapMove());
        this.placing.ghost.position.set(...p);
      }
    });
    vp.addEventListener('gizmostart', () => {
      if (!this.doc || this.houses.active) return;
      this.dragStart = {
        objects: Object.fromEntries(this.selection.ids.map((id) => [id, { pos: this.doc.get(id).pos.slice(), rot: this.doc.get(id).rot.slice() }])),
        pivot: { pos: this.pivot.position.toArray(), quat: this.pivot.quaternion.toArray() },
      };
    });
    vp.addEventListener('gizmochange', () => {
      if (this.houses.active || !this.dragStart || !this.doc) return;
      const now = { pos: this.pivot.position.toArray(), quat: this.pivot.quaternion.toArray() };
      const patches = dragPatches(this.dragStart.objects, this.dragStart.pivot, now, this.mode);
      this.doc.update(patches, this.mode === 'translate' ? 'переместить' : 'повернуть', 'gizmo');
    });
    vp.addEventListener('gizmoend', () => {
      if (this.houses.active) return;
      this.dragStart = null;
      if (this.doc) this.doc.history.seal();
      this.attachGizmo();
    });
  }

  setMode(mode) {
    this.mode = mode;
    this.viewport.gizmo.setMode(mode);
    this.houses.onModeChange();
    $$('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  }

  snapMove() { return Number($('#snap-move').value); }

  applySnap() {
    const move = this.snapMove();
    const rot = Number($('#snap-rot').value);
    this.viewport.gizmo.setTranslationSnap(move || null);
    this.viewport.gizmo.setRotationSnap(rot ? rot * DEG : null);
  }

  // ------------------------------------------------------------------ editing

  startPlacing(info) {
    if (!this.doc) {
      toast('Сначала откройте или создайте карту', 'warning');
      return;
    }
    this.stopPlacing();
    const size = info.bbMax.map((v, i) => Math.max(0.05, v - info.bbMin[i]));
    // The model where it would stand (its box until the model arrives).
    const ghost = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial({ color: 0x20b8cd, transparent: true, opacity: 0.25, depthWrite: false }));
    box.geometry.translate(...info.bbMin.map((v, i) => v + size[i] / 2));
    ghost.add(box);
    this.models.instance(info.hash).then((model) => { if (model && this.placing && this.placing.ghost === ghost) ghost.add(model); });
    this.viewport.scene.add(ghost);
    // A model the game has no name for goes into the map as its hash (the server accepts numbers).
    this.placing = { model: modelOf(info), info, ghost };
    $('#placing').hidden = false;
    $('#placing').textContent = `Ставим ${this.placing.model}: клик по миру · Esc — хватит`;
    renderCatalog(this, this.catalogResults || [], this.catalogState, this.catalogMore);
  }

  stopPlacing() {
    if (!this.placing) return;
    this.viewport.scene.remove(this.placing.ghost);
    this.placing.ghost.children[0].geometry.dispose();
    this.placing = null;
    $('#placing').hidden = true;
    renderCatalog(this, this.catalogResults || [], this.catalogState, this.catalogMore);
  }

  place(point) {
    const p = placeOnGround([point.x, point.y, point.z], this.placing.info, this.snapMove());
    // Facing the camera, rounded to the rotation step.
    const yawStep = Number($('#snap-rot').value) || 15;
    const cam = this.viewport.camera.position;
    const yaw = Math.round((Math.atan2(-(cam.x - p[0]), cam.y - p[1]) / DEG) / yawStep) * yawStep;
    if (this.decor && this.doc.objects.size >= MAX_PROPS) {
      toast(`В интерьере не больше ${MAX_PROPS} предметов декора`, 'warning');
      return;
    }
    const [id] = this.doc.add([{ model: this.placing.model, pos: p, rot: [0, 0, yaw] }], 'поставить');
    this.selection.set([id]);
  }

  removeSelection() {
    if (!this.doc || !this.selection.size) return;
    this.doc.remove(this.selection.ids);
    this.selection.clear();
  }

  duplicate() {
    if (!this.doc || !this.selection.size) return;
    const ids = this.doc.duplicate(this.selection.ids, [1, 1, 0]);
    this.selection.set(ids);
  }

  copy() {
    if (!this.doc) return;
    this.clipboard = this.selection.ids.map((id) => JSON.parse(JSON.stringify(this.doc.get(id))));
    setStatus(`Скопировано объектов: ${this.clipboard.length}`);
  }

  paste() {
    if (!this.doc || !this.clipboard.length) return;
    const at = this.hoverPoint ? [this.hoverPoint.x, this.hoverPoint.y, this.hoverPoint.z] : this.viewport.target.toArray();
    const ids = this.doc.add(pasteAt(this.clipboard, at), 'вставить');
    this.selection.set(ids);
  }

  focusSelection() {
    const node = this.selection.primary && this.objects.node(this.selection.primary);
    if (node) this.viewport.lookAt(node.position.clone(), 15);
  }

  // Puts the selected objects on the ground of the world under them.
  async dropToGround() {
    if (!this.doc || !this.selection.size) return;
    const patches = {};
    let missing = 0;
    for (const id of this.selection.ids) {
      const o = this.doc.get(id);
      // Inside an interior a ray from far above would stop on the ceiling.
      const z = this.viewport.groundAt(o.pos[0], o.pos[1], o.pos[2] + (this.decor ? 1.5 : 50));
      if (z === null) {
        missing++;
        continue;
      }
      const info = await modelInfo(o.model);
      patches[id] = { pos: placeOnGround([o.pos[0], o.pos[1], z], info) };
    }
    if (Object.keys(patches).length) this.doc.update(patches, 'на землю');
    if (missing) toast(`Под ${missing} объектами нет загруженного мира`, 'warning');
  }

  // ------------------------------------------------------------------ toolbar, keys, status

  bindToolbar() {
    $('#btn-save').onclick = () => (this.houses.active ? this.houses.save() : this.save());
    $('#btn-undo').onclick = () => (this.houses.active ? this.houses.undo() : this.doc && this.doc.undo());
    $('#btn-redo').onclick = () => (this.houses.active ? this.houses.redo() : this.doc && this.doc.redo());
    $('#btn-new-map').onclick = () => newMap(this);
    $('#btn-reload-maps').onclick = () => this.refreshMaps();
    $('#btn-cursor').onclick = () => this.goToCursor();
    $$('#mode button').forEach((b) => { b.onclick = () => this.setMode(b.dataset.mode); });
    $$('#space button').forEach((b) => {
      b.onclick = () => {
        this.viewport.gizmo.setSpace(b.dataset.space);
        $$('#space button').forEach((x) => x.classList.toggle('on', x === b));
      };
    });
    $('#world-on').onchange = (e) => this.world.setEnabled(e.target.checked);
    $('#snap-move').onchange = () => this.applySnap();
    $('#snap-rot').onchange = () => this.applySnap();
    this.applySnap();
    $$('.tabs button').forEach((b) => { b.onclick = () => this.showTab(b.dataset.tab); });
    $('#outliner-filter').oninput = () => renderOutliner(this);
    let timer = null;
    $('#catalog-search').oninput = (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => this.searchCatalog(e.target.value), 200);
    };
    $('#catalog-category').onchange = () => this.searchCatalog($('#catalog-search').value);
    $('#catalog-more').onclick = () => this.searchCatalog($('#catalog-search').value, true);

  }

  async showTab(tab) {
    const houses = tab === 'houses';
    // The houses tab while the decor is open: the decor ends (and the interior is selected there).
    if (houses && this.decor) {
      await this.leaveDecor();
      return;
    }
    // The showroom and the houses both own the right panel and the gizmo.
    if (houses && this.vehicles.active) {
      if (this.vehicles.dirty && !(await confirmBox('Несохранённые изменения', 'Изменения машины не сохранены. Закрыть её и открыть дома?'))) return;
      this.vehicles.close();
    }
    $$('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
    $$('.panel').forEach((p) => p.classList.toggle('on', p.dataset.panel === tab));
    this.houses.setActive(houses);
    const help = $('#help');
    if (help.dataset.map === undefined) help.dataset.map = help.textContent;
    help.textContent = houses
      ? 'ЛКМ — выбрать дом/точку · 1/2 — двигать/поворачивать · F — к выбранному · Del — удалить дом · Ctrl+Z/Y — отмена/повтор · Ctrl+S — сохранить дома'
      : help.dataset.map;
  }

  // append: the next page of the same search ("Показать ещё").
  async searchCatalog(q, append = false) {
    const seq = this.catalogSeq = (this.catalogSeq || 0) + 1;  // a slow answer must not overwrite a newer search
    const have = append ? (this.catalogResults || []) : [];
    try {
      const page = await api.catalog(q, { cat: $('#catalog-category').value, offset: have.length });
      if (seq !== this.catalogSeq) return;
      this.catalogResults = have.concat(page.items);
      this.catalogMore = this.catalogResults.length < page.total;
      this.catalogState = page.total ? `Найдено: ${page.total}` : 'Ничего не найдено';
    } catch (e) {
      if (seq !== this.catalogSeq) return;
      this.catalogResults = [];
      this.catalogMore = false;
      this.catalogState = e.status === 503 ? `Файлы игры: ${e.message}` : e.message;
    }
    renderCatalog(this, this.catalogResults, this.catalogState, this.catalogMore);
  }

  async loadCategories() {
    const select = $('#catalog-category');
    try {
      const cats = await api.categories();
      const keep = select.value;
      select.replaceChildren(h('option', { value: '' }, 'Все модели'),
        ...cats.map((c) => h('option', { value: c.id }, `${c.label} (${c.count})`)));
      select.value = keep;
    } catch { /* the game is not ready: only "Все модели" */ }
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.code === 'KeyS') {
        e.preventDefault();
        if (this.vehicles.active) this.vehicles.save();
        else if (this.houses.active) this.houses.save();
        else this.save();
        return;
      }
      if (typing()) return;
      if (this.houses.active) {
        // Map shortcuts (copy, delete, undo of the map) must not touch the map from this tab.
        if (!this.houses.onKey(e, ctrl) && !ctrl) {
          if (e.code === 'Digit1') this.setMode('translate');
          if (e.code === 'Digit2') this.setMode('rotate');
        }
        return;
      }
      if (ctrl && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) this.doc?.redo(); else this.doc?.undo(); return; }
      if (ctrl && e.code === 'KeyY') { e.preventDefault(); this.doc?.redo(); return; }
      if (ctrl && e.code === 'KeyD') { e.preventDefault(); this.duplicate(); return; }
      if (ctrl && e.code === 'KeyC') { this.copy(); return; }
      if (ctrl && e.code === 'KeyV') { this.paste(); return; }
      if (ctrl) return;
      switch (e.code) {
        case 'Delete': this.removeSelection(); break;
        case 'Escape': if (this.placing) this.stopPlacing(); else this.selection.clear(); break;
        case 'KeyF': this.focusSelection(); break;
        case 'Digit1': this.setMode('translate'); break;
        case 'Digit2': this.setMode('rotate'); break;
        default: break;
      }
    });
    window.addEventListener('beforeunload', (e) => {
      if ((this.doc && this.doc.dirty) || this.houses.dirty) e.preventDefault();
    });
  }

  // The right panel of the map (after the vehicle editor had it).
  showMapPanels() {
    $('#right').innerHTML = this.mapPanels;
    renderInspector(this);
    renderMapProps(this);
    renderIssues([]);
  }

  updateHud() {
    const t = this.viewport.target;
    const p = this.hoverPoint;
    const w = this.worldStats;
    $('#hud-pos').textContent = `цель ${t.x.toFixed(1)} ${t.y.toFixed(1)} ${t.z.toFixed(1)}${p ? ` · курсор ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}` : ''}`
      + (w && this.world.enabled ? ` · мир: ${w.entities} объектов, ${w.models} моделей${w.loading ? `, грузится ${w.loading}` : ''}` : '');
  }

  setGame(state, status) {
    const pill = $('#gta-state');
    pill.className = `pill ${state}`;
    pill.textContent = `игра: ${status}`;
    pill.title = status;
    this.world.ready = state === 'ready';
    if (state === 'ready') {
      forgetModelInfo();
      this.models.clear();
      this.world.clear();
      this.objects.setDocument(this.doc);
      this.objects.setSelected(this.selection.ids);
      this.attachGizmo();
      this.loadCategories().then(() => this.searchCatalog($('#catalog-search').value));
      this.vehicles.loadPalette();
      this.houses.onGameReady();
    }
  }

  setCursor(c, jump) {
    this.cursor = c;
    $('#btn-cursor').disabled = !c;
    if (c && jump) {
      this.goToCursor();
      toast(`${c.name || 'Админ'} в игре: ${c.x.toFixed(1)} ${c.y.toFixed(1)} ${c.z.toFixed(1)} — камера перенесена`);
    }
  }

  goToCursor() {
    const c = this.cursor;
    if (c) this.viewport.lookAt(new THREE.Vector3(c.x, c.y, c.z), 25, c.heading);
  }
}

async function main() {
  const studio = new Studio();
  window.studio = studio;  // for the console
  try {
    const s = await api.status();
    $('#maps-dir').textContent = s.maps;
    studio.setGame(s.gta.state, s.gta.status);
  } catch (e) {
    toast('Studio не отвечает: ' + e.message, 'error');
  }
  studio.setCursor(await api.cursor().catch(() => null), false);
  listen((type, data) => {
    if (type === 'gta') studio.setGame(data.state, data.status);
    if (type === 'cursor') studio.setCursor(data, true);
    if (type === 'maps') studio.refreshMaps();
    if (type === 'houses') studio.houses.onFileChanged();
  });
  await studio.refreshMaps();
  await studio.vehicles.init();
  await studio.houses.init();
}

main();

export { Studio, eulerToQuat, EULER_ORDER };
