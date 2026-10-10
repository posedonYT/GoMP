// The geometry of interiors (MLO) near a point, in world space. The world cells
// (WorldIndex.Entities) leave interiors out; here the instances of MLO archetypes
// in the map data (ymap) are found and their rooms' entities returned in the same
// format, so the browser draws them like the rest of the world.
//
// CodeWalker does the placing: after InitYmapEntityArchetypes every MLO instance
// (YmapEntityDef.IsMlo) has MloInstance.Entities, whose Position / Orientation are
// already in world space (the instance's place and rotation applied to the entity's
// place inside the MLO). Entity sets (furniture variants) are included only when the
// instance lists them as default (MloInstanceEntitySet.Visible).
using CodeWalker;
using CodeWalker.GameFiles;

namespace GoMP.Studio.Game;

// pos: where the interior instance is; entities: how many of the returned entities belong to it.
// Entrance: index into InteriorGeometry.Doors of the most likely way in from outside (-1: none).
public sealed record MloInfo(string Name, uint Hash, float[] Pos, int Entities, bool Contains)
{
    public int Entrance { get; init; } = -1;
}

public sealed record InteriorGeometry(IReadOnlyList<MloInfo> Mlos, IReadOnlyList<WorldEntity> Entities)
{
    public IReadOnlyList<DoorPortal> Doors { get; init; } = Array.Empty<DoorPortal>();
}

// A portal of an MLO with a door model attached, in world space. Normal: unit, horizontal,
// points into the room one walks into (for an outside door: away from the outside; for an
// inner one: from RoomFrom to RoomTo). Kind: see DoorsOf. Bottom: the lowest z of the portal, i.e. the floor at the door.
// Corners: the portal's quad in world space, for drawing.
public sealed record DoorPortal(int M, string Model, bool Outside, string Room, string RoomFrom, string RoomTo,
    float[] Center, float[] Normal, float Bottom, float Width, float Height, float[][] Corners, string Kind = "portal");

public sealed partial class WorldIndex
{
    // Interiors are drawn at any distance and never stand in for or hide behind other
    // levels of detail: level 0 (HD), no children, lod distance far beyond any view.
    public const float InteriorDistance = 10000;
    // A point counts as inside a room when it is within this of the room's box.
    public const float RoomMargin = 0.5f;

    private readonly Dictionary<(int, int, int, int, bool), InteriorGeometry> interiorCache = new();

    // Instances within margin of the point are looked at; of them the entities within r.
    // Mlos: the ones that contain the point first, then by distance; every entity's m is its index there.
    // onlyContains: just the interior(s) containing the point, else the nearest one.
    public InteriorGeometry InteriorsNear(float x, float y, float z, float r = 60, float margin = 120, bool onlyContains = false)
    {
        var key = ((int)MathF.Round(x), (int)MathF.Round(y), (int)MathF.Round(z), (int)MathF.Round(r), onlyContains);
        lock (sync)
        {
            if (interiorCache.TryGetValue(key, out var done)) return done;
            var found = new List<(MloInfo Info, List<WorldEntity> Ents, float Dist, List<DoorPortal> Doors)>();
            var seen = new HashSet<(uint, int, int, int)>();
            var ymapNames = new HashSet<uint>();
            float reach = r + margin;
            for (int cx = Cell(x - reach); cx <= Cell(x + reach); cx++)
                for (int cy = Cell(y - reach); cy <= Cell(y + reach); cy++)
                    if (grid.TryGetValue((cx, cy), out var names))
                        foreach (uint n in names) ymapNames.Add(n);

            foreach (uint name in ymapNames)
            {
                var ymap = Ymap(name);
                if (ymap?.MloEntities == null) continue;
                foreach (var mlo in ymap.MloEntities)
                {
                    var inst = mlo.MloInstance;
                    if (inst?.Entities == null || mlo.Archetype == null) continue;
                    var mp = mlo.Position;
                    if (Dist(mp.X, mp.Y, mp.Z, x, y, z) > reach) continue;
                    // The same interior may be placed by several ymaps (updates): once.
                    if (!seen.Add((mlo.Archetype.Hash, (int)MathF.Round(mp.X), (int)MathF.Round(mp.Y), (int)MathF.Round(mp.Z)))) continue;
                    var ents = new List<WorldEntity>();
                    foreach (var e in inst.Entities) Add(e, x, y, z, r, ents);
                    if (inst.EntitySets != null)
                        foreach (var set in inst.EntitySets)
                            if (set.Visible && set.Entities != null)
                                foreach (var e in set.Entities) Add(e, x, y, z, r, ents);
                    if (ents.Count == 0) continue;
                    string label = JenkIndex.TryGetString(mlo.Archetype.Hash);
                    if (string.IsNullOrEmpty(label)) label = JenkIndex.TryGetString(mlo.Archetype.BaseArchetypeDef.name.Hash);
                    if (string.IsNullOrEmpty(label)) label = "0x" + mlo.Archetype.Hash.Hash.ToString("x8");
                    float d = RoomDistance(mlo, x, y, z);
                    found.Add((new MloInfo(label, mlo.Archetype.Hash, new[] { mp.X, mp.Y, mp.Z }, ents.Count, d <= RoomMargin), ents, d, DoorsOf(mlo)));
                }
            }
            var ordered = found.OrderByDescending(f => f.Info.Contains).ThenBy(f => f.Dist).ToList();
            if (onlyContains)
                ordered = ordered.Any(f => f.Info.Contains) ? ordered.Where(f => f.Info.Contains).ToList() : ordered.Take(1).ToList();
            var mlos = new List<MloInfo>();
            var entities = new List<WorldEntity>();
            var doors = new List<DoorPortal>();
            foreach (var f in ordered)
            {
                int m = mlos.Count;
                int first = doors.Count;
                doors.AddRange(f.Doors.Select(dp => dp with { M = m }));
                mlos.Add(f.Info with { Entrance = PickEntrance(doors, first, x, y, z) });
                entities.AddRange(f.Ents.Select(e => e with { m = m }));
            }
            var result = new InteriorGeometry(mlos, entities) { Doors = doors };
            if (interiorCache.Count > 32) interiorCache.Clear();
            interiorCache[key] = result;
            return result;
        }
    }

    // The entrance among doors[from..]: an outside door, the nearest to the point (the spawn
    // is usually in the room by the door); -1 when there is none.
    public static int PickEntrance(IReadOnlyList<DoorPortal> doors, int from, float x, float y, float z)
    {
        int best = -1;
        float bestD = float.MaxValue;
        for (int i = from; i < doors.Count; i++)
        {
            var dp = doors[i];
            if (!dp.Outside) continue;
            float d = Dist(dp.Center[0], dp.Center[1], dp.Center[2], x, y, z);
            if (d < bestD) { bestD = d; best = i; }
        }
        return best;
    }

    // The ways into the MLO from outside, in world space; a room is "limbo" when it is the
    // outside (room 0). The game data does not mark the front door in one way, so the
    // candidates come in tiers, and a lower tier is used only when the one above has nothing:
    //   portal  - a portal to the outside with a door model attached (the ideal; none of the
    //             apartments has one);
    //   door    - a door model attached to a room, not to a portal: the front door standing
    //             in the entrance hall (the studio: v_ilev_mldoor02);
    //   hall    - a portal from the outside into a room called hall/entry/foyer (Integrity Way);
    //   hallway - the portal that joins such a room to the rest, a doorway (Renovated: the
    //             real front door is part of the shell model, only the doorway is in the data).
    // Doors between inner rooms (a model attached to a portal) are listed too, with Outside = false.
    private static List<DoorPortal> DoorsOf(YmapEntityDef mlo)
    {
        var list = new List<DoorPortal>();
        var arch = mlo.Archetype as MloArchetype;
        if (arch?.portals == null || arch.rooms == null) return list;
        var q = mlo.Orientation;
        var p = mlo.Position;
        string RoomName(uint i) => i < arch.rooms.Length ? arch.rooms[i].RoomName ?? "" : "";
        string EntityName(uint idx)
        {
            if (arch.entities == null || idx >= arch.entities.Length) return null;
            var h = arch.entities[idx]._Data.archetypeName;
            var name = JenkIndex.TryGetString(h);
            return string.IsNullOrEmpty(name) ? "0x" + h.Hash.ToString("x8") : name;
        }
        DoorPortal FromPortal(MCMloPortalDef portal, string model, string kind)
        {
            uint from = portal.Data.roomFrom, to = portal.Data.roomTo;
            bool outside = IsLimbo(arch, from) || IsLimbo(arch, to);
            // The room one walks into: the inner side of an outside door, else roomTo.
            uint into = outside ? (IsLimbo(arch, from) ? to : from) : to;
            if (into >= arch.rooms.Length) return null;
            var corners = ToWorld(portal.Corners.Select(c => new SharpDX.Vector3(c.X, c.Y, c.Z)), q, p);
            var roomCenter = q.Multiply(arch.rooms[into].BBCenter) + p;
            return PortalToWorld(corners, roomCenter, outside, RoomName(from), RoomName(to), RoomName(into), model, kind);
        }

        var portalDoors = new List<DoorPortal>();
        foreach (var portal in arch.portals)
        {
            if (portal.Corners == null || portal.Corners.Length < 3 || portal.AttachedObjects == null) continue;
            string model = portal.AttachedObjects.Select(EntityName).FirstOrDefault(n => n != null && n.Contains("door", StringComparison.OrdinalIgnoreCase));
            if (model == null) continue;
            var dp = FromPortal(portal, model, "portal");
            if (dp != null) portalDoors.Add(dp);
        }
        list.AddRange(portalDoors);
        if (portalDoors.Any(d => d.Outside)) return list;

        // Tier "door": a door model on a room.
        var inst = mlo.MloInstance;
        for (int ri = 1; ri < arch.rooms.Length; ri++)
        {
            var room = arch.rooms[ri];
            if (IsLimbo(arch, (uint)ri) || room.AttachedObjects == null) continue;
            foreach (uint idx in room.AttachedObjects)
            {
                string name = EntityName(idx);
                if (name == null || !name.Contains("door", StringComparison.OrdinalIgnoreCase)) continue;
                // Not a door to walk through: shower doors, the garage lift.
                if (name.Contains("shower", StringComparison.OrdinalIgnoreCase) || name.Contains("lift", StringComparison.OrdinalIgnoreCase) || name.Contains("garage", StringComparison.OrdinalIgnoreCase)) continue;
                if (inst?.Entities == null || idx >= inst.Entities.Length) continue;
                var e = inst.Entities[idx];
                if (e?.Archetype == null) continue;
                var dp = DoorOfEntity(e, q.Multiply(room.BBCenter) + p, RoomName((uint)ri), name);
                if (dp != null) list.Add(dp);
            }
        }
        if (list.Any(d => d.Outside)) return list;

        // Tiers "hall" and "hallway": by the name of the entry room.
        static bool IsHall(string n) => n.Contains("hall", StringComparison.OrdinalIgnoreCase) || n.Contains("entr", StringComparison.OrdinalIgnoreCase) || n.Contains("foyer", StringComparison.OrdinalIgnoreCase);
        var shaped = arch.portals.Where(pt => pt.Corners != null && pt.Corners.Length >= 3).ToList();
        foreach (var pt in shaped)
        {
            bool toLimbo = IsLimbo(arch, pt.Data.roomFrom) || IsLimbo(arch, pt.Data.roomTo);
            uint inner = IsLimbo(arch, pt.Data.roomFrom) ? pt.Data.roomTo : pt.Data.roomFrom;
            if (!toLimbo || !IsHall(RoomName(inner))) continue;
            var dp = FromPortal(pt, null, "hall");
            if (dp != null) list.Add(dp);
        }
        if (list.Any(d => d.Outside)) return list;
        foreach (var pt in shaped)
        {
            bool fromHall = IsHall(RoomName(pt.Data.roomFrom)), toHall = IsHall(RoomName(pt.Data.roomTo));
            if (fromHall == toHall) continue;
            // Face into the hall, whichever way the portal was written.
            uint hall = fromHall ? pt.Data.roomFrom : pt.Data.roomTo;
            var corners = ToWorld(pt.Corners.Select(c => new SharpDX.Vector3(c.X, c.Y, c.Z)), q, p);
            var dp = PortalToWorld(corners, q.Multiply(arch.rooms[hall].BBCenter) + p, true,
                RoomName(pt.Data.roomFrom), RoomName(pt.Data.roomTo), RoomName(hall), null, "hallway");
            if (dp != null) list.Add(dp);
        }
        return list;
    }

    // A door model standing in a room: centre of its box, floor under it, and the normal
    // along the thin side of the box, signed towards the room's centre.
    private static DoorPortal DoorOfEntity(YmapEntityDef e, SharpDX.Vector3 roomCenter, string room, string model)
    {
        var lo = e.Archetype.BBMin;
        var hi = e.Archetype.BBMax;
        var size = hi - lo;
        var c = e.Orientation.Multiply((lo + hi) * 0.5f) + e.Position;
        // The leaf is thin along its local X or Y; the other is the width.
        var thin = size.X < size.Y ? SharpDX.Vector3.UnitX : SharpDX.Vector3.UnitY;
        float width = Math.Max(size.X, size.Y);
        var n = e.Orientation.Multiply(thin);
        double len = Math.Sqrt(n.X * n.X + n.Y * n.Y);
        if (len < 1e-6) return null;
        double nx = n.X / len, ny = n.Y / len;
        if (nx * (roomCenter.X - c.X) + ny * (roomCenter.Y - c.Y) < 0) { nx = -nx; ny = -ny; }
        float bottom = e.Position.Z + lo.Z;
        float top = e.Position.Z + hi.Z;
        // The quad across the leaf, for drawing.
        float hx = (float)(-ny * width / 2), hy = (float)(nx * width / 2);
        var corners = new[]
        {
            new[] { c.X - hx, c.Y - hy, bottom }, new[] { c.X + hx, c.Y + hy, bottom },
            new[] { c.X + hx, c.Y + hy, top }, new[] { c.X - hx, c.Y - hy, top },
        };
        return new DoorPortal(0, model, true, room, "", room, new[] { c.X, c.Y, c.Z }, new[] { (float)nx, (float)ny, 0f }, bottom, width, top - bottom, corners, "door");
    }

    private static bool IsLimbo(MloArchetype arch, uint room) =>
        room == 0 || (room < arch.rooms.Length && string.Equals(arch.rooms[room].RoomName, "limbo", StringComparison.OrdinalIgnoreCase));

    // Portal corners in the MLO's own space -> world (the instance's rotation, then its place).
    public static SharpDX.Vector3[] ToWorld(IEnumerable<SharpDX.Vector3> local, SharpDX.Quaternion q, SharpDX.Vector3 pos) =>
        local.Select(c => q.Multiply(c) + pos).ToArray();

    // The door from world-space corners. The normal is the portal plane's, flattened to the
    // horizontal and signed towards the destination room's centre (the winding of the corners
    // does not tell which side is which). Null for a portal lying flat (a hatch has no side to face).
    public static DoorPortal PortalToWorld(SharpDX.Vector3[] c, SharpDX.Vector3 roomCenter, bool outside,
        string roomFrom, string roomTo, string room, string model, string kind = "portal")
    {
        // Newell's method: robust for any polygon.
        double nx = 0, ny = 0;
        for (int i = 0; i < c.Length; i++)
        {
            var a = c[i];
            var b = c[(i + 1) % c.Length];
            nx += (a.Y - b.Y) * (a.Z + b.Z);
            ny += (a.Z - b.Z) * (a.X + b.X);
        }
        double len = Math.Sqrt(nx * nx + ny * ny);
        if (len < 1e-6) return null;
        nx /= len; ny /= len;
        float cx = c.Average(v => v.X), cy = c.Average(v => v.Y), cz = c.Average(v => v.Z);
        if (nx * (roomCenter.X - cx) + ny * (roomCenter.Y - cy) < 0) { nx = -nx; ny = -ny; }
        // Width along the portal (horizontal, perpendicular to the normal); height along z.
        var proj = c.Select(v => v.X * -ny + v.Y * nx).ToArray();
        float width = (float)(proj.Max() - proj.Min());
        float bottom = c.Min(v => v.Z);
        float height = c.Max(v => v.Z) - bottom;
        return new DoorPortal(0, model, outside, room, roomFrom, roomTo, new[] { cx, cy, cz }, new[] { (float)nx, (float)ny, 0f },
            bottom, width, height, c.Select(v => new[] { v.X, v.Y, v.Z }).ToArray(), kind);
    }

    // Metres from the point to the nearest room of the instance (0 inside). The first room
    // of an MLO is "limbo" (the outside): it is left out. The rooms' boxes are in the
    // MLO's own space, so the point is brought there first.
    private static float RoomDistance(YmapEntityDef mlo, float x, float y, float z)
    {
        var rooms = (mlo.Archetype as MloArchetype)?.rooms;
        if (rooms == null) return float.MaxValue;
        var local = SharpDX.Quaternion.Invert(mlo.Orientation).Multiply(new SharpDX.Vector3(x, y, z) - mlo.Position);
        float best = float.MaxValue;
        for (int i = 0; i < rooms.Length; i++)
        {
            var room = rooms[i];
            if (i == 0 || string.Equals(room.RoomName, "limbo", StringComparison.OrdinalIgnoreCase)) continue;
            var lo = SharpDX.Vector3.Min(room.BBMin, room.BBMax);
            var hi = SharpDX.Vector3.Max(room.BBMin, room.BBMax);
            float dx = Math.Max(Math.Max(lo.X - local.X, local.X - hi.X), 0);
            float dy = Math.Max(Math.Max(lo.Y - local.Y, local.Y - hi.Y), 0);
            float dz = Math.Max(Math.Max(lo.Z - local.Z, local.Z - hi.Z), 0);
            best = Math.Min(best, MathF.Sqrt(dx * dx + dy * dy + dz * dz));
        }
        return best;
    }

    private static void Add(YmapEntityDef e, float x, float y, float z, float r, List<WorldEntity> into)
    {
        if (e?.Archetype == null || e.Archetype is MloArchetype) return;
        var p = e.Position;
        if (Dist(p.X, p.Y, p.Z, x, y, z) > r) return;
        var q = e.Orientation;
        var s = e.Scale;
        bool unit = Math.Abs(s.X - 1) < 1e-3 && Math.Abs(s.Y - 1) < 1e-3 && Math.Abs(s.Z - 1) < 1e-3;
        into.Add(new WorldEntity(e.Archetype.Hash, new[] { p.X, p.Y, p.Z }, new[] { q.X, q.Y, q.Z, q.W },
            unit ? null : new[] { s.X, s.Y, s.Z }, 0, InteriorDistance, 0, InteriorDistance, false, 0));
    }

    private static float Dist(float ax, float ay, float az, float bx, float by, float bz) =>
        MathF.Sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by) + (az - bz) * (az - bz));
}
