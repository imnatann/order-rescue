import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, sessionUser } from "@/server/auth";
import { LoginForm } from "./login-form";
export default async function Login() {
  if (sessionUser((await cookies()).get(SESSION_COOKIE)?.value)) redirect("/");
  return <LoginForm />;
}
