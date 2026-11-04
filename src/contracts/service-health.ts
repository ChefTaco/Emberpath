import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ConnectionOptions } from 'node:tls';
import {
  parseIamHealthPayload,
  parseMemoryHealthPayload,
  parseServiceHealthPayload,
  type IamHealthPayload,
  type MemoryHealthPayload,
  type ServiceHealthProbeResult,
  type TypedServiceHealthProbeResult,
} from './service-health-schemas.js';

export * from './service-health-schemas.js';

export interface ServiceHealthRequestOptions {
  allowInsecureTls: boolean;
  requestId?: string;
  timeoutMs?: number;
  tls?: ConnectionOptions;
}

function normalizeOptions(allowInsecureTls: boolean | ServiceHealthRequestOptions, requestId?: string): ServiceHealthRequestOptions {
  return typeof allowInsecureTls === 'boolean'
    ? { allowInsecureTls, ...(requestId ? { requestId } : {}) }
    : allowInsecureTls;
}

function requestTypedHealth<TPayload>(
  healthUrl: string,
  options: ServiceHealthRequestOptions,
  parsePayload: (text: string) => TPayload | null,
): Promise<TypedServiceHealthProbeResult<TPayload>> {
  const url = new URL(healthUrl);
  return new Promise((resolve, reject) => {
    const handleResponse = (response: IncomingMessage) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        if (raw.length < 1024 * 1024) raw += chunk;
      });
      response.on('end', () => {
        const statusCode = response.statusCode ?? 0;
        resolve({
          ok: statusCode >= 200 && statusCode < 300,
          statusCode,
          payload: parsePayload(raw),
        });
      });
    };

    const baseOptions = {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(options.requestId ? { 'x-request-id': options.requestId, 'x-hive-request-id': options.requestId } : {}),
      },
      timeout: options.timeoutMs ?? 2500,
    };
    const request = url.protocol === 'https:'
      ? httpsRequest(url, {
          ...baseOptions,
          ...(options.tls ?? {}),
          rejectUnauthorized: !options.allowInsecureTls,
        }, handleResponse)
      : httpRequest(url, baseOptions, handleResponse);

    request.on('timeout', () => request.destroy(new Error('probe timed out')));
    request.on('error', reject);
    request.end();
  });
}

export function requestServiceHealth(
  healthUrl: string,
  allowInsecureTls: boolean | ServiceHealthRequestOptions,
  requestId?: string,
): Promise<ServiceHealthProbeResult> {
  return requestTypedHealth(healthUrl, normalizeOptions(allowInsecureTls, requestId), parseServiceHealthPayload);
}

export function requestIamHealth(
  healthUrl: string,
  options: ServiceHealthRequestOptions,
): Promise<TypedServiceHealthProbeResult<IamHealthPayload>> {
  return requestTypedHealth(healthUrl, options, parseIamHealthPayload);
}

export function requestMemoryHealth(
  healthUrl: string,
  options: ServiceHealthRequestOptions,
): Promise<TypedServiceHealthProbeResult<MemoryHealthPayload>> {
  return requestTypedHealth(healthUrl, options, parseMemoryHealthPayload);
}
