// GoMP Studio in the browser: opens maps of the server, shows them in 3D and
// edits them (catalog, gizmo, inspector, undo/redo); Ctrl+S sends the map to
// the Studio, which writes it where the GoMP server picks it up at once.
import * as THREE from 'three';
import { api, listen } from './api.js';
import { $, $$, h, toast, setStatus, typing, confirmBox } from './ui/dom.js';
import { Viewport } from './scene/viewport.js';
import { MapObjects, forgetModelInfo, modelInfo } from './scene/objects.js';
import { MapDocument } from './editor/document.js';
import { Selection } from './editor/selection.js';
import { dragPatches, placeOnGround, pasteAt } from './editor/transform.js';
import { DEG, EULER_ORDER, eulerToQuat } from './math/gta.js';
import { renderMaps, newMap, renderOutliner, renderCatalog, renderInspector, renderMapProps, renderIssues } from './ui/panels.js';

class Studio {
  constructor() {
    this.viewport = new Viewport($('#viewport'));
    this.objects = new MapObjects(this.viewport);
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
    const doc = this.doc;
    $('#doc-title').textContent = doc ? `${doc.name}${doc.meta.name && doc.meta.name !== doc.name ? ` — ${doc.meta.name}` : ''}` : 'карта не открыта';
    $('#doc-dirty').hidden = !(doc && doc.dirty);
    $('#btn-save').disabled = !doc;
    $('#btn-undo').disabled = !(doc && doc.history.canUndo);
    $('#btn-redo').disabled = !(doc && doc.history.canRedo);
    document.title = doc ? `${doc.dirty ? '● ' : ''}${doc.name} — GoMP Studio` : 'GoMP Studio';
  }

  async save() {
    if (!this.doc) return;
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
      if (!this.doc) return;
      this.dragStart = {
        objects: Object.fromEntries(this.selection.ids.map((id) => [id, { pos: this.doc.get(id).pos.slice(), rot: this.doc.get(id).rot.slice() }])),
        pivot: { pos: this.pivot.position.toArray(), quat: this.pivot.quaternion.toArray() },
      };
    });
    vp.addEventListener('gizmochange', () => {
      if (!this.dragStart || !this.doc) return;
      const now = { pos: this.pivot.position.toArray(), quat: this.pivot.quaternion.toArray() };
      const patches = dragPatches(this.dragStart.objects, this.dragStart.pivot, now, this.mode);
      this.doc.update(patches, this.mode === 'translate' ? 'переместить' : 'повернуть', 'gizmo');
    });
    vp.addEventListener('gizmoend', () => {
      this.dragStart = null;
      if (this.doc) this.doc.history.seal();
      this.attachGizmo();
    });
  }

  setMode(mode) {
    this.mode = mode;
    this.viewport.gizmo.setMode(mode);
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
    const ghost = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial({ color: 0x20b8cd, transparent: true, opacity: 0.4, depthWrite: false }));
    ghost.geometry.translate(...info.bbMin.map((v, i) => v + size[i] / 2));
    this.viewport.scene.add(ghost);
    this.placing = { model: info.name, info, ghost };
    $('#placing').hidden = false;
    $('#placing').textContent = `Ставим ${info.name}: клик по миру · Esc — хватит`;
    renderCatalog(this, this.catalogResults || [], this.catalogState);
  }

  stopPlacing() {
    if (!this.placing) return;
    this.viewport.scene.remove(this.placing.ghost);
    this.placing.ghost.geometry.dispose();
    this.placing = null;
    $('#placing').hidden = true;
    renderCatalog(this, this.catalogResults || [], this.catalogState);
  }

  place(point) {
    const p = placeOnGround([point.x, point.y, point.z], this.placing.info, this.snapMove());
    // Facing the camera, rounded to the rotation step.
    const yawStep = Number($('#snap-rot').value) || 15;
    const cam = this.viewport.camera.position;
    const yaw = Math.round((Math.atan2(-(cam.x - p[0]), cam.y - p[1]) / DEG) / yawStep) * yawStep;
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
      const z = this.viewport.groundAt(o.pos[0], o.pos[1], o.pos[2] + 50);
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
    $('#btn-save').onclick = () => this.save();
    $('#btn-undo').onclick = () => this.doc && this.doc.undo();
    $('#btn-redo').onclick = () => this.doc && this.doc.redo();
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
    $('#snap-move').onchange = () => this.applySnap();
    $('#snap-rot').onchange = () => this.applySnap();
    this.applySnap();
    $$('.tabs button').forEach((b) => {
      b.onclick = () => {
        $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
        $$('.panel').forEach((p) => p.classList.toggle('on', p.dataset.panel === b.dataset.tab));
      };
    });
    $('#outliner-filter').oninput = () => renderOutliner(this);
    let timer = null;
    $('#catalog-search').oninput = (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => this.searchCatalog(e.target.value), 200);
    };
    $('#vehicles-panel').append(h('p', { class: 'hint' }, 'Редактор машин появится на следующем этапе.'));
  }

  async searchCatalog(q) {
    try {
      this.catalogResults = await api.catalog(q, 100);
      this.catalogState = this.catalogResults.length ? `Найдено: ${this.catalogResults.length}${this.catalogResults.length === 100 ? '+' : ''}` : 'Ничего не найдено';
    } catch (e) {
      this.catalogResults = [];
      this.catalogState = e.status === 503 ? `Файлы игры: ${e.message}` : e.message;
    }
    renderCatalog(this, this.catalogResults, this.catalogState);
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.code === 'KeyS') {
        e.preventDefault();
        this.save();
        return;
      }
      if (typing()) return;
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
      if (this.doc && this.doc.dirty) e.preventDefault();
    });
  }

  updateHud() {
    const t = this.viewport.target;
    const p = this.hoverPoint;
    $('#hud-pos').textContent = `цель ${t.x.toFixed(1)} ${t.y.toFixed(1)} ${t.z.toFixed(1)}${p ? ` · курсор ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}` : ''}`;
  }

  setGame(state, status) {
    const pill = $('#gta-state');
    pill.className = `pill ${state}`;
    pill.textContent = `игра: ${status}`;
    pill.title = status;
    if (state === 'ready') {
      forgetModelInfo();
      this.objects.setDocument(this.doc);
      this.objects.setSelected(this.selection.ids);
      this.attachGizmo();
      this.searchCatalog($('#catalog-search').value);
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
  });
  await studio.refreshMaps();
}

main();

export { Studio, eulerToQuat, EULER_ORDER };
