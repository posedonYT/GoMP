package proto

// EntityType enumerates replicated entity kinds. String() returns the RAGE.MP
// `entity.type` name.
type EntityType uint8

const (
	EntityNone       EntityType = 0
	EntityPlayer     EntityType = 1
	EntityVehicle    EntityType = 2
	EntityObject     EntityType = 3
	EntityPed        EntityType = 4
	EntityBlip       EntityType = 5
	EntityCheckpoint EntityType = 6
	EntityMarker     EntityType = 7
	EntityColshape   EntityType = 8
	EntityTextLabel  EntityType = 9
	EntityDummy      EntityType = 10

	EntityTypeCount = 11
)

var entityTypeNames = [EntityTypeCount]string{
	"", "player", "vehicle", "object", "ped", "blip", "checkpoint", "marker", "colshape", "textlabel", "dummy",
}

func (t EntityType) String() string {
	if int(t) < len(entityTypeNames) {
		return entityTypeNames[t]
	}
	return "unknown"
}

// ParseEntityType is the inverse of EntityType.String.
func ParseEntityType(s string) (EntityType, bool) {
	for i, n := range entityTypeNames {
		if i > 0 && n == s {
			return EntityType(i), true
		}
	}
	return EntityNone, false
}

// NoID marks the absence of an entity id (for example "not in a vehicle").
const NoID uint16 = 0xFFFF

// GlobalDimension makes an entity visible in every dimension.
const GlobalDimension uint32 = 0xFFFFFFFF

// SeatDriver is the driver seat. Passenger seats are 1..N (RAGE.MP 1.1 numbering).
const SeatDriver uint8 = 0

// SeatAny asks the server to pick the first free seat.
const SeatAny uint8 = 0xFF

// MoveState is the locomotion speed class of a ped.
type MoveState uint8

const (
	MoveIdle MoveState = iota
	MoveWalk
	MoveRun
	MoveSprint
)

// PedFlags carries boolean ped states in PedSync.
type PedFlags uint16

const (
	PedAiming PedFlags = 1 << iota
	PedReloading
	PedInMelee
	PedJumping
	PedClimbing
	PedOnLadder
	PedInCover
	PedCrouching
	PedRagdoll
	PedFalling
	PedParachuting
	PedSwimming
	PedEnteringVehicle
	PedLeavingVehicle
)

// VehicleFlags carries boolean vehicle states in VehicleSync.
type VehicleFlags uint16

const (
	VehEngineOn VehicleFlags = 1 << iota
	VehLightsOn
	VehHighBeams
	VehHorn
	VehSiren
	VehHandbrake
	VehDriverAiming
	VehDestroyed
)

// PropID identifies a replicated entity property in EntityCreate/EntitySetProps.
type PropID uint8

const (
	// Common
	PropModel    PropID = 1
	PropPosition PropID = 2 // Vec3, teleports non-player entities
	PropRotation PropID = 3 // Vec3 Euler degrees
	PropAlpha    PropID = 5 // int 0..255
	PropFrozen   PropID = 6 // bool (objects)

	// Player / ped
	PropName         PropID = 10 // string
	PropHealth       PropID = 11 // int 0..100
	PropArmour       PropID = 12 // int 0..100
	PropWeapon       PropID = 13 // int weapon hash (current)
	PropHeading      PropID = 14 // float degrees
	PropClothes      PropID = 15 // map["<component>"] = [drawable, texture, palette]
	PropAccessories  PropID = 16 // map["<prop>"] = [drawable, texture]
	PropHeadBlend    PropID = 17 // [9 numbers]
	PropFaceFeatures PropID = 18 // map["<index>"] = float
	PropHeadOverlays PropID = 19 // map["<overlay>"] = [index, opacity, color1, color2]
	PropDecorations  PropID = 20 // map["<collection>"] = overlay
	PropHairColor    PropID = 21 // [color, highlight]
	PropEyeColor     PropID = 22 // int
	PropDead         PropID = 23 // bool
	PropVehicle      PropID = 24 // [vehicleId, seat] or nil
	PropInvincible   PropID = 25 // bool (peds)
	PropDynamic      PropID = 26 // bool (peds)
	PropWalkingStyle PropID = 27 // string
	PropGameType     PropID = 28 // string

	// Vehicle
	PropColors          PropID = 30 // [primary, secondary] palette
	PropColorRGB        PropID = 31 // [r1,g1,b1,r2,g2,b2]
	PropNumberPlate     PropID = 32 // string
	PropEngine          PropID = 33 // bool
	PropLocked          PropID = 34 // bool
	PropBodyHealth      PropID = 35 // float
	PropEngineHealth    PropID = 36 // float
	PropLivery          PropID = 38 // int
	PropMods            PropID = 39 // map["<modType>"] = index
	PropNeon            PropID = 40 // [enabled, r, g, b]
	PropWindowTint      PropID = 41 // int
	PropWheelType       PropID = 42 // int
	PropWheelColor      PropID = 43 // int
	PropPearlColor      PropID = 44 // int
	PropExtras          PropID = 45 // map["<index>"] = bool
	PropSiren           PropID = 46 // bool
	PropTaxiLights      PropID = 47 // bool
	PropMovable         PropID = 48 // bool
	PropDashboardColor  PropID = 49 // int
	PropTrimColor       PropID = 50 // int
	PropNumberPlateType PropID = 51 // int
	PropCustomTires     PropID = 52 // bool
	PropPaint           PropID = 53 // [primaryType, primaryColor, secondaryType, secondaryColor]

	// Blip
	PropBlipSprite       PropID = 60
	PropBlipColor        PropID = 61
	PropBlipName         PropID = 62
	PropBlipScale        PropID = 63
	PropBlipShortRange   PropID = 64
	PropBlipDrawDistance PropID = 65
	PropBlipRotation     PropID = 66

	// Marker
	PropMarkerType      PropID = 70
	PropMarkerScale     PropID = 71
	PropMarkerColor     PropID = 72 // [r,g,b,a]
	PropMarkerDirection PropID = 73
	PropVisible         PropID = 74

	// Checkpoint
	PropCheckpointType   PropID = 80
	PropCheckpointRadius PropID = 81
	PropCheckpointColor  PropID = 82 // [r,g,b,a]
	PropDestination      PropID = 83

	// Text label
	PropLabelText         PropID = 90
	PropLabelColor        PropID = 91 // [r,g,b,a]
	PropLabelDrawDistance PropID = 92
	PropLabelLOS          PropID = 93
	PropLabelFont         PropID = 94
)

// Props is a set of replicated properties.
type Props map[PropID]Value

// SetPositionReason tells the client why the server moved it.
type SetPositionReason uint8

const (
	PosTeleport   SetPositionReason = 0
	PosCorrection SetPositionReason = 1
	PosSpawn      SetPositionReason = 2
)

// VehicleTaskKind is the animation a remote player plays relative to a vehicle.
type VehicleTaskKind uint8

const (
	TaskEnterStart VehicleTaskKind = 1 // walk to the door and get in
	TaskEnterWarp  VehicleTaskKind = 2 // place into seat immediately
	TaskExitStart  VehicleTaskKind = 3 // play the exit animation
	TaskExitWarp   VehicleTaskKind = 4 // remove from the vehicle immediately
)

// DamageCause classifies environment damage reported by the client.
type DamageCause uint8

const (
	CauseOther     DamageCause = 0
	CauseFall      DamageCause = 1
	CauseFire      DamageCause = 2
	CauseDrown     DamageCause = 3
	CauseVehicle   DamageCause = 4
	CauseExplosion DamageCause = 5
)

// HitFlags qualify a WeaponHit.
type HitFlags uint8

const (
	HitMelee HitFlags = 1 << iota
)

// EnterResult answers an EnterVehicleRequest.
type EnterResult uint8

const (
	EnterAllowed     EnterResult = 0
	EnterNoVehicle   EnterResult = 1
	EnterTooFar      EnterResult = 2
	EnterLocked      EnterResult = 3
	EnterSeatTaken   EnterResult = 4
	EnterInvalidSeat EnterResult = 5
	EnterBusy        EnterResult = 6
)
