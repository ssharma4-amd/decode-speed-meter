import assert from "node:assert/strict";
import test from "node:test";
import { SnapshotPollGuard } from "../src/poll-guard";

test("a disposed/reloaded poll generation cannot mutate or block the replacement", () => {
  const guard = new SnapshotPollGuard();
  const oldRead = guard.begin();
  assert.equal(oldRead, 0);
  assert.equal(guard.begin(), undefined, "one in-flight read locks only its own generation");
  guard.invalidate();
  const newRead = guard.begin();
  assert.equal(newRead, 1, "reload does not wait for old in-flight read");
  assert.equal(guard.isCurrent(oldRead!), false, "old completion cannot mutate the new session");
  guard.end(oldRead!);
  assert.equal(guard.begin(), undefined, "old finally cannot unlock the new read");
  guard.end(newRead!);
  assert.equal(guard.begin(), 1, "current completion unlocks subsequent polling");
});
