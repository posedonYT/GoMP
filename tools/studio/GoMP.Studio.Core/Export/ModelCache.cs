// Exported models on disk: <cache>/models/<hash>-<lod>-<texture size>-v<version>.glb, so a
// model is exported once (and models the game does not have are remembered).
using System.Collections.Concurrent;

namespace GoMP.Studio.Export;

public sealed class ModelCache
{
    private readonly string dir;
    private readonly ConcurrentDictionary<string, bool> missing = new();
    // Exports running now: a second request for the same model (the warmer and the
    // browser) waits for the first instead of exporting it again.
    private readonly ConcurrentDictionary<string, Lazy<byte[]>> running = new();

    // The texture size of the world around the camera (web/js/scene/world.js TEXTURE).
    public const int WorldTexture = 128;

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
        var job = running.GetOrAdd(key, _ => new Lazy<byte[]>(() => ExportToFile(key, file, export)));
        try
        {
            return job.Value;
        }
        finally
        {
            running.TryRemove(new KeyValuePair<string, Lazy<byte[]>>(key, job));
        }
    }

    public bool Has(uint hash, Lod lod, int maxTexture) =>
        File.Exists(Path.Combine(dir, $"{hash:x8}-{lod.ToString().ToLowerInvariant()}-{maxTexture}-v{ModelExporter.Version}.glb"));

    private byte[] ExportToFile(string key, string file, Func<byte[]> export)
    {
        var data = export();
        if (data == null)
        {
            missing[key] = true;
            return null;
        }
        string tmp = file + "." + Environment.ProcessId + "." + Environment.CurrentManagedThreadId + ".tmp";
        File.WriteAllBytes(tmp, data);
        File.Move(tmp, file, true);
        return data;
    }
}
