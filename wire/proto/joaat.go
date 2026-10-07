package proto

// Joaat is Jenkins' one-at-a-time hash used by GTA V for model, weapon and
// native names. Input is lower-cased (ASCII), matching mp.joaat in RAGE.MP.
func Joaat(s string) uint32 {
	var h uint32
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		h += uint32(c)
		h += h << 10
		h ^= h >> 6
	}
	h += h << 3
	h ^= h >> 11
	h += h << 15
	return h
}
