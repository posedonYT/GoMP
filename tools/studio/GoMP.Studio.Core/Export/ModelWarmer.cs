// Exports the models of the world ahead of the browser. When the browser asks for a
// cell, its models are put here and several workers export them into the disk cache
// (the browser itself fetches only a few at a time: about six connections per
// server). The latest cell goes first: after the camera jumps (a house picked in
// the list) the new place is warmed before the backlog of the old one.
using System.Collections.Concurrent;

namespace GoMP.Studio.Export;

public sealed class ModelWarmer
{
    private readonly Action<uint> warm;
    private readonly int workers;
    private readonly ConcurrentDictionary<uint, bool> seen = new();
    private readonly object sync = new();
    private readonly List<uint[]> batches = new();  // newest last
    private readonly SemaphoreSlim pending = new(0);
    private int started;

    public ModelWarmer(Action<uint> warm, int workers)
    {
        this.warm = warm;
        this.workers = Math.Max(1, workers);
    }

    public int Queued
    {
        get { lock (sync) return batches.Sum(b => b.Length); }
    }

    // A batch of models (one cell); those warmed or queued already are skipped.
    public void Enqueue(IEnumerable<uint> hashes)
    {
        var fresh = hashes.Where(h => seen.TryAdd(h, true)).ToArray();
        if (fresh.Length == 0) return;
        lock (sync) batches.Add(fresh);
        pending.Release(fresh.Length);
        Start();
    }

    // The next model: from the newest batch.
    private bool TryTake(out uint hash)
    {
        lock (sync)
        {
            for (int i = batches.Count - 1; i >= 0; i--)
            {
                var b = batches[i];
                if (b.Length == 0)
                {
                    batches.RemoveAt(i);
                    continue;
                }
                hash = b[0];
                if (b.Length == 1) batches.RemoveAt(i);
                else batches[i] = b[1..];
                return true;
            }
        }
        hash = 0;
        return false;
    }

    private void Start()
    {
        if (Interlocked.Exchange(ref started, 1) == 1) return;
        for (int i = 0; i < workers; i++)
            new Thread(Work) { IsBackground = true, Name = "model warmer", Priority = ThreadPriority.BelowNormal }.Start();
    }

    private void Work()
    {
        while (true)
        {
            pending.Wait();
            if (!TryTake(out uint hash)) continue;
            try
            {
                warm(hash);
            }
            catch (Exception)
            {
                // a model that cannot be exported: the browser gets its 404 later
            }
        }
    }
}
