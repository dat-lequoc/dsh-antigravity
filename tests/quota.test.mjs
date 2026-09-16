import test from "node:test";
import assert from "node:assert/strict";
import { parseQuotaSummary } from "../lib/index.js";

test("parses wrapped quota groups and preserves reset metadata", () => {
  const quota = parseQuotaSummary({
    response: {
      groups: [{
        displayName: "Gemini Models",
        buckets: [{
          bucketId: "gemini-5h",
          displayName: "Five Hour Limit",
          remainingFraction: 0.637,
          resetTime: "2026-09-15T22:00:00Z",
        }],
      }],
    },
  });

  assert.equal(quota.groups.length, 1);
  assert.equal(quota.groups[0].displayName, "Gemini Models");
  assert.equal(quota.groups[0].buckets[0].remainingFraction, 0.637);
  assert.equal(quota.groups[0].buckets[0].resetTime, "2026-09-15T22:00:00Z");
});

test("preserves unknown remaining values instead of turning them into zero", () => {
  const quota = parseQuotaSummary({ groups: [{ displayName: "Gemini", buckets: [{ bucketId: "unknown", resetTime: "later" }] }] });
  assert.equal(quota.groups[0].buckets[0].remainingFraction, undefined);
});

test("accepts a flat bucket response and ignores empty groups", () => {
  const quota = parseQuotaSummary({
    buckets: [
      { modelId: "gemini-3-flash", remaining_fraction: 0.5, reset_time: "later" },
    ],
    groups: [{ displayName: "Empty", buckets: [] }],
  });

  assert.equal(quota.groups.length, 1);
  assert.equal(quota.groups[0].displayName, "Quota");
  assert.equal(quota.groups[0].buckets[0].bucketId, "gemini-3-flash");
  assert.equal(quota.groups[0].buckets[0].remainingFraction, 0.5);
  assert.equal(quota.groups[0].buckets[0].resetTime, "later");
});
