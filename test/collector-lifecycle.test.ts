import { test } from "node:test";
import assert from "node:assert/strict";
import { startCollector } from "../src/core/collector";

test("collector closure is shared by stop-tracking and host disposal", async () => {
  const collector = await startCollector({
    port: 0,
    token: "synthetic-test",
    projectId: "host",
    file: "",
  });
  const first = collector.close();
  const second = collector.close();
  assert.equal(first, second);
  await Promise.all([first, second]);
  await collector.close();
  await assert.rejects(
    fetch(`http://127.0.0.1:${collector.port}/synthetic-test/health`),
  );
});
