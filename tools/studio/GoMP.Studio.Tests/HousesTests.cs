using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using GoMP.Studio.Game;
using GoMP.Studio.Houses;
using GoMP.Studio.Maps;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit.Abstractions;

namespace GoMP.Studio.Tests;

internal static class RealServerFiles
{
    // server-files of the repository (read only), or null when the tests run outside it.
    public static string Dir()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "server-files", "houses.json"))) return Path.Combine(d.FullName, "server-files");
        return null;
    }
}

public sealed class HousesDocumentTests
{
    private const string Sample = """
        {
          "format": "gomp-houses",
          "version": 1,
          "note": "top",
          "interiors": [
            {
              "id": "studio",
              "name": "Студия",
              "spawn": [261.4586, -998.8196, -99.00863],
              "heading": 12.5,
              "exit": [261.4586, -998.8196, -99.00863],
              "tag": { "a": [1, 2] },
              "props": [
                { "id": "p1", "model": "prop_couch_01", "pos": [1, 2, 3.25], "rot": [0, 0, 90], "color": 4 },
                { "id": "p2", "model": 123456, "pos": [0, 0, 0], "rot": [0, 0, 0] }
              ]
            }
          ],
          "classes": [ { "id": "econom", "name": "Эконом", "garage": 2, "interior": "studio", "perk": true } ],
          "houses": [
            { "id": 1, "name": "Grove Street, 1", "cls": "econom", "price": 55000, "door": [1.5, 2.5, 3.5], "heading": 90, "owner": "x" },
            { "id": 2, "name": "Own", "cls": "econom", "price": 1, "door": [10, 2.5, 3.5], "heading": 0, "interior": "studio" }
          ]
        }
        """;

    [Fact]
    public void Unknown_fields_and_numbers_survive_a_round_trip()
    {
        var doc = HousesDocument.Parse(Sample);
        string text = doc.ToJson();
        Assert.EndsWith("}\n", text);
        Assert.DoesNotContain("\r", text);
        Assert.False(text.StartsWith('﻿'));
        Assert.Contains("-99.00863", text);
        Assert.Contains("\"note\": \"top\"", text);
        Assert.Contains("\"tag\"", text);
        Assert.Contains("\"color\": 4", text);
        Assert.Contains("\"perk\": true", text);
        Assert.Contains("\"owner\": \"x\"", text);
        Assert.Contains("\"Студия\"", text);
        Assert.Contains("\"model\": 123456", text);
        Assert.Contains("\"model\": \"prop_couch_01\"", text);
        // A house without its own interior writes none: the class and house 2 only.
        Assert.Equal(2, text.Split("\"interior\": \"studio\"").Length - 1);
        var again = HousesDocument.Parse(text);
        Assert.Null(again.Houses[0].Interior);
        Assert.Equal(text, again.ToJson());
    }

    [Fact]
    public void Parse_tolerates_a_bom_and_empty_is_the_default_document()
    {
        var doc = HousesDocument.Parse("﻿" + Sample);
        Assert.Equal(2, doc.Houses.Count);
        var empty = HousesDocument.Empty();
        Assert.Equal("gomp-houses", empty.Format);
        Assert.Equal(1, empty.Version);
        Assert.Empty(empty.Houses);
        Assert.Equal("{\n  \"format\": \"gomp-houses\",\n  \"version\": 1,\n  \"interiors\": [],\n  \"classes\": [],\n  \"houses\": []\n}\n", empty.ToJson());
    }

    [Fact]
    public void The_real_houses_file_is_valid_and_survives_a_rewrite()
    {
        string dir = RealServerFiles.Dir();
        if (dir == null) return;
        var doc = new HousesStore(dir).Load();
        Assert.NotEmpty(doc.Houses);
        var issues = HousesValidator.Check(doc);
        Assert.Empty(issues.Where(i => i.Severity == Severity.Error));
        // Rewriting the file keeps its content (unknown fields included).
        using var a = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "houses.json")));
        using var b = JsonDocument.Parse(doc.ToJson());
        Assert.Equal(Canon(a.RootElement), Canon(b.RootElement));
    }

    // Object keys in order, numbers by value.
    private static string Canon(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Object => "{" + string.Join(",", e.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal).Select(p => p.Name + ":" + Canon(p.Value))) + "}",
        JsonValueKind.Array => "[" + string.Join(",", e.EnumerateArray().Select(Canon)) + "]",
        JsonValueKind.Number => e.GetDouble().ToString("R", System.Globalization.CultureInfo.InvariantCulture),
        _ => e.GetRawText(),
    };
}

public sealed class HousesValidatorTests
{
    private static HousesDocument Good() => HousesDocument.Parse("""
        { "format": "gomp-houses", "version": 1,
          "interiors": [ { "id": "studio", "name": "S", "spawn": [0, 0, 0], "exit": [1, 1, 0], "props": [] } ],
          "classes": [ { "id": "econom", "name": "E", "garage": 2, "interior": "studio" } ],
          "houses": [ { "id": 1, "name": "H", "cls": "econom", "price": 100, "door": [100, 100, 30] } ] }
        """);

    private static List<MapIssue> Errors(HousesDocument d, Func<uint, bool> known = null) =>
        HousesValidator.Check(d, known).Where(i => i.Severity == Severity.Error).ToList();

    private static List<MapIssue> Warnings(HousesDocument d, Func<uint, bool> known = null) =>
        HousesValidator.Check(d, known).Where(i => i.Severity == Severity.Warning).ToList();

    [Fact]
    public void A_good_document_has_no_issues() => Assert.Empty(HousesValidator.Check(Good()));

    [Fact]
    public void Format_and_version()
    {
        var d = Good();
        d.Format = "x";
        d.Version = 2;
        Assert.Equal(2, Errors(d).Count);
    }

    [Theory]
    [InlineData("Studio")]
    [InlineData("")]
    [InlineData("a b")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public void Ids_follow_the_server_pattern(string id)
    {
        var d = Good();
        d.Interiors[0].Id = id;
        Assert.Contains(Errors(d), i => i.Message.Contains("id — a-z"));
        var c = Good();
        c.Classes[0].Id = id;
        Assert.Contains(Errors(c), i => i.Message.StartsWith("класс: id"));
    }

    [Fact]
    public void Interior_rules()
    {
        var d = Good();
        d.Interiors.Add(new HouseInterior { Id = "studio", Name = "again" });
        Assert.Contains(Errors(d), i => i.Message == "интерьер studio: повторяется id");

        d = Good();
        d.Interiors[0].Name = "  ";
        Assert.Contains(Errors(d), i => i.Message == "интерьер studio: нет названия");

        d = Good();
        d.Interiors[0].Spawn = new double[] { 1, 2 };
        d.Interiors[0].Exit = new[] { 1, double.NaN, 3 };
        Assert.Equal(2, Errors(d).Count);

        d = Good();
        d.Interiors[0].Heading = double.PositiveInfinity;
        Assert.Contains(Errors(d), i => i.Message.Contains("heading"));

        d = Good();
        for (int k = 0; k <= HousesDocument.MaxProps; k++)
            d.Interiors[0].Props.Add(new InteriorProp { Id = "p" + k, Model = ModelRef.Of("prop_a") });
        Assert.Contains(Errors(d), i => i.Message.Contains("больше 300 предметов"));
    }

    [Fact]
    public void Prop_rules()
    {
        var d = Good();
        d.Interiors[0].Props.Add(new InteriorProp { Id = "a", Model = ModelRef.Of(""), Pos = new double[] { 1 }, Rot = new[] { 0, 0, double.NaN } });
        var e = Errors(d);
        Assert.Contains(e, i => i.Message == "интерьер studio, предмет 0: нет модели");
        Assert.Contains(e, i => i.Message.Contains("pos — три числа"));
        Assert.Contains(e, i => i.Message.Contains("rot — три числа"));
        // 0 is a valid hash; the maps accept it too.
        d = Good();
        d.Interiors[0].Props.Add(new InteriorProp { Id = "a", Model = ModelRef.Of(0u) });
        Assert.Empty(Errors(d));
    }

    [Fact]
    public void Class_rules()
    {
        var d = Good();
        d.Classes[0].Garage = 51;
        Assert.Contains(Errors(d), i => i.Message == "класс econom: garage — целое 0-50");
        d = Good();
        d.Classes[0].Garage = -1;
        Assert.Single(Errors(d));
        d = Good();
        d.Classes[0].Interior = "nope";
        Assert.Contains(Errors(d), i => i.Message == "класс econom: нет интерьера nope");
        d = Good();
        d.Classes.Add(new HouseClass { Id = "econom", Name = "x", Interior = "studio" });
        Assert.Contains(Errors(d), i => i.Message.Contains("повторяется"));
        d = Good();
        d.Classes[0].Name = "";
        Assert.Contains(Errors(d), i => i.Message.Contains("нет названия"));
    }

    [Fact]
    public void House_rules()
    {
        var d = Good();
        d.Houses[0].Cls = "lux2";
        d.Houses[0].Id = 12;
        Assert.Contains(Errors(d), i => i.Message == "дом 12: нет класса lux2");

        d = Good();
        d.Houses[0].Id = 0;
        Assert.Single(Errors(d));
        d = Good();
        d.Houses.Add(new HouseDef { Id = 1, Name = "dup", Cls = "econom", Price = 5 });
        Assert.Contains(Errors(d), i => i.Message == "дом 1: повторяется id");
        d = Good();
        d.Houses[0].Price = 0;
        Assert.Contains(Errors(d), i => i.Message.Contains("price"));
        d = Good();
        d.Houses[0].Name = " ";
        Assert.Contains(Errors(d), i => i.Message.Contains("нет названия"));
        d = Good();
        d.Houses[0].Door = new double[] { 1, 2, 3, 4 };
        Assert.Contains(Errors(d), i => i.Message.Contains("door"));
        d = Good();
        d.Houses[0].Heading = double.NaN;
        Assert.Contains(Errors(d), i => i.Message.Contains("heading"));
        d = Good();
        d.Houses[0].Interior = "ghost";
        Assert.Contains(Errors(d), i => i.Message == "дом 1: нет интерьера ghost");
    }

    [Fact]
    public void Warnings_for_odd_but_loadable_things()
    {
        var d = Good();
        d.Interiors[0].Exit = new double[] { 100, 0, 0 };
        Assert.Contains(Warnings(d), i => i.Message.Contains("выход далеко от точки появления"));
        Assert.Empty(Errors(d));

        d = Good();
        d.Houses.Add(new HouseDef { Id = 2, Name = "near", Cls = "econom", Price = 5, Door = new double[] { 101, 100, 30 } });
        Assert.Contains(Warnings(d), i => i.Message.Contains("ближе 2 м"));
        d.Houses[1].Door = new double[] { 103, 100, 30 };
        Assert.Empty(Warnings(d));

        d = Good();
        d.Houses[0].Door = new double[] { 0, 0, -60 };
        Assert.Contains(Warnings(d), i => i.Message.Contains("z = -50"));

        d = Good();
        d.Interiors.Add(new HouseInterior { Id = "spare", Name = "S" });
        Assert.Contains(Warnings(d), i => i.Message.Contains("не используется"));
        d.Houses[0].Interior = "spare";
        Assert.Empty(Warnings(d));

        d = Good();
        d.Interiors[0].Props.Add(new InteriorProp { Id = "a", Model = ModelRef.Of("prop_nope") });
        Assert.Empty(Warnings(d));
        Assert.Contains(Warnings(d, h => false), i => i.Message.Contains("prop_nope нет в игре"));
        Assert.Empty(Warnings(d, h => true));
    }
}

public sealed class HousesStoreTests : IDisposable
{
    private readonly string dir = Path.Combine(Path.GetTempPath(), "gomp-houses-" + Guid.NewGuid().ToString("N"));
    private readonly HousesStore store;

    public HousesStoreTests()
    {
        Directory.CreateDirectory(Path.Combine(dir, "data"));
        store = new HousesStore(dir);
    }

    public void Dispose() => Directory.Delete(dir, true);

    [Fact]
    public void A_missing_file_is_the_default_document_and_id_1000()
    {
        var doc = store.Load();
        Assert.Empty(doc.Houses);
        Assert.Equal(1000, HousesStore.NextId(doc, store.ReadStates()));
    }

    [Fact]
    public void Save_is_atomic_and_load_reads_it_back()
    {
        var doc = HousesDocument.Parse("""{ "format": "gomp-houses", "version": 1, "extra": 5, "interiors": [], "classes": [], "houses": [] }""");
        store.Save(doc);
        Assert.Empty(Directory.GetFiles(dir, "*.tmp"));
        Assert.Equal(doc.ToJson(), store.LoadText());
        Assert.Equal(5, store.Load().Extra["extra"].GetInt32());
        store.Save(HousesDocument.Empty());
        Assert.Empty(Directory.GetFiles(dir, "*.tmp"));
        Assert.Null(store.Load().Extra);
    }

    [Fact]
    public void States_are_read_from_the_database()
    {
        File.WriteAllText(Path.Combine(dir, "data", "gomp-rp.json"), """
            { "accounts": {}, "houses": {
                "1": { "owner": null, "ownerName": "", "locked": true, "garage": [] },
                "7": { "owner": 3, "ownerName": "Ivan Petrov", "locked": false, "garage": [ {"a":1}, {"a":2} ], "bought": 5 },
                "bad": { "owner": 1 }, "9": 5 } }
            """);
        var states = store.ReadStates();
        Assert.Equal(2, states.Count);
        Assert.Null(states[1].Owner);
        Assert.True(states[1].Locked);
        Assert.Equal(new HouseState(3, "Ivan Petrov", false, 2), states[7]);
    }

    // The server's file storage keeps a file per house (data/tables/houses/<id>.json);
    // it wins over an old gomp-rp.json left next to it.
    [Fact]
    public void States_are_read_from_the_files_of_the_server_storage()
    {
        var tables = Path.Combine(dir, "data", "tables", "houses");
        Directory.CreateDirectory(tables);
        File.WriteAllText(Path.Combine(tables, "7.json"), """{ "owner": 3, "ownerName": "Ivan Petrov", "locked": false, "garage": [ {"a":1} ] }""");
        File.WriteAllText(Path.Combine(tables, "8.json"), """{ "owner": null, "locked": true }""");
        File.WriteAllText(Path.Combine(tables, "9.json"), "{ broken");
        File.WriteAllText(Path.Combine(tables, "x.json"), "{}");
        File.WriteAllText(Path.Combine(dir, "data", "gomp-rp.json"), """{ "houses": { "2000": { "owner": 1 } } }""");
        var states = store.ReadStates();
        Assert.Equal(2, states.Count);
        Assert.Equal(new HouseState(3, "Ivan Petrov", false, 1), states[7]);
        Assert.Null(states[8].Owner);
        Assert.False(states.ContainsKey(2000));
    }

    [Fact]
    public void Next_id_is_above_the_document_and_the_database()
    {
        var doc = HousesDocument.Empty();
        doc.Houses.Add(new HouseDef { Id = 1200 });
        var states = new Dictionary<int, HouseState>();
        Assert.Equal(1201, HousesStore.NextId(doc, states));
        states[1500] = new HouseState(null, "", true, 0);
        Assert.Equal(1501, HousesStore.NextId(doc, states));
        doc.Houses[0].Id = 5;
        states.Clear();
        states[3] = new HouseState(null, "", true, 0);
        Assert.Equal(1000, HousesStore.NextId(doc, states));

        File.WriteAllText(Path.Combine(dir, "data", "gomp-rp.json"), """{ "houses": { "2000": { "owner": 1 } } }""");
        Assert.Equal(2001, HousesStore.NextId(doc, store.ReadStates()));
    }

    [Theory]
    [InlineData("{ not json")]
    [InlineData("[]")]
    [InlineData("{ \"houses\": [] }")]
    [InlineData("")]
    public void A_broken_database_gives_no_states(string text)
    {
        File.WriteAllText(Path.Combine(dir, "data", "gomp-rp.json"), text);
        Assert.Empty(store.ReadStates());
    }
}

// The API on a temporary server-files folder, without game files.
public sealed class HousesApiTests : IDisposable
{
    private readonly string serverFiles = Path.Combine(Path.GetTempPath(), "gomp-houses-api-" + Guid.NewGuid().ToString("N"));
    private readonly WebApplicationFactory<Program> factory;
    private readonly HttpClient http;

    public HousesApiTests()
    {
        Directory.CreateDirectory(serverFiles);
        factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("Studio:ServerFiles", serverFiles);
            b.UseSetting("Studio:Addons", Path.Combine(serverFiles, "addons"));
            b.UseSetting("Studio:Gta", "");
            b.UseSetting("Studio:NoBrowser", "1");
        });
        http = factory.CreateClient();
    }

    public void Dispose()
    {
        http.Dispose();
        factory.Dispose();
        Directory.Delete(serverFiles, true);
    }

    private string HousesFile => Path.Combine(serverFiles, "houses.json");

    private const string Valid = """
        { "format": "gomp-houses", "version": 1, "keep": 1,
          "interiors": [ { "id": "studio", "name": "S", "spawn": [1.5, 2, -99.00863], "heading": 0, "exit": [1.5, 2, -99.00863], "props": [] } ],
          "classes": [ { "id": "econom", "name": "E", "garage": 2, "interior": "studio" } ],
          "houses": [ { "id": 1, "name": "H", "cls": "econom", "price": 100, "door": [100, 100, 30], "heading": 0 } ] }
        """;

    private Task<HttpResponseMessage> Put(string json) =>
        http.PutAsync("/api/houses", new StringContent(json, System.Text.Encoding.UTF8, "application/json"));

    [Fact]
    public async Task Without_a_file_the_default_document_and_id_1000()
    {
        var r = await http.GetFromJsonAsync<JsonElement>("/api/houses");
        Assert.Equal("gomp-houses", r.GetProperty("doc").GetProperty("format").GetString());
        Assert.Equal(0, r.GetProperty("doc").GetProperty("houses").GetArrayLength());
        Assert.Equal(1000, r.GetProperty("nextId").GetInt32());
        Assert.Equal(0, r.GetProperty("issues").GetArrayLength());
        Assert.False(File.Exists(HousesFile));
    }

    [Fact]
    public async Task A_valid_document_is_saved()
    {
        var put = await Put(Valid);
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        var body = await put.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("saved").GetBoolean());
        Assert.Equal(1000, body.GetProperty("nextId").GetInt32());
        Assert.Empty(Directory.GetFiles(serverFiles, "*.tmp"));
        using var saved = JsonDocument.Parse(File.ReadAllText(HousesFile));
        Assert.Equal(1, saved.RootElement.GetProperty("keep").GetInt32());
        Assert.Equal(-99.00863, saved.RootElement.GetProperty("interiors")[0].GetProperty("spawn")[2].GetDouble());
        Assert.Equal(100, saved.RootElement.GetProperty("houses")[0].GetProperty("price").GetInt32());

        var got = await http.GetFromJsonAsync<JsonElement>("/api/houses");
        Assert.Equal(1, got.GetProperty("doc").GetProperty("houses").GetArrayLength());
        Assert.Equal(1, got.GetProperty("doc").GetProperty("keep").GetInt32());
    }

    [Fact]
    public async Task An_unknown_garage_reference_is_refused_and_a_valid_garage_is_saved()
    {
        string garage = """
            "garages": [ { "id": "g2", "name": "G", "spawn": [0, 0, -99], "heading": 90, "exit": [1, 0, -99],
                           "slots": [ { "pos": [5, 5, -99], "heading": 180, "tag": 1 } ], "memo": "m" } ],
            """;
        string good = Valid.Replace("\"interiors\"", garage + " \"interiors\"")
            .Replace("\"interior\": \"studio\" }", "\"interior\": \"studio\", \"garageInterior\": \"g2\" }")
            .Replace("\"heading\": 0 } ] }", "\"heading\": 0, \"garagePoint\": { \"pos\": [101, 100, 31], \"heading\": 45, \"w\": 1 } } ] }");
        Assert.Equal(HttpStatusCode.OK, (await Put(good)).StatusCode);
        string saved = File.ReadAllText(HousesFile);
        Assert.Contains("\"memo\": \"m\"", saved);
        Assert.Contains("\"tag\": 1", saved);
        Assert.Contains("\"w\": 1", saved);
        Assert.Contains("\"garagePoint\"", saved);

        var bad = await Put(good.Replace("\"garageInterior\": \"g2\"", "\"garageInterior\": \"nope\""));
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var body = await bad.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains(body.GetProperty("issues").EnumerateArray(), i => i.GetProperty("message").GetString() == "класс econom: нет гаража nope");
        Assert.Equal(saved, File.ReadAllText(HousesFile));
    }

    [Fact]
    public async Task Roads_are_unavailable_without_the_game()
    {
        var r = await http.GetAsync("/api/roads/nearest?x=0&y=0&z=0");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, r.StatusCode);
    }

    [Fact]
    public async Task An_invalid_document_is_refused_and_the_file_stays()
    {
        Assert.Equal(HttpStatusCode.OK, (await Put(Valid)).StatusCode);
        string before = File.ReadAllText(HousesFile);
        var put = await Put(Valid.Replace("\"cls\": \"econom\"", "\"cls\": \"lux2\"").Replace("\"id\": 1,", "\"id\": 12,"));
        Assert.Equal(HttpStatusCode.BadRequest, put.StatusCode);
        var body = await put.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains("ошибки", body.GetProperty("error").GetString());
        Assert.Equal("дом 12: нет класса lux2", body.GetProperty("issues")[0].GetProperty("message").GetString());
        Assert.Equal(before, File.ReadAllText(HousesFile));

        Assert.Equal(HttpStatusCode.BadRequest, (await Put("{ nope")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Put("""{ "format": "gomp-houses", "version": 1, "houses": [ { "id": "x" } ] }""")).StatusCode);
        Assert.Equal(before, File.ReadAllText(HousesFile));
    }

    [Fact]
    public async Task States_and_the_next_id_come_from_the_database()
    {
        Assert.Equal(HttpStatusCode.OK, (await Put(Valid)).StatusCode);
        Directory.CreateDirectory(Path.Combine(serverFiles, "data"));
        File.WriteAllText(Path.Combine(serverFiles, "data", "gomp-rp.json"),
            """{ "houses": { "1": { "owner": 4, "ownerName": "Ivan", "locked": false, "garage": [1, 2, 3] }, "1100": { "owner": null, "ownerName": "", "locked": true, "garage": [] } } }""");
        var r = await http.GetFromJsonAsync<JsonElement>("/api/houses");
        var s = r.GetProperty("states").GetProperty("1");
        Assert.Equal(4, s.GetProperty("owner").GetInt32());
        Assert.Equal("Ivan", s.GetProperty("ownerName").GetString());
        Assert.False(s.GetProperty("locked").GetBoolean());
        Assert.Equal(3, s.GetProperty("garage").GetInt32());
        Assert.Equal(JsonValueKind.Null, r.GetProperty("states").GetProperty("1100").GetProperty("owner").ValueKind);
        Assert.Equal(1101, r.GetProperty("nextId").GetInt32());
    }

    [Fact]
    public async Task A_broken_file_is_reported_not_overwritten()
    {
        File.WriteAllText(HousesFile, "{ broken");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await http.GetAsync("/api/houses")).StatusCode);
    }

    [Fact]
    public async Task Geometry_needs_the_game()
    {
        var r = await http.GetAsync("/api/interiors/geometry?x=261&y=-998&z=-99");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, r.StatusCode);
        Assert.Equal("none", (await r.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("state").GetString());
    }

    [Fact]
    public async Task The_houses_event_fires_when_the_file_is_written()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var res = await http.GetAsync("/api/events", HttpCompletionOption.ResponseHeadersRead, cts.Token);
        using var reader = new StreamReader(await res.Content.ReadAsStreamAsync(cts.Token));
        Assert.Equal(": connected", await reader.ReadLineAsync(cts.Token));
        await reader.ReadLineAsync(cts.Token);  // the blank line
        // A temporary file alone makes no event; the final one does.
        File.WriteAllText(HousesFile + ".1.tmp", "x");
        MapStore.WriteAtomic(HousesFile, HousesDocument.Empty().ToJson());
        string line = await reader.ReadLineAsync(cts.Token);
        Assert.Equal("""data: {"type":"houses","data":{}}""", line);
    }
}

// The interiors of the game around the apartments of the server.
[Collection("game")]
public sealed class InteriorGeometryTests
{
    private readonly GameFixture fixture;
    private readonly ITestOutputHelper output;

    public InteriorGeometryTests(GameFixture fixture, ITestOutputHelper output)
    {
        this.fixture = fixture;
        this.output = output;
    }

    [GameTheory]
    [InlineData("studio", 261.4586f, -998.8196f, -99.00863f)]
    [InlineData("renovated", 347.2686f, -999.2955f, -99.19622f)]
    [InlineData("integrity", -35.31277f, -580.4199f, 88.71221f)]
    public void The_apartments_have_walls_and_furniture(string name, float x, float y, float z)
    {
        var g = fixture.Game;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var geo = g.World.InteriorsNear(x, y, z);
        long ms = sw.ElapsedMilliseconds;
        Assert.NotEmpty(geo.Mlos);
        Assert.True(geo.Entities.Count >= 20, $"{name}: {geo.Entities.Count} entities");
        Assert.Equal(geo.Entities.Count, geo.Mlos.Sum(m => m.Entities));
        int known = geo.Entities.Count(e => g.Has(e.a));
        output.WriteLine($"{name}: {geo.Mlos.Count} MLO ({string.Join(", ", geo.Mlos.Select(m => m.Name))}), {geo.Entities.Count} entities, {known} known, {ms} ms");
        Assert.True(known >= geo.Entities.Count * 0.9, $"{name}: only {known} of {geo.Entities.Count} entities are known");
        Assert.All(geo.Entities, e =>
        {
            Assert.Equal(3, e.p.Length);
            Assert.Equal(4, e.q.Length);
            Assert.True(MathF.Sqrt((e.p[0] - x) * (e.p[0] - x) + (e.p[1] - y) * (e.p[1] - y) + (e.p[2] - z) * (e.p[2] - z)) <= 60.01f);
        });
        // Cached by the point: the same list.
        Assert.Same(geo, g.World.InteriorsNear(x, y, z));
        // A smaller radius gives a subset.
        Assert.True(g.World.InteriorsNear(x, y, z, 10).Entities.Count < geo.Entities.Count);
    }

    [GameTheory]
    [InlineData("studio", 261.4586f, -998.8196f, -99.00863f)]
    [InlineData("renovated", 347.2686f, -999.2955f, -99.19622f)]
    [InlineData("integrity", -35.31277f, -580.4199f, 88.71221f)]
    public void Only_the_interior_that_contains_the_point(string name, float x, float y, float z)
    {
        var g = fixture.Game;
        var all = g.World.InteriorsNear(x, y, z);
        Assert.True(all.Mlos[0].Contains, $"{name}: the first of the list contains the point");
        Assert.All(all.Entities, e => Assert.InRange(e.m ?? -1, 0, all.Mlos.Count - 1));
        var geo = g.World.InteriorsNear(x, y, z, onlyContains: true);
        var mlo = Assert.Single(geo.Mlos);
        Assert.True(mlo.Contains);
        Assert.Equal(all.Mlos[0].Name, mlo.Name);
        Assert.NotEmpty(geo.Entities);
        Assert.Equal(mlo.Entities, geo.Entities.Count);
        Assert.All(geo.Entities, e => Assert.Equal(0, e.m));
        output.WriteLine($"{name}: {mlo.Name}, {geo.Entities.Count} entities (of {all.Entities.Count} in {all.Mlos.Count} MLOs, {all.Mlos.Count(m => m.Contains)} containing)");
    }

    [GameTheory]
    [InlineData("studio", 261.4586f, -998.8196f, -99.00863f)]
    [InlineData("renovated", 347.2686f, -999.2955f, -99.19622f)]
    [InlineData("integrity", -35.31277f, -580.4199f, 88.71221f)]
    public void The_apartments_have_an_entrance_door(string name, float x, float y, float z)
    {
        var geo = fixture.Game.World.InteriorsNear(x, y, z, onlyContains: true);
        var mlo = Assert.Single(geo.Mlos);
        Assert.NotEmpty(geo.Doors);
        foreach (var d in geo.Doors)
            output.WriteLine($"{name}: door[{d.Kind}] {d.Model} outside={d.Outside} room={d.Room} ({d.RoomFrom}->{d.RoomTo}) center=({d.Center[0]:F2},{d.Center[1]:F2},{d.Center[2]:F2}) normal=({d.Normal[0]:F3},{d.Normal[1]:F3}) bottom={d.Bottom:F2} w={d.Width:F2} h={d.Height:F2}");
        Assert.All(geo.Doors, d =>
        {
            Assert.Equal(0, d.M);
            Assert.Equal(0f, d.Normal[2]);
            Assert.InRange(MathF.Sqrt(d.Normal[0] * d.Normal[0] + d.Normal[1] * d.Normal[1]), 0.999f, 1.001f);
            Assert.Equal(4, d.Corners.Length);
        });
        Assert.InRange(mlo.Entrance, 0, geo.Doors.Count - 1);
        var e = geo.Doors[mlo.Entrance];
        Assert.True(e.Outside, $"{name}: the entrance is a door to the outside");
        Assert.InRange(e.Bottom, z - 1 - 3, z - 1 + 3);
        output.WriteLine($"{name}: entrance = {e.Model} bottom {e.Bottom:F2}, spawn z - 1 = {z - 1:F2}");
    }

    [Fact]
    public void A_portal_becomes_a_door_in_world_space()
    {
        // A door 1 m wide and 2 m tall in the plane x = 1 of the MLO's space (the MLO's normal
        // faces +x), the room behind it at x = 5. The instance is turned 90 degrees about z
        // (x -> y) and put at (100, 200, 10): the door ends up in the plane y = 201, facing +y.
        var local = new[]
        {
            new SharpDX.Vector3(1, -0.5f, 0), new SharpDX.Vector3(1, 0.5f, 0),
            new SharpDX.Vector3(1, 0.5f, 2), new SharpDX.Vector3(1, -0.5f, 2),
        };
        var q = SharpDX.Quaternion.RotationAxis(SharpDX.Vector3.UnitZ, MathF.PI / 2);
        var pos = new SharpDX.Vector3(100, 200, 10);
        var world = WorldIndex.ToWorld(local, q, pos);
        var inside = SharpDX.Vector3.Transform(new SharpDX.Vector3(5, 0, 1), q) + pos;
        var d = WorldIndex.PortalToWorld(world, inside, true, "limbo", "hall", "hall", "v_ilev_door");
        Assert.NotNull(d);
        Assert.Equal(100f, d.Center[0], 3);
        Assert.Equal(201f, d.Center[1], 3);
        Assert.Equal(11f, d.Center[2], 3);
        Assert.Equal(0f, d.Normal[0], 3);
        Assert.Equal(1f, d.Normal[1], 3);
        Assert.Equal(0f, d.Normal[2]);
        Assert.Equal(10f, d.Bottom, 3);
        Assert.Equal(1f, d.Width, 3);
        Assert.Equal(2f, d.Height, 3);
        // The room on the other side flips the normal.
        var behind = SharpDX.Vector3.Transform(new SharpDX.Vector3(-5, 0, 1), q) + pos;
        var back = WorldIndex.PortalToWorld(world, behind, true, "hall", "limbo", "hall", "v_ilev_door");
        Assert.Equal(-1f, back.Normal[1], 3);
        // A portal lying flat has no side to face.
        var flat = new[] { new SharpDX.Vector3(0, 0, 0), new SharpDX.Vector3(1, 0, 0), new SharpDX.Vector3(1, 1, 0), new SharpDX.Vector3(0, 1, 0) };
        Assert.Null(WorldIndex.PortalToWorld(flat, SharpDX.Vector3.Zero, false, "a", "b", "b", "hatch_door"));
    }

    [Fact]
    public void The_entrance_is_the_nearest_outside_door()
    {
        DoorPortal D(bool outside, float x) => new(0, "door", outside, "r", "a", "b", new[] { x, 0f, 0f }, new[] { 0f, 1f, 0f }, 0, 1, 2, null);
        var doors = new[] { D(false, 0.5f), D(true, 10), D(true, 4), D(true, -30) };
        Assert.Equal(2, WorldIndex.PickEntrance(doors, 0, 0, 0, 0));
        Assert.Equal(3, WorldIndex.PickEntrance(doors, 3, 0, 0, 0));
        Assert.Equal(-1, WorldIndex.PickEntrance(new[] { D(false, 1) }, 0, 0, 0, 0));
    }
    [GameFact]
    public void Outside_every_room_the_nearest_interior_is_returned()
    {
        // Under the studio's floor: no room, but the studio is the nearest.
        var geo = fixture.Game.World.InteriorsNear(261.4586f, -998.8196f, -140, onlyContains: true);
        var mlo = Assert.Single(geo.Mlos);
        Assert.False(mlo.Contains);
        Assert.All(geo.Entities, e => Assert.Equal(0, e.m));
    }

    [GameFact]
    public void Nothing_in_the_open_air_far_from_interiors()
    {
        // The open sea in the south west.
        var geo = fixture.Game.World.InteriorsNear(-5000, -5000, 0);
        Assert.True(geo.Entities.Count == 0, string.Join(", ", geo.Mlos.Select(m => m.Name + " " + m.Entities)));
    }
}

public sealed class GameTheoryAttribute : TheoryAttribute
{
    public GameTheoryAttribute()
    {
        if (string.IsNullOrEmpty(GameFactAttribute.Dir)) Skip = "GOMP_GTA_DIR не задан: тесты с файлами игры пропущены";
    }
}

// Garage interiors, garage points and the references to them.
public sealed class HousesGarageTests
{
    private const string Sample = """
        {
          "format": "gomp-houses",
          "version": 1,
          "interiors": [ { "id": "studio", "name": "S", "spawn": [0, 0, 0], "exit": [1, 1, 0], "props": [] } ],
          "garages": [
            {
              "id": "garage2", "name": "Гараж на 2", "spawn": [177, -1006.3, -99], "heading": 90, "exit": [179.02, -1005.35, -99],
              "note": "g",
              "slots": [
                { "pos": [171.4, -1004, -99], "heading": 180, "lane": 1 },
                { "pos": [175.2, -1004, -99], "heading": 180 }
              ]
            }
          ],
          "classes": [ { "id": "econom", "name": "E", "garage": 2, "interior": "studio", "garageInterior": "garage2" } ],
          "houses": [
            { "id": 1, "name": "H", "cls": "econom", "price": 100, "door": [100, 100, 30], "heading": 0,
              "garagePoint": { "pos": [110, 100, 30.5], "heading": 21, "mark": true } },
            { "id": 2, "name": "H2", "cls": "econom", "price": 100, "door": [200, 100, 30], "heading": 0 }
          ]
        }
        """;

    private static HousesDocument Good() => HousesDocument.Parse(Sample);

    private static List<MapIssue> Errors(HousesDocument d) =>
        HousesValidator.Check(d).Where(i => i.Severity == Severity.Error).ToList();

    private static List<MapIssue> Warnings(HousesDocument d) =>
        HousesValidator.Check(d).Where(i => i.Severity == Severity.Warning).ToList();

    private static void HasError(HousesDocument d, string message) =>
        Assert.Contains(Errors(d), i => i.Message == message);

    private static void HasWarning(HousesDocument d, string message) =>
        Assert.Contains(Warnings(d), i => i.Message == message);

    [Fact]
    public void Garages_and_unknown_fields_survive_a_round_trip()
    {
        var doc = Good();
        string text = doc.ToJson();
        Assert.Contains("\"note\": \"g\"", text);
        Assert.Contains("\"lane\": 1", text);
        Assert.Contains("\"mark\": true", text);
        Assert.Contains("-1006.3", text);
        Assert.Contains("\"garageInterior\": \"garage2\"", text);
        // garages sits between interiors and classes.
        Assert.True(text.IndexOf("\"interiors\"") < text.IndexOf("\"garages\""));
        Assert.True(text.IndexOf("\"garages\"") < text.IndexOf("\"classes\""));
        var again = HousesDocument.Parse(text);
        Assert.Equal(21, again.Houses[0].GaragePoint.Heading);
        Assert.Equal(2, again.Garages[0].Slots.Count);
        Assert.Null(again.Houses[1].GaragePoint);
        Assert.Equal(text, again.ToJson());
    }

    [Fact]
    public void A_document_without_garages_writes_none()
    {
        var doc = HousesDocument.Parse("""
            { "format": "gomp-houses", "version": 1,
              "interiors": [ { "id": "studio", "name": "S", "spawn": [0, 0, 0], "exit": [1, 1, 0], "props": [] } ],
              "classes": [ { "id": "econom", "name": "E", "garage": 2, "interior": "studio" } ],
              "houses": [ { "id": 1, "name": "H", "cls": "econom", "price": 100, "door": [100, 100, 30], "heading": 0 } ] }
            """);
        Assert.Null(doc.Garages);
        Assert.Null(doc.Classes[0].GarageInterior);
        Assert.Null(doc.Houses[0].GarageInterior);
        Assert.Null(doc.Houses[0].GaragePoint);
        string text = doc.ToJson();
        Assert.DoesNotContain("garages", text);
        Assert.DoesNotContain("garageInterior", text);
        Assert.DoesNotContain("garagePoint", text);
        Assert.Equal(text, HousesDocument.Parse(text).ToJson());
        // An explicit empty list stays written.
        doc.Garages = new();
        Assert.Contains("\"garages\": []", doc.ToJson());
    }

    [Fact]
    public void A_good_garage_document_has_no_errors_and_only_the_missing_entrance_warning()
    {
        Assert.Empty(Errors(Good()));
        Assert.Equal("дом 2: нет метки въезда в гараж — машины заезжают у двери", Assert.Single(Warnings(Good())).Message);
    }

    [Theory]
    [InlineData("Garage")]
    [InlineData("")]
    [InlineData("a b")]
    public void Garage_ids_follow_the_server_pattern(string id)
    {
        var d = Good();
        d.Garages[0].Id = id;
        HasError(d, "гараж: id — a-z, 0-9, _, - (до 32)");
    }

    [Fact]
    public void Garage_rules()
    {
        var d = Good();
        d.Garages.Add(new GarageTemplate { Id = "garage2", Name = "again", Slots = { new GarageSlot() } });
        HasError(d, "гараж garage2: повторяется id");

        d = Good();
        d.Garages[0].Name = " ";
        HasError(d, "гараж garage2: нет названия");

        d = Good();
        d.Garages[0].Spawn = new double[] { 1, 2 };
        HasError(d, "гараж garage2: spawn — три числа");
        d = Good();
        d.Garages[0].Exit = new[] { 1, double.NaN, 3 };
        HasError(d, "гараж garage2: exit — три числа");
        d = Good();
        d.Garages[0].Heading = double.PositiveInfinity;
        HasError(d, "гараж garage2: heading — число");

        d = Good();
        d.Garages[0].Slots.Clear();
        HasError(d, "гараж garage2: нет ни одного места для машины");

        d = Good();
        d.Garages[0].Slots = Enumerable.Range(0, 51).Select(i => new GarageSlot { Pos = new double[] { 177 + i * 3, -1006, -99 } }).ToList();
        HasError(d, "гараж garage2: больше 50 мест");
        d.Garages[0].Slots.RemoveAt(50);
        Assert.DoesNotContain(Errors(d), i => i.Message.Contains("больше"));

        d = Good();
        d.Garages[0].Slots[1].Pos = null;
        HasError(d, "гараж garage2, место 2: pos — три числа");
        d = Good();
        d.Garages[0].Slots[0].Heading = double.NaN;
        HasError(d, "гараж garage2, место 1: heading — число");
    }

    [Fact]
    public void Garage_warnings()
    {
        var d = Good();
        d.Garages[0].Exit = new double[] { 177, -1006.3 + 30, -99 };
        HasWarning(d, "гараж garage2: выход далеко от точки появления");

        d = Good();
        d.Garages[0].Slots[1].Pos = new double[] { 172.4, -1004.5, -90 };   // 1.1 m apart on the ground, far apart in z
        HasWarning(d, "гараж garage2: места 1 и 2 ближе 2,5 м");

        d = Good();
        d.Garages[0].Slots[1].Pos = new double[] { 177 + 41, -1006.3, -99 };
        HasWarning(d, "гараж garage2, место 2: дальше 40 м от точки появления");

        d = Good();
        d.Classes[0].GarageInterior = null;
        HasWarning(d, "гараж garage2: не используется ни классом, ни домом");
        // No template resolves for house 2 any more: no entrance warning either.
        Assert.DoesNotContain(Warnings(d), i => i.Message.Contains("нет метки въезда"));

        // A house's own template counts as used and resolves for the entrance warning.
        d.Houses[1].GarageInterior = "garage2";
        Assert.DoesNotContain(Warnings(d), i => i.Message.Contains("не используется"));
        HasWarning(d, "дом 2: нет метки въезда в гараж — машины заезжают у двери");
    }

    [Fact]
    public void References_to_unknown_garages()
    {
        var d = Good();
        d.Classes[0].GarageInterior = "nope";
        HasError(d, "класс econom: нет гаража nope");
        d = Good();
        d.Houses[1].GarageInterior = "nope";
        HasError(d, "дом 2: нет гаража nope");
        // A document without a garage list can't refer to one either.
        d = Good();
        d.Garages = null;
        HasError(d, "класс econom: нет гаража garage2");
    }

    [Fact]
    public void Garage_point_rules()
    {
        var d = Good();
        d.Houses[0].GaragePoint.Pos = new double[] { 1, 2 };
        HasError(d, "дом 1: garagePoint — три числа");
        d = Good();
        d.Houses[0].GaragePoint.Heading = double.NaN;
        HasError(d, "дом 1: garagePoint heading — число");

        d = Good();
        d.Houses[0].GaragePoint.Pos = new double[] { 100 + 61, 100, 30 };
        HasWarning(d, "дом 1: въезд в гараж дальше 60 м от двери");
        d = Good();
        d.Houses[0].GaragePoint.Pos = new double[] { 110, 100, -60 };
        HasWarning(d, "дом 1: въезд в гараж ниже z = -50 (под картой?)");
    }

    [Fact]
    public void A_class_with_a_smaller_garage_warns_about_the_capacity()
    {
        var d = Good();
        d.Classes[0].Garage = 6;
        HasWarning(d, "класс econom: в гараже garage2 мест 2, меньше чем 6 — вместимость 2");
        d.Classes[0].Garage = 2;
        Assert.DoesNotContain(Warnings(d), i => i.Message.Contains("вместимость"));
    }

    [Fact]
    public void The_real_file_has_three_garages_and_a_garage_point_for_every_house()
    {
        string dir = RealServerFiles.Dir();
        if (dir == null) return;
        var doc = new HousesStore(dir).Load();
        Assert.Empty(Errors(doc));
        Assert.NotNull(doc.Garages);
        Assert.Equal(3, doc.Garages.Count);
        Assert.All(doc.Classes, c => Assert.NotNull(c.GarageInterior));
        Assert.All(doc.Houses, h => Assert.True(h.GaragePoint != null, $"дом {h.Id}: нет garagePoint"));
        Assert.DoesNotContain(Warnings(doc), i => i.Message.Contains("гараж"));
    }
}
