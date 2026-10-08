// Item definitions. An inventory slot holds { key, count, uid?, data? }:
//   key   – one of the definitions below;
//   count – stack size (always 1 for non-stackable items);
//   uid   – serial number of non-stackable items (weapons, clothes);
//   data  – per-item data (clothes: { slot, gender, drawable, texture, torso, undershirt }).
// The client receives the definitions (gomp:inv:defs) and draws icons/<icon>.png;
// Mk II variants and close relatives share an icon. `model` is the object a
// dropped item lies on the ground as (drops.js).

const ITEMS = {};

function def(key, d) {
  ITEMS[key] = { key, stack: 1, icon: key, desc: '', ...d };
}

// ------------------------------------------------------------------ weapons
// Not stackable, taken in hand from a hotbar slot (keys 1-9). `ammo` is the
// ammunition item they fire; throwables stack and are their own ammunition;
// `infinite` weapons need no ammunition at all.

const GROUP_MODELS = {
  pistol: 'w_pi_pistol', smg: 'w_sb_smg', mg: 'w_mg_mg', shotgun: 'w_sg_pumpshotgun', rifle: 'w_ar_carbinerifle',
  sniper: 'w_sr_sniperrifle', heavy: 'w_lr_rpg', thrown: 'w_ex_grenadefrag', melee: 'w_me_bat',
};

function weapon(group, key, name, ammo, desc, extra = {}) {
  def(`weapon_${key}`, {
    name, type: 'weapon', group, weapon: `weapon_${key}`, ammo: ammo ? `ammo_${ammo}` : null, desc,
    model: GROUP_MODELS[group], ...extra,
  });
}
const icon = (name) => ({ icon: `weapon_${name}` });
const thrown = (key, name, desc, model, stack = 10) =>
  def(`weapon_${key}`, { name, type: 'weapon', group: 'thrown', weapon: `weapon_${key}`, ammo: `weapon_${key}`, stack, desc, model });

// Pistols.
weapon('pistol', 'pistol', 'Пистолет', 'pistol', 'Калибр 9 мм');
weapon('pistol', 'pistol_mk2', 'Пистолет Mk II', 'pistol', 'Калибр 9 мм', { ...icon('pistol'), model: 'w_pi_pistolmk2' });
weapon('pistol', 'combatpistol', 'Боевой пистолет', 'pistol', 'Калибр 9 мм', { model: 'w_pi_combatpistol' });
weapon('pistol', 'appistol', 'Бронебойный пистолет', 'pistol', 'Калибр 9 мм, автоматический огонь', { model: 'w_pi_appistol' });
weapon('pistol', 'pistol50', 'Пистолет .50', 'magnum', 'Калибр .50 AE', { model: 'w_pi_pistol50' });
weapon('pistol', 'snspistol', 'Карманный пистолет', 'pistol', 'Калибр 9 мм', { model: 'w_pi_sns_pistol' });
weapon('pistol', 'snspistol_mk2', 'Карманный пистолет Mk II', 'pistol', 'Калибр 9 мм', { ...icon('snspistol'), model: 'w_pi_sns_pistolmk2' });
weapon('pistol', 'heavypistol', 'Тяжёлый пистолет', 'pistol', 'Калибр .45', { model: 'w_pi_heavypistol' });
weapon('pistol', 'vintagepistol', 'Винтажный пистолет', 'pistol', 'Калибр 9 мм', { model: 'w_pi_vintage_pistol' });
weapon('pistol', 'ceramicpistol', 'Керамический пистолет', 'pistol', 'Калибр 9 мм', { ...icon('heavypistol'), model: 'w_pi_ceramic_pistol' });
weapon('pistol', 'pistolxm3', 'Пистолет WM 29', 'pistol', 'Калибр 9 мм', icon('pistol'));
weapon('pistol', 'gadgetpistol', 'Пистолет «Перико»', 'pistol', 'Калибр 9 мм', icon('snspistol'));
weapon('pistol', 'marksmanpistol', 'Пистолет марксмана', 'magnum', 'Однозарядный', { model: 'w_pi_singleshot' });
weapon('pistol', 'revolver', 'Тяжёлый револьвер', 'magnum', 'Калибр .44', { model: 'w_pi_revolver' });
weapon('pistol', 'revolver_mk2', 'Тяжёлый револьвер Mk II', 'magnum', 'Калибр .44', { ...icon('revolver'), model: 'w_pi_revolvermk2' });
weapon('pistol', 'doubleaction', 'Револьвер двойного действия', 'magnum', 'Калибр .44', { model: 'w_pi_wep1_gun' });
weapon('pistol', 'navyrevolver', 'Флотский револьвер', 'magnum', 'Калибр .44');
weapon('pistol', 'flaregun', 'Ракетница', 'flare', 'Сигнальные ракеты', { model: 'w_pi_flaregun' });
weapon('pistol', 'stungun', 'Электрошокер', null, 'Обездвиживает цель', { infinite: true, model: 'w_pi_stungun' });
weapon('pistol', 'raypistol', 'Атомайзер', null, 'Перезаряжается сам', { infinite: true, model: 'w_pi_raygun' });

// Submachine guns.
weapon('smg', 'microsmg', 'Микро-ПП', 'smg', 'Патроны для ПП', { model: 'w_sb_microsmg' });
weapon('smg', 'smg', 'Пистолет-пулемёт', 'smg', 'Патроны для ПП', { model: 'w_sb_smg' });
weapon('smg', 'smg_mk2', 'Пистолет-пулемёт Mk II', 'smg', 'Патроны для ПП', { ...icon('smg'), model: 'w_sb_smgmk2' });
weapon('smg', 'assaultsmg', 'Штурмовой ПП', 'smg', 'Патроны для ПП', { model: 'w_sb_assaultsmg' });
weapon('smg', 'combatpdw', 'Боевой PDW', 'smg', 'Патроны для ПП', { model: 'w_sb_pdw' });
weapon('smg', 'machinepistol', 'Автоматический пистолет', 'smg', 'Патроны для ПП');
weapon('smg', 'minismg', 'Мини-ПП', 'smg', 'Патроны для ПП');
weapon('smg', 'tecpistol', 'Тактический ПП', 'smg', 'Патроны для ПП');

// Machine guns.
weapon('mg', 'mg', 'Пулемёт', 'mg', 'Лента 7.62', { model: 'w_mg_mg' });
weapon('mg', 'combatmg', 'Боевой пулемёт', 'mg', 'Лента 7.62', { ...icon('mg'), model: 'w_mg_combatmg' });
weapon('mg', 'combatmg_mk2', 'Боевой пулемёт Mk II', 'mg', 'Лента 7.62', { ...icon('mg'), model: 'w_mg_combatmgmk2' });
weapon('mg', 'gusenberg', 'Пулемёт Томпсона', 'mg', 'Лента 7.62', { model: 'w_sb_gusenberg' });
weapon('mg', 'raycarbine', 'Карабин «Хеллбрингер»', 'mg', 'Лента 7.62');

// Shotguns.
weapon('shotgun', 'pumpshotgun', 'Помповый дробовик', 'shotgun', 'Дробь 12 калибра');
weapon('shotgun', 'pumpshotgun_mk2', 'Помповый дробовик Mk II', 'shotgun', 'Дробь 12 калибра', { ...icon('pumpshotgun'), model: 'w_sg_pumpshotgunmk2' });
weapon('shotgun', 'sawnoffshotgun', 'Обрез', 'shotgun', 'Дробь 12 калибра', { ...icon('pumpshotgun'), model: 'w_sg_sawnoff' });
weapon('shotgun', 'dbshotgun', 'Двуствольный обрез', 'shotgun', 'Дробь 12 калибра', icon('pumpshotgun'));
weapon('shotgun', 'combatshotgun', 'Боевой дробовик', 'shotgun', 'Дробь 12 калибра', icon('pumpshotgun'));
weapon('shotgun', 'assaultshotgun', 'Штурмовой дробовик', 'shotgun', 'Дробь 12 калибра', { model: 'w_sg_assaultshotgun' });
weapon('shotgun', 'bullpupshotgun', 'Буллпап-дробовик', 'shotgun', 'Дробь 12 калибра', { ...icon('assaultshotgun'), model: 'w_sg_bullpupshotgun' });
weapon('shotgun', 'heavyshotgun', 'Тяжёлый дробовик', 'shotgun', 'Дробь 12 калибра', { ...icon('assaultshotgun'), model: 'w_sg_heavyshotgun' });
weapon('shotgun', 'autoshotgun', 'Свипер', 'shotgun', 'Дробь 12 калибра', icon('assaultshotgun'));
weapon('shotgun', 'musket', 'Мушкет', 'shotgun', 'Дробь 12 калибра', { model: 'w_ar_musket' });

// Assault rifles.
weapon('rifle', 'assaultrifle', 'Автомат', 'rifle', 'Калибр 5.56', { model: 'w_ar_assaultrifle' });
weapon('rifle', 'assaultrifle_mk2', 'Автомат Mk II', 'rifle', 'Калибр 5.56', { ...icon('assaultrifle'), model: 'w_ar_assaultriflemk2' });
weapon('rifle', 'carbinerifle', 'Карабин', 'rifle', 'Калибр 5.56', { model: 'w_ar_carbinerifle' });
weapon('rifle', 'carbinerifle_mk2', 'Карабин Mk II', 'rifle', 'Калибр 5.56', { ...icon('carbinerifle'), model: 'w_ar_carbineriflemk2' });
weapon('rifle', 'specialcarbine', 'Особый карабин', 'rifle', 'Калибр 5.56', { model: 'w_ar_specialcarbine' });
weapon('rifle', 'specialcarbine_mk2', 'Особый карабин Mk II', 'rifle', 'Калибр 5.56', { ...icon('specialcarbine'), model: 'w_ar_specialcarbinemk2' });
weapon('rifle', 'advancedrifle', 'Улучшенная винтовка', 'rifle', 'Калибр 5.56', { ...icon('specialcarbine'), model: 'w_ar_advancedrifle' });
weapon('rifle', 'bullpuprifle', 'Буллпап-винтовка', 'rifle', 'Калибр 5.56', { model: 'w_ar_bullpuprifle' });
weapon('rifle', 'bullpuprifle_mk2', 'Буллпап-винтовка Mk II', 'rifle', 'Калибр 5.56', { ...icon('bullpuprifle'), model: 'w_ar_bullpupriflemk2' });
weapon('rifle', 'militaryrifle', 'Армейская винтовка', 'rifle', 'Калибр 5.56', icon('bullpuprifle'));
weapon('rifle', 'compactrifle', 'Компактная винтовка', 'rifle', 'Калибр 5.56');
weapon('rifle', 'heavyrifle', 'Тяжёлая винтовка', 'rifle', 'Калибр 5.56', icon('carbinerifle'));
weapon('rifle', 'tacticalrifle', 'Служебный карабин', 'rifle', 'Калибр 5.56', icon('carbinerifle'));
weapon('rifle', 'battlerifle', 'Боевая винтовка', 'rifle', 'Калибр 5.56', icon('carbinerifle'));

// Sniper rifles.
weapon('sniper', 'sniperrifle', 'Снайперская винтовка', 'sniper', 'Калибр .308', { model: 'w_sr_sniperrifle' });
weapon('sniper', 'heavysniper', 'Тяжёлая снайперская винтовка', 'heavysniper', 'Калибр .50 BMG', { model: 'w_sr_heavysniper' });
weapon('sniper', 'heavysniper_mk2', 'Тяжёлая снайперская винтовка Mk II', 'heavysniper', 'Калибр .50 BMG', { ...icon('heavysniper'), model: 'w_sr_heavysnipermk2' });
weapon('sniper', 'marksmanrifle', 'Винтовка марксмана', 'sniper', 'Калибр .308', { ...icon('carbinerifle'), model: 'w_sr_marksmanrifle' });
weapon('sniper', 'marksmanrifle_mk2', 'Винтовка марксмана Mk II', 'sniper', 'Калибр .308', { ...icon('carbinerifle'), model: 'w_sr_marksmanriflemk2' });
weapon('sniper', 'precisionrifle', 'Точная винтовка', 'sniper', 'Калибр .308', icon('sniperrifle'));

// Heavy weapons.
weapon('heavy', 'rpg', 'РПГ', 'rocket', 'Реактивный гранатомёт', { model: 'w_lr_rpg' });
weapon('heavy', 'hominglauncher', 'Самонаводящаяся ракетница', 'rocket', 'Наводится на транспорт', { model: 'w_lr_homing' });
weapon('heavy', 'grenadelauncher', 'Гранатомёт', 'grenade40', 'Гранаты 40 мм', { model: 'w_lr_grenadelauncher' });
weapon('heavy', 'grenadelauncher_smoke', 'Дымовой гранатомёт', 'grenade40', 'Гранаты 40 мм', icon('grenadelauncher'));
weapon('heavy', 'compactlauncher', 'Компактный гранатомёт', 'grenade40', 'Гранаты 40 мм', icon('grenadelauncher'));
weapon('heavy', 'minigun', 'Миниган', 'minigun', 'Патроны для минигана', { model: 'w_mg_minigun' });
weapon('heavy', 'rayminigun', 'Вдоводел', 'minigun', 'Патроны для минигана', icon('minigun'));
weapon('heavy', 'firework', 'Фейерверк', 'firework', 'Праздничные ракеты', { model: 'w_lr_firework' });
weapon('heavy', 'railgun', 'Рельсотрон', 'railgun', 'Электромагнитная пушка', { model: 'w_ar_railgun' });
weapon('heavy', 'emplauncher', 'ЭМИ-пусковая установка', 'emp', 'Глушит транспорт');

// Throwables: each item is one throw.
thrown('grenade', 'Граната', 'Осколочная', 'w_ex_grenadefrag');
thrown('smokegrenade', 'Дымовая граната', 'Дымовая завеса', 'w_ex_grenadesmoke');
thrown('bzgas', 'Слезоточивый газ', 'Газовая граната', 'w_ex_grenadesmoke');
thrown('molotov', 'Коктейль Молотова', 'Зажигательная смесь', 'w_ex_molotov');
thrown('stickybomb', 'Липкая бомба', 'Взрыв по команде (G)', 'w_ex_pe');
thrown('proxmine', 'Мина', 'Взрывается рядом с целью', 'w_ex_apmine');
thrown('pipebomb', 'Самодельная бомба', 'Взрыв по команде (G)', 'w_ex_pipebomb');
thrown('flare', 'Фальшфейер', 'Сигнальный огонь', 'w_am_flare');
thrown('snowball', 'Снежок', 'Зимнее развлечение', 'w_ex_snowball', 20);
thrown('ball', 'Мяч', 'Бросить и поймать', 'w_am_baseball', 5);

// Melee.
weapon('melee', 'knife', 'Нож', null, 'Холодное оружие', { model: 'w_me_knife_01' });
weapon('melee', 'dagger', 'Кинжал', null, 'Холодное оружие', { model: 'w_me_dagger' });
weapon('melee', 'switchblade', 'Выкидной нож', null, 'Холодное оружие', { model: 'w_me_switchblade' });
weapon('melee', 'machete', 'Мачете', null, 'Холодное оружие', { model: 'w_me_machette_lr' });
weapon('melee', 'hatchet', 'Топорик', null, 'Холодное оружие', { model: 'w_me_hatchet' });
weapon('melee', 'battleaxe', 'Боевой топор', null, 'Холодное оружие', { model: 'w_me_battleaxe' });
weapon('melee', 'stone_hatchet', 'Каменный топор', null, 'Холодное оружие', { model: 'w_me_stonehatchet' });
weapon('melee', 'bat', 'Бита', null, 'Холодное оружие', { model: 'w_me_bat' });
weapon('melee', 'golfclub', 'Клюшка для гольфа', null, 'Холодное оружие', { model: 'w_me_gclub' });
weapon('melee', 'poolcue', 'Кий', null, 'Холодное оружие', { model: 'w_me_poolcue' });
weapon('melee', 'nightstick', 'Дубинка', null, 'Холодное оружие', { model: 'w_me_nightstick' });
weapon('melee', 'crowbar', 'Монтировка', null, 'Холодное оружие', { model: 'w_me_crowbar' });
weapon('melee', 'hammer', 'Молоток', null, 'Холодное оружие', { model: 'w_me_hammer' });
weapon('melee', 'wrench', 'Гаечный ключ', null, 'Холодное оружие', { model: 'w_me_wrench' });
weapon('melee', 'knuckle', 'Кастет', null, 'Холодное оружие', { model: 'w_me_knuckle' });
weapon('melee', 'bottle', 'Разбитая бутылка', null, 'Холодное оружие', { model: 'w_me_bottle' });
weapon('melee', 'candycane', 'Леденцовая трость', null, 'Холодное оружие');
weapon('melee', 'flashlight', 'Фонарик', null, 'Светит и бьёт', { model: 'w_me_flashlight' });
weapon('melee', 'fireextinguisher', 'Огнетушитель', null, 'Тушит огонь', { infinite: true, model: 'w_am_fire_exting' });

// ------------------------------------------------------------------ ammunition
// Stackable, shared by every weapon of the calibre.
const AMMO_MODEL = 'prop_ld_ammo_pack_01';
const ammo = (key, name, stack, extra = {}) =>
  def(`ammo_${key}`, { name, type: 'ammo', stack, desc: 'Патроны в инвентаре = патроны в оружии', model: AMMO_MODEL, ...extra });
ammo('pistol', 'Патроны 9 мм', 250);
ammo('magnum', 'Патроны .44 / .50', 120);
ammo('smg', 'Патроны для ПП', 300);
ammo('rifle', 'Патроны 5.56', 300);
ammo('mg', 'Лента 7.62', 500);
ammo('shotgun', 'Дробь 12 к.', 100);
ammo('sniper', 'Патроны .308', 60);
ammo('heavysniper', 'Патроны .50 BMG', 40);
ammo('flare', 'Сигнальные ракеты', 20, { desc: 'Для ракетницы' });
ammo('rocket', 'Ракеты', 10, { desc: 'Для РПГ и ракетниц' });
ammo('grenade40', 'Гранаты 40 мм', 20, { desc: 'Для гранатомётов' });
ammo('minigun', 'Патроны для минигана', 1000, { icon: 'ammo_mg' });
ammo('firework', 'Фейерверк-ракеты', 20, { icon: 'weapon_firework', desc: 'Для фейерверка' });
ammo('railgun', 'Заряды рельсотрона', 20);
ammo('emp', 'ЭМИ-заряды', 10);

// ------------------------------------------------------------------ consumables
// Stackable, used from the inventory or a hotbar slot.
def('bandage', { name: 'Бинт', type: 'medical', stack: 10, heal: 20, desc: '+20 здоровья', model: 'prop_ld_health_pack' });
def('medkit', { name: 'Аптечка', type: 'medical', stack: 5, heal: 100, desc: 'Полностью восстанавливает здоровье', model: 'prop_ld_health_pack' });
def('armor', { name: 'Бронежилет', type: 'medical', stack: 3, armour: 100, desc: 'Надеть: броня 100', model: 'prop_armour_pickup' });
def('water', { name: 'Вода', type: 'food', stack: 10, heal: 5, desc: '+5 здоровья', model: 'prop_ld_flow_bottle' });
def('soda', { name: 'Газировка', type: 'food', stack: 10, heal: 4, desc: '+4 здоровья', model: 'prop_ecola_can' });
def('coffee', { name: 'Кофе', type: 'food', stack: 10, heal: 4, desc: '+4 здоровья', model: 'p_amb_coffeecup_01' });
def('chips', { name: 'Чипсы', type: 'food', stack: 10, heal: 5, desc: '+5 здоровья' });
def('chocolate', { name: 'Шоколадка', type: 'food', stack: 10, heal: 6, desc: '+6 здоровья', model: 'prop_choc_ego' });
def('hotdog', { name: 'Хот-дог', type: 'food', stack: 10, heal: 8, desc: '+8 здоровья', model: 'prop_cs_hotdog_01' });
def('burger', { name: 'Бургер', type: 'food', stack: 10, heal: 10, desc: '+10 здоровья', model: 'prop_cs_burger_01' });
def('repairkit', { name: 'Ремкомплект', type: 'tool', stack: 3, desc: 'Чинит транспорт рядом (6 сек.)', model: 'prop_tool_box_04' });
def('jerrycan', { name: 'Канистра', type: 'tool', stack: 2, fuel: 20, desc: '+20 л топлива транспорту рядом', model: 'w_am_jerrycan' });
def('phone', { name: 'Телефон', type: 'misc', desc: 'Стрелка вверх — открыть: контакты, сообщения, банк, дом, GPS', model: 'prop_npc_phone_02' });

// Clothes: not stackable; worn from the equipment slots. data.slot: top | legs | shoes.
const CLOTHES_MODEL = 'prop_cs_tshirt_ball_01';
def('clothes_top', { name: 'Верхняя одежда', type: 'clothes', slot: 'top', desc: 'Надевается в слот «Верх»', model: CLOTHES_MODEL });
def('clothes_legs', { name: 'Штаны', type: 'clothes', slot: 'legs', desc: 'Надевается в слот «Низ»', model: CLOTHES_MODEL });
def('clothes_shoes', { name: 'Обувь', type: 'clothes', slot: 'shoes', desc: 'Надевается в слот «Обувь»', model: CLOTHES_MODEL });

// ------------------------------------------------------------------ lookup

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
const byName = new Map();
for (const [key, d] of Object.entries(ITEMS)) {
  byName.set(squash(key), key);
  byName.set(squash(key.replace(/^(weapon|ammo)_/, '')), byName.get(squash(key.replace(/^(weapon|ammo)_/, ''))) || key);
  if (!byName.has(squash(d.name))) byName.set(squash(d.name), key);
}

// Accepts "pistol", "weapon_pistol", "pistol_mk2", "pistolmk2", "ammo_pistol",
// "medkit", "аптечка"... and returns the key or null. A bare weapon name means
// the weapon, not its ammunition ("ammo_" picks the ammunition).
function resolve(name) {
  const n = String(name || '').toLowerCase();
  if (ITEMS[n]) return n;
  if (ITEMS[`weapon_${n}`]) return `weapon_${n}`;
  if (ITEMS[`ammo_${n}`]) return `ammo_${n}`;
  return byName.get(squash(n)) || null;
}

module.exports = { ITEMS, resolve };
