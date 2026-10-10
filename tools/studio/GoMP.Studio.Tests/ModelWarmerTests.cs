using System.Collections.Concurrent;
using GoMP.Studio.Export;

namespace GoMP.Studio.Tests;

public class ModelWarmerTests
{
    private static void WaitFor(Func<bool> done, int ms = 5000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(ms);
        while (!done() && DateTime.UtcNow < until) Thread.Sleep(5);
        Assert.True(done(), "timed out");
    }

    [Fact]
    public void Every_model_is_warmed_once()
    {
        var warmed = new ConcurrentBag<uint>();
        var w = new ModelWarmer(h => warmed.Add(h), 3);
        w.Enqueue(new uint[] { 1, 2, 3 });
        w.Enqueue(new uint[] { 2, 3, 4 });
        WaitFor(() => warmed.Count == 4);
        Thread.Sleep(50);
        Assert.Equal(new uint[] { 1, 2, 3, 4 }, warmed.OrderBy(x => x));
    }

    [Fact]
    public void The_newest_cell_goes_first()
    {
        var order = new ConcurrentQueue<uint>();
        var gate = new ManualResetEventSlim();
        var w = new ModelWarmer(h =>
        {
            if (h == 100) gate.Wait();  // the first model blocks the only worker
            order.Enqueue(h);
        }, 1);
        w.Enqueue(new uint[] { 100 });
        WaitFor(() => w.Queued == 0);   // the worker took it and waits
        w.Enqueue(new uint[] { 1, 2 });  // the old place
        w.Enqueue(new uint[] { 7, 8 });  // the camera jumped: the new place
        gate.Set();
        WaitFor(() => order.Count == 5);
        Assert.Equal(new uint[] { 100, 7, 8, 1, 2 }, order);
    }

    [Fact]
    public void A_failing_model_does_not_stop_the_workers()
    {
        var warmed = new ConcurrentBag<uint>();
        var w = new ModelWarmer(h =>
        {
            if (h == 2) throw new InvalidDataException("broken");
            warmed.Add(h);
        }, 1);
        w.Enqueue(new uint[] { 1, 2, 3 });
        WaitFor(() => warmed.Count == 2);
        Assert.Equal(new uint[] { 1, 3 }, warmed.OrderBy(x => x));
    }

    [Fact]
    public void No_more_models_at_once_than_workers()
    {
        int now = 0, most = 0, done = 0;
        var w = new ModelWarmer(h =>
        {
            int n = Interlocked.Increment(ref now);
            int m;
            while ((m = Volatile.Read(ref most)) < n && Interlocked.CompareExchange(ref most, n, m) != m) { }
            Thread.Sleep(20);
            Interlocked.Decrement(ref now);
            Interlocked.Increment(ref done);
        }, 3);
        w.Enqueue(Enumerable.Range(1, 20).Select(i => (uint)i));
        WaitFor(() => Volatile.Read(ref done) == 20);
        Assert.InRange(most, 2, 3);
    }
}

public class ModelCacheTests : IDisposable
{
    private readonly string dir = Path.Combine(Path.GetTempPath(), "gomp-cache-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
    }

    [Fact]
    public void Two_requests_for_one_model_export_it_once()
    {
        var cache = new ModelCache(dir);
        int exports = 0;
        var gate = new ManualResetEventSlim();
        byte[] Export()
        {
            Interlocked.Increment(ref exports);
            gate.Wait();
            return new byte[] { 1, 2, 3 };
        }
        var a = Task.Run(() => cache.Get(42, Lod.High, Export, ModelCache.WorldTexture));
        Thread.Sleep(100);  // the first one is exporting
        var b = Task.Run(() => cache.Get(42, Lod.High, Export, ModelCache.WorldTexture));
        Thread.Sleep(100);
        gate.Set();
        Assert.Equal(new byte[] { 1, 2, 3 }, a.Result);
        Assert.Equal(new byte[] { 1, 2, 3 }, b.Result);
        Assert.Equal(1, exports);
        Assert.True(cache.Has(42, Lod.High, ModelCache.WorldTexture));
        Assert.False(cache.Has(42, Lod.High, 512));
        Assert.Empty(Directory.GetFiles(Path.Combine(dir, "models"), "*.tmp"));
    }

    [Fact]
    public void The_world_texture_size_matches_the_browser()
    {
        // web/js/scene/world.js asks for this size; the warmer must export the same files.
        string js = null;
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null && js == null; d = d.Parent)
        {
            string f = Path.Combine(d.FullName, "tools", "studio", "web", "js", "scene", "world.js");
            if (File.Exists(f)) js = File.ReadAllText(f);
        }
        Assert.NotNull(js);
        Assert.Matches($@"const TEXTURE = {ModelCache.WorldTexture};", js);
    }
}
