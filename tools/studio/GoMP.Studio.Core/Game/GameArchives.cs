// Starting CodeWalker's GameFileCache on any OS. CodeWalker names the archives of
// the game folder by their path under it with '\' (update\update.rpf) and finds
// the update and the DLCs by those names, but its scan gets them by cutting
// folder + "\" off the full paths: on Linux and macOS nothing is cut, the update
// and the DLCs are not found. There the archives are scanned here, named as on
// Windows, and handed to the cache before it starts (it then skips its own scan
// and the steps after it, which are run here).
using System.Reflection;
using CodeWalker.GameFiles;

namespace GoMP.Studio.Game;

public static class GameArchives
{
    private const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Instance;

    // ownScan: scan the archives here (default: everywhere but Windows).
    public static void Init(GameFileCache cache, string folder, Action<string> status, Action<string> errors, bool? ownScan = null)
    {
        if (!(ownScan ?? !OperatingSystem.IsWindows()))
        {
            cache.Init(status, errors);
            return;
        }
        var man = new RpfManager
        {
            ExcludePaths = (string[])Method(typeof(GameFileCache), "GetExcludePaths").Invoke(cache, null),
            EnableMods = cache.EnableMods,
            BuildExtendedJenkIndex = cache.BuildExtendedJenkIndex,
        };
        man.Init(new List<RpfFile>(), false);  // the empty lists and dictionaries
        typeof(RpfManager).GetProperty(nameof(RpfManager.UpdateStatus)).SetValue(man, status);
        typeof(RpfManager).GetProperty(nameof(RpfManager.ErrorLog)).SetValue(man, errors);
        var add = Method(typeof(RpfManager), "AddRpfFile");
        foreach (string file in Directory.GetFiles(folder, "*.rpf", SearchOption.AllDirectories))
        {
            string name = ArchiveName(folder, file);
            if (man.ExcludePaths?.Any(x => name.StartsWith(x, StringComparison.Ordinal)) == true) continue;
            try
            {
                var rpf = new RpfFile(file, name);
                rpf.ScanStructure(status, errors);
                if (rpf.LastException != null) continue;  // broken, or encrypted with unknown keys
                add.Invoke(man, new object[] { rpf, false, false });
            }
            catch (Exception e)
            {
                errors(file + ": " + e.Message);
            }
        }
        status("Building jenkindex...");
        man.BuildBaseJenkIndex();
        man.IsInited = true;
        cache.RpfMan = man;
        cache.Init(status, errors);
        Method(typeof(GameFileCache), "InitGlobal").Invoke(cache, null);
        Method(typeof(GameFileCache), "InitDlc").Invoke(cache, null);
    }

    // The name CodeWalker gives an archive of the game folder: its path under the folder,
    // lower case, with '\' (update\x64\dlcpacks\mpbeach\dlc.rpf).
    public static string ArchiveName(string folder, string file) =>
        Path.GetRelativePath(folder, file).Replace(Path.DirectorySeparatorChar, '\\').Replace('/', '\\').ToLowerInvariant();

    private static MethodInfo Method(Type type, string name) =>
        type.GetMethod(name, Private) ?? throw new MissingMethodException(type.Name, name + " (another CodeWalker version?)");
}
