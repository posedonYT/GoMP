// Exported models on disk: <cache>/models/<hash>-<lod>-<texture size>-v<version>.glb, so a
// model is exported once (and models the game does not have are remembered).
using System.Collections.Concurrent;

namespace GoMP.Studio.Export;

public sealed class ModelCache
{
    private readonly string dir;
    private readonly ConcurrentDictionary<string, bool> missing = new();

    public ModelCache(string root)
    {
        dir = Path.Combine(root, "models");
        Directory.CreateDirectory(dir);
    }

    public static string DefaultRoot =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolderOption.Create), "GoMP Studio", "cache");

    public byte[] Get(uint hash, Lod lod, Func<byte[]> export, int maxTexture = ModelExporter.MaxTextureSize)
    {
        string key = $"{hash:x8}-{lod.ToString().ToLowerInvariant()}-{maxTexture}-v{ModelExporter.Version}";
        string file = Path.Combine(dir, key + ".glb");
        if (File.Exists(file)) return File.ReadAllBytes(file);
        if (missing.ContainsKey(key)) return null;
        var data = export();
        if (data == null)
        {
            missing[key] = true;
            return null;
        }
        string tmp = file + "." + Environment.ProcessId + ".tmp";
        File.WriteAllBytes(tmp, data);
        File.Move(tmp, file, true);
        return data;
    }
}
