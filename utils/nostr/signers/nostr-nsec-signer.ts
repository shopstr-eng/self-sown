import {
  nip19,
  nip44,
  getPublicKey,
  NostrEvent,
  finalizeEvent,
} from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils";
import CryptoJS from "crypto-js";
import { NostrEventTemplate } from "@/utils/nostr/nostr-manager";
import {
  ChallengeHandler,
  NostrSigner,
} from "@/utils/nostr/signers/nostr-signer";
import * as nip49 from "nostr-tools/nip49";

export type PassphraseResponse = {
  passphrase: string;
  remember: boolean;
};

type OAuthProvider = "apple" | "google";

export class NostrNSecSigner implements NostrSigner {
  private readonly encryptedPrivKey: string;
  private readonly challengeHandler: ChallengeHandler;
  private readonly oauthProvider?: OAuthProvider;
  private readonly oauthEmail?: string;

  public passphrase?: string;
  private pubkey?: string;
  private rememberedPassphrase?: string;
  // The exact sessionStorage key last written/read. this.pubkey can be
  // unset at write time (legacy signer JSON) and set later via getPubKey(),
  // so cleanup must target the recorded key, not a recomputed one.
  private rememberedKeyWritten?: string;
  private inputPassphrase?: string;
  private inputPassphraseClearer?: any;
  private isNip49Format: boolean = false;
  // Single-flight guard: concurrent callers (parallel gift-wrap decryption and
  // NIP-98 auth signs at /orders mount) share ONE passphrase unlock. Without
  // it, each caller spawns a competing challenge and clobbers the provider's
  // single challengeResolver, hanging all but the last one.
  private privKeyInFlight?: Promise<Uint8Array>;

  public static getEncryptedNSEC(
    privKey: Uint8Array | string,
    passphrase: string
  ): {
    encryptedPrivKey: string;
    passphrase: string;
    pubkey: string;
  } {
    let secretKey: Uint8Array;
    if (typeof privKey === "string") {
      if (privKey.startsWith("nsec")) {
        secretKey = nip19.decode(privKey).data as Uint8Array;
      } else {
        secretKey = hexToBytes(privKey);
      }
    } else {
      secretKey = privKey;
    }

    const pubkey = getPublicKey(secretKey);
    const encryptedKey = nip49.encrypt(secretKey, passphrase);

    return {
      encryptedPrivKey: encryptedKey,
      passphrase,
      pubkey,
    };
  }

  constructor(
    {
      encryptedPrivKey,
      passphrase,
      pubkey,
      oauthProvider,
      oauthEmail,
    }: {
      encryptedPrivKey: string;
      passphrase?: string;
      pubkey?: string;
      oauthProvider?: OAuthProvider;
      oauthEmail?: string;
    },
    challengeHandler: ChallengeHandler
  ) {
    this.encryptedPrivKey = encryptedPrivKey;
    this.challengeHandler = challengeHandler;
    this.pubkey = pubkey;
    this.passphrase = passphrase;
    this.oauthProvider = oauthProvider;
    this.oauthEmail = oauthEmail;
    this.isNip49Format = encryptedPrivKey.startsWith("ncryptsec");
  }

  static fromJSON(
    json: {
      [key: string]: any;
    },
    challengeHandler: ChallengeHandler
  ): NostrNSecSigner | undefined {
    if (json.type !== "nsec" || !json.encryptedPrivKey) return undefined;
    const oauthProvider: OAuthProvider | undefined =
      json.oauthProvider === "apple" || json.oauthProvider === "google"
        ? json.oauthProvider
        : undefined;
    const oauthEmail =
      typeof json.oauthEmail === "string" ? json.oauthEmail : undefined;
    const oauthIdentity = oauthEmail || json.pubkey;
    return new NostrNSecSigner(
      {
        encryptedPrivKey: json.encryptedPrivKey,
        passphrase:
          oauthProvider && typeof oauthIdentity === "string"
            ? `oauth-${oauthProvider}-${oauthIdentity}`
            : undefined,
        pubkey: json.pubkey,
        oauthProvider,
        oauthEmail,
      },
      challengeHandler
    );
  }

  public toJSON(): {
    type: "nsec";
    encryptedPrivKey: string;
    pubkey?: string;
    oauthProvider?: OAuthProvider;
    oauthEmail?: string;
  } {
    return {
      type: "nsec",
      encryptedPrivKey: this.encryptedPrivKey,
      ...(this.pubkey !== undefined ? { pubkey: this.pubkey } : {}),
      ...(this.oauthProvider ? { oauthProvider: this.oauthProvider } : {}),
      ...(this.oauthEmail !== undefined ? { oauthEmail: this.oauthEmail } : {}),
    };
  }

  public getEncryptedPrivKey(): string {
    return this.encryptedPrivKey;
  }

  public async connect(): Promise<string> {
    return "connected";
  }

  private rememberedStorageKey(): string {
    return `remembered-passphrase:${this.pubkey ?? "default"}`;
  }

  private clearRememberedPassphrase(): void {
    this.rememberedPassphrase = undefined;
    if (typeof sessionStorage === "undefined") return;
    try {
      sessionStorage.removeItem(this.rememberedStorageKey());
      if (
        this.rememberedKeyWritten &&
        this.rememberedKeyWritten !== this.rememberedStorageKey()
      ) {
        sessionStorage.removeItem(this.rememberedKeyWritten);
      }
    } catch {
      // best-effort cleanup
    }
    this.rememberedKeyWritten = undefined;
  }

  private async getPassphrase(
    abort: () => void,
    error?: Error
  ): Promise<[string, boolean]> {
    let passphrase: string | undefined = this.passphrase;
    let remind: boolean = false;
    if (!passphrase && this.rememberedPassphrase) {
      return [this.rememberedPassphrase, false];
    }
    // "Remember for this session" is sessionStorage-backed: in-memory only
    // loses it on every full page load (refresh, Stripe OAuth round-trip),
    // which re-prompts the user mid-flow. Tab-scoped storage matches the
    // "this session" promise.
    if (!passphrase && typeof sessionStorage !== "undefined") {
      try {
        const stored = sessionStorage.getItem(this.rememberedStorageKey());
        if (stored) {
          this.rememberedKeyWritten = this.rememberedStorageKey();
          this.rememberedPassphrase = stored;
          return [stored, false];
        }
      } catch {
        // storage unavailable (privacy mode) — fall through to the prompt
      }
    }
    if (!passphrase && this.inputPassphrase) {
      return [this.inputPassphrase, false];
    }
    if (!passphrase && this.challengeHandler) {
      const abortController = new AbortController();
      const res = await this.challengeHandler(
        "passphrase",
        "Enter passphrase",
        () => {
          abortController.abort();
          return abort();
        },
        abortController.signal,
        error
      );
      ({ res: passphrase, remind } = res);
    }
    if (!passphrase) passphrase = "";
    return [passphrase, remind];
  }

  public async _getPrivKey(): Promise<Uint8Array> {
    // Coalesce concurrent unlocks into a single passphrase prompt.
    if (this.privKeyInFlight) return this.privKeyInFlight;
    this.privKeyInFlight = this._getPrivKeyUncached().finally(() => {
      this.privKeyInFlight = undefined;
    });
    return this.privKeyInFlight;
  }

  private async _getPrivKeyUncached(): Promise<Uint8Array> {
    let error: Error | undefined;

    let aborted = false;
    do {
      try {
        const [passphrase, remember] = await this.getPassphrase(
          () => (aborted = true),
          error
        );

        let privKeyBytes: Uint8Array;

        if (this.isNip49Format) {
          privKeyBytes = await nip49.decrypt(this.encryptedPrivKey, passphrase);
        } else {
          const privkey = CryptoJS.AES.decrypt(
            this.encryptedPrivKey,
            passphrase
          ).toString(CryptoJS.enc.Utf8);
          if (!privkey) throw new Error("Invalid passphrase");

          privKeyBytes = privkey.startsWith("nsec")
            ? (nip19.decode(privkey).data as Uint8Array)
            : hexToBytes(privkey);
        }

        if (remember) {
          this.rememberedPassphrase = passphrase;
          if (typeof sessionStorage !== "undefined") {
            try {
              const key = this.rememberedStorageKey();
              sessionStorage.setItem(key, passphrase);
              this.rememberedKeyWritten = key;
            } catch {
              // storage unavailable — in-memory remember still applies
            }
          }
        }

        // save input passphrase for few seconds, improve ux by not asking for passphrase again for multiple close actions
        if (this.inputPassphraseClearer)
          clearTimeout(this.inputPassphraseClearer);
        this.inputPassphraseClearer = setTimeout(() => {
          this.inputPassphrase = undefined;
        }, 5000);
        this.inputPassphrase = passphrase;

        return privKeyBytes;
      } catch (e) {
        console.error(e);
        error = e as Error;
        // A sessionStorage-restored passphrase can be stale (account re-keyed
        // in another tab). Drop it so the retry loop prompts the user
        // instead of spinning on the same wrong passphrase forever.
        if (this.rememberedPassphrase) {
          this.clearRememberedPassphrase();
        }
      }
    } while (!aborted);
    throw new Error("Action cancelled by user");
  }

  public async _getNSec(): Promise<string> {
    const privKey = await this._getPrivKey();
    return nip19.nsecEncode(privKey);
  }

  public async getPubKey(): Promise<string> {
    if (this.pubkey) return this.pubkey;
    const privKey = await this._getPrivKey();
    this.pubkey = getPublicKey(privKey);
    return this.pubkey;
  }

  public async sign(event: NostrEventTemplate): Promise<NostrEvent> {
    const privKey = await this._getPrivKey();
    return finalizeEvent(event, privKey);
  }

  public async encrypt(pubkey: string, plainText: string): Promise<string> {
    const conversationKey = nip44.getConversationKey(
      await this._getPrivKey(),
      pubkey
    );
    return nip44.encrypt(plainText, conversationKey);
  }

  public async decrypt(pubkey: string, cipherText: string): Promise<string> {
    const conversationKey = nip44.getConversationKey(
      await this._getPrivKey(),
      pubkey
    );
    const decrypted = nip44.decrypt(cipherText, conversationKey);
    return decrypted;
  }

  public async close(): Promise<void> {
    this.clearRememberedPassphrase();
  }
}
