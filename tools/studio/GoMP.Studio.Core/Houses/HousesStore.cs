// server-files/houses.json (the definitions, written atomically: houses.js watches
// the file) and, read only, the state of the houses in server-files/data/gomp-rp.json
// (owner, lock, garage), which is how the Studio knows an id is taken.
using System.Text.Json;
using GoMP.Studio.Maps;

namespace GoMP.Studio.Houses;

public sealed record HouseState(int? Owner, string OwnerName, bool Locked, int GarageCount);

public sealed class HousesStore
{
    // A new house never gets an id that has (had) an owner: ids start here.
    public const int FirstNewId = 1000;

    public string ServerFiles { get; }
    public string File => Path.Combine(ServerFiles, "houses.json");
    public string DataFile => Path.Combine(ServerFiles, "data", "gomp-rp.json");

    public HousesStore(string serverFiles)
    {
        ServerFiles = Path.GetFullPath(serverFiles);
    }

    // A missing file is an empty document; a broken one throws JsonException.
    public HousesDocument Load() => System.IO.File.Exists(File) ? HousesDocument.Parse(LoadText()) : HousesDocument.Empty();

    public string LoadText() => System.IO.File.ReadAllText(File);

    public void Save(HousesDocument doc)
    {
        Directory.CreateDirectory(ServerFiles);
        MapStore.WriteAtomic(File, doc.ToJson());
    }

    // The server keeps one file per house state (data/tables/houses/<id>.json,
    // store/file.js); older servers kept everything in data/gomp-rp.json. With
    // Redis as the server's storage there are no files: no states are shown.
    public string TablesDir => Path.Combine(ServerFiles, "data", "tables", "houses");

    public Dictionary<int, HouseState> ReadStates()
    {
        var states = new Dictionary<int, HouseState>();
        try
        {
            if (Directory.Exists(TablesDir))
            {
                foreach (string file in Directory.EnumerateFiles(TablesDir, "*.json"))
                {
                    if (!int.TryParse(Path.GetFileNameWithoutExtension(file), out int id)) continue;
                    try
                    {
                        using var one = JsonDocument.Parse(System.IO.File.ReadAllText(file));
                        if (one.RootElement.ValueKind == JsonValueKind.Object) states[id] = StateOf(one.RootElement);
                    }
                    catch (Exception e) when (e is JsonException or IOException)
                    {
                        // Being written just now: skipped this time.
                    }
                }
                return states;
            }
            if (!System.IO.File.Exists(DataFile)) return states;
            using var db = JsonDocument.Parse(System.IO.File.ReadAllText(DataFile));
            if (db.RootElement.ValueKind != JsonValueKind.Object ||
                !db.RootElement.TryGetProperty("houses", out var houses) || houses.ValueKind != JsonValueKind.Object) return states;
            foreach (var p in houses.EnumerateObject())
            {
                if (!int.TryParse(p.Name, out int id) || p.Value.ValueKind != JsonValueKind.Object) continue;
                states[id] = StateOf(p.Value);
            }
        }
        catch (Exception e) when (e is JsonException or IOException or UnauthorizedAccessException)
        {
            // The server may be writing the file just now: show no states rather than fail.
            return new Dictionary<int, HouseState>();
        }
        return states;
    }

    private static HouseState StateOf(JsonElement s)
    {
        int? owner = s.TryGetProperty("owner", out var o) && o.ValueKind == JsonValueKind.Number && o.TryGetInt32(out int ow) ? ow : null;
        string ownerName = s.TryGetProperty("ownerName", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : "";
        bool locked = !s.TryGetProperty("locked", out var l) || l.ValueKind != JsonValueKind.False;
        int garage = s.TryGetProperty("garage", out var g) && g.ValueKind == JsonValueKind.Array ? g.GetArrayLength() : 0;
        return new HouseState(owner, ownerName, locked, garage);
    }

    // Above every id in the document and every id the database holds a state for.
    public static int NextId(HousesDocument doc, IReadOnlyDictionary<int, HouseState> states)
    {
        int max = FirstNewId - 1;
        foreach (var h in doc.Houses ?? new()) max = Math.Max(max, h.Id);
        foreach (int id in states.Keys) max = Math.Max(max, id);
        return max + 1;
    }
}
