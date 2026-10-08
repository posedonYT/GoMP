// Small DOM helpers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// h('li', { class: 'on', onclick }, 'text', child...)
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function toast(text, kind = 'info', ms = 4000) {
  const el = h('div', { class: `toast ${kind}` }, text);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

export function setStatus(text) {
  $('#status-text').textContent = text;
}

// A modal question; resolves with the typed value or null.
export function ask(title, value = '', hint = '') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value });
    const dlg = h('dialog', {},
      h('h3', {}, title), input, hint ? h('p', { class: 'hint' }, hint) : null,
      h('div', { class: 'row' },
        h('button', { onclick: () => { dlg.close(); resolve(null); } }, 'Отмена'),
        h('button', { class: 'primary', onclick: () => { dlg.close(); resolve(input.value.trim()); } }, 'OK')));
    input.addEventListener('keydown', (e) => {
      // No default action: after the dialog closes, Enter would press the button that opened it.
      if (e.key === 'Enter') { e.preventDefault(); dlg.close(); resolve(input.value.trim()); }
    });
    dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
    document.body.append(dlg);
    dlg.showModal();
    input.select();
  });
}

export function confirmBox(title, text) {
  return new Promise((resolve) => {
    const dlg = h('dialog', {}, h('h3', {}, title), h('p', {}, text),
      h('div', { class: 'row' },
        h('button', { onclick: () => { dlg.close(); resolve(false); } }, 'Отмена'),
        h('button', { class: 'primary', onclick: () => { dlg.close(); resolve(true); } }, 'Да')));
    dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
    document.body.append(dlg);
    dlg.showModal();
  });
}

// Typing in a field: keyboard shortcuts of the editor do not apply.
export function typing() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA');
}
