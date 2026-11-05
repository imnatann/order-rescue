import "server-only";
import { NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "./errors";
import { rateLimit, requireRole, sessionUser, SESSION_COOKIE } from "./auth";
import type { Role, User } from "./types";

export const noStore = { "Cache-Control": "no-store" };
export function originGuard(request: NextRequest) {
  const expected = new URL(process.env.APP_URL || "http://127.0.0.1:3000")
    .origin;
  if (
    request.headers.get("origin") !== expected ||
    request.headers.get("x-requested-with") !== "OrderRescue"
  )
    throw new AppError(
      "Origin permintaan tidak diizinkan. Buka alamat APP_URL yang dikonfigurasi.",
      403,
      "ORIGIN_REJECTED",
    );
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new AppError("Gunakan Content-Type application/json.", 415);
}
export async function readJson<T>(
  request: NextRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  // Bound streamed bodies too, including requests without Content-Length.
  if (Number(request.headers.get("content-length") || 0) > 64 * 1024)
    throw new AppError("Permintaan terlalu besar.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("Body JSON wajib diisi.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 64 * 1024) {
      await reader.cancel();
      throw new AppError("Permintaan terlalu besar.", 413);
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks);
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new AppError("JSON tidak valid.");
  }
  return schema.parse(value);
}
export function api(
  handler: (request: NextRequest, user: User) => Promise<Response> | Response,
  roles: Role[] = ["admin", "operator", "viewer"],
) {
  return async (request: NextRequest) => {
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method))
        originGuard(request);
      const user = requireRole(
        sessionUser(request.cookies.get(SESSION_COOKIE)?.value),
        roles,
      );
      rateLimit(`api:${user.id}`, 240, 60_000);
      return await handler(request, user);
    } catch (error) {
      return apiError(error);
    }
  };
}
export function apiError(error: unknown) {
  if (error instanceof z.ZodError)
    return Response.json(
      {
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .slice(0, 4)
          .join("; "),
        code: "VALIDATION_ERROR",
      },
      { status: 400, headers: noStore },
    );
  if (error instanceof AppError)
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: noStore },
    );
  // Avoid logging request bodies, model output, credentials, SQL params or PII.
  console.error(
    JSON.stringify({
      level: "error",
      event: "api_error",
      name: error instanceof Error ? error.name : "UnknownError",
      at: new Date().toISOString(),
    }),
  );
  return Response.json(
    {
      error: "Terjadi kesalahan server. Coba kembali.",
      code: "INTERNAL_ERROR",
    },
    { status: 500, headers: noStore },
  );
}
export const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: noStore });
