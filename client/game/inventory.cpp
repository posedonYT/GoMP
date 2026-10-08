// Inventory window (Tab), hotbar keys 1-9 and the hotbar strip of the HUD.
// The server owns the inventory (server-files/packages/freeroam/inventory.js);
// the client draws it and sends moves. Icons are PNG files in gomp/icons next
// to gomp.asi, drawn with ScriptHookV textures.
#include <cmath>

#include "game_client.hpp"
#include "natives.hpp"
#include "ui.hpp"

namespace gompgame {

using namespace gomp;
using namespace ui;

namespace {

const char* const kContainers[] = {"pockets", "hotbar", "equip"};
const char* const kEquipNames[] = {"Верх", "Низ", "Обувь"};
constexpr int kTextureInstances = 64;  // ScriptHookV limit per texture and frame

// Weapon switching of the game: the wheel (Tab), mouse wheel, number keys, vehicle weapon switch.
constexpr int kWeaponControls[] = {12, 13, 14, 15, 16, 17, 37, 99, 100, 157, 158, 159, 160, 161, 162, 163, 164, 165, 261, 262};

Rgba tintOf(const std::string& type) {
    if (type == "weapon") return theme::Text;
    if (type == "ammo") return {232, 184, 92, 255};
    if (type == "medical") return theme::Negative;
    if (type == "food") return theme::Positive;
    if (type == "clothes") return theme::Accent;
    if (type == "tool") return {236, 150, 70, 255};
    return theme::Muted;
}

std::string iconPath(const std::string& icon) {
    char path[MAX_PATH] = {};
    GetModuleFileNameA(shv::module, path, MAX_PATH);
    std::string dir(path);
    dir = dir.substr(0, dir.find_last_of("\\/") + 1);
    return dir + "gomp\\icons\\" + icon + ".png";
}

}  // namespace

// ------------------------------------------------------------------ data

void GameClient::onInventoryDefs(const Value& defs) {
    if (defs.kind != Value::Kind::Array) return;
    itemDefs_.clear();
    for (const auto& d : defs.arr) {
        ItemDef def;
        def.name = props::fieldStr(d, "name");
        def.type = props::fieldStr(d, "type");
        def.icon = props::fieldStr(d, "icon");
        def.desc = props::fieldStr(d, "desc");
        def.stack = static_cast<int>(props::fieldInt(d, "stack"));
        itemDefs_[props::fieldStr(d, "key")] = def;
    }
}

void GameClient::onInventorySync(const Value& inv) {
    auto fill = [&](const char* key, auto& slots) {
        const Value* list = inv.get(key);
        for (std::size_t i = 0; i < slots.size(); ++i) {
            Slot s;
            if (list && list->kind == Value::Kind::Array && i < list->arr.size() && list->arr[i].kind == Value::Kind::Map) {
                const Value& v = list->arr[i];
                s.key = props::fieldStr(v, "key");
                s.label = props::fieldStr(v, "label");
                s.count = static_cast<int>(props::fieldInt(v, "count"));
                s.uid = props::fieldInt(v, "uid");
            }
            slots[i] = s;
        }
    };
    if (inv.kind != Value::Kind::Map) return;
    fill("pockets", pockets_);
    fill("hotbar", hotbar_);
    fill("equip", equip_);
    heldSlot_ = static_cast<int>(props::fieldInt(inv, "held"));
    if (invSelected_.valid() && slotAt(invSelected_)->empty()) invSelected_ = {};
}

GameClient::Slot* GameClient::slotAt(InvRef r) {
    switch (r.container) {
        case 0: return &pockets_[r.index];
        case 1: return &hotbar_[r.index];
        default: return &equip_[r.index];
    }
}

// ------------------------------------------------------------------ icons

void GameClient::drawIcon(const std::string& icon, float x, float y, float w, float h, Rgba tint, int level) {
    if (!shv::api.createTexture || !shv::api.drawTexture) return;
    auto it = textures_.find(icon);
    if (it == textures_.end()) {
        std::string path = iconPath(icon);
        int id = GetFileAttributesA(path.c_str()) == INVALID_FILE_ATTRIBUTES ? -1 : shv::api.createTexture(path.c_str());
        if (id < 0) log("icon not found: " + path);
        it = textures_.emplace(icon, id).first;
    }
    if (it->second < 0) return;
    int& uses = textureUses_[it->second];
    if (uses >= kTextureInstances) return;
    const float aspect = GRAPHICS::GET_ASPECT_RATIO(false);
    shv::api.drawTexture(it->second, uses++, level, 60, w, h, 0.5f, 0.5f, x + w / 2, y + h / 2, 0.0f, aspect,
                         tint.r / 255.0f, tint.g / 255.0f, tint.b / 255.0f, tint.a / 255.0f);
}

// ------------------------------------------------------------------ input

// Called every frame while spawned: the game's weapon switching is off, keys 1-9 and Tab are ours.
void GameClient::tickWeaponControls() {
    for (int c : kWeaponControls) PAD::DISABLE_CONTROL_ACTION(0, c, true);
    if (int n = hotkeyRequested_.exchange(0)) send(ScriptEvent{"gomp:inv:hotkey", {Value::integer(n)}});
    if (inventoryRequested_.exchange(false) && screen_ == Screen::None) {
        invSelected_ = invPress_ = {};
        invDragging_ = false;
        openScreen(Screen::Inventory);
    }
}

// ------------------------------------------------------------------ window

void GameClient::drawSlot(InvRef ref, float x, float y, float w, float h, const char* caption) {
    const Slot& s = *slotAt(ref);
    const bool hover = mouseX_ >= x && mouseX_ <= x + w && mouseY_ >= y && mouseY_ <= y + h;
    if (hover) invHover_ = ref;
    const bool selected = invSelected_ == ref;
    const bool held = ref.container == 1 && ref.index == heldSlot_;
    Rgba border = selected ? theme::Accent : held ? theme::Positive : hover ? theme::Muted : theme::SlotBorder;
    frame(x, y, w, h, hover ? theme::SlotHover : theme::Slot, border);
    if (caption) label(caption, x + 0.004f, y + 0.002f, 0.24f, theme::Muted);
    if (s.empty() || (invDragging_ && invPress_ == ref)) return;
    auto def = itemDefs_.find(s.key);
    const std::string icon = def != itemDefs_.end() ? def->second.icon : s.key;
    const Rgba tint = def != itemDefs_.end() ? tintOf(def->second.type) : theme::Muted;
    drawIcon(icon, x + w * 0.18f, y + h * 0.16f, w * 0.64f, h * 0.64f, tint);
    if (logic::isMk2(s.key)) label("MK II", x + 0.004f, y + h - 0.02f, 0.22f, theme::Accent);
    if (s.count > 1) label(std::to_string(s.count), x + w - 0.004f, y + h - 0.022f, 0.26f, theme::Text, Align::Right);
}

void GameClient::drawInventory() {
    const float aspect = GRAPHICS::GET_ASPECT_RATIO(false);
    const float cw = 0.052f, ch = cw * aspect, gap = 0.005f, gapY = gap * aspect;
    const float gridW = 6 * cw + 5 * gap, gridH = 4 * ch + 3 * gapY;
    const float side = 0.2f, W = side + 0.03f + gridW + 0.03f;
    const float hotCw = (gridW - 8 * gap) / 9, hotCh = hotCw * aspect;
    const float H = 0.07f + gridH + 0.05f + hotCh + 0.03f;
    const float X = 0.5f - W / 2, Y = 0.5f - H / 2;
    invHover_ = {};

    panel(X, Y, W, H);
    // Header.
    std::string name;
    if (auto it = selfProps_.find(prop::Name); it != selfProps_.end() && it->second.kind == Value::Kind::String) name = it->second.s;
    label("ИНВЕНТАРЬ", X + 0.016f, Y + 0.014f, 0.5f, theme::Text);
    label("Tab / Esc — закрыть  ·  перетащите за окно — выбросить", X + W - 0.016f, Y + 0.024f, 0.28f, theme::Muted, Align::Right);

    // Left column: character, equipment, selected item.
    const float lx = X + 0.016f, ly = Y + 0.07f;
    roundRect(lx, ly, side, 0.06f, theme::Surface, 8);
    label(name.empty() ? "-" : name, lx + 0.01f, ly + 0.006f, 0.42f, theme::Text);
    for (const auto& [k, v] : selfShared_)
        if (k == "static") pill("#" + std::to_string(v.asInt()), lx + 0.01f, ly + 0.034f, 0.022f, 0.26f, theme::AccentSoft, theme::Accent);
    float ey = ly + 0.075f;
    label("ЭКИПИРОВКА", lx, ey, 0.28f, theme::Muted);
    ey += 0.026f;
    for (int i = 0; i < 3; ++i) {
        drawSlot({2, i}, lx, ey, cw, ch, nullptr);
        const Slot& s = equip_[i];
        label(kEquipNames[i], lx + cw + 0.01f, ey + 0.004f, 0.32f, theme::Text);
        label(s.empty() ? "Пусто" : (s.label.empty() ? "Одежда" : s.label), lx + cw + 0.01f, ey + 0.03f, 0.27f, theme::Muted);
        ey += ch + gapY;
    }

    // Selected item details and actions.
    ey += 0.01f;
    const float iy = ey, ih = Y + H - 0.02f - iy;
    roundRect(lx, iy, side, ih, theme::Surface, 8);
    if (invSelected_.valid() && !slotAt(invSelected_)->empty()) {
        const Slot& s = *slotAt(invSelected_);
        auto def = itemDefs_.find(s.key);
        const ItemDef d = def != itemDefs_.end() ? def->second : ItemDef{s.key, "misc", s.key, "", 1};
        label(s.label.empty() ? d.name : d.name + " · " + s.label, lx + 0.01f, iy + 0.008f, 0.38f, theme::Text);
        label(d.desc, lx + 0.01f, iy + 0.036f, 0.27f, theme::Muted);
        std::string meta = d.stack > 1 ? "Количество: " + std::to_string(s.count) + " / " + std::to_string(d.stack)
                                       : (s.uid ? "Серийный № " + std::to_string(s.uid) : "");
        label(meta, lx + 0.01f, iy + 0.056f, 0.27f, theme::Muted);
        const float bx = lx + 0.01f, bw = side - 0.02f, bh = 0.034f;
        float by = iy + ih - 3 * (bh + 0.006f) - 0.004f;
        const char* cont = kContainers[invSelected_.container];
        if (uiButton(bx, by, bw, bh, d.type == "weapon" ? "Взять в руки (быстрый слот)" : "Использовать", true))
            send(ScriptEvent{"gomp:inv:use", {Value::string(cont), Value::integer(invSelected_.index)}});
        by += bh + 0.006f;
        if (uiButton(bx, by, bw, bh, "Разделить пополам", false, d.stack > 1 && s.count > 1)) {
            for (int i = 0; i < static_cast<int>(pockets_.size()); ++i)
                if (pockets_[i].empty()) {
                    send(ScriptEvent{"gomp:inv:move", {Value::string(cont), Value::integer(invSelected_.index), Value::string("pockets"),
                                                       Value::integer(i), Value::integer(s.count / 2)}});
                    break;
                }
        }
        by += bh + 0.006f;
        const bool confirm = GetTickCount() - dropConfirmAt_ < 3000;
        if (uiButton(bx, by, bw, bh, confirm ? "Точно выбросить?" : "Выбросить")) {
            if (confirm) {
                send(ScriptEvent{"gomp:inv:drop", {Value::string(cont), Value::integer(invSelected_.index)}});
                dropConfirmAt_ = 0;
            } else {
                dropConfirmAt_ = GetTickCount();
            }
        }
    } else {
        label("Выберите предмет", lx + side / 2, iy, 0.3f, theme::Muted, Align::Center, ih);
    }

    // Pockets grid.
    const float gx = X + side + 0.046f, gy = Y + 0.07f;
    int used = 0;
    for (const auto& s : pockets_) used += !s.empty();
    label("КАРМАНЫ", gx, gy, 0.28f, theme::Muted);
    label(std::to_string(used) + " / " + std::to_string(pockets_.size()), gx + gridW, gy, 0.28f, theme::Muted, Align::Right);
    for (int i = 0; i < static_cast<int>(pockets_.size()); ++i)
        drawSlot({0, i}, gx + (i % 6) * (cw + gap), gy + 0.026f + (i / 6) * (ch + gapY), cw, ch, nullptr);

    // Hotbar.
    const float hy = gy + 0.026f + gridH + 0.03f;
    label("БЫСТРЫЕ СЛОТЫ  ·  клавиши 1-9", gx, hy - 0.026f, 0.28f, theme::Muted);
    for (int i = 0; i < 9; ++i) {
        const std::string num = std::to_string(i + 1);
        drawSlot({1, i}, gx + i * (hotCw + gap), hy, hotCw, hotCh, num.c_str());
    }

    // Mouse: click selects, drag moves (Shift = half the stack, Ctrl = one item).
    const bool down = PAD::IS_DISABLED_CONTROL_PRESSED(2, 237);
    if (mouseClick_ && invHover_.valid() && !slotAt(invHover_)->empty()) {
        invPress_ = invHover_;
        invPressX_ = mouseX_;
        invPressY_ = mouseY_;
        invDragging_ = false;
    }
    if (invPress_.valid() && down && !invDragging_ && std::hypot(mouseX_ - invPressX_, (mouseY_ - invPressY_) / aspect) > 0.006f)
        invDragging_ = true;
    if (invPress_.valid() && invDragging_ && down) {
        const Slot& s = *slotAt(invPress_);
        auto def = itemDefs_.find(s.key);
        if (def != itemDefs_.end()) drawIcon(def->second.icon, mouseX_ - cw * 0.4f, mouseY_ - ch * 0.4f, cw * 0.8f, ch * 0.8f, tintOf(def->second.type), 10);
    }
    if (invPress_.valid() && !down) {
        const bool outside = !Rect{X, Y, W, H}.contains(mouseX_, mouseY_);
        if (invDragging_ && outside) {
            // Dragged out of the window: thrown on the ground (Shift: half, Ctrl: one).
            const Slot& s = *slotAt(invPress_);
            int count = s.count;
            if (GetAsyncKeyState(VK_SHIFT) & 0x8000) count = std::max(1, s.count / 2);
            if (GetAsyncKeyState(VK_CONTROL) & 0x8000) count = 1;
            send(ScriptEvent{"gomp:inv:drop", {Value::string(kContainers[invPress_.container]), Value::integer(invPress_.index),
                                               Value::integer(count)}});
        } else if (invDragging_ && invHover_.valid() && !(invHover_ == invPress_)) {
            const Slot& s = *slotAt(invPress_);
            int count = s.count;
            if (GetAsyncKeyState(VK_SHIFT) & 0x8000) count = std::max(1, s.count / 2);
            if (GetAsyncKeyState(VK_CONTROL) & 0x8000) count = 1;
            send(ScriptEvent{"gomp:inv:move", {Value::string(kContainers[invPress_.container]), Value::integer(invPress_.index),
                                               Value::string(kContainers[invHover_.container]), Value::integer(invHover_.index),
                                               Value::integer(count)}});
            invSelected_ = invHover_;
        } else if (!invDragging_) {
            invSelected_ = invPress_;
            dropConfirmAt_ = 0;
        }
        invPress_ = {};
        invDragging_ = false;
    }
}

// The hotbar strip at the bottom of the screen during play.
void GameClient::drawHotbar() {
    const float aspect = GRAPHICS::GET_ASPECT_RATIO(false);
    const float cw = 0.03f, ch = cw * aspect, gap = 0.004f;
    const Rect r = hotbarRect();
    for (int i = 0; i < 9; ++i) {
        const float x = settings_.hotbarVertical ? r.x : r.x + i * (cw + gap);
        const float y = settings_.hotbarVertical ? r.y + i * (ch + gap * aspect) : r.y;
        const Slot& s = hotbar_[i];
        const bool held = i == heldSlot_;
        if (s.empty() && !held) {
            frame(x, y, cw, ch, withAlpha(theme::Bg, 140), withAlpha(theme::SlotBorder, 160));
        } else {
            frame(x, y, cw, ch, theme::Hud, held ? theme::Accent : theme::SlotBorder);
            auto def = itemDefs_.find(s.key);
            if (def != itemDefs_.end()) drawIcon(def->second.icon, x + cw * 0.18f, y + ch * 0.18f, cw * 0.64f, ch * 0.64f, tintOf(def->second.type));
            if (logic::isMk2(s.key)) label("II", x + 0.003f, y + ch - 0.018f, 0.2f, theme::Accent);
            if (s.count > 1) label(std::to_string(s.count), x + cw - 0.003f, y + ch - 0.018f, 0.2f, theme::Text, Align::Right);
        }
        label(std::to_string(i + 1), x + 0.003f, y + 0.001f, 0.2f, held ? theme::Accent : theme::Muted);
    }
}

}  // namespace gompgame
