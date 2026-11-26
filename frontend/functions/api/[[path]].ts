export const onRequest = async (context: any) => {
  const backend = String(context.env?.BACKEND_URL || "").replace(/\/$/, "");
  if (!backend) {
    return new Response(JSON.stringify({ success: false, error: { code: "BACKEND_NOT_CONFIGURED", message: "Backend URL is not configured." } }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  const incoming = new URL(context.request.url);
  const headers = new Headers(context.request.headers);
  headers.delete("host");
  const init: RequestInit & { duplex?: string } = {
    method: context.request.method,
    headers,
    redirect: "manual",
    duplex: "half",
  };
  if (!["GET", "HEAD"].includes(context.request.method)) init.body = context.request.body;
  return fetch(backend + incoming.pathname + incoming.search, init);
};
