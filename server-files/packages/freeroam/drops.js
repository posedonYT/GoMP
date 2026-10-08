// Items on the ground. A dropped item becomes an object at the player's feet
// with the shared variable `drop` = { key, count, label }; clients draw its
// name and pick it up with E (gomp:drop:pickup objectId). Drops disappear
// after DROP_LIFETIME.

const inventory = require('./inventory');
const { ITEMS } = require('./items');

const DROP_LIFETIME = 10 * 60 * 1000;
const MAX_DROPS = 300;
const PICKUP_RANGE = 2.5;
const FALLBACK_MODEL = 'prop_paper_bag_small';

const drops = new Map(); // object id -> { object, item, expires }

function remove(id) {
  const d = drops.get(id);
  if (!d) return;
  drops.delete(id);
  if (mp.objects.exists(d.object)) d.object.destroy();
}

function share(d) {
  const def = ITEMS[d.item.key];
  d.object.setVariable('drop', { key: d.item.key, count: d.item.count, label: def ? def.name : d.item.key });
}

// Puts an item (a whole inventory slot) on the ground near the player.
function spawn(player, item) {
  const def = ITEMS[item.key];
  if (!def) return;
  if (drops.size >= MAX_DROPS) remove(drops.keys().next().value);
  const p = player.position;
  const h = (player.heading * Math.PI) / 180;
  // Half a metre in front of the feet, a little scattered so drops do not pile up.
  const r = 0.5 + Math.random() * 0.3;
  const pos = new mp.Vector3(p.x - Math.sin(h) * r, p.y + Math.cos(h) * r, p.z - 0.95);
  const weapon = def.type === 'weapon' && def.group !== 'thrown';
  const object = mp.objects.new(mp.joaat(def.model || FALLBACK_MODEL), pos, {
    rotation: new mp.Vector3(weapon ? 90 : 0, 0, Math.random() * 360),
    dimension: player.dimension,
  });
  const d = { object, item, expires: Date.now() + DROP_LIFETIME };
  drops.set(object.id, d);
  share(d);
}

// E near a drop: as much as fits goes into the inventory, the rest stays.
function pickup(player, ch, id) {
  const d = drops.get(Number(id));
  if (!d || !mp.objects.exists(d.object) || d.object.dimension !== player.dimension || player.vehicle || player.dead) return;
  if (d.object.position.subtract(player.position).length() > PICKUP_RANGE + 1) return;
  const def = ITEMS[d.item.key];
  const left = inventory.addItem(ch, d.item);
  const taken = d.item.count - left;
  if (taken <= 0) {
    player.notify('~r~Нет места в инвентаре');
    return;
  }
  if (left > 0) {
    d.item.count = left;
    share(d);
  } else {
    remove(d.object.id);
  }
  player.playAnimation('pickup_object', 'pickup_low', 8, 48);
  inventory.refreshAmmo(player, ch);
  inventory.sync(player, ch);
  player.notify(`Подобрано: ${def.name}${taken > 1 ? ` x${taken}` : ''}`);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, d] of drops) if (d.expires < now || !mp.objects.exists(d.object)) remove(id);
}, 30000);

module.exports = { spawn, pickup };
