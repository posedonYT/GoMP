// The fields of a vehicle the Studio edits, with Russian labels, units and the
// ranges GTA V handles sensibly. Everything else stays editable as raw XML.
namespace GoMP.Studio.Vehicles;

public enum FieldKind { Text, Float, Int, Vec3, Choice, Flags }

public sealed record FieldDef(string Name, string Label, FieldKind Kind, string Unit = null, double Min = double.NaN, double Max = double.NaN,
    string Help = null, string[] Choices = null, string Group = null);

public static class VehicleSchema
{
    public static readonly string[] Classes =
    {
        "VC_COMPACT", "VC_SEDAN", "VC_SUV", "VC_COUPE", "VC_MUSCLE", "VC_SPORT_CLASSIC", "VC_SPORT", "VC_SUPER", "VC_MOTORCYCLE",
        "VC_OFF_ROAD", "VC_INDUSTRIAL", "VC_UTILITY", "VC_VAN", "VC_CYCLE", "VC_BOAT", "VC_HELICOPTER", "VC_PLANE", "VC_SERVICE",
        "VC_EMERGENCY", "VC_MILITARY", "VC_COMMERCIAL", "VC_RAIL", "VC_OPEN_WHEEL",
    };

    public static readonly string[] WheelTypes =
    {
        "VWT_SPORT", "VWT_MUSCLE", "VWT_LOWRIDER", "VWT_SUV", "VWT_OFFROAD", "VWT_TUNER", "VWT_BIKE", "VWT_HIEND", "VWT_SUPERMOD1",
        "VWT_SUPERMOD2", "VWT_SUPERMOD3", "VWT_SUPERMOD4", "VWT_SUPERMOD5", "VWT_STREET", "VWT_TRACK",
    };

    // vehicles.meta (CVehicleModelInfo__InitData).
    public static readonly FieldDef[] Data =
    {
        new("gameName", "Название в игре", FieldKind.Text, Help: "Показывается на спидометре и в меню (до 11 символов)"),
        new("vehicleMakeName", "Марка", FieldKind.Text),
        new("handlingId", "Характеристики (handlingId)", FieldKind.Text, Help: "Имя записи в handling.meta"),
        new("audioNameHash", "Звук двигателя", FieldKind.Text, Help: "Модель GTA, чей звук взять (например, FELON2, ADDER); пусто — свой звук"),
        new("vehicleClass", "Класс", FieldKind.Choice, Choices: Classes),
        new("wheelType", "Тип колёс (тюнинг)", FieldKind.Choice, Choices: WheelTypes),
        new("layout", "Посадка (layout)", FieldKind.Text),
        new("swankness", "Престиж", FieldKind.Choice, Choices: new[] { "SWANKNESS_0", "SWANKNESS_1", "SWANKNESS_2", "SWANKNESS_3", "SWANKNESS_4", "SWANKNESS_5" }),
        new("flags", "Флаги", FieldKind.Flags),
    };

    // handling.meta (CHandlingData).
    public static readonly FieldDef[] Handling =
    {
        new("fMass", "Масса", FieldKind.Float, "кг", 50, 50000, Group: "Кузов"),
        new("fInitialDragCoeff", "Сопротивление воздуха", FieldKind.Float, null, 0, 100, Group: "Кузов"),
        new("vecCentreOfMassOffset", "Смещение центра масс", FieldKind.Vec3, "м", -2, 2, Group: "Кузов"),
        new("fPercentSubmerged", "Погружение (плавучесть)", FieldKind.Float, "%", 10, 120, Group: "Кузов"),
        new("fDriveBiasFront", "Привод", FieldKind.Float, null, 0, 1, "0 — задний, 1 — передний, 0.5 — полный", Group: "Двигатель"),
        new("nInitialDriveGears", "Передач", FieldKind.Int, null, 1, 10, Group: "Двигатель"),
        new("fInitialDriveForce", "Мощность (тяга)", FieldKind.Float, null, 0.01, 2, "Обычно 0.2–0.5", Group: "Двигатель"),
        new("fDriveInertia", "Отклик двигателя", FieldKind.Float, null, 0.01, 2, Group: "Двигатель"),
        new("fClutchChangeRateScaleUpShift", "Скорость переключения вверх", FieldKind.Float, null, 0.1, 10, Group: "Двигатель"),
        new("fClutchChangeRateScaleDownShift", "Скорость переключения вниз", FieldKind.Float, null, 0.1, 10, Group: "Двигатель"),
        new("fInitialDriveMaxFlatVel", "Максимальная скорость", FieldKind.Float, "км/ч", 10, 500, "В игре фактическая скорость примерно на 20% ниже", Group: "Двигатель"),
        new("fBrakeForce", "Тормоза", FieldKind.Float, null, 0.01, 3, Group: "Тормоза и руль"),
        new("fBrakeBiasFront", "Тормоза спереди", FieldKind.Float, null, 0, 1, Group: "Тормоза и руль"),
        new("fHandBrakeForce", "Ручник", FieldKind.Float, null, 0, 5, Group: "Тормоза и руль"),
        new("fSteeringLock", "Угол поворота руля", FieldKind.Float, "°", 10, 75, Group: "Тормоза и руль"),
        new("fTractionCurveMax", "Сцепление (макс.)", FieldKind.Float, null, 0.5, 5, Group: "Шины"),
        new("fTractionCurveMin", "Сцепление (мин.)", FieldKind.Float, null, 0.5, 5, Group: "Шины"),
        new("fTractionCurveLateral", "Сцепление боком", FieldKind.Float, "°", 5, 35, Group: "Шины"),
        new("fTractionBiasFront", "Сцепление спереди", FieldKind.Float, null, 0.01, 0.99, Group: "Шины"),
        new("fLowSpeedTractionLossMult", "Пробуксовка на старте", FieldKind.Float, null, 0, 3, Group: "Шины"),
        new("fSuspensionForce", "Жёсткость подвески", FieldKind.Float, null, 0.5, 10, Group: "Подвеска"),
        new("fSuspensionCompDamp", "Демпфер сжатия", FieldKind.Float, null, 0.05, 5, Group: "Подвеска"),
        new("fSuspensionReboundDamp", "Демпфер отбоя", FieldKind.Float, null, 0.05, 5, Group: "Подвеска"),
        new("fSuspensionRaise", "Клиренс", FieldKind.Float, "м", -0.3, 0.3, Group: "Подвеска"),
        new("fAntiRollBarForce", "Стабилизатор", FieldKind.Float, null, 0, 5, Group: "Подвеска"),
        new("fCollisionDamageMult", "Урон от столкновений", FieldKind.Float, "×", 0, 10, Group: "Повреждения"),
        new("fDeformationDamageMult", "Деформация", FieldKind.Float, "×", 0, 10, Group: "Повреждения"),
        new("fEngineDamageMult", "Урон двигателю", FieldKind.Float, "×", 0, 10, Group: "Повреждения"),
        new("fPetrolTankVolume", "Бак (игры)", FieldKind.Float, "л", 0, 500, "GoMP считает бак по классу (vehicles.js)", Group: "Повреждения"),
    };

    public static FieldDef DataField(string name) => Data.FirstOrDefault(f => f.Name == name);
    public static FieldDef HandlingField(string name) => Handling.FirstOrDefault(f => f.Name == name);
}
