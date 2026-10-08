// GTA V archives (RPF) for the GoMP tools, on top of CodeWalker.Core.
//
// The game's own archives are encrypted (NG): Keys.Load reads the keys from the
// game folder first. Add-on packs and the copies in the mods folder are OPEN
// archives, which need no keys and are the only ones that can be written.
using CodeWalker.GameFiles;

namespace GoMP.Gta;

public static class Keys
{
    private static readonly object Lock = new();
    private static string loadedFrom;

    // Reads the archive keys from GTA5.exe in the game folder (once per folder).
    public static void Load(string gameDir)
    {
        lock (Lock)
        {
            string full = Path.GetFullPath(gameDir);
            if (loadedFrom == full) return;
            if (!File.Exists(Path.Combine(full, "GTA5.exe"))) throw new FileNotFoundException("GTA5.exe is not in " + full);
            GTA5Keys.LoadFromPath(full, false, null);
            loadedFrom = full;
        }
    }
}

public static class Archives
{
    // Opens an archive file; relPath names it in entry paths (e.g. "mods\update\update.rpf").
    // Problems with single entries go to errors (default: stderr).
    public static RpfFile Open(string path, string relPath = null, Action<string> errors = null)
    {
        var rpf = new RpfFile(path, relPath ?? Path.GetFileName(path));
        rpf.ScanStructure(null, errors ?? (e => Console.Error.WriteLine("  " + e)));
        return rpf;
    }

    // The archive and the archives nested in it (x64\...\vehicles.rpf).
    public static IEnumerable<RpfFile> WithNested(RpfFile rpf)
    {
        var all = new List<RpfFile> { rpf };
        for (int i = 0; i < all.Count; i++)
            if (all[i].Children != null) all.AddRange(all[i].Children);
        return all;
    }

    // Every file of the archive, nested archives included.
    public static IEnumerable<RpfFileEntry> Files(RpfFile rpf) => WithNested(rpf).SelectMany(f => f.AllEntries).OfType<RpfFileEntry>();

    // The first file whose path ends with suffix ("common\data\dlclist.xml"); null when there is none.
    public static RpfFileEntry TryFind(RpfFile rpf, string suffix)
    {
        string s = suffix.Replace('/', '\\');
        return Files(rpf).FirstOrDefault(e => e.Path.EndsWith(s, StringComparison.OrdinalIgnoreCase));
    }

    public static RpfFileEntry Find(RpfFile rpf, string suffix) =>
        TryFind(rpf, suffix) ?? throw new FileNotFoundException(suffix + " not found in " + rpf.Name);

    public static byte[] Read(RpfFileEntry entry) => entry.File.ExtractFile(entry);

    // Replaces a file of an OPEN archive (its directory stays).
    public static void Replace(RpfFileEntry entry, byte[] data)
    {
        RequireOpen(entry.File);
        RpfFile.CreateFile(entry.Parent, entry.Name, data, true);
    }

    // Writes a file at a path inside an OPEN archive ("common\data\handling.meta"),
    // creating its directories; an existing file is replaced.
    public static void Write(RpfFile rpf, string path, byte[] data)
    {
        RequireOpen(rpf);
        var parts = path.Replace('/', '\\').Split('\\', StringSplitOptions.RemoveEmptyEntries);
        RpfDirectoryEntry dir = rpf.Root;
        for (int i = 0; i < parts.Length - 1; i++)
        {
            string name = parts[i].ToLowerInvariant();
            dir = dir.Directories.FirstOrDefault(d => d.NameLower == name) ?? RpfFile.CreateDirectory(dir, name);
        }
        RpfFile.CreateFile(dir, parts[^1].ToLowerInvariant(), data, true);
    }

    // Builds an OPEN archive from a folder tree; a sub-folder named *.rpf becomes a
    // nested archive (x64\levels\gta5\vehicles\vehicles.rpf). Returns the number of files.
    public static int Pack(string folder, string archive)
    {
        string src = Path.GetFullPath(folder), dst = Path.GetFullPath(archive);
        if (!Directory.Exists(src)) throw new DirectoryNotFoundException(src + " is not a folder");
        Directory.CreateDirectory(Path.GetDirectoryName(dst));
        File.Delete(dst);
        var rpf = RpfFile.CreateNew(Path.GetDirectoryName(dst), Path.GetFileName(dst), RpfEncryption.OPEN);
        return AddFolder(rpf.Root, src);
    }

    private static int AddFolder(RpfDirectoryEntry dir, string path)
    {
        int n = 0;
        foreach (string d in Directory.GetDirectories(path).OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
        {
            string name = Path.GetFileName(d).ToLowerInvariant();
            n += name.EndsWith(".rpf")
                ? AddFolder(RpfFile.CreateNew(dir, name, RpfEncryption.OPEN).Root, d)
                : AddFolder(RpfFile.CreateDirectory(dir, name), d);
        }
        foreach (string f in Directory.GetFiles(path).OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
        {
            RpfFile.CreateFile(dir, Path.GetFileName(f).ToLowerInvariant(), File.ReadAllBytes(f));
            n++;
        }
        return n;
    }

    private static void RequireOpen(RpfFile rpf)
    {
        for (var f = rpf; f != null; f = f.Parent)
            if (f.Encryption != RpfEncryption.OPEN)
                throw new InvalidOperationException(f.Name + " is encrypted; only OPEN archives can be edited");
    }
}
