import type { CreateMessageRequest } from "@/lib/contracts";
/** Keep one retry key for the same in-flight draft; edits and new posts get a new key. */
export class CreateAttempt {
  private fingerprint: string | null = null;
  private key: string | null = null;
  private message: {
    fingerprint: string;
    key: string;
    body: CreateMessageRequest;
  } | null = null;

  prepareMessage(path: string, body: CreateMessageRequest) {
    const draft: Partial<CreateMessageRequest> = { ...body };
    delete draft.expectedCloudVersion;
    const fingerprint = JSON.stringify([path, draft]);
    if (!this.message || this.message.fingerprint !== fingerprint) {
      this.message = {
        fingerprint,
        key: crypto.randomUUID(),
        body: structuredClone(body),
      };
    }
    // A poll can advance cloud.version after a successful write whose response
    // was lost. Retry the exact original body so its receipt still matches.
    return this.message;
  }

  forRequest(path: string, body: unknown): string {
    const fingerprint = JSON.stringify([path, body]);
    if (fingerprint !== this.fingerprint || !this.key) {
      this.fingerprint = fingerprint;
      this.key = crypto.randomUUID();
    }
    return this.key;
  }

  complete() {
    this.fingerprint = this.key = null;
    this.message = null;
  }
}
