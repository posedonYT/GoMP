package proto

import (
	"bytes"
	"encoding/json"
	"flag"
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

var updateGolden = flag.Bool("update", false, "rewrite golden fixtures in testdata/golden")

// sampleMessages returns one representative instance of every message type.
// Values are pre-quantized so that decode(encode(m)) reproduces the same bytes.
func sampleMessages() map[string]Message {
	q := UnpackQuat(PackQuat(QuatFromEuler(Vec3{5, -3, 120})))
	return map[string]Message{
		"ped_sync": &PedSync{Time: 123456, Pos: Vec3{-1037.5, -2737.25, 20.125}, Vel: Vec3{1.25, -3.5, 0},
			Heading: DequantizeHeading(QuantizeHeading(271.5)), Move: MoveRun, Flags: PedAiming | PedCrouching,
			Weapon: Joaat("weapon_pistol"), AimPos: Vec3{-1030, -2730, 21}},
		"ped_sync_noaim": &PedSync{Time: 1, Pos: Vec3{1, 2, 3}, Move: MoveIdle, Weapon: Joaat("weapon_unarmed")},
		"player_sync_out": &PlayerSyncOut{PlayerID: 7, PedSync: PedSync{Time: 99, Pos: Vec3{10, 20, 30},
			Vel: Vec3{0.5, 0.25, -0.75}, Heading: DequantizeHeading(QuantizeHeading(90)), Move: MoveSprint, Flags: PedJumping}},
		"vehicle_sync": &VehicleSync{VehicleID: 42, Time: 5000, Pos: Vec3{200.5, -900.25, 30}, Rot: q,
			Vel: Vec3{20.5, -1.25, 0.01}, AngVel: Vec3{0.001, -0.25, 1.5}, Steer: DequantizeUnitS8(QuantizeUnitS8(-0.5)),
			Gas: DequantizeUnitS8(QuantizeUnitS8(1)), Brake: DequantizeUnitU8(QuantizeUnitU8(0.2)),
			Flags: VehEngineOn | VehLightsOn | VehDriverAiming, BodyHealth: 950, EngineHealth: -120,
			Weapon: Joaat("weapon_microsmg"), AimPos: Vec3{210, -905, 31}},
		"vehicle_sync_out":   &VehicleSyncOut{VehicleSync{VehicleID: 3, Time: 1, Rot: IdentityQuat, BodyHealth: 1000, EngineHealth: 1000}},
		"passenger_sync":     &PassengerSync{VehicleID: 42, Seat: 2, Time: 77, Flags: PedAiming, Weapon: 0x1B06D571, AimPos: Vec3{1, 1, 1}},
		"passenger_sync_out": &PassengerSyncOut{PlayerID: 4, PassengerSync: PassengerSync{VehicleID: 1, Seat: 1, Time: 9}},
		"unoccupied_sync":    &UnoccupiedSync{VehicleID: 11, Time: 3, Pos: Vec3{5, 6, 7}, Rot: q, Vel: Vec3{1, 0, 0}, AngVel: Vec3{0, 0, 0.5}},
		"weapon_shot":        &WeaponShot{Seq: 65535, Time: 10, Weapon: Joaat("weapon_carbinerifle"), Origin: Vec3{1, 2, 3}, Target: Vec3{4, 5, 6}},
		"weapon_shot_out":    &WeaponShotOut{PlayerID: 1, WeaponShot: WeaponShot{Seq: 1, Weapon: 2, Origin: Vec3{1, 1, 1}, Target: Vec3{2, 2, 2}}},
		"weapon_hit": &WeaponHit{ShotSeq: 12, Weapon: Joaat("weapon_pistol"), Flags: 0, TargetType: EntityPlayer, TargetID: 3,
			Bone: 31086, HitPos: Vec3{9, 8, 7}},
		"self_damage":            &SelfDamage{Cause: CauseFall, Health: 25, Armour: 0},
		"enter_vehicle_request":  &EnterVehicleRequest{VehicleID: 5, Seat: SeatAny},
		"enter_vehicle_response": &EnterVehicleResponse{VehicleID: 5, Seat: 0, Result: EnterAllowed},
		"enter_vehicle_complete": &EnterVehicleComplete{VehicleID: 5, Seat: 0, Aborted: true},
		"exit_vehicle_request":   &ExitVehicleRequest{},
		"exit_vehicle_complete":  &ExitVehicleComplete{},
		"put_into_vehicle":       &PutIntoVehicle{VehicleID: NoID, Seat: 0},
		"vehicle_task":           &VehicleTask{PlayerID: 2, Task: TaskEnterStart, VehicleID: 5, Seat: 1},
		"controller_assign":      &ControllerAssign{VehicleID: 8, Controlled: true},
		"vehicle_explode":        &VehicleExplode{VehicleID: 8},
		"teleport_ack":           &TeleportAck{Seq: 4},
		"ready":                  &Ready{},
		"welcome": &Welcome{PlayerID: 0, ServerName: "GoMP RP", GameMode: "freeroam", TickRate: 30, StreamDistance: 300,
			Hour: 12, Minute: 30, Weather: "EXTRASUNNY"},
		"set_position": &SetPosition{Seq: 9, Reason: PosSpawn, Pos: Vec3{-425.5, 1123.25, 325.75}, Heading: 180},
		"loadout": &Loadout{Current: Joaat("weapon_pistol"), Weapons: []WeaponAmmo{
			{Hash: Joaat("weapon_pistol"), Ammo: 120}, {Hash: Joaat("weapon_knife"), Ammo: 1}}},
		"entity_create": &EntityCreate{Type: EntityVehicle, EntID: 17, Model: Joaat("adder"), Pos: Vec3{1, 2, 3}, Rot: Vec3{0, 0, 90},
			Props: Props{PropColors: []Value{int64(5), int64(12)}, PropNumberPlate: "GOMP", PropEngine: true, PropBodyHealth: 1000.0},
			Shared: map[string]Value{"owner": "Alice", "fuel": 63.5, "tags": []Value{"rent", int64(3)},
				"meta": map[string]Value{"pos": Vec3{1, 2, 3}, "who": EntityRef{Type: EntityPlayer, ID: 2}, "none": nil}}},
		"entity_destroy":   &EntityDestroy{Type: EntityPlayer, EntID: 3},
		"entity_set_props": &EntitySetProps{Type: EntityPlayer, EntID: 3, Props: Props{PropHealth: int64(50), PropName: "Bob"}},
		"shared_data":      &SharedData{Type: EntityPlayer, EntID: 3, Own: true, Values: map[string]Value{"money": int64(-5), "deleted": nil}},
		"chat":             &Chat{Text: "Привет, мир! /veh adder"},
		"script_event":     &ScriptEvent{Name: "client:notify", Args: []Value{"hi", int64(42), 1.5, true, false, nil}},
		"proc_call":        &ProcCall{CallID: 77, Name: "getMoney", Args: []Value{EntityRef{Type: EntityVehicle, ID: 1}}},
		"proc_result_ok":   &ProcResult{CallID: 77, OK: true, Result: int64(1000)},
		"proc_result_err":  &ProcResult{CallID: 78, OK: false, Error: "no such proc"},
		"world":            &World{Hour: 23, Minute: 59, Second: 1, Weather: "RAIN", TransitionMs: 5000},
		"ipl":              &Ipl{Name: "shr_int", Load: true},
		"notify":           &Notify{Text: "~g~Welcome"},
		"invoke":           &Invoke{Hash: 0x4E3C0D, Args: []Value{int64(1), 2.5, "x", true}},
		"play_anim":        &PlayAnim{PlayerID: 1, Dict: "mp_player_int_upperwave", Name: "mp_player_int_wave", Speed: 8, Flag: 49},
	}
}

func TestRoundTripAllMessages(t *testing.T) {
	seen := map[MsgID]bool{}
	for name, m := range sampleMessages() {
		t.Run(name, func(t *testing.T) {
			b, err := Marshal(m)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			got, err := Unmarshal(b)
			if err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if reflect.TypeOf(got) != reflect.TypeOf(m) {
				t.Fatalf("type %T, want %T", got, m)
			}
			b2, err := Marshal(got)
			if err != nil {
				t.Fatalf("re-marshal: %v", err)
			}
			if !bytes.Equal(b, b2) {
				t.Fatalf("re-encoding differs:\n%x\n%x", b, b2)
			}
		})
		seen[m.ID()] = true
	}
	for id := 0; id < 256; id++ {
		if _, ok := New(MsgID(id)); ok && !seen[MsgID(id)] {
			t.Errorf("message 0x%02x has no sample", id)
		}
	}
}

func TestDecodeExactFields(t *testing.T) {
	in := &EntityCreate{Type: EntityPlayer, EntID: 9, Model: 1, Props: Props{PropName: "x", PropHealth: 100},
		Shared: map[string]Value{"a": []Value{1, "b"}}}
	b, _ := Marshal(in)
	out, err := Unmarshal(b)
	if err != nil {
		t.Fatal(err)
	}
	ec := out.(*EntityCreate)
	if ec.Props[PropHealth] != int64(100) || ec.Props[PropName] != "x" {
		t.Fatalf("props: %#v", ec.Props)
	}
	if !reflect.DeepEqual(ec.Shared["a"], NormalizeValue([]Value{1, "b"})) {
		t.Fatalf("shared: %#v", ec.Shared)
	}
}

func TestTruncatedMessagesFail(t *testing.T) {
	for name, m := range sampleMessages() {
		b, _ := Marshal(m)
		for n := 1; n < len(b); n++ {
			if _, err := Unmarshal(b[:n]); err == nil {
				// A prefix may only decode if it is itself a valid complete message,
				// which is impossible here because every sample has fixed fields.
				t.Errorf("%s: truncated to %d/%d decoded without error", name, n, len(b))
			}
		}
		if _, err := Unmarshal(append(append([]byte{}, b...), 0)); err == nil {
			t.Errorf("%s: trailing byte accepted", name)
		}
	}
}

func TestUnknownMessage(t *testing.T) {
	if _, err := Unmarshal([]byte{0x01}); err == nil {
		t.Fatal("unknown id accepted")
	}
	if _, err := Unmarshal(nil); err == nil {
		t.Fatal("empty buffer accepted")
	}
}

func TestValueRoundTrip(t *testing.T) {
	vals := []Value{nil, true, false, int64(0), int64(-1), int64(math.MaxInt64), int64(math.MinInt64),
		0.0, -1.5, math.Inf(1), "", "строка", []Value{}, map[string]Value{},
		Vec3{1, 2, 3}, EntityRef{Type: EntityVehicle, ID: 65534},
		[]Value{[]Value{[]Value{int64(1)}}}, map[string]Value{"k": map[string]Value{"n": nil}}}
	for _, v := range vals {
		var w Writer
		if err := w.Value(v); err != nil {
			t.Fatal(err)
		}
		r := NewReader(w.Bytes())
		got := r.Value()
		if r.Err() != nil || r.Remaining() != 0 {
			t.Fatalf("%#v: err=%v rem=%d", v, r.Err(), r.Remaining())
		}
		if !reflect.DeepEqual(got, NormalizeValue(v)) {
			t.Fatalf("got %#v want %#v", got, v)
		}
	}
	// Go numeric types normalize to int64/float64.
	var w Writer
	_ = w.Value(uint16(7))
	if got := NewReader(w.Bytes()).Value(); got != int64(7) {
		t.Fatalf("uint16 -> %#v", got)
	}
	if err := (&Writer{}).Value(struct{}{}); err == nil {
		t.Fatal("unsupported type accepted")
	}
}

func TestValueDepthLimit(t *testing.T) {
	var v Value = int64(1)
	for i := 0; i < MaxValueDepth+2; i++ {
		v = []Value{v}
	}
	if err := (&Writer{}).Value(v); err == nil {
		t.Fatal("deep value encoded")
	}
	// Hand-craft an over-deep array on the wire.
	b := bytes.Repeat([]byte{TagArray, 1}, MaxValueDepth+2)
	b = append(b, TagNil)
	r := NewReader(b)
	r.Value()
	if r.Err() == nil {
		t.Fatal("deep value decoded")
	}
}

func TestHugeLengthPrefixRejected(t *testing.T) {
	// Array claiming 2^40 elements must fail fast without allocating.
	var w Writer
	w.U8(TagArray)
	w.Uvarint(1 << 40)
	r := NewReader(w.Bytes())
	r.Value()
	if r.Err() == nil {
		t.Fatal("huge array accepted")
	}
}

func TestJoaat(t *testing.T) {
	// Well-known GTA V hashes.
	cases := map[string]uint32{
		"adder":            0xB779A091,
		"weapon_pistol":    0x1B06D571,
		"WEAPON_PISTOL":    0x1B06D571,
		"mp_m_freemode_01": 0x705E61F2,
	}
	for s, want := range cases {
		if got := Joaat(s); got != want {
			t.Errorf("Joaat(%q) = %#x, want %#x", s, got, want)
		}
	}
}

// TestGolden writes/validates cross-language fixtures consumed by the C++ client tests.
func TestGolden(t *testing.T) {
	dir := filepath.Join("testdata", "golden")
	type index struct {
		Name string `json:"name"`
		ID   uint8  `json:"id"`
		File string `json:"file"`
	}
	var idx []index
	for name, m := range sampleMessages() {
		b, err := Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		file := name + ".bin"
		path := filepath.Join(dir, file)
		if *updateGolden {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, b, 0o644); err != nil {
				t.Fatal(err)
			}
		} else {
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("missing golden %s (run go test ./wire/proto -update): %v", path, err)
			}
			if !bytes.Equal(want, b) {
				t.Errorf("golden %s differs from current encoding; run with -update if intended", file)
			}
		}
		idx = append(idx, index{Name: name, ID: uint8(m.ID()), File: file})
	}
	if *updateGolden {
		// Stable order for the index file.
		for i := range idx {
			for j := i + 1; j < len(idx); j++ {
				if idx[j].Name < idx[i].Name {
					idx[i], idx[j] = idx[j], idx[i]
				}
			}
		}
		js, _ := json.MarshalIndent(idx, "", "  ")
		if err := os.WriteFile(filepath.Join(dir, "index.json"), js, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func FuzzUnmarshal(f *testing.F) {
	for _, m := range sampleMessages() {
		b, _ := Marshal(m)
		f.Add(b)
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		m, err := Unmarshal(b)
		if err != nil {
			return
		}
		// Anything that decodes must re-encode without error.
		if _, err := Marshal(m); err != nil {
			t.Fatalf("decoded message does not re-encode: %v", err)
		}
	})
}

func FuzzValue(f *testing.F) {
	f.Add([]byte{TagArray, 2, TagInt, 4, TagString, 1, 'x'})
	f.Fuzz(func(t *testing.T, b []byte) {
		r := NewReader(b)
		v := r.Value()
		if r.Err() != nil {
			return
		}
		var w Writer
		if err := w.Value(v); err != nil {
			t.Fatalf("re-encode: %v", err)
		}
	})
}

func BenchmarkPedSyncEncode(b *testing.B) {
	m := sampleMessages()["ped_sync"]
	w := NewWriter(make([]byte, 0, 128))
	b.ReportAllocs()
	for b.Loop() {
		w.Reset()
		_ = Encode(w, m)
	}
}

func BenchmarkPedSyncDecode(b *testing.B) {
	buf, _ := Marshal(sampleMessages()["ped_sync"])
	var m PedSync
	b.ReportAllocs()
	for b.Loop() {
		_ = DecodeInto(buf, &m)
	}
}

func randUnitQuat(rng *rand.Rand) Quat {
	return Quat{float32(rng.NormFloat64()), float32(rng.NormFloat64()), float32(rng.NormFloat64()), float32(rng.NormFloat64())}.Normalize()
}
