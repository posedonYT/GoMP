using GoMP.Studio.Game;
using GoMP.Studio.Maps;
using Xunit.Abstractions;

namespace GoMP.Studio.Tests;

// Tests with the files of GTA V: GOMP_GTA_DIR=<the game folder> dotnet test ...
public sealed class GameFactAttribute : FactAttribute
{
    public static string Dir => Environment.GetEnvironmentVariable("GOMP_GTA_DIR");

    public GameFactAttribute()
    {
        if (string.IsNullOrEmpty(Dir)) Skip = "GOMP_GTA_DIR не задан: тесты с файлами игры пропущены";
    }
}

// The game is loaded once for all these tests (it takes a while).
public sealed class GameFixture
{
    private readonly Lazy<GameData> game = new(() =>
    {
        var g = new GameData(GameFactAttribute.Dir);
        g.StartLoading().Wait();
        return g;
    });

    public GameData Game => game.Value;
}

[CollectionDefinition("game")]
public sealed class GameCollection : ICollectionFixture<GameFixture>
{
}

[Collection("game")]
public sealed class GameTests
{
    private readonly GameFixture fixture;

    private readonly ITestOutputHelper output;

    public GameTests(GameFixture fixture, ITestOutputHelper output)
    {
        this.fixture = fixture;
        this.output = output;
    }

    [GameFact]
    public void Loads_the_game_and_knows_its_props()
    {
        var g = fixture.Game;
        Assert.Equal(GameState.Ready, g.State);
        var bench = g.Get(Joaat.Hash("prop_bench_01a"));
        Assert.NotNull(bench);
        Assert.Equal("prop_bench_01a", bench.Name);
        Assert.Equal("model", bench.Kind);
        // A bench: about two metres long, under a metre and a half high.
        float length = Math.Max(bench.BBMax[0] - bench.BBMin[0], bench.BBMax[1] - bench.BBMin[1]);
        Assert.InRange(length, 1f, 4f);
        Assert.InRange(bench.BBMax[2] - bench.BBMin[2], 0.3f, 1.5f);
    }

    // Linux and macOS scan the archives with GameArchives (CodeWalker's scan finds
    // no update and no DLCs there). On Windows it must find what CodeWalker finds.
    [GameFact]
    public void The_archive_scan_finds_the_update_and_the_dlcs()
    {
        var a = fixture.Game.Cache;
        Assert.True(a.RpfMan.RpfDict.ContainsKey(@"update\update.rpf"));  // (AllRpfs may have its copy in mods)
        Assert.True(a.DlcNameList.Count > 50, $"{a.DlcNameList.Count} DLCs");
        Assert.Equal(@"update\x64\dlcpacks\mpbeach\dlc.rpf",
                     GameArchives.ArchiveName(Path.Combine("x", "gta"), Path.Combine("x", "gta", "update", "x64", "dlcpacks", "mpBeach", "dlc.rpf")));
        if (!OperatingSystem.IsWindows()) return;  // the fixture already used it

        var own = new GameData(GameFactAttribute.Dir) { OwnScan = true };
        own.StartLoading().Wait();
        Assert.Equal(GameState.Ready, own.State);
        var b = own.Cache;
        Assert.Equal(a.RpfMan.AllRpfs.Select(r => r.Path).Order(), b.RpfMan.AllRpfs.Select(r => r.Path).Order());
        Assert.Equal(a.AllRpfs.Count, b.AllRpfs.Count);
        Assert.Equal(a.DlcNameList, b.DlcNameList);
        Assert.Equal(a.DlcActiveRpfs.Count, b.DlcActiveRpfs.Count);
        Assert.Equal(a.YmapDict.Count, b.YmapDict.Count);
        Assert.Equal(a.YtypDict.Count, b.YtypDict.Count);
        Assert.NotNull(own.Get(Joaat.Hash("prop_bench_01a")));
    }

    [GameFact]
    public void Search_finds_props_first()
    {
        var found = fixture.Game.Search("bench 01a", 20);
        Assert.Contains(found, a => a.Name == "prop_bench_01a");
        // The ytyp name is searched too (its models match last), so only the best hits must have the word in the name.
        Assert.Contains("bench", found[0].Name);
        Assert.StartsWith("prop_", found[0].Name);
        Assert.DoesNotContain(fixture.Game.Search("", 500), a => a.Kind == "interior");
    }

    [GameFact]
    public void The_catalog_finds_gates_and_fences_and_knows_its_categories()
    {
        var g = fixture.Game;
        var gates = g.Search("gate", null, 0, 200, false);
        Assert.True(gates.Total > 300, $"gate: {gates.Total}");
        Assert.Contains(gates.Items, a => a.Name == "prop_gate_airport_01");

        var fences = g.Search("", "fences", 0, 500, false);
        Assert.Contains(fences.Items, a => a.Name == "prop_facgate_01");
        Assert.Contains(fences.Items, a => a.Name == "prop_fncwood_01a");

        var bench = g.Get(Joaat.Hash("prop_bench_01a"));
        var byHash = g.Search("0x" + bench.Hash.ToString("X8"), null, 0, 10, false);
        Assert.Equal(new[] { bench }, byHash.Items);

        var index = g.Catalog;
        output.WriteLine($"named {index.NamedCount}, unnamed {index.UnnamedCount}");
        for (int i = 0; i < CatalogSearch.Categories.Count; i++)
            output.WriteLine($"{CatalogSearch.Categories[i].Id}: {index.CategoryCounts[i]}");
        var watch = System.Diagnostics.Stopwatch.StartNew();
        foreach (var q in new[] { "gate", "wall", "fnc", "bench 01a", "e" }) g.Search(q, null, 0, 200, false);
        output.WriteLine($"5 searches: {watch.ElapsedMilliseconds} ms");
    }
}
