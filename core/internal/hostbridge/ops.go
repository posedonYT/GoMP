// Package hostbridge connects the core to script hosts (the Node.js RAGE.MP
// compatibility runtime now, a .NET runtime later) running as separate
// processes. Hosts can only exchange operations over IPC; they never share
// memory with the core.
//
// Wire format: every frame is a little-endian uint32 length followed by one
// GoMP Value (wire/proto) that is an array of operations. Each operation is an
// array whose first element is the operation name. See docs/ipc.md.
package hostbridge

// MirrorStride is the number of values per entity in OpUpdates.
const MirrorStride = 8

// Protocol version spoken with hosts.
const Version = 1

// Operations sent by the core to hosts.
const (
	OpHello   = "hello"   // [hello, version, config, info]
	OpCreate  = "create"  // [create, type, id, gen, state]
	OpDestroy = "destroy" // [destroy, type, id, gen]
	OpUpdate  = "update"  // [update, type, id, partialState]
	// OpUpdates carries the synced state (position etc.) of many entities in
	// one flat array, MirrorStride values each:
	// type, id, pos, vel, rot (players: heading in x), flags, move|steer, aim|nil.
	OpUpdates  = "updates"  // [updates, [values...]]
	OpEvent    = "event"    // [event, name, args]
	OpProcReq  = "procReq"  // [procReq, callId, player, name, args]
	OpProcRes  = "procRes"  // [procRes, hostCallId, ok, valueOrError]
	OpReady    = "ready"    // [ready] initial snapshot complete
	OpPing     = "ping"     // [ping, n]
	OpShutdown = "shutdown" // [shutdown]
	OpError    = "error"    // [error, message]
)

// Operations sent by hosts to the core.
const (
	CmdAuth          = "auth"          // [auth, token, hostName]
	CmdLoaded        = "loaded"        // [loaded, packageCount]
	CmdSubscribe     = "sub"           // [sub, [names]]  events or "proc:<name>"
	CmdUnsubscribe   = "unsub"         // [unsub, [names]]
	CmdCreate        = "create"        // [create, type, id, state]
	CmdDestroy       = "destroy"       // [destroy, type, id, gen]
	CmdSet           = "set"           // [set, type, id, gen, key, value]
	CmdCall          = "call"          // [call, type, id, gen, method, args]
	CmdGlobal        = "global"        // [global, method, args]
	CmdProcResult    = "procRes"       // [procRes, callId, ok, valueOrError]
	CmdProcCall      = "procCall"      // [procCall, hostCallId, player, name, args]
	CmdPong          = "pong"          // [pong, n]
	CmdShutdownReady = "shutdownReady" // [shutdownReady]
)
