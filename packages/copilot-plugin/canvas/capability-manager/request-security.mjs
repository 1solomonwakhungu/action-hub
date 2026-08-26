import { timingSafeEqual } from "node:crypto";

export const MAX_BODY_BYTES = 64 * 1024;

export function validateMutationRequest(req, token) {
  const host = req.headers.host;
  if (typeof host !== "string" || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
    return { status: 403, error: "Invalid Host" };
  }

  const origin = req.headers.origin;
  if (origin !== undefined && !localOrigin(origin)) {
    return { status: 403, error: "Foreign Origin" };
  }

  const supplied = req.headers["x-action-hub-canvas-token"];
  if (
    typeof supplied !== "string" ||
    supplied.length !== token.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
  ) {
    return { status: 401, error: "Unauthorized" };
  }

  if (req.headers["content-type"] !== "application/json") {
    return { status: 415, error: "Content-Type must be application/json" };
  }

  return null;
}

function localOrigin(origin) {
  if (typeof origin !== "string") return false;
  try {
    const url = new URL(origin);
    return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.protocol === "http:";
  } catch {
    return false;
  }
}
