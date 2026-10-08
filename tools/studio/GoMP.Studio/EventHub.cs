// Server-sent events for the browser (/api/events): the loading of the game,
// the cursor from the game (/mapcursor) and maps changed on disk.
using System.Text.Json;
using System.Threading.Channels;

namespace GoMP.Studio;

public sealed class EventHub
{
    private readonly object sync = new();
    private readonly List<Channel<string>> clients = new();
    private static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);

    public void Publish(string type, object data)
    {
        string json = JsonSerializer.Serialize(new { type, data }, WebJson);
        lock (sync)
            foreach (var c in clients) c.Writer.TryWrite(json);
    }

    public async Task Stream(HttpContext ctx)
    {
        ctx.Response.Headers.ContentType = "text/event-stream";
        ctx.Response.Headers.CacheControl = "no-cache";
        var channel = Channel.CreateBounded<string>(new BoundedChannelOptions(256) { FullMode = BoundedChannelFullMode.DropOldest });
        lock (sync) clients.Add(channel);
        try
        {
            await ctx.Response.WriteAsync(": connected\n\n", ctx.RequestAborted);
            await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
            await foreach (string msg in channel.Reader.ReadAllAsync(ctx.RequestAborted))
            {
                await ctx.Response.WriteAsync($"data: {msg}\n\n", ctx.RequestAborted);
                await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
            }
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            lock (sync) clients.Remove(channel);
        }
    }

    public int Clients
    {
        get { lock (sync) return clients.Count; }
    }
}
