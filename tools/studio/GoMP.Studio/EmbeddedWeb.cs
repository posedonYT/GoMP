// The browser part (tools/studio/web) built into the program, so a published
// Studio is one file. The resources are named web/<path> (GoMP.Studio.csproj);
// --web <folder> serves a folder instead.
using System.Reflection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Primitives;

namespace GoMP.Studio;

public sealed class EmbeddedWeb : IFileProvider
{
    private readonly Assembly assembly;
    private readonly Dictionary<string, string> files = new(StringComparer.Ordinal);  // path -> resource
    private readonly DateTimeOffset modified;

    public EmbeddedWeb(Assembly assembly)
    {
        this.assembly = assembly;
        foreach (string name in assembly.GetManifestResourceNames())
        {
            string path = name.Replace('\\', '/');
            if (path.StartsWith("web/", StringComparison.Ordinal)) files[path[4..]] = name;
        }
        // For Last-Modified and ETag: a new build is a new version of every page.
        string exe = Environment.ProcessPath;
        modified = exe != null && File.Exists(exe) ? File.GetLastWriteTimeUtc(exe) : DateTimeOffset.UtcNow;
    }

    public int Count => files.Count;

    public IFileInfo GetFileInfo(string subpath)
    {
        string path = (subpath ?? "").TrimStart('/');
        return files.TryGetValue(path, out string name) ? new Entry(assembly, name, Path.GetFileName(path), modified) : new NotFoundFileInfo(path);
    }

    // Directories exist only to find index.html in them.
    public IDirectoryContents GetDirectoryContents(string subpath)
    {
        string dir = (subpath ?? "").Trim('/');
        string prefix = dir.Length == 0 ? "" : dir + "/";
        var under = files.Keys.Where(p => p.StartsWith(prefix, StringComparison.Ordinal)).ToList();
        if (under.Count == 0) return NotFoundDirectoryContents.Singleton;
        return new Folder(under.Where(p => p.IndexOf('/', prefix.Length) < 0).Select(GetFileInfo).ToList());
    }

    public IChangeToken Watch(string filter) => NullChangeToken.Singleton;

    private sealed class Entry : IFileInfo
    {
        private readonly Assembly assembly;
        private readonly string resource;

        public Entry(Assembly assembly, string resource, string name, DateTimeOffset modified)
        {
            this.assembly = assembly;
            this.resource = resource;
            Name = name;
            LastModified = modified;
            using var s = assembly.GetManifestResourceStream(resource);
            Length = s?.Length ?? 0;
        }

        public bool Exists => true;
        public long Length { get; }
        public string PhysicalPath => null;
        public string Name { get; }
        public DateTimeOffset LastModified { get; }
        public bool IsDirectory => false;
        public Stream CreateReadStream() => assembly.GetManifestResourceStream(resource);
    }

    private sealed class Folder : IDirectoryContents
    {
        private readonly List<IFileInfo> entries;

        public Folder(List<IFileInfo> entries) => this.entries = entries;

        public bool Exists => true;
        public IEnumerator<IFileInfo> GetEnumerator() => entries.GetEnumerator();
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
