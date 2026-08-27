import { describe, expect, it } from "vitest";

import {
  createSignedPrekey,
  generateIdentity,
  signIdentityDhKey,
  sodium,
} from "../crypto/identity";
import { ApiClient, ApiError, NetworkError, type FetchLike } from "./api";

interface Recorded {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A fetch stub that records calls and replays scripted responses. */
function stubFetch(
  responses: (Partial<Response> & { json?: () => Promise<unknown> })[],
): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });

    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: next.json ?? (async () => ({})),
    } as Response;
  };

  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("ApiClient", () => {
  it("registers an account with public material only", async () => {
    const identity = await generateIdentity();
    const spk = await createSignedPrekey(identity.signing.privateKey, 1);
    const { fetch, calls } = stubFetch([jsonResponse({ account_id: "acc-1" })]);

    const api = new ApiClient({ baseUrl: "https://example.test", fetch });
    expect(await api.register(identity, spk)).toBe("acc-1");

    const body = calls[0].body as Record<string, unknown>;
    // Nothing secret may appear in the request. Serialising the whole body and
    // searching it catches a private key smuggled into any field.
    const serialised = JSON.stringify(body);
    const s = await sodium();
    expect(serialised).not.toContain(
      s.to_base64(identity.signing.privateKey, s.base64_variants.ORIGINAL),
    );
    expect(serialised).not.toContain(
      s.to_base64(identity.dh.privateKey, s.base64_variants.ORIGINAL),
    );
    expect(body.identity_key).toBeDefined();
    expect(body.signed_prekey).toBeDefined();
  });

  it("strips a trailing slash from the base URL", async () => {
    const { fetch, calls } = stubFetch([jsonResponse({ envelopes: [] })]);
    const api = new ApiClient({ baseUrl: "https://example.test/", fetch });
    api.useToken("tok");

    await api.fetchEnvelopes();
    expect(calls[0].url).toBe("https://example.test/v1/envelopes");
  });

  it("authenticates and keeps the token out of the URL", async () => {
    const identity = await generateIdentity();
    const s = await sodium();
    const nonce = s.to_base64(new Uint8Array(32).fill(7), s.base64_variants.ORIGINAL);

    const { fetch, calls } = stubFetch([
      jsonResponse({ nonce }),
      jsonResponse({ token: "session-token" }),
    ]);
    const api = new ApiClient({ baseUrl: "https://example.test", fetch });

    expect(await api.authenticate(identity, "acc-1")).toBe("session-token");
    expect(api.sessionToken).toBe("session-token");

    // The proof, not the key, goes on the wire.
    const verifyBody = calls[1].body as Record<string, string>;
    expect(verifyBody.signature).toBeDefined();
    expect(JSON.stringify(verifyBody)).not.toContain(
      s.to_base64(identity.signing.privateKey, s.base64_variants.ORIGINAL),
    );

    // A token in a query string would leak into logs and history.
    for (const call of calls) {
      expect(call.url).not.toContain("session-token");
    }
  });

  it("sends the token as a bearer header on authenticated calls", async () => {
    const { fetch, calls } = stubFetch([jsonResponse({ envelopes: [] })]);
    const api = new ApiClient({ baseUrl: "https://example.test", fetch });
    api.useToken("tok");

    await api.fetchEnvelopes();
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    expect(calls[0].url).not.toContain("tok");
  });

  it("refuses authenticated calls before authentication", async () => {
    const { fetch, calls } = stubFetch([jsonResponse({})]);
    const api = new ApiClient({ baseUrl: "https://example.test", fetch });

    await expect(api.fetchEnvelopes()).rejects.toThrow(ApiError);
    // No request should have been attempted at all.
    expect(calls).toHaveLength(0);
  });

  it("surfaces server errors as ApiError with the status and message", async () => {
    const { fetch } = stubFetch([
      jsonResponse({ error: "unknown recipient" }, 404),
    ]);
    const api = new ApiClient({ baseUrl: "https://example.test", fetch });
    api.useToken("tok");

    await expect(api.sendEnvelope("nobody", new Uint8Array([1]))).rejects.toThrow(
      /unknown recipient/,
    );
    await expect(
      api.sendEnvelope("nobody", new Uint8Array([1])),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("survives an error response with no JSON body", async () => {
    const api = new ApiClient({
      baseUrl: "https://example.test",
      fetch: async () =>
        ({
          ok: false,
          status: 502,
          json: async () => {
            throw new Error("not json");
          },
        }) as unknown as Response,
    });
    api.useToken("tok");

    // A proxy-generated 502 is not JSON; it must still produce a usable error.
    await expect(api.fetchEnvelopes()).rejects.toMatchObject({ status: 502 });
  });

  it("distinguishes a network failure from a rejected request", async () => {
    const api = new ApiClient({
      baseUrl: "https://example.test",
      fetch: async () => {
        throw new TypeError("connection refused");
      },
    });
    api.useToken("tok");

    // The two demand opposite responses: retry the network, not the 401.
    await expect(api.fetchEnvelopes()).rejects.toThrow(NetworkError);
    await expect(api.fetchEnvelopes()).rejects.not.toThrow(ApiError);
  });

  it("decodes a bundle into the shape X3DH expects", async () => {
    const identity = await generateIdentity();
    const spk = await createSignedPrekey(identity.signing.privateKey, 3);
    const s = await sodium();
    const otk = s.crypto_kx_keypair();
    const enc = (b: Uint8Array) => s.to_base64(b, s.base64_variants.ORIGINAL);

    const { fetch, calls } = stubFetch([
      jsonResponse({
        identity_key: enc(identity.signing.publicKey),
        identity_dh_key: enc(identity.dh.publicKey),
        identity_dh_signature: enc(await signIdentityDhKey(identity)),
        signed_prekey: {
          id: 3,
          public_key: enc(spk.publicKey),
          signature: enc(spk.signature),
        },
        one_time_prekey: { id: 9, public_key: enc(otk.publicKey) },
      }),
    ]);
    const api = new ApiClient({ baseUrl: "https://example.test", fetch });
    api.useToken("tok");

    const bundle = await api.fetchBundle("acc/with special");
    expect(bundle.identityKey).toEqual(identity.signing.publicKey);
    expect(bundle.signedPrekey.id).toBe(3);
    expect(bundle.oneTimePrekey?.id).toBe(9);
    // The account id must be escaped, not interpolated raw into the path.
    expect(calls[0].url).toContain("acc%2Fwith%20special");
  });

  it("omits the one-time prekey when the pool is empty", async () => {
    const identity = await generateIdentity();
    const spk = await createSignedPrekey(identity.signing.privateKey, 1);
    const s = await sodium();
    const enc = (b: Uint8Array) => s.to_base64(b, s.base64_variants.ORIGINAL);

    const { fetch } = stubFetch([
      jsonResponse({
        identity_key: enc(identity.signing.publicKey),
        identity_dh_key: enc(identity.dh.publicKey),
        identity_dh_signature: enc(await signIdentityDhKey(identity)),
        signed_prekey: {
          id: 1,
          public_key: enc(spk.publicKey),
          signature: enc(spk.signature),
        },
      }),
    ]);
    const api = new ApiClient({ baseUrl: "https://example.test", fetch });
    api.useToken("tok");

    expect((await api.fetchBundle("acc")).oneTimePrekey).toBeUndefined();
  });

  it("round-trips an envelope payload through base64", async () => {
    const payload = new Uint8Array([0, 255, 128, 1, 2, 3]);
    const { fetch, calls } = stubFetch([
      jsonResponse({ envelope_id: "env-1" }),
    ]);
    const api = new ApiClient({ baseUrl: "https://example.test", fetch });
    api.useToken("tok");

    expect(await api.sendEnvelope("acc-2", payload)).toBe("env-1");

    const sent = (calls[0].body as Record<string, string>).payload;
    const api2 = new ApiClient({
      baseUrl: "https://example.test",
      fetch: stubFetch([
        jsonResponse({
          envelopes: [
            { id: "e", sender_id: "s", payload: sent, created_at: "now" },
          ],
        }),
      ]).fetch,
    });
    api2.useToken("tok");

    expect((await api2.fetchEnvelopes())[0].payload).toEqual(payload);
  });

  it("skips the request entirely when acknowledging nothing", async () => {
    const { fetch, calls } = stubFetch([jsonResponse({ acknowledged: 0 })]);
    const api = new ApiClient({ baseUrl: "https://example.test", fetch });
    api.useToken("tok");

    expect(await api.acknowledge([])).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
