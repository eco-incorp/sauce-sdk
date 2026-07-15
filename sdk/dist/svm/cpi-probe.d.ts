import type { Address, GetAccountInfoApi, Instruction, Rpc, SimulateTransactionApi, TransactionSigner } from '@solana/kit';
/** The instructions sysvar — its presence in a swap's account list = introspection. */
export declare const INSTRUCTIONS_SYSVAR: Address;
/** Prop-AMM integrability tier (see the module doc + docs/svm-venues.md). */
export type CpiTier = 'P-A' | 'P-B' | 'P-C';
/** One account of a venue swap, for the static screen (address + signer flag). */
export interface ScreenAccount {
    address?: Address;
    signer?: boolean;
}
export interface StaticScreenInput {
    /** The venue swap's ordered accounts. */
    accounts: readonly ScreenAccount[];
    /** The user's own signer (owner) — the ONLY permitted signer; others are gating candidates. */
    userSigner?: Address;
}
export interface StaticScreen {
    /** The Instructions sysvar rides the account list ⇒ the swap introspects. */
    introspects: boolean;
    /** Signer accounts that are NOT the user (maker seats / oracle writers). */
    foreignSigners: Address[];
    /** P-C when introspecting or foreign-signed; else P-A candidate (needs the sim to confirm). */
    candidateTier: 'P-A' | 'P-C';
    /** Human-readable reasons feeding the ledger. */
    reasons: string[];
}
/**
 * The free static screen over a swap's account list. `introspects` /
 * foreign-signer ⇒ hard P-C candidate; otherwise the pool is a P-A candidate
 * that the unrecognized-caller simulation confirms.
 */
export declare function staticCpiScreen(input: StaticScreenInput): StaticScreen;
/** ACCEPT / REJECT / DEGRADE / UNKNOWN — the simulation verdict. */
export type CpiVerdict = 'accept' | 'reject' | 'degrade' | 'unknown';
export interface AcceptanceProbeInput {
    rpc: Rpc<SimulateTransactionApi & GetAccountInfoApi>;
    /** The venue swap ix, built as an UNRECOGNIZED caller would send it (tiny input, minOut=1). */
    swapIx: Instruction;
    /** Fee payer / signer (signature not verified — sigVerify:false). */
    payer: TransactionSigner;
    /** The scratch out-ATA the swap credits — the probe reads its delta. */
    outAta: Address;
    /**
     * The venue's own off-chain quote for the probe size (e.g. referenceQuote).
     * When given, a realized delta materially below it is DEGRADE (adverse fill
     * for unrecognized flow).
     */
    expectedOut?: bigint;
    /** DEGRADE threshold in bps: delta < expectedOut·(1 − bps/1e4) ⇒ degrade. Default 500 (5%). */
    degradeBps?: number;
}
export interface AcceptanceProbe {
    verdict: CpiVerdict;
    /** The out-ATA balance delta from the simulation (0 on reject). */
    delta: bigint;
    /** CU consumed by the simulated CPI (feeds the budgeter). */
    cu?: bigint;
    /** Error / log evidence. */
    detail?: string;
}
/**
 * Runs the unrecognized-caller simulation and classifies the venue. Never
 * lands a swap; on any simulation error it returns `reject` with the error
 * detail (a gated program refuses the arbitrary caller). ACCEPT/DEGRADE split
 * on `expectedOut` when supplied.
 */
export declare function probeCpiAcceptance(input: AcceptanceProbeInput): Promise<AcceptanceProbe>;
export interface VenueClassification {
    tier: CpiTier;
    reasons: string[];
    /** True iff a P-C venue may still be quoted through the off-chain simulation best-scan lane. */
    externalScanEligible: boolean;
}
/**
 * Combine the static screen with an optional simulation verdict into the final
 * tier. Introspection is decisive P-C. Otherwise ACCEPT ⇒ P-A (public/readable
 * oracle) or P-B (proprietary internal oracle located empirically — the caller
 * distinguishes via `internalOracle`); REJECT/DEGRADE ⇒ P-C. Without a sim
 * verdict the static candidate stands (a P-A candidate stays provisional).
 */
export declare function classifyVenue(screen: StaticScreen, probe?: AcceptanceProbe, opts?: {
    internalOracle?: boolean;
}): VenueClassification;
//# sourceMappingURL=cpi-probe.d.ts.map