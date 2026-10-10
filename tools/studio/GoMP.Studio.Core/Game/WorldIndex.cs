// The placed world of GTA V by cells of 256 m: which ymaps (map data files)
// have entities in a cell, and those entities (archetype, place, rotation,
// scale, level of detail). Built from the game's map data hierarchy
// (GameFileCache.YmapHierarchyDict); ymaps that only exist at other hours or in
// other weather are left out (the Studio shows noon, clear sky). Interiors (MLO)
// are not included here (see Interiors.cs).
using CodeWalker.GameFiles;

namespace GoMP.Studio.Game;

// a: archetype hash; p: position; q: rotation quaternion (x, y, z, w); s: scale (null = 1);
// l: level of detail (0 HD, 1 LOD, 2-4 SLOD1-3, 5 orphan HD, 6 SLOD4); d / c: lod and child lod distance;
// m: (interiors only) index into the MLO list of the answer; u: drawn up to this distance (the parent's child lod distance, else d); k: has children (hidden within c).
public sealed record WorldEntity(uint a, float[] p, float[] q, float[] s, int l, float d, float c, float u, bool k, [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] int? m = null);

public sealed partial class WorldIndex
{
    public const float CellSize = 256;
    private static readonly uint ExtraSunny = Maps.Joaat.Hash("extrasunny");

    private readonly GameFileCache cache;
    private readonly Dictionary<(int, int), List<uint>> grid = new();
    private readonly HashSet<uint> hidden = new();
    private readonly Dictionary<uint, YmapFile> ymaps = new();
    private readonly Dictionary<(int, int), List<WorldEntity>> cells = new();
    private readonly object sync = new();

    public int YmapCount { get; }

    public WorldIndex(GameFileCache cache)
    {
        this.cache = cache;
        foreach (var m in cache.AllManifests ?? new List<YmfFile>())
            foreach (var g in m.MapDataGroups ?? Array.Empty<YmfMapDataGroup>())
            {
                if (g.HoursOnOff != 0 && (g.HoursOnOff & (1u << 12)) == 0) hidden.Add(g.Name.Hash);
                if (g.WeatherTypes != null && g.WeatherTypes.Length > 0 && !g.WeatherTypes.Any(w => w.Hash == ExtraSunny)) hidden.Add(g.Name.Hash);
            }
        foreach (var node in cache.YmapHierarchyDict?.Values ?? Enumerable.Empty<MapDataStoreNode>())
        {
            var min = node.entitiesExtentsMin;
            var max = node.entitiesExtentsMax;
            if (!(max.X >= min.X && max.Y >= min.Y) || max.X - min.X > 20000) continue;
            YmapCount++;
            for (int x = Cell(min.X); x <= Cell(max.X); x++)
                for (int y = Cell(min.Y); y <= Cell(max.Y); y++)
                {
                    if (!grid.TryGetValue((x, y), out var list)) grid[(x, y)] = list = new List<uint>();
                    list.Add(node.Name.Hash);
                }
        }
    }

    public static int Cell(float v) => (int)Math.Floor(v / CellSize);

    // The entities whose position lies in the cell.
    public IReadOnlyList<WorldEntity> Entities(int cx, int cy)
    {
        lock (sync)
        {
            if (cells.TryGetValue((cx, cy), out var done)) return done;
            var list = new List<WorldEntity>();
            float x0 = cx * CellSize, y0 = cy * CellSize;
            if (grid.TryGetValue((cx, cy), out var names))
                foreach (uint name in names)
                {
                    if (hidden.Contains(name)) continue;
                    var ymap = Ymap(name);
                    if (ymap?.AllEntities == null) continue;
                    // The ymap of the lower-detail parents: where each entity takes over from its parent.
                    uint parentName = ymap._CMapData.parent.Hash;
                    var parents = parentName != 0 ? Ymap(parentName)?.AllEntities : null;
                    foreach (var e in ymap.AllEntities)
                    {
                        if (e.Archetype == null || e.Archetype is MloArchetype) continue;
                        var p = e.Position;
                        if (p.X < x0 || p.X >= x0 + CellSize || p.Y < y0 || p.Y >= y0 + CellSize) continue;
                        var q = e.Orientation;
                        var s = e.Scale;
                        bool unit = Math.Abs(s.X - 1) < 1e-3 && Math.Abs(s.Y - 1) < 1e-3 && Math.Abs(s.Z - 1) < 1e-3;
                        int pi = e.CEntityDef.parentIndex;
                        float upper = parents != null && pi >= 0 && pi < parents.Length ? parents[pi].ChildLodDist : e.LodDist;
                        list.Add(new WorldEntity(e.Archetype.Hash, new[] { p.X, p.Y, p.Z }, new[] { q.X, q.Y, q.Z, q.W },
                            unit ? null : new[] { s.X, s.Y, s.Z }, (int)e.CEntityDef.lodLevel, e.LodDist, e.ChildLodDist,
                            upper > 0 ? upper : e.LodDist, e.CEntityDef.numChildren > 0));
                    }
                }
            if (cells.Count > 512) cells.Clear();
            cells[(cx, cy)] = list;
            return list;
        }
    }

    private YmapFile Ymap(uint name)
    {
        if (ymaps.TryGetValue(name, out var y)) return y;
        if (ymaps.Count > 2048) ymaps.Clear();
        var entry = cache.GetYmapEntry(name);
        y = entry != null ? cache.RpfMan.GetFile<YmapFile>(entry) : null;
        y?.InitYmapEntityArchetypes(cache);
        ymaps[name] = y;
        return y;
    }
}
