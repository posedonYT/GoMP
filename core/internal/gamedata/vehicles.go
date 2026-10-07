package gamedata

import (
	"strings"

	"gomp/wire/proto"
)

// VehicleClass mirrors GET_VEHICLE_CLASS.
type VehicleClass uint8

const (
	ClassCompact VehicleClass = iota
	ClassSedan
	ClassSUV
	ClassCoupe
	ClassMuscle
	ClassSportsClassic
	ClassSports
	ClassSuper
	ClassMotorcycle
	ClassOffroad
	ClassIndustrial
	ClassUtility
	ClassVan
	ClassCycle
	ClassBoat
	ClassHelicopter
	ClassPlane
	ClassService
	ClassEmergency
	ClassMilitary
	ClassCommercial
	ClassTrain
)

// MaxSpeed returns a generous upper bound for a class in metres per second,
// used by the anti-cheat. It is above the fastest stock vehicle of the class.
func (c VehicleClass) MaxSpeed() float32 {
	switch c {
	case ClassCycle:
		return 35
	case ClassSuper, ClassSports, ClassMotorcycle:
		return 110
	case ClassHelicopter:
		return 110
	case ClassPlane:
		return 260
	case ClassBoat:
		return 70
	case ClassIndustrial, ClassUtility, ClassCommercial, ClassService:
		return 60
	case ClassTrain:
		return 50
	default:
		return 90
	}
}

// VehicleInfo describes a vehicle model.
type VehicleInfo struct {
	Name  string
	Hash  uint32
	Class VehicleClass
	Seats int // including the driver
}

// DefaultSeats is assumed for unknown models.
const DefaultSeats = 4

// MaxSeats caps seat indices for unknown models (buses have 16).
const MaxSeats = 16

type vdef struct {
	class VehicleClass
	seats int
	names string
}

// Stock GTA V Legacy vehicles grouped by class and seat count.
var vehicleDefs = []vdef{
	{ClassCompact, 2, "blista issi2 panto rhapsody prairie brioso"},
	{ClassCompact, 4, "dilettante asbo club kanjo"},
	{ClassSedan, 4, "asea asterope cog55 cognoscenti emperor fugitive glendale ingot intruder premier primo primo2 regina romero schafter2 stanier stratum stretch superd surge tailgater warrener washington"},
	{ClassSUV, 4, "baller baller2 bjxl cavalcade cavalcade2 contender dubsta dubsta2 fq2 granger gresley habanero huntley landstalker mesa patriot radi rocoto seminole serrano xls"},
	{ClassCoupe, 2, "cogcabrio exemplar f620 felon felon2 jackal oracle oracle2 sentinel sentinel2 windsor windsor2 zion zion2"},
	{ClassMuscle, 2, "blade buccaneer chino coquette3 dominator dukes gauntlet hotknife faction nightshade phoenix picador ratloader ruiner sabregt slamvan stalion tampa vigero virgo voodoo"},
	{ClassSportsClassic, 2, "btype casco coquette2 feltzer3 jb700 mamba manana monroe peyote pigalle stinger stingergt tornado torero ztype"},
	{ClassSports, 2, "alpha banshee bestiagts carbonizzare comet2 coquette elegy2 feltzer2 furoregt fusilade futo jester khamelion massacro ninef ninef2 penumbra rapidgt rapidgt2 schwarzer surano sultan buffalo buffalo2 kuruma"},
	{ClassSports, 4, "sultan buffalo buffalo2 kuruma kuruma2 schafter3 schafter4"},
	{ClassSuper, 2, "adder bullet cheetah entityxf fmj infernus osiris pfister811 reaper sultanrs t20 turismor tyrus vacca voltic zentorno italigtb nero tempesta"},
	{ClassMotorcycle, 2, "akuma bagger bati bati2 carbonrs daemon double faggio faggio2 hakuchou hexer innovation lectro nemesis pcj ruffian sanchez sanchez2 sovereign thrust vader vindicator enduro gargoyle cliffhanger bf400 diablous"},
	{ClassOffroad, 2, "bfinjection bifta blazer blazer2 dune rancherxl sandking2 trophytruck"},
	{ClassOffroad, 4, "bodhi2 dubsta3 mesa3 rebel rebel2 sandking kalahari brawler guardian"},
	{ClassIndustrial, 2, "bulldozer cutter dump flatbed guardian handler mixer mixer2 rubble tiptruck tiptruck2"},
	{ClassUtility, 2, "airtug caddy caddy2 docktug forklift mower ripley sadler scrap towtruck towtruck2 tractor tractor2 utillitruck utillitruck2 utillitruck3"},
	{ClassVan, 4, "bison bobcatxl boxville burrito burrito2 burrito3 camper gburrito journey minivan paradise pony rumpo rumpo2 speedo surfer youga"},
	{ClassCycle, 1, "bmx cruiser fixter scorcher tribike tribike2 tribike3"},
	{ClassBoat, 4, "dinghy dinghy2 jetmax marquis predator seashark seashark2 speeder squalo suntrap toro tropic"},
	{ClassHelicopter, 4, "buzzard buzzard2 frogger maverick polmav swift swift2 supervolito volatus"},
	{ClassHelicopter, 2, "cargobob savage valkyrie annihilator"},
	{ClassPlane, 2, "besra cuban800 dodo duster hydra lazer mammatus stunt titan velum vestra luxor shamal miljet"},
	{ClassService, 16, "bus coach airbus rentalbus tourbus"},
	{ClassService, 4, "taxi trash trash2 pbus"},
	{ClassEmergency, 4, "police police2 police3 police4 policeb policet sheriff sheriff2 fbi fbi2 pranger riot ambulance firetruk lguard"},
	{ClassMilitary, 2, "barracks barracks2 crusader rhino"},
	{ClassCommercial, 2, "benson biff hauler mule mule2 packer phantom pounder stockade"},
}

// Vehicles is a lookup table by model hash.
type Vehicles struct {
	byHash map[uint32]*VehicleInfo
}

// DefaultVehicles builds the stock vehicle table.
func DefaultVehicles() *Vehicles {
	t := &Vehicles{byHash: make(map[uint32]*VehicleInfo, 400)}
	for _, d := range vehicleDefs {
		for _, n := range strings.Fields(d.names) {
			h := proto.Joaat(n)
			if _, dup := t.byHash[h]; dup {
				// Later definitions refine seat counts for models listed twice.
				t.byHash[h].Seats = max(t.byHash[h].Seats, d.seats)
				continue
			}
			t.byHash[h] = &VehicleInfo{Name: n, Hash: h, Class: d.class, Seats: d.seats}
		}
	}
	// Motorcycles and bikes listed as 2 seats; policeb is a bike.
	if v := t.byHash[proto.Joaat("policeb")]; v != nil {
		v.Class, v.Seats = ClassMotorcycle, 2
	}
	return t
}

// Get returns model info or nil.
func (t *Vehicles) Get(hash uint32) *VehicleInfo { return t.byHash[hash] }

// Seats returns the seat count for a model (DefaultSeats when unknown).
func (t *Vehicles) Seats(hash uint32) int {
	if v := t.byHash[hash]; v != nil {
		return v.Seats
	}
	return DefaultSeats
}

// MaxSpeed returns the anti-cheat speed bound for a model.
func (t *Vehicles) MaxSpeed(hash uint32) float32 {
	if v := t.byHash[hash]; v != nil {
		return v.Class.MaxSpeed()
	}
	return ClassPlane.MaxSpeed() // unknown (possibly modded) models get the loosest bound
}

// Len returns the number of known models.
func (t *Vehicles) Len() int { return len(t.byHash) }
