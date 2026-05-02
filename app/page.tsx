import { redirect } from "next/navigation";
import { getServerConnection } from "@/lib/session";

export default async function Home() {
  const cfg = await getServerConnection();
  redirect(cfg ? "/catalog" : "/connect");
}
