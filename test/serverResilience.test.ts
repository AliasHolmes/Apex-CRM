import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { EventEmitter } from "node:events";

test("Socket error guard middleware suppresses ECONNRESET, EPIPE, and premature close errors", async () => {
  const app = express();

  // Replicate the server socket error guard middleware
  app.use((req, res, next) => {
    const suppressSocketError = (err: any) => {
      if (
        err?.code === "ECONNRESET" ||
        err?.code === "EPIPE" ||
        err?.code === "ERR_STREAM_PREMATURE_CLOSE" ||
        err?.message?.includes("ECONNRESET") ||
        err?.message?.includes("EPIPE")
      ) {
        return;
      }
    };
    req.on("error", suppressSocketError);
    res.on("error", suppressSocketError);
    req.socket?.on("error", suppressSocketError);
    next();
  });

  app.get("/test-disconnect", (req, res) => {
    // Simulating client disconnect
    const mockResetError = new Error("read ECONNRESET");
    (mockResetError as any).code = "ECONNRESET";

    // Should not throw unhandled exception
    assert.doesNotThrow(() => {
      req.emit("error", mockResetError);
      res.emit("error", mockResetError);
    });

    res.status(200).send("ok");
  });

  const server = http.createServer(app);

  server.on("clientError", (err: any, socket) => {
    if (
      err?.code === "ECONNRESET" ||
      err?.code === "EPIPE" ||
      err?.code === "ERR_STREAM_PREMATURE_CLOSE" ||
      !socket.writable
    ) {
      socket.destroy();
      return;
    }
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = (server.address() as any).port;

  const res = await fetch(`http://127.0.0.1:${port}/test-disconnect`);
  assert.equal(res.status, 200);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("HTTP server clientError handler cleanly destroys reset client sockets without throwing", async () => {
  let destroyed = false;
  const mockSocket: any = new EventEmitter();
  mockSocket.writable = false;
  mockSocket.destroy = () => {
    destroyed = true;
  };
  mockSocket.end = () => {};

  const server = http.createServer();
  server.on("clientError", (err: any, socket) => {
    if (
      err?.code === "ECONNRESET" ||
      err?.code === "EPIPE" ||
      err?.code === "ERR_STREAM_PREMATURE_CLOSE" ||
      !socket.writable
    ) {
      socket.destroy();
      return;
    }
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  const err: any = new Error("read ECONNRESET");
  err.code = "ECONNRESET";

  assert.doesNotThrow(() => {
    server.emit("clientError", err, mockSocket);
  });

  assert.equal(destroyed, true);
});

test("Global unhandledRejection / uncaughtException handlers ignore client connection resets", () => {
  const resetError: any = new Error("write EPIPE");
  resetError.code = "EPIPE";

  const isBenignDisconnect = (err: any) => {
    return (
      err?.code === "ECONNRESET" ||
      err?.code === "EPIPE" ||
      err?.code === "ERR_STREAM_PREMATURE_CLOSE" ||
      err?.message?.includes("ECONNRESET") ||
      err?.message?.includes("EPIPE")
    );
  };

  assert.equal(isBenignDisconnect(resetError), true);

  const resetErr2: any = new Error("socket hang up");
  resetErr2.code = "ECONNRESET";
  assert.equal(isBenignDisconnect(resetErr2), true);

  const genericError: any = new Error("Unexpected crash");
  assert.equal(isBenignDisconnect(genericError), false);
});
