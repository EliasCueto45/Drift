import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schema = JSON.parse(readFileSync(new URL('../../../../packages/contracts/schemas/drift.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv); ajv.addSchema(schema);
const validators = new Map();
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function fail(status, code, message) { throw new ApiError(status, code, message); }
export function requireThat(condition, message, code = 'INVALID', status = 422) {
  if (!condition) fail(status, code, message);
}
export function validate(name, value) {
  if (!validators.has(name)) validators.set(name, ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` }));
  const fn = validators.get(name);
  requireThat(fn(value), `Invalid ${name}`);
  return value;
}
export function exact(value, keys) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'Expected object');
  requireThat(Object.keys(value).every(k => keys.includes(k)), 'Unexpected field');
}
export function location(params, required = true) {
  const lat = params.get('lat'), lng = params.get('lng');
  if (!required && lat === null && lng === null) return null;
  requireThat(lat !== null && lng !== null && lat.trim() !== '' && lng.trim() !== '', 'lat and lng required');
  return validate('Anchor', { longitude: Number(lng), latitude: Number(lat) });
}
export function radius(params) {
  const n = params.has('radiusM') ? Number(params.get('radiusM')) : 25000;
  requireThat(Number.isFinite(n) && n > 0 && n <= 50000, 'radiusM must be positive and at most 50000');
  return n;
}
export function limit(params) {
  const n = params.has('limit') ? Number(params.get('limit')) : 50;
  requireThat(Number.isInteger(n) && n >= 1 && n <= 50, 'limit must be 1..50'); return n;
}
export function utc(value) { requireThat(typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value)), 'UTC timestamp required'); }
export function outlineVertices(outline) {
  validate('Polygon', outline);
  requireThat(outline.coordinates.length === 1, 'Created outline must have one exterior ring');
  const ring = outline.coordinates[0];
  requireThat(JSON.stringify(ring[0]) === JSON.stringify(ring.at(-1)), 'Ring must be closed');
  const vertices = ring.slice(0, -1);
  requireThat(vertices.length >= 3 && vertices.length <= 256 && new Set(vertices.map(p => JSON.stringify(p))).size === vertices.length, 'Outline requires 3..256 distinct vertices');
  return vertices;
}
const songHosts = new Set(['open.spotify.com', 'music.apple.com', 'www.youtube.com', 'youtube.com', 'youtu.be', 'soundcloud.com', 'music.youtube.com', 'bandcamp.com']);
export function messageInput(value) {
  exact(value, ['kind','anchor','expectedCloudVersion','body','assetId','songUrl','artworkTransform','strokes']);
  validate('CreateMessageRequest', value);
  const fields = { text: ['body'], song: ['songUrl'], audio: ['assetId'], png: ['assetId','artworkTransform'], drawing: ['assetId','artworkTransform','strokes'] };
  for (const key of fields[value.kind]) requireThat(value[key] !== undefined, `${key} required`);
  for (const key of ['body','songUrl','assetId','artworkTransform','strokes']) requireThat(value[key] === undefined || fields[value.kind].includes(key), `${key} not allowed for this kind`);
  if (value.kind === 'text') requireThat(value.body.trim().length > 0, 'Text must not be blank');
  if (value.kind === 'song') {
    let url; try { url = new URL(value.songUrl); } catch { fail(422, 'INVALID', 'Invalid song URL'); }
    requireThat(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && songHosts.has(url.hostname), 'Song host is not allowed');
  }
  // Stroke wire format is not defined by v1. Accept arrays of normalized [x,y]
  // polylines; handoff explicitly asks Owner 1/4 to adopt this convention.
  if (value.kind === 'drawing') {
    let count = 0;
    requireThat(value.strokes.length > 0, 'Strokes required');
    for (const line of value.strokes) {
      requireThat(Array.isArray(line) && line.length > 0, 'Each stroke must be a nonempty polyline');
      for (const point of line) {
        count++;
        requireThat(Array.isArray(point) && point.length === 2 && point.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1), 'Stroke points must be normalized [x,y]');
      }
    }
    requireThat(count <= 10000, 'At most 10000 drawing points');
  }
  return value;
}
