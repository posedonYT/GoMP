// A minimal PNG writer (8-bit RGBA, no filtering, zlib), so textures can go
// into glTF files on every system without an image library.
using System.IO.Compression;

namespace GoMP.Studio.Export;

public static class PngEncoder
{
    private static readonly uint[] CrcTable = MakeCrcTable();

    // rgba: width * height * 4 bytes, rows from the top.
    public static byte[] Encode(byte[] rgba, int width, int height)
    {
        if (width <= 0 || height <= 0 || rgba.Length < width * height * 4) throw new ArgumentException("not an RGBA image of that size");
        using var ms = new MemoryStream();
        ms.Write(new byte[] { 0x89, (byte)'P', (byte)'N', (byte)'G', 0x0D, 0x0A, 0x1A, 0x0A });

        var ihdr = new byte[13];
        WriteBE(ihdr, 0, (uint)width);
        WriteBE(ihdr, 4, (uint)height);
        ihdr[8] = 8;   // bit depth
        ihdr[9] = 6;   // colour type: RGBA
        Chunk(ms, "IHDR", ihdr);

        using (var raw = new MemoryStream())
        {
            using (var z = new ZLibStream(raw, CompressionLevel.Fastest, leaveOpen: true))
            {
                int stride = width * 4;
                for (int y = 0; y < height; y++)
                {
                    z.WriteByte(0);  // filter: none
                    z.Write(rgba, y * stride, stride);
                }
            }
            Chunk(ms, "IDAT", raw.ToArray());
        }
        Chunk(ms, "IEND", Array.Empty<byte>());
        return ms.ToArray();
    }

    private static void Chunk(Stream s, string type, byte[] data)
    {
        var len = new byte[4];
        WriteBE(len, 0, (uint)data.Length);
        s.Write(len);
        var typeBytes = System.Text.Encoding.ASCII.GetBytes(type);
        s.Write(typeBytes);
        s.Write(data);
        uint crc = Crc(Crc(0xFFFFFFFF, typeBytes), data) ^ 0xFFFFFFFF;
        var c = new byte[4];
        WriteBE(c, 0, crc);
        s.Write(c);
    }

    private static void WriteBE(byte[] b, int at, uint v)
    {
        b[at] = (byte)(v >> 24);
        b[at + 1] = (byte)(v >> 16);
        b[at + 2] = (byte)(v >> 8);
        b[at + 3] = (byte)v;
    }

    public static uint Crc(uint crc, byte[] data)
    {
        foreach (byte b in data) crc = CrcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
        return crc;
    }

    private static uint[] MakeCrcTable()
    {
        var t = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            uint c = n;
            for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
            t[n] = c;
        }
        return t;
    }
}
