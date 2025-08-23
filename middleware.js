// middleware.js (SEGURO CON FALLBACK)
import { NextResponse } from "next/server";

const FALLBACK_TOKEN = "__APP_TOKEN_REQUIRED__";

export function middleware(req) {
  const url = req.nextUrl;
  const { pathname } = url;

  // Rutas públicas: login, **cualquier API**, y estáticos
  if (
    pathname === "/login" ||
    pathname.startsWith("/api/") ||      // ← agrega esto
    pathname === "/favicon.ico" ||
    pathname === "/finantah-logo.png" ||
    pathname.startsWith("/_next/")
  ) {
    return NextResponse.next();
  }

  // Auth
  const hasPass = !!process.env.APP_PASSWORD;
  const tokenEnv = process.env.APP_AUTH_TOKEN || FALLBACK_TOKEN;
  const requireAuth = hasPass || !!process.env.APP_AUTH_TOKEN;

  if (!requireAuth) return NextResponse.next();

  const cookieToken = req.cookies.get("auth")?.value || "";
  if (cookieToken === tokenEnv) return NextResponse.next();

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = { matcher: ["/:path*"] };
