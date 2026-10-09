// Builds a binary glTF 2.0 file (.glb): one buffer, meshes of triangles with
// positions, normals and texture coordinates, materials with a base colour
// texture (PNG), and a node tree. The Studio keeps GTA V's axes (Z up) in its
// files and scene; asset.extras.up says so.
using System.Text.Json.Nodes;

namespace GoMP.Studio.Export;

public sealed class GlbPrimitive
{
    public float[] Positions;  // x, y, z per vertex
    public float[] Normals;    // optional
    public float[] Uvs;        // optional, u, v per vertex
    public int[] Indices;      // triangles
    public int Material = -1;
}

public sealed class GlbMaterial
{
    public string Name;
    public int Texture = -1;   // index from AddTexture
    public float[] Color = { 1, 1, 1, 1 };
    public string AlphaMode = "OPAQUE";  // OPAQUE, MASK, BLEND
    public float AlphaCutoff = 0.5f;
    public bool DoubleSided;
    public JsonObject Extras;
}

public sealed class GlbNode
{
    public string Name;
    public float[] Translation;  // x, y, z
    public float[] Rotation;     // quaternion x, y, z, w
    public float[] Scale;
    public int Mesh = -1;
    public List<int> Children = new();
    public JsonObject Extras;
}

public sealed class GlbBuilder
{
    private const int ArrayBuffer = 34962, ElementArrayBuffer = 34963;
    private const int Float = 5126, UInt16 = 5123, UInt32 = 5125;

    private readonly MemoryStream bin = new();
    private readonly JsonArray bufferViews = new(), accessors = new(), meshes = new(), materials = new(),
        images = new(), textures = new(), nodes = new();
    private readonly List<GlbNode> nodeList = new();
    public JsonObject AssetExtras { get; } = new() { ["up"] = "Z" };

    public int MeshCount => meshes.Count;
    public int ImageCount => images.Count;

    private int View(byte[] data, int? target)
    {
        while (bin.Length % 4 != 0) bin.WriteByte(0);
        var view = new JsonObject { ["buffer"] = 0, ["byteOffset"] = bin.Length, ["byteLength"] = data.Length };
        if (target != null) view["target"] = target.Value;
        bin.Write(data);
        bufferViews.Add(view);
        return bufferViews.Count - 1;
    }

    private int Accessor(int view, int componentType, int count, string type, float[] min = null, float[] max = null)
    {
        var a = new JsonObject { ["bufferView"] = view, ["componentType"] = componentType, ["count"] = count, ["type"] = type };
        if (min != null) a["min"] = new JsonArray(min.Select(v => (JsonNode)v).ToArray());
        if (max != null) a["max"] = new JsonArray(max.Select(v => (JsonNode)v).ToArray());
        accessors.Add(a);
        return accessors.Count - 1;
    }

    private static byte[] Bytes(float[] v)
    {
        var b = new byte[v.Length * 4];
        Buffer.BlockCopy(v, 0, b, 0, b.Length);
        return b;
    }

    public int AddTexture(byte[] png, string name = null)
    {
        images.Add(new JsonObject { ["bufferView"] = View(png, null), ["mimeType"] = "image/png", ["name"] = name });
        textures.Add(new JsonObject { ["source"] = images.Count - 1, ["sampler"] = 0 });
        return textures.Count - 1;
    }

    public int AddMaterial(GlbMaterial m)
    {
        var pbr = new JsonObject
        {
            ["baseColorFactor"] = new JsonArray(m.Color.Select(v => (JsonNode)v).ToArray()),
            ["metallicFactor"] = 0f,
            ["roughnessFactor"] = 0.9f,
        };
        if (m.Texture >= 0) pbr["baseColorTexture"] = new JsonObject { ["index"] = m.Texture };
        var mat = new JsonObject { ["name"] = m.Name, ["pbrMetallicRoughness"] = pbr, ["alphaMode"] = m.AlphaMode, ["doubleSided"] = m.DoubleSided };
        if (m.AlphaMode == "MASK") mat["alphaCutoff"] = m.AlphaCutoff;
        if (m.Extras != null) mat["extras"] = m.Extras;
        materials.Add(mat);
        return materials.Count - 1;
    }

    public int AddMesh(string name, IEnumerable<GlbPrimitive> primitives)
    {
        var prims = new JsonArray();
        foreach (var p in primitives)
        {
            int n = p.Positions.Length / 3;
            if (n == 0 || p.Indices.Length < 3) continue;
            var min = new[] { float.MaxValue, float.MaxValue, float.MaxValue };
            var max = new[] { float.MinValue, float.MinValue, float.MinValue };
            for (int i = 0; i < n; i++)
                for (int c = 0; c < 3; c++)
                {
                    min[c] = Math.Min(min[c], p.Positions[i * 3 + c]);
                    max[c] = Math.Max(max[c], p.Positions[i * 3 + c]);
                }
            var attrs = new JsonObject { ["POSITION"] = Accessor(View(Bytes(p.Positions), ArrayBuffer), Float, n, "VEC3", min, max) };
            if (p.Normals != null && p.Normals.Length == n * 3) attrs["NORMAL"] = Accessor(View(Bytes(p.Normals), ArrayBuffer), Float, n, "VEC3");
            if (p.Uvs != null && p.Uvs.Length == n * 2) attrs["TEXCOORD_0"] = Accessor(View(Bytes(p.Uvs), ArrayBuffer), Float, n, "VEC2");
            int indices;
            if (n <= ushort.MaxValue)
            {
                var b = new byte[p.Indices.Length * 2];
                for (int i = 0; i < p.Indices.Length; i++) BitConverter.TryWriteBytes(b.AsSpan(i * 2), (ushort)p.Indices[i]);
                indices = Accessor(View(b, ElementArrayBuffer), UInt16, p.Indices.Length, "SCALAR");
            }
            else
            {
                var b = new byte[p.Indices.Length * 4];
                Buffer.BlockCopy(p.Indices, 0, b, 0, b.Length);
                indices = Accessor(View(b, ElementArrayBuffer), UInt32, p.Indices.Length, "SCALAR");
            }
            var prim = new JsonObject { ["attributes"] = attrs, ["indices"] = indices, ["mode"] = 4 };
            if (p.Material >= 0) prim["material"] = p.Material;
            prims.Add(prim);
        }
        if (prims.Count == 0) return -1;
        meshes.Add(new JsonObject { ["name"] = name, ["primitives"] = prims });
        return meshes.Count - 1;
    }

    public int AddNode(GlbNode n)
    {
        nodeList.Add(n);
        return nodeList.Count - 1;
    }

    public GlbNode Node(int i) => nodeList[i];

    // The scene: nodes that are no one's child are its roots.
    public byte[] ToGlb()
    {
        var children = new HashSet<int>(nodeList.SelectMany(n => n.Children));
        foreach (var n in nodeList)
        {
            var o = new JsonObject();
            if (n.Name != null) o["name"] = n.Name;
            if (n.Translation != null) o["translation"] = new JsonArray(n.Translation.Select(v => (JsonNode)v).ToArray());
            if (n.Rotation != null) o["rotation"] = new JsonArray(n.Rotation.Select(v => (JsonNode)v).ToArray());
            if (n.Scale != null) o["scale"] = new JsonArray(n.Scale.Select(v => (JsonNode)v).ToArray());
            if (n.Mesh >= 0) o["mesh"] = n.Mesh;
            if (n.Children.Count > 0) o["children"] = new JsonArray(n.Children.Select(c => (JsonNode)c).ToArray());
            if (n.Extras != null) o["extras"] = n.Extras;
            nodes.Add(o);
        }
        var roots = Enumerable.Range(0, nodeList.Count).Where(i => !children.Contains(i)).Select(i => (JsonNode)i).ToArray();
        while (bin.Length % 4 != 0) bin.WriteByte(0);
        var json = new JsonObject
        {
            ["asset"] = new JsonObject { ["version"] = "2.0", ["generator"] = "GoMP Studio", ["extras"] = AssetExtras },
            ["scene"] = 0,
            ["scenes"] = new JsonArray(new JsonObject { ["nodes"] = new JsonArray(roots) }),
            ["nodes"] = nodes,
            ["buffers"] = new JsonArray(new JsonObject { ["byteLength"] = bin.Length }),
            ["bufferViews"] = bufferViews,
            ["accessors"] = accessors,
        };
        if (meshes.Count > 0) json["meshes"] = meshes;
        if (materials.Count > 0) json["materials"] = materials;
        if (images.Count > 0)
        {
            json["images"] = images;
            json["textures"] = textures;
            json["samplers"] = new JsonArray(new JsonObject { ["magFilter"] = 9729, ["minFilter"] = 9987, ["wrapS"] = 10497, ["wrapT"] = 10497 });
        }
        byte[] jsonBytes = System.Text.Encoding.UTF8.GetBytes(json.ToJsonString());
        int jsonPad = (4 - jsonBytes.Length % 4) % 4;
        byte[] binBytes = bin.ToArray();
        int total = 12 + 8 + jsonBytes.Length + jsonPad + (binBytes.Length > 0 ? 8 + binBytes.Length : 0);
        using var ms = new MemoryStream(total);
        using var w = new BinaryWriter(ms);
        w.Write(0x46546C67u);  // "glTF"
        w.Write(2u);
        w.Write((uint)total);
        w.Write((uint)(jsonBytes.Length + jsonPad));
        w.Write(0x4E4F534Au);  // "JSON"
        w.Write(jsonBytes);
        for (int i = 0; i < jsonPad; i++) w.Write((byte)' ');
        if (binBytes.Length > 0)
        {
            w.Write((uint)binBytes.Length);
            w.Write(0x004E4942u);  // "BIN\0"
            w.Write(binBytes);
        }
        return ms.ToArray();
    }
}
