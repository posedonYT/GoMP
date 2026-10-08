// Entity rotations as GTA V takes them: SET_ENTITY_ROTATION(x, y, z, rotationOrder 2)
// with degrees around the world axes (Z up). Order 2 is the matrix Rz(z) * Rx(x) * Ry(y):
// the entity turns about Y first, then X, then Z (three.js Euler order 'ZXY').
// Measured in the game: tools/studio/testdata/rotations.json holds the matrices and
// quaternions GTA V gives for such rotations (probe "rotation", client/game/probe.cpp).
namespace GoMP.Studio.Geometry;

public readonly record struct Quat(double X, double Y, double Z, double W)
{
    public static readonly Quat Identity = new(0, 0, 0, 1);

    public static Quat operator *(Quat a, Quat b) => new(
        a.W * b.X + a.X * b.W + a.Y * b.Z - a.Z * b.Y,
        a.W * b.Y - a.X * b.Z + a.Y * b.W + a.Z * b.X,
        a.W * b.Z + a.X * b.Y - a.Y * b.X + a.Z * b.W,
        a.W * b.W - a.X * b.X - a.Y * b.Y - a.Z * b.Z);

    public static Quat Axis(double x, double y, double z, double radians)
    {
        double s = Math.Sin(radians / 2);
        return new Quat(x * s, y * s, z * s, Math.Cos(radians / 2));
    }

    public Quat Normalized()
    {
        double n = Math.Sqrt(X * X + Y * Y + Z * Z + W * W);
        return n == 0 ? Identity : new Quat(X / n, Y / n, Z / n, W / n);
    }

    // The same rotation (q and -q): for comparisons.
    public bool SameRotation(Quat o, double eps = 1e-6) =>
        Math.Abs(Math.Abs(X * o.X + Y * o.Y + Z * o.Z + W * o.W) - 1) < eps;

    // Row-major 3x3 matrix.
    public double[,] Matrix()
    {
        var q = Normalized();
        double x = q.X, y = q.Y, z = q.Z, w = q.W;
        return new[,]
        {
            { 1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w) },
            { 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w) },
            { 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y) },
        };
    }
}

public static class GtaRotation
{
    private const double Deg = Math.PI / 180;

    // SET_ENTITY_ROTATION(x, y, z, 2) as a quaternion.
    public static Quat ToQuat(double x, double y, double z) =>
        (Quat.Axis(0, 0, 1, z * Deg) * Quat.Axis(1, 0, 0, x * Deg) * Quat.Axis(0, 1, 0, y * Deg)).Normalized();

    // GET_ENTITY_ROTATION(entity, 2) of a rotation: x in [-90, 90], y and z in (-180, 180].
    public static (double X, double Y, double Z) FromQuat(Quat q)
    {
        // Rz * Rx * Ry: m[2,1] = sin x, m[2,0] = -cos x sin y, m[2,2] = cos x cos y,
        // m[0,1] = -sin z cos x, m[1,1] = cos z cos x.
        var m = q.Matrix();
        double sx = Math.Clamp(m[2, 1], -1, 1);
        double x = Math.Asin(sx), y, z;
        if (Math.Abs(sx) < 0.9999999)
        {
            y = Math.Atan2(-m[2, 0], m[2, 2]);
            z = Math.Atan2(-m[0, 1], m[1, 1]);
        }
        else
        {
            // Pitch ±90: only y + z or y - z is defined; y is taken as 0.
            y = 0;
            z = Math.Atan2(m[1, 0], m[0, 0]);
        }
        return (Round(x / Deg), Round(y / Deg), Round(z / Deg));
    }

    private static double Round(double d)
    {
        double r = Math.Round(d, 9);
        return r == -180 ? 180 : r == 0 ? 0 : r;  // no -0, -180 is 180
    }
}
