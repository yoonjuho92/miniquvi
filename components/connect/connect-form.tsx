"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";

interface EnvPreview {
  dialect: "postgres" | "supabase" | "mysql";
  host: string;
  port: number;
  database: string;
  user: string;
}

interface CurrentSession {
  connectionId: string;
  connection: {
    dialect: string;
    host: string;
    port: number;
    database: string;
    user: string;
  };
}

export function ConnectForm({
  envPreview,
  current,
}: {
  envPreview: EnvPreview | null;
  current: CurrentSession | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildLog, setBuildLog] = useState<string | null>(null);
  const [mode, setMode] = useState<"string" | "fields">("string");
  const [form, setForm] = useState({
    dialect: envPreview?.dialect ?? "postgres",
    connectionString: "",
    host: envPreview?.host ?? "",
    port: String(envPreview?.port ?? 5432),
    database: envPreview?.database ?? "postgres",
    user: envPreview?.user ?? "postgres",
    password: "",
  });

  function update<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }

  async function postConnect(body: object) {
    setError(null);
    const res = await fetch("/api/session/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? `request failed (${res.status})`);
      return false;
    }
    return true;
  }

  async function handleConnect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body =
      mode === "string"
        ? {
            dialect: form.dialect,
            connectionString: form.connectionString,
          }
        : {
            dialect: form.dialect,
            host: form.host,
            port: Number(form.port),
            database: form.database,
            user: form.user,
            password: form.password,
          };
    if (await postConnect(body)) {
      startTransition(() => router.refresh());
    }
  }

  async function handleUseEnv() {
    if (await postConnect({ useEnv: true })) {
      startTransition(() => router.refresh());
    }
  }

  async function handleBuild() {
    setBuilding(true);
    setBuildLog("Building catalog…");
    try {
      const res = await fetch("/api/catalog/build", { method: "POST" });
      const data = (await res.json()) as {
        ok?: boolean;
        rebuilt?: number;
        reused?: number;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setBuildLog(`Build failed: ${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      setBuildLog(
        `Done. Rebuilt ${data.rebuilt ?? 0}, reused ${data.reused ?? 0}.`,
      );
      router.push("/catalog");
    } catch (err) {
      setBuildLog(`Build failed: ${(err as Error).message}`);
    } finally {
      setBuilding(false);
    }
  }

  async function handleDisconnect() {
    await fetch("/api/session/disconnect", { method: "POST" });
    startTransition(() => router.refresh());
  }

  if (current) {
    return (
      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Connected</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3 text-sm">
            <Field label="Dialect" value={current.connection.dialect} />
            <Field
              label="Host"
              value={`${current.connection.host}:${current.connection.port}`}
            />
            <Field label="Database" value={current.connection.database} />
            <Field label="User" value={current.connection.user} />
            <Field
              label="Connection ID"
              value={current.connectionId}
              mono
            />
            <div className="flex flex-wrap gap-2 pt-2">
              <Button onClick={handleBuild} disabled={building}>
                {building ? "Building catalog…" : "Build / refresh catalog"}
              </Button>
              <Button variant="secondary" onClick={() => router.push("/catalog")}>
                Open catalog
              </Button>
              <Button variant="ghost" onClick={() => router.push("/chat")}>
                Open chat
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDisconnect}
                className="ml-auto"
              >
                Disconnect
              </Button>
            </div>
            {buildLog && (
              <p className="text-xs text-muted-foreground">{buildLog}</p>
            )}
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {envPreview && (
        <Card>
          <CardHeader>
            <CardTitle>Use environment configuration</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              The server has a connection configured via environment variables.
              Click below to use it — the password stays server-side.
            </p>
            <div className="grid grid-cols-[120px_1fr] gap-y-1.5 text-xs">
              <span className="text-muted-foreground">Dialect</span>
              <span>{envPreview.dialect}</span>
              <span className="text-muted-foreground">Host</span>
              <span>
                {envPreview.host}:{envPreview.port}
              </span>
              <span className="text-muted-foreground">Database</span>
              <span>{envPreview.database}</span>
              <span className="text-muted-foreground">User</span>
              <span>{envPreview.user}</span>
              <span className="text-muted-foreground">Password</span>
              <span className="font-mono">••••••••</span>
            </div>
            <Button onClick={handleUseEnv} disabled={pending}>
              {pending ? "Connecting…" : "Use this connection"}
            </Button>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {envPreview ? "Or enter manually" : "Connect to a database"}
          </CardTitle>
        </CardHeader>
        <CardBody>
          <form onSubmit={handleConnect} className="space-y-3">
            <div>
              <Label>Dialect</Label>
              <Select
                value={form.dialect}
                onChange={(e) =>
                  update("dialect", e.target.value as typeof form.dialect)
                }
              >
                <option value="postgres">PostgreSQL</option>
                <option value="supabase">Supabase (PostgreSQL)</option>
              </Select>
            </div>
            <div>
              <Label>Mode</Label>
              <div className="flex gap-2 text-xs">
                <Toggle
                  active={mode === "string"}
                  onClick={() => setMode("string")}
                >
                  Connection string
                </Toggle>
                <Toggle
                  active={mode === "fields"}
                  onClick={() => setMode("fields")}
                >
                  Discrete fields
                </Toggle>
              </div>
            </div>
            {mode === "string" ? (
              <div>
                <Label>Connection string</Label>
                <Input
                  placeholder="postgres://user:password@host:5432/database"
                  value={form.connectionString}
                  onChange={(e) => update("connectionString", e.target.value)}
                  autoComplete="off"
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <Label>Host</Label>
                  <Input
                    value={form.host}
                    onChange={(e) => update("host", e.target.value)}
                  />
                </div>
                <div>
                  <Label>Port</Label>
                  <Input
                    value={form.port}
                    onChange={(e) => update("port", e.target.value)}
                  />
                </div>
                <div>
                  <Label>Database</Label>
                  <Input
                    value={form.database}
                    onChange={(e) => update("database", e.target.value)}
                  />
                </div>
                <div>
                  <Label>User</Label>
                  <Input
                    value={form.user}
                    onChange={(e) => update("user", e.target.value)}
                  />
                </div>
                <div>
                  <Label>Password</Label>
                  <Input
                    type="password"
                    value={form.password}
                    onChange={(e) => update("password", e.target.value)}
                    autoComplete="off"
                  />
                </div>
              </div>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end pt-2">
              <Button type="submit" disabled={pending}>
                {pending ? "Connecting…" : "Test & connect"}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs" : ""}>{value}</span>
    </div>
  );
}

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-md border px-2.5 py-1 text-xs transition-colors " +
        (active
          ? "border-ring bg-accent"
          : "border-border hover:bg-accent")
      }
    >
      {children}
    </button>
  );
}
