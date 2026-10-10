using GoMP.Studio.Export;

namespace GoMP.Studio.Tests;

public class ExportSlotsTests
{
    // Whether a request gets a slot: its own thread (the pool may be busy with the game
    // tests), a short wait when it should block, a long one when it should not.
    private static bool Enters(ExportSlots slots, bool low, bool expected)
    {
        var done = new ManualResetEventSlim();
        IDisposable lease = null;
        var t = new Thread(() =>
        {
            lease = slots.Enter(low);
            done.Set();
        }) { IsBackground = true };
        t.Start();
        bool ok = done.Wait(expected ? 10000 : 300);
        if (ok) lease.Dispose();
        return ok;
    }

    [Fact]
    public void Streaming_requests_leave_a_slot_for_the_user()
    {
        var slots = new ExportSlots(2);
        using var first = slots.Enter(low: true);
        Assert.False(Enters(slots, low: true, expected: false), "a second streaming request waits");
        Assert.True(Enters(slots, low: false, expected: true), "the user's request goes at once");
    }

    [Fact]
    public void Slots_are_given_back()
    {
        var slots = new ExportSlots(2);
        var a = slots.Enter(low: true);
        a.Dispose();
        a.Dispose();  // twice is harmless
        using var b = slots.Enter(low: true);
        Assert.True(Enters(slots, low: false, expected: true));
        Assert.False(Enters(slots, low: true, expected: false));
    }

    [Fact]
    public void The_user_can_use_every_slot()
    {
        var slots = new ExportSlots(3);
        using var a = slots.Enter();
        using var b = slots.Enter();
        using var c = slots.Enter();
        Assert.False(Enters(slots, low: false, expected: false));
        Assert.False(Enters(slots, low: true, expected: false));
    }

    [Fact]
    public void Streaming_stops_at_all_but_one_slot_whatever_the_user_runs()
    {
        var slots = new ExportSlots(3);  // streaming may hold two
        using var s1 = slots.Enter(low: true);
        using var s2 = slots.Enter(low: true);
        Assert.False(Enters(slots, low: true, expected: false), "a third streaming request waits");
        Assert.True(Enters(slots, low: false, expected: true), "the last slot is the user's");
    }
}
