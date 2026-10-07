package proto

import "fmt"

// ClientVersion is the protocol revision spoken by this package. The server
// rejects clients with a different value.
const ClientVersion = 1

// ConnectInfo is the payload of the transport CONNECT packet.
type ConnectInfo struct {
	Version    uint16
	Name       string
	Serial     string // hardware-derived client identifier
	SocialClub string
	RGSCID     string
	GameType   string // "gta5"
	Build      uint32 // game build number
}

// Marshal encodes the connect info.
func (c *ConnectInfo) Marshal() []byte {
	w := NewWriter(make([]byte, 0, 64))
	w.U16(c.Version)
	w.String(c.Name)
	w.String(c.Serial)
	w.String(c.SocialClub)
	w.String(c.RGSCID)
	w.String(c.GameType)
	w.U32(c.Build)
	return w.Bytes()
}

// ParseConnectInfo decodes a connect payload.
func ParseConnectInfo(b []byte) (ConnectInfo, error) {
	r := NewReader(b)
	c := ConnectInfo{
		Version:    r.U16(),
		Name:       r.String(),
		Serial:     r.String(),
		SocialClub: r.String(),
		RGSCID:     r.String(),
		GameType:   r.String(),
		Build:      r.U32(),
	}
	if r.Err() != nil {
		return ConnectInfo{}, fmt.Errorf("connect info: %w", r.Err())
	}
	return c, nil
}
