using GoMP.Studio.Maps;

namespace GoMP.Studio.Tests;

public class MapDocumentTests
{
    [Fact]
    public void Joaat_matches_the_game()
    {
        Assert.Equal(0xB779A091u, Joaat.Hash("adder"));
        Assert.Equal(Joaat.Hash("adder"), Joaat.Hash("ADDER"));
    }

    [Fact]
    public void Round_trip_keeps_names_hashes_and_unknown_fields()
    {
        const string json = """
            { "format": "gomp-map", "version": 1, "name": "Площадь", "enabled": false, "author": "admin",
              "objects": [
                { "id": "a", "model": "Prop_Bench_01a", "pos": [1.5, -2, 3], "rot": [0, 0, 90], "group": "лавки", "note": 7 },
                { "id": "b", "model": 3078201489, "pos": [0, 0, 0], "rot": [0, 0, 0], "dimension": 5, "alpha": 100 } ] }
            """;
        var doc = MapDocument.Parse(json);
        Assert.Equal("Площадь", doc.Name);
        Assert.False(doc.Enabled);
        Assert.Equal("prop_bench_01a", doc.Objects[0].Model.Name);
        Assert.Equal(Joaat.Hash("prop_bench_01a"), doc.Objects[0].Model.Hash);
        Assert.Null(doc.Objects[1].Model.Name);
        Assert.Equal(0xB779A091u, doc.Objects[1].Model.Hash);
        Assert.Equal(5u, doc.Objects[1].Dimension);

        var again = MapDocument.Parse(doc.ToJson());
        Assert.Equal("admin", again.Extra["author"].GetString());
        Assert.Equal(7, again.Objects[0].Extra["note"].GetInt32());
        Assert.Equal("лавки", again.Objects[0].Group);
        Assert.Contains("\"model\": 3078201489", doc.ToJson());
        Assert.Contains("Площадь", doc.ToJson());  // Cyrillic stays readable
        Assert.DoesNotContain("\"group\": null", doc.ToJson());
    }

    [Fact]
    public void Defaults_of_a_new_object()
    {
        var o = MapDocument.Parse("""{ "objects": [ { "id": "x", "model": "prop_bin_01a", "pos": [1, 2, 3] } ] }""").Objects[0];
        Assert.Equal(new double[] { 0, 0, 0 }, o.Rot);
        Assert.Equal(255, o.Alpha);
        Assert.Equal(0u, o.Dimension);
    }

    [Theory]
    [InlineData("""{ "objects": [ { "id": "x", "model": true, "pos": [1, 2, 3] } ] }""")]
    [InlineData("""{ "objects": [ { "id": "x", "model": "a", "pos": [1, "2", 3] } ] }""")]
    [InlineData("[]")]
    public void Not_a_map(string json) => Assert.ThrowsAny<System.Text.Json.JsonException>(() => MapDocument.Parse(json));
}

public class MapValidatorTests
{
    private static MapObject Obj(string id, double x = 0, string model = "prop_bench_01a") =>
        new() { Id = id, Model = ModelRef.Of(model), Pos = new[] { x, 0, 30 } };

    [Fact]
    public void A_good_map_has_no_problems()
    {
        var doc = new MapDocument { Objects = { Obj("a"), Obj("b", 5) } };
        Assert.Empty(MapValidator.Check(doc, _ => true));
    }

    [Fact]
    public void Errors_are_what_the_server_refuses()
    {
        var doc = new MapDocument
        {
            Version = 2,
            Objects =
            {
                Obj("a"), Obj("a"), Obj(""), new MapObject { Id = "nomodel", Pos = new double[] { 0, 0, 0 } },
                new MapObject { Id = "nan", Model = ModelRef.Of("x"), Pos = new[] { double.NaN, 0, 0 } },
                new MapObject { Id = "short", Model = ModelRef.Of("x"), Pos = new double[] { 0, 0 } },
                new MapObject { Id = "alpha", Model = ModelRef.Of("x"), Alpha = 300 },
            },
        };
        var issues = MapValidator.Check(doc);
        Assert.True(MapValidator.HasErrors(issues));
        string all = string.Join("; ", issues.Select(i => $"{i.ObjectId}: {i.Message}"));
        Assert.Contains("версия 2", all);
        Assert.Contains("a: id повторяется", all);
        Assert.Contains("объект без id", all);
        Assert.Contains("nomodel: нет модели", all);
        Assert.Contains("nan: pos", all);
        Assert.Contains("short: pos", all);
        Assert.Contains("alpha: alpha", all);
    }

    [Fact]
    public void Too_many_objects()
    {
        var doc = new MapDocument();
        for (int i = 0; i <= MapDocument.MaxObjects; i++) doc.Objects.Add(Obj("o" + i));
        Assert.Contains(MapValidator.Check(doc), i => i.Severity == Severity.Error && i.Message.Contains("5000"));
    }

    [Fact]
    public void Warnings_do_not_stop_saving()
    {
        var doc = new MapDocument { Objects = { Obj("far", 20000), Obj("unknown", 0, "no_such_prop") } };
        var issues = MapValidator.Check(doc, h => h != Joaat.Hash("no_such_prop"));
        Assert.False(MapValidator.HasErrors(issues));
        Assert.Contains(issues, i => i.ObjectId == "far" && i.Message.Contains("краем"));
        Assert.Contains(issues, i => i.ObjectId == "unknown" && i.Message.Contains("no_such_prop"));
    }
}

public sealed class MapStoreTests : IDisposable
{
    private readonly string dir = Path.Combine(Path.GetTempPath(), "gomp-studio-" + Guid.NewGuid().ToString("N"));
    private readonly MapStore store;

    public MapStoreTests() => store = new MapStore(dir);

    public void Dispose() => Directory.Delete(dir, true);

    [Fact]
    public void Save_list_load_rename_delete()
    {
        var doc = new MapDocument { Name = "Тест", Objects = { new MapObject { Id = "a", Model = ModelRef.Of("prop_bin_01a") } } };
        store.Save("Площадь_1", doc);
        Assert.True(store.Exists("Площадь_1"));
        Assert.Empty(Directory.GetFiles(dir, "*.tmp"));
        var info = Assert.Single(store.List());
        Assert.Equal(("Площадь_1", "Тест", 1, true), (info.Name, info.Title, info.Objects, info.Enabled));
        Assert.Equal("prop_bin_01a", store.Load("Площадь_1").Objects[0].Model.Name);

        store.Rename("Площадь_1", "square");
        Assert.False(store.Exists("Площадь_1"));
        store.Save("other", doc);
        Assert.Throws<IOException>(() => store.Rename("square", "other"));
        store.Delete("square");
        Assert.Equal(new[] { "other" }, store.List().Select(m => m.Name));
    }

    [Theory]
    [InlineData("../evil")]
    [InlineData("a/b")]
    [InlineData("")]
    [InlineData(".cursor")]
    [InlineData("name with spaces")]
    public void Unsafe_names_are_refused(string name)
    {
        Assert.False(MapStore.ValidName(name));
        Assert.Throws<ArgumentException>(() => store.Save(name, new MapDocument()));
    }

    [Fact]
    public void Broken_files_are_listed_and_the_cursor_is_not_a_map()
    {
        File.WriteAllText(Path.Combine(dir, "broken.json"), "{ \"objects\": [");
        File.WriteAllText(Path.Combine(dir, MapStore.CursorFile), """{"x":1.5,"y":-2,"z":30,"heading":90,"dimension":0,"name":"Admin","at":123}""");
        var info = Assert.Single(store.List());
        Assert.Equal("broken", info.Name);
        Assert.False(info.Enabled);
        var c = store.ReadCursor();
        Assert.Equal((1.5, -2.0, 30.0, 90.0, "Admin", 123L), (c.X, c.Y, c.Z, c.Heading, c.Name, c.At));
    }
}
