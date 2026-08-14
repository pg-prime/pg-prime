import type { Fact } from "../ir/fact.js";
import type { StableId } from "../ir/stable-id.js";

export type Delta =
  | { readonly op: "create"; readonly id: StableId; readonly fact: Fact }
  | { readonly op: "drop"; readonly id: StableId; readonly fact: Fact }
  | { readonly op: "alter"; readonly id: StableId; readonly before: Fact; readonly after: Fact }
  | { readonly op: "rename"; readonly from: StableId; readonly to: StableId; readonly fact: Fact }
  /** enum label appended to an existing type, with its ordering anchor */
  | {
      readonly op: "addEnumValue";
      readonly id: StableId;
      readonly anchor: { readonly position: "BEFORE" | "AFTER"; readonly label: string } | null;
    };

export const deltaSubject = (d: Delta): StableId => (d.op === "rename" ? d.to : d.id);

/** Rename hints are an INPUT (annotation-first, D5). Nothing here infers them. */
export interface RenameHint {
  readonly from: StableId | string;
  readonly to: StableId | string;
}

export interface RenameRecord {
  readonly kind: string;
  readonly from: string;
  readonly to: string;
  readonly source: "annotation";
  readonly confidence: "unambiguous";
}
