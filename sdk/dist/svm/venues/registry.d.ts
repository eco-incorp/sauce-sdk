import type { SvmVenueAdapter, SvmVenueLadderV2 } from './types.js';
/** Known venue slugs, in table order. */
export declare function listVenues(): string[];
/** Looks up a venue adapter by slug; throws listing the known slugs. */
export declare function venueAdapter(slug: string): SvmVenueAdapter;
/** Known ladder-family slugs, in table order. */
export declare function listLadderVenues(): string[];
/** Looks up a ladder-adapter (v2) by slug; throws listing the known slugs. */
export declare function ladderVenueAdapter(slug: string): SvmVenueLadderV2;
//# sourceMappingURL=registry.d.ts.map