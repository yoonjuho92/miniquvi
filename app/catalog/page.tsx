import path from "node:path";
import { redirect } from "next/navigation";
import { getServerConnection } from "@/lib/session";
import { connectionId } from "@/lib/db/pool";
import { loadCatalog, loadRelations } from "@/lib/catalog";
import { CatalogView } from "@/components/catalog/catalog-view";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";

export const dynamic = "force-dynamic";

function catalogRoot(): string {
  return process.env.CATALOG_DIR || path.join(process.cwd(), ".catalog");
}

export default async function CatalogPage() {
  const cfg = await getServerConnection();
  if (!cfg) redirect("/connect");

  const id = connectionId(cfg);
  const handle = await loadCatalog(catalogRoot(), id);
  if (!handle) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Catalog not built yet</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3 text-sm">
            <p>
              No catalog exists for this connection
              (
              <code className="font-mono text-xs">{id.slice(0, 8)}…</code>
              ). Build one from the connect page.
            </p>
            <Link
              href="/connect"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Go to Connect
            </Link>
          </CardBody>
        </Card>
      </div>
    );
  }

  const graph = (await loadRelations(handle)) ?? { nodes: [], edges: [] };
  return <CatalogView manifest={handle.manifest} initialGraph={graph} />;
}
