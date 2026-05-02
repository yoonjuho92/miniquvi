/**
 * Phase 1 smoke test for the introspection adapter.
 *
 *   pnpm tsx scripts/introspect-smoke.ts
 *
 * Reads connection info from env (DATABASE_URL, or NEXT_PUBLIC_SUPABASE_URL +
 * SUPABASE_DB_PASSWORD), introspects a single table, and prints the result.
 * Intended for hand-verification only — not a unit test.
 */
import "dotenv/config";
import { closeAllPgPools } from "../lib/db/pool";
import {
  createIntrospector,
  supabaseConnectionFromUrl,
  type ConnectionConfig,
} from "../lib/db/introspect";

function configFromEnv(): ConnectionConfig {
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    const isSupabase = /\.supabase\.(co|com|in)$/i.test(url.hostname);
    return {
      dialect: isSupabase ? "supabase" : "postgres",
      host: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      database: url.pathname.replace(/^\//, "") || "postgres",
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    };
  }
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (projectUrl && password) {
    return supabaseConnectionFromUrl({
      projectUrl,
      password,
      port: process.env.SUPABASE_DB_PORT
        ? Number(process.env.SUPABASE_DB_PORT)
        : 5432,
    });
  }
  throw new Error(
    "Set DATABASE_URL, or NEXT_PUBLIC_SUPABASE_URL + SUPABASE_DB_PASSWORD, in .env.local",
  );
}

async function main() {
  const cfg = configFromEnv();
  const introspector = createIntrospector(cfg);

  console.log(`# dialect: ${introspector.dialect}`);

  const schemas = await introspector.listSchemas();
  console.log(`\n## schemas (${schemas.length})`);
  for (const s of schemas) {
    console.log(`  ${s.isSystem ? "(sys) " : "      "}${s.name}`);
  }

  const tables = await introspector.listTables();
  console.log(`\n## tables (${tables.length})`);
  for (const t of tables.slice(0, 20)) {
    const rows = t.rowCountEstimate >= 0 ? `~${t.rowCountEstimate}` : "?";
    console.log(`  ${t.schema}.${t.name}  [${t.kind}, ${rows} rows]`);
  }
  if (tables.length > 20) console.log(`  … and ${tables.length - 20} more`);

  const first = tables[0];
  if (first) {
    console.log(`\n## describeTable: ${first.schema}.${first.name}`);
    const detail = await introspector.describeTable(first.schema, first.name);
    console.log(`  columns:`);
    for (const c of detail.columns) {
      console.log(
        `    - ${c.name} ${c.dataType}${c.isNullable ? "" : " NOT NULL"}` +
          (c.defaultExpr ? ` DEFAULT ${c.defaultExpr}` : "") +
          (c.comment ? `  -- ${c.comment}` : ""),
      );
    }
    if (detail.primaryKey) {
      console.log(`  pk: (${detail.primaryKey.columns.join(", ")})`);
    }
    if (detail.foreignKeys.length) {
      console.log(`  fks:`);
      for (const fk of detail.foreignKeys) {
        console.log(
          `    - (${fk.columns.join(", ")}) -> ${fk.referencedSchema}.${fk.referencedTable}(${fk.referencedColumns.join(", ")})`,
        );
      }
    }
    console.log(`  indexes: ${detail.indexes.length}`);

    const sample = await introspector.sampleRows(first.schema, first.name, 3);
    console.log(`  sampleRows (${sample.length}):`);
    for (const row of sample) console.log(`    ${JSON.stringify(row)}`);
  }
}

main()
  .catch((err) => {
    console.error("smoke test failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAllPgPools();
  });
