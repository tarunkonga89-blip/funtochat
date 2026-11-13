// Supabase Edge Function: giphy
// Proxies GIPHY so the API key stays server-side.
// Deploy: supabase functions deploy giphy
// Secret: supabase secrets set GIPHY_API_KEY=...
//
// GET ?q=cats            -> search GIFs
// GET ?q=&trending=1     -> trending GIFs
// (sticker=1 switches to the stickers endpoint)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401, headers: CORS });

  const key = Deno.env.get("GIPHY_API_KEY");
  if (!key) return Response.json({ error: "GIPHY_API_KEY is not configured" }, { status: 500, headers: CORS });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 60);
  const trending = url.searchParams.get("trending") === "1";
  const stickers = url.searchParams.get("sticker") === "1";
  const offset = Number(url.searchParams.get("offset") ?? 0) || 0;

  const base = stickers ? "https://api.giphy.com/v1/stickers" : "https://api.giphy.com/v1/gifs";
  const endpoint = trending || !q ? base + "/trending" : base + "/search";
  const params = new URLSearchParams({
    api_key: key,
    limit: "24",
    offset: String(offset),
    rating: "pg-13",
  });
  if (!trending && q) params.set("q", q);

  const res = await fetch(endpoint + "?" + params.toString());
  if (!res.ok) {
    return Response.json({ error: "GIPHY request failed" }, { status: 502, headers: CORS });
  }

  const data = await res.json();
  const items = (data.data ?? []).map((g: any) => ({
    id: g.id,
    title: g.title,
    url: g.images?.original?.url,
    preview: g.images?.fixed_width?.url ?? g.images?.original?.url,
    width: Number(g.images?.original?.width ?? 0),
    height: Number(g.images?.original?.height ?? 0),
  }));

  return Response.json({ items }, { headers: CORS });
});