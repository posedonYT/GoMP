// The game files behind the Studio: CodeWalker's GameFileCache over a GTA V
// folder (with the mods folder, so add-on packs installed by gomp-addons are
// included). Loading takes a while and happens in the background; State and
// Status tell how far it is. The catalog lists the archetypes (models that can
// be placed) with their bounding boxes.
using CodeWalker.GameFiles;

namespace GoMP.Studio.Game;

public enum GameState { None, Loading, Ready, Failed }

public sealed record ArchetypeInfo(string Name, uint Hash, float[] BBMin, float[] BBMax, float Radius, float LodDist, string Kind, string Ytyp);

public sealed class GameData
{
    private readonly object sync = new();
    private Task loading;
    private Dictionary<uint, ArchetypeInfo> archetypes = new();
    private List<ArchetypeInfo> named = new();

    public string GameDir { get; }
    public GameState State { get; private set; } = GameState.None;
    public string Status { get; private set; } = "нет папки игры";
    public GameFileCache Cache { get; private set; }
    public event Action<GameState, string> Changed;

    public GameData(string gameDir)
    {
        GameDir = string.IsNullOrWhiteSpace(gameDir) ? null : Path.GetFullPath(gameDir);
    }

    // Starts loading (once); the task ends when the game data is ready or failed.
    public Task StartLoading()
    {
        lock (sync)
        {
            if (loading != null) return loading;
            if (GameDir == null)
            {
                Set(GameState.None, "нет папки игры: запустите с --gta <папка GTA V>");
                return loading = Task.CompletedTask;
            }
            Set(GameState.Loading, "загрузка файлов игры...");
            return loading = Task.Run(Load);
        }
    }

    private void Load()
    {
        try
        {
            GoMP.Gta.Keys.Load(GameDir);
            var cache = new GameFileCache(2L << 30, 600, GameDir, false, "", Directory.Exists(Path.Combine(GameDir, "mods")), "Installers;_CommonRedist")
            {
                EnableDlc = true,  // every DLC: their props too
                LoadVehicles = true,
                LoadPeds = false,
                LoadAudio = false,
            };
            cache.Init(s => Set(GameState.Loading, s), e => { });
            var dict = new Dictionary<uint, ArchetypeInfo>();
            foreach (var ytyp in cache.YtypDict.Values)
                foreach (var arch in ytyp.AllArchetypes ?? Array.Empty<Archetype>())
                    dict[arch.Hash] = Describe(arch.Hash, arch);
            lock (sync)
            {
                archetypes = dict;
                named = dict.Values.Where(a => a.Name != null).OrderBy(a => a.Name, StringComparer.Ordinal).ToList();
                Cache = cache;
            }
            Set(GameState.Ready, $"готово: {dict.Count} моделей");
        }
        catch (Exception e)
        {
            Set(GameState.Failed, "ошибка загрузки игры: " + e.Message);
        }
    }

    private static ArchetypeInfo Describe(uint hash, Archetype a)
    {
        string name = JenkIndex.TryGetString(hash);
        string kind = a is MloArchetype ? "interior" : a is TimeArchetype ? "time" : "model";
        return new ArchetypeInfo(string.IsNullOrEmpty(name) ? null : name, hash,
            new[] { a.BBMin.X, a.BBMin.Y, a.BBMin.Z }, new[] { a.BBMax.X, a.BBMax.Y, a.BBMax.Z },
            a.BSRadius, a.LodDist, kind, a.Ytyp?.Name);
    }

    private void Set(GameState state, string status)
    {
        State = state;
        Status = status;
        Changed?.Invoke(state, status);
    }

    public bool Has(uint hash) => archetypes.ContainsKey(hash);

    public ArchetypeInfo Get(uint hash) => archetypes.TryGetValue(hash, out var a) ? a : null;

    // Models whose name contains every word of the query; props first.
    public IReadOnlyList<ArchetypeInfo> Search(string query, int limit, bool interiors = false)
    {
        var words = (query ?? "").ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return named
            .Where(a => (interiors || a.Kind != "interior") && words.All(w => a.Name.Contains(w, StringComparison.Ordinal)))
            .OrderBy(a => a.Name.StartsWith("prop_") ? 0 : 1)
            .ThenBy(a => a.Name.Length)
            .Take(Math.Clamp(limit, 1, 500))
            .ToList();
    }
}
