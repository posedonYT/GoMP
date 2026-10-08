// gomp-addons installs add-on vehicle packs for GoMP into the game's mods
// folder, the way OpenIV does it by hand:
//
//   <game>\mods\update\x64\dlcpacks\<pack>\dlc.rpf        the pack itself
//   <game>\mods\update\update.rpf                          a copy of update.rpf whose
//                                                          common\data\dlclist.xml lists the packs
//                                                          and whose gameconfig.xml has room for
//                                                          their vehicles (Patches.cs)
//
// The mods folder is read only by a mods-folder ASI (RageOpenV), which the
// GoMP launcher puts into the game folder for GoMP sessions only; a normal
// launch of GTA V ignores it. The copy of update.rpf is rebuilt when the game
// updates its own update.rpf or the set of packs changes.
//
//   gomp-addons install --game E:\GTAV --packs client-dist\addons
//   gomp-addons list    --game E:\GTAV <archive.rpf> [name filter]
//   gomp-addons extract --game E:\GTAV <archive.rpf> <entry path> <output file>
//   gomp-addons replace --game E:\GTAV <archive.rpf> <entry path> <new file>
//   gomp-addons pack    <folder> <out.rpf>
//   gomp-addons selftest
using System.Text;
using System.Text.Json;
using CodeWalker.GameFiles;
using GoMP.Gta;

namespace GoMP.Addons;

internal static class Program
{
    // Bump when the patching of update.rpf changes, so old copies are rebuilt.
    private const int PatchVersion = 4;
    private sealed record Marker(long SourceLength, DateTime SourceWriteTime, string[] Packs, int Version = 0);

    private static int Main(string[] args)
    {
        try
        {
            string game = Option(args, "--game") ?? @"E:\GTAV";
            string[] rest = args.Where(a => !a.StartsWith("--") && a != Option(args, "--game") && a != Option(args, "--packs"))
                .Skip(1).ToArray();
            switch (args.FirstOrDefault())
            {
                case "install":
                    return Install(game, Option(args, "--packs") ?? "addons");
                case "list":
                    return List(game, rest);
                case "extract":
                    return Extract(game, rest);
                case "replace":
                    return Replace(game, rest);
                case "selftest":
                    return Patches.SelfTest() | PackSelfTest();
                case "pack":
                    return Pack(rest);
                default:
                    Console.Error.WriteLine("usage: gomp-addons install --game <gta folder> --packs <folder with <pack>\\dlc.rpf>");
                    Console.Error.WriteLine("       gomp-addons list --game <gta folder> <archive.rpf> [name filter]");
                    Console.Error.WriteLine("       gomp-addons extract --game <gta folder> <archive.rpf> <entry path> <output file>");
                    Console.Error.WriteLine("       gomp-addons replace --game <gta folder> <archive.rpf> <entry path> <new file>");
                    Console.Error.WriteLine("       gomp-addons pack <folder> <out.rpf>");
                    Console.Error.WriteLine("       gomp-addons selftest");
                    return 2;
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("gomp-addons: " + e.Message);
            return 1;
        }
    }

    private static string Option(string[] args, string name)
    {
        int i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    private static RpfFile Open(string path, string relPath) => Archives.Open(path, relPath);

    private static RpfFileEntry FindEntry(RpfFile rpf, string suffix) => Archives.Find(rpf, suffix);

    // ------------------------------------------------------------------ install

    private static int Install(string game, string packsDir)
    {
        var packs = Directory.Exists(packsDir)
            ? Directory.GetDirectories(packsDir).Where(d => File.Exists(Path.Combine(d, "dlc.rpf")))
                .Select(d => Path.GetFileName(d).ToLowerInvariant()).OrderBy(n => n).ToArray()
            : Array.Empty<string>();
        if (packs.Length == 0)
        {
            Console.WriteLine("no add-on packs in " + packsDir);
            return 0;
        }
        Keys.Load(game);

        // 1. The packs.
        string dlcpacks = Path.Combine(game, "mods", "update", "x64", "dlcpacks");
        foreach (string pack in packs)
        {
            string src = Path.Combine(packsDir, pack, "dlc.rpf");
            string dst = Path.Combine(dlcpacks, pack, "dlc.rpf");
            Directory.CreateDirectory(Path.GetDirectoryName(dst));
            // File.Copy keeps the write time: a replaced pack differs in it.
            if (!File.Exists(dst) || new FileInfo(dst).Length != new FileInfo(src).Length ||
                File.GetLastWriteTimeUtc(dst) != File.GetLastWriteTimeUtc(src))
                File.Copy(src, dst, true);
            var models = VehicleModels(dst, $@"mods\update\x64\dlcpacks\{pack}\dlc.rpf");
            Console.WriteLine($"pack {pack}: /veh {string.Join(", /veh ", models)}");
        }

        // 2. update.rpf with the packs in dlclist.xml and the limits of gameconfig.xml
        //    (rebuilt only when something changed).
        string source = Path.Combine(game, "update", "update.rpf");
        string target = Path.Combine(game, "mods", "update", "update.rpf");
        string markerPath = Path.Combine(game, "mods", "gomp-addons.json");
        var srcInfo = new FileInfo(source);
        var marker = new Marker(srcInfo.Length, srcInfo.LastWriteTimeUtc, packs, PatchVersion);
        if (File.Exists(target) && File.Exists(markerPath))
        {
            var old = JsonSerializer.Deserialize<Marker>(File.ReadAllText(markerPath));
            if (old != null && old.SourceLength == marker.SourceLength && old.SourceWriteTime == marker.SourceWriteTime &&
                old.Packs.SequenceEqual(marker.Packs) && old.Version == marker.Version)
            {
                Console.WriteLine("mods\\update\\update.rpf is up to date");
                return 0;
            }
        }
        File.Delete(markerPath);
        Console.WriteLine($"copying update.rpf ({srcInfo.Length / (1 << 20)} MB) to the mods folder...");
        File.Copy(source, target, true);
        try
        {
            var rpf = Open(target, @"mods\update\update.rpf");
            var dlclist = FindEntry(rpf, @"common\data\dlclist.xml");
            var config = FindEntry(rpf, @"common\data\gameconfig.xml");
            string patchedList = Patches.AddPacks(Encoding.UTF8.GetString(rpf.ExtractFile(dlclist)), packs);
            string patchedConfig = Patches.RaiseLimits(Encoding.UTF8.GetString(rpf.ExtractFile(config)));
            // Like OpenIV: the copy in the mods folder gets an OPEN (unencrypted) header.
            RpfFile.SetEncryptionType(rpf, RpfEncryption.OPEN);
            RpfFile.CreateFile(dlclist.Parent, "dlclist.xml", Encoding.UTF8.GetBytes(patchedList), true);
            RpfFile.CreateFile(config.Parent, "gameconfig.xml", Encoding.UTF8.GetBytes(patchedConfig), true);

            // Read both back to be sure the archive is consistent.
            var check = Open(target, @"mods\update\update.rpf");
            string written = Encoding.UTF8.GetString(check.ExtractFile(FindEntry(check, @"common\data\dlclist.xml")));
            foreach (string pack in packs)
                if (!written.Contains($"dlcpacks:/{pack}/", StringComparison.OrdinalIgnoreCase))
                    throw new Exception("dlclist.xml was not updated");
            string writtenConfig = Encoding.UTF8.GetString(check.ExtractFile(FindEntry(check, @"common\data\gameconfig.xml")));
            foreach (var (name, minimum) in Patches.ConfigLimits)
            {
                int value = Patches.LimitOf(writtenConfig, name);
                if (value < minimum) throw new Exception($"gameconfig.xml was not updated ({name} = {value})");
                Console.WriteLine($"gameconfig: {name} = {value}");
            }
        }
        catch
        {
            File.Delete(target);
            throw;
        }
        File.WriteAllText(markerPath, JsonSerializer.Serialize(marker));
        Console.WriteLine("mods\\update\\update.rpf built with " + string.Join(", ", packs));
        return 0;
    }

    // Model names declared in the pack's vehicles.meta files (what /veh takes).
    private static IEnumerable<string> VehicleModels(string path, string relPath)
    {
        var rpf = Open(path, relPath);
        var names = new List<string>();
        foreach (var e in rpf.AllEntries.OfType<RpfFileEntry>().Where(e => e.NameLower == "vehicles.meta"))
            names.AddRange(Patches.ModelNames(Encoding.UTF8.GetString(rpf.ExtractFile(e))));
        return names.Distinct();
    }

    // ------------------------------------------------------------------ list / extract / replace

    private static int Extract(string game, string[] args)
    {
        if (args.Length < 3) throw new Exception("extract needs <archive.rpf> <entry> <output file>");
        Keys.Load(game);
        string path = Path.GetFullPath(args[0]);
        var entry = FindEntry(Open(path, Path.GetRelativePath(game, path)), args[1]);
        File.WriteAllBytes(args[2], entry.File.ExtractFile(entry));
        Console.WriteLine($"{entry.Path} -> {args[2]}");
        return 0;
    }

    // gomp-addons pack <folder> <out.rpf>: builds an OPEN archive from a folder tree;
    // a sub-folder named *.rpf becomes a nested archive (x64\...\vehicles.rpf).
    // Used to turn replace-only vehicle mods into add-on packs.
    private static int Pack(string[] args)
    {
        if (args.Length < 2) throw new Exception("pack needs <folder> <out.rpf>");
        int files = Archives.Pack(args[0], args[1]);
        Console.WriteLine($"{Path.GetFullPath(args[1])}: {files} files");
        return 0;
    }

    // Packs a small tree into a temporary archive and reads it back.
    private static int PackSelfTest()
    {
        string tmp = Path.Combine(Path.GetTempPath(), "gomp-addons-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(Path.Combine(tmp, "src", "x64", "Vehicles.rpf"));
            File.WriteAllText(Path.Combine(tmp, "src", "content.xml"), "<content/>");
            File.WriteAllText(Path.Combine(tmp, "src", "x64", "Vehicles.rpf", "a.txt"), "inside");
            string archive = Path.Combine(tmp, "out", "dlc.rpf");
            using (var quiet = new StringWriter())
            {
                var stdout = Console.Out;
                Console.SetOut(quiet);
                try { Pack(new[] { Path.Combine(tmp, "src"), archive }); }
                finally { Console.SetOut(stdout); }
            }
            var rpf = Open(archive, "dlc.rpf");
            var nested = rpf.Children.FirstOrDefault(c => c.Name == "vehicles.rpf");
            var inner = nested?.AllEntries.OfType<RpfFileEntry>().FirstOrDefault(e => e.Name == "a.txt");
            bool ok = Encoding.UTF8.GetString(rpf.ExtractFile(FindEntry(rpf, "content.xml"))) == "<content/>"
                      && inner != null && Encoding.UTF8.GetString(nested.ExtractFile(inner)) == "inside";
            Console.WriteLine((ok ? "ok   " : "FAIL ") + "pack builds an archive with a nested *.rpf folder");
            return ok ? 0 : 1;
        }
        finally
        {
            Directory.Delete(tmp, true);
        }
    }

    // Replaces a file of an OPEN (unencrypted) archive, e.g. a pack's vehicles.meta.
    private static int Replace(string game, string[] args)
    {
        if (args.Length < 3) throw new Exception("replace needs <archive.rpf> <entry> <new file>");
        Keys.Load(game);
        string path = Path.GetFullPath(args[0]);
        var rpf = Open(path, Path.GetRelativePath(game, path));
        var entry = FindEntry(rpf, args[1]);
        Archives.Replace(entry, File.ReadAllBytes(args[2]));
        Console.WriteLine($"{entry.Path} <- {args[2]}");
        return 0;
    }

    private static int List(string game, string[] args)
    {
        if (args.Length == 0) throw new Exception("list needs an archive path");
        Keys.Load(game);
        string path = Path.GetFullPath(args[0]);
        var rpf = Open(path, Path.GetRelativePath(game, path));
        string filter = args.Length > 1 ? args[1].ToLowerInvariant() : "";
        Console.WriteLine($"{rpf.Name}: encryption {rpf.Encryption}, {rpf.AllEntries.Count} entries");
        // Nested archives (x64\vehicles.rpf...) are listed too.
        foreach (var e in Archives.WithNested(rpf).SelectMany(f => f.AllEntries).Where(e => e.Path.Contains(filter)))
            Console.WriteLine("  " + e.Path + (e is RpfResourceFileEntry r ? $"  (resource v{r.Version})" : ""));
        return 0;
    }
}
