// A custom map as server-files/packages/freeroam/maps.js reads it
// (server-files/maps/<name>.json, format gomp-map, version 1).
// Fields the Studio does not know are kept as they are (Extra).
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GoMP.Studio.Maps;

public sealed class MapDocument
{
    public const string FormatName = "gomp-map";
    public const int CurrentVersion = 1;
    public const int MaxObjects = 5000;  // the same limit as maps.js

    [JsonPropertyName("format")] public string Format { get; set; } = FormatName;
    [JsonPropertyName("version")] public int Version { get; set; } = CurrentVersion;
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("enabled")] public bool Enabled { get; set; } = true;
    [JsonPropertyName("objects")] public List<MapObject> Objects { get; set; } = new();
    [JsonExtensionData] public Dictionary<string, JsonElement> Extra { get; set; }

    public static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        NumberHandling = JsonNumberHandling.Strict,
    };

    public static MapDocument Parse(string json) =>
        JsonSerializer.Deserialize<MapDocument>(json, Json) ?? throw new JsonException("empty map");

    public string ToJson() => JsonSerializer.Serialize(this, Json) + "\n";
}

public sealed class MapObject
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    // A model name ("prop_bench_01a") or its hash.
    [JsonPropertyName("model")] public ModelRef Model { get; set; }
    [JsonPropertyName("pos")] public double[] Pos { get; set; } = { 0, 0, 0 };
    // Degrees, as SET_ENTITY_ROTATION with rotation order 2 (GtaRotation).
    [JsonPropertyName("rot")] public double[] Rot { get; set; } = { 0, 0, 0 };
    [JsonPropertyName("dimension")] public uint Dimension { get; set; }
    [JsonPropertyName("alpha")] public int Alpha { get; set; } = 255;
    [JsonPropertyName("group")][JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string Group { get; set; }
    [JsonExtensionData] public Dictionary<string, JsonElement> Extra { get; set; }
}

// "model": a name or a number (a hash as the server takes it).
[JsonConverter(typeof(ModelRefConverter))]
public readonly record struct ModelRef(string Name, uint Hash)
{
    public static ModelRef Of(string name) => new(name.Trim().ToLowerInvariant(), Joaat.Hash(name.Trim().ToLowerInvariant()));
    public static ModelRef Of(uint hash) => new(null, hash);
    public bool IsEmpty => Name == null ? Hash == 0 : Name.Length == 0;
    public override string ToString() => Name ?? Hash.ToString();
}

public sealed class ModelRefConverter : JsonConverter<ModelRef>
{
    public override ModelRef Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) => reader.TokenType switch
    {
        JsonTokenType.String => ModelRef.Of(reader.GetString() ?? ""),
        JsonTokenType.Number when reader.TryGetUInt32(out uint h) => ModelRef.Of(h),
        _ => throw new JsonException("model: a name or a hash"),
    };

    public override void Write(Utf8JsonWriter writer, ModelRef value, JsonSerializerOptions options)
    {
        if (value.Name != null) writer.WriteStringValue(value.Name);
        else writer.WriteNumberValue(value.Hash);
    }
}

// Jenkins one-at-a-time, the hash of GTA names (lower case), like mp.joaat.
public static class Joaat
{
    public static uint Hash(string s)
    {
        uint h = 0;
        foreach (byte b in System.Text.Encoding.UTF8.GetBytes(s.ToLowerInvariant()))
        {
            h += b;
            h += h << 10;
            h ^= h >> 6;
        }
        h += h << 3;
        h ^= h >> 11;
        h += h << 15;
        return h;
    }
}
