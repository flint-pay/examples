import { NextResponse } from 'next/server';
import { runtime } from '@/server/runtime.ts';
import { returnPath } from '@/server/security/paths.ts';

// A page found an expired or unknown session cookie. Start a fresh session and go back.
export async function GET(request: Request) {
  const rt = await runtime();
  const next = returnPath(new URL(request.url).searchParams.get('next'));
  const response = NextResponse.redirect(new URL(next, rt.config.appOrigin), 303);
  response.cookies.set(rt.config.cookieName, rt.identity.createSession().token, { httpOnly: true, secure: rt.config.appOrigin.startsWith('https:'), sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 });
  return response;
}
