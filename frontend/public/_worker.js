export default {
  async fetch(request, env) {
    const backend = String(env?.FLASK_API_ORIGIN || env?.BACKEND_URL || "").replace(/\/$/, "");
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!backend) {
        return new Response(JSON.stringify({ success: false, error: { code: "BACKEND_NOT_CONFIGURED", message: "Backend URL is not configured." } }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      const init = { method: request.method, headers, redirect: "manual" };
      if (!["GET","HEAD"].includes(request.method)) init.body = request.body;
      return fetch(backend + url.pathname + url.search, init);
    }
    return env.ASSETS.fetch(request);
  },
};
