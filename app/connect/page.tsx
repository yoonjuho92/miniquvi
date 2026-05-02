import { connectionId } from "@/lib/db/pool";
import {
  configFromEnv,
  getServerConnection,
  publicConfigView,
} from "@/lib/session";
import { ConnectForm } from "@/components/connect/connect-form";

export const dynamic = "force-dynamic";

/**
 * Build a NON-SECRET preview of the env config, so the connect page can offer
 * a "use env" shortcut without the password ever entering the rendered HTML.
 */
function envPreview() {
  const cfg = configFromEnv();
  if (!cfg) return null;
  return {
    dialect: cfg.dialect,
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
  };
}

export default async function ConnectPage() {
  const cfg = await getServerConnection();
  const env = cfg ? null : envPreview();

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="text-xl font-semibold mb-1">Connect</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Credentials live server-side; the browser only ever sees a session
        cookie.
      </p>
      <ConnectForm
        envPreview={env}
        current={
          cfg
            ? {
                connectionId: connectionId(cfg),
                connection: publicConfigView(cfg),
              }
            : null
        }
      />
    </div>
  );
}
