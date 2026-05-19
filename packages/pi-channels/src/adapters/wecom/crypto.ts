import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

export function sha1Signature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string,
): string {
  return createHash('sha1')
    .update([token, timestamp, nonce, encrypted].sort().join(''))
    .digest('hex');
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyWeComSignature(params: {
  token: string;
  timestamp?: string | null;
  nonce?: string | null;
  encrypted?: string | null;
  provided?: string | null;
}): boolean {
  const { token, timestamp, nonce, encrypted, provided } = params;
  if (!token || !timestamp || !nonce || !encrypted || !provided) return false;
  const expected = sha1Signature(token, timestamp, nonce, encrypted);
  return timingSafeEqualString(expected, provided);
}

function pkcs7Unpad(buffer: Buffer): Buffer {
  const pad = buffer.at(-1);
  if (!pad || pad < 1 || pad > 32) return buffer;
  return buffer.subarray(0, buffer.length - pad);
}

export function decryptWeComEnvelope(
  encrypted: string,
  encodingAesKey: string,
): { message: string; receiveId: string } {
  const aesKey = Buffer.from(`${encodingAesKey}=`, 'base64');
  if (aesKey.length !== 32) throw new Error('Invalid WeCom encodingAesKey');
  const decipher = createDecipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);
  const decrypted = pkcs7Unpad(
    Buffer.concat([decipher.update(encrypted, 'base64'), decipher.final()]),
  );
  const msgLength = decrypted.readUInt32BE(16);
  const message = decrypted.subarray(20, 20 + msgLength).toString('utf-8');
  const receiveId = decrypted.subarray(20 + msgLength).toString('utf-8');
  return { message, receiveId };
}
