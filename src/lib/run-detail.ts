export type GeoPoint = { lat: number; lng: number };

export type RunSample = {
  distanceKm: number;
  timeSec: number;
  heartrate?: number;
  /** One-foot cadence, as Intervals.icu stores it. Step rate is about twice this. */
  cadenceRpm?: number;
  altitudeM?: number;
};

export type KmSplit = {
  label: string;
  distanceKm: number;
  paceSecPerKm: number;
  heartrate: number | null;
  stepRateSpm: number | null;
  elevationM: number | null;
};

export type RunSeries = {
  paceSecPerKm: number[];
  heartrate: number[];
  stepRateSpm: number[];
};

export type RunDetail = {
  splits: KmSplit[];
  series: RunSeries;
  avgHr: number | null;
  maxHr: number | null;
  avgStepRate: number | null;
  elevationGainM: number | null;
};

function finite(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function parseRunSamples(value: unknown): RunSample[] {
  if (!Array.isArray(value)) return [];
  const samples: RunSample[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const distanceKm = finite(record.distanceKm);
    const timeSec = finite(record.timeSec);
    if (distanceKm === null || timeSec === null || distanceKm < 0 || timeSec < 0) continue;
    const sample: RunSample = { distanceKm, timeSec };
    const heartrate = finite(record.heartrate);
    if (heartrate !== null && heartrate > 0) sample.heartrate = heartrate;
    const cadenceRpm = finite(record.cadenceRpm);
    if (cadenceRpm !== null && cadenceRpm > 0) sample.cadenceRpm = cadenceRpm;
    const altitudeM = finite(record.altitudeM);
    if (altitudeM !== null) sample.altitudeM = altitudeM;
    samples.push(sample);
    if (samples.length >= 2000) break;
  }
  return samples;
}

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Even time along the track when the run has a line but no recorded samples. */
export function samplesFromCoords(coords: GeoPoint[], timeSec: number): RunSample[] {
  if (coords.length < 2 || !(timeSec > 0)) return [];
  const stepKm: number[] = [0];
  for (let index = 1; index < coords.length; index += 1) {
    stepKm.push(stepKm[index - 1] + haversineKm(coords[index - 1], coords[index]));
  }
  const totalKm = stepKm[stepKm.length - 1] ?? 0;
  if (!(totalKm > 0)) return [];
  return stepKm.map((distanceKm) => ({
    distanceKm,
    timeSec: (distanceKm / totalKm) * timeSec,
  }));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stepRate(sample: RunSample): number | null {
  if (!sample.cadenceRpm || !(sample.cadenceRpm > 0)) return null;
  return Math.round(sample.cadenceRpm * 2);
}

function splitsFromSamples(samples: RunSample[]): KmSplit[] {
  const end = samples[samples.length - 1];
  if (!end || !(end.distanceKm > 0)) return [];
  const marks: number[] = [];
  for (let km = 1; km < end.distanceKm; km += 1) marks.push(km);
  if (end.distanceKm - Math.floor(end.distanceKm) >= 0.05 || marks.length === 0) {
    marks.push(end.distanceKm);
  }
  const splits: KmSplit[] = [];
  let cursor = 0;
  let previousKm = 0;
  let previousTime = samples[0]?.timeSec ?? 0;
  let previousAlt = samples[0]?.altitudeM;
  for (const mark of marks) {
    const bucket: RunSample[] = [];
    while (cursor < samples.length && samples[cursor].distanceKm <= mark + 0.001) {
      if (samples[cursor].distanceKm >= previousKm - 0.001) bucket.push(samples[cursor]);
      cursor += 1;
    }
    const last = bucket[bucket.length - 1] ?? samples[Math.max(0, cursor - 1)];
    if (!last) continue;
    const distanceKm = Math.max(0.05, last.distanceKm - previousKm);
    const seconds = Math.max(1, last.timeSec - previousTime);
    const hrs = bucket.map((sample) => sample.heartrate).filter((value): value is number => typeof value === "number");
    const steps = bucket.map(stepRate).filter((value): value is number => value !== null);
    const altitude = last.altitudeM;
    const partial = mark < end.distanceKm - 0.02 ? false : distanceKm < 0.95;
    splits.push({
      label: partial ? `${distanceKm.toFixed(2)} km` : String(splits.length + 1),
      distanceKm,
      paceSecPerKm: seconds / distanceKm,
      heartrate: average(hrs) === null ? null : Math.round(average(hrs) as number),
      stepRateSpm: average(steps) === null ? null : Math.round(average(steps) as number),
      elevationM:
        typeof altitude === "number" && typeof previousAlt === "number"
          ? Math.round(altitude - previousAlt)
          : null,
    });
    previousKm = last.distanceKm;
    previousTime = last.timeSec;
    if (typeof altitude === "number") previousAlt = altitude;
  }
  return splits;
}

function downsample(values: number[], size = 64): number[] {
  if (values.length <= size) return values;
  const out: number[] = [];
  const bucket = values.length / size;
  for (let index = 0; index < size; index += 1) {
    const start = Math.floor(index * bucket);
    const end = Math.max(start + 1, Math.floor((index + 1) * bucket));
    const slice = values.slice(start, end);
    const mean = average(slice);
    if (mean !== null) out.push(mean);
  }
  return out;
}

export function detailFromSamples(samples: RunSample[]): RunDetail {
  const ordered = [...samples].sort((a, b) => a.distanceKm - b.distanceKm);
  const pace: number[] = [];
  const heartrate: number[] = [];
  const stepRates: number[] = [];
  let climb = 0;
  let sawAltitude = false;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const distance = current.distanceKm - previous.distanceKm;
    const seconds = current.timeSec - previous.timeSec;
    if (distance > 0.005 && seconds > 0) pace.push(seconds / distance);
    if (typeof current.heartrate === "number") heartrate.push(current.heartrate);
    const steps = stepRate(current);
    if (steps !== null) stepRates.push(steps);
    if (typeof current.altitudeM === "number" && typeof previous.altitudeM === "number") {
      sawAltitude = true;
      const delta = current.altitudeM - previous.altitudeM;
      if (delta > 0) climb += delta;
    }
  }
  const avgHr = average(heartrate);
  const avgStep = average(stepRates);
  return {
    splits: splitsFromSamples(ordered),
    series: {
      paceSecPerKm: downsample(pace),
      heartrate: downsample(heartrate),
      stepRateSpm: downsample(stepRates),
    },
    avgHr: avgHr === null ? null : Math.round(avgHr),
    maxHr: heartrate.length ? Math.round(Math.max(...heartrate)) : null,
    avgStepRate: avgStep === null ? null : Math.round(avgStep),
    elevationGainM: sawAltitude ? Math.round(climb) : null,
  };
}

export function effortFromSamples(samples: RunSample[] | undefined): {
  averageHr: number | null;
  maxHr: number | null;
  cadenceRpm: number | null;
  stepRateSpm: number | null;
} {
  const rows = samples ?? [];
  const heartrate = rows.map((sample) => sample.heartrate).filter((value): value is number => typeof value === "number");
  const cadence = rows.map((sample) => sample.cadenceRpm).filter((value): value is number => typeof value === "number");
  const avgHr = average(heartrate);
  const avgCadence = average(cadence);
  return {
    averageHr: avgHr === null ? null : Math.round(avgHr),
    maxHr: heartrate.length ? Math.round(Math.max(...heartrate)) : null,
    cadenceRpm: avgCadence === null ? null : Math.round(avgCadence),
    stepRateSpm: avgCadence === null ? null : Math.round(avgCadence * 2),
  };
}

export function detailForRun(
  coords: GeoPoint[],
  samples: RunSample[] | undefined,
  timeSec: number,
): RunDetail {
  const recorded = samples && samples.length >= 2 ? samples : samplesFromCoords(coords, timeSec);
  return detailFromSamples(recorded);
}

export type ChartGeometry = {
  line: string;
  area: string;
  grids: string[];
  min: number;
  max: number;
};

/** Line plus fill. `invert` puts smaller numbers toward the top (pace: faster is up). */
export function chartGeometry(values: number[], width: number, height: number, invert = false): ChartGeometry | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 0.001);
  const padX = 2;
  const padY = 12;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const points = values.map((value, index) => {
    const x = padX + (index / (values.length - 1)) * innerW;
    const ratio = (value - min) / span;
    const y = invert ? padY + ratio * innerH : padY + (1 - ratio) * innerH;
    return { x, y };
  });
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const baseline = height - padY;
  const area = `${line} L${points[points.length - 1].x.toFixed(1)} ${baseline.toFixed(1)} L${points[0].x.toFixed(1)} ${baseline.toFixed(1)} Z`;
  const grids = [0, 0.5, 1].map((step) => {
    const y = (padY + step * innerH).toFixed(1);
    return `M${padX} ${y} L${(width - padX).toFixed(1)} ${y}`;
  });
  return { line, area, grids, min, max };
}

/** SVG path. `invert` puts smaller numbers toward the top (pace: faster is up). */
export function seriesPath(values: number[], width: number, height: number, invert = false): string {
  return chartGeometry(values, width, height, invert)?.line ?? "";
}
