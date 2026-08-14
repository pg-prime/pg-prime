import type { AnyRef } from './ref.js';
/**
 * Table-level nodes (design/05 D5): one heterogeneous array of tagged nodes,
 * extensible by extension packs without an API change.
 *
 * The spike carries a representative subset — enough to prove that the extras
 * callback receives the table's pre-computed `[REFS]` slot.
 */
export type TableExtra = {
    readonly node: 'primaryKey';
    readonly name: string | undefined;
    readonly columns: readonly string[];
} | {
    readonly node: 'index';
    readonly name: string;
    readonly unique: boolean;
    readonly columns: readonly string[];
} | {
    readonly node: 'comment';
    readonly text: string;
};
export declare function primaryKey(...refs: AnyRef[]): TableExtra;
declare class IndexBuilder {
    #private;
    constructor(name: string, unique: boolean);
    on(...refs: AnyRef[]): TableExtra;
}
export declare function index(name: string): IndexBuilder;
export declare function uniqueIndex(name: string): IndexBuilder;
export declare function comment(text: string): TableExtra;
export {};
