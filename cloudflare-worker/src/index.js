export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
    }

    const url = new URL(request.url);

    // Internal endpoint to dynamically update origin without redeploy
    if (url.pathname === '/__internal/set_origin' && request.method === 'POST') {
      const auth = request.headers.get('x-admin-secret');
      if (!auth || auth !== env.ADMIN_SECRET) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const newOrigin = (await request.text()).trim();
      if (!newOrigin.startsWith('http://') && !newOrigin.startsWith('https://')) {
        return new Response(JSON.stringify({ error: 'invalid_origin', message: 'Must start with http:// or https://' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (env.TUNNEL_KV) {
        await env.TUNNEL_KV.put('ORIGIN', newOrigin);
      }
      return new Response(JSON.stringify({ ok: true, origin: newOrigin }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/__internal/get_origin' && request.method === 'GET') {
      const current = env.TUNNEL_KV ? await env.TUNNEL_KV.get('ORIGIN') : null;
      return new Response(JSON.stringify({
        activeOrigin: current || env.BACKEND_ORIGIN,
        kvOrigin: current,
        fallbackOrigin: env.BACKEND_ORIGIN
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Proxy request
    let origin = env.BACKEND_ORIGIN || "https://academics-ira-appraisal-lawn.trycloudflare.com";
    if (env.TUNNEL_KV) {
      try {
        const kvOrigin = await env.TUNNEL_KV.get('ORIGIN');
        if (kvOrigin) origin = kvOrigin;
      } catch (e) {
        // fallback to env.BACKEND_ORIGIN
      }
    }

    const targetUrl = new URL(url.pathname + url.search, origin);

    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-Host', url.host);
    headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));

    const proxyRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers,
      body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
      redirect: 'manual'
    });

    try {
      const response = await fetch(proxyRequest);
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Access-Control-Allow-Origin', '*');
      newHeaders.set('Access-Control-Allow-Headers', '*');
      newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'upstream_unavailable', message: err.message, targetOrigin: origin }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
