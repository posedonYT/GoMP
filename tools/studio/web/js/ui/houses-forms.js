// The right panel of the houses editor: forms for a house, an interior, a garage and a
// class, and the list of problems. Every change goes through editor.edit(),
// which keeps the undo snapshots; fields that the gizmo also moves are
// registered in editor.live so the numbers follow the drag.
import { h } from './dom.js';
import {
  classById, interiorById, interiorOf, usageOf, renameInterior, entranceChoices,
  garageById, garageOf, garageUsageOf, renameGarage, geoKey, MAX_SLOTS,
} from '../houses/model.js';

const round = (v) => Math.round(v * 1000) / 1000;

function field(label, input, unit) {
  return h('div', { class: 'field' }, h('label', {}, label),
    h('div', { class: 'with-unit' }, input, unit ? h('span', { class: 'unit' }, unit) : null));
}

function textInput(value, onchange, attrs = {}) {
  return h('input', { type: 'text', value: value ?? '', onchange: (e) => onchange(e.target.value.trim()), ...attrs });
}

function numberInput(value, onchange, attrs = {}) {
  return h('input', {
    type: 'number',
    step: 1,
    value,
    onchange: (e) => {
      const n = Number(e.target.value);
      if (e.target.value !== '' && Number.isFinite(n)) onchange(n);
    },
    ...attrs,
  });
}

function select(options, value, onchange) {
  return h('select', { onchange: (e) => onchange(e.target.value) },
    ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

// Three number fields over an array of the document; the inputs are put in
// `inputs` so the editor can refresh them while the gizmo moves the point.
function vec3(editor, owner, key, inputs) {
  const row = h('div', { class: 'vec' });
  for (let i = 0; i < 3; i++) {
    const input = numberInput(round(owner[key][i]), (n) => editor.edit(() => { owner[key][i] = n; }), { step: 0.1 });
    inputs.push(input);
    row.append(input);
  }
  return row;
}

function headingInput(editor, owner, key, inputs) {
  const input = numberInput(round(owner[key]), (n) => editor.edit(() => { owner[key] = n; }), { step: 5 });
  inputs.push(input);
  return input;
}

// The inputs that the gizmo also moves: door/heading and gpos/gheading (the garage point) of
// a house; spawn/sheading/exit of an interior or garage; slot/slotHeading/slotRow of a garage slot.
function emptyLive() {
  return { door: [], heading: [], gpos: [], gheading: [], spawn: [], sheading: [], exit: [], slot: [], slotHeading: [], slotRow: null };
}

// The line of the slot list: "Место 3 · x, y, z · 180°".
export function slotLabel(slot, i) {
  return `Место ${i + 1} · ${slot.pos.map(round).join(', ')} · ${round(slot.heading)}°`;
}

// ------------------------------------------------------------------ house

export function houseForm(editor, house) {
  const doc = editor.doc;
  const st = editor.states[house.id];
  const live = editor.live = emptyLive();
  const own = interiorOf(doc, house);
  const cls = classById(doc, house.cls);
  const classOpts = doc.classes.map((c) => [c.id, `${c.name} (${c.id})`]);
  if (!cls) classOpts.unshift([house.cls, `нет класса: ${house.cls}`]);
  const classInterior = cls && interiorById(doc, cls.interior);
  const interiorOpts = [['', `Как у класса: ${classInterior ? classInterior.name : '—'}`],
    ...doc.interiors.map((i) => [i.id, `${i.name} (${i.id})`])];
  const classGarage = cls && garageById(doc, cls.garageInterior);
  const garageOpts = [['', `Как у класса: ${classGarage ? classGarage.name : 'нет'}`],
    ...doc.garages.map((g) => [g.id, `${g.name} (${g.id})`])];
  if (house.garageInterior && !garageById(doc, house.garageInterior)) garageOpts.push([house.garageInterior, `нет гаража: ${house.garageInterior}`]);
  const garage = garageOf(doc, house);
  const owner = st && st.owner
    ? h('p', {}, `Владелец: ${st.ownerName || st.owner}`, st.locked ? ' · закрыт' : '', st.garage ? ' · есть гараж' : '')
    : h('p', { class: 'hint' }, 'Продаётся: владельца нет.');
  return [
    h('h3', {}, `Дом #${house.id}`),
    field('Номер', h('input', { type: 'text', value: house.id, disabled: true })),
    field('Название', textInput(house.name, (v) => editor.edit(() => { house.name = v; }))),
    field('Класс', select(classOpts, house.cls, (v) => editor.edit(() => { house.cls = v; }, { right: true }))),
    field('Цена', numberInput(house.price, (n) => editor.edit(() => { house.price = Math.round(n); }), { min: 1, step: 1000 }), '$'),
    field('Интерьер', select(interiorOpts, house.interior || '', (v) => editor.edit(() => {
      if (v) house.interior = v;
      else delete house.interior;
    }, { right: true }))),
    h('div', { class: 'subhead' }, 'Дверь (вход и покупка, снаружи)'),
    vec3(editor, house, 'door', live.door),
    field('Направление', headingInput(editor, house, 'heading', live.heading), '°'),
    h('p', { class: 'hint' }, 'Направление — куда смотрит игрок, выходя из дома.'),
    h('div', { class: 'actions' },
      h('button', { onclick: () => editor.dropDoorToGround(house) }, 'На землю'),
      h('button', { onclick: () => editor.lookAtHouse(house) }, 'К двери'),
      own ? h('button', { onclick: () => editor.selectInterior(own.id) }, 'Открыть интерьер') : null,
      h('button', { class: 'danger', onclick: () => editor.deleteHouse(house) }, 'Удалить дом')),
    ...garagePointSection(editor, house, garageOpts, garage, live),
    h('div', { class: 'subhead' }, 'Владелец'),
    owner,
  ];
}

// "Въезд в гараж (снаружи)": which garage template the house uses and where cars drive in.
function garagePointSection(editor, house, garageOpts, garage, live) {
  const gp = house.garagePoint;
  const part = editor.sel && editor.sel.part;
  const out = [
    h('div', { class: 'subhead' }, 'Въезд в гараж (снаружи)'),
    field('Интерьер гаража', select(garageOpts, house.garageInterior || '', (v) => editor.edit(() => {
      if (v) house.garageInterior = v;
      else delete house.garageInterior;
    }, { right: true }))),
  ];
  if (gp) {
    out.push(
      h('div', { class: 'actions' },
        h('button', { class: part !== 'garage' ? 'on' : '', onclick: () => editor.selectHousePart(house, 'door') }, 'Двигать дверь'),
        h('button', { class: part === 'garage' ? 'on' : '', onclick: () => editor.selectHousePart(house, 'garage') }, 'Двигать въезд')),
      vec3(editor, gp, 'pos', live.gpos),
      field('Направление', headingInput(editor, gp, 'heading', live.gheading), '°'),
      h('p', { class: 'hint' }, 'Стрелка — куда смотрит машина, выезжая из гаража'),
      h('div', { class: 'actions' },
        h('button', { onclick: () => editor.dropGaragePointToGround(house) }, 'На землю'),
        h('button', { title: 'Ближайший узел дорожной сети игры', onclick: () => editor.snapGaragePointToRoad(house) }, 'Въезд у дороги'),
        h('button', { onclick: () => editor.lookAtGaragePoint(house) }, 'К въезду'),
        h('button', { onclick: () => editor.edit(() => { delete house.garagePoint; }, { right: true }) }, 'Убрать въезд')));
  } else {
    out.push(
      h('p', { class: 'hint' }, 'Метки въезда нет: машины заезжают в гараж у двери (10 м)'),
      h('div', { class: 'actions' },
        h('button', { title: 'Ближайший узел дорожной сети игры', onclick: () => editor.snapGaragePointToRoad(house) }, 'Въезд у дороги'),
        h('button', { title: '6 м перед дверью, на земле', onclick: () => editor.placeGaragePoint(house) }, 'Поставить въезд')));
  }
  if (garage) out.push(h('div', { class: 'actions' }, h('button', { onclick: () => editor.selectGarage(garage.id) }, 'Открыть гараж')));
  return out;
}

// ------------------------------------------------------------------ interior

// How a door found in the game data is named: where it came from decides how sure it is.
const DOOR_KIND = { portal: 'дверь', door: 'входная дверь', hall: 'проём наружу', hallway: 'проём холла' };

// Buttons that put the exit and the spawn by the interior's entrance door. The doors come with
// the game's geometry of this interior (editor.doors, once it is loaded).
function entranceControls(editor, interior, kind = 'interior') {
  const here = editor.geoFor === geoKey(kind, interior.id);
  const doors = here ? editor.doors : [];
  const choices = entranceChoices(doors);
  if (!choices.length) {
    return [h('p', { class: 'hint' }, here
      ? 'Вход в интерьер в данных игры не найден — выход и появление ставятся вручную.'
      : 'Дверь входа появится, когда загрузится интерьер игры.')];
  }
  const name = (i) => `${DOOR_KIND[doors[i].kind] || 'дверь'} · ${doors[i].room || '?'}${doors[i].model ? ` · ${doors[i].model}` : ''}`;
  const door = doors[editor.entrance];
  const pick = choices.length > 1
    ? [field('Дверь входа', select(choices.map((i) => [String(i), name(i)]), String(editor.entrance), (v) => editor.setEntrance(Number(v))))]
    : [h('p', { class: 'hint' }, `Дверь входа: ${name(choices[0])}.`)];
  return [
    h('div', { class: 'subhead' }, 'У двери интерьера (зелёная рамка)'),
    ...pick,
    h('div', { class: 'actions' },
      h('button', { disabled: !door, title: 'Выход на 0,8 м внутрь от двери, на уровне пола двери', onclick: () => editor.placeAtDoor(interior, 'exit') }, 'Выход у двери'),
      h('button', { disabled: !door, title: 'Появление на 2,6 м внутрь от двери, лицом в комнату', onclick: () => editor.placeAtDoor(interior, 'spawn') }, 'Появление у двери')),
  ];
}

export function interiorForm(editor, interior) {
  const doc = editor.doc;
  const live = editor.live = emptyLive();
  const use = usageOf(doc, interior.id);
  const used = use.classes.length + use.houses.length > 0;
  const who = [use.classes.length ? `классы ${use.classes.map((c) => c.name || c.id).join(', ')}` : null,
    use.houses.length ? `дома ${use.houses.map((x) => x.id).join(', ')}` : null].filter(Boolean).join('; ');
  const oldId = interior.id;
  // Renaming touches classes and houses too: one undo step. On a refusal edit() redraws the old code.
  const idInput = textInput(oldId, (v) => {
    if (v === oldId) return;
    editor.edit(() => {
      const error = renameInterior(doc, oldId, v);
      if (!error) {
        editor.sel.id = v;
        if (editor.geoFor === geoKey('interior', oldId)) editor.geoFor = geoKey('interior', v);
      }
      return error;
    }, { right: true });
  }, { maxLength: 32 });
  return [
    h('h3', {}, `Интерьер ${interior.name}`),
    field('Код', idInput),
    field('Название', textInput(interior.name, (v) => editor.edit(() => { interior.name = v; }))),
    h('div', { class: 'actions' }, ...['spawn', 'exit'].map((part) => h('button', {
      class: editor.sel.part === part ? 'on' : '',
      onclick: () => editor.selectInterior(interior.id, false, part),
    }, part === 'spawn' ? 'Двигать появление' : 'Двигать выход'))),
    h('div', { class: 'subhead' }, 'Точка появления (синяя)'),
    vec3(editor, interior, 'spawn', live.spawn),
    field('Направление', headingInput(editor, interior, 'heading', live.sheading), '°'),
    h('div', { class: 'subhead' }, 'Выход (оранжевая) — лучше у двери интерьера'),
    vec3(editor, interior, 'exit', live.exit),
    h('div', { class: 'actions' },
      h('button', { onclick: () => editor.edit(() => { interior.exit = interior.spawn.slice(); }, { right: true }) }, 'Выход к точке появления'),
      h('button', { onclick: () => editor.edit(() => { interior.spawn = interior.exit.slice(); }, { right: true }) }, 'Появление к выходу'),
      h('button', { onclick: () => editor.lookAtInterior(interior) }, 'К точке появления'),
      h('button', { onclick: () => editor.duplicateInterior(interior) }, 'Дублировать')),
    ...entranceControls(editor, interior),
    h('p', { class: 'hint' }, used ? `Используют: ${who}.` : 'Интерьер никто не использует.'),
    h('p', {}, `Декор: ${(interior.props || []).length} предметов`),
    h('div', { class: 'actions' },
      h('button', { onclick: () => editor.editDecor(interior), title: 'Открыть интерьер в редакторе карт: каталог, гизмо, Ctrl+S' }, `Редактировать декор (${(interior.props || []).length})`)),
    h('div', { class: 'actions' },
      h('button', { class: 'danger', disabled: used, title: used ? 'Сначала переназначьте классы и дома' : '', onclick: () => editor.deleteInterior(interior) }, 'Удалить интерьер')),
  ];
}

// ------------------------------------------------------------------ garage

export function garageForm(editor, garage) {
  const doc = editor.doc;
  const live = editor.live = emptyLive();
  const use = garageUsageOf(doc, garage.id);
  const used = use.classes.length + use.houses.length > 0;
  const who = [use.classes.length ? `классы ${use.classes.map((c) => c.name || c.id).join(', ')}` : null,
    use.houses.length ? `дома ${use.houses.map((x) => x.id).join(', ')}` : null].filter(Boolean).join('; ');
  const oldId = garage.id;
  const sel = editor.sel;
  const slots = Array.isArray(garage.slots) ? garage.slots : [];
  const slot = sel.part === 'slot' ? slots[sel.slot] : null;
  // Renaming touches classes and houses too: one undo step. On a refusal edit() redraws the old code.
  const idInput = textInput(oldId, (v) => {
    if (v === oldId) return;
    editor.edit(() => {
      const error = renameGarage(doc, oldId, v);
      if (!error) {
        editor.sel.id = v;
        if (editor.geoFor === geoKey('garage', oldId)) editor.geoFor = geoKey('garage', v);
      }
      return error;
    }, { right: true });
  }, { maxLength: 32 });
  const rows = slots.map((sl, i) => {
    const li = h('li', { class: slot === sl ? 'on' : '', onclick: () => editor.selectGarage(garage.id, false, 'slot', i) }, slotLabel(sl, i));
    if (slot === sl) live.slotRow = li;
    return li;
  });
  const out = [
    h('h3', {}, `Гараж ${garage.name}`),
    field('Код', idInput),
    field('Название', textInput(garage.name, (v) => editor.edit(() => { garage.name = v; }))),
    h('p', {}, `Мест: ${slots.length}`),
    h('div', { class: 'actions' }, ...['spawn', 'exit'].map((part) => h('button', {
      class: sel.part === part ? 'on' : '',
      onclick: () => editor.selectGarage(garage.id, false, part),
    }, part === 'spawn' ? 'Двигать появление' : 'Двигать выход'))),
    h('div', { class: 'subhead' }, 'Точка появления (синяя)'),
    vec3(editor, garage, 'spawn', live.spawn),
    field('Направление', headingInput(editor, garage, 'heading', live.sheading), '°'),
    h('div', { class: 'subhead' }, 'Выход (оранжевая) — лучше у двери гаража'),
    vec3(editor, garage, 'exit', live.exit),
    h('div', { class: 'actions' },
      h('button', { onclick: () => editor.edit(() => { garage.exit = garage.spawn.slice(); }, { right: true }) }, 'Выход к точке появления'),
      h('button', { onclick: () => editor.edit(() => { garage.spawn = garage.exit.slice(); }, { right: true }) }, 'Появление к выходу'),
      h('button', { onclick: () => editor.lookAtInterior(garage) }, 'К точке появления')),
    h('div', { class: 'subhead' }, `Места для машин (${slots.length}, фиолетовые коробки)`),
    h('ul', { class: 'list compact' }, ...rows),
  ];
  if (slot) {
    out.push(
      h('div', { class: 'subhead' }, `Место ${sel.slot + 1}`),
      vec3(editor, slot, 'pos', live.slot),
      field('Направление', headingInput(editor, slot, 'heading', live.slotHeading), '°'));
  }
  out.push(
    h('div', { class: 'actions' },
      h('button', { disabled: slots.length >= MAX_SLOTS, title: '3,2 м справа от выбранного места, то же направление', onclick: () => editor.addSlot(garage) }, 'Добавить место рядом'),
      h('button', { disabled: !slot || slots.length <= 1, onclick: () => editor.deleteSlot(garage, sel.slot) }, 'Удалить место'),
      h('button', { disabled: !slot, onclick: () => editor.lookAtSlot(garage, sel.slot) }, 'К месту')),
    ...entranceControls(editor, garage, 'garage'),
    h('p', { class: 'hint' }, used ? `Используют: ${who}.` : 'Гараж никто не использует.'),
    h('div', { class: 'actions' },
      h('button', { onclick: () => editor.duplicateGarage(garage) }, 'Дублировать'),
      h('button', { class: 'danger', disabled: used, title: used ? 'Сначала переназначьте классы и дома' : '', onclick: () => editor.deleteGarage(garage) }, 'Удалить гараж')));
  return out;
}

// ------------------------------------------------------------------ class

export function classForm(editor, cls) {
  const doc = editor.doc;
  const houses = doc.houses.filter((x) => x.cls === cls.id);
  const interiorOpts = doc.interiors.map((i) => [i.id, `${i.name} (${i.id})`]);
  if (!interiorById(doc, cls.interior)) interiorOpts.unshift([cls.interior, `нет интерьера: ${cls.interior}`]);
  editor.live = emptyLive();
  const garageOpts = [['', 'нет (гараж без интерьера)'], ...doc.garages.map((g) => [g.id, `${g.name} (${g.id})`])];
  if (cls.garageInterior && !garageById(doc, cls.garageInterior)) garageOpts.push([cls.garageInterior, `нет гаража: ${cls.garageInterior}`]);
  const tpl = garageById(doc, cls.garageInterior);
  const small = tpl && tpl.slots.length < cls.garage
    ? h('p', { class: 'hint' }, `В гараже ${tpl.name} мест ${tpl.slots.length}, меньше чем ${cls.garage} — вместимость ${tpl.slots.length}.`) : null;
  return [
    h('h3', {}, `Класс ${cls.name}`),
    field('Код', h('input', { type: 'text', value: cls.id, disabled: true })),
    field('Название', textInput(cls.name, (v) => editor.edit(() => { cls.name = v; }))),
    field('Гараж', numberInput(cls.garage, (n) => editor.edit(() => { cls.garage = Math.round(n); }), { min: 0, max: 50 }), 'мест'),
    field('Интерьер', select(interiorOpts, cls.interior, (v) => editor.edit(() => { cls.interior = v; }, { right: true }))),
    field('Интерьер гаража', select(garageOpts, cls.garageInterior || '', (v) => editor.edit(() => {
      if (v) cls.garageInterior = v;
      else delete cls.garageInterior;
    }, { right: true }))),
    small,
    h('p', { class: 'hint' }, houses.length ? `Домов этого класса: ${houses.length}.` : 'Домов этого класса нет.'),
    h('div', { class: 'actions' },
      h('button', { disabled: !interiorById(doc, cls.interior), onclick: () => editor.selectInterior(cls.interior) }, 'Открыть интерьер'),
      tpl ? h('button', { onclick: () => editor.selectGarage(tpl.id) }, 'Открыть гараж') : null,
      h('button', { class: 'danger', disabled: houses.length > 0, title: houses.length ? 'Сначала переназначьте дома' : '', onclick: () => editor.deleteClass(cls) }, 'Удалить класс')),
  ];
}

// ------------------------------------------------------------------ problems

// A click on a problem selects the object it is about.
export function problems(editor, issues) {
  const errors = issues.filter((i) => i.severity === 0).length;
  const box = h('ul', { class: 'issues' });
  if (!issues.length) box.append(h('li', { class: 'hint' }, 'Проблем нет.'));
  for (const i of issues.slice(0, 40)) {
    box.append(h('li', {
      class: i.severity === 0 ? 'error' : 'warning',
      style: i.objectId ? 'cursor:pointer' : '',
      onclick: () => editor.selectByObjectId(i.objectId),
    }, i.message));
  }
  if (issues.length > 40) box.append(h('li', { class: 'hint' }, `…и ещё ${issues.length - 40}`));
  const title = issues.length ? `Проверка (ошибок: ${errors}, замечаний: ${issues.length - errors})` : 'Проверка';
  return [h('h3', {}, title), box];
}
