using GoMP.Studio.Geometry;

namespace GoMP.Studio.Tests;

public class RotationTests
{
    private static void Same(Quat a, Quat b) => Assert.True(a.SameRotation(b, 1e-6), $"{a} != {b}");

    [Fact]
    public void Yaw_turns_about_the_vertical_axis()
    {
        Same(Quat.Axis(0, 0, 1, Math.PI / 2), GtaRotation.ToQuat(0, 0, 90));
        // Heading 90: the front (+Y) looks to the west (-X), as in GTA.
        var m = GtaRotation.ToQuat(0, 0, 90).Matrix();
        Assert.Equal(-1, m[0, 1], 9);
        Assert.Equal(0, m[1, 1], 9);
    }

    [Fact]
    public void Order_is_y_then_x_then_z()
    {
        // Rz * Rx * Ry: the object is first turned about Y, then X, then Z (world axes).
        var expected = Quat.Axis(0, 0, 1, 0.1) * Quat.Axis(1, 0, 0, 0.2) * Quat.Axis(0, 1, 0, 0.3);
        Same(expected, GtaRotation.ToQuat(0.2 * 180 / Math.PI, 0.3 * 180 / Math.PI, 0.1 * 180 / Math.PI));
    }

    [Fact]
    public void Back_and_forth_gives_the_same_angles()
    {
        var rnd = new Random(1);
        for (int i = 0; i < 2000; i++)
        {
            double x = rnd.NextDouble() * 178 - 89, y = rnd.NextDouble() * 358 - 179, z = rnd.NextDouble() * 358 - 179;
            var (ax, ay, az) = GtaRotation.FromQuat(GtaRotation.ToQuat(x, y, z));
            Assert.Equal(x, ax, 1e-6);
            Assert.Equal(y, ay, 1e-6);
            Assert.Equal(z, az, 1e-6);
        }
    }

    [Fact]
    public void Straight_up_keeps_the_rotation()
    {
        foreach (double x in new double[] { 90, -90 })
        {
            var q = GtaRotation.ToQuat(x, 30, 40);
            var (ax, ay, az) = GtaRotation.FromQuat(q);
            Assert.Equal(x, ax, 6);
            Assert.Equal(0, ay);
            Same(q, GtaRotation.ToQuat(ax, ay, az));
        }
    }

    // What GTA V itself gives for these angles (tools/studio/testdata/rotations.json).
    [Fact]
    public void Same_as_the_game()
    {
        using var json = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "testdata", "rotations.json")));
        int n = 0;
        foreach (var r in json.RootElement.GetProperty("rotations").EnumerateArray())
        {
            double[] V(string k) => r.GetProperty(k).EnumerateArray().Select(e => e.GetDouble()).ToArray();
            var a = V("angles");
            var q = GtaRotation.ToQuat(a[0], a[1], a[2]);
            var m = q.Matrix();
            string[] axes = { "right", "forward", "up" };
            for (int c = 0; c < 3; c++)
                for (int row = 0; row < 3; row++)
                    Assert.Equal(V(axes[c])[row], m[row, c], 1e-4);
            var gq = V("quat");
            Assert.True(q.SameRotation(new Quat(gq[0], gq[1], gq[2], gq[3]), 1e-5), string.Join(",", a));
            var (x, y, z) = GtaRotation.FromQuat(q);
            Assert.Equal(a[0], x, 1e-4);
            Assert.Equal(a[1], y, 1e-4);
            Assert.Equal(a[2], z, 1e-4);
            n++;
        }
        Assert.True(n >= 8);
    }

    [Fact]
    public void Angles_wrap_to_the_game_range()
    {
        var (_, _, z) = GtaRotation.FromQuat(GtaRotation.ToQuat(0, 0, 270));
        Assert.Equal(-90, z, 6);
        var (_, _, z2) = GtaRotation.FromQuat(GtaRotation.ToQuat(0, 0, -180));
        Assert.Equal(180, z2, 6);
    }
}
