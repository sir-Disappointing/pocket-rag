// pocket-rag proxy: lets the widget use your Anthropic API key without the key ever reaching the page.
//
// The browser talks to this Worker as if it were the Anthropic API (POST /v1/messages, streaming).
// The Worker:
//   - only accepts requests from your own site (ALLOWED_ORIGINS),
//   - limits questions per visitor (LIMITER, by IP address),
//   - takes only the conversation from the browser and sets everything else itself (model, system
//     prompt, sources, answer length), so it can't be used as free general-purpose Claude access,
//   - adds the API key (secret ANTHROPIC_API_KEY).
//
// knowledge.js, settings.js, retrieve.mjs and lang/ are written by `pocket-rag build`.
// This file is yours to change; the build doesn't overwrite it.
import KNOWLEDGE from "./knowledge.js";
import SETTINGS from "./settings.js";
import { requestBody } from "./retrieve.mjs";

const S = SETTINGS.strings;

function corsHeaders(origin, request) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// Errors in the same shape as the Anthropic API.
function apiError(status, type, message, headers = {}) {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

// Only a plain conversation: alternating user/assistant text, starting and ending with the user.
export function cleanMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > SETTINGS.maxHistory) return null;
  const out = [];
  for (const [i, m] of messages.entries()) {
    const role = i % 2 === 0 ? "user" : "assistant";
    if (!m || m.role !== role || typeof m.content !== "string") return null;
    const content = m.content.trim();
    // Answers can be longer than questions; maxTokens is a generous bound in characters.
    const max = role === "user" ? SETTINGS.maxQuestion : SETTINGS.maxTokens * 6;
    if (!content || content.length > max) return null;
    out.push({ role, content });
  }
  return out[out.length - 1].role === "user" ? out : null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(origin)) return apiError(403, "permission_error", S.errForbidden);
    const headers = corsHeaders(origin, request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/messages") {
      return apiError(404, "not_found_error", "Not found.", headers);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await env.LIMITER.limit({ key: ip });
    if (!success) return apiError(429, "rate_limit_error", S.errRate, headers);

    let body;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "invalid_request_error", S.errInvalid, headers);
    }
    const messages = cleanMessages(body && body.messages);
    if (!messages) return apiError(400, "invalid_request_error", S.errInvalid, headers);

    let upstream;
    try {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(requestBody(KNOWLEDGE, SETTINGS, messages)),
      });
    } catch (err) {
      console.error("Anthropic API unreachable", err);
      return apiError(502, "api_error", S.errUnavailable, headers);
    }
    if (!upstream.ok) {
      console.error("Anthropic API error", upstream.status, await upstream.text());
      if (upstream.status === 429 || upstream.status === 529) return apiError(429, "rate_limit_error", S.errBusy, headers);
      return apiError(502, "api_error", S.errUnavailable, headers);
    }
    return new Response(upstream.body, {
      status: 200,
      headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  },
};
