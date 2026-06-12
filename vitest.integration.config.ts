import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { githubOutbound } from "./test/integration/github-mock";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Point at the build-generated wrangler config (dist/server/wrangler.json),
      // not the source ./wrangler.jsonc. The source config's `main` is the
      // adapter shim package export which has no Astro manifest, so SELF.fetch
      // would hit a manifest-less worker. `yarn test:integration` runs
      // `yarn build` first, so this file exists before vitest starts and points
      // at the real built SSR worker (entry.mjs) with the bundled route manifest.
      wrangler: { configPath: "./dist/server/wrangler.json" },
      miniflare: {
        // Intercept ALL outbound fetch from the worker-under-test. This version
        // of @cloudflare/vitest-pool-workers (0.16.15) does NOT export `fetchMock`
        // from `cloudflare:test` (the type is declared but the runtime binding is
        // absent), so the documented per-test MockAgent pattern is unavailable.
        // A miniflare `outboundService` is the supported substitute: it runs
        // in-process and returns canned GitHub API responses, so the real github
        // client + JWT-mint code paths execute against deterministic upstream
        // responses. See test/integration/github-mock.ts for the response map.
        outboundService: githubOutbound,
        bindings: {
          TEST_MIGRATIONS: migrations,
          SESSION_SECRET: "test-session-secret",
          GITHUB_OAUTH_CLIENT_ID: "test-client-id",
          GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
          GITHUB_APP_ID: "12345",
          // Test-only PKCS#8 RSA key. The installation-token mint is mocked
          // (see test/integration/github-mock.ts), so this never authenticates
          // against real GitHub — it only has to be a valid key the JWT signer
          // (RSASSA-PKCS1-v1_5 / SHA-256) can import. Committing it is fine.
          GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCwGgyjGipEAXEc
UaA9VR+c57dVw9XCvqT7nZtM2OsClSf3AL+8a1PD6zveAoeEUAb2FcDEL80mCe0V
yaJtSpKJhu3nrt6T5e6ZLB8DtifE49KzaFV6Z1dYZzI4X5MNHPYQ8yHIV8b08qhz
q6J4Jw73J9h8Y/HXKMq7iiW2QFlq0sFJH2TURkYjeLCT0vKysjc0pblDWhcgnlsn
QCNJ17xnUsjBkcYPdVjuK6tFFRTRqTqNEYJ11J9zLjov+XXHouAtUlKoWDu78fLi
hM8tgDuT5gSVFzKJZXWsgnn1JzvpGN7FAfagP4ga0N7lmBEKVdc8Glgohw7E1ceN
snAxRRRnAgMBAAECggEAJW+kOBgb3BEiZo7DrcYmzkhEJStYienVUNgUZ6XFb+sd
b9js6bU3PXMIaw3GmU4Z7L57GDnBNtDtYbBXozwzIqFYeeQm1PIQYueKQFO86JI1
/IW1hivp2ZU2i91leWgqtze4esqONQxQ2yYlh71l5QzHbMoiY0b8shmQIspTN+3y
21bV+pgi+HcS6ESYyWf5Uak2K8KyA4N+kFdCKIm2iV8RRqcGPT8/gbSNQNKS8Ovv
UUwSR4jQwF5qsptzamDMEBM92CP1/LTbFZu1+M8vGxQFAxkCK0tC+gRZYAMsoV0l
wr3Y1TeyzCyjL6695hzy5xpl61N4y/jHTnT3nBcBIQKBgQDuxRw8dhxdxUrigE43
dar6mbW1/RZsjUbLRo4gdvs3RsR3HhSnrXny9g2TD98X2yXzwqcqmx4o0/CVT62y
Jk99yx5jWxUW5+kXOzDI8Rxe2jQgk2zx/rgfypz03or0OF0F3+5Vm+dpeK2u55gD
4L/PMT2YCI+FFDPzC/m+g1+fIwKBgQC8zz696evrJlrfNrvpEMRy5D5wsqkjEyFt
jmpgUbl6RBmzEV2SI9jpvKe0lx2p/am2ahF9WLVIOMwamqbwublIpIM0snA70kq3
vYwcynGuhqDpGB5untz+wvcrx4O4IqA6Ne8Iq0CsRRjV8vCWXvfXT6JfcN1eoRhA
aybn5xrL7QKBgASufrg8xJ+eD7LTOzVhLEIPo313AeqM9pdjwcOnMZPK4m1HfLYw
85Qs+OUqSYCJPnxCE88FDZlVVoFG96vnjmV0BxuBnK8/StW2xmUaPSkq9ByzZ05z
ZR7SdTNj7auOM1y7IEwza10pDZbBWbyxunEQkRmbCV1doQsh7/qpTsWrAoGAT3W0
xP42UD9TDQ+e44Yv9t5BvPIjpmQ9tDq0YBbkxST139uWEpPNjQjdV24liM39Z4ya
EbOMj3l/xE6DpVm0NXMu2LWj8DkfQtadqdw1HasA+zgwToPDI+BvX1hXAd5oqjba
gz53OEjYG+pjABW1nkKgZiQ8tb98UlgGBqDHMT0CgYEArHakTP+Ibgopw5DXpXBu
PZgFnug2DUVGq98xwqrOpzkb2G79+k4jrF0HYtrTdJu9kPzmwbM3gVzEmGu6Vo4V
9UNYhwjOBVCCUcWBDhSBcL13MOCu4jNME1eq747oBL7YX1AwBlGjnlfNszHSbJJ2
T5j5Rxvh+snI7lADrAbCspw=
-----END PRIVATE KEY-----`,
          GITHUB_APP_INSTALLATION_ID: "67890",
        },
      },
    }),
  ],
  test: {
    include: ["test/integration/**/*.test.ts"],
    setupFiles: ["./test/integration/apply-migrations.ts"],
  },
});
