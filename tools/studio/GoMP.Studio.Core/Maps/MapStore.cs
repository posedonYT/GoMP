// The maps folder of the server (server-files/maps): one JSON file per map,
// written atomically (a temporary file, then a rename) because maps.js watches
// the folder and must never read half a file. .cursor.json is where /mapcursor
// put an admin in the game.
using System.Text.Json;
using System.Text.RegularExpressions;

namespace GoMP.Studio.Maps;

public sealed record MapInfo(string Name, string Title, int Objects, bool Enabled, DateTime Modified);

public sealed record Cursor(double X, double Y, double Z, double Heading, uint Dimension, string Name, long At);

public sealed class MapStore
{
    public const string CursorFile = ".cursor.json";
    private static readonly Regex NameRe = new(@"^[\p{L}\p{N}_\-]{1,64}$");

    public string Dir { get; }

    public MapStore(string dir)
    {
        Dir = Path.GetFullPath(dir);
        Directory.CreateDirectory(Dir);
    }

    // Letters, digits, _ and -: a file name on every system.
    public static bool ValidName(string name) => name != null && NameRe.IsMatch(name);

    private string FileOf(string name)
    {
        if (!ValidName(name)) throw new ArgumentException("имя карты: буквы, цифры, _ и -, до 64 символов");
        return Path.Combine(Dir, name + ".json");
    }

    public bool Exists(string name) => ValidName(name) && File.Exists(FileOf(name));

    public IReadOnlyList<MapInfo> List()
    {
        var list = new List<MapInfo>();
        foreach (string file in Directory.GetFiles(Dir, "*.json"))
        {
            string name = Path.GetFileNameWithoutExtension(file);
            if (name.StartsWith('.') || !ValidName(name)) continue;
            try
            {
                var doc = MapDocument.Parse(File.ReadAllText(file));
                list.Add(new MapInfo(name, doc.Name, doc.Objects.Count, doc.Enabled, File.GetLastWriteTimeUtc(file)));
            }
            catch (JsonException)
            {
                list.Add(new MapInfo(name, "(ошибка в файле)", 0, false, File.GetLastWriteTimeUtc(file)));
            }
        }
        return list.OrderBy(m => m.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public MapDocument Load(string name) => MapDocument.Parse(File.ReadAllText(FileOf(name)));

    public void Save(string name, MapDocument doc) => WriteAtomic(FileOf(name), doc.ToJson());

    public void Delete(string name) => File.Delete(FileOf(name));

    public void Rename(string from, string to)
    {
        string src = FileOf(from), dst = FileOf(to);
        if (File.Exists(dst)) throw new IOException($"карта {to} уже есть");
        File.Move(src, dst);
    }

    public Cursor ReadCursor()
    {
        string file = Path.Combine(Dir, CursorFile);
        if (!File.Exists(file)) return null;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            var r = doc.RootElement;
            double Num(string k) => r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : 0;
            return new Cursor(Num("x"), Num("y"), Num("z"), Num("heading"), (uint)Num("dimension"),
                r.TryGetProperty("name", out var n) ? n.GetString() : null, (long)Num("at"));
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static void WriteAtomic(string file, string text)
    {
        string tmp = file + "." + Environment.ProcessId + ".tmp";
        File.WriteAllText(tmp, text, new System.Text.UTF8Encoding(false));
        File.Move(tmp, file, true);
    }
}
