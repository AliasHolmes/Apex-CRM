/**
 * Client-disconnect socket guards, extracted from server.ts so the test suite can
 * exercise the production wiring instead of an inline re-implementation.
 *
 * All functions are safe to call with mock req/res/socket objects (EventEmitters).
 */
import type http from "node:http";

export function isClientSocketAbortError(err: any): boolean {
  if (!err) return false;
  const code = err.code;
  const message = err.message || (typeof err === "string" ? err : "");
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    message.includes("ECONNRESET") ||
    message.includes("EPIPE")
  );
}

/**
 * App-level middleware guarding against unhandled client-disconnect errors
 * (e.g. ECONNRESET/EPIPE when a browser tab closes mid-response). Reused sockets
 * are registered exactly once via a WeakSet.
 */
export function createSocketErrorGuard(): (
  req: any,
  res: any,
  next: () => void,
) => void {
  const guardedSockets = new WeakSet<object>();
  return function socketErrorGuard(req: any, res: any, next: () => void) {
    const handleSocketError = (err: any) => {
      if (isClientSocketAbortError(err)) {
        return;
      }
      console.warn("[Server] Socket warning:", err?.message || err);
    };
    req.on("error", handleSocketError);
    res.on("error", handleSocketError);
    if (req.socket && !guardedSockets.has(req.socket)) {
      guardedSockets.add(req.socket);
      req.socket.on("error", handleSocketError);
    }
    next();
  };
}

/**
 * `clientError` handler for the HTTP server: reset sockets are destroyed
 * silently; everything else gets a plain 400 and the socket is ended.
 */
export function handleHttpClientError(
  err: any,
  socket: (http.ServerResponse & { destroy?: (...args: any[]) => any }) | any,
): void {
  if (isClientSocketAbortError(err) || !socket.writable) {
    socket.destroy();
    return;
  }
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
}

/**
 * SSE disconnect cleanup wiring shared by the mining-sessions stream route and
 * its tests. Registers a no-op error supressor on req/res/socket, and removes
 * every listener on teardown (idempotent).
 */
export function attachDisconnectCleanup(options: {
  req: any;
  res: any;
  onDrain?: () => void;
  onUnsubscribe?: () => void;
  onEmpty?: () => void;
}): {
  suppressDisconnectError: () => void;
  doUnsubscribe: () => void;
} {
  const { req, res, onDrain, onUnsubscribe, onEmpty } = options;
  const suppressDisconnectError = () => {
    // Intentionally ignored: expected client disconnect errors.
  };
  res.on("error", suppressDisconnectError);
  req.on("error", suppressDisconnectError);
  req.socket?.on("error", suppressDisconnectError);

  let unsubscribed = false;
  const doUnsubscribe = () => {
    if (unsubscribed) return;
    unsubscribed = true;
    onEmpty?.();
    if (onDrain) res.off("drain", onDrain);
    (req.socket || res.socket)?.off("error", suppressDisconnectError);
    req.off("error", suppressDisconnectError);
    res.off("error", suppressDisconnectError);
    req.off("close", doUnsubscribe);
    res.off("close", doUnsubscribe);
    if (onUnsubscribe) onUnsubscribe();
  };

  req.on("close", doUnsubscribe);
  res.on("close", doUnsubscribe);
  return { suppressDisconnectError, doUnsubscribe };
}
