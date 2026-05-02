"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Database, MessageSquare, Plug } from "lucide-react";
import { cn } from "@/lib/utils/cn";

const TABS = [
  { href: "/connect", label: "Connect", icon: Plug },
  { href: "/catalog", label: "Catalog", icon: Database },
  { href: "/chat", label: "Chat", icon: MessageSquare },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="border-b border-[var(--border)] bg-[var(--background)]">
      <div className="mx-auto flex max-w-6xl items-center gap-1 px-4 py-2">
        <Link href="/" className="mr-4 text-sm font-semibold tracking-tight">
          nl2sql
        </Link>
        {TABS.map((t) => {
          const active = pathname?.startsWith(t.href);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                active
                  ? "bg-[var(--accent)] text-[var(--foreground)]"
                  : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
              )}
            >
              <Icon size={14} />
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
