// A model of the game as a .glb for the browser: the drawable of an archetype
// (from a ydd, ydr or yft, like CodeWalker's GameFileCache.TryGetDrawable),
// its skeleton as a node tree (doors, wheels and other parts hang on their
// bones), its geometry and diffuse textures (embedded, the archetype's texture
// dictionary and its parents). Files are loaded synchronously; a few exports
// run at once (the world view asks for many models); the results are cached on
// disk (ModelCache).
using System.Collections.Concurrent;
using CodeWalker.GameFiles;
using CodeWalker.Utils;

namespace GoMP.Studio.Export;

public enum Lod { High, Med, Low, VLow }

public sealed class ModelExporter
{
    public const int Version = 4;            // bump when the output changes: old cache files are not used
    public const int MaxTextureSize = 512;   // map objects; the world around asks for smaller ones

    private static readonly uint DiffuseSampler = GoMP.Studio.Maps.Joaat.Hash("diffusesampler");
    private readonly GameFileCache cache;
    private readonly SemaphoreSlim slots = new(Math.Max(2, Environment.ProcessorCount / 2));
    private readonly ConcurrentDictionary<uint, Lazy<YtdFile>> ytds = new();

    public ModelExporter(GameFileCache cache) => this.cache = cache;

    // The .glb of a model, or null when the game has no drawable for it.
    // extraTxds: more texture dictionaries to look in (vehicles: vehshare...).
    public byte[] Export(uint hash, Lod lod = Lod.High, int maxTexture = MaxTextureSize, IEnumerable<uint> extraTxds = null)
    {
        slots.Wait();
        try
        {
            var arch = cache.GetArchetype(hash);
            var drawable = LoadDrawable(hash, arch, out var frag);
            if (drawable == null) return null;
            var txds = new List<uint>();
            if (arch != null && arch.TextureDict.Hash != 0) txds.Add(arch.TextureDict.Hash);
            txds.Add(hash);  // vehicles and many props: a dictionary named like the model
            if (extraTxds != null) txds.AddRange(extraTxds);
            return Build(drawable, lod, tex => FindTexture(drawable, tex, txds), maxTexture, frag);
        }
        finally
        {
            slots.Release();
        }
    }

    private DrawableBase LoadDrawable(uint hash, Archetype arch, out FragType frag)
    {
        frag = null;
        if (arch != null && arch.DrawableDict.Hash != 0)
        {
            var e = cache.GetYddEntry(arch.DrawableDict.Hash);
            var ydd = e != null ? cache.RpfMan.GetFile<YddFile>(e) : null;
            if (ydd?.Dict != null && ydd.Dict.TryGetValue(hash, out var d)) return d;
        }
        var ydrEntry = cache.GetYdrEntry(hash);
        if (ydrEntry != null) return cache.RpfMan.GetFile<YdrFile>(ydrEntry)?.Drawable;
        var yftEntry = cache.GetYftEntry(hash);
        if (yftEntry != null)
        {
            frag = cache.RpfMan.GetFile<YftFile>(yftEntry)?.Fragment;
            return frag?.Drawable;
        }
        return null;
    }

    // A vehicle of an add-on pack: its model (the detailed _hi one when there is one)
    // with the pack's textures, the parents named in its vehicles.meta, the game's
    // texture dictionaries (when the game is loaded) and the shared vehshare.
    public byte[] ExportVehicle(Vehicles.AddonPack pack, string model, int maxTexture = MaxTextureSize, string textureOf = null) =>
        ExportVehicle(pack, model, cache, ytds, maxTexture, textureOf);

    // textureOf: a mod part (spoiler, bumper) uses the textures of its vehicle.
    public static byte[] ExportVehicle(Vehicles.AddonPack pack, string model, GameFileCache cache, ConcurrentDictionary<uint, Lazy<YtdFile>> gameYtds, int maxTexture, string textureOf = null)
    {
        var rpf = pack.Open();
        var files = GoMP.Gta.Archives.Files(rpf).ToList();
        string lower = model.ToLowerInvariant();
        var yftEntry = files.FirstOrDefault(e => e.NameLower == lower + "_hi.yft") ?? files.FirstOrDefault(e => e.NameLower == lower + ".yft");
        if (yftEntry == null) return null;
        var yft = new YftFile();
        yft.Load(yftEntry.File.ExtractFile(yftEntry), yftEntry);
        var drawable = yft.Fragment?.Drawable;
        if (drawable == null) return null;

        var packYtds = files.Where(e => e.NameLower.EndsWith(".ytd"))
            .GroupBy(e => JenkHash.GenHash(e.NameLower[..^4]))
            .ToDictionary(g => g.Key, g => g.First());
        var loaded = new Dictionary<uint, YtdFile>();
        YtdFile Ytd(uint h)
        {
            if (loaded.TryGetValue(h, out var y)) return y;
            if (packYtds.TryGetValue(h, out var e))
            {
                y = new YtdFile();
                y.Load(e.File.ExtractFile(e), e);
            }
            else if (cache != null && cache.GetYtdEntry(h) is { } ge)
            {
                y = gameYtds != null ? gameYtds.GetOrAdd(h, _ => new Lazy<YtdFile>(() => cache.RpfMan.GetFile<YtdFile>(ge))).Value : cache.RpfMan.GetFile<YtdFile>(ge);
            }
            return loaded[h] = y;
        }

        // child txd -> parent txd from the pack's vehicles.meta files.
        var parents = new Dictionary<uint, uint>();
        foreach (var e in files.Where(e => e.NameLower == "vehicles.meta"))
        {
            var doc = System.Xml.Linq.XDocument.Parse(System.Text.Encoding.UTF8.GetString(e.File.ExtractFile(e)).TrimStart('\uFEFF'));
            foreach (var r in System.Xml.Linq.Extensions.Elements(doc.Descendants("txdRelationships"), "Item"))
            {
                string p = r.Element("parent")?.Value.Trim(), c = r.Element("child")?.Value.Trim();
                if (!string.IsNullOrEmpty(p) && !string.IsNullOrEmpty(c)) parents[JenkHash.GenHash(c.ToLowerInvariant())] = JenkHash.GenHash(p.ToLowerInvariant());
            }
        }
        var starts = new List<uint> { JenkHash.GenHash(lower), JenkHash.GenHash(lower + "+hi"), JenkHash.GenHash("vehshare") };
        if (!string.IsNullOrEmpty(textureOf)) starts.InsertRange(0, new[] { JenkHash.GenHash(textureOf.ToLowerInvariant()), JenkHash.GenHash(textureOf.ToLowerInvariant() + "+hi") });

        Texture Find(TextureBase t)
        {
            uint name = t.NameHash != 0 ? t.NameHash : JenkHash.GenHash((t.Name ?? "").ToLowerInvariant());
            Texture own = t is Texture o && o.Data != null ? o
                : drawable.ShaderGroup?.TextureDictionary?.Dict?.TryGetValue(name, out var embedded) == true ? embedded : null;
            // A mod part's own textures can be stubs (m5_hood: a quarter of the data its
            // format needs): the vehicle's dictionaries first, its own copy if not there.
            if (own != null && textureOf == null) return own;
            foreach (uint start in starts)
            {
                int depth = 0;
                for (uint h = start; h != 0 && depth < 8; depth++)
                {
                    if (Ytd(h)?.TextureDict?.Dict?.TryGetValue(name, out var tex) == true) return tex;
                    h = parents.TryGetValue(h, out uint p) ? p : cache?.TryGetParentYtdHash(h) ?? 0;
                }
            }
            return own;
        }
        return Build(drawable, Lod.High, Find, maxTexture, yft.Fragment);
    }

    private Texture FindTexture(DrawableBase drawable, TextureBase tex, List<uint> txds)
    {
        uint name = tex.NameHash != 0 ? tex.NameHash : JenkHash.GenHash((tex.Name ?? "").ToLowerInvariant());
        if (tex is Texture own && own.Data != null) return own;
        if (drawable.ShaderGroup?.TextureDictionary?.Dict?.TryGetValue(name, out var embedded) == true) return embedded;
        foreach (uint start in txds)
        {
            int depth = 0;
            for (uint h = start; h != 0 && depth < 8; h = cache.TryGetParentYtdHash(h), depth++)
            {
                var ytd = LoadYtd(h);
                if (ytd?.TextureDict?.Dict?.TryGetValue(name, out var t) == true) return t;
            }
        }
        return null;
    }

    // Texture dictionaries are big and shared by many models: a few are kept.
    private YtdFile LoadYtd(uint hash)
    {
        if (ytds.Count > 96) ytds.Clear();
        return ytds.GetOrAdd(hash, h => new Lazy<YtdFile>(() =>
        {
            var e = cache.GetYtdEntry(h);
            return e != null ? cache.RpfMan.GetFile<YtdFile>(e) : null;
        })).Value;
    }

    // ------------------------------------------------------------------ building

    public static byte[] Build(DrawableBase drawable, Lod lod, Func<TextureBase, Texture> findTexture, int maxTexture = MaxTextureSize, FragType frag = null)
    {
        var glb = new GlbBuilder();
        var bones = drawable.Skeleton?.Bones?.Items ?? Array.Empty<Bone>();

        // The skeleton as nodes (bone names: the vehicle preview finds doors, bonnet and boot).
        var boneNodes = new int[bones.Length];
        for (int i = 0; i < bones.Length; i++)
        {
            var b = bones[i];
            boneNodes[i] = glb.AddNode(new GlbNode
            {
                Name = b.Name ?? $"bone{i}",
                Translation = new[] { b.Translation.X, b.Translation.Y, b.Translation.Z },
                Rotation = new[] { b.Rotation.X, b.Rotation.Y, b.Rotation.Z, b.Rotation.W },
                Scale = b.Scale == default ? null : new[] { b.Scale.X, b.Scale.Y, b.Scale.Z },
                Extras = new() { ["bone"] = b.Tag },
            });
        }
        int root = bones.Length > 0 ? -1 : glb.AddNode(new GlbNode { Name = "model" });
        for (int i = 0; i < bones.Length; i++)
        {
            int parent = bones[i].ParentIndex;
            if (parent >= 0 && parent < bones.Length) glb.Node(boneNodes[parent]).Children.Add(boneNodes[i]);
        }

        var textures = new Dictionary<Texture, int>();
        var materials = new Dictionary<ShaderFX, int>();
        int m = 0;
        // Where each bone is in the model (for skinned geometry moved onto its bone).
        var boneAbs = new SharpDX.Matrix[bones.Length];
        for (int i = 0; i < bones.Length; i++)
        {
            var b = bones[i];
            var local = SharpDX.Matrix.Scaling(b.Scale == default ? SharpDX.Vector3.One : b.Scale) * SharpDX.Matrix.RotationQuaternion(b.Rotation) *
                        SharpDX.Matrix.Translation(b.Translation);
            boneAbs[i] = b.ParentIndex >= 0 && b.ParentIndex < i ? local * boneAbs[b.ParentIndex] : local;
        }

        // The models of a drawable as nodes under a parent node (or at their bones).
        void AddModels(DrawableBase d, int parent)
        {
            foreach (var model in Models(d.DrawableModels, lod))
            {
                // Bone -> primitives; skinned geometry is split by the bone each triangle hangs on.
                var byBone = new SortedDictionary<int, List<GlbPrimitive>>();
                int rigidBone = model.HasSkin == 0 ? model.BoneIndex : 0;
                foreach (var g in model.Geometries ?? Array.Empty<DrawableGeometry>())
                {
                    var p = Primitive(g, out byte[] vertexBones);
                    if (p == null) continue;
                    if (g.Shader != null)
                    {
                        if (!materials.TryGetValue(g.Shader, out int mat))
                            materials[g.Shader] = mat = glb.AddMaterial(Material(glb, g.Shader, findTexture, textures, maxTexture));
                        p.Material = mat;
                    }
                    if (model.HasSkin != 0 && vertexBones != null && bones.Length > 0 && parent < 0)
                    {
                        foreach (var (bone, part) in SplitByBone(p, vertexBones, g.BoneIds, bones.Length, boneAbs))
                        {
                            if (!byBone.TryGetValue(bone, out var l)) byBone[bone] = l = new List<GlbPrimitive>();
                            l.Add(part);
                        }
                    }
                    else
                    {
                        if (!byBone.TryGetValue(rigidBone, out var l)) byBone[rigidBone] = l = new List<GlbPrimitive>();
                        l.Add(p);
                    }
                }
                foreach (var (bone, prims) in byBone)
                {
                    int mesh = glb.AddMesh($"model{m}", prims);
                    if (mesh < 0) continue;
                    var node = glb.AddNode(new GlbNode { Name = $"model{m++}", Mesh = mesh });
                    int parentNode = parent >= 0 ? parent : bones.Length > 0 ? boneNodes[Math.Clamp(bone, 0, bones.Length - 1)] : root;
                    glb.Node(parentNode).Children.Add(node);
                }
            }
        }
        AddModels(drawable, -1);
        if (frag != null) AddFragmentChildren(glb, frag, drawable, AddModels);
        return glb.MeshCount == 0 ? null : glb.ToGlb();
    }

    private static readonly HashSet<ushort> FrontWheels = new() { 27922, 26418 };  // wheel_lf, wheel_rf
    private static readonly HashSet<ushort> RearWheels = new() { 29921, 29922, 29923, 27902, 5857, 5858, 5859, 26398 };
    private static readonly HashSet<ushort> RightWheels = new() { 26418, 5857, 5858, 5859, 26398 };

    // Parts of a fragment with their own drawables (vehicle wheels, breakable parts),
    // placed by the fragment's transforms; one wheel model serves all wheels of an
    // axle, mirrored on the right (as CodeWalker draws them).
    private static void AddFragmentChildren(GlbBuilder glb, FragType frag, DrawableBase main, Action<DrawableBase, int> addModels)
    {
        var lod1 = frag.PhysicsLODGroup?.PhysicsLOD1;
        var children = lod1?.Children?.data_items;
        var mats = lod1?.FragTransforms?.Matrices;
        if (children == null) return;
        DrawableBase front = null, rear = null;
        bool HasModels(DrawableBase d) => d?.DrawableModels?.High?.Length > 0;
        foreach (var c in children)
        {
            if (!HasModels(c.Drawable1)) continue;
            if (FrontWheels.Contains(c.BoneTag)) front ??= c.Drawable1;
            if (RearWheels.Contains(c.BoneTag)) rear ??= c.Drawable1;
        }
        var offset = lod1.PositionOffset;
        for (int i = 0; i < children.Length; i++)
        {
            var c = children[i];
            bool wheel = FrontWheels.Contains(c.BoneTag) || RearWheels.Contains(c.BoneTag);
            var d = HasModels(c.Drawable1) ? c.Drawable1 : wheel ? (FrontWheels.Contains(c.BoneTag) ? front ?? rear : rear ?? front) : null;
            if (d == null || mats == null || i >= mats.Length) continue;
            var mx = mats[i];
            var q = SharpDX.Quaternion.RotationMatrix(mx);
            if (RightWheels.Contains(c.BoneTag)) q = new SharpDX.Quaternion(0, 1, 0, 0);  // turned 180 degrees about Y
            string name = main.Skeleton?.BonesMap != null && main.Skeleton.BonesMap.TryGetValue(c.BoneTag, out var bone) ? bone.Name : $"part{i}";
            int node = glb.AddNode(new GlbNode
            {
                Name = name,
                Translation = new[] { mx.M41 + offset.X, mx.M42 + offset.Y, mx.M43 + offset.Z },
                Rotation = new[] { q.X, q.Y, q.Z, q.W },
                Extras = new() { ["bone"] = c.BoneTag, ["part"] = true },
            });
            addModels(d, node);
        }
    }

    // The models of a level of detail, or of the nearest more detailed one that exists.
    private static DrawableModel[] Models(DrawableModelsBlock block, Lod lod)
    {
        if (block == null) return Array.Empty<DrawableModel>();
        var levels = new[] { block.High, block.Med, block.Low, block.VLow };
        for (int i = (int)lod; i >= 0; i--)
            if (levels[i]?.Length > 0) return levels[i];
        return levels.FirstOrDefault(l => l?.Length > 0) ?? Array.Empty<DrawableModel>();
    }

    private static GlbPrimitive Primitive(DrawableGeometry g, out byte[] vertexBones)
    {
        vertexBones = null;
        var vd = g.VertexData;
        var indices = g.IndexBuffer?.Indices;
        if (vd?.VertexBytes == null || vd.Info == null || indices == null || indices.Length < 3) return null;
        var v = VertexDecoder.Decode(vd.VertexBytes, vd.VertexCount, vd.VertexStride, vd.Info.Flags, (ulong)vd.Info.Types);
        int n = v.Positions.Length / 3;
        var idx = new int[indices.Length - indices.Length % 3];
        for (int i = 0; i < idx.Length; i++) idx[i] = Math.Min(indices[i], n - 1);
        vertexBones = v.Bones;
        return new GlbPrimitive { Positions = v.Positions, Normals = v.Normals, Uvs = v.Uvs, Indices = idx };
    }

    // Skinned geometry as rigid pieces: each triangle goes to the bone of its first
    // vertex (blend index through the geometry's bone ids), moved into that bone's
    // space. The root's piece stays as it is.
    public static List<(int Bone, GlbPrimitive Part)> SplitByBone(GlbPrimitive p, byte[] vertexBones, ushort[] boneIds, int boneCount, SharpDX.Matrix[] boneAbs)
    {
        int BoneOf(int vertex)
        {
            int local = vertexBones[vertex];
            int b = boneIds != null && local < boneIds.Length ? boneIds[local] : local;
            return b >= 0 && b < boneCount ? b : 0;
        }
        var tris = new Dictionary<int, List<int>>();
        for (int t = 0; t < p.Indices.Length; t += 3)
        {
            int b = BoneOf(p.Indices[t]);
            if (!tris.TryGetValue(b, out var l)) tris[b] = l = new List<int>();
            l.Add(t);
        }
        var parts = new List<(int, GlbPrimitive)>();
        foreach (var (bone, list) in tris)
        {
            // The vertices this piece uses, renumbered.
            var map = new Dictionary<int, int>();
            var idx = new int[list.Count * 3];
            for (int i = 0; i < list.Count; i++)
                for (int k = 0; k < 3; k++)
                {
                    int old = p.Indices[list[i] + k];
                    if (!map.TryGetValue(old, out int nw)) map[old] = nw = map.Count;
                    idx[i * 3 + k] = nw;
                }
            var inv = bone > 0 ? SharpDX.Matrix.Invert(boneAbs[bone]) : SharpDX.Matrix.Identity;
            var pos = new float[map.Count * 3];
            var nrm = p.Normals != null ? new float[map.Count * 3] : null;
            var uv = p.Uvs != null ? new float[map.Count * 2] : null;
            foreach (var (old, nw) in map)
            {
                var v = new SharpDX.Vector3(p.Positions[old * 3], p.Positions[old * 3 + 1], p.Positions[old * 3 + 2]);
                if (bone > 0) v = SharpDX.Vector3.TransformCoordinate(v, inv);
                pos[nw * 3] = v.X;
                pos[nw * 3 + 1] = v.Y;
                pos[nw * 3 + 2] = v.Z;
                if (nrm != null)
                {
                    var n = new SharpDX.Vector3(p.Normals[old * 3], p.Normals[old * 3 + 1], p.Normals[old * 3 + 2]);
                    if (bone > 0) n = SharpDX.Vector3.Normalize(SharpDX.Vector3.TransformNormal(n, inv));
                    nrm[nw * 3] = n.X;
                    nrm[nw * 3 + 1] = n.Y;
                    nrm[nw * 3 + 2] = n.Z;
                }
                if (uv != null)
                {
                    uv[nw * 2] = p.Uvs[old * 2];
                    uv[nw * 2 + 1] = p.Uvs[old * 2 + 1];
                }
            }
            parts.Add((bone, new GlbPrimitive { Positions = pos, Normals = nrm, Uvs = uv, Indices = idx, Material = p.Material }));
        }
        return parts;
    }

    private static GlbMaterial Material(GlbBuilder glb, ShaderFX shader, Func<TextureBase, Texture> findTexture, Dictionary<Texture, int> textures, int maxTexture)
    {
        string name = shader.Name.ToString();
        // Without a texture: grey, not glaring white.
        var mat = new GlbMaterial { Name = name, Color = new[] { 0.62f, 0.63f, 0.64f, 1f } };
        var diffuse = DiffuseOf(shader);
        bool alpha = false;
        var tex = diffuse != null ? findTexture(diffuse) : null;
        if (tex != null)
        {
            if (!textures.TryGetValue(tex, out int ti))
            {
                var png = TexturePng(tex, out alpha, maxTexture);
                ti = png != null ? glb.AddTexture(png, tex.Name) : -1;
                textures[tex] = ti;
            }
            mat.Texture = ti;
            if (ti >= 0) mat.Color = new[] { 1f, 1f, 1f, 1f };
        }
        string lower = name.ToLowerInvariant();
        if (lower.Contains("glass"))
        {
            mat.AlphaMode = "BLEND";
            mat.Color = new[] { 0.75f, 0.85f, 0.9f, 0.35f };
        }
        else if (lower.Contains("decal"))
        {
            // Dirt, stains and markings: blended over the surface under them (the browser offsets their depth).
            mat.AlphaMode = "BLEND";
        }
        else if (alpha || lower.Contains("alpha") || lower.Contains("cutout") || lower.Contains("trees") || lower.Contains("grass"))
        {
            mat.AlphaMode = "MASK";
            mat.AlphaCutoff = 0.33f;
            mat.DoubleSided = true;
        }
        // Vehicle paint: the preview tints these with the chosen colours.
        if (lower.StartsWith("vehicle_paint")) mat.Extras = new() { ["paint"] = lower.Length > 13 && char.IsDigit(lower[13]) ? lower[13] - '0' : 1 };
        return mat;
    }

    // The colour texture of a shader: DiffuseSampler; terrain shaders have layers
    // instead (TextureSampler_layer0...); else any texture that is not a normal,
    // specular or detail map.
    public static TextureBase DiffuseOf(ShaderFX shader)
    {
        var block = shader.ParametersList;
        if (block?.Parameters == null || block.Hashes == null) return null;
        var textures = new List<(string Name, TextureBase Texture)>();
        for (int i = 0; i < block.Parameters.Length && i < block.Hashes.Length; i++)
            if (block.Parameters[i].Data is TextureBase tb)
                textures.Add(((uint)block.Hashes[i] == DiffuseSampler ? "diffusesampler" : block.Hashes[i].ToString().ToLowerInvariant(), tb));
        return SamplerPreference(textures.Select(t => t.Name)) is int best && best >= 0 ? textures[best].Texture : null;
    }

    // Index of the colour sampler among sampler names, or -1.
    public static int SamplerPreference(IEnumerable<string> names)
    {
        var list = names.ToList();
        static bool Colour(string n) => !(n.Contains("bump") || n.Contains("normal") || n.Contains("spec") || n.Contains("detail") ||
                                         n.Contains("noise") || n.Contains("lookup") || n.Contains("dirt"));
        int Find(Func<string, bool> f) => list.FindIndex(n => Colour(n) && f(n));
        int i = Find(n => n == "diffusesampler");
        if (i < 0) i = Find(n => n.Contains("layer0"));
        if (i < 0) i = Find(n => n.Contains("diffuse"));
        if (i < 0) i = Find(n => n.Contains("layer1"));
        if (i < 0) i = Find(_ => true);
        return i;
    }

    // RGBA PNG of a texture, at most maxSize wide and high; alpha: some pixels are see-through.
    public static byte[] TexturePng(Texture tex, out bool alpha, int maxSize = MaxTextureSize)
    {
        alpha = false;
        int mip = 0;
        while (mip + 1 < Math.Max(1, (int)tex.Levels) && Math.Max(tex.Width >> mip, tex.Height >> mip) > maxSize) mip++;
        byte[] px;
        try
        {
            px = DDSIO.GetPixels(tex, mip);
        }
        catch (Exception)
        {
            return null;
        }
        int w = Math.Max(1, tex.Width >> mip), h = Math.Max(1, tex.Height >> mip);
        if (px == null || px.Length < w * h * 4) return null;
        // DDSIO gives BGRA.
        var rgba = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++)
        {
            rgba[i * 4] = px[i * 4 + 2];
            rgba[i * 4 + 1] = px[i * 4 + 1];
            rgba[i * 4 + 2] = px[i * 4];
            rgba[i * 4 + 3] = px[i * 4 + 3];
            if (px[i * 4 + 3] < 200) alpha = true;
        }
        return PngEncoder.Encode(rgba, w, h);
    }
}
