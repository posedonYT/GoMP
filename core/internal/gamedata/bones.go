package gamedata

// BoneGroup classifies ped bones for damage multipliers.
type BoneGroup uint8

const (
	BoneTorso BoneGroup = iota
	BoneHead
	BoneLimb
)

// Ped bone tags (GET_PED_BONE_INDEX ids) of GTA V skeletons.
const (
	BoneSkelHead      = 31086
	BoneSkelNeck1     = 39317
	BoneFacialRoot    = 65068
	BoneSkelLThigh    = 58271
	BoneSkelRThigh    = 51826
	BoneSkelLCalf     = 63931
	BoneSkelRCalf     = 36864
	BoneSkelLFoot     = 14201
	BoneSkelRFoot     = 52301
	BoneSkelLUpperArm = 45509
	BoneSkelRUpperArm = 40269
	BoneSkelLForearm  = 61163
	BoneSkelRForearm  = 28252
	BoneSkelLHand     = 18905
	BoneSkelRHand     = 57005
	BoneSkelSpine0    = 23553
	BoneSkelSpine3    = 24818
	BoneSkelPelvis    = 11816
)

var boneGroups = map[uint16]BoneGroup{
	BoneSkelHead:      BoneHead,
	BoneSkelNeck1:     BoneHead,
	BoneFacialRoot:    BoneHead,
	BoneSkelLThigh:    BoneLimb,
	BoneSkelRThigh:    BoneLimb,
	BoneSkelLCalf:     BoneLimb,
	BoneSkelRCalf:     BoneLimb,
	BoneSkelLFoot:     BoneLimb,
	BoneSkelRFoot:     BoneLimb,
	BoneSkelLUpperArm: BoneLimb,
	BoneSkelRUpperArm: BoneLimb,
	BoneSkelLForearm:  BoneLimb,
	BoneSkelRForearm:  BoneLimb,
	BoneSkelLHand:     BoneLimb,
	BoneSkelRHand:     BoneLimb,
}

// BoneGroupOf classifies a bone; unknown bones count as torso.
func BoneGroupOf(bone uint16) BoneGroup {
	if g, ok := boneGroups[bone]; ok {
		return g
	}
	return BoneTorso
}
