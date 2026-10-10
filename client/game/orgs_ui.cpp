// Organizations on the client: the bases (gomp:orgs) are real interiors of the
// map — near one its interior is switched on and its doors unlocked, so it is
// walked into like any building; the storage marker and "E" for members. The F2
// menu's "Недвижимость" (houses and cars, gomp:property) and "Организация"
// (members, ranks, permissions, gomp:org) tabs, and the server's questions
// (gomp:prompt: an invitation...). Server side: orgs.js, cars.js, prompt.js.
#include <algorithm>
#include <cmath>

#include "game_client.hpp"
#include "natives.hpp"
#include "props.hpp"
#include "ui.hpp"

namespace gompgame {

using namespace gomp;
using namespace ui;

namespace {

constexpr DWORD kDoorsEveryMs = 1000;
constexpr float kStorageRange = 1.6f;
constexpr float kStorageMarkerRange = 20.0f;
constexpr float kDoorLeaf = 0.65f;  // a double door: the leaves either side of the middle
const char* const kPerms[] = {"invite", "uninvite", "setrank", "storage", "vehicles"};

float dist(Vector3 a, Vec3 b) { return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) + (a.z - b.z) * (a.z - b.z)); }

Vec3 vec3(const Value* v) {
    if (!v || v->kind != Value::Kind::Array || v->arr.size() < 3) return {};
    return {static_cast<float>(v->arr[0].asNumber()), static_cast<float>(v->arr[1].asNumber()), static_cast<float>(v->arr[2].asNumber())};
}

}  // namespace

bool GameClient::handleOrgEvent(const ScriptEvent& e) {
    const auto& a = e.args;
    if (e.name == "gomp:orgs") {
        orgBases_.clear();
        if (!a.empty() && a[0].kind == Value::Kind::Array) {
            for (const auto& o : a[0].arr) {
                OrgBase b;
                b.id = props::fieldStr(o, "id");
                b.name = props::fieldStr(o, "name");
                if (const Value* c = props::field(o, "color"); c && c->kind == Value::Kind::Array && c->arr.size() >= 3)
                    b.color = {static_cast<int>(c->arr[0].asInt()), static_cast<int>(c->arr[1].asInt()), static_cast<int>(c->arr[2].asInt()), 255};
                const Value* base = props::field(o, "base");
                if (!base) continue;
                b.baseName = props::fieldStr(*base, "name");
                b.center = vec3(props::field(*base, "center"));
                b.radius = static_cast<float>(props::fieldNum(*base, "radius"));
                b.storage = vec3(props::field(*base, "storage"));
                if (const Value* in = props::field(*base, "interior"); in && in->kind == Value::Kind::Array) {
                    b.interior = vec3(in);
                    b.hasInterior = true;
                }
                if (const Value* ds = props::field(*base, "doors"); ds && ds->kind == Value::Kind::Array) {
                    for (const auto& d : ds->arr) {
                        OrgDoor door;
                        door.model = joaat(props::fieldStr(d, "model"));
                        door.pos = vec3(props::field(d, "pos"));
                        if (const Value* n = props::field(d, "n"); n && n->kind == Value::Kind::Array && n->arr.size() >= 2) {
                            door.nx = static_cast<float>(n->arr[0].asNumber());
                            door.ny = static_cast<float>(n->arr[1].asNumber());
                        }
                        b.doors.push_back(door);
                    }
                }
                orgBases_.push_back(std::move(b));
            }
        }
        orgDoorsAt_ = 0;
        return true;
    }
    if (e.name == "gomp:org") {
        orgView_ = a.empty() ? Value{} : a[0];
        return true;
    }
    if (e.name == "gomp:property") {
        propertyView_ = a.empty() ? Value{} : a[0];
        return true;
    }
    if (e.name == "gomp:prompt" && !a.empty()) {
        const int64_t id = props::fieldInt(a[0], "id");
        std::vector<ChoiceOption> options;
        if (const Value* o = props::field(a[0], "options"); o && o->kind == Value::Kind::Array)
            for (std::size_t i = 0; i < o->arr.size(); ++i)
                options.push_back({o->arr[i].s, [this, id, i] { send(ScriptEvent{"gomp:prompt:answer", {Value::integer(id), Value::integer(static_cast<int64_t>(i))}}); }});
        if (screen_ != Screen::None) closeScreens();
        openChoice(props::fieldStr(a[0], "title"), std::move(options), props::fieldStr(a[0], "text"),
                   [this, id] { send(ScriptEvent{"gomp:prompt:answer", {Value::integer(id), Value::integer(-1)}}); });
        return true;
    }
    return false;
}

// Every frame: bases nearby keep their interior on and their doors unlocked (once a
// second); a member at his base's storage gets the marker and "E".
bool GameClient::tickOrgBases(bool interact, bool hintTaken) {
    if (orgBases_.empty()) return false;
    const Ped me = PLAYER::PLAYER_PED_ID();
    const Vector3 here = ENTITY::GET_ENTITY_COORDS(me, true);
    const DWORD now = GetTickCount();
    if (now - orgDoorsAt_ >= kDoorsEveryMs) {
        orgDoorsAt_ = now;
        for (const OrgBase& b : orgBases_) {
            if (dist(here, b.center) > b.radius + 80.0f) continue;
            if (b.hasInterior) {
                // Story mode switches some interiors off; GoMP opens them (like houses.cpp does).
                if (const Interior in = INTERIOR::GET_INTERIOR_AT_COORDS(b.interior.x, b.interior.y, b.interior.z)) {
                    if (INTERIOR::IS_INTERIOR_DISABLED(in)) INTERIOR::DISABLE_INTERIOR(in, false);
                    if (INTERIOR::IS_INTERIOR_CAPPED(in)) INTERIOR::CAP_INTERIOR(in, false);
                    INTERIOR::PIN_INTERIOR_IN_MEMORY(in);
                }
            }
            for (const OrgDoor& d : b.doors) {
                // The middle of the doorway and the two leaves of a double door.
                const float tx = -d.ny * kDoorLeaf, ty = d.nx * kDoorLeaf;
                OBJECT::SET_STATE_OF_CLOSEST_DOOR_OF_TYPE(d.model, d.pos.x, d.pos.y, d.pos.z, false, 0.0f, false);
                OBJECT::SET_STATE_OF_CLOSEST_DOOR_OF_TYPE(d.model, d.pos.x + tx, d.pos.y + ty, d.pos.z, false, 0.0f, false);
                OBJECT::SET_STATE_OF_CLOSEST_DOOR_OF_TYPE(d.model, d.pos.x - tx, d.pos.y - ty, d.pos.z, false, 0.0f, false);
            }
        }
    }
    if (screen_ != Screen::None || dead_) return false;
    const Value* org = props::shared(selfShared_, "org");
    if (!org || org->kind != Value::Kind::String) return false;
    for (const OrgBase& b : orgBases_) {
        if (b.id != org->s) continue;
        const float d = dist(here, b.storage);
        if (d > kStorageMarkerRange) return false;
        GRAPHICS::DRAW_MARKER(1, b.storage.x, b.storage.y, b.storage.z - 0.98f, 0, 0, 0, 0, 0, 0, 0.9f, 0.9f, 0.3f, b.color.r, b.color.g,
                              b.color.b, 130, false, false, 2, false, nullptr, nullptr, false);
        if (hintTaken || d > kStorageRange || PED::IS_PED_IN_ANY_VEHICLE(me, false)) return false;
        drawHint("E", "Склад " + b.name);
        if (interact) send(ScriptEvent{"gomp:org:storage", {}});
        return true;
    }
    return false;
}

// ------------------------------------------------------------------ F2: property

void GameClient::drawPropertyTab(float cx, float cy, float cw, float bottom) {
    const DWORD now = GetTickCount();
    if (now - propertyAskedAt_ > 3000) {  // refreshed while the tab is open: cars move
        propertyAskedAt_ = now;
        send(ScriptEvent{"gomp:property:get", {}});
    }
    const Value& v = propertyView_;
    if (v.kind != Value::Kind::Map) {
        label("Загрузка…", cx, cy, 0.34f, theme::Muted);
        return;
    }
    label("ДОМА", cx, cy, 0.28f, theme::Muted);
    cy += 0.026f;
    const Value* houses = props::field(v, "houses");
    if (!houses || houses->kind != Value::Kind::Array || houses->arr.empty()) {
        label("Нет купленной недвижимости — дома покупаются у двери (зелёные домики на карте)", cx, cy, 0.3f, theme::Muted);
        cy += 0.04f;
    } else {
        for (const auto& h : houses->arr) {
            roundRect(cx, cy, cw, 0.07f, theme::Surface, 8);
            label(props::fieldStr(h, "name"), cx + 0.012f, cy + 0.008f, 0.4f, theme::Text);
            label(props::fieldStr(h, "cls") + "  ·  гараж " + std::to_string(props::fieldInt(h, "garage")) + " / " +
                      std::to_string(props::fieldInt(h, "cap")) + "  ·  " + money(props::fieldInt(h, "price")),
                  cx + 0.012f, cy + 0.04f, 0.3f, theme::Muted);
            if (uiButton(cx + cw - 0.11f, cy + 0.017f, 0.1f, 0.036f, "Метка")) {
                HUD::SET_NEW_WAYPOINT(static_cast<float>(props::fieldNum(h, "x")), static_cast<float>(props::fieldNum(h, "y")));
                notify("Дом отмечен на карте");
            }
            cy += 0.078f;
        }
    }
    const Value* cars = props::field(v, "cars");
    const int count = cars && cars->kind == Value::Kind::Array ? static_cast<int>(cars->arr.size()) : 0;
    label("ТРАНСПОРТ  " + std::to_string(count) + " / " + std::to_string(props::fieldInt(v, "maxCars")), cx, cy + 0.006f, 0.28f, theme::Muted);
    cy += 0.032f;
    if (!count) {
        label("Машин нет — их продаёт автосалон Premium Deluxe Motorsport", cx, cy, 0.3f, theme::Muted);
        return;
    }
    const float rh = 0.05f;
    for (const auto& c : cars->arr) {
        if (cy + rh > bottom) break;
        const int64_t id = props::fieldInt(c, "id");
        const std::string model = props::fieldStr(c, "model");
        const std::string status = props::fieldStr(c, "status");
        roundRect(cx, cy, cw, rh, theme::Surface, 7);
        label(vehicleName(joaat(model), model), cx + 0.012f, cy + 0.004f, 0.36f, theme::Text);
        const std::string where = status == "garage" ? "в гараже: " + props::fieldStr(c, "house") : status == "out" ? "на улице" : "на парковке";
        label(props::fieldStr(c, "plate") + "  ·  " + where, cx + 0.012f, cy + 0.027f, 0.27f, status == "out" ? theme::Positive : theme::Muted);
        const float bw = 0.085f, bh = 0.032f, by = cy + (rh - bh) / 2;
        float bx = cx + cw - bw - 0.008f;
        if (status == "parked") {
            if (uiButton(bx, by, bw, bh, "Вызвать", true)) {
                const Vector3 p = ENTITY::GET_ENTITY_COORDS(PLAYER::PLAYER_PED_ID(), true);
                Vec3 spot;
                float heading = 0;
                if (roadSpot({p.x, p.y, p.z}, spot, heading))
                    send(ScriptEvent{"gomp:car:call", {Value::integer(id), Value::number(spot.x), Value::number(spot.y), Value::number(spot.z), Value::number(heading)}});
                else
                    notify("~r~Рядом нет дороги");
            }
        } else if (status == "out") {
            if (uiButton(bx, by, bw, bh, "На парковку")) send(ScriptEvent{"gomp:car:park", {Value::integer(id)}});
            bx -= bw + 0.006f;
            if (uiButton(bx, by, bw, bh, "Метка", true)) {
                HUD::SET_NEW_WAYPOINT(static_cast<float>(props::fieldNum(c, "x")), static_cast<float>(props::fieldNum(c, "y")));
                notify("Машина отмечена на карте");
            }
        }
        cy += rh + 0.006f;
    }
}

// ------------------------------------------------------------------ F2: organization

void GameClient::drawOrgTab(float cx, float cy, float cw, float bottom) {
    const DWORD now = GetTickCount();
    if (now - orgAskedAt_ > 3000) {
        orgAskedAt_ = now;
        send(ScriptEvent{"gomp:org:get", {}});
    }
    const Value& v = orgView_;
    if (v.kind != Value::Kind::Map) {
        label("Вы не состоите в организации", cx, cy, 0.38f, theme::Text);
        label("Пригласить может руководство LSPD, Army, EMS или GOV (/invite); лидеров назначает администрация.", cx, cy + 0.035f, 0.3f, theme::Muted);
        return;
    }
    const bool leader = props::field(v, "leader") && props::field(v, "leader")->asNumber() != 0;
    const Value* perms = props::field(v, "perms");
    auto can = [&](const char* p) { const Value* x = perms ? props::field(*perms, p) : nullptr; return x && x->asNumber() != 0; };
    const int myRank = static_cast<int>(props::fieldInt(v, "rank"));
    const Value* ranks = props::field(v, "ranks");
    const int rankCount = ranks && ranks->kind == Value::Kind::Array ? static_cast<int>(ranks->arr.size()) : 0;
    auto rankName = [&](int r) { return r >= 1 && r <= rankCount ? props::fieldStr(ranks->arr[r - 1], "name") : std::to_string(r); };

    // Header.
    roundRect(cx, cy, cw, 0.066f, theme::Surface, 8);
    label(props::fieldStr(v, "full"), cx + 0.012f, cy + 0.008f, 0.42f, theme::Text);
    label("Ваш ранг: " + std::to_string(myRank) + " · " + props::fieldStr(v, "rankName") + (leader ? "  (лидер)" : ""), cx + 0.012f, cy + 0.038f, 0.3f,
          theme::Accent);
    cy += 0.076f;

    // The leader edits a rank: its name and permissions.
    if (leader && orgRankEdit_ >= 0 && orgRankEdit_ < rankCount - 1) {
        label("РАНГ " + std::to_string(orgRankEdit_ + 1), cx, cy, 0.28f, theme::Muted);
        cy += 0.024f;
        uiTextField(cx, cy, cw, "Название", orgRankName_, false);
        cy += 0.07f;
        const Value* names = props::field(v, "permNames");
        for (const char* p : kPerms) {
            const float rh = 0.036f;
            bool& on = orgRankPerms_[p];
            const bool hover = mouseX_ >= cx && mouseX_ <= cx + cw && mouseY_ >= cy && mouseY_ <= cy + rh;
            roundRect(cx, cy, cw, rh, hover ? theme::SurfaceHi : theme::Surface, 6);
            label(names ? props::fieldStr(*names, p) : p, cx + 0.012f, cy, 0.32f, theme::Text, Align::Left, rh);
            label(on ? "да" : "нет", cx + cw - 0.012f, cy, 0.32f, on ? theme::Positive : theme::Muted, Align::Right, rh);
            if (hover && mouseClick_) on = !on;
            cy += rh + 0.005f;
        }
        cy += 0.008f;
        const float bw = (cw - 0.008f) / 2;
        if (uiButton(cx, cy, bw, 0.04f, "Сохранить", true)) {
            Value pm;
            pm.kind = Value::Kind::Map;
            for (const char* p : kPerms) pm.map.emplace_back(p, Value::boolean(orgRankPerms_[p]));
            send(ScriptEvent{"gomp:org:rank", {Value::integer(orgRankEdit_), Value::string(orgRankName_), pm}});
            orgRankEdit_ = -1;
            orgAskedAt_ = 0;
        }
        if (uiButton(cx + bw + 0.008f, cy, bw, 0.04f, "Отмена")) orgRankEdit_ = -1;
        return;
    }

    // Members: name, rank; promote / demote / dismiss by permission.
    const Value* members = props::field(v, "members");
    const int total = members && members->kind == Value::Kind::Array ? static_cast<int>(members->arr.size()) : 0;
    label("СОСТАВ  " + std::to_string(total), cx, cy, 0.28f, theme::Muted);
    if (leader) label("Ранги: нажмите на ранг ниже, чтобы настроить", cx + cw, cy, 0.26f, theme::Muted, Align::Right);
    cy += 0.026f;
    const float rh = 0.04f;
    const float ranksH = leader ? 0.11f : 0.0f;
    const int visible = std::max(1, static_cast<int>((bottom - cy - ranksH) / (rh + 0.005f)));
    if (mouseX_ >= cx && mouseX_ <= cx + cw && mouseY_ >= cy && mouseY_ <= cy + visible * (rh + 0.005f)) {
        if (PAD::IS_DISABLED_CONTROL_JUST_PRESSED(2, 241)) --orgMemberScroll_;
        if (PAD::IS_DISABLED_CONTROL_JUST_PRESSED(2, 242)) ++orgMemberScroll_;
    }
    orgMemberScroll_ = std::clamp(orgMemberScroll_, 0, std::max(0, total - visible));
    const int64_t me = props::shared(selfShared_, "static") ? props::shared(selfShared_, "static")->asInt() : -1;
    for (int i = 0; i < visible && orgMemberScroll_ + i < total; ++i) {
        const Value& m = members->arr[orgMemberScroll_ + i];
        const int64_t st = props::fieldInt(m, "static");
        const int r = static_cast<int>(props::fieldInt(m, "rank"));
        const bool online = props::field(m, "online") && props::field(m, "online")->asNumber() != 0;
        roundRect(cx, cy, cw, rh, theme::Surface, 6);
        label((online ? "● " : "○ ") + props::fieldStr(m, "name") + "  #" + std::to_string(st), cx + 0.01f, cy, 0.31f, online ? theme::Text : theme::Muted,
              Align::Left, rh);
        label(std::to_string(r) + " · " + rankName(r), cx + cw * 0.52f, cy, 0.29f, theme::Muted, Align::Left, rh);
        const logic::OrgActions act = logic::orgActions(myRank, leader, can("setrank"), can("uninvite"), r, rankCount, st == me);
        const float bw = 0.026f, bh = 0.028f, by = cy + (rh - bh) / 2;
        float bx = cx + cw - bw - 0.006f;
        if (act.kick && uiButton(bx, by, bw, bh, "x")) send(ScriptEvent{"gomp:org:kick", {Value::integer(st)}});
        bx -= bw + 0.004f;
        if (act.demote && uiButton(bx, by, bw, bh, "-")) send(ScriptEvent{"gomp:org:setrank", {Value::integer(st), Value::integer(r - 1)}});
        bx -= bw + 0.004f;
        if (act.promote && uiButton(bx, by, bw, bh, "+")) send(ScriptEvent{"gomp:org:setrank", {Value::integer(st), Value::integer(r + 1)}});
        cy += rh + 0.005f;
    }

    // The leader's rank list (the top rank is his own and stays as it is).
    if (!leader) return;
    cy = bottom - ranksH + 0.006f;
    float rx = cx;
    for (int r = 0; r < rankCount - 1; ++r) {
        const std::string text = std::to_string(r + 1) + ". " + props::fieldStr(ranks->arr[r], "name");
        const float w = textWidth(text, 0.27f) + 0.014f, h = 0.028f;
        if (rx + w > cx + cw) {
            rx = cx;
            cy += h + 0.005f;
        }
        const bool hover = mouseX_ >= rx && mouseX_ <= rx + w && mouseY_ >= cy && mouseY_ <= cy + h;
        roundRect(rx, cy, w, h, hover ? theme::SurfaceHi : theme::Surface, 5);
        label(text, rx + w / 2, cy, 0.27f, theme::Text, Align::Center, h);
        if (hover && mouseClick_) {
            orgRankEdit_ = r;
            orgRankName_ = props::fieldStr(ranks->arr[r], "name");
            const Value* rp = props::field(ranks->arr[r], "perms");
            for (const char* p : kPerms) {
                const Value* x = rp ? props::field(*rp, p) : nullptr;
                orgRankPerms_[p] = x && x->asNumber() != 0;
            }
        }
        rx += w + 0.005f;
    }
}

}  // namespace gompgame
