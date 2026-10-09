using System.Diagnostics;
using GoMP.Studio.Export;
using GoMP.Studio.Game;
using Xunit.Abstractions;

namespace GoMP.Studio.Tests;

[Collection("game")]
public sealed class WorldTests
{
    private readonly GameFixture fixture;
    private readonly ITestOutputHelper output;

    public WorldTests(GameFixture fixture, ITestOutputHelper output)
    {
        this.fixture = fixture;
        this.output = output;
    }

    [GameFact]
    public void Legion_square_has_the_city_around_it()
    {
        var world = fixture.Game.World;
        Assert.True(world.YmapCount > 1000, $"{world.YmapCount} map data files");
        int cx = WorldIndex.Cell(195), cy = WorldIndex.Cell(-930);
        var sw = Stopwatch.StartNew();
        var ents = world.Entities(cx, cy);
        output.WriteLine($"cell {cx},{cy}: {ents.Count} entities in {sw.ElapsedMilliseconds} ms");
        Assert.True(ents.Count > 100, $"{ents.Count} entities");
        Assert.All(ents, e =>
        {
            Assert.InRange(e.p[0], cx * WorldIndex.CellSize, (cx + 1) * WorldIndex.CellSize);
            Assert.InRange(e.p[1], cy * WorldIndex.CellSize, (cy + 1) * WorldIndex.CellSize);
            float qn = MathF.Sqrt(e.q.Sum(v => v * v));
            Assert.InRange(qn, 0.99f, 1.01f);
            Assert.True(e.d > 0);
        });
        Assert.Contains(ents, e => e.l == 0);         // detailed
        Assert.Contains(ents, e => e.l is 1 or 2);    // their low-detail stand-ins
        Assert.Same(ents, world.Entities(cx, cy));    // kept

        // What the browser will ask for: how long models take to export.
        var sample = ents.Where(e => e.l == 0).Select(e => e.a).Distinct().Take(30).ToList();
        sw.Restart();
        int ok = 0;
        Parallel.ForEach(sample, h => { if (fixture.Game.Exporter.Export(h, Lod.High, 128) != null) Interlocked.Increment(ref ok); });
        output.WriteLine($"{ok} of {sample.Count} models exported in {sw.ElapsedMilliseconds} ms");
        Assert.True(ok >= sample.Count * 0.8, $"{ok} of {sample.Count}");
    }

    [GameFact]
    public void The_ocean_far_away_has_nothing()
    {
        Assert.Empty(fixture.Game.World.Entities(WorldIndex.Cell(-9000), WorldIndex.Cell(-9000)));
    }
}
