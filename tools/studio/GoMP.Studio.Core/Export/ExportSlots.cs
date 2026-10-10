// How many model exports run at once, with a lane for the user. The world around
// the camera asks for hundreds of models; a model the user just picked (a map
// object, a vehicle, an interior) must not wait behind them. Streaming ("low")
// requests may hold all slots but one, so one slot is always free for the user's.
namespace GoMP.Studio.Export;

public sealed class ExportSlots
{
    private readonly SemaphoreSlim all;
    private readonly SemaphoreSlim streaming;

    public ExportSlots(int count)
    {
        count = Math.Max(2, count);
        all = new SemaphoreSlim(count);
        streaming = new SemaphoreSlim(count - 1);
    }

    public IDisposable Enter(bool low = false)
    {
        if (low) streaming.Wait();
        try
        {
            all.Wait();
        }
        catch
        {
            if (low) streaming.Release();
            throw;
        }
        return new Lease(this, low);
    }

    private sealed class Lease : IDisposable
    {
        private ExportSlots owner;
        private readonly bool low;

        public Lease(ExportSlots owner, bool low)
        {
            this.owner = owner;
            this.low = low;
        }

        public void Dispose()
        {
            var o = Interlocked.Exchange(ref owner, null);
            if (o == null) return;
            o.all.Release();
            if (low) o.streaming.Release();
        }
    }
}
