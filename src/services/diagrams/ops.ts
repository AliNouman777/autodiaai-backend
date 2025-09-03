export type CanonicalKey = "NONE" | "PK" | "FK" | "UNIQUE";

const KEY_MAP: Record<string, CanonicalKey> = {
  NONE: "NONE",
  PRIMARY: "PK",
  PK: "PK",
  FOREIGN: "FK",
  FK: "FK",
  UNIQUE: "UNIQUE",
};

export function toCanonicalKey(k: unknown): CanonicalKey {
  const up = String(k ?? "NONE").toUpperCase();
  return KEY_MAP[up] ?? "NONE";
}

type Op =
  | {
      op: "add_field";
      tableId: string;
      id: string;
      title: string;
      type: string;
      key?: "NONE" | "PRIMARY" | "UNIQUE" | "FOREIGN";
    }
  | { op: "rename_table"; oldId: string; newId: string; newLabel?: string }
  | { op: "delete_field"; tableId: string; fieldId: string };

const clone = <T>(v: T): T => {
  try {
    // @ts-ignore
    return typeof structuredClone === "function"
      ? structuredClone(v)
      : JSON.parse(JSON.stringify(v));
  } catch {
    return JSON.parse(JSON.stringify(v));
  }
};

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function rewriteHandlesForFieldRename(diagram: any, oldFieldId: string, newFieldId: string) {
  const from = new RegExp(`^${escapeRegExp(oldFieldId)}-(left|right)$`, "i");
  const to = (side: string) => `${newFieldId}-${side}`;
  for (const e of diagram.edges ?? []) {
    if (typeof e.sourceHandle === "string" && from.test(e.sourceHandle)) {
      const side = e.sourceHandle.toLowerCase().endsWith("left") ? "left" : "right";
      e.sourceHandle = to(side);
    }
    if (typeof e.targetHandle === "string" && from.test(e.targetHandle)) {
      const side = e.targetHandle.toLowerCase().endsWith("left") ? "left" : "right";
      e.targetHandle = to(side);
    }
  }
}

export function removeEdgesTouchingField(diagram: any, fieldId: string) {
  const startsWith = new RegExp(`^${escapeRegExp(fieldId)}-(left|right)$`, "i");
  diagram.edges = (diagram.edges ?? []).filter(
    (e: any) => !(startsWith.test(e.sourceHandle || "") || startsWith.test(e.targetHandle || "")),
  );
}

function rewriteEdgesOnTableRename(edges: any[], oldId: string, newId: string) {
  for (const e of edges) {
    if (e.source === oldId) e.source = newId;
    if (e.target === oldId) e.target = newId;
  }
}

export function applyOpsInMemory(doc: any, ops: Op[]) {
  const nodes: any[] = clone(doc.nodes ?? []);
  const edges: any[] = clone(doc.edges ?? []);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const getSchema = (t: any) => ((t.data ||= { label: t.id, schema: [] }).schema ||= []);

  for (const raw of ops) {
    if (raw.op === "add_field") {
      const t = byId.get(raw.tableId);
      if (!t) throw new Error("Table not found");
      const s = getSchema(t);
      if (s.some((f: any) => f.id === raw.id)) throw new Error("Field id exists");
      s.push({
        id: raw.id,
        title: raw.title,
        type: raw.type,
        key: toCanonicalKey(raw.key),
        nullable: true,
        default: null,
      });
    } else if (raw.op === "rename_table") {
      const t = byId.get(raw.oldId);
      if (!t) throw new Error("Table not found");
      if (byId.has(raw.newId)) throw new Error("New table id exists");
      t.id = raw.newId;
      t.data = { ...(t.data || {}), label: raw.newLabel ?? t?.data?.label ?? raw.newId };
      rewriteEdgesOnTableRename(edges, raw.oldId, raw.newId);
      byId.delete(raw.oldId);
      byId.set(raw.newId, t);
    } else if (raw.op === "delete_field") {
      const t = byId.get(raw.tableId);
      if (!t) throw new Error("Table not found");
      const s = getSchema(t);
      const before = s.length;
      t.data.schema = s.filter((f: any) => f.id !== raw.fieldId);
      if (t.data.schema.length === before) throw new Error("Field not found");
      removeEdgesTouchingField({ edges }, raw.fieldId);
    }
  }
  return { nodes: Array.from(byId.values()), edges };
}
