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
    // Archetypes whose name hash differs from the asset hash they are keyed by: the
    // game (and the server's maps) refer to them by the name hash.
    private Dictionary<uint, ArchetypeInfo> byNameHash = new();
    private CatalogIndex index = new(Array.Empty<ArchetypeInfo>());

    public string GameDir { get; }
    // How the archives are scanned (GameArchives): null — CodeWalker's own scan on Windows only.
    public bool? OwnScan { get; init; }
    public GameState State { get; private set; } = GameState.None;
    public string Status { get; private set; } = "нет папки игры";
    public GameFileCache Cache { get; private set; }
    public Export.ModelExporter Exporter { get; private set; }
    public WorldIndex World { get; private set; }
    public CatalogIndex Catalog => index;
    public Exception Error { get; private set; }  // why loading failed (for the console)

    // Handling, kit and light ids, paints of the game: read when the vehicle editor first needs them.
    private Lazy<Vehicles.GameVehicles> vehicles;
    public Vehicles.GameVehicles Vehicles => vehicles?.Value;
    // Vehicle path nodes, read when a garage entrance first needs a road.
    private Lazy<RoadNodes> roads;
    public RoadNodes Roads => roads?.Value;
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
            GameArchives.Init(cache, GameDir, s => Set(GameState.Loading, s), e => { }, OwnScan);
            var dict = new Dictionary<uint, ArchetypeInfo>();
            var aliases = new Dictionary<uint, ArchetypeInfo>();
            foreach (var ytyp in cache.YtypDict.Values)
                foreach (var arch in ytyp.AllArchetypes ?? Array.Empty<Archetype>())
                {
                    var info = Describe(arch);
                    dict[arch.Hash] = info;
                    uint nameHash = arch.BaseArchetypeDef.name.Hash;
                    if (nameHash != 0 && nameHash != arch.Hash.Hash) aliases[nameHash] = info;
                }
            var idx = new CatalogIndex(dict.Values);
            lock (sync)
            {
                archetypes = dict;
                byNameHash = aliases;
                index = idx;
                Cache = cache;
                Exporter = new Export.ModelExporter(cache);
                World = new WorldIndex(cache);
                vehicles = new Lazy<Vehicles.GameVehicles>(() => GoMP.Studio.Vehicles.GameVehicles.Load(cache));
                roads = new Lazy<RoadNodes>(() => RoadNodes.Load(cache));
            }
            Set(GameState.Ready, $"готово: {dict.Count} моделей, {idx.NamedCount} с именами");
        }
        catch (Exception e)
        {
            Error = e;
            Set(GameState.Failed, "ошибка загрузки игры: " + e.Message);
        }
    }

    private static ArchetypeInfo Describe(Archetype a)
    {
        uint hash = a.Hash;
        // Keyed by the asset name, which is often not in the dictionary while the model name is.
        string name = JenkIndex.TryGetString(hash);
        if (string.IsNullOrEmpty(name)) name = JenkIndex.TryGetString(a.BaseArchetypeDef.name.Hash);
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

    public bool Has(uint hash) => archetypes.ContainsKey(hash) || byNameHash.ContainsKey(hash);

    public ArchetypeInfo Get(uint hash) =>
        archetypes.TryGetValue(hash, out var a) ? a : byNameHash.TryGetValue(hash, out var b) ? b : null;

    // Models whose name matches every word of the query; see CatalogSearch for the order.
    public IReadOnlyList<ArchetypeInfo> Search(string query, int limit, bool interiors = false) =>
        index.Search(query, null, 0, limit, interiors).Items;

    public CatalogPage Search(string query, string category, int offset, int limit, bool interiors) =>
        index.Search(query, category, offset, limit, interiors);
}
