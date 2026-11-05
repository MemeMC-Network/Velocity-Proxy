import { createHash } from 'node:crypto';

export const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export const hostOf = (rawUrl) => {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.host || null;
  } catch {
    return null;
  }
};

export const isHttpUrl = (value) => /^https?:\/\//i.test(String(value ?? ''));

export const shortHash = (value, length = 16) =>
  createHash('sha1').update(String(value)).digest('hex').slice(0, length);

export const randomId = (bytes = 6) => createHash('sha1')
  .update(`${Date.now()}-${Math.random()}-${process.hrtime.bigint()}`)
  .digest('hex')
  .slice(0, bytes * 2);

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const parseJson = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};
