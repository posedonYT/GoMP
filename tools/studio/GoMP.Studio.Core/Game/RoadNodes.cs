// Vehicle path nodes of the game (the nodes*.ynd files), used to put a garage
// entrance onto a road: the nearest node to a house door and the way the
// traffic flows there. Read lazily the first time it is needed.
using CodeWalker.GameFiles;

namespace GoMP.Studio.Game;

// Headings of the links leaving the node, in degrees (0 = +y, counterclockwise, as GTA).
public sealed record RoadNode(float X, float Y, float Z, float[] Headings);

public sealed record RoadHit(RoadNode Node, float Dist);

public sealed record RoadSuggestion(float X, float Y, float Z, float Heading);

public sealed class RoadNodes
{
    private readonly RoadNode[] nodes;

    public RoadNodes(IEnumerable<RoadNode> nodes) => this.nodes = nodes.ToArray();

    public int Count => nodes.Length;
    public int Links { get; private init; }
    public static RoadNodes Empty => new(Array.Empty<RoadNode>());

    // The nearest nodes within r metres (3D), closest first.
    public List<RoadHit> Nearest(float x, float y, float z, float r, int limit = 5)
    {
        var hits = new List<RoadHit>();
        float r2 = r * r;
        foreach (var n in nodes)
        {
            float dx = n.X - x, dy = n.Y - y, dz = n.Z - z;
            float d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= r2) hits.Add(new RoadHit(n, MathF.Sqrt(d2)));
        }
        hits.Sort((a, b) => a.Dist.CompareTo(b.Dist));
        if (hits.Count > limit) hits.RemoveRange(limit, hits.Count - limit);
        return hits;
    }

    // A garage entrance on the node: z + 1 (the ground + 1 convention of houses.json) and the
    // link heading that keeps the door on the right (right-hand traffic). No links: heading 0.
    public static RoadSuggestion Suggest(RoadNode node, float doorX, float doorY)
    {
        float best = 0, bestDot = float.NegativeInfinity;
        foreach (float h in node.Headings)
        {
            double rad = h * Math.PI / 180;
            float dirX = (float)-Math.Sin(rad), dirY = (float)Math.Cos(rad);
            float dot = dirY * (doorX - node.X) - dirX * (doorY - node.Y);
            if (dot > bestDot) { bestDot = dot; best = h; }
        }
        return new RoadSuggestion(node.X, node.Y, node.Z + 1, best);
    }

    public static RoadNodes Load(GameFileCache cache)
    {
        var rpfman = cache?.RpfMan;
        if (rpfman == null) return Empty;
        // Later archives win: base game, then the update, then the active DLCs (x64 ones are in the base list).
        var entries = new Dictionary<uint, RpfFileEntry>();
        void AddRpf(RpfFile f)
        {
            if (f?.AllEntries == null) return;
            foreach (var e in f.AllEntries)
                if (e is RpfFileEntry fe && e.NameLower.EndsWith(".ynd")) entries[e.NameHash] = fe;
        }
        foreach (var r in cache.BaseRpfs ?? new List<RpfFile>()) AddRpf(r);
        var upd = rpfman.FindRpfFile(@"update\update.rpf");
        if (upd?.Children != null) foreach (var c in upd.Children) AddRpf(c);
        foreach (var d in cache.DlcActiveRpfs ?? new List<RpfFile>())
        {
            if (d.Path.StartsWith("x64") || d.Children == null) continue;
            foreach (var c in d.Children) AddRpf(c);
        }
        var ynds = new Dictionary<int, YndFile>();
        foreach (var fe in entries.Values)
        {
            var y = rpfman.GetFile<YndFile>(fe);
            if (y?.Nodes == null) continue;
            ynds[y.AreaID] = y;
        }
        YndNode Get(int area, int id) =>
            ynds.TryGetValue(area, out var y) && y.Nodes != null && id >= 0 && id < y.Nodes.Length ? y.Nodes[id] : null;

        var list = new List<RoadNode>();
        int links = 0;
        foreach (var y in ynds.Values)
        {
            var raw = y.NodeDictionary?.Links;
            foreach (var n in y.Nodes)
            {
                if (n.IsPedNode) continue;
                var headings = new List<float>();
                int first = n._RawData.LinkID;
                for (int i = 0; raw != null && i < n.LinkCount && first + i < raw.Length; i++)
                {
                    var t = Get(raw[first + i].AreaID, raw[first + i].NodeID);
                    if (t == null) continue;
                    var dir = t.Position - n.Position;
                    headings.Add((float)((Math.Atan2(-dir.X, dir.Y) * 180 / Math.PI + 360) % 360));
                }
                links += headings.Count;
                list.Add(new RoadNode(n.Position.X, n.Position.Y, n.Position.Z, headings.ToArray()));
            }
        }
        return new RoadNodes(list) { Links = links };
    }
}
