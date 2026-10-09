// Where the Studio finds things: the GTA V folder, the server's files (maps) and
// the add-on packs. Command line: --gta, --server-files, --addons, --port,
// --no-browser (also settings Studio:Gta... for tests). Without --server-files
// and --addons the folders of the GoMP repository around the program are used.
namespace GoMP.Studio;

public sealed class StudioOptions
{
    public string GtaDir { get; init; }
    public string ServerFiles { get; init; }
    public string AddonsDir { get; init; }
    public int Port { get; init; } = 22100;
    public string CacheDir { get; init; }
    public bool OpenBrowser { get; init; } = true;

    public string MapsDir => Path.Combine(ServerFiles, "maps");

    public static readonly Dictionary<string, string> Switches = new()
    {
        ["--gta"] = "Studio:Gta",
        ["--server-files"] = "Studio:ServerFiles",
        ["--addons"] = "Studio:Addons",
        ["--port"] = "Studio:Port",
        ["--no-browser"] = "Studio:NoBrowser",
        ["--web"] = "Studio:Web",
        ["--cache"] = "Studio:Cache",
    };

    public static StudioOptions From(IConfiguration c)
    {
        string serverFiles = c["Studio:ServerFiles"] ?? FindUp("server-files") ?? Path.Combine(Directory.GetCurrentDirectory(), "server-files");
        return new StudioOptions
        {
            GtaDir = c["Studio:Gta"] ?? Environment.GetEnvironmentVariable("GOMP_GTA_DIR"),
            ServerFiles = Path.GetFullPath(serverFiles),
            AddonsDir = Path.GetFullPath(c["Studio:Addons"] ?? FindUp(Path.Combine("client-dist", "addons")) ?? "addons"),
            Port = int.TryParse(c["Studio:Port"], out int p) ? p : 22100,
            OpenBrowser = c["Studio:NoBrowser"] == null,
            CacheDir = c["Studio:Cache"] ?? Export.ModelCache.DefaultRoot,
        };
    }

    // A folder next to the working directory or the program, or in a parent of them.
    private static string FindUp(string rel)
    {
        foreach (string start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
            for (var d = new DirectoryInfo(start); d != null; d = d.Parent)
                if (Directory.Exists(Path.Combine(d.FullName, rel))) return Path.Combine(d.FullName, rel);
        return null;
    }
}
