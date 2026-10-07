package hostbridge

import (
	"bufio"
	"encoding/binary"
	"net"
	"sync"

	"gomp/wire/proto"
)

// HostClient is the host side of the IPC connection, used by Go test hosts.
// The Node.js runtime implements the same protocol in runtimes/node.
type HostClient struct {
	conn net.Conn
	r    *bufio.Reader
	mu   sync.Mutex
}

// Dial connects and authenticates as host name.
func Dial(network, addr, token, name string) (*HostClient, error) {
	c, err := net.Dial(network, addr)
	if err != nil {
		return nil, err
	}
	hc := &HostClient{conn: c, r: bufio.NewReaderSize(c, 64<<10)}
	if err := hc.Send(Op{CmdAuth, token, name}); err != nil {
		c.Close()
		return nil, err
	}
	return hc, nil
}

// Send writes ops as one frame.
func (c *HostClient) Send(ops ...Op) error {
	arr := make([]proto.Value, len(ops))
	for i, op := range ops {
		arr[i] = op
	}
	w := proto.NewWriter(make([]byte, 0, 256))
	w.Raw([]byte{0, 0, 0, 0}) // length prefix, patched below
	if err := w.Value(arr); err != nil {
		return err
	}
	frame := w.Bytes()
	binary.LittleEndian.PutUint32(frame, uint32(len(frame)-4))
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err := c.conn.Write(frame)
	return err
}

// Recv reads the next frame of ops.
func (c *HostClient) Recv() ([]Op, error) {
	frame, err := readFrame(c.r, defaultFrame)
	if err != nil {
		return nil, err
	}
	return decodeOps(frame)
}

// Close closes the connection.
func (c *HostClient) Close() error { return c.conn.Close() }
