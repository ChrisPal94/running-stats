import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSameOrigin, publicOrigin } from "./public-origin.ts";

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("publicOrigin", () => {
  it("uses X-Forwarded-Proto and X-Forwarded-Host over the internal URL", () => {
    const req = request("http://10.0.0.1:8080/signup", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "running-stats-production.up.railway.app",
      host: "10.0.0.1:8080",
    });
    assert.equal(publicOrigin(req), "https://running-stats-production.up.railway.app");
  });

  it("takes the first value of comma-separated forwarded headers", () => {
    const req = request("http://127.0.0.1:4321/login", {
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "app.example.com, localhost",
    });
    assert.equal(publicOrigin(req), "https://app.example.com");
  });

  it("falls back to Host when forwarded host is absent", () => {
    const req = request("http://127.0.0.1:4321/login", {
      "x-forwarded-proto": "https",
      host: "running-stats-production.up.railway.app",
    });
    assert.equal(publicOrigin(req), "https://running-stats-production.up.railway.app");
  });

  it("ignores injected hosts and uses Host instead", () => {
    const req = request("http://127.0.0.1:4321/login", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "evil.com/phish",
      host: "running-stats-production.up.railway.app",
    });
    assert.equal(publicOrigin(req), "https://running-stats-production.up.railway.app");
  });

  it("uses request.url when no Host or forwarded headers are present", () => {
    const req = request("http://localhost:4321/login");
    assert.equal(publicOrigin(req), "http://localhost:4321");
  });
});

describe("isSameOrigin", () => {
  const internal = "http://10.0.0.1:8080/signup";
  const publicHost = {
    "x-forwarded-proto": "https",
    "x-forwarded-host": "running-stats-production.up.railway.app",
  };

  it("allows a browser Origin that matches the public HTTPS origin", () => {
    const req = request(internal, {
      ...publicHost,
      origin: "https://running-stats-production.up.railway.app",
    });
    assert.equal(isSameOrigin(req), true);
  });

  it("rejects a cross-site Origin even when forwarded headers are present", () => {
    const req = request(internal, {
      ...publicHost,
      origin: "https://evil.example",
    });
    assert.equal(isSameOrigin(req), false);
  });

  it("does not treat the internal http origin as same-site for a public Origin", () => {
    const req = request(internal, {
      origin: "https://running-stats-production.up.railway.app",
      host: "10.0.0.1:8080",
    });
    assert.equal(isSameOrigin(req), false);
  });

  it("falls back to Referer when Origin is absent", () => {
    const req = request(internal, {
      ...publicHost,
      referer: "https://running-stats-production.up.railway.app/signup",
    });
    assert.equal(isSameOrigin(req), true);
  });

  it("rejects a cross-site Referer", () => {
    const req = request(internal, {
      ...publicHost,
      referer: "https://evil.example/signup",
    });
    assert.equal(isSameOrigin(req), false);
  });

  it("allows requests with neither Origin nor Referer", () => {
    const req = request(internal, publicHost);
    assert.equal(isSameOrigin(req), true);
  });
});
