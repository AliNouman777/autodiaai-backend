// src/utils/sql/erdToSql.ts
import { TErd } from "../../schemas/erd";
import type { DialectRenderer } from "./dialects";

type Options = {
  dialect: DialectRenderer;
  schema?: string; // only used when dialect.supportsSchema()
  addNotNull?: boolean;
  addFkIndexes?: boolean;
  addTimestampsDefault?: boolean;
  addIdentity?: boolean;
};

/** parse "table-column-left" or "table-column-right" */
function parseHandle(handle?: string) {
  if (!handle) return null;
  const m = handle.match(/^(.+?)-([^-\s]+)-(left|right)$/);
  if (!m) return null;
  const [, table, column] = m;
  return { table, column };
}

function sortBy<T>(arr: T[], proj: (x: T) => string) {
  return [...arr].sort((a, b) => proj(a).localeCompare(proj(b)));
}

export function erdToSql(erd: TErd, opts: Options) {
  const cfg = {
    addNotNull: true,
    addFkIndexes: true,
    addTimestampsDefault: true,
    addIdentity: true,
    schema: "",
    ...opts,
  };
  const d = cfg.dialect;

  type Col = { name: string; type: string; pk?: boolean; fk?: boolean };
  type FK = { col: string; refTable: string; refCol: string; name: string };
  type Table = { name: string; cols: Col[]; pks: string[]; fks: FK[] };

  const tables = new Map<string, Table>();

  // 1) collect tables
  for (const n of sortBy(erd.nodes, (x) => x.data.label)) {
    const tableName = n.data.label.trim();
    const t: Table = tables.get(tableName) || { name: tableName, cols: [], pks: [], fks: [] };
    for (const c of sortBy(n.data.schema, (x) => x.title)) {
      const col: Col = {
        name: c.title.trim(),
        type: c.type || "TEXT",
        pk: c.key === "PK",
        fk: c.key === "FK",
      };
      t.cols.push(col);
      if (col.pk) t.pks.push(col.name);
    }
    tables.set(tableName, t);
  }

  const getCol = (t: string, c: string) => tables.get(t)?.cols.find((x) => x.name === c);

  // 2) infer FKs from edges
  for (const e of erd.edges) {
    const A = parseHandle(e.sourceHandle);
    const B = parseHandle(e.targetHandle);
    if (!A || !B) continue;

    const aIsFK = !!getCol(A.table, A.column)?.fk;
    const bIsFK = !!getCol(B.table, B.column)?.fk;

    let child = B,
      parent = A;
    if (aIsFK && !bIsFK) {
      child = A;
      parent = B;
    }
    if (bIsFK && !aIsFK) {
      child = B;
      parent = A;
    }

    const childTbl = tables.get(child.table);
    const parentTbl = tables.get(parent.table);
    if (!childTbl || !parentTbl) continue;
    const childCol = getCol(child.table, child.column);
    const parentCol = getCol(parent.table, parent.column);
    if (!childCol || !parentCol) continue;

    childTbl.fks.push({
      col: child.column,
      refTable: parent.table,
      refCol: parent.column,
      name: `fk_${child.table}_${child.column}_to_${parent.table}_${parent.column}`,
    });
  }

  // 3) emit SQL
  const out: string[] = [];
  const useSchema = cfg.schema && d.supportsSchema();
  const fq = (tbl: string) => (useSchema ? `${d.q(cfg.schema!)}.${d.q(tbl)}` : d.q(tbl));

  if (useSchema) {
    out.push(`CREATE SCHEMA IF NOT EXISTS ${d.q(cfg.schema!)};`, "");
  }

  for (const [_, tbl] of sortBy([...tables], (x) => x[0])) {
    const colDefs: string[] = [];

    // determine if SQLite inline PK should suppress table-level PK (single-column PK)
    const isSqlite = d.id === "sqlite";
    const singlePk = tbl.pks.length === 1;
    const inlineSqlitePk = isSqlite && singlePk && cfg.addIdentity;

    for (const c of tbl.cols) {
      const isPK = !!c.pk;
      let typeSql = d.type(c.type);

      // identity / autoincrement
      if (cfg.addIdentity && isPK) {
        typeSql = d.identity(typeSql, true);
      }

      const parts: string[] = [];

      // In SQLite identity for PK is "INTEGER PRIMARY KEY AUTOINCREMENT" — full clause
      // so don't add extra PRIMARY KEY at table level later.
      parts.push(`${d.q(c.name)} ${typeSql}`);

      if (cfg.addNotNull && (isPK || c.fk)) {
        // SQLite inline PK already implies NOT NULL; adding NOT NULL is harmless but redundant
        if (!(inlineSqlitePk && isPK)) {
          parts.push("NOT NULL");
        }
      }

      if (cfg.addTimestampsDefault && (c.name === "created_at" || c.name === "updated_at")) {
        parts.push(`DEFAULT ${d.now()}`);
      }

      colDefs.push("  " + parts.join(" "));
    }

    // table-level PK (skip for SQLite inline PK)
    if (!inlineSqlitePk) {
      if (tbl.pks.length) {
        colDefs.push(`  PRIMARY KEY (${tbl.pks.map((c) => d.q(c)).join(", ")})`);
      }
    }

    // foreign keys
    for (const fk of tbl.fks) {
      const refTable = fq(fk.refTable);
      colDefs.push(
        `  CONSTRAINT ${d.q(fk.name)} FOREIGN KEY (${d.q(fk.col)}) REFERENCES ${refTable} (${d.q(
          fk.refCol,
        )})`,
      );
    }

    out.push(`CREATE TABLE IF NOT EXISTS ${fq(tbl.name)} (\n${colDefs.join(",\n")}\n);`, "");

    // indexes for FKs
    if (cfg.addFkIndexes) {
      for (const fk of tbl.fks) {
        out.push(
          `CREATE INDEX IF NOT EXISTS ${d.q(`${tbl.name}_${fk.col}_idx`)} ON ${fq(tbl.name)} (${d.q(
            fk.col,
          )});`,
        );
      }
      out.push("");
    }
  }

  return out.join("\n");
}
