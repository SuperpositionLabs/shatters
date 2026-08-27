/**
 * Typed client for the shatters REST API.
 *
 * Every payload crossing this boundary is either public key material or opaque
 * ciphertext; no plaintext and no private key ever reaches these calls.
 *
 * `fetch` is injected so the suite stays hermetic and callers can supply their
 * own instrumentation.
 */
import {
  type Identity,
  type SignedPrekey,
  createAuthProof,
  fromBase64,
} from "../crypto/identity";
import type { PrekeyBundle } from "../crypto/x3dh";

/** The server rejected the request; `status` is the HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The request never produced a response.
 *
 * Kept distinct from `ApiError` because the two demand opposite responses:
 * a network failure is worth retrying, a 401 is not.
 */
export class NetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "NetworkError";
  }
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ApiClientOptions {
  /** Base URL of the server, e.g. `https://shatters.example`. */
  baseUrl: string;
  fetch?: FetchLike;
}

export interface QueuedEnvelope {
  id: string;
  senderId: string;
  /** Raw inner-message bytes, already base64-decoded. */
  payload: Uint8Array;
  createdAt: string;
}

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private token?: string;

  constructor(options: ApiClientOptions) {
    // Trailing slashes would produce `//v1/...`, which some proxies redirect
    // and others reject.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The current session token, once authenticated. */
  get sessionToken(): string | undefined {
    return this.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    authenticated = false,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (authenticated) {
      if (!this.token) {
        throw new ApiError(401, "not authenticated");
      }
      // Header, never a query parameter: tokens in URLs end up in proxy logs
      // and browser history.
      headers.authorization = `Bearer ${this.token}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw new NetworkError(`${method} ${path} failed`, cause);
    }

    if (!response.ok) {
      // The body may be empty or not JSON on proxy-generated errors.
      let message = `${method} ${path} returned ${response.status}`;
      try {
        const parsed = (await response.json()) as { error?: string };
        if (parsed?.error) message = parsed.error;
      } catch {
        /* keep the generic message */
      }
      throw new ApiError(response.status, message);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** Registers an account. Idempotent on the identity key. */
  async register(
    identity: Identity,
    signedPrekey: SignedPrekey,
    oneTimePrekeys: { id: number; publicKey: Uint8Array }[] = [],
  ): Promise<string> {
    const body = await this.request<{ account_id: string }>(
      "POST",
      "/v1/accounts",
      {
        identity_key: b64(identity.signing.publicKey),
        identity_dh_key: b64(identity.dh.publicKey),
        signed_prekey: {
          id: signedPrekey.id,
          public_key: b64(signedPrekey.publicKey),
          signature: b64(signedPrekey.signature),
        },
        one_time_prekeys: oneTimePrekeys.map((k) => ({
          id: k.id,
          public_key: b64(k.publicKey),
        })),
      },
    );
    return body.account_id;
  }

  /**
   * Completes the challenge-response handshake and stores the session token.
   *
   * The private key never leaves this process: only the detached proof is sent.
   */
  async authenticate(identity: Identity, accountId: string): Promise<string> {
    const challenge = await this.request<{ nonce: string }>(
      "POST",
      "/v1/auth/challenge",
      { account_id: accountId },
    );

    const nonce = fromBase64(challenge.nonce);
    const proof = await createAuthProof(identity.signing.privateKey, nonce);

    const verified = await this.request<{ token: string }>(
      "POST",
      "/v1/auth/verify",
      {
        account_id: accountId,
        nonce: challenge.nonce,
        signature: b64(proof),
      },
    );

    this.token = verified.token;
    return verified.token;
  }

  /** Adopts a token obtained elsewhere (e.g. restored from storage). */
  useToken(token: string): void {
    this.token = token;
  }

  /** Fetches a peer's prekey bundle, consuming a one-time prekey server-side. */
  async fetchBundle(accountId: string): Promise<PrekeyBundle> {
    const body = await this.request<{
      identity_key: string;
      identity_dh_key: string;
      signed_prekey: { id: number; public_key: string; signature: string };
      one_time_prekey?: { id: number; public_key: string };
    }>("GET", `/v1/accounts/${encodeURIComponent(accountId)}/bundle`, undefined, true);

    return {
      identityKey: fromBase64(body.identity_key),
      identityDhKey: fromBase64(body.identity_dh_key),
      signedPrekey: {
        id: body.signed_prekey.id,
        publicKey: fromBase64(body.signed_prekey.public_key),
        signature: fromBase64(body.signed_prekey.signature),
      },
      oneTimePrekey: body.one_time_prekey
        ? {
            id: body.one_time_prekey.id,
            publicKey: fromBase64(body.one_time_prekey.public_key),
          }
        : undefined,
    };
  }

  /** Tops up the account's one-time prekey pool. */
  async uploadPrekeys(
    prekeys: { id: number; publicKey: Uint8Array }[],
  ): Promise<number> {
    const body = await this.request<{ uploaded: number }>(
      "POST",
      "/v1/accounts/me/prekeys",
      {
        one_time_prekeys: prekeys.map((k) => ({
          id: k.id,
          public_key: b64(k.publicKey),
        })),
      },
      true,
    );
    return body.uploaded;
  }

  /** Submits an opaque envelope for a recipient. */
  async sendEnvelope(
    recipientId: string,
    payload: Uint8Array,
  ): Promise<string> {
    const body = await this.request<{ envelope_id: string }>(
      "POST",
      "/v1/envelopes",
      { recipient_id: recipientId, payload: b64(payload) },
      true,
    );
    return body.envelope_id;
  }

  /** Reads queued envelopes. Does not delete them; acknowledge separately. */
  async fetchEnvelopes(): Promise<QueuedEnvelope[]> {
    const body = await this.request<{
      envelopes: {
        id: string;
        sender_id: string;
        payload: string;
        created_at: string;
      }[];
    }>("GET", "/v1/envelopes", undefined, true);

    return body.envelopes.map((e) => ({
      id: e.id,
      senderId: e.sender_id,
      payload: fromBase64(e.payload),
      createdAt: e.created_at,
    }));
  }

  /** Confirms receipt, letting the server delete the envelopes. */
  async acknowledge(envelopeIds: string[]): Promise<number> {
    if (envelopeIds.length === 0) return 0;

    const body = await this.request<{ acknowledged: number }>(
      "POST",
      "/v1/envelopes/ack",
      { envelope_ids: envelopeIds },
      true,
    );
    return body.acknowledged;
  }
}
