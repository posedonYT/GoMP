// The vehicle editor: the list of add-on packs (left), the vehicle in the
// showroom (center) and its forms (right): data, handling, colours, mod kits,
// lights, problems and the raw XML files. Only changed values are sent
// (PUT /api/vehicles/<pack>/<model>); the game picks them up at its next start.
import * as THREE from 'three';
import { $, $$, h, toast, setStatus, confirmBox } from './dom.js';
import { Garage } from '../vehicles/garage.js';

const NUM = (v) => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v);

export class VehicleEditor {
  constructor(studio) {
    this.studio = studio;
    this.garage = new Garage();
    this.view = null;    // the vehicle as the server returned it
    this.edits = null;   // what changed: { data, handling, variation, kits, lights }
    this.schema = null;
    this.palette = [];
    this.colorIndex = 0; // which colour variant the preview shows
  }

  get active() { return !!this.view; }
  get dirty() { return !!this.edits && Object.values(this.edits).some((e) => e && (Array.isArray(e) || Object.keys(e).length)); }

  async init() {
    this.schema = await fetch('/api/vehicles/schema').then((r) => r.json()).catch(() => null);
    this.loadPalette();
    await this.renderPacks();
  }

  async loadPalette() {
    const r = await fetch('/api/vehicles/palette').catch(() => null);
    this.palette = r && r.ok ? await r.json() : [];
  }

  colorOf(index) {
    const c = this.palette.find((p) => p.index === index);
    return c ? c.rgb : '#888888';
  }

  // ------------------------------------------------------------------ list

  async renderPacks() {
    const panel = $('#vehicles-panel');
    let packs = [];
    try {
      packs = await fetch('/api/vehicles').then((r) => r.json());
    } catch (e) {
      panel.replaceChildren(h('p', { class: 'hint' }, 'Не удалось получить паки: ' + e.message));
      return;
    }
    const list = h('ul', { class: 'list compact' });
    for (const p of packs) {
      list.append(h('li', { class: 'group' }, p.pack));
      for (const m of p.models) {
        const on = this.view && this.view.pack === p.pack && this.view.model === m.model;
        list.append(h('li', { class: on ? 'on' : '', onclick: () => this.open(p.pack, m.model) },
          h('span', { class: 'grow' }, m.gameName || m.model), h('span', { class: 'tag' }, m.model)));
      }
    }
    if (!packs.length) list.append(h('li', { class: 'hint' }, 'В client-dist/addons нет паков.'));
    panel.replaceChildren(...[
      list,
      this.view ? h('button', { onclick: () => this.close() }, '← Вернуться к карте') : null,
      h('p', { class: 'hint' }, 'Изменения машин записываются в dlc.rpf пака (копия — dlc.rpf.bak) и действуют после перезапуска игры.'),
    ].filter(Boolean));
  }

  // ------------------------------------------------------------------ open / close

  async open(pack, model) {
    if (this.dirty && !(await confirmBox('Несохранённые изменения', 'Изменения этой машины не сохранены. Открыть другую?'))) return;
    try {
      const view = await this.fetchView(pack, model);
      this.setView(view);
      setStatus(`Загрузка модели ${model}…`);
      const size = await this.garage.load(pack, model).catch((e) => { toast('3D: ' + e.message, 'warning'); return null; });
      this.studio.viewport.showScene(this.garage.scene, new THREE.Vector3(0, 0, size ? size.z / 2 : 0.8), size ? Math.max(size.x, size.y) * 1.3 + 2 : 6);
      this.applyPaint();
      setStatus(`Машина ${pack}/${model}`);
      this.renderPacks();
      this.renderToolbar();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  close() {
    this.view = null;
    this.edits = null;
    this.studio.viewport.showScene(null);
    $('#vehicle-tools')?.remove();
    this.studio.showMapPanels();
    this.renderPacks();
  }

  async fetchView(pack, model) {
    const r = await fetch(`/api/vehicles/${encodeURIComponent(pack)}/${encodeURIComponent(model)}`);
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

  setView(view) {
    this.view = view;
    this.edits = { data: {}, handling: {}, variation: null, kits: null, lights: null };
    this.colorIndex = 0;
    this.render();
  }

  renderToolbar() {
    $('#vehicle-tools')?.remove();
    const g = this.garage;
    const btn = (group, label) => h('button', {
      disabled: !g.has(group),
      onclick: (e) => e.target.classList.toggle('on', g.toggle(group)),
    }, label);
    $('#view').append(h('div', { id: 'vehicle-tools', class: 'vehicle-tools' },
      btn('doors', 'Двери'), btn('bonnet', 'Капот'), btn('boot', 'Багажник')));
  }

  applyPaint() {
    const colors = (this.edits && this.edits.variation && this.edits.variation.colors) || (this.view.variation && this.view.variation.colors) || [];
    const c = colors[this.colorIndex] || [0, 0, 0, 0];
    this.garage.setPaint(this.colorOf(c[0]), this.colorOf(c[1]));
  }

  // ------------------------------------------------------------------ saving

  async save() {
    if (!this.view || !this.dirty) return;
    const patch = {};
    if (Object.keys(this.edits.data).length) patch.data = this.edits.data;
    if (Object.keys(this.edits.handling).length) patch.handling = this.edits.handling;
    if (this.edits.variation) patch.variation = this.edits.variation;
    if (this.edits.kits) patch.kits = this.edits.kits;
    if (this.edits.lights) patch.lights = this.edits.lights;
    const { pack, model } = this.view;
    const r = await fetch(`/api/vehicles/${encodeURIComponent(pack)}/${encodeURIComponent(model)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    const body = await r.json();
    if (!r.ok) {
      toast('Не сохранено: ' + (body.error || r.status), 'error');
      return;
    }
    this.setView(body);
    this.applyPaint();
    toast(`${model}: сохранено в пак ${pack}. Перезапустите игру, чтобы увидеть изменения.`);
    this.renderPacks();
  }

  async ownHandling() {
    const { pack, model } = this.view;
    const r = await fetch(`/api/vehicles/${encodeURIComponent(pack)}/${encodeURIComponent(model)}/handling`, { method: 'POST' });
    const body = await r.json();
    if (!r.ok) return toast(body.error || `HTTP ${r.status}`, 'error');
    this.setView(body);
    this.applyPaint();
    return toast(`У ${model} теперь свои характеристики (${body.handling.name})`);
  }

  // ------------------------------------------------------------------ forms

  render() {
    const v = this.view;
    const box = $('#right');
    if (!v) return;
    const changed = this.dirty;
    box.replaceChildren(
      h('h3', {}, `${v.data.gameName || v.model} · ${v.pack}`),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', disabled: !changed, onclick: () => this.save() }, 'Сохранить в пак'),
        h('button', { onclick: () => this.files() }, 'XML-файлы')),
      this.section('Данные', this.dataForm()),
      this.section('Характеристики', this.handlingForm()),
      this.section('Цвета', this.colorsForm()),
      this.section('Тюнинг', this.kitsForm()),
      this.section('Свет', this.lightsForm()),
      this.section('Проверка', h('ul', { class: 'issues' }, ...(v.issues.length ? v.issues.map((i) => h('li', { class: i.severity }, i.message)) : [h('li', { class: 'hint' }, 'Проблем нет.')]))),
    );
  }

  section(title, body) {
    return h('details', { open: true, class: 'vsec' }, h('summary', {}, title), body);
  }

  field(label, input, unit, help) {
    return h('div', { class: 'field', title: help || '' }, h('label', {}, label), h('div', { class: 'with-unit' }, input, unit ? h('span', { class: 'unit' }, unit) : null));
  }

  touched() {
    $('#right .actions .primary').disabled = !this.dirty;
  }

  dataForm() {
    const v = this.view;
    const rows = [];
    for (const f of (this.schema && this.schema.data) || []) {
      const name = f.name;
      const cur = name in this.edits.data ? this.edits.data[name] : v.data[name];
      let input;
      if (f.kind === 'Choice' || f.kind === 4) {
        const choices = f.choices.includes(cur) || !cur ? f.choices : [cur, ...f.choices];
        input = h('select', { onchange: (e) => { this.edits.data[name] = e.target.value; this.touched(); } },
          ...choices.map((c) => h('option', { value: c, selected: c === cur }, c)));
      } else if (f.kind === 'Flags' || f.kind === 5) {
        input = h('input', { type: 'text', value: (cur || []).join(' '), onchange: (e) => { this.edits.data[name] = e.target.value.split(/\s+/).filter(Boolean); this.touched(); } });
      } else {
        input = h('input', { type: 'text', value: cur || '', onchange: (e) => { this.edits.data[name] = e.target.value.trim(); this.touched(); } });
      }
      rows.push(this.field(f.label, input, null, f.help));
    }
    return h('div', {}, ...rows);
  }

  handlingForm() {
    const hv = this.view.handling;
    const head = hv.source === 'game'
      ? h('div', {}, h('p', { class: 'hint' }, `Характеристики общие с машиной игры ${hv.name}. Чтобы менять их, сделайте свою запись:`),
        h('button', { onclick: () => this.ownHandling() }, `Свои характеристики (копия ${hv.name})`))
      : hv.source === 'missing' ? h('p', { class: 'hint' }, `Нет записи ${hv.name}.`) : h('p', { class: 'hint' }, `Запись ${hv.name} в паке.`);
    const groups = new Map();
    for (const f of (this.schema && this.schema.handling) || []) {
      if (!(f.name in hv.fields)) continue;
      if (!groups.has(f.group)) groups.set(f.group, []);
      groups.get(f.group).push(f);
    }
    const readOnly = hv.source !== 'pack';
    const blocks = [];
    for (const [group, fields] of groups) {
      blocks.push(h('div', { class: 'subhead' }, group));
      for (const f of fields) {
        const cur = f.name in this.edits.handling ? this.edits.handling[f.name] : hv.fields[f.name];
        let input;
        if (Array.isArray(cur)) {
          input = h('div', { class: 'vec' }, ...cur.map((x, i) => h('input', {
            type: 'number', step: 0.01, value: NUM(x), disabled: readOnly,
            onchange: (e) => { const next = (this.edits.handling[f.name] || cur).slice(); next[i] = Number(e.target.value); this.edits.handling[f.name] = next; this.touched(); },
          })));
        } else {
          input = h('input', {
            type: 'number', step: f.kind === 'Int' || f.kind === 2 ? 1 : 0.01, value: NUM(cur), disabled: readOnly,
            min: f.min ?? undefined, max: f.max ?? undefined,
            onchange: (e) => { this.edits.handling[f.name] = Number(e.target.value); this.touched(); },
          });
        }
        blocks.push(this.field(f.label, input, f.unit, f.help));
      }
    }
    return h('div', {}, head, ...blocks);
  }

  colorsForm() {
    const v = this.view;
    if (!v.variation) return h('p', { class: 'hint' }, 'У машины нет carvariations.meta.');
    const colors = (this.edits.variation && this.edits.variation.colors) || v.variation.colors.map((c) => c.slice());
    const setColors = (next) => {
      this.edits.variation = { ...(this.edits.variation || {}), colors: next };
      this.touched();
      this.applyPaint();
    };
    const labels = ['Основной', 'Второй', 'Перламутр', 'Диски'];
    const pick = (row, i) => {
      const sel = h('select', {
        onchange: (e) => { const next = colors.map((c) => c.slice()); next[row][i] = Number(e.target.value); setColors(next); this.render(); },
      }, ...(this.palette.length ? this.palette : [{ index: colors[row][i], name: String(colors[row][i]) }]).map((p) =>
        h('option', { value: p.index, selected: p.index === colors[row][i] }, `${p.index} · ${p.name}`)));
      return h('div', { class: 'swatch-row' }, h('span', { class: 'swatch', style: `background:${this.colorOf(colors[row][i])}` }), sel);
    };
    const rows = colors.map((c, row) => h('div', { class: `variant${row === this.colorIndex ? ' on' : ''}` },
      h('div', { class: 'variant-head' },
        h('button', { onclick: () => { this.colorIndex = row; this.applyPaint(); this.render(); } }, row === this.colorIndex ? '● Показан' : 'Показать'),
        h('button', { class: 'danger', disabled: colors.length <= 1, onclick: () => { setColors(colors.filter((_, i) => i !== row)); this.colorIndex = 0; this.render(); } }, 'Убрать')),
      ...labels.map((l, i) => this.field(l, pick(row, i)))));
    return h('div', {},
      h('p', { class: 'hint' }, 'Заводские сочетания цветов: игра выбирает одно из них для машины.'),
      ...rows,
      h('button', { onclick: () => { setColors([...colors, colors[colors.length - 1].slice()]); this.render(); } }, '+ Сочетание'),
      this.field('Свет (id)', h('input', {
        type: 'number', value: (this.edits.variation && this.edits.variation.lightSettings) ?? v.variation.lightSettings ?? '',
        onchange: (e) => { this.edits.variation = { ...(this.edits.variation || {}), lightSettings: Number(e.target.value) }; this.touched(); },
      }), null, 'Настройки фар из carcols.meta'));
  }

  kitsForm() {
    const v = this.view;
    if (!v.kits.length) return h('p', { class: 'hint' }, v.variation && v.variation.kits.length ? `Набор ${v.variation.kits.join(', ')} — из игры.` : 'Нет своего набора тюнинга.');
    const kits = this.edits.kits || v.kits.map((k) => ({ name: k.name, id: k.id, mods: k.mods.map((m) => ({ ...m })) }));
    const touch = () => { this.edits.kits = kits; this.touched(); };
    return h('div', {}, ...kits.map((k) => h('div', {},
      this.field('Набор', h('code', {}, k.name)),
      this.field('id', h('input', { type: 'number', value: k.id, onchange: (e) => { k.id = Number(e.target.value); touch(); } }), null, 'Номер набора: не должен совпадать с игрой и другими паками'),
      h('div', { class: 'subhead' }, `Детали (${k.mods.length})`),
      ...k.mods.map((m) => h('div', { class: 'mod' },
        h('div', { class: 'swatch-row' },
          h('input', { type: 'text', value: m.label || '', title: 'Название в LSC (метка GXT)', onchange: (e) => { m.label = e.target.value; touch(); } }),
          h('button', {
            class: 'try-part',
            dataset: { type: m.type || '', part: m.modelName || '' },
            disabled: !m.modelName,
            title: 'Поставить деталь на машину в 3D',
            onclick: async () => {
              try {
                await this.garage.tryPart(this.view.pack, this.view.model, m);
                this.applyPaint();
              } catch (err) {
                toast(err.message, 'warning');
              }
              // One part per type: trying one takes the other off.
              for (const b of $$('#right .try-part')) b.textContent = this.garage.isTried({ type: b.dataset.type, modelName: b.dataset.part }) ? 'Снять' : 'Примерить';
            },
          }, this.garage.isTried(m) ? 'Снять' : 'Примерить')),
        h('span', { class: 'tag' }, `${m.type || ''} · ${m.modelName || ''}`))))));
  }

  lightsForm() {
    const v = this.view;
    if (!v.lights.length) return h('p', { class: 'hint' }, 'Свет — из игры.');
    const lights = this.edits.lights || v.lights.map((l) => ({ ...l }));
    return h('div', {}, ...lights.map((l) => this.field('id света', h('input', {
      type: 'number', value: l.id, onchange: (e) => { l.id = Number(e.target.value); this.edits.lights = lights; this.touched(); },
    }), null, 'Игра берёт номер по модулю 256; он не должен совпадать с игрой')));
  }

  // ------------------------------------------------------------------ raw XML

  async files() {
    const { pack } = this.view;
    const files = await fetch(`/api/vehicles/${encodeURIComponent(pack)}/files`).then((r) => r.json());
    const area = h('textarea', { spellcheck: false, class: 'xml' });
    const select = h('select', {}, ...files.map((f) => h('option', { value: f }, f)));
    const load = async () => {
      area.value = await fetch(`/api/vehicles/${encodeURIComponent(pack)}/file?path=${encodeURIComponent(select.value)}`).then((r) => r.text());
    };
    select.onchange = load;
    const dlg = h('dialog', { class: 'wide' },
      h('h3', {}, `Файлы пака ${pack}`), select, area,
      h('div', { class: 'row' },
        h('button', { onclick: () => dlg.close() }, 'Закрыть'),
        h('button', {
          class: 'primary',
          onclick: async () => {
            const r = await fetch(`/api/vehicles/${encodeURIComponent(pack)}/file?path=${encodeURIComponent(select.value)}`, { method: 'PUT', body: area.value });
            const body = await r.json();
            if (!r.ok) return toast('Не сохранено: ' + body.error, 'error');
            toast(`${select.value} сохранён`);
            this.setView(await this.fetchView(pack, this.view.model));
            return this.applyPaint();
          },
        }, 'Сохранить файл')));
    dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
    document.body.append(dlg);
    dlg.showModal();
    await load();
  }
}
