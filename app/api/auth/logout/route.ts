import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

export async function POST(request: Request) {
  const url = new URL("/login", request.url);
  const res = NextResponse.redirect(url, 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}

export async function GET(request: Request) {
  return POST(request);
}
