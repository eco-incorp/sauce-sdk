type BuilderNode = {
    _bytes: Uint8Array;
};
export declare const encodeArray: (elements: BuilderNode[]) => Uint8Array;
export declare const encodeIndex: (index: BuilderNode, array: BuilderNode) => Uint8Array;
export declare const encodeSetIndex: (value: BuilderNode, index: BuilderNode, array: BuilderNode) => Uint8Array;
export declare const encodeNewArray: (count: BuilderNode) => Uint8Array;
export declare const isImmutablePackedArray: (bytes: Uint8Array) => boolean;
export {};
//# sourceMappingURL=array.d.ts.map