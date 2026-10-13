import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { request } from "node:http";
import { startCollector } from "../src/core/collector";

test("collector bounds plain and expanded gzip payloads without persisting rejected bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hoosage-collector-bounds-"));
  const collector = await startCollector({
    port: 0,
    token: "synthetic-bounds",
    projectId: "a",
    file: join(directory, "usage.jsonl"),
  });
  const url = `http://127.0.0.1:${collector.port}/synthetic-bounds/v1/traces`;
  try {
    const large = Buffer.alloc(8 * 1024 * 1024 + 1, 32);
    // The collector rejects the declared size before upload. A fetch upload
    // can observe the deliberate connection close as ECONNRESET instead.
    const plainStatus = await new Promise<number>((resolve, reject) => {
      const upload = request(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(large.length),
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      upload.once("error", reject);
      upload.end();
    });
    assert.equal(plainStatus, 413);
    const compressed = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: gzipSync(large),
    });
    assert.equal(compressed.status, 400);
    assert.deepEqual(await readdir(directory), []);
    assert.equal(
      (await fetch(url.replace("/v1/traces", "/health"))).status,
      200,
    );
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("collector discards metrics and logs and rejects preflights and unsupported formats", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hoosage-collector-discard-"));
  const collector = await startCollector({
    port: 0,
    token: "synthetic-discard",
    projectId: "a",
    file: join(directory, "usage.jsonl"),
  });
  const prefix = `http://127.0.0.1:${collector.port}/synthetic-discard`;
  try {
    for (const signal of ["metrics", "logs"]) {
      const response = await fetch(`${prefix}/v1/${signal}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "synthetic-private-content" }),
      });
      assert.equal(response.status, 200);
    }
    assert.equal(
      (
        await fetch(`${prefix}/v1/traces`, {
          method: "OPTIONS",
          headers: { origin: "https://example.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${prefix}/v1/traces`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "ignored",
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await fetch(`${prefix}/v1/traces`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-encoding": "br",
          },
          body: "{}",
        })
      ).status,
      415,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});
