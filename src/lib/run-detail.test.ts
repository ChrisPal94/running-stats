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
