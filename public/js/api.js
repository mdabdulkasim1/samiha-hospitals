/* Thin fetch wrapper. Every call returns parsed JSON or throws an Error whose
   message is the server's human-readable reason. */
(function () {
  'use strict';

  let token = localStorage.getItem('samiha_token') || null;

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;

    const res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 401 && !path.includes('/auth/')) {
      API.setToken(null);
      window.dispatchEvent(new CustomEvent('samiha:unauthorised'));
      throw new Error('Your session has expired. Please sign in again.');
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.details = data && data.details;
      err.payload = data;
      throw err;
    }
    return data;
  }

  const API = {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b || {}),
    patch: (p, b) => request('PATCH', p, b || {}),
    put: (p, b) => request('PUT', p, b || {}),
    del: (p) => request('DELETE', p),
    getToken: () => token,
    setToken(value) {
      token = value;
      if (value) localStorage.setItem('samiha_token', value);
      else localStorage.removeItem('samiha_token');
    },
    qs(params) {
      const parts = Object.entries(params || {})
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      return parts.length ? '?' + parts.join('&') : '';
    },
  };

  window.API = API;
})();
