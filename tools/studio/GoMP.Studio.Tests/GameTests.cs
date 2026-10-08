using GoMP.Studio.Game;
using GoMP.Studio.Maps;

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

    public GameTests(GameFixture fixture) => this.fixture = fixture;

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

    [GameFact]
    public void Search_finds_props_first()
    {
        var found = fixture.Game.Search("bench 01a", 20);
        Assert.Contains(found, a => a.Name == "prop_bench_01a");
        Assert.All(found, a => Assert.Contains("bench", a.Name));
        Assert.StartsWith("prop_", found[0].Name);
        Assert.DoesNotContain(fixture.Game.Search("", 500), a => a.Kind == "interior");
    }
}
