package server

import (
	"strings"
	"time"
	"unicode/utf8"

	"gomp/core/internal/anticheat"
	"gomp/core/internal/combat"
	"gomp/core/internal/streaming"
	"gomp/core/internal/world"
	"gomp/wire/proto"
	"gomp/wire/transport"
)

// client is a connected player's session state.
type client struct {
	conn   *transport.Conn
	p      *world.Player
	info   proto.ConnectInfo
	stream *streaming.Set
	mover  anticheat.Mover
	shots  combat.History

	// Pending stream changes computed in the parallel phase, plus scratch buffers.
	addQ  []streaming.Candidate
	remQ  []streaming.Key
	cands []streaming.Candidate
	due   []dueSync
	out   [][]byte

	blips   map[uint16]uint16 // blip id -> gen currently shown
	dummies map[uint16]uint16

	procs      map[uint32]clientProc // server-initiated callProc awaiting the client
	nextProcID uint32

	envBudget   float32
	envLast     time.Time
	chatTokens  float32
	chatLast    time.Time
	evTokens    float32
	evLast      time.Time
	badMessages int
	kicked      string // kick reason, "" if not kicked
	respawnAt   time.Time
	joinedAt    time.Time

	// Reusable decode targets.
	pedSync   proto.PedSync
	vehSync   proto.VehicleSync
	passSync  proto.PassengerSync
	unoccSync proto.UnoccupiedSync
}

type clientProc struct {
	host       int
	hostCallID uint32
	expires    time.Time
}

// serverProc is a client→server procedure call forwarded to a host.
type serverProc struct {
	player       world.Ref
	clientCallID uint32
	host         int
	expires      time.Time
}

const procTimeout = 30 * time.Second

func (s *Server) clientOf(p *world.Player) *client {
	if p == nil || int(p.ID) >= len(s.byID) {
		return nil
	}
	if c := s.byID[p.ID]; c != nil && c.p == p {
		return c
	}
	return nil
}

func (s *Server) clientByRef(r world.Ref) *client {
	if r.Type != proto.EntityPlayer {
		return nil
	}
	if p, ok := s.world.Resolve(r).(*world.Player); ok {
		return s.clientOf(p)
	}
	return nil
}

// ------------------------------------------------------------------ joining

func validName(n string) bool {
	if l := utf8.RuneCountInString(n); l < 1 || l > 32 {
		return false
	}
	for _, r := range n {
		if r < 0x20 || r == 0x7F {
			return false
		}
	}
	return strings.TrimSpace(n) == n
}

func (s *Server) onNetEvent(ev transport.Event) {
	switch ev.Kind {
	case transport.EventConnect:
		s.onConnect(ev.Conn, ev.Payload)
	case transport.EventDisconnect:
		if c := s.clients[ev.Conn]; c != nil {
			exit := "disconnect"
			switch {
			case c.kicked != "":
				exit = "kicked"
			case ev.Reason == "timeout":
				exit = "timeout"
			}
			reason := ev.Reason
			if c.kicked != "" {
				reason = c.kicked
			}
			s.removePlayer(c, exit, reason)
		}
	}
}

func (s *Server) onConnect(conn *transport.Conn, payload []byte) {
	info, err := proto.ParseConnectInfo(payload)
	ip := conn.Addr().Addr().String()
	switch {
	case err != nil:
		conn.Reject("malformed connect info")
		return
	case info.Version != proto.ClientVersion:
		conn.Reject("client version mismatch")
		return
	case !validName(info.Name):
		conn.Reject("invalid name")
		return
	case !s.scriptsLoaded:
		conn.Reject("server is starting, try again")
		return
	}
	if r, ok := s.bans[info.Serial]; ok && info.Serial != "" {
		conn.Reject("banned: " + r)
		return
	}
	if r, ok := s.bans[ip]; ok {
		conn.Reject("banned: " + r)
		return
	}
	if s.cfg.LimitTimeOfConnectionsPerIP > 0 {
		if last, ok := s.lastConnect[ip]; ok && s.now.Sub(last) < time.Duration(s.cfg.LimitTimeOfConnectionsPerIP)*time.Millisecond {
			conn.Reject("too many connection attempts")
			return
		}
		s.lastConnect[ip] = s.now
	}
	if s.cfg.DisallowMultipleConnectionsPerIP {
		for _, c := range s.clients {
			if c.p.IP == ip {
				conn.Reject("only one connection per IP is allowed")
				return
			}
		}
	}
	s.emit("incomingConnection", ip, info.Serial, info.SocialClub, info.RGSCID, info.GameType)

	p := &world.Player{
		EntityBase: world.EntityBase{Model: proto.Joaat("mp_m_freemode_01"), Alpha: 255},
		Name:       info.Name,
		Serial:     info.Serial,
		SocialClub: info.SocialClub,
		RGSCID:     info.RGSCID,
		GameType:   info.GameType,
		IP:         ip,
		Health:     100,
		Weapon:     unarmed,
		Weapons:    map[uint32]uint16{},
	}
	if err := s.world.Add(p, -1); err != nil {
		conn.Reject("server full")
		return
	}
	conn.Accept()
	c := &client{
		conn:     conn,
		p:        p,
		info:     info,
		stream:   streaming.NewSet(),
		blips:    map[uint16]uint16{},
		dummies:  map[uint16]uint16{},
		procs:    map[uint32]clientProc{},
		joinedAt: s.now,
	}
	conn.UserData = c
	s.clients[conn] = c
	s.byID[p.ID] = c
	s.log.Info("player joined", "id", p.ID, "name", p.Name, "ip", ip)
	s.hostCreate(p) // before anything that queues mirror updates for p

	s.sendTo(c, transport.Reliable, &proto.Welcome{
		PlayerID:       p.ID,
		ServerName:     s.cfg.Name,
		GameMode:       s.cfg.GameMode,
		TickRate:       uint8(s.tickRate),
		StreamDistance: float32(s.cfg.StreamDistance),
		Hour:           s.world.Time.Hour,
		Minute:         s.world.Time.Minute,
		Second:         s.world.Time.Second,
		Weather:        s.world.Weather,
	})
	s.sendTo(c, transport.Reliable, s.createMessage(p))
	for name, loaded := range s.world.Ipls {
		s.sendTo(c, transport.Reliable, &proto.Ipl{Name: name, Load: loaded})
	}
	s.syncGlobals(c)
	s.sendLoadout(c)
	s.emit("playerJoin", p.Key())
}

// removePlayer tears down a player after disconnect.
func (s *Server) removePlayer(c *client, exitType, reason string) {
	p := c.p
	s.log.Info("player left", "id", p.ID, "name", p.Name, "exit", exitType, "reason", reason)
	s.emit("playerQuit", p.Key(), exitType, reason)

	s.clearReservation(p)
	if v := p.Vehicle; v != nil {
		s.vacateSeat(p)
		if v.Driver() == nil && v.Controller == nil {
			s.assignController(v)
		}
	}
	s.world.Vehicles.Each(func(_ uint16, v *world.Vehicle) {
		if v.Controller == p {
			v.Controller, v.ControllerPinned = nil, false
		}
	})
	s.world.Peds.Each(func(_ uint16, pd *world.Ped) {
		if pd.Controller == p {
			pd.Controller = nil
		}
	})
	// Forget what this player streamed.
	c.stream.Each(func(e *streaming.Entry) { s.unindexStreamer(e.Key, p.ID) })
	s.world.Colshapes.Each(func(_ uint16, cs *world.Colshape) { delete(cs.Inside, p.ID) })
	s.world.Checkpoints.Each(func(_ uint16, cp *world.Checkpoint) { delete(cp.Inside, p.ID) })
	for _, pp := range c.procs {
		s.sendToHost(pp.host, hostOp("procRes", int64(pp.hostCallID), false, "player disconnected"))
	}
	for id, sp := range s.serverProcs {
		if sp.player == p.Ref() {
			delete(s.serverProcs, id)
		}
	}
	s.destroyEntity(p)
	delete(s.clients, c.conn)
	s.byID[p.ID] = nil
}

// kick disconnects a player with a reason shown to them.
func (s *Server) kick(c *client, reason string) {
	if c.kicked != "" {
		return
	}
	if reason == "" {
		reason = "kicked"
	}
	c.kicked = reason
	c.conn.Disconnect(reason)
}

// ------------------------------------------------------------------ sending

// sendTo encodes m and queues it for c.
func (s *Server) sendTo(c *client, ch transport.Channel, m proto.Message) {
	b, err := proto.Marshal(m)
	if err != nil {
		s.log.Error("encode message", "type", m.ID(), "err", err)
		return
	}
	_ = c.conn.Send(ch, b)
}

// toStreamers sends m to every player that has ent streamed in. When self is
// true and ent is a player, that player receives it too.
func (s *Server) toStreamers(ent world.Entity, ch transport.Channel, m proto.Message, self bool) {
	b, err := proto.Marshal(m)
	if err != nil {
		s.log.Error("encode message", "type", m.ID(), "err", err)
		return
	}
	s.bytesToStreamers(ent, ch, b, self)
}

func (s *Server) bytesToStreamers(ent world.Entity, ch transport.Channel, b []byte, self bool) {
	base := ent.Base()
	for id := range s.streamers[base.Key()] {
		if c := s.byID[id]; c != nil {
			_ = c.conn.Send(ch, b)
		}
	}
	if self {
		if p, ok := ent.(*world.Player); ok {
			if c := s.clientOf(p); c != nil {
				_ = c.conn.Send(ch, b)
			}
		}
	}
}

// toAll sends m to every connected player.
func (s *Server) toAll(ch transport.Channel, m proto.Message) {
	b, err := proto.Marshal(m)
	if err != nil {
		return
	}
	for _, c := range s.byID {
		if c != nil {
			_ = c.conn.Send(ch, b)
		}
	}
}

// setProps updates replicated properties and sends them to streamers.
func (s *Server) setProps(ent world.Entity, props proto.Props, self bool) {
	base := ent.Base()
	hostProps := make(map[string]proto.Value, len(props))
	for id, v := range props {
		base.SetProp(id, v)
		hostProps[propKey(id)] = v
	}
	s.toStreamers(ent, transport.Reliable, &proto.EntitySetProps{Type: base.Type, EntID: base.ID, Props: props}, self)
	s.hostUpdate(ent, "props", hostProps)
}
