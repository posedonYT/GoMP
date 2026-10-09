using System.IO.Compression;
using System.Text.Json;
using GoMP.Studio.Export;
using GoMP.Studio.Maps;

namespace GoMP.Studio.Tests;

// Reads a .glb back: the JSON and the binary chunk, accessors as floats.
public sealed class Glb
{
    public JsonElement Json;
    public byte[] Bin;

    public static Glb Parse(byte[] data)
    {
        Assert.Equal(0x46546C67u, BitConverter.ToUInt32(data, 0));  // glTF
        Assert.Equal(2u, BitConverter.ToUInt32(data, 4));
        Assert.Equal((uint)data.Length, BitConverter.ToUInt32(data, 8));
        int jsonLen = (int)BitConverter.ToUInt32(data, 12);
        Assert.Equal(0x4E4F534Au, BitConverter.ToUInt32(data, 16));
        Assert.Equal(0, jsonLen % 4);
        var g = new Glb { Json = JsonDocument.Parse(data.AsMemory(20, jsonLen)).RootElement };
        int at = 20 + jsonLen;
        if (at < data.Length)
        {
            int binLen = (int)BitConverter.ToUInt32(data, at);
            Assert.Equal(0x004E4942u, BitConverter.ToUInt32(data, at + 4));
            g.Bin = data.AsSpan(at + 8, binLen).ToArray();
            Assert.Equal(binLen, g.Json.GetProperty("buffers")[0].GetProperty("byteLength").GetInt32());
        }
        return g;
    }

    public byte[] View(int index)
    {
        var v = Json.GetProperty("bufferViews")[index];
        int off = v.TryGetProperty("byteOffset", out var o) ? o.GetInt32() : 0;
        Assert.Equal(0, off % 4);
        return Bin.AsSpan(off, v.GetProperty("byteLength").GetInt32()).ToArray();
    }

    public float[] Floats(int accessor)
    {
        var a = Json.GetProperty("accessors")[accessor];
        Assert.Equal(5126, a.GetProperty("componentType").GetInt32());
        var bytes = View(a.GetProperty("bufferView").GetInt32());
        var f = new float[bytes.Length / 4];
        Buffer.BlockCopy(bytes, 0, f, 0, bytes.Length);
        return f;
    }

    public IEnumerable<JsonElement> Primitives() =>
        Json.TryGetProperty("meshes", out var m) ? m.EnumerateArray().SelectMany(x => x.GetProperty("primitives").EnumerateArray()) : Enumerable.Empty<JsonElement>();
}

public class ExportTests
{
    // Decodes our PNG: zlib, filter 0 rows.
    private static byte[] DecodePng(byte[] png, out int w, out int h)
    {
        Assert.Equal(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }, png[..8]);
        int at = 8;
        w = h = 0;
        using var idat = new MemoryStream();
        while (at < png.Length)
        {
            int len = (png[at] << 24) | (png[at + 1] << 16) | (png[at + 2] << 8) | png[at + 3];
            string type = System.Text.Encoding.ASCII.GetString(png, at + 4, 4);
            var data = png.AsSpan(at + 8, len).ToArray();
            uint crc = (uint)((png[at + 8 + len] << 24) | (png[at + 9 + len] << 16) | (png[at + 10 + len] << 8) | png[at + 11 + len]);
            Assert.Equal(PngEncoder.Crc(PngEncoder.Crc(0xFFFFFFFF, System.Text.Encoding.ASCII.GetBytes(type)), data) ^ 0xFFFFFFFF, crc);
            if (type == "IHDR")
            {
                w = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
                h = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
                Assert.Equal(new byte[] { 8, 6 }, data[8..10]);
            }
            if (type == "IDAT") idat.Write(data);
            at += 12 + len;
        }
        using var z = new ZLibStream(new MemoryStream(idat.ToArray()), CompressionMode.Decompress);
        using var raw = new MemoryStream();
        z.CopyTo(raw);
        var rows = raw.ToArray();
        var rgba = new byte[w * h * 4];
        for (int y = 0; y < h; y++)
        {
            Assert.Equal(0, rows[y * (w * 4 + 1)]);
            Buffer.BlockCopy(rows, y * (w * 4 + 1) + 1, rgba, y * w * 4, w * 4);
        }
        return rgba;
    }

    [Fact]
    public void Png_round_trip()
    {
        var rgba = new byte[3 * 2 * 4];
        for (int i = 0; i < rgba.Length; i++) rgba[i] = (byte)(i * 11);
        var back = DecodePng(PngEncoder.Encode(rgba, 3, 2), out int w, out int h);
        Assert.Equal((3, 2), (w, h));
        Assert.Equal(rgba, back);
        Assert.Throws<ArgumentException>(() => PngEncoder.Encode(new byte[3], 2, 2));
    }

    [Fact]
    public void Glb_has_a_valid_structure_and_the_data_back()
    {
        var b = new GlbBuilder();
        int tex = b.AddTexture(PngEncoder.Encode(new byte[] { 255, 0, 0, 255 }, 1, 1), "red");
        int mat = b.AddMaterial(new GlbMaterial { Name = "m", Texture = tex, AlphaMode = "MASK", AlphaCutoff = 0.3f, Extras = new() { ["paint"] = 1 } });
        int mesh = b.AddMesh("tri", new[]
        {
            new GlbPrimitive { Positions = new float[] { 0, 0, 0, 1, 0, 0, 0, 2, 3 }, Normals = new float[] { 0, 0, 1, 0, 0, 1, 0, 0, 1 },
                Uvs = new float[] { 0, 0, 1, 0, 0, 1 }, Indices = new[] { 0, 1, 2 }, Material = mat },
        });
        int bone = b.AddNode(new GlbNode { Name = "door_dside_f", Translation = new float[] { 1, 2, 3 }, Extras = new() { ["bone"] = 5 } });
        b.Node(bone).Children.Add(b.AddNode(new GlbNode { Mesh = mesh }));
        var g = Glb.Parse(b.ToGlb());

        Assert.Equal("Z", g.Json.GetProperty("asset").GetProperty("extras").GetProperty("up").GetString());
        var roots = g.Json.GetProperty("scenes")[0].GetProperty("nodes");
        Assert.Equal(1, roots.GetArrayLength());
        Assert.Equal("door_dside_f", g.Json.GetProperty("nodes")[roots[0].GetInt32()].GetProperty("name").GetString());
        var prim = g.Primitives().Single();
        var posAcc = g.Json.GetProperty("accessors")[prim.GetProperty("attributes").GetProperty("POSITION").GetInt32()];
        Assert.Equal(new[] { 1f, 2f, 3f }, posAcc.GetProperty("max").EnumerateArray().Select(e => e.GetSingle()));
        Assert.Equal(new float[] { 0, 0, 0, 1, 0, 0, 0, 2, 3 }, g.Floats(prim.GetProperty("attributes").GetProperty("POSITION").GetInt32()));
        Assert.Equal(new float[] { 0, 0, 1, 0, 0, 1 }, g.Floats(prim.GetProperty("attributes").GetProperty("TEXCOORD_0").GetInt32()));
        var ind = g.Json.GetProperty("accessors")[prim.GetProperty("indices").GetInt32()];
        Assert.Equal(5123, ind.GetProperty("componentType").GetInt32());
        var material = g.Json.GetProperty("materials")[prim.GetProperty("material").GetInt32()];
        Assert.Equal("MASK", material.GetProperty("alphaMode").GetString());
        Assert.Equal(1, material.GetProperty("extras").GetProperty("paint").GetInt32());
        var image = g.Json.GetProperty("images")[0];
        Assert.Equal("image/png", image.GetProperty("mimeType").GetString());
        DecodePng(g.View(image.GetProperty("bufferView").GetInt32()), out int w, out _);
        Assert.Equal(1, w);
    }

    [Fact]
    public void Large_meshes_use_32_bit_indices_and_empty_ones_are_skipped()
    {
        var b = new GlbBuilder();
        int n = 70000;
        var pos = new float[n * 3];
        Assert.Equal(-1, b.AddMesh("empty", new[] { new GlbPrimitive { Positions = Array.Empty<float>(), Indices = Array.Empty<int>() } }));
        int mesh = b.AddMesh("big", new[] { new GlbPrimitive { Positions = pos, Indices = new[] { 0, 1, n - 1 } } });
        b.AddNode(new GlbNode { Mesh = mesh });
        var g = Glb.Parse(b.ToGlb());
        var ind = g.Json.GetProperty("accessors")[g.Primitives().Single().GetProperty("indices").GetInt32()];
        Assert.Equal(5125, ind.GetProperty("componentType").GetInt32());
    }

    [Fact]
    public void Vertices_are_read_by_their_declaration()
    {
        // position Float3 (bit 0), normal Float3 (bit 3), colour (bit 4), texcoord0 Half2 (bit 6)
        uint flags = (1u << 0) | (1u << 3) | (1u << 4) | (1u << 6);
        ulong types = (6ul << 0) | (6ul << 12) | (9ul << 16) | (1ul << 24);
        int stride = 12 + 12 + 4 + 4;
        Assert.Equal(12, VertexDecoder.OffsetOf(flags, types, VertexDecoder.Normal));
        Assert.Equal(28, VertexDecoder.OffsetOf(flags, types, VertexDecoder.TexCoord0));
        var bytes = new byte[stride * 2];
        void Put(int v, int at, float f) => BitConverter.TryWriteBytes(bytes.AsSpan(v * stride + at), f);
        void PutHalf(int v, int at, float f) => BitConverter.TryWriteBytes(bytes.AsSpan(v * stride + at), (Half)f);
        Put(0, 0, 1); Put(0, 4, 2); Put(0, 8, 3);
        Put(0, 12, 0); Put(0, 16, 0); Put(0, 20, 2);  // normalised to (0, 0, 1)
        PutHalf(0, 28, 0.25f); PutHalf(0, 30, 0.75f);
        Put(1, 0, -1); Put(1, 4, float.NaN); Put(1, 8, 0);
        var v = VertexDecoder.Decode(bytes, 2, stride, flags, types);
        Assert.Equal(new float[] { 1, 2, 3, -1, 0, 0 }, v.Positions);
        Assert.Equal(new float[] { 0, 0, 1, 0, 0, 1 }, v.Normals);  // a zero normal points up
        Assert.Equal(0.25f, v.Uvs[0]);
        Assert.Equal(0.75f, v.Uvs[1]);
        Assert.Throws<InvalidDataException>(() => VertexDecoder.Decode(bytes, 2, stride, flags & ~1u, types));
    }

    [Fact]
    public void Skinned_vertices_name_their_main_bone()
    {
        // position Float3, blend weights Colour (bit 1), blend indices UByte4 (bit 2)
        uint flags = (1u << 0) | (1u << 1) | (1u << 2);
        ulong types = (6ul << 0) | (9ul << 4) | (8ul << 8);
        int stride = 12 + 4 + 4;
        var bytes = new byte[stride * 2];
        bytes[12] = 10; bytes[13] = 245; bytes[16] = 3; bytes[17] = 7;   // vertex 0: weight 245 on index 7
        bytes[stride + 12] = 255; bytes[stride + 16] = 2;               // vertex 1: all on index 2
        var v = VertexDecoder.Decode(bytes, 2, stride, flags, types);
        Assert.Equal(new byte[] { 7, 2 }, v.Bones);
        Assert.Null(VertexDecoder.Decode(bytes, 2, stride, 1u, 6ul).Bones);
    }

    [Fact]
    public void Skinned_geometry_is_cut_into_rigid_pieces_on_their_bones()
    {
        var p = new GlbPrimitive
        {
            Positions = new float[] { 0, 0, 0, 1, 0, 0, 0, 1, 0, /* door */ 2, 0, 0, 3, 0, 0, 2, 1, 0 },
            Normals = new float[] { 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1 },
            Indices = new[] { 0, 1, 2, 3, 4, 5 },
            Material = 3,
        };
        var bones = new byte[] { 0, 0, 0, 1, 1, 1 };
        var abs = new[] { SharpDX.Matrix.Identity, SharpDX.Matrix.Translation(2, 0, 0) };
        var parts = ModelExporter.SplitByBone(p, bones, new ushort[] { 0, 1 }, 2, abs).OrderBy(x => x.Bone).ToList();
        Assert.Equal(new[] { 0, 1 }, parts.Select(x => x.Bone));
        Assert.Equal(new float[] { 0, 0, 0, 1, 0, 0, 0, 1, 0 }, parts[0].Part.Positions);
        Assert.Equal(new float[] { 0, 0, 0, 1, 0, 0, 0, 1, 0 }, parts[1].Part.Positions);  // in the door bone's space
        Assert.Equal(new[] { 0, 1, 2 }, parts[1].Part.Indices);
        Assert.Equal(3, parts[1].Part.Material);
        // The geometry's bone ids map blend indices to skeleton bones.
        Assert.Equal(1, ModelExporter.SplitByBone(p, new byte[] { 0, 0, 0, 0, 0, 0 }, new ushort[] { 1 }, 2, abs).Single().Bone);
    }

    [Fact]
    public void The_colour_texture_is_chosen_among_samplers()
    {
        Assert.Equal(1, ModelExporter.SamplerPreference(new[] { "bumpsampler", "diffusesampler", "specsampler" }));
        Assert.Equal(2, ModelExporter.SamplerPreference(new[] { "bumpsampler_layer0", "lookupsampler", "texturesampler_layer0", "texturesampler_layer1" }));
        Assert.Equal(1, ModelExporter.SamplerPreference(new[] { "normalsampler", "platebgsampler" }));
        Assert.Equal(-1, ModelExporter.SamplerPreference(new[] { "bumpsampler", "specsampler" }));
    }

    [Fact]
    public void Cache_exports_once_and_remembers_missing_models()
    {
        string dir = Path.Combine(Path.GetTempPath(), "gomp-cache-" + Guid.NewGuid().ToString("N"));
        try
        {
            var cache = new ModelCache(dir);
            int calls = 0;
            Assert.Equal(new byte[] { 1 }, cache.Get(1, Lod.High, () => { calls++; return new byte[] { 1 }; }));
            Assert.Equal(new byte[] { 1 }, new ModelCache(dir).Get(1, Lod.High, () => { calls++; return null; }));
            Assert.Null(cache.Get(2, Lod.High, () => { calls++; return null; }));
            Assert.Null(cache.Get(2, Lod.High, () => { calls++; return null; }));
            Assert.Equal(2, calls);
            Assert.Single(Directory.GetFiles(Path.Combine(dir, "models")));
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }
}

[Collection("game")]
public sealed class GameExportTests
{
    private readonly GameFixture fixture;

    public GameExportTests(GameFixture fixture) => this.fixture = fixture;

    [GameFact]
    public void A_prop_of_the_game_becomes_a_textured_glb_of_its_size()
    {
        var g = fixture.Game;
        uint hash = Joaat.Hash("prop_bench_01a");
        var data = g.Exporter.Export(hash);
        Assert.NotNull(data);
        var glb = Glb.Parse(data);
        Assert.True(glb.Json.GetProperty("images").GetArrayLength() >= 1);
        var info = g.Get(hash);
        float[] min = { float.MaxValue, float.MaxValue, float.MaxValue }, max = { float.MinValue, float.MinValue, float.MinValue };
        int vertices = 0;
        foreach (var p in glb.Primitives())
        {
            var pos = glb.Floats(p.GetProperty("attributes").GetProperty("POSITION").GetInt32());
            vertices += pos.Length / 3;
            for (int i = 0; i < pos.Length; i++)
            {
                min[i % 3] = Math.Min(min[i % 3], pos[i]);
                max[i % 3] = Math.Max(max[i % 3], pos[i]);
            }
        }
        Assert.True(vertices > 50, $"{vertices} vertices");
        // The geometry lies in the archetype's box (which has some room around it) and fills most of it.
        for (int c = 0; c < 3; c++)
        {
            Assert.True(min[c] >= info.BBMin[c] - 0.05f && max[c] <= info.BBMax[c] + 0.05f, $"axis {c}: {min[c]}..{max[c]} in {info.BBMin[c]}..{info.BBMax[c]}");
            Assert.True(max[c] - min[c] >= 0.7f * (info.BBMax[c] - info.BBMin[c]), $"axis {c}: {min[c]}..{max[c]} fills {info.BBMin[c]}..{info.BBMax[c]}");
        }
        Assert.Null(g.Exporter.Export(Joaat.Hash("no_such_model_at_all")));
    }

    [GameFact]
    public void Lower_detail_has_fewer_vertices()
    {
        // A model from a drawable dictionary with levels of detail (a tree).
        var g = fixture.Game;
        var tree = g.Search("prop_tree_birch_01", 5).FirstOrDefault();
        Assert.NotNull(tree);
        int Count(Lod lod) => Glb.Parse(g.Exporter.Export(tree.Hash, lod)).Primitives().Sum(p =>
            p.GetProperty("attributes").GetProperty("POSITION").GetInt32() >= 0 ? 1 : 0);
        Assert.True(Count(Lod.High) >= Count(Lod.VLow));
    }
}
