import { describe, expect, it } from 'vitest';
import { failureDetails, failureKind } from './page-failure';

class StatusError extends Error {
  override readonly name = 'AuthError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

describe('why a page could not be shown', () => {
  it('is being offline before anything else', () => {
    expect(failureKind(new StatusError(502, 'Signing in failed with 502.'), false)).toBe('offline');
    expect(failureKind(undefined, false)).toBe('offline');
  });

  it('is the server when it answered 500 or more, or never answered', () => {
    expect(failureKind(new StatusError(502, 'Signing in failed with 502.'), true)).toBe('server');
    expect(failureKind(new StatusError(500, 'Internal Server Error'), true)).toBe('server');
    expect(failureKind(new TypeError('Failed to fetch'), true)).toBe('server');
    expect(
      failureKind(new TypeError('NetworkError when attempting to fetch resource.'), true),
    ).toBe('server');
    expect(failureKind(new TypeError('Load failed'), true)).toBe('server');
  });

  it("is the page's code when a module could not be fetched, in each browser's words", () => {
    expect(
      failureKind(
        new TypeError('Failed to fetch dynamically imported module: https://x.example/a.js'),
        true,
      ),
    ).toBe('code');
    expect(failureKind(new TypeError('error loading dynamically imported module'), true)).toBe(
      'code',
    );
    expect(failureKind(new TypeError('Importing a module script failed.'), true)).toBe('code');
    expect(failureKind(new Error('Unable to preload CSS for /assets/a.css'), true)).toBe('code');
  });

  it('is something else for a refusal, a missing record or a fault in the page', () => {
    expect(failureKind(new StatusError(403, 'Forbidden'), true)).toBe('other');
    expect(failureKind(new StatusError(404, 'Not Found'), true)).toBe('other');
    expect(
      failureKind(new TypeError("Cannot read properties of undefined (reading 'id')"), true),
    ).toBe('other');
    expect(failureKind(undefined, true)).toBe('other');
    expect(failureKind({ status: '502' }, true)).toBe('other');
  });
});

describe('the technical details of a failure', () => {
  it('gives the name and the message', () => {
    expect(failureDetails(new StatusError(502, 'Signing in failed with 502.'))).toBe(
      'AuthError: Signing in failed with 502.',
    );
    expect(failureDetails(new Error('Something broke'))).toBe('Something broke');
    expect(failureDetails('plain words')).toBe('plain words');
  });

  it('adds the status when the message does not already say it', () => {
    expect(failureDetails(new StatusError(503, 'Service Unavailable'))).toBe(
      'AuthError: status 503: Service Unavailable',
    );
  });

  it('is nothing when the failure says nothing', () => {
    expect(failureDetails(undefined)).toBeUndefined();
    expect(failureDetails(null)).toBeUndefined();
    expect(failureDetails(new Error(''))).toBeUndefined();
    expect(failureDetails({})).toBeUndefined();
  });

  it('is cut to a few lines', () => {
    const details = failureDetails(new Error('x'.repeat(1000)));
    expect(details).toHaveLength(301);
    expect(details?.endsWith('…')).toBe(true);
  });
});
