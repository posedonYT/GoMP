// The side panels: maps, objects (outliner), catalog, the inspector of the
// selected objects and the map's properties.
import { $, h, ask, confirmBox, toast } from './dom.js';
import { api } from '../api.js';

// ------------------------------------------------------------------ maps

export function renderMaps(studio, maps) {
  const list = $('#map-list');
  list.replaceChildren(...maps.map((m) => h('li', {
    class: [studio.doc && studio.doc.name === m.name ? 'on' : '', m.enabled ? '' : 'off'].join(' '),
    onclick: () => studio.openMap(m.name),
  },
  h('div', { class: 'grow' }, h('div', {}, m.name), h('div', { class: 'sub' }, `${m.title || ''} · ${m.objects} объектов${m.enabled ? '' : ' · выключена'}`)),
  h('button', { title: 'Переименовать', onclick: (e) => { e.stopPropagation(); renameMap(studio, m.name); } }, '✎'),
  h('button', { class: 'danger', title: 'Удалить', onclick: (e) => { e.stopPropagation(); deleteMap(studio, m.name); } }, '✕'))));
  if (!maps.length) list.append(h('li', { class: 'hint' }, 'Карт пока нет — создайте первую.'));
}

const NAME_HINT = 'Латинские или русские буквы, цифры, _ и -. Это имя файла на сервере.';

export async function newMap(studio) {
  const name = await ask('Новая карта', '', NAME_HINT);
  if (!name) return;
  try {
    await api.saveMap(name, { format: 'gomp-map', version: 1, name, enabled: true, objects: [] });
    await studio.refreshMaps();
    await studio.openMap(name);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function renameMap(studio, name) {
  const to = await ask(`Переименовать «${name}»`, name, NAME_HINT);
  if (!to || to === name) return;
  try {
    await api.renameMap(name, to);
    if (studio.doc && studio.doc.name === name) studio.doc.name = to;
    if (studio.decorReturn === name) studio.decorReturn = to;  // the map to reopen after the decor
    await studio.refreshMaps();
    studio.updateTitle();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteMap(studio, name) {
  if (!(await confirmBox('Удалить карту?', `Карта «${name}» исчезнет с сервера вместе со всеми объектами.`))) return;
  try {
    await api.deleteMap(name);
    if (studio.doc && studio.doc.name === name) studio.closeMap();
    await studio.refreshMaps();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ------------------------------------------------------------------ outliner

export function renderOutliner(studio) {
  const list = $('#outliner');
  const doc = studio.doc;
  if (!doc) {
    list.replaceChildren(h('li', { class: 'hint' }, 'Откройте карту.'));
    return;
  }
  const filter = $('#outliner-filter').value.trim().toLowerCase();
  const groups = new Map();
  for (const o of doc.list()) {
    const text = `${o.id} ${o.model} ${o.group || ''}`.toLowerCase();
    if (filter && !text.includes(filter)) continue;
    const g = o.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(o);
  }
  const items = [];
  for (const [g, objs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (groups.size > 1 || g) items.push(h('li', { class: 'group' }, g || 'без группы'));
    for (const o of objs) {
      items.push(h('li', {
        class: studio.selection.has(o.id) ? 'on' : '',
        onclick: (e) => studio.select(o.id, e.shiftKey || e.ctrlKey),
        ondblclick: () => studio.focusSelection(),
      }, h('span', { class: 'grow' }, String(o.model)), h('span', { class: 'tag' }, o.id)));
    }
  }
  list.replaceChildren(...items);
  if (!items.length) list.append(h('li', { class: 'hint' }, filter ? 'Ничего не найдено.' : 'Объектов нет: поставьте их из каталога.'));
}

// ------------------------------------------------------------------ catalog

// What a catalog item is placed as: its name, or the hash when the game has no name for it.
export const modelOf = (a) => a.name ?? a.hash;
const hex = (hash) => `0x${hash.toString(16).toUpperCase().padStart(8, '0')}`;

// more: whether a "Показать ещё" page exists.
export function renderCatalog(studio, results, state, more = false) {
  $('#catalog-state').textContent = state || '';
  $('#catalog-more').hidden = !more;
  $('#catalog').replaceChildren(...results.map((a) => {
    const size = a.bbMax.map((v, i) => (v - a.bbMin[i]).toFixed(1)).join(' × ');
    const label = a.name ?? (a.ytyp ? `${hex(a.hash)} · ${a.ytyp}` : hex(a.hash));
    let hover = null;
    return h('li', {
      class: studio.placing && studio.placing.model === modelOf(a) ? 'on' : '',
      title: `${a.name ?? hex(a.hash)} (${a.ytyp || ''})`,
      onclick: () => studio.startPlacing(a),
      // Fetched while the pointer rests on the row: the click then shows the model at once.
      onpointerenter: () => { hover = setTimeout(() => studio.models.load(a.hash), 120); },
      onpointerleave: () => clearTimeout(hover),
    }, h('span', { class: 'grow' }, label), h('span', { class: 'tag' }, size));
  }));
}

// ------------------------------------------------------------------ inspector

function numberInput(value, onchange, step = 0.01) {
  return h('input', {
    type: 'number', step, value: Number.isFinite(value) ? Math.round(value * 1000) / 1000 : '',
    onchange: (e) => onchange(Number(e.target.value)),
  });
}

export function renderInspector(studio) {
  const box = $('#inspector');
  const doc = studio.doc;
  const ids = studio.selection.ids.filter((id) => doc && doc.get(id));
  if (!doc || !ids.length) {
    box.replaceChildren(h('p', { class: 'hint' }, doc ? 'Выберите объект в мире или в списке.' : 'Карта не открыта.'));
    return;
  }
  const o = doc.get(studio.selection.primary) || doc.get(ids[0]);
  const many = ids.length > 1;
  const update = (patch, key) => {
    // Several selected: a field typed in goes to all of them (position: as an offset).
    const patches = {};
    for (const id of many ? ids : [o.id]) {
      const cur = doc.get(id);
      const p = { ...patch };
      if (patch.pos && many) p.pos = cur.pos.map((v, i) => v + patch.pos[i] - o.pos[i]);
      patches[id] = p;
    }
    doc.update(patches, 'изменить', `inspector-${key}`);
    doc.history.seal();
  };
  const vec = (label, arr, key, step) => h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'vec' },
    ...arr.map((v, i) => numberInput(v, (n) => { const next = arr.slice(); next[i] = n; update({ [key]: next }, key); }, step))));

  box.replaceChildren(...[
    many ? h('p', { class: 'hint' }, `Выбрано объектов: ${ids.length}. Поля меняют все (позиция — сдвигом).`) : null,
    h('div', { class: 'field' }, h('label', {}, 'id'), h('code', {}, o.id)),
    h('div', { class: 'field' }, h('label', {}, 'Модель'), h('input', {
      type: 'text', value: String(o.model),
      onchange: (e) => update({ model: /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value }, 'model'),
    })),
    vec('Позиция', o.pos, 'pos', 0.1),
    vec('Поворот°', o.rot, 'rot', 1),
    h('div', { class: 'field' }, h('label', {}, 'Измерение'), numberInput(o.dimension, (n) => update({ dimension: Math.max(0, Math.round(n)) }, 'dim'), 1)),
    h('div', { class: 'field' }, h('label', {}, 'Прозрачн.'), h('input', {
      type: 'range', min: 0, max: 255, value: o.alpha, onchange: (e) => update({ alpha: Number(e.target.value) }, 'alpha'),
    })),
    h('div', { class: 'field' }, h('label', {}, 'Группа'), h('input', {
      type: 'text', value: o.group || '', placeholder: 'например, лавки', onchange: (e) => update({ group: e.target.value.trim() || undefined }, 'group'),
    })),
    h('div', { class: 'actions' },
      h('button', { onclick: () => studio.dropToGround(), title: 'Опустить на землю мира' }, 'На землю'),
      h('button', { onclick: () => studio.focusSelection(), title: 'F' }, 'Показать'),
      h('button', { onclick: () => studio.duplicate(), title: 'Ctrl+D' }, 'Копия'),
      h('button', { class: 'danger', onclick: () => studio.removeSelection(), title: 'Delete' }, 'Удалить')),
  ].filter(Boolean));
}

export function renderMapProps(studio) {
  const box = $('#map-props');
  const doc = studio.doc;
  box.previousElementSibling.textContent = doc && doc.decor ? 'Декор' : 'Карта';
  if (doc && doc.decor) {
    // No name, no "enabled": the props are saved into houses.json, not as a map.
    box.replaceChildren(
      h('p', {}, doc.decor.title),
      h('div', { class: 'field' }, h('label', {}, 'Предметов'), h('span', {}, `${doc.objects.size} из 300`)),
      h('p', { class: 'hint' }, 'Ctrl+S записывает декор в интерьер и сохраняет дома. «Готово» над сценой — выйти.'));
    return;
  }
  if (!doc) {
    box.replaceChildren(h('p', { class: 'hint' }, 'Карта не открыта.'));
    return;
  }
  box.replaceChildren(
    h('div', { class: 'field' }, h('label', {}, 'Название'), h('input', {
      type: 'text', value: doc.meta.name || '', onchange: (e) => doc.setMeta({ name: e.target.value }),
    })),
    h('div', { class: 'field' }, h('label', {}, 'Включена'), h('input', {
      type: 'checkbox', checked: doc.meta.enabled !== false, onchange: (e) => doc.setMeta({ enabled: e.target.checked }),
    })),
    h('div', { class: 'field' }, h('label', {}, 'Объектов'), h('span', {}, String(doc.objects.size))),
  );
}

export function renderIssues(issues) {
  const list = $('#issues');
  if (!issues || !issues.length) {
    list.replaceChildren(h('li', { class: 'hint' }, 'Проблем нет.'));
    return;
  }
  list.replaceChildren(...issues.slice(0, 50).map((i) => h('li', { class: String(i.severity).toLowerCase() === 'error' || i.severity === 0 ? 'error' : 'warning' },
    `${i.objectId ? `${i.objectId}: ` : ''}${i.message}`)));
}
