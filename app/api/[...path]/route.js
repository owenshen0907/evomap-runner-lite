import { handleApi } from '../../../lib/evomap.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 256 * 1024;

function requestId() {
  return `req_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function responseJson(payload, init = {}) {
  return Response.json(payload, {
    ...init,
    headers: {
      'cache-control': 'no-store',
      'x-request-id': payload.request_id || init.requestId || '',
      ...(init.headers || {}),
    },
  });
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    const headerHost = request.headers.get('x-forwarded-host') || request.headers.get('host');
    const headerProto = request.headers.get('x-forwarded-proto') || requestUrl.protocol.replace(':', '');
    const headerOrigin = headerHost ? `${headerProto}://${headerHost}` : null;
    const allowedOrigins = [requestUrl.origin, headerOrigin].filter(Boolean);
    return allowedOrigins.some((allowed) => originsMatch(originUrl, new URL(allowed)));
  } catch {
    return false;
  }
}

function originsMatch(left, right) {
  if (left.origin === right.origin) return true;
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  return (
    localHosts.has(left.hostname)
    && localHosts.has(right.hostname)
    && left.port === right.port
    && left.protocol === right.protocol
  );
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/secret|token|authorization|password|credential/i.test(key)) return [key, '[redacted]'];
    return [key, redact(item)];
  }));
}

async function route(request, context) {
  const id = requestId();
  const params = await context.params;
  const pathname = `/api/${(params.path || []).join('/')}`;
  let body = {};
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (!sameOrigin(request)) {
      return responseJson({ error: 'Forbidden cross-origin request', request_id: id }, { status: 403 });
    }
    const length = Number(request.headers.get('content-length') || 0);
    if (length > MAX_BODY_BYTES) {
      return responseJson({ error: 'Request body too large', request_id: id }, { status: 413 });
    }
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return responseJson({ error: 'Request body too large', request_id: id }, { status: 413 });
    }
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return responseJson({ error: 'Invalid JSON body', request_id: id }, { status: 400 });
      }
    }
  }

  try {
    const result = await handleApi(pathname, request.method, body);
    return responseJson(result.payload, { status: result.status, requestId: id });
  } catch (err) {
    const isDev = process.env.NODE_ENV !== 'production';
    return responseJson(
      {
        error: err.message || 'Internal server error',
        request_id: id,
        details: isDev ? redact(err.payload || err.stack) : undefined,
      },
      { status: err.status || 500, requestId: id },
    );
  }
}

export const GET = route;
export const POST = route;
