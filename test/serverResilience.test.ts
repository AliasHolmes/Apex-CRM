import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { EventEmitter } from "node:events";
import {
  isClientSocketAbortError,
  createSocketErrorGuard,
  handleHttpClientError,
  attachDisconnectCleanup,
} from "../server/socketGuard.js";

test("Socket error guard middleware (production wiring) suppresses ECONNRESET/EPIPE/premature close", async () => {
  const app = express();
  app.use(createSocketErrorGuard());

  app.get("/test-disconnect", (req, res) => {
    // Nothing throws: the guard must swallow the disconnect noise emitted here.
    const resetError: any = new Error("read ECONNRESET");
    resetError.code = "ECONNRESET";
    assert.doesNotThrow(() => {
      req.emit("error", resetError);
      res.emit("error", resetError);
    });

    res.status(200).send("ok");
  });

  const server = http.createServer(app);
  server.on("clientError", (err: any, socket: any) => {
    handleHttpClientError(err, socket);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = (server.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}/test-disconnect`);
  assert.equal(res.status, 200);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("handleHttpClientError destroys reset sockets and ends others with 400", () => {
  const resetError: any = new Error("write EPIPE");
  resetError.code = "EPIPE";

  let destroyed = false;
  const resetSocket: any = new EventEmitter();
  resetSocket.writable = false;
  resetSocket.destroy = () => {
    destroyed = true;
  };
  resetSocket.end = () => {
    throw new Error("must not be called for reset sockets");
  };
  assert.doesNotThrow(() => handleHttpClientError(resetError, resetSocket));
  assert.equal(destroyed, true);

  const healthySocket: any = new EventEmitter();
  healthySocket.writable = true;
  let endedWith: string | null = null;
  healthySocket.destroy = () => {
    throw new Error("must not be called for non-reset errors");
  };
  healthySocket.end = (payload?: string) => {
    endedWith = payload ?? null;
  };
  const weirdError: any = new Error("Something else entirely");
  weirdError.code = "ERANGE";
  handleHttpClientError(weirdError, healthySocket);
  assert.equal(endedWith, "HTTP/1.1 400 Bad Request\r\n\r\n");
});

test("isClientSocketAbortError classifies client disconnects and ignores unrelated errors", () => {
  assert.equal(isClientSocketAbortError(Object.assign(new Error("x"), { code: "ECONNRESET" })), true);
  assert.equal(isClientSocketAbortError(Object.assign(new Error("x"), { code: "EPIPE" })), true);
  assert.equal(
    isClientSocketAbortError(Object.assign(new Error("x"), { code: "ERR_STREAM_PREMATURE_CLOSE" })),
    true,
  );
  assert.equal(isClientSocketAbortError(new Error("read ECONNRESET")), true);
  assert.equal(isClientSocketAbortError(new Error("write EPIPE")), true);
  assert.equal(isClientSocketAbortError(new Error("Unexpected crash")), false);
  assert.equal(isClientSocketAbortError(undefined), false);
  assert.equal(isClientSocketAbortError(null), false);
});

test("Socket error guard does not accumulate duplicate listeners on reused (keep-alive) sockets", () => {
  const middleware = createSocketErrorGuard();
  const mockSocket = new EventEmitter();

  for (let i = 0; i < 20; i++) {
    const mockReq = new EventEmitter() as any;
    mockReq.socket = mockSocket;
    const mockRes = new EventEmitter() as any;
    middleware(mockReq, mockRes, () => {});
  }

  assert.equal(mockSocket.listenerCount("error"), 1, "socket must carry exactly one error listener");
});

test("attachDisconnectCleanup removes listeners and is idempotent on double close", () => {
  const mockSocket = new EventEmitter();

  for (let i = 0; i < 20; i++) {
    const mockReq = new EventEmitter() as any;
    mockReq.socket = mockSocket;
    const mockRes = new EventEmitter() as any;
    mockRes.socket = mockSocket;

    let emptied = false;
    let unsubscribed = false;
    const { doUnsubscribe } = attachDisconnectCleanup({
      req: mockReq,
      res: mockRes,
      onEmpty: () => {
        emptied = true;
      },
      onUnsubscribe: () => {
        unsubscribed = true;
      },
    });

    // Client closes the stream, then a stray second close arrives: must be a no-op.
    mockReq.emit("close");
    mockReq.emit("close");
    mockRes.emit("close");

    assert.equal(emptied, true);
    assert.equal(unsubscribed, true);
    void doUnsubscribe;
  }

  assert.equal(mockSocket.listenerCount("error"), 0, "teardown must remove socket error listener");
});
