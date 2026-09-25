import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detailFromSamples, effortFromSamples, parseRunSamples, seriesPath, type RunSample } from "./run-detail.ts";

function steady(km: number, secondsPerKm: number, hr: number, rpm: number): RunSample[] {
  const samples: RunSample[] = [];
  const steps = km * 10;
  for (let index = 0; index <= steps; index += 1) {
    const distanceKm = (index / steps) * km;
    samples.push({
      distanceKm,
      timeSec: distanceKm * secondsPerKm,
      heartrate: hr,
      cadenceRpm: rpm,
      altitudeM: index,
    });
  }
  return samples;
}

describe("run detail", () => {
  it("splits each kilometre and keeps a short last split", () => {
    const detail = detailFromSamples(steady(2.4, 300, 160, 85));
    assert.equal(detail.splits.length, 3);
    assert.equal(detail.splits[0]?.label, "1");
    assert.equal(Math.round(detail.splits[0]?.paceSecPerKm ?? 0), 300);
    assert.equal(detail.splits[0]?.heartrate, 160);
    assert.equal(detail.splits[0]?.stepRateSpm, 170);
    assert.equal(detail.splits[2]?.label.endsWith("km"), true);
    assert.equal(detail.avgHr, 160);
    assert.ok((detail.elevationGainM ?? 0) > 0);
  });

  it("emits every full kilometre of an exact distance", () => {
    const detail = detailFromSamples(steady(3, 300, 150, 85));
    assert.equal(detail.splits.length, 3);
    assert.deepEqual(
      detail.splits.map((split) => split.label),
      ["1", "2", "3"],
    );
    for (const split of detail.splits) {
      assert.ok(Math.abs(split.distanceKm - 1) < 1e-6);
      assert.equal(Math.round(split.paceSecPerKm), 300);
    }
  });

  it("adds a trailing partial with its real distance and per-km pace", () => {
    const samples: RunSample[] = [
      { distanceKm: 0, timeSec: 0, heartrate: 150 },
      { distanceKm: 1, timeSec: 300, heartrate: 150 },
      { distanceKm: 2, timeSec: 600, heartrate: 150 },
      { distanceKm: 3, timeSec: 900, heartrate: 150 },
      { distanceKm: 3.4, timeSec: 1100, heartrate: 150 },
    ];
    const detail = detailFromSamples(samples);
    assert.equal(detail.splits.length, 4);
    assert.deepEqual(
      detail.splits.slice(0, 3).map((split) => split.label),
      ["1", "2", "3"],
    );
    const partial = detail.splits[3];
    assert.equal(partial?.label, "0.40 km");
    assert.ok(Math.abs((partial?.distanceKm ?? 0) - 0.4) < 1e-6);
    assert.equal(Math.round(partial?.paceSecPerKm ?? 0), 500);
  });

  it("returns one partial split when the run is under a kilometre", () => {
    const detail = detailFromSamples(steady(0.4, 360, 140, 80));
    assert.equal(detail.splits.length, 1);
    assert.equal(detail.splits[0]?.label, "0.40 km");
    assert.ok(Math.abs((detail.splits[0]?.distanceKm ?? 0) - 0.4) < 1e-6);
    assert.equal(Math.round(detail.splits[0]?.paceSecPerKm ?? 0), 360);
  });

  it("does not duplicate a split when the distance sits on a kilometre boundary", () => {
    for (const endKm of [3 + 1e-10, 3 - 1e-10]) {
      const samples = steady(3, 300, 150, 85);
      const last = samples[samples.length - 1];
      assert.ok(last);
      last.distanceKm = endKm;
      last.timeSec = endKm * 300;
      const detail = detailFromSamples(samples);
      assert.equal(detail.splits.length, 3);
      assert.deepEqual(
        detail.splits.map((split) => split.label),
        ["1", "2", "3"],
      );
    }
  });

  it("drops samples that are not numbers", () => {
    const samples = parseRunSamples([
      { distanceKm: 0, timeSec: 0, heartrate: 150 },
      { distanceKm: "1", timeSec: 300 },
      null,
    ]);
    assert.equal(samples.length, 1);
    assert.equal(samples[0]?.heartrate, 150);
  });

  it("reads heart rate and step rate from the session samples", () => {
    const effort = effortFromSamples(steady(1, 300, 160, 85));
    assert.equal(effort.averageHr, 160);
    assert.equal(effort.maxHr, 160);
    assert.equal(effort.cadenceRpm, 85);
    assert.equal(effort.stepRateSpm, 170);
  });

  it("draws a pace line", () => {
    const path = seriesPath([300, 280, 320], 100, 40, true);
    assert.match(path, /^M/);
    assert.equal(path.includes("L"), true);
  });
});
