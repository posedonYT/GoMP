using GoMP.Studio.Game;
using Xunit.Abstractions;

namespace GoMP.Studio.Tests;

public sealed class RoadNodesPureTests
{
    [Theory]
    [InlineData(20, 0, 0)]       // heading 0 faces +y, its right hand is +x: the door in the east
    [InlineData(-20, 0, 180)]    // heading 180 faces -y, its right hand is -x: the door in the west
    public void Suggest_keeps_the_door_on_the_right(float doorX, float doorY, float expected)
    {
        var node = new RoadNode(0, 0, 10, new[] { 0f, 180f });
        var s = RoadNodes.Suggest(node, doorX, doorY);
        Assert.Equal(expected, s.Heading);
        Assert.Equal(11f, s.Z);   // ground + 1
        Assert.Equal(0f, s.X);
        Assert.Equal(0f, s.Y);
    }

    [Fact]
    public void Suggest_works_for_an_east_west_road_and_a_node_without_links()
    {
        // Heading 270 faces +x (direction (-sin, cos) = (1, 0)); its right hand is -y.
        var node = new RoadNode(5, 5, 0, new[] { 270f, 90f });
        Assert.Equal(270f, RoadNodes.Suggest(node, 5, -20).Heading);
        Assert.Equal(90f, RoadNodes.Suggest(node, 5, 30).Heading);
        Assert.Equal(0f, RoadNodes.Suggest(new RoadNode(1, 2, 3, Array.Empty<float>()), 9, 9).Heading);
    }

    [Fact]
    public void Nearest_sorts_by_distance_and_honours_radius_and_limit()
    {
        var none = Array.Empty<float>();
        var roads = new RoadNodes(new[]
        {
            new RoadNode(30, 0, 0, none), new RoadNode(10, 0, 0, none), new RoadNode(0, 4, 0, none), new RoadNode(200, 0, 0, none),
        });
        Assert.Equal(new[] { 4f, 10f, 30f }, roads.Nearest(0, 0, 0, 50).Select(h => h.Dist).ToArray());
        Assert.Single(roads.Nearest(0, 0, 0, 50, 1));
        Assert.Empty(roads.Nearest(0, 0, 0, 3));
        Assert.Empty(RoadNodes.Empty.Nearest(0, 0, 0, 100));
    }
}

[Collection("game")]
public sealed class RoadNodesGameTests
{
    private readonly GameFixture fixture;
    private readonly ITestOutputHelper output;

    public RoadNodesGameTests(GameFixture fixture, ITestOutputHelper output)
    {
        this.fixture = fixture;
        this.output = output;
    }

    [GameFact]
    public void House_12_door_gets_the_road_node_in_front_of_it()
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var roads = fixture.Game.Roads;
        output.WriteLine($"road nodes: {roads.Count} vehicle nodes, {roads.Links} links, loaded in {sw.ElapsedMilliseconds} ms");
        Assert.True(roads.Count > 10000);
        // The door of house 12, 3655 Wild Oats Drive.
        var hits = roads.Nearest(-176, 502.7f, 137.42f, 60);
        Assert.NotEmpty(hits);
        var n = hits[0].Node;
        output.WriteLine($"nearest {n.X},{n.Y},{n.Z} dist {hits[0].Dist:F1} headings {string.Join(",", n.Headings.Select(h => h.ToString("F0")))}");
        Assert.Equal(-180.0, n.X, 1);
        Assert.Equal(509.75, n.Y, 1);
        Assert.Equal(135.06, n.Z, 1);
        var s = RoadNodes.Suggest(n, -176, 502.7f);
        output.WriteLine($"suggest {s.X},{s.Y},{s.Z} heading {s.Heading:F1}");
        Assert.InRange(s.Heading, 282, 284);
        Assert.Equal(136.06, s.Z, 1);
    }
}
