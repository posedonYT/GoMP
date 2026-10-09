// Reads positions, normals and the first texture coordinates out of GTA V vertex
// data. A vertex declaration has a bit per component (Flags: 0 position, 3 normal,
// 6 texcoord0...) and a 4-bit type per component (Types); components follow each
// other in bit order. Only plain numbers here: tested without game files.
namespace GoMP.Studio.Export;

public static class VertexDecoder
{
    public const int Position = 0, BlendWeights = 1, BlendIndices = 2, Normal = 3, TexCoord0 = 6;

    // Sizes of the component types (CodeWalker's VertexComponentType).
    public static int SizeOf(int type) => type switch
    {
        1 => 4,   // Half2
        2 => 4,   // Float
        3 => 8,   // Half4
        5 => 8,   // Float2
        6 => 12,  // Float3
        7 => 16,  // Float4
        8 => 4,   // UByte4
        9 => 4,   // Colour
        10 => 4,  // RGBA8SNorm
        _ => 0,
    };

    public static int TypeOf(ulong types, int component) => (int)((types >> (component * 4)) & 0xF);

    public static int OffsetOf(uint flags, ulong types, int component)
    {
        int offset = 0;
        for (int k = 0; k < component; k++)
            if (((flags >> k) & 1) != 0) offset += SizeOf(TypeOf(types, k));
        return offset;
    }

    public static bool Has(uint flags, int component) => ((flags >> component) & 1) != 0;

    // Up to four numbers of one component of one vertex.
    public static void Read(ReadOnlySpan<byte> v, int type, Span<float> out4)
    {
        out4.Clear();
        switch (type)
        {
            case 1:
                out4[0] = (float)BitConverter.ToHalf(v);
                out4[1] = (float)BitConverter.ToHalf(v[2..]);
                break;
            case 3:
                for (int i = 0; i < 4; i++) out4[i] = (float)BitConverter.ToHalf(v[(i * 2)..]);
                break;
            case 2:
            case 5:
            case 6:
            case 7:
                int n = type == 2 ? 1 : type - 3;
                for (int i = 0; i < n; i++) out4[i] = BitConverter.ToSingle(v[(i * 4)..]);
                break;
            case 8:
                for (int i = 0; i < 4; i++) out4[i] = v[i];
                break;
            case 9:
                for (int i = 0; i < 4; i++) out4[i] = v[i] / 255f * 2 - 1;
                break;
            case 10:
                for (int i = 0; i < 4; i++) out4[i] = Math.Max(-1f, (sbyte)v[i] / 127f);
                break;
        }
        for (int i = 0; i < 4; i++)
            if (!float.IsFinite(out4[i])) out4[i] = 0;
    }

    // Bones: for skinned vertices the blend index with the largest weight (else null).
    public sealed record Vertices(float[] Positions, float[] Normals, float[] Uvs, byte[] Bones = null);

    public static Vertices Decode(byte[] bytes, int count, int stride, uint flags, ulong types)
    {
        if (!Has(flags, Position)) throw new InvalidDataException("vertices without positions");
        count = Math.Min(count, stride > 0 ? bytes.Length / stride : 0);
        var pos = new float[count * 3];
        float[] nrm = Has(flags, Normal) ? new float[count * 3] : null;
        float[] uv = Has(flags, TexCoord0) ? new float[count * 2] : null;
        bool skinned = Has(flags, BlendWeights) && Has(flags, BlendIndices) &&
                       SizeOf(TypeOf(types, BlendWeights)) == 4 && SizeOf(TypeOf(types, BlendIndices)) == 4;
        byte[] bones = skinned ? new byte[count] : null;
        int wOff = OffsetOf(flags, types, BlendWeights), iOff = OffsetOf(flags, types, BlendIndices);
        int pOff = OffsetOf(flags, types, Position), nOff = OffsetOf(flags, types, Normal), tOff = OffsetOf(flags, types, TexCoord0);
        int pType = TypeOf(types, Position), nType = TypeOf(types, Normal), tType = TypeOf(types, TexCoord0);
        Span<float> tmp = stackalloc float[4];
        for (int i = 0; i < count; i++)
        {
            var v = bytes.AsSpan(i * stride, stride);
            Read(v[pOff..], pType, tmp);
            pos[i * 3] = tmp[0];
            pos[i * 3 + 1] = tmp[1];
            pos[i * 3 + 2] = tmp[2];
            if (nrm != null)
            {
                Read(v[nOff..], nType, tmp);
                float len = MathF.Sqrt(tmp[0] * tmp[0] + tmp[1] * tmp[1] + tmp[2] * tmp[2]);
                if (len < 1e-6f) { tmp[0] = 0; tmp[1] = 0; tmp[2] = 1; len = 1; }
                nrm[i * 3] = tmp[0] / len;
                nrm[i * 3 + 1] = tmp[1] / len;
                nrm[i * 3 + 2] = tmp[2] / len;
            }
            if (uv != null)
            {
                Read(v[tOff..], tType, tmp);
                uv[i * 2] = tmp[0];
                uv[i * 2 + 1] = tmp[1];
            }
            if (bones != null)
            {
                int best = 0;
                for (int k = 1; k < 4; k++)
                    if (v[wOff + k] > v[wOff + best]) best = k;
                bones[i] = v[iOff + best];
            }
        }
        return new Vertices(pos, nrm, uv, bones);
    }
}
