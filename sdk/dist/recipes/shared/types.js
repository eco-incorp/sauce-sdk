/**
 * Shared TypeScript types for swap recipes.
 */
/**
 * Bracket kinds (must match the on-chain `kind` tag).
 *
 * `EcoSwapPrepared.brackets` carries the STATIC SAMPLED-VENUE segments (every kind >= Curve,
 * referencing the per-venue lists by refIdx); it is `[]` only when no sampled venue was
 * discovered. Routes contribute NO brackets (they are first-class live-walk venues, not static
 * off-chain-composed segments), so `Route` is UNUSED by EcoSwap. `V3`/`V2` still tag
 * direct-pool brackets in the test fixtures' bracket builders.
 */
export var EcoBracketKind;
(function (EcoBracketKind) {
    EcoBracketKind[EcoBracketKind["V3"] = 0] = "V3";
    EcoBracketKind[EcoBracketKind["V2"] = 1] = "V2";
    EcoBracketKind[EcoBracketKind["Route"] = 2] = "Route";
    EcoBracketKind[EcoBracketKind["Curve"] = 3] = "Curve";
    EcoBracketKind[EcoBracketKind["LB"] = 4] = "LB";
    EcoBracketKind[EcoBracketKind["DODO"] = 5] = "DODO";
    EcoBracketKind[EcoBracketKind["SolidlyStable"] = 6] = "SolidlyStable";
    EcoBracketKind[EcoBracketKind["Wombat"] = 7] = "Wombat";
    EcoBracketKind[EcoBracketKind["BalancerStable"] = 8] = "BalancerStable";
    EcoBracketKind[EcoBracketKind["EulerSwap"] = 9] = "EulerSwap";
    EcoBracketKind[EcoBracketKind["MaverickV2"] = 10] = "MaverickV2";
    EcoBracketKind[EcoBracketKind["CryptoSwap"] = 11] = "CryptoSwap";
    EcoBracketKind[EcoBracketKind["WOOFi"] = 12] = "WOOFi";
    EcoBracketKind[EcoBracketKind["Fermi"] = 13] = "Fermi";
    EcoBracketKind[EcoBracketKind["Fluid"] = 14] = "Fluid";
    EcoBracketKind[EcoBracketKind["Mento"] = 15] = "Mento";
    EcoBracketKind[EcoBracketKind["BalancerV3"] = 16] = "BalancerV3";
})(EcoBracketKind || (EcoBracketKind = {}));
//# sourceMappingURL=types.js.map