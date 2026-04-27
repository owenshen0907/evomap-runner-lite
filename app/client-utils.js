export function pretty(value) {
  return JSON.stringify(value, null, 2);
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok) {
    const err = new Error(data.error || `HTTP ${response.status}`);
    err.data = data;
    throw err;
  }
  return data;
}
