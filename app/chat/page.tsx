import { redirect } from "next/navigation";
import {
  getServerConnection,
  publicConfigView,
} from "@/lib/session";
import { connectionId } from "@/lib/db/pool";
import { ChatView } from "@/components/chat/chat-view";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const cfg = await getServerConnection();
  if (!cfg) redirect("/connect");

  return (
    <ChatView
      connection={publicConfigView(cfg)}
      connectionId={connectionId(cfg)}
    />
  );
}
