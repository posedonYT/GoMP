// The houses of the server as houses.js reads them (server-files/houses.json,
// format gomp-houses, version 1): interiors, house classes and the houses themselves.
// Fields the Studio does not know are kept as they are (Extra) at every level.
using System.Text.Json;
using System.Text.Json.Serialization;
using GoMP.Studio.Maps;

namespace GoMP.Studio.Houses;

public sealed class HousesDocument
{
    public const string FormatName = "gomp-houses";
    public const int CurrentVersion = 1;
    public const int MaxProps = 300;    // per interior, the same limit as houses.js
    public const int MaxGarage = 50;
    public const int MaxSlots = 50;     // car slots per garage template

    [JsonPropertyName("format")] public string Format { get; set; } = FormatName;
    [JsonPropertyName("version")] public int Version { get; set; } = CurrentVersion;
    [JsonPropertyName("interiors")] public List<HouseInterior> Interiors { get; set; } = new();
    // Garage interiors; null: the file has none (not written, so old files stay as they are).
    [JsonPropertyName("garages")] public List<GarageTemplate> Garages { get; set; }
    [JsonPropertyName("classes")] public List<HouseClass> Classes { get; set; } = new();
    [JsonPropertyName("houses")] public List<HouseDef> Houses { get; set; } = new();
    [JsonExtensionData] public Dictionary<string, JsonElement> Extra { get; set; }

    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        NumberHandling = JsonNumberHandling.Strict,
    };

    public static HousesDocument Parse(string json) =>
        JsonSerializer.Deserialize<HousesDocument>(json.TrimStart('﻿'), Json) ?? throw new JsonException("empty document");

    // LF on every system (the indenting follows Environment.NewLine); line breaks inside strings are escaped.
    public string ToJson() => JsonSerializer.Serialize(this, Json).Replace("\r\n", "\n") + "\n";

    public static HousesDocument Empty() => new();
}

public sealed class HouseInterior
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("spawn")] public double[] Spawn { get; set; } = { 0, 0, 0 };
    [JsonPropertyName("heading")] public double Heading { get; set; }
    [JsonPropertyName("exit")] public double[] Exit { get; set; } = { 0, 0, 0 };
    [JsonPropertyName("props")] public List<InteriorProp> Props { get; set; } = new();
    [JsonExtensionData] public Dictionary<string, JsonElement> Extra { get; set; }
}

public sealed class InteriorProp
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    // A model name or its hash (as in the maps).
    [JsonPropertyName("model")] public ModelRef Model { get; set; }
    [JsonPropertyName("pos")] public double[] Pos { get; set; } = { 0, 0, 0 };
    [JsonPropertyName("rot")] public double[] Rot { get; set; } = { 0, 0, 0 };
    [JsonExtensionData] public Dictionary<string, JsonElement> Extra { get; set; }
}

public sealed class HouseClass
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("garage")] public int Garage { get; set; }
    [JsonPropertyName("interior")] public string Interior { get; set; } = "";
    // Garage interior of the class; null: none (the virtual garage), not written.
    [JsonPropertyName("garageInterior")] public string GarageInterior { get; set; }
    [JsonExtensionData] public Dictionary<string, JsonElement> Extra { get; set; }
}

public sealed class GarageTemplate
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("spawn")] public double[] Spawn { get; set; } = { 0, 0, 0 };
    [JsonPropertyName("heading")] public double Heading { get; set; }
    [JsonPropertyName("exit")] public double[] Exit { get; set; } = { 0, 0, 0 };
    [JsonPropertyName("slots")] public List<GarageSlot> Slots { get; set; } = new();
    [JsonExtensionData] public Dictionary<string, JsonElement> Extra { get; set; }
}

public sealed class GarageSlot
{
    [JsonPropertyName("pos")] public double[] Pos { get; set; } = { 0, 0, 0 };
    [JsonPropertyName("heading")] public double Heading { get; set; }
    [JsonExtensionData] public Dictionary<string, JsonElement> Extra { get; set; }
}

// Where a car enters the garage outside (and appears when it leaves).
public sealed class HouseGaragePoint
{
    [JsonPropertyName("pos")] public double[] Pos { get; set; } = { 0, 0, 0 };
    [JsonPropertyName("heading")] public double Heading { get; set; }
    [JsonExtensionData] public Dictionary<string, JsonElement> Extra { get; set; }
}

public sealed class HouseDef
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("cls")] public string Cls { get; set; } = "";
    [JsonPropertyName("price")] public long Price { get; set; }
    [JsonPropertyName("door")] public double[] Door { get; set; } = { 0, 0, 0 };
    [JsonPropertyName("heading")] public double Heading { get; set; }
    // Its own interior instead of the class's; null: the class's (not written).
    [JsonPropertyName("interior")] public string Interior { get; set; }
    // Its own garage interior instead of the class's, and the entrance point outside; null: none, not written.
    [JsonPropertyName("garageInterior")] public string GarageInterior { get; set; }
    [JsonPropertyName("garagePoint")] public HouseGaragePoint GaragePoint { get; set; }
    [JsonExtensionData] public Dictionary<string, JsonElement> Extra { get; set; }
}
