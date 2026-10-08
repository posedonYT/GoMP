// Watches the maps folder: /mapcursor in the game writes .cursor.json (the
// browser moves its camera there), other programs may change maps.
namespace GoMP.Studio;

public sealed class MapWatcher : IDisposable
{
    private readonly FileSystemWatcher watcher;
    private readonly EventHub hub;
    private readonly Maps.MapStore store;
    private readonly Dictionary<string, Timer> timers = new();

    public MapWatcher(Maps.MapStore store, EventHub hub)
    {
        this.store = store;
        this.hub = hub;
        watcher = new FileSystemWatcher(store.Dir, "*.json") { NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName };
        watcher.Changed += (_, e) => Touch(e.Name);
        watcher.Created += (_, e) => Touch(e.Name);
        watcher.Renamed += (_, e) => Touch(e.Name);
        watcher.Deleted += (_, e) => Touch(e.Name);
        watcher.EnableRaisingEvents = true;
    }

    // Events come in bursts (temporary file, rename): one event per quiet file.
    private void Touch(string file)
    {
        if (file == null || file.EndsWith(".tmp")) return;
        lock (timers)
        {
            if (timers.TryGetValue(file, out var t)) t.Dispose();
            timers[file] = new Timer(_ => Fire(file), null, 150, Timeout.Infinite);
        }
    }

    private void Fire(string file)
    {
        lock (timers) timers.Remove(file);
        if (file == Maps.MapStore.CursorFile)
        {
            var c = store.ReadCursor();
            if (c != null) hub.Publish("cursor", c);
        }
        else
        {
            hub.Publish("maps", new { name = Path.GetFileNameWithoutExtension(file) });
        }
    }

    public void Dispose()
    {
        watcher.Dispose();
        lock (timers)
            foreach (var t in timers.Values) t.Dispose();
    }
}
