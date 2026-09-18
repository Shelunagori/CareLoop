import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Session refresh. Next 16 calls this file `proxy` (it was `middleware`).
 *
 * Its ONLY job is to keep the Supabase access token fresh and hand the
 * refreshed cookies to both sides: to the application through the request, and
 * to the browser through the response. Without it an anonymous demo session
 * expires mid-demo and the reviewer is silently signed out of their own world.
 *
 * THE RESPONSE MUST BE THE ONE `setAll` LAST BUILT. Returning an earlier
 * `NextResponse.next()` drops the refreshed cookies, and the next request
 * arrives unauthenticated - the single most common way this goes wrong.
 *
 * It is not a security boundary. Next's own guidance is explicit that a proxy
 * may be skipped by a matcher change or a refactor, so every Server Action and
 * route re-checks identity itself. Nothing here decides anything.
 *
 * The client is built PER REQUEST, inside the handler. A proxy may run outside
 * the application's main runtime, and nothing user-specific may live in module
 * scope or on `globalThis`.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Verifies the token and refreshes it when it is close to expiring. Its
  // result is deliberately unused: authorization happens where the work does.
  await supabase.auth.getClaims();

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image optimization. A session does
     * not need refreshing to serve a stylesheet, and running auth on assets is
     * how a proxy ends up blocking the CSS.
     */
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
