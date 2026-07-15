import { StringDecoder } from 'node:string_decoder';

const TRUNCATION_MARKER = '[Earlier exact-check output truncated]\n';

export class ExactCheckOutputBuffer {
  readonly #decoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };
  #tail = Buffer.alloc(0);
  #truncated = false;
  #ended = false;

  public constructor(private readonly maximumBytes: number) {}

  public write(stream: 'stdout' | 'stderr', data: Buffer): void {
    if (this.#ended) return;
    this.#append(this.#decoders[stream].write(data));
  }

  public append(value: string): void {
    this.#append(value);
  }

  public finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#append(this.#decoders.stdout.end());
    this.#append(this.#decoders.stderr.end());
  }

  public snapshot(): { readonly output: string; readonly outputTruncated: boolean } {
    return {
      output: this.#truncated
        ? `${TRUNCATION_MARKER}${this.#tail.toString('utf8')}`
        : this.#tail.toString('utf8'),
      outputTruncated: this.#truncated,
    };
  }

  #append(value: string): void {
    if (value === '') return;
    const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
    const tailLimit = Math.max(1, this.maximumBytes - markerBytes);
    const combined = Buffer.concat([this.#tail, Buffer.from(value)]);
    if (!this.#truncated && combined.byteLength <= this.maximumBytes) {
      this.#tail = combined;
      return;
    }
    this.#truncated = true;
    this.#tail = validUtf8Tail(combined, tailLimit);
  }
}

function validUtf8Tail(value: Buffer, maximumBytes: number): Buffer {
  let tail = value.subarray(Math.max(0, value.byteLength - maximumBytes));
  while (tail.byteLength > 0 && (tail[0] ?? 0) >= 0x80 && (tail[0] ?? 0) < 0xc0) {
    tail = tail.subarray(1);
  }
  while (Buffer.byteLength(tail.toString('utf8'), 'utf8') > maximumBytes && tail.length > 0) {
    tail = tail.subarray(1);
  }
  return Buffer.from(tail);
}
