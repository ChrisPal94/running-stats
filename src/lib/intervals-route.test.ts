import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeFromIntervalsStreams } from "./intervals.ts";

describe("routeFromIntervalsStreams", () => {
  it("keeps the GPS line with heart rate and one-foot cadence", () => {
    const route = routeFromIntervalsStreams({
      latlng: [
        [-2.19, -79.88],
        [-2.191, -79.881],
        [-2.192, -79.882],
      ],
      time: [0, 30, 70],
      distance: [0, 150, 320],
      heartrate: [140, 150, 155],
      cadence: [82, 86, 88],
      altitude: [5, 6, 8],
    });
    assert.ok(route);
    assert.equal(route?.coords.length, 3);
    assert.equal(route?.samples[1]?.heartrate, 150);
    assert.equal(route?.samples[1]?.cadenceRpm, 86);
    assert.equal(route?.samples[2]?.distanceKm, 0.32);
    assert.equal(route?.samples[0]?.timeSec, 0);
  });

  it("reads the array payload Intervals returns when GPS is absent", () => {
    const route = routeFromIntervalsStreams([
      { type: "time", data: [0, 30, 60] },
      { type: "distance", data: [0, 100, 200] },
      { type: "heartrate", data: [150, 160, 170] },
      { type: "cadence", data: [84, 86, 88] },
    ]);
    assert.equal(route?.coords.length, 0);
    assert.equal(route?.samples.length, 3);
    assert.equal(route?.samples[2]?.heartrate, 170);
    assert.equal(route?.samples[2]?.cadenceRpm, 88);
    assert.equal(route?.samples[2]?.distanceKm, 0.2);
  });

  it("returns null without a GPS line or a time series", () => {
    assert.equal(routeFromIntervalsStreams({ heartrate: [140, 150] }), null);
  });
});
