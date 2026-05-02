/**
 * Phase 2/3 builder runner.
 *
 *   pnpm catalog:build                       # incremental (TTL-aware)
 *   pnpm catalog:build -- --force            # rebuild every table
 *   pnpm catalog:build -- --refresh public.orders   # refresh one table
 */
import "dotenv/config";
import { closeAllPgPools, connectionId } from "../lib/db/pool";
import {
  createIntrospector,
  supabaseConnectionFromUrl,
  type ConnectionConfig,
} from "../lib/db/introspect";
import { ensureCatalog, refreshTable } from "../lib/catalog";

function configFromEnv(): ConnectionConfig {
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    const isSupabase =
      /\.supabase\.(co|com|in)$/i.test(url.hostname) ||
      /supabase\.com$/i.test(url.hostname);
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

interface CliArgs {
  force: boolean;
  refresh: { schema: string; name: string } | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { force: false, refresh: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") args.force = true;
    else if (a === "--refresh") {
      const fqn = argv[++i];
      if (!fqn || !fqn.includes(".")) {
        throw new Error("--refresh expects <schema>.<table>");
      }
      const [schema, ...rest] = fqn.split(".");
      args.refresh = { schema: schema!, name: rest.join(".") };
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = configFromEnv();
  const introspector = createIntrospector(cfg);
  const id = connectionId(cfg);

  if (args.refresh) {
    console.log(
      `# refreshing ${args.refresh.schema}.${args.refresh.name} for ${id} (${introspector.dialect})`,
    );
    const profile = await refreshTable(
      cfg,
      introspector,
      args.refresh.schema,
      args.refresh.name,
    );
    if (!profile) {
      console.log("table no longer exists in source DB — catalog reconciled.");
    } else {
      console.log(
        `refreshed: ${profile.schema}.${profile.name} (sampledSkipped=${profile.sampledSkipped})`,
      );
    }
    return;
  }

  console.log(
    `# ${args.force ? "force-rebuilding" : "ensuring"} catalog for ${id} (${introspector.dialect})`,
  );
  const result = await ensureCatalog(cfg, introspector, {
    force: args.force,
    onProgress: (e) => {
      switch (e.kind) {
        case "schemas-listed":
          console.log(`schemas: ${e.schemas.join(", ")}`);
          break;
        case "tables-listed":
          console.log(`live tables: ${e.tables.length}`);
          break;
        case "plan":
          console.log(
            `plan: ${e.build} build · ${e.reuse} reuse · ${e.drop} drop`,
          );
          break;
        case "no-changes":
          console.log("cache hit — nothing to do");
          break;
        case "table-start":
          console.log(`  → ${e.schema}.${e.name}`);
          break;
        case "table-done":
          console.log(
            `    ✓ ${e.schema}.${e.name} (${e.durationMs}ms${e.sampledSkipped ? ", samples skipped" : ""})`,
          );
          break;
        case "table-reused":
          console.log(`    · ${e.schema}.${e.name} (reused)`);
          break;
        case "table-dropped":
          console.log(`    × ${e.schema}.${e.name} (dropped)`);
          break;
        case "graph-built":
          console.log(`graph: ${e.nodes} nodes, ${e.edges} edges`);
          break;
        case "written":
          console.log(`written → ${e.root}`);
          break;
      }
    },
  });

  console.log("\nDone.");
  console.log(
    `  rebuilt: ${result.rebuilt.length}, reused: ${result.reused.length}`,
  );
  console.log(`  manifest: ${result.paths.manifest}`);
}

main()
  .catch((err) => {
    console.error("catalog build failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAllPgPools();
  });
