import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Dashboard } from "@/features/dashboard/dashboard";
import { SESSION_COOKIE, sessionUser } from "@/server/auth";
import { snapshot, suppliers } from "@/server/store";
import { isLlmConfigured } from "@/lib/llm/provider";

export default async function Home() {
  const user = sessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return (
    <Dashboard
      initialData={{
        ...snapshot(),
        suppliers: suppliers(),
        llmConfigured: isLlmConfigured(),
      }}
      user={user}
    />
  );
}
