// Watches server-files/houses.json: the gamemode (admin commands) and other programs
// may change it; the browser reloads the houses on the "houses" event.
namespace GoMP.Studio;

public sealed class HousesWatcher : IDisposable
{
    private readonly FileSystemWatcher watcher;
    private readonly EventHub hub;
    private readonly object sync = new();
    private Timer timer;

    public HousesWatcher(Houses.HousesStore store, EventHub hub)
    {
        this.hub = hub;
        Directory.CreateDirectory(store.ServerFiles);
        watcher = new FileSystemWatcher(store.ServerFiles, "houses.json") { NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName };
        watcher.Changed += (_, e) => Touch(e.Name);
        watcher.Created += (_, e) => Touch(e.Name);
        watcher.Renamed += (_, e) => Touch(e.Name);
        watcher.Deleted += (_, e) => Touch(e.Name);
        watcher.EnableRaisingEvents = true;
    }

    // Events come in bursts (temporary file, rename): one event per quiet period.
    private void Touch(string file)
    {
        if (file == null || file.EndsWith(".tmp")) return;
        lock (sync)
        {
            timer?.Dispose();
            timer = new Timer(_ => hub.Publish("houses", new { }), null, 150, Timeout.Infinite);
        }
    }

    public void Dispose()
    {
        watcher.Dispose();
        lock (sync) timer?.Dispose();
    }
}
